import { describe, it, expect } from "vitest";
import { latestPlayChoiceSet, latestPlayChoices } from "../play-choices";

describe("latestPlayChoices", () => {
  it("returns suggestedActions from the most recent play tool execution", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "tool", execution: { tool: "play_start", status: "completed", details: { kind: "play_world_started", suggestedActions: ["看账本", "问来人"] } } }] },
      { role: "assistant", parts: [{ type: "tool", execution: { tool: "play_step", status: "completed", details: { kind: "play_turn_advanced", suggestedActions: ["上楼", "离开"] } } }] },
    ] as any;
    expect(latestPlayChoices(messages)).toEqual(["上楼", "离开"]);
  });

  it("returns a stable source key for the latest choice set", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "tool", execution: { id: "tool-old", tool: "play_start", status: "completed", details: { kind: "play_world_started", suggestedActions: ["看账本"] } } }] },
      { role: "assistant", parts: [{ type: "tool", execution: { id: "tool-new", tool: "play_step", status: "completed", details: { kind: "play_turn_advanced", suggestedActions: ["上楼", "离开"] } } }] },
    ] as any;

    expect(latestPlayChoiceSet(messages)).toEqual({
      key: "message-1-part-0:tool-new:[\"上楼\",\"离开\"]",
      choices: ["上楼", "离开"],
    });
  });

  it("creates a fresh key when a later turn reuses the same tool id", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "tool", execution: { id: "play-step", tool: "play_step", status: "completed", details: { kind: "play_turn_advanced", suggestedActions: ["看账本", "问来人"] } } }] },
      { role: "user", content: "看账本" },
      { role: "assistant", parts: [{ type: "tool", execution: { id: "play-step", tool: "play_step", status: "completed", details: { kind: "play_turn_advanced", suggestedActions: ["翻到最后一页", "藏起账本"] } } }] },
    ] as any;

    expect(latestPlayChoiceSet(messages)).toEqual({
      key: "message-2-part-0:play-step:[\"翻到最后一页\",\"藏起账本\"]",
      choices: ["翻到最后一页", "藏起账本"],
    });
  });

  it("also reads direct tool executions before they are rehydrated into parts", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolExecutions: [
          {
            tool: "play_start",
            status: "completed",
            details: {
              kind: "play_world_started",
              suggestedActions: ["检查放映机", "下楼去大堂"],
            },
          },
        ],
      },
    ] as any;

    expect(latestPlayChoiceSet(messages)).toEqual({
      key: "message-0-execution-0:no-tool-id:[\"检查放映机\",\"下楼去大堂\"]",
      choices: ["检查放映机", "下楼去大堂"],
    });
  });

  it("returns [] when there is no play execution", () => {
    expect(latestPlayChoices([{ role: "user", content: "hi" }] as any)).toEqual([]);
  });

  it("uses guided fallback choices for an existing turn without suggested actions", () => {
    const messages = [
      {
        role: "assistant",
        parts: [{
          type: "tool",
          execution: {
            id: "tool-empty",
            tool: "play_step",
            status: "completed",
            details: { kind: "play_turn_advanced", suggestedActions: [] },
          },
        }],
      },
    ] as any;

    expect(latestPlayChoiceSet(messages, ["观察变化", "继续互动"])).toEqual({
      key: "message-0-part-0:tool-empty:[\"观察变化\",\"继续互动\"]",
      choices: ["观察变化", "继续互动"],
    });
  });
});
