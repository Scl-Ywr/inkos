import { existsSync, mkdirSync } from "node:fs";
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
import type { PlayReducerDB } from "./play-reducer.js";
import { atomicWriteFileSync, readJsonWithBackupSync } from "../utils/atomic-file.js";

interface PlayFileDBData {
  readonly entities: Record<string, PlayEntity>;
  readonly edges: Record<string, PlayEdge>;
  readonly stateSlots: Record<string, PlayStateSlot>;
  readonly events: Record<string, PlayEvent>;
}

export interface PlayGraphSnapshot {
  readonly entities: PlayEntity[];
  readonly edges: PlayEdge[];
  readonly stateSlots: PlayStateSlot[];
  readonly events: PlayEvent[];
}

export class PlayFileDB implements PlayReducerDB {
  private readonly filePath: string;
  private data: PlayFileDBData;
  private transactionBackup: PlayFileDBData | null = null;

  constructor(runDir: string) {
    mkdirSync(runDir, { recursive: true });
    this.filePath = join(runDir, "play-graph.json");
    this.data = this.load();
  }

  upsertEntity(entity: PlayEntityInput): void {
    const parsed = PlayEntitySchema.parse(entity);
    this.data.entities[parsed.id] = parsed;
    this.persistIfNeeded();
  }

  getEntity(id: string): PlayEntity | null {
    return this.data.entities[id] ?? null;
  }

  upsertEdge(edge: PlayEdgeInput): void {
    const parsed = PlayEdgeSchema.parse(edge);
    this.data.edges[parsed.id] = parsed;
    this.persistIfNeeded();
  }

  expireEdge(edgeId: string, validUntilEventId: string): void {
    const edge = this.data.edges[edgeId];
    if (edge) {
      this.data.edges[edgeId] = { ...edge, validUntilEventId };
      this.persistIfNeeded();
    }
  }

  getCurrentEdgesForEntity(entityId: string): PlayEdge[] {
    return Object.values(this.data.edges)
      .filter((edge) => edge.validUntilEventId === null && (edge.fromId === entityId || edge.toId === entityId))
      .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  }

  getEvidenceForClaim(claimId: string): PlayEntity[] {
    return Object.values(this.data.edges)
      .filter((edge) => edge.validUntilEventId === null && edge.type === "supports" && edge.toId === claimId)
      .map((edge) => this.data.entities[edge.fromId])
      .filter((entity): entity is PlayEntity => !!entity && (entity.type === "evidence" || entity.type === "clue"))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  upsertStateSlot(slot: PlayStateSlotInput): void {
    const parsed = PlayStateSlotSchema.parse(slot);
    this.data.stateSlots[parsed.id] = parsed;
    this.persistIfNeeded();
  }

  getStateSlotsForEntity(entityId: string): PlayStateSlot[] {
    return Object.values(this.data.stateSlots)
      .filter((slot) => slot.ownerEntityId === entityId)
      .sort((a, b) => `${a.kind}:${a.label}:${a.id}`.localeCompare(`${b.kind}:${b.label}:${b.id}`));
  }

  recordEvent(event: PlayEventInput): void {
    const parsed = PlayEventSchema.parse(event);
    this.data.events[parsed.id] = parsed;
    this.persistIfNeeded();
  }

  getEvent(id: string): PlayEvent | null {
    return this.data.events[id] ?? null;
  }

  snapshot(): PlayGraphSnapshot {
    return {
      entities: Object.values(this.data.entities).sort((a, b) => a.id.localeCompare(b.id)),
      edges: Object.values(this.data.edges).sort((a, b) => a.id.localeCompare(b.id)),
      stateSlots: Object.values(this.data.stateSlots).sort((a, b) => a.id.localeCompare(b.id)),
      events: Object.values(this.data.events).sort((a, b) => a.turn - b.turn || a.id.localeCompare(b.id)),
    };
  }

  replaceWithSnapshot(snapshot: PlayGraphSnapshot): void {
    const replace = () => {
      this.data = {
        entities: Object.fromEntries(snapshot.entities.map((entity) => [entity.id, PlayEntitySchema.parse(entity)])),
        edges: Object.fromEntries(snapshot.edges.map((edge) => [edge.id, PlayEdgeSchema.parse(edge)])),
        stateSlots: Object.fromEntries(snapshot.stateSlots.map((slot) => [slot.id, PlayStateSlotSchema.parse(slot)])),
        events: Object.fromEntries(snapshot.events.map((event) => [event.id, PlayEventSchema.parse(event)])),
      };
    };
    if (this.transactionBackup) {
      replace();
      return;
    }
    replace();
    this.persist();
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionBackup) {
      return fn();
    }
    this.transactionBackup = cloneData(this.data);
    try {
      const result = fn();
      this.transactionBackup = null;
      this.persist();
      return result;
    } catch (error) {
      const backup = this.transactionBackup;
      if (backup) this.data = backup;
      this.transactionBackup = null;
      this.persist();
      throw error;
    }
  }

  close(): void {
    this.persist();
  }

  private load(): PlayFileDBData {
    if (!existsSync(this.filePath)) return emptyData();
    try {
      const parsed = readJsonWithBackupSync(
        this.filePath,
        (value) => value as Partial<PlayFileDBData>,
      );
      return {
        entities: parseRecord(parsed.entities, PlayEntitySchema),
        edges: parseRecord(parsed.edges, PlayEdgeSchema),
        stateSlots: parseRecord(parsed.stateSlots, PlayStateSlotSchema),
        events: parseRecord(parsed.events, PlayEventSchema),
      };
    } catch (error) {
      throw new Error(
        `Cannot load play world database "${this.filePath}". The damaged file was preserved.`,
        { cause: error },
      );
    }
  }

  private persistIfNeeded(): void {
    if (!this.transactionBackup) this.persist();
  }

  private persist(): void {
    atomicWriteFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

function emptyData(): PlayFileDBData {
  return {
    entities: {},
    edges: {},
    stateSlots: {},
    events: {},
  };
}

function cloneData(data: PlayFileDBData): PlayFileDBData {
  return JSON.parse(JSON.stringify(data)) as PlayFileDBData;
}

function parseRecord<T>(
  value: unknown,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = schema.safeParse(item);
    if (parsed.success) result[key] = parsed.data;
  }
  return result;
}
