import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  PlayEdgeSchema,
  PlayEntitySchema,
  PlayEventSchema,
  PlayStateSlotSchema,
  type PlayEdge,
  type PlayEdgeInput,
  type PlayEntity,
  type PlayEntityInput,
  type PlayEvent,
  type PlayEventInput,
  type PlayStateSlot,
  type PlayStateSlotInput,
} from "../models/play.js";
import type { PlayGraphSnapshot } from "./play-file-db.js";

const require = createRequire(import.meta.url);

const ENTITY_SELECT_COLUMNS = `
  entities.id,
  entities.type,
  entities.label,
  entities.summary,
  entities.status,
  entities.created_event AS createdEventId,
  entities.updated_event AS updatedEventId
`;

const EDGE_SELECT_COLUMNS = `
  id,
  from_id AS fromId,
  type,
  to_id AS toId,
  value_json AS valueJson,
  valid_from_event AS validFromEventId,
  valid_until_event AS validUntilEventId,
  source_event_id AS sourceEventId,
  visibility_json AS visibilityJson,
  strength,
  confidence
`;

const STATE_SLOT_SELECT_COLUMNS = `
  id,
  owner_entity_id AS ownerEntityId,
  kind,
  label,
  value_json AS valueJson,
  updated_event AS updatedEventId
`;

const EVENT_SELECT_COLUMNS = `
  id,
  turn,
  action_kind AS actionKind,
  raw_input AS rawInput,
  outcome_summary AS outcomeSummary,
  created_at AS createdAt
`;

export class PlayDB {
  private readonly db: any;

  constructor(runDir: string) {
    mkdirSync(runDir, { recursive: true });
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(join(runDir, "play.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        created_event TEXT,
        updated_event TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        value_json TEXT NOT NULL DEFAULT '{}',
        valid_from_event TEXT NOT NULL,
        valid_until_event TEXT,
        source_event_id TEXT NOT NULL,
        visibility_json TEXT NOT NULL DEFAULT '{}',
        strength REAL,
        confidence REAL
      );

      CREATE TABLE IF NOT EXISTS state_slots (
        id TEXT PRIMARY KEY,
        owner_entity_id TEXT,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_event TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        turn INTEGER NOT NULL,
        action_kind TEXT NOT NULL,
        raw_input TEXT NOT NULL,
        outcome_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_play_edges_from ON edges(from_id, valid_until_event);
      CREATE INDEX IF NOT EXISTS idx_play_edges_to ON edges(to_id, type, valid_until_event);
      CREATE INDEX IF NOT EXISTS idx_play_state_owner ON state_slots(owner_entity_id);
      CREATE INDEX IF NOT EXISTS idx_play_events_turn ON events(turn);
    `);
  }

  upsertEntity(entity: PlayEntityInput): void {
    const parsed = PlayEntitySchema.parse(entity);
    this.db.prepare(
      `INSERT OR REPLACE INTO entities (id, type, label, summary, status, created_event, updated_event)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.id,
      parsed.type,
      parsed.label,
      parsed.summary,
      parsed.status,
      parsed.createdEventId ?? null,
      parsed.updatedEventId ?? null,
    );
  }

  getEntity(id: string): PlayEntity | null {
    const row = this.db.prepare(
      `SELECT ${ENTITY_SELECT_COLUMNS} FROM entities WHERE id = ?`,
    ).get(id) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  upsertEdge(edge: PlayEdgeInput): void {
    const parsed = PlayEdgeSchema.parse(edge);
    this.db.prepare(
      `INSERT OR REPLACE INTO edges (
         id, from_id, type, to_id, value_json, valid_from_event, valid_until_event,
         source_event_id, visibility_json, strength, confidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.id,
      parsed.fromId,
      parsed.type,
      parsed.toId,
      JSON.stringify(parsed.value),
      parsed.validFromEventId,
      parsed.validUntilEventId,
      parsed.sourceEventId,
      JSON.stringify(parsed.visibility),
      parsed.strength ?? null,
      parsed.confidence ?? null,
    );
  }

  expireEdge(edgeId: string, validUntilEventId: string): void {
    this.db.prepare(
      "UPDATE edges SET valid_until_event = ? WHERE id = ?",
    ).run(validUntilEventId, edgeId);
  }

  getCurrentEdgesForEntity(entityId: string): PlayEdge[] {
    const rows = this.db.prepare(
      `SELECT ${EDGE_SELECT_COLUMNS}
       FROM edges
       WHERE (from_id = ? OR to_id = ?) AND valid_until_event IS NULL
       ORDER BY type, id`,
    ).all(entityId, entityId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getEvidenceForClaim(claimId: string): PlayEntity[] {
    const rows = this.db.prepare(
      `SELECT ${ENTITY_SELECT_COLUMNS}
       FROM entities
       INNER JOIN edges ON entities.id = edges.from_id
       WHERE edges.to_id = ?
         AND edges.type = 'supports'
         AND edges.valid_until_event IS NULL
         AND entities.type IN ('evidence', 'clue')
       ORDER BY COALESCE(edges.strength, 0) DESC, entities.id ASC`,
    ).all(claimId) as EntityRow[];
    return rows.map(rowToEntity);
  }

  upsertStateSlot(slot: PlayStateSlotInput): void {
    const parsed = PlayStateSlotSchema.parse(slot);
    this.db.prepare(
      `INSERT OR REPLACE INTO state_slots (id, owner_entity_id, kind, label, value_json, updated_event)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.id,
      parsed.ownerEntityId ?? null,
      parsed.kind,
      parsed.label,
      JSON.stringify(parsed.value),
      parsed.updatedEventId,
    );
  }

  getStateSlotsForEntity(entityId: string): PlayStateSlot[] {
    const rows = this.db.prepare(
      `SELECT ${STATE_SLOT_SELECT_COLUMNS}
       FROM state_slots
       WHERE owner_entity_id = ?
       ORDER BY kind, label, id`,
    ).all(entityId) as StateSlotRow[];
    return rows.map(rowToStateSlot);
  }

  recordEvent(event: PlayEventInput): void {
    const parsed = PlayEventSchema.parse(event);
    this.db.prepare(
      `INSERT OR REPLACE INTO events (id, turn, action_kind, raw_input, outcome_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.id,
      parsed.turn,
      parsed.actionKind,
      parsed.rawInput,
      parsed.outcomeSummary,
      parsed.createdAt,
    );
  }

  getEvent(id: string): PlayEvent | null {
    const row = this.db.prepare(
      `SELECT ${EVENT_SELECT_COLUMNS} FROM events WHERE id = ?`,
    ).get(id) as EventRow | undefined;
    return row ? PlayEventSchema.parse(row) : null;
  }

  snapshot(): PlayGraphSnapshot {
    const entities = this.db.prepare(
      `SELECT ${ENTITY_SELECT_COLUMNS} FROM entities ORDER BY id`,
    ).all() as EntityRow[];
    const edges = this.db.prepare(
      `SELECT ${EDGE_SELECT_COLUMNS} FROM edges ORDER BY id`,
    ).all() as EdgeRow[];
    const stateSlots = this.db.prepare(
      `SELECT ${STATE_SLOT_SELECT_COLUMNS} FROM state_slots ORDER BY id`,
    ).all() as StateSlotRow[];
    const events = this.db.prepare(
      `SELECT ${EVENT_SELECT_COLUMNS} FROM events ORDER BY turn, id`,
    ).all() as EventRow[];
    return {
      entities: entities.map(rowToEntity),
      edges: edges.map(rowToEdge),
      stateSlots: stateSlots.map(rowToStateSlot),
      events: events.map((row) => PlayEventSchema.parse(row)),
    };
  }

  replaceWithSnapshot(snapshot: PlayGraphSnapshot): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM state_slots").run();
      this.db.prepare("DELETE FROM edges").run();
      this.db.prepare("DELETE FROM entities").run();
      this.db.prepare("DELETE FROM events").run();
      for (const event of snapshot.events) this.recordEvent(event);
      for (const entity of snapshot.entities) this.upsertEntity(entity);
      for (const edge of snapshot.edges) this.upsertEdge(edge);
      for (const slot of snapshot.stateSlots) this.upsertStateSlot(slot);
    });
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

interface EntityRow {
  readonly id: string;
  readonly type: PlayEntity["type"];
  readonly label: string;
  readonly summary: string;
  readonly status: string;
  readonly createdEventId: string | null;
  readonly updatedEventId: string | null;
}

interface EdgeRow {
  readonly id: string;
  readonly fromId: string;
  readonly type: string;
  readonly toId: string;
  readonly valueJson: string;
  readonly validFromEventId: string;
  readonly validUntilEventId: string | null;
  readonly sourceEventId: string;
  readonly visibilityJson: string;
  readonly strength: number | null;
  readonly confidence: number | null;
}

interface StateSlotRow {
  readonly id: string;
  readonly ownerEntityId: string | null;
  readonly kind: PlayStateSlot["kind"];
  readonly label: string;
  readonly valueJson: string;
  readonly updatedEventId: string;
}

interface EventRow {
  readonly id: string;
  readonly turn: number;
  readonly actionKind: PlayEvent["actionKind"];
  readonly rawInput: string;
  readonly outcomeSummary: string;
  readonly createdAt: string;
}

function rowToEntity(row: EntityRow): PlayEntity {
  return PlayEntitySchema.parse({
    id: row.id,
    type: row.type,
    label: row.label,
    summary: row.summary,
    status: row.status,
    ...(row.createdEventId ? { createdEventId: row.createdEventId } : {}),
    ...(row.updatedEventId ? { updatedEventId: row.updatedEventId } : {}),
  });
}

function rowToEdge(row: EdgeRow): PlayEdge {
  return PlayEdgeSchema.parse({
    id: row.id,
    fromId: row.fromId,
    type: row.type,
    toId: row.toId,
    value: parseJsonObject(row.valueJson),
    validFromEventId: row.validFromEventId,
    validUntilEventId: row.validUntilEventId,
    sourceEventId: row.sourceEventId,
    visibility: parseJsonObject(row.visibilityJson),
    ...(row.strength === null ? {} : { strength: row.strength }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
  });
}

function rowToStateSlot(row: StateSlotRow): PlayStateSlot {
  return PlayStateSlotSchema.parse({
    id: row.id,
    ownerEntityId: row.ownerEntityId,
    kind: row.kind,
    label: row.label,
    value: JSON.parse(row.valueJson) as unknown,
    updatedEventId: row.updatedEventId,
  });
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
