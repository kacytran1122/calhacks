import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("multipart API validates real uploaded bytes, permission, origins, duplicate fields and body limits", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-tour-api-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const route = pathToFileURL(path.join(root, "frontend/app/api/tours/contributions/route.ts")).href;
  const packageFile = pathToFileURL(path.join(root, "backend/package.json")).href;
  const script = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    import fs from "node:fs";
    import path from "node:path";
    import { POST } from ${JSON.stringify(route)};
    const sharp = createRequire(${JSON.stringify(packageFile)})("sharp");
    const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#fff" } }).png().toBuffer();
    let sequence = 0;
    async function send(kind, expected) {
      const form = new FormData();
      form.set("eventName", "Venue API check");
      form.set("eventUrl", "https://events.example.edu/hackathon");
      form.set("consent", kind === "no-consent" ? "false" : "true");
      const bytes = kind === "oversize-body" ? Buffer.alloc(3 * 1024 * 1024 + 128 * 1024 + 1) : kind === "oversize" ? Buffer.alloc(3 * 1024 * 1024 + 1) : kind === "disguised" ? Buffer.from("not an image") : png;
      if (kind !== "empty") form.append("photos", new Blob([bytes], { type: "image/png" }), "../../outside.png");
      if (kind === "duplicate") form.append("eventName", "Another event");
      if (kind === "unknown") form.set("storagePath", "../../outside");
      const headers = { "x-forwarded-for": "192.0.2." + ++sequence };
      if (kind !== "no-origin") headers.origin = kind === "foreign" ? "https://evil.example" : "https://smilefromhereto.work";
      if (kind === "local-bind") { headers.origin = "http://127.0.0.1:3000"; headers.host = "127.0.0.1:3000"; headers["sec-fetch-site"] = "same-origin"; }
      const url = kind === "local-bind" ? "http://0.0.0.0:3000/api/tours/contributions" : "https://calhacks-production-5fe6.up.railway.app/api/tours/contributions";
      const encoded = new Request(url, { method: "POST", headers, body: form });
      const response = await POST(new Request(encoded.url, { method: "POST", headers: encoded.headers, body: await encoded.arrayBuffer() }));
      const body = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      assert.equal(JSON.stringify(body).includes(process.env.SMILE_DATA_DIR), false);
      if (expected === 201) {
        assert.equal(body.status, "received");
        assert.equal(body.storage, "sqlite");
        const db = new DatabaseSync(path.join(process.env.SMILE_DATA_DIR, "tour-contributions", "contributions.db"));
        const photos = db.prepare("SELECT data, bytes FROM tour_contribution_photos WHERE contribution_id = ?").all(body.receiptId);
        assert.equal(photos.length, 1);
        assert.equal(photos[0].data.byteLength, photos[0].bytes);
        assert.equal((await sharp(Buffer.from(photos[0].data)).metadata()).format, "png");
        db.close();
        assert.equal(fs.existsSync(path.join(process.env.SMILE_DATA_DIR, "tour-contributions", body.receiptId)), false);
      }
    }
    for (const [kind, status] of [["valid", 201], ["local-bind", 201], ["foreign", 403], ["no-origin", 403], ["empty", 400], ["disguised", 415], ["no-consent", 400], ["duplicate", 400], ["unknown", 400], ["oversize", 413], ["oversize-body", 413]]) await send(kind, status);
  `;
  execFileSync(process.execPath, ["--conditions=react-server", "--import", path.join(root, "backend/node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", VERCEL: "", TIGER_DATABASE_URL: "", PHOTO_DATABASE_URL: "", TOUR_CONTRIBUTION_STORAGE: "sqlite", SMILE_DATA_DIR: directory, TSX_TSCONFIG_PATH: path.join(root, "frontend/tsconfig.json") },
    timeout: 30_000,
    stdio: "pipe",
  });
});
