import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rootCertificates } from "node:tls";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TOUR_UPLOAD_LIMITS, PostgresTourContributionStore, TourContributionError, TourContributionStore, normalizeTourPhotos, tourContributionOriginAllowed, tourContributionPgOptions, tourContributionStore, type TourContributionInput, type TourContributionPgClient, type TourContributionPgPool } from "../../backend/src/tourContributions";

const sharp = createRequire(new URL("../../backend/package.json", import.meta.url))("sharp");

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-upload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new TourContributionStore(path.join(directory, "private-photos"));
}

async function image(format = "png"): Promise<Buffer> {
  return sharp({ create: { width: 12, height: 8, channels: 3, background: "#deb887" } }).toFormat(format).toBuffer();
}

async function input(overrides: Partial<TourContributionInput> = {}): Promise<TourContributionInput> {
  return { eventName: "Example Hackathon", eventUrl: "https://events.example.edu/hackathon", location: "University event hall", consent: true, photos: [{ bytes: await image(), contentType: "image/png" }], ...overrides };
}

async function submit(store: TourContributionStore, value: TourContributionInput, source = "192.0.2.1") {
  const ticket = await store.reserve(source);
  try { return await store.receive(ticket, value); }
  finally { await store.release(ticket); }
}

function status(expected: number) {
  return (error: unknown) => error instanceof TourContributionError && error.status === expected;
}

test("stores actual photos privately and persists a safe receipt across restarts", async (t) => {
  const store = fixture(t);
  const value = await input();
  const receipt = await submit(store, value);
  assert.equal(receipt.status, "received");
  assert.equal(receipt.storage, "sqlite");
  assert.equal(receipt.photoCount, 1);
  assert.equal(receipt.eventName, value.eventName);
  assert.match(receipt.message, /does not automatically create or publish/);
  assert.match(receipt.receiptId, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(receipt).includes(store.directory), false);
  const restarted = new TourContributionStore(store.directory);
  await restarted.prepare();
  const db = new DatabaseSync(restarted.database);
  const row = db.prepare("SELECT * FROM tour_contributions WHERE id = ?").get(receipt.receiptId) as { photos: string; status: string; location: string };
  const manifest = JSON.parse(row.photos) as { file: string; width: number; height: number }[];
  assert.equal(row.status, "received");
  assert.equal(row.location, value.location);
  assert.equal(manifest[0]!.width, 12);
  assert.equal(manifest[0]!.height, 8);
  const photo = db.prepare("SELECT data, content_type, bytes FROM tour_contribution_photos WHERE contribution_id = ?").get(receipt.receiptId) as { data: Uint8Array; content_type: string; bytes: number };
  assert.equal((await sharp(Buffer.from(photo.data)).metadata()).format, "png");
  assert.equal(photo.content_type, "image/png");
  assert.equal(photo.data.byteLength, photo.bytes);
  assert.equal(fs.existsSync(path.join(store.directory, receipt.receiptId)), false);
  assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.database).mode & 0o777, 0o600);
  db.close();
});

test("decodes JPEG, PNG and WebP rather than accepting a filename or MIME claim", async () => {
  for (const format of ["jpeg", "png", "webp"]) {
    const result = await normalizeTourPhotos([{ bytes: await image(format), contentType: `image/${format}` }]);
    assert.equal(result.length, 1);
    assert.equal((await sharp(result[0]!.bytes).metadata()).format, format);
  }
  await assert.rejects(normalizeTourPhotos([{ bytes: Buffer.from("<svg><script>alert(1)</script></svg>"), contentType: "image/png" }]), status(415));
  await assert.rejects(normalizeTourPhotos([{ bytes: Buffer.from([0xff, 0xd8, 0xff, 0]), contentType: "image/jpeg" }]), status(415));
  await assert.rejects(normalizeTourPhotos([{ bytes: await image(), contentType: "text/html" }]), status(415));
});

test("removes EXIF, GPS, XMP and other embedded metadata after decoding", async () => {
  const original = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#deb887" } }).jpeg().withExif({ IFD0: { Artist: "Private contributor", ImageDescription: "Private location" }, IFD2: { GPSLatitudeRef: "N", GPSLatitude: "41/1 53/1 0/1" } }).toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const clean = (await normalizeTourPhotos([{ bytes: original, contentType: "image/jpeg" }]))[0]!;
  const metadata = await sharp(clean.bytes).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.xmp, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(clean.bytes.includes(Buffer.from("Private contributor")), false);
  assert.equal(clean.bytes.includes(Buffer.from("Private location")), false);
});

test("rejects missing permission, blank names and private or executable event links", async (t) => {
  const store = fixture(t);
  for (const change of [{ consent: false }, { eventName: " " }, { eventName: "x".repeat(161) }, { eventUrl: "javascript:alert(1)" }, { eventUrl: "http://127.0.0.1/internal" }, { eventUrl: "http://[::1]/" }, { eventUrl: "http://localhost/" }, { eventUrl: "https://name:password@example.edu/" }, { location: "hall\u0000file" }]) {
    await assert.rejects(submit(store, await input(change), String(Math.random())), status(400));
  }
  const db = new DatabaseSync(store.database);
  assert.equal((db.prepare("SELECT COUNT(*) AS total FROM tour_contributions").get() as { total: number }).total, 0);
  db.close();
});

test("requires one to six nonempty photos and at most 3 MB combined", async () => {
  await assert.rejects(normalizeTourPhotos([]), status(400));
  await assert.rejects(normalizeTourPhotos(Array.from({ length: 7 }, () => ({ bytes: Buffer.from("x") }))), status(400));
  await assert.rejects(normalizeTourPhotos([{ bytes: new Uint8Array(0) }]), status(400));
  await assert.rejects(normalizeTourPhotos([{ bytes: new Uint8Array(TOUR_UPLOAD_LIMITS.maxPhotoBytes + 1) }]), status(413));
  await assert.rejects(normalizeTourPhotos([{ bytes: new Uint8Array(2 * 1024 * 1024) }, { bytes: new Uint8Array(2 * 1024 * 1024) }]), status(413));
});

test("rejects compressed images above the decoded pixel safety limit", async () => {
  const oversized = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "#fff" } }).png().toBuffer();
  assert.ok(oversized.byteLength < TOUR_UPLOAD_LIMITS.maxPhotoBytes);
  await assert.rejects(normalizeTourPhotos([{ bytes: oversized, contentType: "image/png" }]), status(415));
});

test("uses generated database identifiers, not contributor-supplied file paths", async (t) => {
  const store = fixture(t);
  const receipt = await submit(store, await input({ eventName: "../../untrusted-folder" }));
  assert.equal(fs.existsSync(path.join(store.directory, receipt.receiptId)), false);
  assert.equal(fs.existsSync(path.join(path.dirname(store.directory), "untrusted-folder")), false);
  const db = new DatabaseSync(store.database);
  const files = db.prepare("SELECT file FROM tour_contribution_photos WHERE contribution_id = ?").all(receipt.receiptId) as { file: string }[];
  assert.equal(files.length, 1);
  assert.match(files[0]!.file, /^[a-f0-9-]{36}\.png$/);
  db.close();
});

test("rate limits survive a restart and do not retain the raw source address", async (t) => {
  const store = fixture(t);
  const source = "192.0.2.123";
  for (let count = 0; count < 5; count++) await store.release(await store.reserve(source));
  const restarted = new TourContributionStore(store.directory);
  await assert.rejects(restarted.reserve(source), status(429));
  const db = new DatabaseSync(store.database);
  const row = db.prepare("SELECT source FROM contribution_attempts LIMIT 1").get() as { source: string };
  assert.match(row.source, /^[a-f0-9]{64}$/);
  assert.notEqual(row.source, source);
  db.close();
});

test("limits concurrent uploads and requires a live, unused upload reservation", async (t) => {
  const store = fixture(t);
  const reservations = [await store.reserve("one"), await store.reserve("two"), await store.reserve("three")];
  await assert.rejects(store.reserve("four"), status(429));
  await store.release(reservations[0]!);
  const replacement = await store.reserve("four");
  await assert.rejects(store.receive(reservations[0]!, await input()), status(409));
  await store.receive(replacement, await input());
  await assert.rejects(store.receive(replacement, await input()), status(409));
  for (const ticket of reservations) await store.release(ticket);
});

test("fails closed at the durable disk quota instead of silently accepting files", async (t) => {
  const store = fixture(t);
  const ticket = await store.reserve("one");
  const db = new DatabaseSync(store.database);
  db.prepare("INSERT INTO tour_contributions (id, event_name, event_url, location, received_at, status, bytes, photos) VALUES ('full', 'Event', 'https://example.edu', '', '', 'pending', ?, '[]')").run(TOUR_UPLOAD_LIMITS.maxStoredBytes);
  db.close();
  await assert.rejects(store.receive(ticket, await input()), status(503));
  await store.release(ticket);
  await assert.rejects(store.reserve("two"), status(503));
  assert.deepEqual(fs.readdirSync(store.directory).filter((file) => /^[a-f0-9-]{36}$/.test(file)), []);
});

test("commits image bytes, metadata and consumed reservation together or rolls everything back", async (t) => {
  const store = fixture(t);
  const ticket = await store.reserve("one");
  const db = new DatabaseSync(store.database);
  db.exec("CREATE TRIGGER reject_second_photo BEFORE INSERT ON tour_contribution_photos WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END");
  await assert.rejects(store.receive(ticket, await input({ photos: [{ bytes: await image() }, { bytes: await image() }] })), status(503));
  assert.equal((db.prepare("SELECT COUNT(*) AS total FROM tour_contributions").get() as { total: number }).total, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS total FROM tour_contribution_photos").get() as { total: number }).total, 0);
  assert.ok((db.prepare("SELECT expires_at FROM contribution_attempts WHERE id = ?").get(ticket) as { expires_at: number }).expires_at > Date.now());
  db.exec("DROP TRIGGER reject_second_photo");
  const receipt = await store.receive(ticket, await input());
  assert.equal(receipt.status, "received");
  db.close();
});

async function legacyContribution(store: TourContributionStore, id: string, missing = false) {
  const bytes = await image();
  const file = "11111111-1111-4111-8111-111111111111.png";
  const directory = path.join(store.directory, id);
  fs.mkdirSync(directory, { mode: 0o700 });
  if (!missing) fs.writeFileSync(path.join(directory, file), bytes, { mode: 0o600 });
  const db = new DatabaseSync(store.database);
  db.prepare("INSERT INTO tour_contributions (id, event_name, event_url, location, received_at, status, bytes, photos) VALUES (?, 'Legacy event', 'https://events.example.edu/', 'Venue', ?, 'received', ?, ?)").run(id, new Date().toISOString(), bytes.byteLength, JSON.stringify([{ file, width: 12, height: 8, bytes: bytes.byteLength }]));
  db.close();
  return { bytes, file: path.join(directory, file) };
}

test("imports legacy disk photos into database BLOBs without removing the original files", async (t) => {
  const store = fixture(t);
  const id = "22222222-2222-4222-8222-222222222222";
  const original = await legacyContribution(store, id);
  await new TourContributionStore(store.directory).prepare();
  await new TourContributionStore(store.directory).prepare();
  const db = new DatabaseSync(store.database);
  const saved = db.prepare("SELECT data FROM tour_contribution_photos WHERE contribution_id = ?").get(id) as { data: Uint8Array };
  assert.deepEqual(Buffer.from(saved.data), original.bytes);
  assert.deepEqual(fs.readFileSync(original.file), original.bytes);
  assert.equal((db.prepare("SELECT COUNT(*) AS total FROM tour_contribution_photos").get() as { total: number }).total, 1);
  db.close();
});

test("does not partially migrate or accept new uploads when a legacy image is missing", async (t) => {
  const store = fixture(t);
  const original = await legacyContribution(store, "22222222-2222-4222-8222-222222222222");
  await legacyContribution(store, "33333333-3333-4333-8333-333333333333", true);
  await assert.rejects(new TourContributionStore(store.directory).prepare(), status(503));
  const db = new DatabaseSync(store.database);
  assert.equal((db.prepare("SELECT COUNT(*) AS total FROM tour_contribution_photos").get() as { total: number }).total, 0);
  assert.deepEqual(fs.readFileSync(original.file), original.bytes);
  db.close();
});

test("rejects same-length corrupted legacy photos even when their image signature is intact", async (t) => {
  const store = fixture(t);
  const original = await legacyContribution(store, "22222222-2222-4222-8222-222222222222");
  const corrupted = Buffer.from(original.bytes);
  const dataOffset = corrupted.indexOf(Buffer.from("IDAT"));
  assert.ok(dataOffset > 0);
  corrupted[dataOffset + 6] = corrupted[dataOffset + 6]! ^ 0xff;
  fs.writeFileSync(original.file, corrupted);
  await assert.rejects(new TourContributionStore(store.directory).prepare(), status(503));
  const db = new DatabaseSync(store.database);
  assert.equal((db.prepare("SELECT COUNT(*) AS total FROM tour_contribution_photos").get() as { total: number }).total, 0);
  assert.deepEqual(fs.readFileSync(original.file), corrupted);
  db.close();
});

test("refuses a partial existing database image set instead of ignoring missing photos", async (t) => {
  const store = fixture(t);
  const receipt = await submit(store, await input({ photos: [{ bytes: await image() }, { bytes: await image() }] }));
  const db = new DatabaseSync(store.database);
  db.prepare("DELETE FROM tour_contribution_photos WHERE contribution_id = ? AND position = 1").run(receipt.receiptId);
  db.close();
  await assert.rejects(new TourContributionStore(store.directory).prepare(), status(503));
});

function fakePostgres() {
  let contributions = new Map<string, Record<string, unknown>>();
  let photos = new Map<string, Record<string, unknown>>();
  let attempts = new Map<string, Record<string, unknown>>();
  let snapshot: { contributions: typeof contributions; photos: typeof photos; attempts: typeof attempts } | undefined;
  const calls: { sql: string; values: unknown[] }[] = [];
  let failPhotoAt = -1;
  let unavailable = false;
  let released = 0;
  const client: TourContributionPgClient = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      sql = sql.replace(/smile_photos\./g, "");
      let rows: Record<string, unknown>[] = [];
      if (sql === "BEGIN") snapshot = { contributions: new Map(contributions), photos: new Map(photos), attempts: new Map([...attempts].map(([key, row]) => [key, { ...row }])) };
      else if (sql === "ROLLBACK" && snapshot) ({ contributions, photos, attempts } = snapshot);
      else if (sql === "COMMIT" || sql.startsWith("SELECT pg_advisory") || sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE SCHEMA") || sql.startsWith("ALTER TABLE") || sql.startsWith("INSERT INTO contribution_settings")) {}
      else if (sql.startsWith("SELECT value FROM contribution_settings")) rows = [{ value: "a".repeat(64) }];
      else if (sql.startsWith("DELETE FROM contribution_attempts")) { for (const [key, row] of attempts) if (Number(row.created_at) < Number(values[0])) attempts.delete(key); }
      else if (sql.includes("COUNT(*) FILTER")) { const recent = [...attempts.values()].filter((row) => Number(row.created_at) > Number(values[1])); rows = [{ total: String(recent.length), own: String(recent.filter((row) => row.source === values[0]).length) }]; }
      else if (sql.startsWith("SELECT COUNT(*) AS total FROM contribution_attempts")) rows = [{ total: String([...attempts.values()].filter((row) => Number(row.expires_at) > Number(values[0])).length) }];
      else if (sql.startsWith("SELECT COUNT(*) AS total, COALESCE(SUM(bytes)")) rows = [{ total: String(contributions.size), bytes: String([...contributions.values()].reduce((sum, row) => sum + Number(row.bytes), 0)) }];
      else if (sql.startsWith("INSERT INTO contribution_attempts")) attempts.set(String(values[0]), { id: values[0], source: values[1], created_at: values[2], expires_at: values[3] });
      else if (sql.startsWith("SELECT expires_at FROM contribution_attempts")) { const row = attempts.get(String(values[0])); if (row) rows = [row]; }
      else if (sql.startsWith("UPDATE contribution_attempts")) { const row = attempts.get(String(values[0])); if (row) row.expires_at = 0; }
      else if (sql.startsWith("INSERT INTO tour_contributions")) contributions.set(String(values[0]), { id: values[0], event_name: values[1], event_url: values[2], location: values[3], received_at: values[4], status: values.length === 8 ? values[5] : "received", bytes: values.at(-2), photos: JSON.parse(String(values.at(-1))) });
      else if (sql.startsWith("INSERT INTO tour_contribution_photos")) { if (values[1] === failPhotoAt) throw new Error("private database error"); photos.set(`${values[0]}:${values[1]}`, { contribution_id: values[0], position: values[1], file: values[2], content_type: values[3], width: values[4], height: values[5], bytes: values[6], data: Buffer.from(values[7] as Uint8Array) }); }
      else if (sql.startsWith("SELECT * FROM tour_contributions")) { const row = contributions.get(String(values[0])); if (row) rows = [row]; }
      else if (sql.startsWith("SELECT * FROM tour_contribution_photos")) rows = [...photos.values()].filter((row) => row.contribution_id === values[0]).sort((a, b) => Number(a.position) - Number(b.position));
      else throw new Error(`Unexpected query: ${sql}`);
      return { rows };
    },
    release() { released++; },
  };
  const pool: TourContributionPgPool = { async connect() { if (unavailable) throw new Error("postgresql://private:password@database"); return client; } };
  return { pool, calls, contributions: () => contributions, photos: () => photos, attempts: () => attempts, released: () => released, failPhoto: (position: number) => { failPhotoAt = position; }, failConnection: () => { unavailable = true; } };
}

test("stores PostgreSQL BYTEA images and their receipt in one locked transaction", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-pg-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(directory, async () => database.pool);
  const ticket = await store.reserve("192.0.2.99");
  const receipt = await store.receive(ticket, await input());
  assert.equal(receipt.storage, "tigerdata");
  assert.equal(database.contributions().size, 1);
  assert.equal(database.photos().size, 1);
  const saved = [...database.photos().values()][0]!;
  assert.equal((await sharp(saved.data).metadata()).format, "png");
  assert.equal(database.attempts().get(ticket)?.expires_at, 0);
  assert.notEqual(database.attempts().get(ticket)?.source, "192.0.2.99");
  assert.ok(database.calls.some((call) => call.sql.includes("data BYTEA NOT NULL CHECK(octet_length(data) = bytes)")));
  assert.ok(database.calls.some((call) => call.sql.includes("pg_advisory_xact_lock")));
  assert.equal(database.calls.at(-1)?.sql, "COMMIT");
  assert.ok(database.released() >= 3);
  assert.deepEqual(fs.readdirSync(directory), []);
  await assert.rejects(store.receive(ticket, await input()), status(409));
});

test("rolls PostgreSQL image failures back and never silently switches to disk storage", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-pg-fail-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(directory, async () => database.pool);
  const ticket = await store.reserve("one");
  database.failPhoto(1);
  await assert.rejects(store.receive(ticket, await input({ photos: [{ bytes: await image() }, { bytes: await image() }] })), status(503));
  assert.equal(database.contributions().size, 0);
  assert.equal(database.photos().size, 0);
  assert.ok(Number(database.attempts().get(ticket)?.expires_at) > Date.now());
  assert.equal(database.calls.at(-1)?.sql, "ROLLBACK");
  database.failConnection();
  await assert.rejects(store.reserve("two"), (error: unknown) => status(503)(error) && !(error as Error).message.includes("password"));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("stores Supabase bytes in a private schema with no public or signed-in Data API access", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-supabase-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(directory, async () => database.pool, { kind: "supabase" });
  const ticket = await store.reserve("one");
  const saved = await store.receive(ticket, await input());
  assert.equal(saved.storage, "supabase");
  assert.equal(store.maxStoredBytes, 256 * 1024 * 1024);
  assert.equal(database.photos().size, 1);
  assert.ok(database.calls.some(({ sql }) => sql.includes("CREATE SCHEMA IF NOT EXISTS smile_photos; REVOKE ALL ON SCHEMA smile_photos FROM PUBLIC")));
  for (const table of ["contribution_settings", "contribution_attempts", "tour_contributions", "tour_contribution_photos"]) {
    assert.ok(database.calls.some(({ sql }) => sql.includes(`ALTER TABLE smile_photos.${table} ENABLE ROW LEVEL SECURITY`)));
    assert.ok(database.calls.some(({ sql }) => sql.includes(`CREATE TABLE IF NOT EXISTS smile_photos.${table}`)));
  }
  assert.ok(database.calls.some(({ sql }) => sql.includes("REVOKE ALL ON SCHEMA smile_photos FROM anon") && sql.includes("REVOKE ALL ON ALL TABLES IN SCHEMA smile_photos FROM authenticated") && sql.includes("REVOKE ALL ON ALL TABLES IN SCHEMA smile_photos FROM service_role")));
  assert.equal(database.calls.some(({ sql }) => /(?:FROM|INTO|UPDATE|REFERENCES) (?:contribution_settings|contribution_attempts|tour_contributions|tour_contribution_photos)\b/.test(sql)), false);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("enforces a photo-specific PostgreSQL quota before reserving or committing uploads", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-pg-quota-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(directory, async () => database.pool, { kind: "supabase", maxStoredBytes: 1 });
  const ticket = await store.reserve("one");
  await assert.rejects(store.receive(ticket, await input()), status(503));
  assert.equal(database.photos().size, 0);
  assert.equal(database.contributions().size, 0);
  database.contributions().set("full", { bytes: 1 });
  await assert.rejects(store.reserve("two"), status(503));
  for (const maxStoredBytes of [0, -1, NaN, 1.5, 256 * 1024 * 1024 + 1]) assert.throws(() => new PostgresTourContributionStore(directory, async () => database.pool, { kind: "supabase", maxStoredBytes }), status(503));
});

test("copies existing photos into the private Supabase schema and preserves SQLite receipts and bytes", async (t) => {
  const local = fixture(t);
  const saved = await submit(local, await input());
  const db = new DatabaseSync(local.database);
  const original = db.prepare("SELECT data FROM tour_contribution_photos WHERE contribution_id = ?").get(saved.receiptId) as { data: Uint8Array };
  db.close();
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(local.directory, async () => database.pool, { kind: "supabase" });
  await store.release(await store.reserve("one"));
  assert.equal(database.contributions().get(saved.receiptId)?.event_name, saved.eventName);
  assert.deepEqual(database.photos().get(`${saved.receiptId}:0`)?.data, Buffer.from(original.data));
  assert.equal(fs.existsSync(local.database), true);
  const restarted = new PostgresTourContributionStore(local.directory, async () => database.pool, { kind: "supabase" });
  await restarted.release(await restarted.reserve("two"));
  assert.equal(database.contributions().size, 1);
  assert.equal(database.photos().size, 1);
});

test("rolls back an oversized migration without deleting the SQLite source", async (t) => {
  const local = fixture(t);
  const saved = await submit(local, await input());
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(local.directory, async () => database.pool, { kind: "supabase", maxStoredBytes: 1 });
  await assert.rejects(store.reserve("one"), status(503));
  assert.equal(database.contributions().size, 0);
  assert.equal(database.photos().size, 0);
  const db = new DatabaseSync(local.database);
  assert.ok(db.prepare("SELECT data FROM tour_contribution_photos WHERE contribution_id = ?").get(saved.receiptId));
  db.close();
});

test("copies existing SQLite and legacy photos into PostgreSQL without deleting either backup", async (t) => {
  const local = fixture(t);
  const id = "22222222-2222-4222-8222-222222222222";
  const original = await legacyContribution(local, id);
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(local.directory, async () => database.pool);
  const ticket = await store.reserve("one");
  await store.release(ticket);
  assert.deepEqual(database.photos().get(`${id}:0`)?.data, original.bytes);
  assert.deepEqual(fs.readFileSync(original.file), original.bytes);
  assert.equal(fs.existsSync(local.database), true);
  const restarted = new PostgresTourContributionStore(local.directory, async () => database.pool);
  const next = await restarted.reserve("two");
  await restarted.release(next);
  assert.equal(database.contributions().size, 1);
  assert.equal(database.photos().size, 1);
});

test("migrates one consistent SQLite snapshot while a separate writer updates a later receipt", async (t) => {
  const local = fixture(t);
  const firstId = "22222222-2222-4222-8222-222222222222";
  const secondId = "33333333-3333-4333-8333-333333333333";
  await legacyContribution(local, firstId);
  const original = await legacyContribution(local, secondId);
  const replacement = (await normalizeTourPhotos([{ bytes: await sharp({ create: { width: 12, height: 8, channels: 3, background: "#123456" } }).png().toBuffer() }]))[0]!.bytes;
  const database = fakePostgres();
  let updated = false;
  const pool: TourContributionPgPool = {
    async connect() {
      const client = await database.pool.connect();
      return {
        async query(sql, values = []) {
          if (!updated && sql.startsWith("SELECT * FROM tour_contributions") && values[0] === firstId) {
            const db = new DatabaseSync(local.database);
            try {
              db.exec("BEGIN IMMEDIATE");
              const row = db.prepare("SELECT photos FROM tour_contributions WHERE id = ?").get(secondId) as { photos: string };
              const manifest = JSON.parse(row.photos);
              manifest[0].bytes = replacement.byteLength;
              db.prepare("UPDATE tour_contribution_photos SET bytes = ?, data = ? WHERE contribution_id = ?").run(replacement.byteLength, replacement, secondId);
              db.prepare("UPDATE tour_contributions SET event_name = 'Updated event', bytes = ?, photos = ? WHERE id = ?").run(replacement.byteLength, JSON.stringify(manifest), secondId);
              db.exec("COMMIT");
              updated = true;
            } finally { db.close(); }
          }
          return client.query(sql, values);
        },
        release() { client.release(); },
      };
    },
  };
  const store = new PostgresTourContributionStore(local.directory, async () => pool);
  await store.release(await store.reserve("one"));
  assert.equal(updated, true);
  assert.equal(database.contributions().get(secondId)?.event_name, "Legacy event");
  assert.deepEqual(database.photos().get(`${secondId}:0`)?.data, original.bytes);
  const db = new DatabaseSync(local.database);
  const current = db.prepare("SELECT event_name, data FROM tour_contributions JOIN tour_contribution_photos ON id = contribution_id WHERE id = ?").get(secondId) as { event_name: string; data: Uint8Array };
  db.close();
  assert.equal(current.event_name, "Updated event");
  assert.deepEqual(Buffer.from(current.data), replacement);
});

test("accepts equivalent migrated manifests regardless of object key order or JSON whitespace", async (t) => {
  const local = fixture(t);
  const id = "22222222-2222-4222-8222-222222222222";
  await legacyContribution(local, id);
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(local.directory, async () => database.pool);
  await store.release(await store.reserve("one"));
  const row = database.contributions().get(id)!;
  const photo = (row.photos as Record<string, unknown>[])[0]!;
  row.photos = JSON.stringify([{ bytes: photo.bytes, height: photo.height, width: photo.width, file: photo.file }], null, 2);
  const restarted = new PostgresTourContributionStore(local.directory, async () => database.pool);
  await restarted.release(await restarted.reserve("two"));
  assert.equal(database.contributions().size, 1);
  assert.equal(database.photos().size, 1);
});

test("rejects a conflicting migrated manifest even when all stored image bytes match", async (t) => {
  const local = fixture(t);
  const id = "22222222-2222-4222-8222-222222222222";
  const original = await legacyContribution(local, id);
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(local.directory, async () => database.pool);
  await store.release(await store.reserve("one"));
  const row = database.contributions().get(id)!;
  const photo = (row.photos as Record<string, unknown>[])[0]!;
  row.photos = [{ ...photo, width: Number(photo.width) + 1 }];
  const restarted = new PostgresTourContributionStore(local.directory, async () => database.pool);
  await assert.rejects(restarted.reserve("two"), status(503));
  assert.equal(database.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(database.contributions().size, 1);
  assert.deepEqual(database.photos().get(`${id}:0`)?.data, original.bytes);
  assert.deepEqual(fs.readFileSync(original.file), original.bytes);
});

test("keeps PostgreSQL empty if any legacy contribution is incomplete", async (t) => {
  const local = fixture(t);
  const original = await legacyContribution(local, "22222222-2222-4222-8222-222222222222");
  await legacyContribution(local, "33333333-3333-4333-8333-333333333333", true);
  const database = fakePostgres();
  const store = new PostgresTourContributionStore(local.directory, async () => database.pool);
  await assert.rejects(store.reserve("one"), status(503));
  assert.equal(database.photos().size, 0);
  assert.equal(database.contributions().size, 0);
  assert.deepEqual(fs.readFileSync(original.file), original.bytes);
});

test("selects an explicit database without silently falling back and rejects invalid settings", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-provider-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backend = fileURLToPath(new URL("../../backend/", import.meta.url));
  const source = new URL("../../backend/src/tourContributions.ts", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { tourContributionStore, TourContributionError } from ${JSON.stringify(source)};
    const unavailable = (error) => error instanceof TourContributionError && error.status === 503;
    process.env.TIGER_DATABASE_URL = "postgresql://user:unused@database.example/test?sslmode=require";
    process.env.PHOTO_DATABASE_URL = "";
    process.env.TOUR_CONTRIBUTION_STORAGE = "sqlite";
    assert.equal(tourContributionStore().kind, "sqlite");
    process.env.TOUR_CONTRIBUTION_STORAGE = "tigerdata";
    assert.equal(tourContributionStore().kind, "tigerdata");
    process.env.TOUR_CONTRIBUTION_STORAGE = "";
    assert.equal(tourContributionStore().kind, "sqlite");
    process.env.PHOTO_DATABASE_URL = "postgresql://photo-user:unused@photos.example/test?sslmode=verify-full";
    assert.equal(tourContributionStore().kind, "postgres");
    process.env.PHOTO_DATABASE_URL = "postgresql://photo-user:unused@aws-0-region.pooler.supabase.com/postgres?sslmode=verify-full";
    assert.equal(tourContributionStore().kind, "supabase");
    process.env.TOUR_CONTRIBUTION_STORAGE = "supabase";
    assert.equal(tourContributionStore().kind, "supabase");
    process.env.TIGER_DATABASE_URL = "";
    assert.equal(tourContributionStore().kind, "supabase");
    process.env.PHOTO_DATABASE_URL = "";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.TOUR_CONTRIBUTION_STORAGE = "postgres";
    process.env.TIGER_DATABASE_URL = "postgresql://user:unused@database.example/test?sslmode=require";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.TIGER_DATABASE_URL = "";
    process.env.TOUR_CONTRIBUTION_STORAGE = "tigerdata";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.PHOTO_DATABASE_URL = "https://private-user:private-password@photos.example/test";
    process.env.TOUR_CONTRIBUTION_STORAGE = "supabase";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.PHOTO_DATABASE_URL = "postgresql://photo-user:unused@photos.example/test?sslmode=verify-full";
    process.env.TIGER_DATABASE_CA_PEM = "invalid TigerData certificate must not affect photos";
    assert.equal(tourContributionStore().kind, "supabase");
    process.env.PHOTO_DATABASE_CA_PEM = "invalid photo certificate";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.PHOTO_DATABASE_CA_PEM = "";
    process.env.PHOTO_DATABASE_MAX_BYTES = "0";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.PHOTO_DATABASE_MAX_BYTES = "268435457";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.PHOTO_DATABASE_MAX_BYTES = "";
    process.env.TOUR_CONTRIBUTION_STORAGE = "unknown";
    assert.throws(() => tourContributionStore(), unavailable);
    process.env.VERCEL = "1";
    for (const provider of ["sqlite", "tigerdata", "postgres", "supabase", ""]) {
      process.env.TOUR_CONTRIBUTION_STORAGE = provider;
      assert.throws(() => tourContributionStore(), unavailable);
    }
  `;
  execFileSync(process.execPath, ["--import", path.join(backend, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", script], { cwd: backend, env: { ...process.env, VERCEL: "", PHOTO_DATABASE_CA_PEM: "", PHOTO_DATABASE_CA_FILE: "", PHOTO_DATABASE_MAX_BYTES: "", TIGER_DATABASE_CA_PEM: "", TIGER_DATABASE_CA_FILE: "", SMILE_DATA_DIR: directory }, timeout: 30_000, stdio: "pipe" });
});

test("keeps certificate and hostname verification for every supported PostgreSQL TLS mode", () => {
  const { Client } = createRequire(new URL("../../backend/package.json", import.meta.url))("pg");
  for (const mode of [undefined, "prefer", "require", "verify-ca", "verify-full"]) {
    const options = tourContributionPgOptions(`postgresql://user:unused@database.example/test${mode ? `?sslmode=${mode}` : ""}`);
    assert.equal(new URL(options.connectionString).searchParams.has("sslmode"), false);
    assert.equal(options.ssl.rejectUnauthorized, true);
    const actual = new Client(options).connectionParameters.ssl;
    assert.ok(actual);
    assert.notEqual(actual.rejectUnauthorized, false);
    assert.equal(actual.checkServerIdentity, undefined);
  }
  for (const mode of ["disable", "no-verify", "allow", ""]) assert.throws(() => tourContributionPgOptions(`postgresql://user:unused@database.example/test?sslmode=${mode}`), status(503));
  assert.throws(() => tourContributionPgOptions("https://database.example/test?sslmode=require"), status(503));
});

test("passes an explicitly trusted inline CA to PostgreSQL without losing hostname verification", () => {
  const { Client } = createRequire(new URL("../../backend/package.json", import.meta.url))("pg");
  for (const mode of [undefined, "prefer", "require", "verify-ca", "verify-full"]) {
    const options = tourContributionPgOptions(`postgresql://user:unused@database.example/test?uselibpqcompat=true${mode ? `&sslmode=${mode}` : ""}`, { caPem: rootCertificates[0]!.replace(/\n/g, "\\n") });
    const actual = new Client(options).connectionParameters.ssl;
    assert.equal(actual.ca, rootCertificates[0]!.trim());
    assert.equal(actual.rejectUnauthorized, true);
    assert.equal(actual.checkServerIdentity, undefined);
    assert.equal(new URL(options.connectionString).searchParams.has("uselibpqcompat"), false);
  }
});

test("prefers the connection root certificate over an inline CA and the optional CA file", (t) => {
  const { Client } = createRequire(new URL("../../backend/package.json", import.meta.url))("pg");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-ca-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "provider-ca.pem");
  fs.writeFileSync(file, rootCertificates[1]!);
  const url = new URL("postgresql://user:unused@database.example/test?sslmode=verify-full");
  url.searchParams.set("sslrootcert", file);
  const preferred = tourContributionPgOptions(url.toString(), { caPem: rootCertificates[0]!, caFile: "/missing/ignored-ca.pem" });
  assert.equal(new Client(preferred).connectionParameters.ssl.ca, rootCertificates[1]!.trim());
  assert.equal(new URL(preferred.connectionString).searchParams.has("sslrootcert"), false);
  const inline = tourContributionPgOptions("postgresql://user:unused@database.example/test", { caPem: rootCertificates[0]!, caFile: file });
  assert.equal(inline.ssl.ca, rootCertificates[0]!.trim());
  const fromFile = tourContributionPgOptions("postgresql://user:unused@database.example/test", { caFile: file });
  assert.equal(new Client(fromFile).connectionParameters.ssl.ca, rootCertificates[1]!.trim());
});

test("rejects malformed or unreadable custom CA configuration without leaking connection details", () => {
  for (const trust of [{ caPem: "not a certificate" }, { caPem: "-----BEGIN CERTIFICATE-----broken-----END CERTIFICATE-----" }, { caFile: "/missing/private-ca.pem" }]) assert.throws(() => tourContributionPgOptions("postgresql://private-user:private-password@database.example/test?sslmode=require", trust), (error: unknown) => status(503)(error) && !/private-user|private-password|private-ca/.test((error as Error).message));
  assert.throws(() => tourContributionPgOptions("postgresql://user:unused@database.example/test?ssl=no-verify"), status(503));
  assert.throws(() => tourContributionPgOptions("postgresql://user:unused@database.example/test?ssl=false"), status(503));
});

test("allows the real production origin through the backend proxy and rejects foreign or missing origins", () => {
  const backend = "https://calhacks-production-5fe6.up.railway.app/api/tours/contributions";
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://smilefromhereto.work", "sec-fetch-site": "same-origin" } })), true);
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://www.smilefromhereto.work" } })), true);
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://calhacks-beta.vercel.app" } })), false);
  assert.equal(tourContributionOriginAllowed(new Request("http://127.0.0.1:3000/api/tours/contributions", { headers: { origin: "http://127.0.0.1:3000" } })), true);
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://evil.example", "x-forwarded-host": "evil.example" } })), false);
  assert.equal(tourContributionOriginAllowed(new Request(backend)), false);
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://smilefromhereto.work", "sec-fetch-site": "cross-site" } })), false);
});

test("allows equivalent loopback origins in a production local preview without opening public or different-port origins", () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const local = "http://localhost:3000/api/tours/contributions";
    assert.equal(tourContributionOriginAllowed(new Request(local, { headers: { origin: "http://127.0.0.1:3000" } })), true);
    assert.equal(tourContributionOriginAllowed(new Request(local, { headers: { origin: "http://[::1]:3000" } })), true);
    assert.equal(tourContributionOriginAllowed(new Request(local, { headers: { origin: "http://127.0.0.1:3001" } })), false);
    assert.equal(tourContributionOriginAllowed(new Request(local, { headers: { origin: "https://127.0.0.1:3000" } })), false);
    assert.equal(tourContributionOriginAllowed(new Request("https://calhacks-production-5fe6.up.railway.app/api/tours/contributions", { headers: { origin: "http://127.0.0.1:3000" } })), false);
    const bound = "http://0.0.0.0:3000/api/tours/contributions";
    assert.equal(tourContributionOriginAllowed(new Request(bound, { headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" } })), true);
    assert.equal(tourContributionOriginAllowed(new Request(bound, { headers: { origin: "http://localhost:3000", host: "localhost:3000" } })), true);
    assert.equal(tourContributionOriginAllowed(new Request(bound, { headers: { origin: "http://127.0.0.1:3001", host: "127.0.0.1:3001" } })), false);
    assert.equal(tourContributionOriginAllowed(new Request(bound, { headers: { origin: "http://127.0.0.1:3000", host: "public.example.com:3000", "x-forwarded-host": "127.0.0.1:3000" } })), false);
    assert.equal(tourContributionOriginAllowed(new Request(bound, { headers: { origin: "http://127.0.0.1:3000" } })), false);
  } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
});

test("never stores contribution files on ephemeral Vercel storage", () => {
  const before = process.env.VERCEL;
  process.env.VERCEL = "1";
  try { assert.throws(() => tourContributionStore(), status(503)); }
  finally { if (before === undefined) delete process.env.VERCEL; else process.env.VERCEL = before; }
});
