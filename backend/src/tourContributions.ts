import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";
import { DATA_DIR } from "./store";
import { tigerDatabasePgOptions, type TigerDatabaseTrust } from "./tigerConnection";

export const TOUR_UPLOAD_LIMITS = {
  maxPhotos: 6,
  maxPhotoBytes: 3 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024,
  maxBodyBytes: 3 * 1024 * 1024 + 128 * 1024,
  maxPixels: 24_000_000,
  maxNormalizedBytes: 24 * 1024 * 1024,
  maxStoredBytes: 1024 * 1024 * 1024,
  maxContributions: 500,
} as const;

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("0.0.0.0", "ipv4");
loopbackAddresses.addAddress("::", "ipv6");
loopbackAddresses.addAddress("::1", "ipv6");
loopbackAddresses.addAddress("::ffff:0.0.0.0", "ipv6");
loopbackAddresses.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function localHostname(value: string): boolean {
  const dotted = value.toLowerCase().replace(/\.+$/u, "");
  const hostname = dotted.startsWith("[") && dotted.endsWith("]") ? dotted.slice(1, -1) : dotted;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  const family = isIP(hostname);
  return family === 4 ? loopbackAddresses.check(hostname, "ipv4") : family === 6 ? loopbackAddresses.check(hostname, "ipv6") : false;
}

export class TourContributionError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
  }
}

export interface TourContributionInput {
  eventName: string;
  eventUrl: string;
  location?: string;
  consent: boolean;
  photos: { bytes: Uint8Array; contentType?: string }[];
}

export interface TourContributionReceipt {
  receiptId: string;
  eventName: string;
  photoCount: number;
  status: "received";
  storage: "tigerdata" | "sqlite" | "postgres" | "supabase";
  message: string;
}

type CleanPhoto = { bytes: Buffer; extension: "jpg" | "png" | "webp"; width: number; height: number };
type PhotoManifest = { file: string; width: number; height: number; bytes: number };
type ContributionRow = { id: string; event_name: string; event_url: string; location: string; received_at: string; status: string; bytes: number; photos: string };

export interface TourContributionStorage {
  readonly kind: TourContributionReceipt["storage"];
  reserve(source: string): string | Promise<string>;
  release(ticket: string): void | Promise<void>;
  receive(ticket: string, input: TourContributionInput): Promise<TourContributionReceipt>;
}

function receipt(id: string, eventName: string, photoCount: number, storage: TourContributionReceipt["storage"]): TourContributionReceipt {
  return { receiptId: id, eventName, photoCount, status: "received", storage, message: "Photos received for venue tour review. Uploading does not automatically create or publish a 3D tour." };
}

function contentType(file: string): string {
  return file.endsWith(".jpg") ? "image/jpeg" : file.endsWith(".png") ? "image/png" : "image/webp";
}

function manifestFor(photos: CleanPhoto[]): PhotoManifest[] {
  return photos.map((photo) => ({ file: `${randomUUID()}.${photo.extension}`, width: photo.width, height: photo.height, bytes: photo.bytes.byteLength }));
}

async function legacyPhotos(directory: string, row: ContributionRow): Promise<{ manifest: PhotoManifest[]; bytes: Buffer[] }> {
  if (!/^[a-f0-9-]{36}$/.test(row.id)) throw new Error("Invalid legacy contribution");
  const manifest: unknown = JSON.parse(row.photos);
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > TOUR_UPLOAD_LIMITS.maxPhotos) throw new Error("Invalid legacy photos");
  const folder = path.join(directory, row.id);
  if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw new Error("Invalid legacy folder");
  const bytes = manifest.map((photo: PhotoManifest) => {
    if (!photo || !/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(photo.file) || !Number.isSafeInteger(photo.bytes) || photo.bytes < 1 || !Number.isSafeInteger(photo.width) || !Number.isSafeInteger(photo.height) || photo.width < 1 || photo.height < 1 || photo.width * photo.height > TOUR_UPLOAD_LIMITS.maxPixels) throw new Error("Invalid legacy photo");
    const file = path.join(folder, photo.file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== photo.bytes || stat.size > TOUR_UPLOAD_LIMITS.maxNormalizedBytes) throw new Error("Incomplete legacy photo");
    const data = fs.readFileSync(file);
    if (!imageFormat(data)) throw new Error("Invalid legacy image");
    return data;
  });
  if (bytes.reduce((total, data) => total + data.byteLength, 0) !== Number(row.bytes)) throw new Error("Incomplete legacy contribution");
  for (const [index, data] of bytes.entries()) {
    const metadata = await sharp(data, { limitInputPixels: TOUR_UPLOAD_LIMITS.maxPixels, failOn: "error" }).metadata();
    if (metadata.width !== manifest[index].width || metadata.height !== manifest[index].height || (metadata.pages ?? 1) > 1) throw new Error("Invalid legacy image dimensions");
    await sharp(data, { limitInputPixels: TOUR_UPLOAD_LIMITS.maxPixels, failOn: "error" }).stats();
  }
  return { manifest, bytes };
}

export function tourContributionOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
  const destination = new URL(request.url);
  const allowed = new Set<string>();
  if (!localHostname(destination.hostname)) allowed.add(destination.origin);
  try {
    const source = new URL(origin);
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    let localBind = false;
    if (host) {
      const requestHost = new URL(`${destination.protocol}//${host}`);
      localBind = localHostname(destination.hostname) && localHostname(requestHost.hostname) && requestHost.port === source.port;
    }
    if (process.env.NODE_ENV !== "production" && localHostname(source.hostname) && (localHostname(destination.hostname) || localBind) && source.protocol === destination.protocol && source.port === destination.port) allowed.add(source.origin);
  } catch {}
  for (const value of [process.env.SMILE_PUBLIC_ORIGIN, process.env.SMILE_PUBLIC_URL, process.env.SMILE_WEB_URL, process.env.NEXT_PUBLIC_APP_URL, "https://smilefromhereto.work", "https://www.smilefromhereto.work"]) {
    if (!value) continue;
    try {
      const configured = new URL(value);
      if (!localHostname(configured.hostname)) allowed.add(configured.origin);
    } catch {}
  }
  return allowed.has(origin);
}

function textField(value: unknown, label: string, maxLength: number, required = true): string {
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))
    throw new TourContributionError(`Please enter a valid ${label}.`, 400);
  const cleaned = value.trim();
  if (required && !cleaned) throw new TourContributionError(`Please enter the ${label}.`, 400);
  return cleaned;
}

function eventFields(input: TourContributionInput) {
  const eventName = textField(input.eventName, "event name", 160);
  const location = textField(input.location ?? "", "venue or city", 240, false);
  let eventUrl: URL;
  try { eventUrl = new URL(textField(input.eventUrl, "event website", 2048)); }
  catch { throw new TourContributionError("Please enter the event's public website, starting with https:// or http://.", 400); }
  const host = eventUrl.hostname.toLowerCase();
  if (!["http:", "https:"].includes(eventUrl.protocol) || eventUrl.username || eventUrl.password || !host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host === "localhost" || /^\[|^[0-9.]+$/.test(host))
    throw new TourContributionError("Please use a public event website without account details in the link.", 400);
  eventUrl.hash = "";
  if (input.consent !== true) throw new TourContributionError("Please confirm that you have permission to share these photos for venue tour review.", 400);
  return { eventName, eventUrl: eventUrl.toString(), location };
}

function imageFormat(bytes: Uint8Array): "jpeg" | "png" | "webp" | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "webp";
  return undefined;
}

export async function normalizeTourPhotos(photos: TourContributionInput["photos"]): Promise<CleanPhoto[]> {
  if (!Array.isArray(photos) || photos.length < 1 || photos.length > TOUR_UPLOAD_LIMITS.maxPhotos)
    throw new TourContributionError("Please select between one and six photos.", 400);
  let total = 0;
  for (const photo of photos) {
    if (!(photo?.bytes instanceof Uint8Array) || photo.bytes.byteLength < 1) throw new TourContributionError("An uploaded photo is empty.", 400);
    total += photo.bytes.byteLength;
    if (photo.bytes.byteLength > TOUR_UPLOAD_LIMITS.maxPhotoBytes || total > TOUR_UPLOAD_LIMITS.maxTotalBytes)
      throw new TourContributionError("Please keep the selected photos under 3 MB in total. You can send another batch later.", 413);
  }
  const cleaned: CleanPhoto[] = [];
  let normalizedBytes = 0;
  for (const photo of photos) {
    const format = imageFormat(photo.bytes);
    if (!format || (photo.contentType && !["image/jpeg", "image/jpg", "image/png", "image/webp", "application/octet-stream"].includes(photo.contentType.toLowerCase())))
      throw new TourContributionError("Please use JPEG, PNG or WebP photos. Other file types are not accepted.", 415);
    try {
      const options = { limitInputPixels: TOUR_UPLOAD_LIMITS.maxPixels, failOn: "error" as const, sequentialRead: true };
      const source = Buffer.from(photo.bytes);
      const metadata = await sharp(source, options).metadata();
      if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width * metadata.height > TOUR_UPLOAD_LIMITS.maxPixels || (metadata.pages ?? 1) > 1)
        throw new TourContributionError("Please use a still photo no larger than 24 megapixels.", 415);
      const image = sharp(source, options).rotate();
      const output = await (format === "jpeg" ? image.jpeg({ quality: 95 }) : format === "png" ? image.png({ compressionLevel: 9 }) : image.webp({ quality: 95 })).toBuffer({ resolveWithObject: true });
      normalizedBytes += output.data.byteLength;
      if (normalizedBytes > TOUR_UPLOAD_LIMITS.maxNormalizedBytes) throw new TourContributionError("These photos are too large after processing. Please upload smaller copies.", 413);
      cleaned.push({ bytes: output.data, extension: format === "jpeg" ? "jpg" : format, width: output.info.width, height: output.info.height });
    } catch (error) {
      if (error instanceof TourContributionError) throw error;
      throw new TourContributionError("A photo could not be read safely. Please choose a different JPEG, PNG or WebP image.", 415);
    }
  }
  return cleaned;
}

export class TourContributionStore implements TourContributionStorage {
  readonly kind = "sqlite" as const;
  readonly directory: string;
  readonly database: string;
  private ready: Promise<void> | undefined;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) throw new TourContributionError("Photo storage is not available right now. Please try again later.", 503);
    this.directory = directory;
    this.database = path.join(directory, "contributions.db");
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      fs.closeSync(fs.openSync(this.database, "a", 0o600));
      fs.chmodSync(this.database, 0o600);
      const db = this.open();
      try {
        db.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS contribution_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS contribution_attempts (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS contribution_attempt_time ON contribution_attempts (created_at);
          CREATE TABLE IF NOT EXISTS tour_contributions (id TEXT PRIMARY KEY, event_name TEXT NOT NULL, event_url TEXT NOT NULL, location TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL, bytes INTEGER NOT NULL, photos TEXT NOT NULL CHECK(json_valid(photos)));
          CREATE TABLE IF NOT EXISTS tour_contribution_photos (contribution_id TEXT NOT NULL REFERENCES tour_contributions(id), position INTEGER NOT NULL, file TEXT NOT NULL, content_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0), data BLOB NOT NULL CHECK(length(data) = bytes), PRIMARY KEY (contribution_id, position));
        `);
        db.prepare("INSERT OR IGNORE INTO contribution_settings (id, value) VALUES ('rate_salt', ?)").run(randomBytes(32).toString("hex"));
      } finally { db.close(); }
    } catch {
      throw new TourContributionError("Photo storage is not available right now. Please try again later.", 503);
    }
  }

  async prepare(): Promise<void> {
    this.ready ??= (async () => {
      const db = this.open();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const rows = db.prepare("SELECT * FROM tour_contributions").all() as ContributionRow[];
          const insert = db.prepare("INSERT INTO tour_contribution_photos (contribution_id, position, file, content_type, width, height, bytes, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
          for (const row of rows) {
            const stored = db.prepare("SELECT position, file, width, height, bytes, length(data) AS length FROM tour_contribution_photos WHERE contribution_id = ? ORDER BY position").all(row.id) as { position: number; file: string; width: number; height: number; bytes: number; length: number }[];
            if (stored.length) {
              const manifest = JSON.parse(row.photos) as PhotoManifest[];
              if (!Array.isArray(manifest) || manifest.length !== stored.length || stored.reduce((sum, photo) => sum + photo.bytes, 0) !== Number(row.bytes) || stored.some((photo, index) => photo.position !== index || photo.file !== manifest[index]?.file || photo.width !== manifest[index]?.width || photo.height !== manifest[index]?.height || photo.bytes !== manifest[index]?.bytes || photo.length !== photo.bytes)) throw new Error("Incomplete database contribution");
              continue;
            }
            const migrated = await legacyPhotos(this.directory, row);
            migrated.manifest.forEach((photo, index) => insert.run(row.id, index, photo.file, contentType(photo.file), photo.width, photo.height, photo.bytes, migrated.bytes[index]!));
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally { db.close(); }
    })();
    try { await this.ready; }
    catch { this.ready = undefined; throw new TourContributionError("Photo storage could not be prepared safely. Please try again later.", 503); }
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.database);
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    return db;
  }

  async reserve(source: string): Promise<string> {
    await this.prepare();
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const salt = (db.prepare("SELECT value FROM contribution_settings WHERE id = 'rate_salt'").get() as { value: string }).value;
      const key = createHmac("sha256", salt).update(source.slice(0, 256) || "unknown").digest("hex");
      const now = Date.now();
      db.prepare("DELETE FROM contribution_attempts WHERE created_at < ?").run(now - 48 * 60 * 60 * 1000);
      const recent = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN source = ? THEN 1 ELSE 0 END), 0) AS own FROM contribution_attempts WHERE created_at > ?").get(key, now - 60 * 60 * 1000) as { total: number; own: number };
      const active = db.prepare("SELECT COUNT(*) AS total FROM contribution_attempts WHERE expires_at > ?").get(now) as { total: number };
      if (recent.own >= 5 || recent.total >= 50) throw new TourContributionError("We have received several uploads recently. Please try again in an hour.", 429, 3600);
      if (active.total >= 3) throw new TourContributionError("Other photos are being processed. Please try again in a minute.", 429, 60);
      const used = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM tour_contributions").get() as { total: number; bytes: number };
      if (used.total >= TOUR_UPLOAD_LIMITS.maxContributions || used.bytes >= TOUR_UPLOAD_LIMITS.maxStoredBytes)
        throw new TourContributionError("Photo contributions are temporarily full. Please try again later.", 503);
      const id = randomUUID();
      db.prepare("INSERT INTO contribution_attempts (id, source, created_at, expires_at) VALUES (?, ?, ?, ?)").run(id, key, now, now + 120_000);
      db.exec("COMMIT");
      return id;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (error instanceof TourContributionError) throw error;
      throw new TourContributionError("Photo storage is busy. Please try again shortly.", 503);
    } finally { db.close(); }
  }

  async release(ticket: string): Promise<void> {
    await this.prepare();
    const db = this.open();
    try { db.prepare("UPDATE contribution_attempts SET expires_at = 0 WHERE id = ?").run(ticket); }
    finally { db.close(); }
  }

  async receive(ticket: string, input: TourContributionInput): Promise<TourContributionReceipt> {
    const fields = eventFields(input);
    const photos = await normalizeTourPhotos(input.photos);
    await this.prepare();
    const id = randomUUID();
    const bytes = photos.reduce((sum, photo) => sum + photo.bytes.byteLength, 0);
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const reservation = db.prepare("SELECT expires_at FROM contribution_attempts WHERE id = ?").get(ticket) as { expires_at: number } | undefined;
      if (!reservation || reservation.expires_at <= Date.now()) throw new TourContributionError("The upload session expired. Please submit your photos again.", 409);
      const used = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM tour_contributions").get() as { total: number; bytes: number };
      if (used.total >= TOUR_UPLOAD_LIMITS.maxContributions || used.bytes + bytes > TOUR_UPLOAD_LIMITS.maxStoredBytes)
        throw new TourContributionError("Photo contributions are temporarily full. Please try again later.", 503);
      const manifest = manifestFor(photos);
      db.prepare("INSERT INTO tour_contributions (id, event_name, event_url, location, received_at, status, bytes, photos) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)").run(id, fields.eventName, fields.eventUrl, fields.location, new Date().toISOString(), bytes, JSON.stringify(manifest));
      const insert = db.prepare("INSERT INTO tour_contribution_photos (contribution_id, position, file, content_type, width, height, bytes, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      photos.forEach((photo, index) => insert.run(id, index, manifest[index]!.file, contentType(manifest[index]!.file), photo.width, photo.height, photo.bytes.byteLength, photo.bytes));
      db.prepare("UPDATE contribution_attempts SET expires_at = 0 WHERE id = ?").run(ticket);
      db.exec("COMMIT");
      return receipt(id, fields.eventName, photos.length, this.kind);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (error instanceof TourContributionError) throw error;
      throw new TourContributionError("Your photos could not be saved. Please try again later.", 503);
    } finally { db.close(); }
  }
}

type PgResult = { rows: Record<string, unknown>[] };
export interface TourContributionPgClient {
  query(sql: string, values?: unknown[]): Promise<PgResult>;
  release(): void;
}
export interface TourContributionPgPool {
  connect(): Promise<TourContributionPgClient>;
}

type PostgresPhotoOptions = { kind?: "tigerdata" | "postgres" | "supabase"; maxStoredBytes?: number };

export class PostgresTourContributionStore implements TourContributionStorage {
  readonly kind: "tigerdata" | "postgres" | "supabase";
  readonly maxStoredBytes: number;
  private ready: Promise<void> | undefined;

  constructor(readonly directory: string, private readonly pool: () => Promise<TourContributionPgPool>, options: PostgresPhotoOptions = {}) {
    if (!path.isAbsolute(directory)) throw new TourContributionError("Photo storage is not available right now. Please try again later.", 503);
    this.kind = options.kind ?? "tigerdata";
    this.maxStoredBytes = options.maxStoredBytes ?? (this.kind === "supabase" ? 256 * 1024 * 1024 : TOUR_UPLOAD_LIMITS.maxStoredBytes);
    if (!Number.isSafeInteger(this.maxStoredBytes) || this.maxStoredBytes < 1 || this.maxStoredBytes > (this.kind === "supabase" ? 256 * 1024 * 1024 : TOUR_UPLOAD_LIMITS.maxStoredBytes)) throw new TourContributionError("Photo storage limits are not configured safely. Please try again later.", 503);
  }

  private scoped(client: TourContributionPgClient): TourContributionPgClient {
    if (this.kind === "tigerdata") return client;
    return {
      query: (sql, values) => client.query(sql.replace(/\b(contribution_settings|contribution_attempts|tour_contributions|tour_contribution_photos)\b/g, "smile_photos.$1"), values),
      release: () => client.release(),
    };
  }

  private async transaction<T>(work: (client: TourContributionPgClient) => Promise<T>): Promise<T> {
    const client = await (await this.pool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1984326761)");
      const value = await work(this.scoped(client));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally { client.release(); }
  }

  private async initialize(): Promise<void> {
    this.ready ??= this.transaction(async (client) => {
      if (this.kind !== "tigerdata") await client.query("CREATE SCHEMA IF NOT EXISTS smile_photos; REVOKE ALL ON SCHEMA smile_photos FROM PUBLIC;");
      await client.query(`CREATE TABLE IF NOT EXISTS contribution_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS contribution_attempts (id TEXT PRIMARY KEY, source TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS contribution_attempt_time ON contribution_attempts (created_at);
        CREATE TABLE IF NOT EXISTS tour_contributions (id TEXT PRIMARY KEY, event_name TEXT NOT NULL, event_url TEXT NOT NULL, location TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL, bytes BIGINT NOT NULL, photos JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS tour_contribution_photos (contribution_id TEXT NOT NULL REFERENCES tour_contributions(id), position INTEGER NOT NULL, file TEXT NOT NULL, content_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes BIGINT NOT NULL CHECK(bytes > 0), data BYTEA NOT NULL CHECK(octet_length(data) = bytes), PRIMARY KEY (contribution_id, position));`);
      if (this.kind !== "tigerdata") await client.query(`ALTER TABLE contribution_settings ENABLE ROW LEVEL SECURITY;
        ALTER TABLE contribution_attempts ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tour_contributions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tour_contribution_photos ENABLE ROW LEVEL SECURITY;
        REVOKE ALL ON ALL TABLES IN SCHEMA smile_photos FROM PUBLIC;
        DO $private_photos$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            REVOKE ALL ON SCHEMA smile_photos FROM anon;
            REVOKE ALL ON ALL TABLES IN SCHEMA smile_photos FROM anon;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            REVOKE ALL ON SCHEMA smile_photos FROM authenticated;
            REVOKE ALL ON ALL TABLES IN SCHEMA smile_photos FROM authenticated;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            REVOKE ALL ON SCHEMA smile_photos FROM service_role;
            REVOKE ALL ON ALL TABLES IN SCHEMA smile_photos FROM service_role;
          END IF;
        END $private_photos$;`);
      await client.query("INSERT INTO contribution_settings (id, value) VALUES ('rate_salt', $1) ON CONFLICT (id) DO NOTHING", [randomBytes(32).toString("hex")]);
      await this.migrate(client);
    });
    try { await this.ready; }
    catch { this.ready = undefined; throw new TourContributionError("Photo storage could not be prepared safely. Please try again later.", 503); }
  }

  private async migrate(client: TourContributionPgClient): Promise<void> {
    if (!fs.existsSync(path.join(this.directory, "contributions.db"))) return;
    const local = new TourContributionStore(this.directory);
    await local.prepare();
    const db = new DatabaseSync(local.database);
    try {
      db.exec("BEGIN");
      const contributions = db.prepare("SELECT * FROM tour_contributions").all() as ContributionRow[];
      const used = (await client.query("SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM tour_contributions")).rows[0]!;
      let total = Number(used.total);
      let storedBytes = Number(used.bytes);
      for (const row of contributions) {
        const photos = db.prepare("SELECT * FROM tour_contribution_photos WHERE contribution_id = ? ORDER BY position").all(row.id) as { position: number; file: string; content_type: string; width: number; height: number; bytes: number; data: Uint8Array }[];
        const existing = (await client.query("SELECT * FROM tour_contributions WHERE id = $1", [row.id])).rows[0];
        if (existing) {
          const stored = (await client.query("SELECT * FROM tour_contribution_photos WHERE contribution_id = $1 ORDER BY position", [row.id])).rows;
          const manifest = typeof existing.photos === "string" ? JSON.parse(existing.photos) : existing.photos;
          if (!isDeepStrictEqual(manifest, JSON.parse(row.photos)) || ["event_name", "event_url", "location", "received_at", "status"].some((key) => existing[key] !== row[key as keyof ContributionRow]) || Number(existing.bytes) !== Number(row.bytes) || stored.length !== photos.length || stored.some((photo, index) => Number(photo.position) !== photos[index]!.position || photo.file !== photos[index]!.file || photo.content_type !== photos[index]!.content_type || Number(photo.width) !== photos[index]!.width || Number(photo.height) !== photos[index]!.height || Number(photo.bytes) !== photos[index]!.bytes || !Buffer.from(photo.data as Uint8Array).equals(Buffer.from(photos[index]!.data)))) throw new Error("Conflicting legacy contribution");
          continue;
        }
        total++;
        storedBytes += Number(row.bytes);
        if (total > TOUR_UPLOAD_LIMITS.maxContributions || storedBytes > this.maxStoredBytes) throw new Error("Legacy photos exceed the photo database quota");
        await client.query("INSERT INTO tour_contributions (id, event_name, event_url, location, received_at, status, bytes, photos) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)", [row.id, row.event_name, row.event_url, row.location, row.received_at, row.status, row.bytes, row.photos]);
        for (const photo of photos) await client.query("INSERT INTO tour_contribution_photos (contribution_id, position, file, content_type, width, height, bytes, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [row.id, photo.position, photo.file, photo.content_type, photo.width, photo.height, photo.bytes, Buffer.from(photo.data)]);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally { db.close(); }
  }

  async reserve(source: string): Promise<string> {
    await this.initialize();
    try {
      return await this.transaction(async (client) => {
        const salt = (await client.query("SELECT value FROM contribution_settings WHERE id = 'rate_salt'")).rows[0]?.value;
        if (typeof salt !== "string" || !salt) throw new Error("Missing storage settings");
        const key = createHmac("sha256", salt).update(source.slice(0, 256) || "unknown").digest("hex");
        const now = Date.now();
        await client.query("DELETE FROM contribution_attempts WHERE created_at < $1", [now - 48 * 60 * 60 * 1000]);
        const recent = (await client.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE source = $1) AS own FROM contribution_attempts WHERE created_at > $2", [key, now - 60 * 60 * 1000])).rows[0]!;
        const active = (await client.query("SELECT COUNT(*) AS total FROM contribution_attempts WHERE expires_at > $1", [now])).rows[0]!;
        if (Number(recent.own) >= 5 || Number(recent.total) >= 50) throw new TourContributionError("We have received several uploads recently. Please try again in an hour.", 429, 3600);
        if (Number(active.total) >= 3) throw new TourContributionError("Other photos are being processed. Please try again in a minute.", 429, 60);
        const used = (await client.query("SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM tour_contributions")).rows[0]!;
        if (Number(used.total) >= TOUR_UPLOAD_LIMITS.maxContributions || Number(used.bytes) >= this.maxStoredBytes) throw new TourContributionError("Photo contributions are temporarily full. Please try again later.", 503);
        const id = randomUUID();
        await client.query("INSERT INTO contribution_attempts (id, source, created_at, expires_at) VALUES ($1, $2, $3, $4)", [id, key, now, now + 120_000]);
        return id;
      });
    } catch (error) {
      if (error instanceof TourContributionError) throw error;
      throw new TourContributionError("Photo storage is busy. Please try again shortly.", 503);
    }
  }

  async release(ticket: string): Promise<void> {
    await this.initialize();
    await this.transaction(async (client) => { await client.query("UPDATE contribution_attempts SET expires_at = 0 WHERE id = $1", [ticket]); });
  }

  async receive(ticket: string, input: TourContributionInput): Promise<TourContributionReceipt> {
    const fields = eventFields(input);
    const photos = await normalizeTourPhotos(input.photos);
    await this.initialize();
    try {
      return await this.transaction(async (client) => {
        const reservation = (await client.query("SELECT expires_at FROM contribution_attempts WHERE id = $1 FOR UPDATE", [ticket])).rows[0];
        if (!reservation || Number(reservation.expires_at) <= Date.now()) throw new TourContributionError("The upload session expired. Please submit your photos again.", 409);
        const bytes = photos.reduce((total, photo) => total + photo.bytes.byteLength, 0);
        const used = (await client.query("SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM tour_contributions")).rows[0]!;
        if (Number(used.total) >= TOUR_UPLOAD_LIMITS.maxContributions || Number(used.bytes) + bytes > this.maxStoredBytes) throw new TourContributionError("Photo contributions are temporarily full. Please try again later.", 503);
        const id = randomUUID();
        const manifest = manifestFor(photos);
        await client.query("INSERT INTO tour_contributions (id, event_name, event_url, location, received_at, status, bytes, photos) VALUES ($1, $2, $3, $4, $5, 'received', $6, $7::jsonb)", [id, fields.eventName, fields.eventUrl, fields.location, new Date().toISOString(), bytes, JSON.stringify(manifest)]);
        for (const [index, photo] of photos.entries()) await client.query("INSERT INTO tour_contribution_photos (contribution_id, position, file, content_type, width, height, bytes, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [id, index, manifest[index]!.file, contentType(manifest[index]!.file), photo.width, photo.height, photo.bytes.byteLength, photo.bytes]);
        await client.query("UPDATE contribution_attempts SET expires_at = 0 WHERE id = $1", [ticket]);
        return receipt(id, fields.eventName, photos.length, this.kind);
      });
    } catch (error) {
      if (error instanceof TourContributionError) throw error;
      throw new TourContributionError("Your photos could not be saved. Please try again later.", 503);
    }
  }
}

const postgresStores = new Map<string, PostgresTourContributionStore>();

export function tourContributionPgOptions(url: string, trust: TigerDatabaseTrust = { caPem: process.env.PHOTO_DATABASE_CA_PEM, caFile: process.env.PHOTO_DATABASE_CA_FILE }) {
  try {
    return tigerDatabasePgOptions(url, trust);
  } catch {
    throw new TourContributionError("Photo database connection settings require verified TLS and a valid trusted CA certificate when configured.", 503);
  }
}

export function tourContributionStore(): TourContributionStorage {
  if (process.env.VERCEL) throw new TourContributionError("Photo uploads need the persistent application service. Please try again later.", 503);
  const storage = process.env.TOUR_CONTRIBUTION_STORAGE?.trim();
  if (storage && !["sqlite", "tigerdata", "postgres", "supabase"].includes(storage)) throw new TourContributionError("Photo storage settings are not available right now. Please try again later.", 503);
  const directory = path.join(DATA_DIR, "tour-contributions");
  const photoUrl = process.env.PHOTO_DATABASE_URL?.trim();
  let kind = storage || (photoUrl ? "postgres" : "sqlite");
  if (!storage && photoUrl) {
    try { if (/(?:^|\.)supabase\.(?:co|com)$/.test(new URL(photoUrl).hostname)) kind = "supabase"; } catch {}
  }
  if (kind === "sqlite") return new TourContributionStore(directory);
  const url = kind === "tigerdata" ? process.env.TIGER_DATABASE_URL?.trim() : photoUrl;
  if (!url) throw new TourContributionError("The photo database connection is not configured. Please try again later.", 503);
  const trust = kind === "tigerdata" ? { caPem: process.env.TIGER_DATABASE_CA_PEM, caFile: process.env.TIGER_DATABASE_CA_FILE } : { caPem: process.env.PHOTO_DATABASE_CA_PEM, caFile: process.env.PHOTO_DATABASE_CA_FILE };
  const options = tourContributionPgOptions(url, trust);
  const maxStoredBytes = process.env.PHOTO_DATABASE_MAX_BYTES?.trim() ? Number(process.env.PHOTO_DATABASE_MAX_BYTES) : undefined;
  const key = JSON.stringify([kind, url, trust, maxStoredBytes]);
  let store = postgresStores.get(key);
  if (!store) {
    let pool: Promise<TourContributionPgPool> | undefined;
    store = new PostgresTourContributionStore(directory, () => pool ??= (async () => {
      const { default: pg } = await import("pg");
      return new pg.Pool(options);
    })(), { kind: kind as "tigerdata" | "postgres" | "supabase", maxStoredBytes });
    postgresStores.set(key, store);
  }
  return store;
}
