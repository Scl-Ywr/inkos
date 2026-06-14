import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolExecution } from "../../../store/chat/types";
import { ToolExecutionSteps, buildPlayRunStatusUrl, buildPlaySceneImageUrl, getGeneratedArtifactDetails, getPlayEditDetails, getPlayToolDetails, getProposedActionContractRows, getProposedActionDetails, groupToolExecutionsChronologically } from "../ToolExecutionSteps";

const makeExec = (overrides: Partial<ToolExecution> & { id: string; tool: string }): ToolExecution => ({
  label: "test",
  status: "completed",
  startedAt: Date.now(),
  ...overrides,
});

describe("groupChronologically", () => {
  it("shows partial Play scene prose while the model is still generating", () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolExecutionSteps, {
        executions: [
          makeExec({
            id: "play-live",
            tool: "play_step",
            label: "推进互动世界",
            status: "running",
            streamingText: "{\"sceneText\":\"雨水顺着旧招牌往下淌，门内传来脚步声",
          }),
        ],
      }),
    );

    expect(html).toContain("互动场景 · 实时生成");
    expect(html).toContain("雨水顺着旧招牌往下淌");
    expect(html).not.toContain("{&quot;sceneText&quot;");
  });

  it("keeps read before pipeline when read happened first", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "sub_agent", agent: "writer", label: "写作" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe("utilities");
    expect(groups[1].type).toBe("pipeline");
  });

  it("groups consecutive utility tools together", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "grep", label: "搜索" }),
      makeExec({ id: "3", tool: "read", label: "读取文件" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("utilities");
    if (groups[0].type === "utilities") {
      expect(groups[0].execs).toHaveLength(3);
    }
  });

  it("interleaves utility groups around pipeline ops", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "sub_agent", agent: "writer", label: "写作" }),
      makeExec({ id: "3", tool: "read", label: "读取文件" }),
      makeExec({ id: "4", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("utilities");
    expect(groups[1].type).toBe("pipeline");
    expect(groups[2].type).toBe("utilities");
    if (groups[2].type === "utilities") {
      expect(groups[2].execs).toHaveLength(2);
    }
  });

  it("handles pipeline-only executions", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "sub_agent", agent: "writer", label: "写作" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("pipeline");
  });

  it("handles empty array", () => {
    expect(groupToolExecutionsChronologically([])).toHaveLength(0);
  });

  it("renders short fiction and cover tools as visible pipeline cards", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "generate_cover", label: "生成封面" }),
      makeExec({ id: "3", tool: "short_fiction_run", label: "短篇生产" }),
      makeExec({ id: "4", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("generate_cover");
    expect(groups[2].type === "pipeline" ? groups[2].exec.tool : "").toBe("short_fiction_run");
  });

  it("renders play tools as visible pipeline cards", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "play_start", label: "启动互动世界" }),
      makeExec({ id: "3", tool: "play_edit", label: "编辑互动世界" }),
      makeExec({ id: "4", tool: "play_revise", label: "重做互动回合" }),
      makeExec({ id: "5", tool: "play_step", label: "推进互动世界" }),
      makeExec({ id: "6", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(6);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "pipeline", "pipeline", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("play_start");
    expect(groups[2].type === "pipeline" ? groups[2].exec.tool : "").toBe("play_edit");
    expect(groups[3].type === "pipeline" ? groups[3].exec.tool : "").toBe("play_revise");
    expect(groups[4].type === "pipeline" ? groups[4].exec.tool : "").toBe("play_step");
  });

  it("renders proposed actions as visible pipeline cards", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "propose_action", label: "确认动作" }),
      makeExec({ id: "3", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("propose_action");
  });

  it("renders context compression as a visible pipeline card", () => {
    const execs: ToolExecution[] = [
      makeExec({ id: "1", tool: "read", label: "读取文件" }),
      makeExec({ id: "2", tool: "context_compression", label: "整理会话记忆" }),
      makeExec({ id: "3", tool: "grep", label: "搜索" }),
    ];

    const groups = groupToolExecutionsChronologically(execs);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.type)).toEqual(["utilities", "pipeline", "utilities"]);
    expect(groups[1].type === "pipeline" ? groups[1].exec.tool : "").toBe("context_compression");
  });

  it("extracts generated cover details from public short fiction tools", () => {
    const exec = makeExec({
      id: "short-1",
      tool: "short_fiction_run",
      label: "短篇生产",
      details: {
        kind: "short_fiction_created",
        storyId: "demo-story",
        finalMarkdownPath: "shorts/demo-story/final/full.md",
        salesPackagePath: "shorts/demo-story/final/sales-package.md",
        coverImagePath: "shorts/demo-story/final/cover.png",
      },
    });

    expect(getGeneratedArtifactDetails(exec)).toMatchObject({
      kind: "short_fiction_created",
      storyId: "demo-story",
      finalMarkdownPath: "shorts/demo-story/final/full.md",
      salesPackagePath: "shorts/demo-story/final/sales-package.md",
      coverImagePath: "shorts/demo-story/final/cover.png",
    });
  });

  it("extracts play scene details from play tools", () => {
    const exec = makeExec({
      id: "play-1",
      tool: "play_step",
      label: "推进互动世界",
      details: {
        kind: "play_turn_advanced",
        title: "雨夜茶馆",
        worldId: "rain-teahouse",
        runId: "main",
        sceneText: "你翻开账本，发现一张旧船票。",
        suggestedActions: ["藏起船票", "追问来人"],
        currentState: { turn: 3 },
      },
    });

    expect(getPlayToolDetails(exec)).toMatchObject({
      kind: "play_turn_advanced",
      title: "雨夜茶馆",
      worldId: "rain-teahouse",
      runId: "main",
      turn: 3,
      sceneText: "你翻开账本，发现一张旧船票。",
      suggestedActions: ["藏起船票", "追问来人"],
    });
  });

  it("extracts revised play scene details", () => {
    const exec = makeExec({
      id: "play-revise-1",
      tool: "play_revise",
      label: "重做互动回合",
      details: {
        kind: "play_turn_revised",
        title: "雨夜茶馆",
        worldId: "rain-teahouse",
        runId: "main",
        sceneText: "你重新翻开账本，先看见夹层里的红印。",
        suggestedActions: ["取出红印", "合上账本"],
        variantId: "v-new",
      },
    });

    expect(getPlayToolDetails(exec)).toMatchObject({
      kind: "play_turn_revised",
      title: "雨夜茶馆",
      worldId: "rain-teahouse",
      runId: "main",
      sceneText: "你重新翻开账本，先看见夹层里的红印。",
      suggestedActions: ["取出红印", "合上账本"],
      variantId: "v-new",
    });
  });

  it("does not render suggested play actions as non-clickable text in the result card", () => {
    const html = renderToStaticMarkup(React.createElement(ToolExecutionSteps, {
      executions: [
        makeExec({
          id: "play-choices-1",
          tool: "play_step",
          label: "推进互动世界",
          details: {
            kind: "play_turn_advanced",
            worldId: "rain-teahouse",
            runId: "main",
            sceneText: "你翻开账本，发现一张旧船票。",
            suggestedActions: ["藏起船票", "追问来人"],
            currentState: { turn: 3 },
          },
        }),
      ],
    }));

    expect(html).toContain("你翻开账本");
    expect(html).not.toContain("藏起船票");
    expect(html).not.toContain("追问来人");
  });

  it("does not guess a scene image file path before the run manifest reports it ready", () => {
    const details = {
      kind: "play_turn_advanced" as const,
      worldId: "rain-teahouse",
      runId: "main",
      turn: 3,
      sceneText: "你翻开账本。",
    };

    expect(buildPlaySceneImageUrl(details)).toBeNull();
    expect(buildPlayRunStatusUrl(details)).toBe("/api/v1/play/runs/rain-teahouse/main");
  });

  it("does not render stale direct scene image urls after the run marks them deleted", () => {
    const details = {
      kind: "play_turn_advanced" as const,
      worldId: "rain-teahouse",
      runId: "main",
      turn: 3,
      sceneImageUrl: "/api/v1/play/runs/rain-teahouse/main/images/scene-turn-3.png",
      sceneText: "你翻开账本。",
    };

    expect(buildPlaySceneImageUrl(details, { deletedImageKeys: ["scene-turn-3"] })).toBeNull();
  });

  it("extracts play edit details", () => {
    const exec = makeExec({
      id: "play-edit-1",
      tool: "play_edit",
      label: "编辑互动世界",
      details: {
        kind: "play_world_updated",
        worldId: "rain-flat",
        runId: "main",
        updatedWorldContract: true,
        updatedVisualContract: true,
        updatedPremise: false,
        updatedEntities: 2,
      },
    });

    expect(getPlayEditDetails(exec)).toMatchObject({
      kind: "play_world_updated",
      worldId: "rain-flat",
      runId: "main",
      updatedWorldContract: true,
      updatedVisualContract: true,
      updatedPremise: false,
      updatedEntities: 2,
    });
  });

  it("extracts proposed action details", () => {
    const exec = makeExec({
      id: "proposal-1",
      tool: "propose_action",
      label: "确认动作",
      details: {
        kind: "proposed_action",
        action: "short_run",
        targetSessionKind: "short",
        sameSession: true,
        title: "生成短篇",
        summary: "确认后生成完整短篇。",
        instruction: "写一篇婚姻反杀短篇",
        actionPayload: {
          shortRun: {
            direction: "婚姻反杀",
            chapters: 12,
            charsPerChapter: 1000,
            cover: true,
          },
        },
      },
    });

    expect(getProposedActionDetails(exec)).toMatchObject({
      kind: "proposed_action",
      execId: "proposal-1",
      action: "short_run",
      targetSessionKind: "short",
      sameSession: true,
      title: "生成短篇",
      instruction: "写一篇婚姻反杀短篇",
      actionPayload: {
        shortRun: {
          direction: "婚姻反杀",
          chapters: 12,
          charsPerChapter: 1000,
          cover: true,
        },
      },
    });
  });

  it("extracts proposed route actions for existing Studio workflows", () => {
    const cases = [
      { action: "fanfic_init", route: "import:fanfic", title: "打开同人创作" },
      { action: "spinoff_create", route: "import:spinoff", title: "打开番外创作" },
      { action: "style_imitation", route: "import:imitation", title: "打开仿写创作" },
    ] as const;

    for (const item of cases) {
      const exec = makeExec({
        id: `proposal-route-${item.action}`,
        tool: "propose_action",
        label: "确认动作",
        details: {
          kind: "proposed_action",
          action: item.action,
          targetSessionKind: "chat",
          targetRoute: item.route,
          title: item.title,
          summary: "确认后打开对应工具入口。",
          instruction: "打开对应工具，等待用户补充材料。",
        },
      });

      expect(getProposedActionDetails(exec)).toMatchObject({
        kind: "proposed_action",
        execId: `proposal-route-${item.action}`,
        action: item.action,
        targetSessionKind: "chat",
        targetRoute: item.route,
        title: item.title,
        instruction: "打开对应工具，等待用户补充材料。",
      });
    }
  });

  it("extracts Play world and visual contracts for confirmation cards", () => {
    const exec = makeExec({
      id: "proposal-play-contract",
      tool: "propose_action",
      label: "确认动作",
      details: {
        kind: "proposed_action",
        action: "play_start",
        targetSessionKind: "play",
        title: "玄照山外门",
        instruction: "启动一个修仙开放世界。",
        actionPayload: {
          playStart: {
            title: "玄照山外门",
            worldContract: "时间是世界同步轴；角色会自主修炼和布局；不要固定 tick 或 RPG 面板。",
            visualContract: "法器珍惜程度通过材质、光泽和旁人反应体现，不要绿蓝紫橙边框。",
          },
        },
      },
    });

    const details = getProposedActionDetails(exec);
    expect(details).not.toBeNull();
    expect(getProposedActionContractRows(details!)).toEqual([
      {
        label: "世界契约",
        value: expect.stringContaining("时间是世界同步轴"),
      },
      {
        label: "视觉契约",
        value: expect.stringContaining("不要绿蓝紫橙边框"),
      },
    ]);
  });

  it("ignores invalid proposed target routes", () => {
    const exec = makeExec({
      id: "proposal-bad-route",
      tool: "propose_action",
      label: "确认动作",
      details: {
        kind: "proposed_action",
        action: "fanfic_init",
        targetSessionKind: "chat",
        targetRoute: "https://example.com",
        instruction: "打开同人工具。",
      },
    });

    expect(getProposedActionDetails(exec)).toMatchObject({
      action: "fanfic_init",
      targetRoute: undefined,
    });
  });
});
