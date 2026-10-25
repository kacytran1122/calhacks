import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("private Photon join requires a trip token and returns only the visitor-specific real assignment", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-photon-join-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const route = pathToFileURL(path.join(root, "frontend/app/api/chat/photon/join/route.ts")).href;
  const core = pathToFileURL(path.join(root, "backend/src/index.ts")).href;
  const script = `
    import assert from "node:assert/strict";
    const { issueTripToken } = await import(${JSON.stringify(core)});
    const { POST } = await import(${JSON.stringify(route)});
    const tripId = "TR-L-private-test";
    const tripToken = issueTripToken(tripId, "T-private-test");
    const assigned = { assignedPhoneNumber: "+14155550199", assignmentId: "assign_1", createdAt: "2026-10-25T00:00:00Z", handle: "+14155550123", platform: "imessage", projectId: "pho_prj_test", updatedAt: "2026-10-25T00:00:00Z" };
    let assignment;
    let apiCalls = 0;
    globalThis.fetch = async (input, init) => {
      apiCalls++;
      const request = new Request(input, init);
      assert.equal(request.headers.get("authorization"), "Bearer pho_sk_test");
      assert.match(request.url, /\\/v1\\/projects\\/pho_prj_test\\/platforms\\/imessage\\/assignments/);
      if (request.method === "GET") return Response.json({ assignments: assignment ? [assignment] : [] }, { headers: { "x-request-id": "req_list" } });
      assert.equal(request.method, "POST");
      assert.match(request.headers.get("idempotency-key"), /^smile-join-[a-f0-9]{64}$/);
      assert.deepEqual(await request.json(), { handle: "+14155550123" });
      assignment = assigned;
      return Response.json(assigned, { status: 201, headers: { "x-request-id": "req_create" } });
    };
    const send = async (body, origin = "https://smilefromhereto.work") => {
      const request = new Request("https://smilefromhereto.work/api/chat/photon/join", { method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-for": "192.0.2.10" }, body: JSON.stringify(body) });
      const response = await POST(request);
      return { response, body: await response.json() };
    };
    const valid = { handle: "(415) 555-0123", consent: true, tripId, tripToken };
    assert.equal((await send(valid, "https://evil.example")).response.status, 403);
    assert.equal((await send({ ...valid, consent: false })).response.status, 400);
    assert.equal((await send({ ...valid, tripToken: "x".repeat(40) })).response.status, 403);
    assert.equal(apiCalls, 0);
    const first = await send(valid);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body, { assignedPhoneNumber: "+14155550199", messageUrl: "sms:+14155550199", starterMessage: "@smile I’m planning a trip. My home ZIP is _____ and the event link is _____.", reused: false });
    assert.equal(JSON.stringify(first.body).includes("4155550123"), false);
    const second = await send(valid);
    assert.equal(second.response.status, 201);
    assert.equal(second.body.reused, true);
    assert.equal(apiCalls, 3);
    assert.match(first.response.headers.get("cache-control"), /no-store/);
  `;
  execFileSync(process.execPath, ["--conditions=react-server", "--import", path.join(root, "backend/node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      VERCEL: "",
      SMILE_DATA_DIR: directory,
      PHOTON_PROJECT_ID: "pho_prj_test",
      PHOTON_API_KEY: "pho_sk_test",
      PHOTON_BRIDGE_SECRET: "this-is-a-long-test-secret",
      TSX_TSCONFIG_PATH: path.join(root, "frontend/tsconfig.json"),
    },
    timeout: 30_000,
    stdio: "pipe",
  });
});
