import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("Photon QR requires a trip token and never asks for contact information", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-photon-join-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const route = pathToFileURL(path.join(root, "frontend/app/api/chat/photon/join/route.ts")).href;
  const mapRoute = pathToFileURL(path.join(root, "frontend/app/api/map/handoff/route.ts")).href;
  const core = pathToFileURL(path.join(root, "backend/src/index.ts")).href;
  const script = `
    import assert from "node:assert/strict";
    const core = await import(${JSON.stringify(core)});
    const { POST } = await import(${JSON.stringify(route)});
    const { GET: mapHandoff } = await import(${JSON.stringify(mapRoute)});
    const seeded = core.buildSeed().state;
    const trip = seeded.trips[0];
    const traveler = seeded.travelers.find((candidate) => candidate.id === trip.travelerId);
    const event = seeded.events.find((candidate) => candidate.id === trip.eventId);
    assert.ok(trip && traveler && event);
    trip.includeSelfDrive = false;
    core.saveState(seeded);
    const tripId = trip.id;
    const tripToken = core.issueTripToken(tripId, trip.travelerId);
    let externalFetches = 0;
    globalThis.fetch = async () => { externalFetches++; throw new Error("No Photon network call belongs in QR creation"); };
    const send = async (body, origin = "https://smilefromhereto.work") => {
      const request = new Request("https://smilefromhereto.work/api/chat/photon/join", { method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-for": "192.0.2.10" }, body: JSON.stringify(body) });
      const response = await POST(request);
      return { response, body: await response.json() };
    };
    const valid = { tripId, tripToken };
    assert.equal((await send(valid, "https://evil.example")).response.status, 403);
    assert.equal((await send({ ...valid, tripToken: "x".repeat(40) })).response.status, 403);
    const first = await send(valid);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.deepEqual(Object.keys(first.body).sort(), ["expiresAt", "messageUrl", "starterMessage"]);
    assert.match(first.body.starterMessage, /^@smile open my route SMILE-/);
    assert.match(first.body.messageUrl, /^sms:\\+14155550199\\?&body=/);
    assert.equal(decodeURIComponent(first.body.messageUrl.split("body=")[1]), first.body.starterMessage);
    assert.equal(JSON.stringify(first.body).includes(tripToken), false);
    assert.equal(JSON.stringify(first.body).includes(JSON.stringify(trip.travelerId)), false);
    assert.equal(externalFetches, 0);
    assert.match(first.response.headers.get("cache-control"), /no-store/);

    const claimed = core.claimPhotonTripHandoff(first.body.starterMessage, { projectId: "pho_prj_test", spaceId: "direct_1", senderId: "human_1" });
    assert.equal(claimed.kind, "ready");
    const token = new URL("https://smilefromhereto.work" + claimed.mapPath).searchParams.get("handoff");
    const bootstrapResponse = await mapHandoff(new Request("https://smilefromhereto.work/api/map/handoff?token=" + token));
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrap.tripId, trip.id);
    assert.equal(bootstrap.mode, trip.mode);
    assert.equal(bootstrap.includeSelfDrive, false);
    assert.equal(bootstrap.origin.query, traveler.homeZip);
    assert.equal(bootstrap.destination.label, event.name);
    assert.equal(bootstrap.destination.query, [event.venue, event.city].filter(Boolean).join(", "));
    assert.equal(JSON.stringify(bootstrap).includes(JSON.stringify(trip.travelerId)), false);
    assert.match(bootstrapResponse.headers.get("cache-control"), /no-store/);
    assert.equal(bootstrapResponse.headers.get("referrer-policy"), "no-referrer");
    delete trip.includeSelfDrive;
    trip.mode = "flight";
    core.saveState(seeded);
    const legacyFlight = await mapHandoff(new Request("https://smilefromhereto.work/api/map/handoff?token=" + token));
    assert.equal((await legacyFlight.json()).includeSelfDrive, false);
    trip.mode = "drive";
    core.saveState(seeded);
    const legacyDrive = await mapHandoff(new Request("https://smilefromhereto.work/api/map/handoff?token=" + token));
    assert.equal((await legacyDrive.json()).includeSelfDrive, true);
    assert.equal((await mapHandoff(new Request("https://smilefromhereto.work/api/map/handoff?token=phm1_" + "x".repeat(43)))).status, 404);
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
      PHOTON_LINE_ADDRESS: "+14155550199",
      PHOTON_BRIDGE_SECRET: "this-is-a-long-test-secret",
      TSX_TSCONFIG_PATH: path.join(root, "frontend/tsconfig.json"),
    },
    timeout: 30_000,
    stdio: "pipe",
  });
});
