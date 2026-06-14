import { describe, expect, it } from "vitest";
import { buildAutoImageRequests, buildView } from "../PlayHud";

describe("PlayHud buildView", () => {
  it("classifies held inventory from canonical graph edge roles, not status words", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "guided", premise: "查一个配送柜。" },
      graph: {
        entities: [
          { id: "loc-cabinet", type: "location", label: "F-07配送柜", status: "就在面前" },
          { id: "blood", type: "evidence", label: "柜内血迹", status: "已看见，还未采集" },
          { id: "note", type: "clue", label: "夹层纸条", status: "正在查阅" },
        ],
        edges: [
          { id: "edge-hold-note", fromId: "actor_player", type: "拿着", toId: "note", value: { role: "holding", physical: true } },
        ],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.facing.map((row) => row.label)).toEqual([
      "F-07配送柜",
      "柜内血迹",
    ]);
    expect(view?.holdings.map((row) => row.label)).toEqual(["夹层纸条"]);
  });

  it("does not put observed intangible phenomena into the player's inventory", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "open", premise: "后山石缝。" },
      graph: {
        entities: [
          { id: "evidence_grass", type: "evidence", label: "草叶回避现象", status: "已观察到" },
        ],
        edges: [
          { id: "edge-observed-grass", fromId: "actor_player", type: "持有", toId: "evidence_grass", value: { role: "holding" } },
        ],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.facing.map((row) => row.label)).toEqual(["草叶回避现象"]);
    expect(view?.holdings.map((row) => row.label)).toEqual([]);
  });

  it("does not treat inventory-looking status text as authoritative", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "guided", premise: "查一个配送柜。" },
      graph: {
        entities: [
          { id: "note", type: "clue", label: "夹层纸条", status: "已收起" },
        ],
        edges: [],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.facing.map((row) => row.label)).toEqual(["夹层纸条"]);
    expect(view?.holdings.map((row) => row.label)).toEqual([]);
  });

  it("does not infer holdings from relation wording alone", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "guided", premise: "查一个配送柜。" },
      graph: {
        entities: [
          { id: "note", type: "clue", label: "夹层纸条", status: "正在查阅" },
        ],
        edges: [
          { id: "edge-hold-note", fromId: "actor_player", type: "持有", toId: "note" },
        ],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.facing.map((row) => row.label)).toEqual(["夹层纸条"]);
    expect(view?.holdings.map((row) => row.label)).toEqual([]);
  });

  it("only treats actor_player holding edges as the player's inventory", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "guided", premise: "查一个旧站台。" },
      graph: {
        entities: [
          { id: "actor_mechanic", type: "actor", label: "临时维修员", status: "警觉" },
          { id: "ticket", type: "item", label: "旧车票", status: "已收起" },
          { id: "key", type: "item", label: "铜钥匙", status: "已收起" },
        ],
        edges: [
          { id: "edge-wrong-holder", fromId: "actor_mechanic", type: "持有", toId: "ticket", value: { role: "holding" } },
          { id: "edge-player-holder", fromId: "actor_player", type: "持有", toId: "key", value: { role: "holding" } },
        ],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.holdings.map((row) => row.label)).toEqual(["铜钥匙"]);
    expect(view?.facing.map((row) => row.label)).toEqual(["临时维修员", "旧车票"]);
  });

  it("uses semantic relation roles and suppresses duplicate status labels", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "open", premise: "查一个旧站台。" },
      graph: {
        entities: [
          { id: "actor_player", type: "actor", label: "值班员", status: "值班员" },
          { id: "actor_guard", type: "actor", label: "站长", status: "怀疑" },
          { id: "key", type: "item", label: "旧钥匙", status: "已持有" },
        ],
        edges: [
          { id: "edge-hold-key", fromId: "actor_player", type: "持有", toId: "key", value: { role: "holding" } },
          { id: "edge-suspect", fromId: "actor_guard", type: "怀疑", toId: "actor_player", value: { role: "relation" } },
        ],
        stateSlots: [],
        events: [],
      },
    });

    const player = view?.actors.find((row) => row.id === "actor_player");
    expect(player?.note).toBeNull();
    expect(player?.details.map((detail) => detail.text)).toEqual(["怀疑 · 站长"]);
    expect(view?.holdings.map((row) => row.label)).toEqual(["旧钥匙"]);
  });

  it("surfaces semantic world time as a synchronized state row", () => {
    const view = buildView({
      currentState: {
        turn: 2,
        mode: "open",
        premise: "雨夜库房。",
        timeAdvance: {
          elapsed: "几息",
          anchor: "仍在雨夜门外的同一个片刻",
          rationale: "玩家只是屏息观察门外动静。",
          synchronized: ["门外的人也停住脚步，像是在数玩家的呼吸。"],
        },
      },
      graph: {
        entities: [],
        edges: [],
        stateSlots: [],
        events: [],
      },
    });

    expect(view?.time?.label).toBe("世界时间");
    expect(view?.time?.value).toBe("仍在雨夜门外的同一个片刻");
    expect(view?.time?.note).toContain("屏息观察");
    expect(view?.time?.details[0]).toEqual({ label: "经过", text: "几息" });
    expect(view?.time?.details[1]?.text).toContain("数玩家的呼吸");
  });

  it("auto-illustrates enabled actors, holdings, and current moment", () => {
    const view = buildView({
      currentState: { turn: 3, mode: "open", premise: "雨夜库房。" },
      graph: {
        entities: [
          { id: "actor_player", type: "actor", label: "守库弟子" },
          { id: "actor_master", type: "actor", label: "执事", imageUrl: "/ready.png" },
          { id: "item_box", type: "item", label: "铜匣" },
        ],
        edges: [
          { id: "edge-hold-box", fromId: "actor_player", type: "持有", toId: "item_box", value: { role: "holding" } },
        ],
        stateSlots: [],
        events: [],
      },
    });

    expect(buildAutoImageRequests(view, { actors: true, moments: true, inventory: true })).toEqual([
      { key: "actor_player", body: { target: "entity", entityId: "actor_player" } },
      { key: "item_box", body: { target: "entity", entityId: "item_box" } },
      { key: "scene-turn-3", body: { target: "scene" } },
    ]);
  });

  it("does not auto-illustrate the current moment when a scene image is already ready", () => {
    const view = buildView({
      currentState: { turn: 3, mode: "open", premise: "雨夜库房。" },
      graph: { entities: [], edges: [], stateSlots: [], events: [] },
    });

    expect(buildAutoImageRequests(view, { actors: false, moments: true, inventory: false }, "/scene.png")).toEqual([]);
  });

  it("does not auto-illustrate images the user deleted", () => {
    const view = buildView({
      currentState: { turn: 3, mode: "open", premise: "雨夜库房。" },
      graph: {
        entities: [
          { id: "actor_player", type: "actor", label: "守库弟子" },
          { id: "item_box", type: "item", label: "铜匣" },
        ],
        edges: [
          { id: "edge-hold-box", fromId: "actor_player", type: "持有", toId: "item_box", value: { role: "holding" } },
        ],
        stateSlots: [],
        events: [],
      },
    });

    expect(buildAutoImageRequests(
      view,
      { actors: true, moments: true, inventory: true },
      undefined,
      new Set(["actor_player", "item_box", "scene-turn-3"]),
    )).toEqual([]);
  });

  it("surfaces a holding's relationship web from its edges, excluding every player edge", () => {
    const view = buildView({
      currentState: { turn: 2, mode: "open", premise: "推理。" },
      graph: {
        entities: [
          { id: "evi_letter", type: "evidence", label: "血迹信封", createdEventId: "evt-1" },
          { id: "actor_chen", type: "actor", label: "陈守仁" },
          { id: "claim_alibi", type: "claim", label: "不在场证明" },
        ],
        edges: [
          { id: "e-hold", fromId: "actor_player", type: "持有", toId: "evi_letter", value: { role: "holding", physical: true } },
          // A player→holding relation-role edge must also be kept out of the web.
          { id: "e-player-rel", fromId: "actor_player", type: "随身", toId: "evi_letter", value: { role: "relation" } },
          { id: "e-indict", fromId: "evi_letter", type: "指认", toId: "actor_chen", value: { role: "relation" }, strength: 0.8 },
          { id: "e-refute", fromId: "evi_letter", type: "反驳", toId: "claim_alibi", value: { role: "relation" } },
        ],
        stateSlots: [],
        events: [{ id: "evt-1", turn: 1, outcomeSummary: "" }, { id: "evt-2", turn: 2, outcomeSummary: "" }],
      },
    });
    const letter = view?.holdings.find((h) => h.id === "evi_letter");
    expect(letter?.relations).toEqual([
      { targetLabel: "陈守仁", type: "指认", strength: 0.8 },
      { targetLabel: "不在场证明", type: "反驳", strength: undefined },
    ]);
  });

  it("attaches owner-scoped state slots to the holding and keeps unowned slots global", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "open", premise: "rpg。" },
      graph: {
        entities: [{ id: "item_sword", type: "item", label: "断魂刃", createdEventId: "evt-1" }],
        edges: [{ id: "e-hold", fromId: "actor_player", type: "持有", toId: "item_sword", value: { role: "holding" } }],
        stateSlots: [
          { id: "s-atk", ownerEntityId: "item_sword", kind: "resource", label: "攻击", value: 14 },
          { id: "s-dur", ownerEntityId: "item_sword", kind: "resource", label: "耐久", value: { current: 62, max: 80 } },
          { id: "s-world", kind: "pressure", label: "追兵", value: "逼近" },
        ],
        events: [{ id: "evt-1", turn: 1, outcomeSummary: "" }],
      },
    });
    const sword = view?.holdings.find((h) => h.id === "item_sword");
    expect(sword?.meters.map((m) => [m.label, m.value, m.ratio])).toEqual([
      ["攻击", "14", undefined],
      ["耐久", "62/80", 0.775],
    ]);
    expect(view?.meters.map((m) => m.label)).toEqual(["追兵"]);
  });

  it("carries kind and a progress ratio on world-level meters for gauge rendering", () => {
    const view = buildView({
      currentState: { turn: 1, mode: "open", premise: "x。" },
      graph: {
        entities: [],
        edges: [],
        stateSlots: [
          { id: "s-hp", kind: "resource", label: "体力", value: { current: 62, max: 80 } },
          { id: "s-chase", kind: "pressure", label: "追兵", value: "逼近" },
        ],
        events: [],
      },
    });
    expect(view?.meters.map((m) => [m.label, m.kind, m.value, m.ratio])).toEqual([
      ["体力", "resource", "62/80", 0.775],
      ["追兵", "pressure", "逼近", undefined],
    ]);
  });

  it("reads the evidence lifecycle ladder and reason from the owner-scoped evidence slot", () => {
    const view = buildView({
      currentState: { turn: 3, mode: "guided", premise: "推理。" },
      graph: {
        entities: [{ id: "evi_letter", type: "evidence", label: "血迹信封", createdEventId: "evt-1" }],
        edges: [{ id: "e-hold", fromId: "actor_player", type: "持有", toId: "evi_letter", value: { role: "holding", physical: true } }],
        stateSlots: [{
          id: "evidence:evi_letter:status", ownerEntityId: "evi_letter", kind: "evidence", label: "证据状态",
          value: { previous: "seen", status: "verified", reason: "与账本交叉比对一致" },
        }],
        events: [{ id: "evt-1", turn: 1, outcomeSummary: "" }],
      },
    });
    const letter = view?.holdings.find((h) => h.id === "evi_letter");
    expect(letter?.lifecycle?.current).toBe("verified");
    expect(letter?.lifecycle?.reason).toBe("与账本交叉比对一致");
    expect(letter?.lifecycle?.stages).toContain("weaponized");
    expect(letter?.statusPill).toBeUndefined();
    expect(letter?.meters).toEqual([]); // the evidence slot is the ladder, not a meter
  });

  it("marks freshly acquired holdings and records provenance turn", () => {
    const view = buildView({
      currentState: { turn: 7, mode: "open", premise: "rpg。" },
      graph: {
        entities: [
          { id: "item_sword", type: "item", label: "断魂刃", status: "已装备", createdEventId: "evt-7", updatedEventId: "evt-7" },
          { id: "item_key", type: "item", label: "旧钥匙", createdEventId: "evt-2", updatedEventId: "evt-2" },
        ],
        edges: [
          { id: "e1", fromId: "actor_player", type: "持有", toId: "item_sword", value: { role: "holding" } },
          { id: "e2", fromId: "actor_player", type: "持有", toId: "item_key", value: { role: "holding" } },
        ],
        stateSlots: [],
        events: [{ id: "evt-2", turn: 2, outcomeSummary: "" }, { id: "evt-7", turn: 7, outcomeSummary: "你在熔炉镇锻成此刃。" }],
      },
    });
    const sword = view?.holdings.find((h) => h.id === "item_sword");
    const key = view?.holdings.find((h) => h.id === "item_key");
    expect(sword?.isFresh).toBe(true);
    expect(sword?.provenanceTurn).toBe(7);
    expect(sword?.statusPill).toBe("已装备");
    expect(key?.isFresh).toBe(false);
    expect(key?.provenanceTurn).toBe(2);
  });
});
