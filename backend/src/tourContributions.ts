import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { DATA_DIR } from "./store";

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
  message: string;
}

type CleanPhoto = { bytes: Buffer; extension: "jpg" | "png" | "webp"; width: number; height: number };

export function tourContributionOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
  const destination = new URL(request.url);
  const allowed = new Set([destination.origin]);
  try {
    const source = new URL(origin);
    const local = new Set(["localhost", "127.0.0.1", "[::1]"]);
    const host = request.headers.get("host")?.toLowerCase() ?? "";
    const localBind = destination.hostname === "0.0.0.0" && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) && new URL(`${destination.protocol}//${host}`).port === source.port;
    if (local.has(source.hostname) && (local.has(destination.hostname) || localBind) && source.protocol === destination.protocol && source.port === destination.port) allowed.add(source.origin);
  } catch {}
  for (const value of [process.env.SMILE_PUBLIC_ORIGIN, process.env.SMILE_PUBLIC_URL, process.env.SMILE_WEB_URL, process.env.NEXT_PUBLIC_APP_URL, "https://smilefromhereto.work", "https://www.smilefromhereto.work", "https://calhacks-beta.vercel.app"]) {
    if (!value) continue;
    try { allowed.add(new URL(value).origin); } catch {}
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

export class TourContributionStore {
  readonly directory: string;
  readonly database: string;

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
        `);
        db.prepare("INSERT OR IGNORE INTO contribution_settings (id, value) VALUES ('rate_salt', ?)").run(randomBytes(32).toString("hex"));
      } finally { db.close(); }
    } catch {
      throw new TourContributionError("Photo storage is not available right now. Please try again later.", 503);
    }
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.database);
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
    return db;
  }

  reserve(source: string): string {
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

  release(ticket: string): void {
    const db = this.open();
    try { db.prepare("UPDATE contribution_attempts SET expires_at = 0 WHERE id = ?").run(ticket); }
    finally { db.close(); }
  }

  async receive(ticket: string, input: TourContributionInput): Promise<TourContributionReceipt> {
    const fields = eventFields(input);
    const photos = await normalizeTourPhotos(input.photos);
    const id = randomUUID();
    const bytes = photos.reduce((sum, photo) => sum + photo.bytes.byteLength, 0);
    const directory = path.join(this.directory, id);
    const db = this.open();
    let created = false;
    let persisted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      const reservation = db.prepare("SELECT expires_at FROM contribution_attempts WHERE id = ?").get(ticket) as { expires_at: number } | undefined;
      if (!reservation || reservation.expires_at <= Date.now()) throw new TourContributionError("The upload session expired. Please submit your photos again.", 409);
      const used = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(bytes), 0) AS bytes FROM tour_contributions").get() as { total: number; bytes: number };
      if (used.total >= TOUR_UPLOAD_LIMITS.maxContributions || used.bytes + bytes > TOUR_UPLOAD_LIMITS.maxStoredBytes)
        throw new TourContributionError("Photo contributions are temporarily full. Please try again later.", 503);
      const manifest = photos.map((photo) => ({ file: `${randomUUID()}.${photo.extension}`, width: photo.width, height: photo.height, bytes: photo.bytes.byteLength }));
      db.prepare("INSERT INTO tour_contributions (id, event_name, event_url, location, received_at, status, bytes, photos) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").run(id, fields.eventName, fields.eventUrl, fields.location, new Date().toISOString(), bytes, JSON.stringify(manifest));
      db.exec("COMMIT");
      persisted = true;
      fs.mkdirSync(directory, { mode: 0o700 });
      created = true;
      photos.forEach((photo, index) => {
        const file = fs.openSync(path.join(directory, manifest[index]!.file), "wx", 0o600);
        try { fs.writeFileSync(file, photo.bytes); fs.fsyncSync(file); }
        finally { fs.closeSync(file); }
      });
      const folder = fs.openSync(directory, "r");
      try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); }
      const parent = fs.openSync(this.directory, "r");
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE tour_contributions SET status = 'received' WHERE id = ?").run(id);
      db.prepare("UPDATE contribution_attempts SET expires_at = 0 WHERE id = ?").run(ticket);
      db.exec("COMMIT");
      return { receiptId: id, eventName: fields.eventName, photoCount: photos.length, status: "received", message: "Photos received for venue tour review. Uploading does not automatically create or publish a 3D tour." };
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      try {
        if (created) fs.rmSync(directory, { recursive: true, force: true });
        if (persisted) db.prepare("DELETE FROM tour_contributions WHERE id = ?").run(id);
      } catch {}
      if (error instanceof TourContributionError) throw error;
      throw new TourContributionError("Your photos could not be saved. Please try again later.", 503);
    } finally { db.close(); }
  }
}

export function tourContributionStore(): TourContributionStore {
  if (process.env.VERCEL) throw new TourContributionError("Photo uploads need the persistent application service. Please try again later.", 503);
  return new TourContributionStore(path.join(DATA_DIR, "tour-contributions"));
}
