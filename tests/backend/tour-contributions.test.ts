import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TOUR_UPLOAD_LIMITS, TourContributionError, TourContributionStore, normalizeTourPhotos, tourContributionOriginAllowed, tourContributionStore, type TourContributionInput } from "../../backend/src/tourContributions";

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
  const ticket = store.reserve(source);
  try { return await store.receive(ticket, value); }
  finally { store.release(ticket); }
}

function status(expected: number) {
  return (error: unknown) => error instanceof TourContributionError && error.status === expected;
}

test("stores actual photos privately and persists a safe receipt across restarts", async (t) => {
  const store = fixture(t);
  const value = await input();
  const receipt = await submit(store, value);
  assert.equal(receipt.status, "received");
  assert.equal(receipt.photoCount, 1);
  assert.equal(receipt.eventName, value.eventName);
  assert.match(receipt.message, /does not automatically create or publish/);
  assert.match(receipt.receiptId, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(receipt).includes(store.directory), false);
  const restarted = new TourContributionStore(store.directory);
  const db = new DatabaseSync(restarted.database);
  const row = db.prepare("SELECT * FROM tour_contributions WHERE id = ?").get(receipt.receiptId) as { photos: string; status: string; location: string };
  const manifest = JSON.parse(row.photos) as { file: string; width: number; height: number }[];
  assert.equal(row.status, "received");
  assert.equal(row.location, value.location);
  assert.equal(manifest[0]!.width, 12);
  assert.equal(manifest[0]!.height, 8);
  const file = path.join(store.directory, receipt.receiptId, manifest[0]!.file);
  assert.equal((await sharp(file).metadata()).format, "png");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
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

test("uses generated paths, not event names or contributor-supplied file paths", async (t) => {
  const store = fixture(t);
  const receipt = await submit(store, await input({ eventName: "../../untrusted-folder" }));
  assert.equal(fs.existsSync(path.join(store.directory, receipt.receiptId)), true);
  assert.equal(fs.existsSync(path.join(path.dirname(store.directory), "untrusted-folder")), false);
  const files = fs.readdirSync(path.join(store.directory, receipt.receiptId));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^[a-f0-9-]{36}\.png$/);
});

test("rate limits survive a restart and do not retain the raw source address", (t) => {
  const store = fixture(t);
  const source = "192.0.2.123";
  for (let count = 0; count < 5; count++) store.release(store.reserve(source));
  const restarted = new TourContributionStore(store.directory);
  assert.throws(() => restarted.reserve(source), status(429));
  const db = new DatabaseSync(store.database);
  const row = db.prepare("SELECT source FROM contribution_attempts LIMIT 1").get() as { source: string };
  assert.match(row.source, /^[a-f0-9]{64}$/);
  assert.notEqual(row.source, source);
  db.close();
});

test("limits concurrent uploads and requires a live, unused upload reservation", async (t) => {
  const store = fixture(t);
  const reservations = [store.reserve("one"), store.reserve("two"), store.reserve("three")];
  assert.throws(() => store.reserve("four"), status(429));
  store.release(reservations[0]!);
  const replacement = store.reserve("four");
  await assert.rejects(store.receive(reservations[0]!, await input()), status(409));
  await store.receive(replacement, await input());
  await assert.rejects(store.receive(replacement, await input()), status(409));
  reservations.forEach((ticket) => store.release(ticket));
});

test("fails closed at the durable disk quota instead of silently accepting files", async (t) => {
  const store = fixture(t);
  const ticket = store.reserve("one");
  const db = new DatabaseSync(store.database);
  db.prepare("INSERT INTO tour_contributions (id, event_name, event_url, location, received_at, status, bytes, photos) VALUES ('full', 'Event', 'https://example.edu', '', '', 'pending', ?, '[]')").run(TOUR_UPLOAD_LIMITS.maxStoredBytes);
  db.close();
  await assert.rejects(store.receive(ticket, await input()), status(503));
  store.release(ticket);
  assert.throws(() => store.reserve("two"), status(503));
  assert.deepEqual(fs.readdirSync(store.directory).filter((file) => /^[a-f0-9-]{36}$/.test(file)), []);
});

test("allows the real production origin through the backend proxy and rejects foreign or missing origins", () => {
  const backend = "https://calhacks-production-5fe6.up.railway.app/api/tours/contributions";
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://smilefromhereto.work", "sec-fetch-site": "same-origin" } })), true);
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://www.smilefromhereto.work" } })), true);
  assert.equal(tourContributionOriginAllowed(new Request(backend, { headers: { origin: "https://calhacks-beta.vercel.app" } })), true);
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
