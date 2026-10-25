import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./store";

type ReplayRequest = { id: string; payloadHash: string };
type StoredRow = { body: string };
type ReplayRow = { payload_hash: string; result: string };

export class ChatReplayConflict extends Error {}
export class ChatBusy extends Error {}
export class ChatStorageUnavailable extends Error {}

export interface ChatStoreOptions {
  file: string;
  leaseMs?: number;
  waitMs?: number;
  pollMs?: number;
}

export class DurableChatStore {
  readonly file: string;
  private readonly leaseMs: number;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(options: ChatStoreOptions) {
    this.file = options.file;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.waitMs = options.waitMs ?? 270_000;
    this.pollMs = options.pollMs ?? 50;
    if (!path.isAbsolute(this.file) || this.file === ":memory:") throw new ChatStorageUnavailable("Chat storage must use an absolute durable database path.");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(this.file, "a", 0o600));
    fs.chmodSync(this.file, 0o600);
    const db = this.open();
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS chat_rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_room_locks (room_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS chat_requests (room_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY (room_id, request_id));
        CREATE TABLE IF NOT EXISTS chat_replays (
          room_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          result TEXT NOT NULL CHECK(json_valid(result)),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (room_id, request_id)
        );
      `);
    } finally {
      db.close();
    }
  }

  private open(): DatabaseSync {
    try {
      const db = new DatabaseSync(this.file);
      db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
      return db;
    } catch {
      throw new ChatStorageUnavailable("Chat history could not be saved. Please try again later.");
    }
  }

  read<T>(roomId: string): { state?: T; busy: boolean } {
    const db = this.open();
    try {
      const row = db.prepare("SELECT body FROM chat_rooms WHERE id = ?").get(roomId) as StoredRow | undefined;
      const lock = db.prepare("SELECT expires_at FROM chat_room_locks WHERE room_id = ?").get(roomId) as { expires_at: number } | undefined;
      return { state: row ? JSON.parse(row.body) as T : undefined, busy: Boolean(lock && lock.expires_at > Date.now()) };
    } finally {
      db.close();
    }
  }

  reset(roomId: string): void {
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const lock = db.prepare("SELECT expires_at FROM chat_room_locks WHERE room_id = ?").get(roomId) as { expires_at: number } | undefined;
      if (lock && lock.expires_at > Date.now()) throw new ChatBusy("A message in this chat is still being processed. Please try again shortly.");
      db.prepare("DELETE FROM chat_rooms WHERE id = ?").run(roomId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  private replay<R>(roomId: string, request?: ReplayRequest): { found: true; result: R } | { found: false } {
    if (!request) return { found: false };
    const db = this.open();
    try {
      const reserved = db.prepare("SELECT payload_hash FROM chat_requests WHERE room_id = ? AND request_id = ?").get(roomId, request.id) as { payload_hash: string } | undefined;
      if (reserved && reserved.payload_hash !== request.payloadHash) throw new ChatReplayConflict("That message ID was already used for different message contents.");
      const row = db.prepare("SELECT payload_hash, result FROM chat_replays WHERE room_id = ? AND request_id = ?").get(roomId, request.id) as ReplayRow | undefined;
      if (!row) return { found: false };
      if (row.payload_hash !== request.payloadHash) throw new ChatReplayConflict("That message ID was already used for different message contents.");
      return { found: true, result: JSON.parse(row.result) as R };
    } finally {
      db.close();
    }
  }

  private reserve(roomId: string, request: ReplayRequest): void {
    const db = this.open();
    try {
      db.prepare("INSERT OR IGNORE INTO chat_requests (room_id, request_id, payload_hash) VALUES (?, ?, ?)").run(roomId, request.id, request.payloadHash);
      const row = db.prepare("SELECT payload_hash FROM chat_requests WHERE room_id = ? AND request_id = ?").get(roomId, request.id) as { payload_hash: string };
      if (row.payload_hash !== request.payloadHash) throw new ChatReplayConflict("That message ID was already used for different message contents.");
    } finally {
      db.close();
    }
  }

  private acquire(roomId: string, owner: string): boolean {
    const db = this.open();
    try {
      const now = Date.now();
      const result = db.prepare(`INSERT INTO chat_room_locks (room_id, owner, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE chat_room_locks.expires_at <= ?`).run(roomId, owner, now + this.leaseMs, now);
      return Number(result.changes) === 1;
    } finally {
      db.close();
    }
  }

  private renew(roomId: string, owner: string): boolean {
    const db = this.open();
    try {
      const now = Date.now();
      return Number(db.prepare("UPDATE chat_room_locks SET expires_at = ? WHERE room_id = ? AND owner = ? AND expires_at > ?").run(now + this.leaseMs, roomId, owner, now).changes) === 1;
    } finally {
      db.close();
    }
  }

  private release(roomId: string, owner: string): void {
    const db = this.open();
    try {
      db.prepare("UPDATE chat_room_locks SET owner = '', expires_at = 0 WHERE room_id = ? AND owner = ?").run(roomId, owner);
    } finally {
      db.close();
    }
  }

  async transact<T, R>(roomId: string, initial: () => T, run: (state: T) => Promise<R>, request?: ReplayRequest): Promise<R> {
    if (!roomId || roomId.length > 300) throw new Error("A valid chat room is required.");
    if (request && (!request.id || !/^[a-f0-9]{64}$/.test(request.payloadHash))) throw new Error("A message identity and payload hash are required.");
    const first = this.replay<R>(roomId, request);
    if (first.found) return first.result;
    const owner = randomUUID();
    const deadline = Date.now() + this.waitMs;
    while (!this.acquire(roomId, owner)) {
      const cached = this.replay<R>(roomId, request);
      if (cached.found) return cached.result;
      if (Date.now() >= deadline) throw new ChatBusy("A message in this chat is still being processed. Please retry the same message shortly.");
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    let lost = false;
    const heartbeat = setInterval(() => {
      try { if (!this.renew(roomId, owner)) lost = true; } catch { lost = true; }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    try {
      const cached = this.replay<R>(roomId, request);
      if (cached.found) return cached.result;
      if (request) this.reserve(roomId, request);
      const state = this.read<T>(roomId).state ?? initial();
      const result = await run(state);
      if (lost) throw new ChatBusy("Chat processing was interrupted. Please retry the same message shortly.");
      const body = JSON.stringify(state);
      const output = JSON.stringify(result);
      if (body === undefined || output === undefined) throw new Error("Chat state and reply must be serializable.");
      const db = this.open();
      try {
        db.exec("BEGIN IMMEDIATE");
        const lock = db.prepare("SELECT owner, expires_at FROM chat_room_locks WHERE room_id = ?").get(roomId) as { owner: string; expires_at: number } | undefined;
        if (!lock || lock.owner !== owner || lock.expires_at <= Date.now()) throw new ChatBusy("Chat processing was interrupted. Please retry the same message shortly.");
        db.prepare("INSERT INTO chat_rooms (id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at").run(roomId, body, Date.now());
        if (request) db.prepare("INSERT INTO chat_replays (room_id, request_id, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?)").run(roomId, request.id, request.payloadHash, output, Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
      return result;
    } finally {
      clearInterval(heartbeat);
      this.release(roomId, owner);
    }
  }
}

let sharedStore: DurableChatStore | undefined;

export function chatStore(): DurableChatStore {
  if (process.env.VERCEL) throw new ChatStorageUnavailable("Durable chat must run on the persistent chat service, not a serverless filesystem.");
  return sharedStore ??= new DurableChatStore({ file: path.join(DATA_DIR, "chat.db") });
}
