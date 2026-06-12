import { z } from "zod";
import { BaseAgent, type AgentContext } from "../agents/base.js";
import {
  PlayActionIntentSchema,
  PlayMutationSchema,
  type PlayActionIntent,
  type PlayActionIntentInput,
  type PlayMutation,
  type PlayMutationInput,
} from "../models/play.js";

export interface PlayActionInterpreterInput {
  readonly input: string;
  readonly sceneBrief: string;
  readonly language?: "zh" | "en";
}

export interface PlayWorldMutatorInput {
  readonly turn: number;
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly context: string;
  readonly language?: "zh" | "en";
}

export interface PlaySceneRenderInput {
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly mutationSummary: string;
  readonly stateBrief: string;
  readonly replayContext?: string;
  readonly language?: "zh" | "en";
  // The world's premise — a persistent anchor so the scene stays in the
  // established era/setting/genre and doesn't drift (a modern shop must not grow
  // night-watchmen and oil lamps).
  readonly worldPremise?: string;
}

export interface PlaySceneReconcileInput {
  readonly turn: number;
  readonly input: string;
  readonly action: PlayActionIntentInput;
  readonly mutation: PlayMutationInput;
  readonly sceneText: string;
  readonly context: string;
  readonly stateBrief: string;
  readonly language?: "zh" | "en";
  readonly worldPremise?: string;
}

const PlaySceneRenderSchema = z.object({
  sceneText: z.string().min(1),
  suggestedActions: z.array(z.string().min(1)).min(0).max(4).default([]),
});
export type PlaySceneRender = z.infer<typeof PlaySceneRenderSchema>;

// A play turn runs three internal LLM calls (interpret → mutate → render). The
// transport-level retry in the provider does NOT cover HTTP 502/503/429 or
// "temporarily unavailable", so a single flaky upstream response would break the
// whole turn. Retry those here, then let each agent fail open.
function isRetryableLlmError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /50[0-9]|429|temporarily unavailable|timeout|timed out|socket|terminated|econn|network|fetch failed|bad gateway|service unavailable|rate limit/.test(msg);
}

async function chatWithRetry<T>(call: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryableLlmError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function trySceneParse(content: string): PlaySceneRender | null {
  try {
    return PlaySceneRenderSchema.parse(parseJson(content));
  } catch {
    return null;
  }
}

export class PlayActionInterpreterAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-action-interpreter";
  }

  async interpret(input: PlayActionInterpreterInput): Promise<PlayActionIntent> {
    // Never throw: a transient upstream error (after retries) or unparseable output
    // degrades to a generic action (the player's raw text as a "do"), not a crash.
    let raw: unknown = {};
    try {
      const response = await chatWithRetry(() => this.chat([
        { role: "system", content: buildActionInterpreterSystemPrompt(input.language ?? "zh") },
        { role: "user", content: buildActionInterpreterUserPrompt(input, input.language ?? "zh") },
      ], { temperature: 0.15, maxTokens: 1024 }));
      raw = parseJson(response.content);
    } catch { /* transient/malformed → degrade below */ }
    const parsed = PlayActionIntentSchema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : PlayActionIntentSchema.parse({ actionKind: "do", intent: input.input });
  }
}

export class PlayWorldMutatorAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-world-mutator";
  }

  async proposeMutation(input: PlayWorldMutatorInput): Promise<PlayMutation> {
    // Never throw: a transient upstream error (after retries) or an unparseable
    // mutation degrades to a blocked, no-op turn (with a reason), not a crash.
    let raw: unknown = {};
    try {
      const response = await chatWithRetry(() => this.chat([
        { role: "system", content: buildWorldMutatorSystemPrompt(input.language ?? "zh") },
        { role: "user", content: buildWorldMutatorUserPrompt(input, input.language ?? "zh") },
      ], { temperature: 0.25, maxTokens: 4096 }));
      raw = parseJson(response.content);
    } catch { /* transient/malformed → degrade below */ }
    const parsed = PlayMutationSchema.safeParse(raw);
    const mutation = parsed.success
      ? parsed.data
      : PlayMutationSchema.parse({
          turn: input.turn,
          actionKind: input.action.actionKind,
          blocked: true,
          blockedReason: "模型输出无法解析为有效的状态变更，本回合未推进世界状态。",
        });
    // Observability (#2): a dropped world item must not vanish silently. Log when
    // the model proposed entities/edges/slots that parsing discarded — that is the
    // difference between "the model wrote nothing" and "we threw its work away".
    logDroppedMutationItems(raw, mutation, input.turn);
    return { ...mutation, eventId: mutation.eventId || `evt-${input.turn}` };
  }
}

function rawUpsertCount(field: unknown): number {
  if (Array.isArray(field)) return field.length;
  if (field && typeof field === "object" && Array.isArray((field as { upsert?: unknown }).upsert)) {
    return (field as { upsert: unknown[] }).upsert.length;
  }
  return 0;
}

function logDroppedMutationItems(raw: unknown, mutation: PlayMutation, turn: number): void {
  if (!raw || typeof raw !== "object") return;
  const r = raw as Record<string, unknown>;
  const rawE = rawUpsertCount(r.entities);
  const rawEd = rawUpsertCount(r.edges);
  const rawS = rawUpsertCount(r.stateSlots);
  const keptE = mutation.entities.upsert.length;
  const keptEd = mutation.edges.upsert.length;
  const keptS = mutation.stateSlots.upsert.length;
  if (rawE > keptE || rawEd > keptEd || rawS > keptS) {
    console.warn(
      `[play-mutator] turn ${turn}: dropped malformed items — entities ${rawE}->${keptE}, edges ${rawEd}->${keptEd}, slots ${rawS}->${keptS}`,
    );
  }
}

export class PlaySceneRendererAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-scene-renderer";
  }

  async render(input: PlaySceneRenderInput & { readonly mode?: "open" | "guided" }): Promise<PlaySceneRender> {
    const language = input.language ?? "zh";
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: buildSceneRendererSystemPrompt(input.mode ?? "open", language) },
      { role: "user", content: buildSceneRendererUserPrompt(input, language) },
    ];
    // The renderer must NEVER throw — a hiccup here used to break the turn AND leave
    // a half-committed world (event/state written before render). Retry transient
    // upstream errors, ask once for strict JSON if the output wasn't, then fail open
    // to the raw prose as the scene. (Bigger token budget so long literary scenes
    // don't get truncated mid-JSON, which is itself a common parse failure.)
    let lastContent = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      let content = "";
      try {
        const response = await chatWithRetry(() => this.chat(messages, { temperature: 0.45, maxTokens: 4096 }));
        content = response.content;
      } catch {
        break; // transient retries exhausted → fail open below
      }
      lastContent = content || lastContent;
      const parsed = trySceneParse(content);
      if (parsed) {
        return input.mode === "guided" && parsed.suggestedActions.length === 0
          ? { ...parsed, suggestedActions: guidedFallbackActions(language) }
          : parsed;
      }
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content: language === "en"
            ? 'That was not strict JSON. Output ONLY one JSON object {"sceneText": "...", "suggestedActions": ["..."]} and nothing else.'
            : '上面不是严格 JSON。只输出一个 JSON 对象 {"sceneText": "...", "suggestedActions": ["..."]}，不要任何其他文字。',
        },
      );
    }
    const proseFallback = lastContent
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    return {
      sceneText: proseFallback || (language === "en" ? "(The moment holds, unresolved.)" : "（这一拍悬着，没有落定。）"),
      suggestedActions: input.mode === "guided" ? guidedFallbackActions(language) : [],
    };
  }
}

function guidedFallbackActions(language: "zh" | "en"): string[] {
  return language === "en"
    ? ["Observe the immediate change", "Interact with what is in front of you", "Hold back and see what happens"]
    : ["观察眼前刚发生的变化", "主动与眼前的人或事物互动", "暂时按兵不动，看看局势如何发展"];
}

export class PlaySceneReconcilerAgent extends BaseAgent {
  constructor(ctx: AgentContext) {
    super(ctx);
  }

  get name(): string {
    return "play-scene-reconciler";
  }

  async reconcile(input: PlaySceneReconcileInput): Promise<PlayMutationInput> {
    const language = input.language ?? "zh";
    const eventId = `evt-${input.turn}`;
    const empty = emptyReconciliation(input.turn, PlayActionIntentSchema.parse(input.action).actionKind);
    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: buildSceneReconcilerSystemPrompt(language) },
      { role: "user", content: buildSceneReconcilerUserPrompt(input, language) },
    ];
    try {
      const response = await chatWithRetry(() => this.chat(messages, { temperature: 0.1, maxTokens: 2048 }));
      const parsed = PlayMutationSchema.parse(parseJson(response.content));
      return {
        ...parsed,
        eventId: parsed.eventId || eventId,
        turn: parsed.turn || input.turn,
        actionKind: parsed.actionKind || PlayActionIntentSchema.parse(input.action).actionKind,
      };
    } catch {
      return empty;
    }
  }
}

function emptyReconciliation(turn: number, actionKind: PlayActionIntent["actionKind"]): PlayMutationInput {
  return {
    eventId: `evt-${turn}`,
    turn,
    actionKind,
    summary: "",
    entities: { upsert: [] },
    edges: { upsert: [], expire: [] },
    stateSlots: { upsert: [] },
    evidence: { transitions: [] },
    blocked: false,
    blockedReason: "",
    notes: [],
  };
}

function buildSceneReconcilerSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You reconcile an interactive-fiction scene with the world graph.",
      "Compare the rendered prose against the already applied changes and current state summary.",
      "If the prose introduced a concrete named object, clue, evidence, location, organization, or person that is not represented in the applied changes/current state, output ONLY supplemental PlayMutation entries for those missing graph facts.",
      "Do not rewrite prose. Do not invent facts that are not in the rendered scene. If nothing is missing, output an empty PlayMutation with empty arrays.",
      "Use the same eventId/turn/actionKind. For tangible things the player now physically holds, add a holding edge from actor_player with value.role=\"holding\"; if the target is evidence/clue/claim/proof_chain rather than an item, also set value.physical=true. Observed phenomena or learned facts are not holdings.",
      "Output strict JSON matching PlayMutation.",
    ].join("\n");
  }
  return [
    "你负责把互动小说正文和世界图谱对齐。",
    "对照已经应用的本回合变化、当前状态摘要和最终正文。",
    "如果正文里出现了具体且具名的新物件、线索、证据、地点、组织或人物，但它还没有体现在已应用变化/当前状态里，只输出这些缺失图谱事实的补充 PlayMutation。",
    "不要改正文，不要发明正文没有的事实。没有缺失就输出空的 PlayMutation，各数组留空。",
    "沿用同一个 eventId/turn/actionKind。玩家获得或拿在手里的实物，需要补一条 actor_player 指向该实体、value.role=\"holding\" 的 edge；如果目标是 evidence/clue/claim/proof_chain 而不是 item，还要设置 value.physical=true。观察到的现象或知道的信息不是持有物。",
    "输出严格 JSON，必须符合 PlayMutation。",
  ].join("\n");
}

function buildSceneReconcilerUserPrompt(input: PlaySceneReconcileInput, language: "zh" | "en"): string {
  const actionKind = PlayActionIntentSchema.parse(input.action).actionKind;
  const eventId = `evt-${input.turn}`;
  if (language === "en") {
    return [
      `eventId: ${eventId}`,
      `turn: ${input.turn}`,
      `actionKind: ${actionKind}`,
      "",
      ...(input.worldPremise ? ["World setting:", input.worldPremise, ""] : []),
      "Player input:",
      input.input,
      "",
      "Current context before this turn:",
      input.context,
      "",
      "Applied mutation:",
      JSON.stringify(PlayMutationSchema.parse(input.mutation), null, 2),
      "",
      "Current state summary:",
      input.stateBrief,
      "",
      "Rendered scene:",
      input.sceneText,
    ].join("\n");
  }
  return [
    `eventId: ${eventId}`,
    `turn: ${input.turn}`,
    `actionKind: ${actionKind}`,
    "",
    ...(input.worldPremise ? ["世界设定：", input.worldPremise, ""] : []),
    "玩家输入：",
    input.input,
    "",
    "本回合前的当前上下文：",
    input.context,
    "",
    "已应用 mutation：",
    JSON.stringify(PlayMutationSchema.parse(input.mutation), null, 2),
    "",
    "当前状态摘要：",
    input.stateBrief,
    "",
    "最终正文：",
    input.sceneText,
  ].join("\n");
}

function buildActionInterpreterSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You are an interactive-fiction action interpreter.",
      "Your job is to normalize one line of the player's natural language into one of five action kinds: look / say / move / do / wait.",
      "Do not add drama for the player, do not advance the plot, do not write scene prose.",
      "look = observe/examine/recall a clue; say = speak/probe/confront; move = move to a location; do = perform an action/use an item/investigate; wait = wait/stall/watch.",
      "Output strict JSON, no explanation.",
    ].join("\n");
  }
  return [
    "你是互动小说动作理解器。",
    "你的任务是把玩家一句自然语言，归一成五类动作之一：look / say / move / do / wait。",
    "不要替玩家加戏，不要直接推进剧情，不要写场景正文。",
    "look=观察/检查/回忆线索；say=说话/试探/质问；move=移动到地点；do=执行动作/使用物品/调查；wait=等待/拖延/旁观。",
    "输出严格 JSON，不要解释。",
  ].join("\n");
}

function buildActionInterpreterUserPrompt(input: PlayActionInterpreterInput, language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Current scene:",
      input.sceneBrief,
      "",
      "Player input:",
      input.input,
      "",
      "Output fields: actionKind, targetEntityLabel?, targetLocationLabel?, intent, manner, risk, ambiguity, secondaryActions.",
    ].join("\n");
  }
  return [
    "当前场景：",
    input.sceneBrief,
    "",
    "玩家输入：",
    input.input,
    "",
    "输出字段：actionKind, targetEntityLabel?, targetLocationLabel?, intent, manner, risk, ambiguity, secondaryActions。",
  ].join("\n");
}

function buildWorldMutatorSystemPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "You are an interactive-fiction world-state drafter.",
      "Based only on the player's action and the current context, propose this turn's possible state changes as a draft.",
      "Do not write final prose; do not commit to the store on the reducer's behalf; do not let key states jump to completion out of nowhere.",
      "One player input advances one adjacent beat. If the player gives a chain of actions, apply only the literal chain up to the nearest new pressure point; do not skip through off-screen aftermath, rewards, or resolution beyond what the input directly attempts.",
      "Do not leap over the process. If the player runs toward, reaches for, uses, opens, or confronts something, account for the movement, resistance, interruption, or immediate pressure inside this same beat instead of jumping straight to an after-the-fact state.",
      "This engine is genre-neutral: romance, adventure, wuxia, mystery, slice-of-life all use the same structure. Entity types: actor/location/item/evidence/clue/claim/proof_chain/organization/rule/scene/event — use as needed.",
      "Give every new or important entity a one-line summary (who/what it is and why it matters), not just a status word — the player expands this summary in the side panel.",
      "Tangible things the player discovers or holds (a clue, a document, a weapon, a token, key evidence) MUST be their own entity (item/evidence/clue), never folded into a person's status — only then can they enter the player's holdings and be tracked. Observed phenomena, knowledge, impressions, or environmental signs are NOT holdings.",
      "Use entity.status to record state progress for any genre, with status words suited to this world's genre, advancing step by step without skipping (e.g. relationship: stranger -> curious -> attracted -> lover; injury: healthy -> bleeding -> critical; clue: found -> collected -> confirmed).",
      "The player entity id is fixed: always use id actor_player for the player character. Never rename this id; only replace its label, summary, and status with this world's player identity.",
      "Whenever a meaningful relationship forms or shifts between entities (ally / rival / kin / suspicion / debt / master-servant …), record it in edges.upsert as {\"fromId\":\"<entity>\",\"type\":\"<relation>\",\"toId\":\"<entity>\",\"value\":{\"role\":\"relation\"}} — this is the ONLY source for the relationship panel, so over-record rather than skip; add a fresh edge when a relationship changes.",
      "When the player physically holds/carries/keeps/takes a tangible thing, record an edge from actor_player to that entity and set value.role=\"holding\". If the held target is evidence/clue/claim/proof_chain rather than an item, also set value.physical=true. If the player only observes or learns something, use value.role=\"observed\" or a normal relation, never holding.",
      "The current context may include an entity roster. Reuse those exact ids in entities, edges, evidence, and stateSlots. If you only know a name, use the exact roster label; never invent a new id for the same person/thing (or the panel shows duplicates).",
      "State tracking is optional and governed by the user's world contract. If the world contract rejects stats, numeric panels, levels, RPG framing, or quantified meters, do NOT output stateSlots; express progress as natural-language entity.status / summary / evidence transitions instead.",
      "When stateSlots are appropriate, prefer natural-language values unless the user explicitly asked for quantitative tracking or the fiction contains a concrete count/clock/deadline. Do not create numbers just because the schema supports them.",
      "Early on (the first few turns), seed only the state the premise already establishes: a concrete deadline may become a timer slot if the world permits quantified tracking; the central mystery/objective -> its first clue/evidence entity; already-named key characters -> actor entities with a one-line summary. Don't leave the opening world nearly empty.",
      "Restraint: only create entities and meters the story actually makes real — never invent gratuitous stats or items just to fill the panel.",
      "Only use evidence.transitions for the evidence lifecycle when this world is genuinely an investigation/mystery; otherwise leave it empty.",
      "If the player's action is invalid or information is insufficient, set blocked=true and write blockedReason.",
      "Time is a synchronization axis, not a fixed tick. For every non-opening turn, set timeAdvance with: elapsed = the natural-language duration spent by this action; anchor = the world time/phase after the action if the world has a clock, season, phase, day/night, retreat period, deadline, or other temporal anchor; rationale = why this duration is right; synchronized = what relevant NPCs/places/pressures changed during the same elapsed time. A glance may pass seconds, a trip half a day, cultivation three years — obey the user's world contract; never invent a universal turn length.",
      "Output strict JSON matching PlayMutation: eventId, turn, actionKind, summary, timeAdvance, entities, edges, stateSlots, evidence, blocked, blockedReason, notes.",
      "The following is only a JSON-shape example. Do not reuse its labels, names, or story facts in the actual world; the reserved player id actor_player is the only example id you must keep for the player entity:",
    `{"eventId":"evt-1","turn":1,"actionKind":"look","summary":"The player-character finds a sample clue and a sample key.","timeAdvance":{"elapsed":"a few breaths","anchor":"still in the same rain-soaked minute","rationale":"The player only examined the immediate scene.","synchronized":["The counterpart notices the pause but does not act openly yet."]},"entities":{"upsert":[{"id":"actor_player","type":"actor","label":"player-character","summary":"Reserved player entity id; replace label, summary, and status with the current world's player identity.","status":"alert","updatedEventId":"evt-1"},{"id":"actor_counterpart","type":"actor","label":"counterpart","summary":"Placeholder for a relevant person in the current world; replace with the real roster id/label.","status":"guarded","updatedEventId":"evt-1"},{"id":"evidence_sample_clue","type":"evidence","label":"sample clue","summary":"A tangible clue discovered this turn; replace with a real object from the scene.","status":"seen","updatedEventId":"evt-1"},{"id":"item_sample_key","type":"item","label":"sample key","summary":"A tangible item collected this turn; replace with a real object from the scene.","status":"collected","updatedEventId":"evt-1"}]},"edges":{"upsert":[{"fromId":"actor_player","type":"suspicious_of","toId":"actor_counterpart","value":{"role":"relation"}},{"fromId":"actor_player","type":"holds","toId":"item_sample_key","value":{"role":"holding"}},{"fromId":"actor_player","type":"holds","toId":"evidence_sample_clue","value":{"role":"holding","physical":true}}]},"stateSlots":{"upsert":[{"id":"slot_sample_timer","kind":"timer","label":"sample timer","value":3,"updatedEventId":"evt-1"}]}}`,
    ].join("\n");
  }
  return [
    "你是互动小说世界状态草案员。",
    "你只根据玩家动作和当前上下文，提出本回合可能发生的状态变化草案。",
    "不要写最终正文；不要越权替 reducer 落库；不要凭空让关键状态一步到位。",
    "一个玩家输入只推进相邻一拍。玩家把多个动作写在一句里时，只处理原话直接包含的动作链，到最近的新压力点就停；不要跳过过程去写场外后果、完整回报或问题解决。",
    "不要替玩家越过过程。玩家奔向、伸手、使用、打开或对峙某物时，必须把移动、阻力、干扰、敌人压近或即时压力算进这一拍，不能直接跳到事后状态。",
    "这套引擎是品类中立的：恋情、冒险、武侠、悬疑、日常等都用同一套结构表达。实体类型用 actor/location/item/evidence/clue/claim/proof_chain/organization/rule/scene/event，按需选用。",
    "给每个新出现或重要的实体写一句 summary（他是谁/这是什么、为什么重要），不要只靠 status 一句话——玩家会在侧栏里展开看这条 summary。",
    "玩家发现或获得的「实物」（线索、文件、凶器、信物、关键证据等）必须建成独立实体（item/evidence/clue），不要塞进某个人物的 status——这样它们才能进入玩家的「持有物」并被追踪。观察到的现象、知识、印象、环境征兆不是持有物。",
    "用 entity.status 记录任意品类的状态推进，状态词按这个世界的题材自定，循序渐进、不要跳级（例如关系：陌生→好奇→心动→恋人；伤势：健康→流血→重伤；线索：发现→收集→坐实）。",
    "玩家本人实体 id 是固定保留字：必须始终用 actor_player。绝不要把它改成本局名字或别的 id；只替换 label、summary、status 为本局玩家身份。",
    "人物之间（或人物与组织/地点之间）一旦形成或改变有意义的关系（盟友/敌对/亲属/怀疑/欠债/上下级/师徒等），就在 edges.upsert 里记一条 {\"fromId\":\"<实体>\",\"type\":\"<关系词>\",\"toId\":\"<实体>\",\"value\":{\"role\":\"relation\"}}——这是侧栏「关系网」的唯一来源，宁可多记勿漏；关系一旦变化（如怀疑→敌对）也补一条新边。",
    "玩家实际持有/携带/收进包里/拿走某个实物时，必须记一条 actor_player 指向该实体的 edge，并设置 value.role=\"holding\"。如果目标是 evidence/clue/claim/proof_chain 而不是 item，还必须设置 value.physical=true。玩家只是观察或知道某件事时，用 value.role=\"observed\" 或普通关系，绝不能写成 holding。",
    "当前上下文可能包含实体名册。entities、edges、evidence、stateSlots 都优先复用名册里的精确 id；如果只知道名字，就用名册里的精确 label。绝不要把同一个人/物换个新 id 重建（否则侧栏会出现重复节点）。",
      "状态追踪是可选的，必须服从用户的世界契约。世界契约禁止数值、面板、等级、RPG 化或量化进度时，不要输出 stateSlots；改用 entity.status / summary / evidence transitions 写自然语言状态。",
      "确实需要 stateSlots 时，也优先用自然语言 value；只有用户明确要求量化追踪，或文本里存在具体倒计时/钟点/数量，才写数字。不要因为 schema 支持就硬造数值。",
      "开局阶段（前几回合），只播种前提里已经确立的状态：明确期限在世界允许量化时才可成为 timer；核心谜题/目标物→第一条 clue/evidence 实体；已点名的关键人物→actor 实体并配一句 summary。不要让开场世界几乎空着。",
    "克制：只建剧情真正落地的实体和数值，不要为了填满侧栏而硬造属性或物品。",
    "只有当这个世界确实是调查/推理题材时，才用 evidence.transitions 走证据生命周期；其他题材留空即可。",
    "如果玩家动作无效或信息不足，blocked=true 并写 blockedReason。",
    "时间是世界同步轴，不是固定 tick。每个非开场回合都要写 timeAdvance：elapsed=本动作按语义经过了多久；anchor=动作结束后世界处在什么时间/阶段（若本局有钟点、昼夜、季节、闭关期、期限、潮汐、巡逻节奏等时间锚点）；rationale=为什么是这段时间；synchronized=同一段时间里相关人物/地点/压力发生了什么同步变化。看一眼可能几息，赶路可能半天，闭关可能三年——遵守用户的世界契约，绝不要发明统一回合长度。",
    "输出严格 JSON，必须符合 PlayMutation：eventId, turn, actionKind, summary, timeAdvance, entities, edges, stateSlots, evidence, blocked, blockedReason, notes。",
    "下面的范例只示结构，不得复用范例里的名称、人名或剧情事实；唯一必须保留的示例 id 是玩家本人 actor_player：",
    `{"eventId":"evt-1","turn":1,"actionKind":"look","summary":"玩家角色发现了一个示例线索和一个示例道具。","timeAdvance":{"elapsed":"几息","anchor":"仍在同一个雨夜片刻里","rationale":"玩家只是贴近观察眼前物件，没有离开现场。","synchronized":["相关人物注意到玩家停顿，但还没有公开阻拦。"]},"entities":{"upsert":[{"id":"actor_player","type":"actor","label":"玩家角色","summary":"玩家本人固定实体 id；实际输出只替换 label、summary、status 为本局玩家身份。","status":"警觉","updatedEventId":"evt-1"},{"id":"actor_counterpart","type":"actor","label":"相关人物","summary":"当前世界中相关人物的占位示例；实际输出必须替换为本局真实实体。","status":"戒备","updatedEventId":"evt-1"},{"id":"evidence_sample_clue","type":"evidence","label":"示例线索","summary":"本回合发现的实物线索示例；实际输出必须替换为场景里的真实物件。","status":"已发现","updatedEventId":"evt-1"},{"id":"item_sample_key","type":"item","label":"示例钥匙","summary":"本回合获得的实物道具示例；实际输出必须替换为场景里的真实物件。","status":"已收集","updatedEventId":"evt-1"}]},"edges":{"upsert":[{"fromId":"actor_player","type":"怀疑","toId":"actor_counterpart","value":{"role":"relation"}},{"fromId":"actor_player","type":"持有","toId":"item_sample_key","value":{"role":"holding"}},{"fromId":"actor_player","type":"持有","toId":"evidence_sample_clue","value":{"role":"holding","physical":true}}]},"stateSlots":{"upsert":[{"id":"slot_sample_timer","kind":"timer","label":"示例倒计时","value":3,"updatedEventId":"evt-1"}]}}`,
  ].join("\n");
}

function buildWorldMutatorUserPrompt(input: PlayWorldMutatorInput, language: "zh" | "en"): string {
  if (language === "en") {
    return [
      `turn: ${input.turn}`,
      "Player's words:",
      input.input,
      "",
      "Action interpretation:",
      JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
      "",
      "Current context:",
      input.context,
      "",
      "Requirement: use eventId evt-" + input.turn + "; every new or referenced entity id must be stable, readable, and short.",
    ].join("\n");
  }
  return [
    `turn: ${input.turn}`,
    "玩家原话：",
    input.input,
    "",
    "动作理解：",
    JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
    "",
    "当前上下文：",
    input.context,
    "",
    "要求：eventId 使用 evt-" + input.turn + "；所有新增或引用的实体 id 要稳定、可读、短小。",
  ].join("\n");
}

export function buildSceneRendererSystemPrompt(mode: "open" | "guided" = "open", language: "zh" | "en" = "zh"): string {
  if (language === "en") {
    const base = [
      "You are an interactive-fiction scene-response author.",
      "Write the response only from the already-applied state; do not overturn the reducer's results.",
      "Concrete new objects, clues, evidence, locations, organizations, or named people can only appear if they are already present in Applied changes or Current state summary. If the prose needs a new concrete thing, it must have been created by the mutator first; otherwise describe mood, pressure, or an unnamed detail instead.",
      "It should read like a playable novel — action, senses, pressure, breathing room — never a system log and never a menu-narration that herds the player into picking something.",
      "Bridge from the player's action first. Even though the state is already applied, do not start as if everything is already over; write the follow-through, contact, resistance, interruption, and immediate consequence so the action connects to the new state.",
      "Do not jump straight to the after-action result, and do not write epilogue-style summaries, morals, or closing-theme lines. End on an immediate sensory pressure, changed position, exposed detail, or nearby consequence.",
      "Stay strictly inside the world the premise established — era, place, tech level, genre tone must stay consistent. Never introduce elements that don't belong: a modern-city story must not grow night-watchmen / oil lamps; a historical/wuxia story must not sprout phones / cars / computers. Every detail lands inside the given world.",
      // Presence is a valid turn.
      "The player is not always 'acting'. When they merely observe, linger, feel, idle-chat, or do nothing, give an immersive beat — one living detail, a smell, a bystander's small movement, a thought crossing their mind. NEVER say 'there's nothing more to see' / 'you already looked' / 'stop stalling', and never nag them to hurry up and act. Let the beat breathe.",
      // The world runs on its own clock.
      "The world is not inert. Time moves, the deadline closes in, side characters act on their own, something stirs in the distance, off-screen events happen. Even on a turn where the player did nothing, nudge the world forward a little — so the pull to move forward comes from the STORY (the trail goes cold / the deadline nears / someone moved first), not from the narration pestering them to choose.",
      "If Current state summary includes a Time section, treat elapsed and anchor as canonical. Render the scene after exactly that elapsed interval, at that resulting world time/phase, and include the synchronized pressure/character movement naturally in prose. Do not invent another clock reading, another elapsed amount, or a fixed tick label.",
      "Respect negative player intent as fact. If the player's words say they did NOT touch, open, take, leave, attack, or speak, do not narrate them doing it by implication; write the restraint itself and the world's response to that restraint.",
      // Don't herd — and don't smuggle the herding into a character's mouth.
      "Do not end with herding questions like 'What do you do?' / 'Which way?'. And do NOT route the same pressure through a companion who keeps listing options ('go to A, or B?') — a sidekick is not an options dispenser. Most beats should NOT end on a pending question at all: land on an image, a sound, a smell, or a hanging tension, and stop. Only when the player is genuinely at a fork that demands a decision may a question surface — sparingly.",
      "sceneText is PURE narrative prose. Never put a choice list in the body — no 'Options:' / 'What do you do?' followed by A/B/C, no '- ' bulleted options — no matter how urgent or fork-like the moment is (a tense escape is NOT an excuse for a menu). Weave the available routes into the scene itself (the bamboo by the wall, the half-open skylight, the alley toward the river) and let the player decide by free input. Any springboard goes ONLY in the suggestedActions field, kept sparse — never a menu in the prose.",
      "Example (applies even at a life-or-death beat) — [WRONG, never write this] 'The zombie lunges, the axe is stuck. React now:\\n- yank the axe and swing\\n- squeeze sideways through\\n- roll back'; [RIGHT] 'Its claws are already spread, the sour reek of rot in your nose. Your axe is wedged in the twenty-centimeter gap of the door, and it won't come free. Its weight bears down—'. Take the danger to its peak, then stop, and hand the 'what now' entirely to the player's free input — never list options for them.",
    ];
    const actionsRule = mode === "guided"
      ? "suggestedActions: ALWAYS give 2-4 concise, distinct actions that fit the current scene. They are clickable branches and optional springboards, not the only way forward; the player can still type freely."
      : "suggestedActions: 0-3 short hints, optional, never restricting the player's input; omit them when there is no real decision point.";
    return [...base, actionsRule, "Output strict JSON: sceneText, suggestedActions."].join("\n");
  }
  const base = [
    "你是互动小说场景回应作者。",
    "你只能根据已经应用后的状态写回应，不要推翻 reducer 结果。",
    "具体的新物件、线索、证据、地点、组织、具名人物，只能来自「已应用的本回合变化」或「当前状态摘要」。如果正文需要一个新的具体东西，它必须先由 mutator 建成实体；否则只写氛围、压力或不具名的细节。",
    "回应要像可玩的小说：有动作、感官、压迫、留白；绝不是系统日志，也绝不是把玩家往'快做个选择'上赶的菜单旁白。",
    "先承接玩家动作。即使状态已经应用，也不要直接跳到动作完成后；要写出动作的跟进、接触、阻力、打断和即时后果，让玩家原话自然接到新状态。",
    "不要写总结性尾声、主题升华或收束感很强的结语。每回合停在眼前的感官压力、位置变化、暴露出的细节或近处后果上。",
    "严格守住前提确立的那个世界——年代、地点、技术水平、题材基调都要一致。绝不要引入不属于它的元素：现代都市故事别冒出更夫/油灯/二更天，古代武侠故事别冒出手机/汽车/电脑。每一拍的细节都落在前提给定的那个世界里。",
    // 在场即合法
    "玩家不一定每回合都在'行动'。当他只是观察、停留、感受、闲聊、发呆，给一段有沉浸感的回应——一个活的细节、一缕气味、旁人的一个小动作、心里掠过的一个念头。绝不要说'这里没什么可看的了''你已经看过了''别磨蹭'，也绝不要催他快点行动。让这一拍能呼吸。",
    // 世界自走
    "世界不是死的：时间在走、期限在逼近、配角会自己做事、远处会有动静、场外会发生事。哪怕玩家这一拍什么都没做，也让世界往前动一点点——让'前进的压力'来自故事本身（再不动线索就凉了／期限就到了／有人先动了），而不是来自旁白催他选。",
    "如果当前状态摘要里有 Time/时间段，elapsed 和 anchor 是权威时间：正文必须按这段经过时长、这个动作后的世界时间/阶段来写，并把同步发生的压力、人物移动、远处变化自然溶进正文。不得另写一个钟点、另写一段经过时长，也不要写成固定 tick、回合标签或 UI 提示。",
    "玩家原话里的否定动作就是事实。玩家说没有触碰、没有打开、没有拿走、没有离开、没有攻击、没有开口时，正文不能暗示他做了这些事；要写克制本身，以及世界对这份克制的反应。",
    // 不催不逼，也别借角色之口变相逼选
    "不要用'你想怎么做？''你打算往哪走？'这类逼问句收尾；也不要把同样的催促塞进身边同伴的嘴里（'要去 A 还是 B？''去不去问他？'）——同伴不是'选项播报员'，别让他每段都给你列下一步。**多数 beat 根本不该以一个待决问题结束**：落在一个画面、一处声响、一缕气味或悬着的张力上，然后停住。只有当玩家真的走到了非选不可的岔口，才偶尔点出选择。",
    "sceneText 必须是纯叙事散文。**正文里绝不允许出现'选项：''你想怎么做？'后跟 A/B/C 清单，也不允许用'- '列出可选动作**——无论局势多紧急、多像一个岔路口都不行（被围杀的逃命戏也不是甩菜单的借口）。可走的路要自然融进场景描写里（墙下的竹丛、半开的天窗、通向河边的巷尾），让玩家用自由输入自己决定。要给跳板只放进 suggestedActions 字段、少而精；正文里一个选项清单都不要。",
    "对比一例（生死关头也照此办）——【错，绝不要这样写】「丧尸扑来，斧头卡住。你必须立刻做出反应：\\n- 拔斧劈砍\\n- 侧身挤过\\n- 后翻闪避」；【对】「它的爪子已经张开，腐臭的酸味灌进你的鼻腔。你的斧头死死卡在那道二十厘米宽的门缝里，一时拔不出来。它的重心压下来了——」。把险境写到极致，然后停住，把'怎么办'整个交给玩家的自由输入；一个选项都不要替他列。",
  ];
  const actionsRule = mode === "guided"
    ? "suggestedActions：每一回合都必须给出 2-4 个简短、互有区别且符合当前场景的可点击行动。它们是分支入口和行动跳板，不是唯一前进方式；玩家仍然可以自由输入。"
    : "suggestedActions：0-3 个短句，可选，只是参考、不限制玩家输入；没有明显抉择点时就不给。";
  return [...base, actionsRule, "输出严格 JSON：sceneText, suggestedActions。"].join("\n");
}

function buildSceneRendererUserPrompt(input: PlaySceneRenderInput, language: "zh" | "en"): string {
  const premise = input.worldPremise?.trim();
  if (language === "en") {
    return [
      ...(premise ? ["World setting (always obey):", premise, ""] : []),
      "Player's words:",
      input.input,
      "",
      "Action:",
      JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
      "",
      "Applied changes this turn:",
      input.mutationSummary,
      "",
      "Current state summary:",
      input.stateBrief,
      input.replayContext ? ["", "Replay constraints:", input.replayContext].join("\n") : "",
    ].join("\n");
  }
  return [
    ...(premise ? ["世界设定（始终遵守）：", premise, ""] : []),
    "玩家原话：",
    input.input,
    "",
    "动作：",
    JSON.stringify(PlayActionIntentSchema.parse(input.action), null, 2),
    "",
    "已应用的本回合变化：",
    input.mutationSummary,
    "",
    "当前状态摘要：",
    input.stateBrief,
    input.replayContext ? ["", "重写约束：", input.replayContext].join("\n") : "",
  ].join("\n");
}

function parseJson(raw: string): unknown {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Play agent did not return JSON.");
  }
}
