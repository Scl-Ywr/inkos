import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayFileDB } from "../play/play-file-db.js";

describe("PlayFileDB", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "inkos-play-file-db-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists graph state across instances", () => {
    const db = new PlayFileDB(dir);
    db.upsertEntity({ id: "player", type: "actor", label: "宋词" });
    db.upsertEntity({ id: "claim-hidden-home", type: "claim", label: "隐瞒同居地点" });
    db.upsertEdge({
      id: "edge-player-claim",
      fromId: "player",
      type: "investigates",
      toId: "claim-hidden-home",
      validFromEventId: "evt-1",
      sourceEventId: "evt-1",
    });
    db.upsertStateSlot({
      id: "pressure-player-risk",
      ownerEntityId: "player",
      kind: "pressure",
      label: "暴露风险",
      value: { current: 20, min: 0, max: 100 },
      updatedEventId: "evt-1",
    });
    db.recordEvent({
      id: "evt-1",
      turn: 1,
      actionKind: "look",
      rawInput: "看导航",
      outcomeSummary: "发现地址统计",
      createdAt: "2026-05-28T00:00:00.000Z",
    });
    db.close();

    const reopened = new PlayFileDB(dir);
    expect(reopened.getEntity("player")?.label).toBe("宋词");
    expect(reopened.getEvent("evt-1")?.rawInput).toBe("看导航");
    expect(reopened.snapshot()).toMatchObject({
      entities: [expect.objectContaining({ id: "claim-hidden-home" }), expect.objectContaining({ id: "player" })],
      edges: [expect.objectContaining({ id: "edge-player-claim" })],
      stateSlots: [expect.objectContaining({ id: "pressure-player-risk" })],
      events: [expect.objectContaining({ id: "evt-1" })],
    });
  });

  it("rolls back transaction mutations when validation fails inside the transaction", () => {
    const db = new PlayFileDB(dir);

    expect(() => db.transaction(() => {
      db.upsertEntity({ id: "temp", type: "actor", label: "临时角色" });
      throw new Error("fail");
    })).toThrow("fail");

    expect(db.getEntity("temp")).toBeNull();
  });

  it("recovers a truncated world database from the last valid backup", async () => {
    const db = new PlayFileDB(dir);
    db.upsertEntity({ id: "player", type: "actor", label: "宋词" });
    db.upsertEntity({ id: "guide", type: "actor", label: "向导" });
    db.close();

    const filePath = join(dir, "play-graph.json");
    await writeFile(filePath, "{\"entities\":", "utf-8");

    const recovered = new PlayFileDB(dir);
    expect(recovered.getEntity("player")?.label).toBe("宋词");
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toHaveProperty("entities.player");
    expect((await readdir(dir)).some((name) => name.startsWith("play-graph.json.corrupt-"))).toBe(true);
  });
});
