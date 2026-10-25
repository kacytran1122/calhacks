import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, type Photon, type SharedLineAssignment } from "../../backend/node_modules/@photon-ai/api/dist/index.js";
import { assignPhotonDirectChat, normalizeImessageHandle, PhotonJoinError } from "../../backend/src/photonJoin";

const env = {
  PHOTON_PROJECT_ID: "pho_prj_test",
  PHOTON_API_KEY: "pho_sk_test",
  PHOTON_BRIDGE_SECRET: "this-is-a-long-test-secret",
};

const assignment = (handle: string, assignedPhoneNumber = "+14155550199"): SharedLineAssignment => ({
  assignedPhoneNumber,
  assignmentId: "assign_1",
  createdAt: "2026-10-25T00:00:00Z",
  handle,
  platform: "imessage",
  projectId: "pho_prj_test",
  updatedAt: "2026-10-25T00:00:00Z",
});

function client(options: { existing?: SharedLineAssignment; createError?: Error } = {}) {
  const calls: unknown[] = [];
  const value = {
    projects: { platforms: { imessage: { assignments: {
      list: async (input: unknown) => {
        calls.push(["list", input]);
        return { assignments: options.existing ? [options.existing] : [] };
      },
      create: async (input: { body: { handle: string } }) => {
        calls.push(["create", input]);
        if (options.createError) throw options.createError;
        return assignment(input.body.handle);
      },
    } } } },
  } as unknown as Pick<Photon, "projects">;
  return { value, calls };
}

test("normalizes supported iMessage phone and Apple Account identities", () => {
  assert.equal(normalizeImessageHandle("(415) 555-0123"), "+14155550123");
  assert.equal(normalizeImessageHandle("1 415 555 0123"), "+14155550123");
  assert.equal(normalizeImessageHandle("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeImessageHandle("Traveler@iCloud.com"), "traveler@icloud.com");
  for (const invalid of ["", "555-0123", "+012345678", "not-an-email", "a@b", "a@@example.com", "x\n@example.com"])
    assert.throws(() => normalizeImessageHandle(invalid), PhotonJoinError);
});

test("creates a real shared-line assignment and returns a recipient-only Messages URL", async () => {
  const fake = client();
  const result = await assignPhotonDirectChat("415-555-0123", { env, client: fake.value });
  assert.equal(result.assignedPhoneNumber, "+14155550199");
  assert.equal(result.messageUrl, "sms:+14155550199");
  assert.match(result.starterMessage, /^@smile\b/);
  assert.equal(result.reused, false);
  assert.deepEqual(fake.calls.map((call) => (call as unknown[])[0]), ["list", "create"]);
  const create = fake.calls[1] as [string, { headers: { idempotencyKey: string }; body: { handle: string } }];
  assert.equal(create[1].body.handle, "+14155550123");
  assert.match(create[1].headers.idempotencyKey, /^smile-join-[a-f0-9]{64}$/);
  assert.doesNotMatch(result.messageUrl, /body=|@smile/);
});

test("reuses an active assignment without consuming another seat", async () => {
  const fake = client({ existing: assignment("person@icloud.com") });
  const result = await assignPhotonDirectChat("Person@iCloud.com", { env, client: fake.value });
  assert.equal(result.reused, true);
  assert.deepEqual(fake.calls.map((call) => (call as unknown[])[0]), ["list"]);
});

test("recovers an assignment-exists race by looking up only the requested handle", async () => {
  let lists = 0;
  const calls: unknown[] = [];
  const exists = new ApiError("exists", { status: 409, headers: new Headers(), body: { code: "ASSIGNMENT_EXISTS" } });
  const fake = { projects: { platforms: { imessage: { assignments: {
    list: async () => ({ assignments: ++lists === 1 ? [] : [assignment("+14155550123")] }),
    create: async (input: unknown) => { calls.push(input); throw exists; },
  } } } } } as unknown as Pick<Photon, "projects">;
  const result = await assignPhotonDirectChat("4155550123", { env, client: fake });
  assert.equal(result.assignedPhoneNumber, "+14155550199");
  assert.equal(calls.length, 1);
  assert.equal(lists, 2);
});

test("fails safely for capacity, permissions, invalid assignments and missing server config", async () => {
  const capacity = client({ createError: new ApiError("private detail with +14155550123", { status: 409, headers: new Headers(), body: { code: "SHARED_LINE_CAP_EXCEEDED" } }) });
  await assert.rejects(assignPhotonDirectChat("4155550123", { env, client: capacity.value }), (error: unknown) => {
    assert.ok(error instanceof PhotonJoinError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "SHARED_LINE_CAP_EXCEEDED");
    assert.doesNotMatch(error.message, /4155550123/);
    return true;
  });
  const forbidden = client({ createError: new ApiError("secret", { status: 403, headers: new Headers(), body: { code: "INSUFFICIENT_SCOPE" } }) });
  await assert.rejects(assignPhotonDirectChat("4155550123", { env, client: forbidden.value }), /platforms:read and platforms:write/);
  const malformed = client({ existing: assignment("+14155550123", "not-a-number") });
  await assert.rejects(assignPhotonDirectChat("4155550123", { env, client: malformed.value }), /did not return an active iMessage number/);
  await assert.rejects(assignPhotonDirectChat("4155550123", { env: {}, client: client().value }), /not available yet/);
});
