import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

test("opaque Photon map session authorizes one idempotent post-trip handoff", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-trip-completion-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const handoffRoute = pathToFileURL(path.join(root, "frontend/app/api/map/handoff/route.ts")).href;
  const completionRoute = pathToFileURL(path.join(root, "frontend/app/api/map/trip-completion/route.ts")).href;
  const core = pathToFileURL(path.join(root, "backend/src/index.ts")).href;
  const script = `
    import assert from "node:assert/strict";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const core = await import(${JSON.stringify(core)});
    const { GET: mapHandoff } = await import(${JSON.stringify(handoffRoute)});
    const { POST: completeTrip } = await import(${JSON.stringify(completionRoute)});

    const state = core.buildSeed().state;
    state.travelers.push({ id: "T-live-route", initials: "LR", school: "Test University", homeZip: "94720" });
    const event = state.events[0];
    const trip = { id: "TR-L-route-security", travelerId: "T-live-route", eventId: event.id, period: state.company.openPeriod, method: "virtual_card", mode: "train", distanceMiles: 90, quoteCents: 7500, requestedBy: "agent:policy", approvals: [], state: "booked" };
    const other = { ...trip, id: "TR-L-forged-target", travelerId: "T-other", state: "planned" };
    state.travelers.push({ id: "T-other", initials: "OT", school: "Other University", homeZip: "60601" });
    state.trips.push(trip, other);
    state.evidence.push(
      { id: "EV-route-quote", tripId: trip.id, kind: "quote", source: "live fare", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: { amountCents: 7500 } },
      { id: "EV-route-bank", tripId: trip.id, kind: "bank_line", source: "Card statement feed", fetchedAt: new Date().toISOString(), status: "ok", provenance: "simulated", data: { amountCents: 7500, currency: "USD" } },
    );
    core.saveState(state);

    const join = core.createPhotonTripHandoff({ tripId: trip.id, travelerId: trip.travelerId });
    const claim = core.claimPhotonTripHandoff(join.starterMessage, { projectId: "pho_prj_test", spaceId: "direct_1", senderId: "human_1" });
    assert.equal(claim.kind, "ready");
    const token = new URL("https://smilefromhereto.work" + claim.mapPath).searchParams.get("handoff");
    assert.ok(token);

    const bootstrap = await mapHandoff(new Request("https://smilefromhereto.work/api/map/handoff?token=" + token));
    assert.equal(bootstrap.status, 200);
    const setCookie = bootstrap.headers.get("set-cookie") || "";
    assert.match(setCookie, /smile_photon_map_handoff=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\\/api\\/map\\/trip-completion/i);
    assert.match(setCookie, /Max-Age=\\d+/i);
    const expires = setCookie.match(/Expires=([^;]+)/i)?.[1];
    assert.ok(expires);
    assert.ok(Math.abs(Date.parse(expires) - Date.parse(claim.expiresAt)) < 2000);
    const cookie = setCookie.split(";")[0];

    const post = (origin, includeCookie = true, body) => completeTrip(new Request("https://smilefromhereto.work/api/map/trip-completion", {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        ...(includeCookie ? { cookie } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));

    assert.equal((await post(undefined)).status, 403);
    assert.equal((await post("https://evil.example")).status, 403);
    const anonymous = await post("https://smilefromhereto.work", false);
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await anonymous.json(), { connected: false });

    const first = await post("https://smilefromhereto.work", true, { tripId: other.id, travelerId: other.travelerId });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.connected, true);
    assert.equal(firstBody.replayed, false);
    assert.equal(firstBody.state, "needs_human");
    const afterFirst = core.loadState();
    assert.equal(afterFirst.trips.find((candidate) => candidate.id === trip.id).state, "needs_human");
    assert.equal(afterFirst.trips.find((candidate) => candidate.id === other.id).state, "planned");
    assert.equal(afterFirst.evidence.filter((item) => item.tripId === trip.id && item.kind === "trip_completion").length, 1);
    assert.equal(afterFirst.evidence.filter((item) => item.tripId === other.id && item.kind === "trip_completion").length, 0);
    assert.equal(afterFirst.audit.filter((item) => item.subject === trip.id && item.action === "trip.map_completed").length, 1);

    const replay = await post("https://smilefromhereto.work");
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    const afterReplay = core.loadState();
    assert.equal(afterReplay.evidence.filter((item) => item.tripId === trip.id && item.kind === "trip_completion").length, 1);
    assert.equal(afterReplay.audit.filter((item) => item.subject === trip.id && item.action === "trip.map_completed").length, 1);
    assert.equal(afterReplay.inbox.filter((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion").length, 1);

    const handoffDb = new DatabaseSync(path.join(process.env.SMILE_DATA_DIR, "photon-handoffs.db"));
    handoffDb.prepare("UPDATE photon_handoffs SET map_expires_at = 0 WHERE map_token_hash = ?").run(core.photonHandoffFingerprint(token));
    handoffDb.close();
    const expired = await post("https://smilefromhereto.work");
    assert.equal(expired.status, 401);
    assert.match(expired.headers.get("set-cookie") || "", /Max-Age=0/i);
    assert.match(expired.headers.get("set-cookie") || "", /Path=\\/api\\/map\\/trip-completion/i);

    const failureState = core.loadState();
    const failureTrip = { ...trip, id: "TR-L-atomic-retry", state: "booked", decision: undefined, submittedAt: undefined };
    failureState.trips.push(failureTrip);
    failureState.evidence.push(
      { id: "EV-atomic-quote", tripId: failureTrip.id, kind: "quote", source: "live fare", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: { amountCents: 7500 } },
      { id: "EV-atomic-bank", tripId: failureTrip.id, kind: "bank_line", source: "Card statement feed", fetchedAt: new Date().toISOString(), status: "ok", provenance: "simulated", data: { amountCents: 7500, currency: "USD" } },
      { id: "EV-atomic-checkin", tripId: failureTrip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: { result: "checked_in" } },
    );
    failureState.company.closedPeriods = [...new Set([...failureState.company.closedPeriods, failureState.company.openPeriod])];
    core.saveState(failureState);

    const retryJoin = core.createPhotonTripHandoff({ tripId: failureTrip.id, travelerId: failureTrip.travelerId });
    const retryClaim = core.claimPhotonTripHandoff(retryJoin.starterMessage, { projectId: "pho_prj_test", spaceId: "direct_atomic", senderId: "human_atomic" });
    assert.equal(retryClaim.kind, "ready");
    const retryToken = new URL("https://smilefromhereto.work" + retryClaim.mapPath).searchParams.get("handoff");
    assert.ok(retryToken);
    const retryBootstrap = await mapHandoff(new Request("https://smilefromhereto.work/api/map/handoff?token=" + retryToken));
    assert.equal(retryBootstrap.status, 200);
    const retryCookie = (retryBootstrap.headers.get("set-cookie") || "").split(";")[0];
    const retryPost = () => completeTrip(new Request("https://smilefromhereto.work/api/map/trip-completion", {
      method: "POST",
      headers: { origin: "https://smilefromhereto.work", cookie: retryCookie },
    }));

    const failed = await retryPost();
    assert.equal(failed.status, 409);
    const afterFailure = core.loadState();
    const failedTrip = afterFailure.trips.find((candidate) => candidate.id === failureTrip.id);
    assert.equal(failedTrip.state, "booked");
    assert.equal(failedTrip.decision, undefined);
    assert.equal(afterFailure.evidence.some((item) => item.tripId === failureTrip.id && item.kind === "trip_completion"), false);
    assert.equal(afterFailure.audit.some((item) => item.subject === failureTrip.id && item.action === "trip.map_completed"), false);
    assert.equal(afterFailure.inbox.some((item) => item.tripId === failureTrip.id), false);
    assert.equal(afterFailure.journal.some((item) => item.refs.includes(failureTrip.id)), false);

    afterFailure.company.closedPeriods = afterFailure.company.closedPeriods.filter((period) => period !== afterFailure.company.openPeriod);
    core.saveState(afterFailure);
    const retried = await retryPost();
    assert.equal(retried.status, 201);
    assert.equal((await retried.json()).replayed, false);
    const afterRetry = core.loadState();
    assert.equal(afterRetry.trips.find((candidate) => candidate.id === failureTrip.id).state, "reimbursed");
    assert.equal(afterRetry.evidence.filter((item) => item.tripId === failureTrip.id && item.kind === "trip_completion").length, 1);
    assert.equal(afterRetry.audit.filter((item) => item.subject === failureTrip.id && item.action === "trip.map_completed").length, 1);
    assert.equal(afterRetry.journal.filter((item) => item.refs.includes(failureTrip.id)).length, 1);
  `;
  execFileSync(process.execPath, ["--conditions=react-server", "--import", path.join(root, "backend/node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      VERCEL: "",
      SMILE_DATA_DIR: directory,
      SMILE_PUBLIC_ORIGIN: "https://smilefromhereto.work",
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
