import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  claimPhotonTripHandoff,
  createPhotonTripHandoff,
  PhotonHandoffError,
  resolvePhotonMapHandoff,
} from "../../backend/src/photonHandoff";

const env = {
  PHOTON_BRIDGE_SECRET: "this-is-a-long-test-secret",
  PHOTON_LINE_ADDRESS: "+14155550199",
};

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-photon-handoff-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let seed = 0;
  return {
    database: path.join(directory, "handoffs.db"),
    env,
    now: () => new Date("2026-10-25T12:00:00.000Z"),
    randomBytes: (size: number) => Buffer.alloc(size, seed++),
  };
}

const identity = { projectId: "pho_prj_test", spaceId: "direct_1", senderId: "human_1" };

test("creates a contact-free QR request for only the configured dedicated line", (t) => {
  const runtime = fixture(t);
  const result = createPhotonTripHandoff({ tripId: "TR-L-test", travelerId: "T-test" }, runtime);
  assert.match(result.starterMessage, /^@smile open my route SMILE-(?:[23456789A-Z]{4}-){3}[23456789A-Z]{4}$/);
  assert.equal(result.expiresAt, "2026-10-25T12:15:00.000Z");
  assert.match(result.messageUrl, /^sms:\+14155550199\?&body=/);
  assert.equal(decodeURIComponent(result.messageUrl.split("body=")[1]!), result.starterMessage);
  assert.doesNotMatch(JSON.stringify(result), /TR-L-test|T-test|phone|email|assigned/i);
});

test("has no fallback line or handoff secret", (t) => {
  const runtime = fixture(t);
  assert.throws(
    () => createPhotonTripHandoff({ tripId: "TR-L-test", travelerId: "T-test" }, { ...runtime, env: { PHOTON_BRIDGE_SECRET: env.PHOTON_BRIDGE_SECRET } }),
    (error: unknown) => error instanceof PhotonHandoffError && error.code === "LINE_NOT_CONFIGURED",
  );
  assert.throws(
    () => createPhotonTripHandoff({ tripId: "TR-L-test", travelerId: "T-test" }, { ...runtime, env: { PHOTON_LINE_ADDRESS: env.PHOTON_LINE_ADDRESS } }),
    (error: unknown) => error instanceof PhotonHandoffError && error.code === "HANDOFF_NOT_CONFIGURED",
  );
});

test("first direct sender claims the code, safe retries reuse it, and another sender is refused", (t) => {
  const runtime = fixture(t);
  const join = createPhotonTripHandoff({ tripId: "TR-L-test", travelerId: "T-test" }, runtime);
  const first = claimPhotonTripHandoff(join.starterMessage, identity, runtime);
  assert.equal(first.kind, "ready");
  if (first.kind !== "ready") return;
  assert.equal(first.reused, false);
  assert.match(first.mapPath, /^\/map\?handoff=phm1_[A-Za-z0-9_-]{43}$/);
  const token = new URL(`https://smilefromhereto.work${first.mapPath}`).searchParams.get("handoff")!;
  assert.deepEqual(resolvePhotonMapHandoff(token, runtime), {
    tripId: "TR-L-test",
    travelerId: "T-test",
    expiresAt: "2026-10-26T00:00:00.000Z",
  });

  const replay = claimPhotonTripHandoff(join.starterMessage, identity, runtime);
  assert.deepEqual(replay, { ...first, reused: true });
  assert.deepEqual(
    claimPhotonTripHandoff(join.starterMessage, { ...identity, senderId: "human_2" }, runtime),
    { kind: "used" },
  );
  assert.equal(resolvePhotonMapHandoff(`${token.slice(0, -1)}x`, runtime), null);
});

test("distinguishes ordinary chat, malformed route commands, claim expiry, and map expiry", (t) => {
  const runtime = fixture(t);
  assert.deepEqual(claimPhotonTripHandoff("@smile help me", identity, runtime), { kind: "none" });
  assert.deepEqual(claimPhotonTripHandoff("@smile open my route not-a-code", identity, runtime), { kind: "invalid" });

  const join = createPhotonTripHandoff({ tripId: "TR-L-test", travelerId: "T-test" }, runtime);
  const expiredClaim = claimPhotonTripHandoff(join.starterMessage, identity, {
    ...runtime,
    now: () => new Date("2026-10-25T12:15:00.000Z"),
  });
  assert.deepEqual(expiredClaim, { kind: "expired" });

  const freshRuntime = fixture(t);
  const fresh = createPhotonTripHandoff({ tripId: "TR-L-fresh", travelerId: "T-fresh" }, freshRuntime);
  const claimed = claimPhotonTripHandoff(fresh.starterMessage, identity, freshRuntime);
  assert.equal(claimed.kind, "ready");
  if (claimed.kind !== "ready") return;
  const token = new URL(`https://smilefromhereto.work${claimed.mapPath}`).searchParams.get("handoff")!;
  assert.equal(resolvePhotonMapHandoff(token, { ...freshRuntime, now: () => new Date("2026-10-26T00:00:00.000Z") }), null);
});

test("refuses ephemeral Vercel storage instead of pretending the handoff is durable", () => {
  assert.throws(
    () => createPhotonTripHandoff(
      { tripId: "TR-L-test", travelerId: "T-test" },
      { env: { ...env, VERCEL: "1" } },
    ),
    (error: unknown) => error instanceof PhotonHandoffError && error.code === "PERSISTENT_STORAGE_REQUIRED",
  );
});
