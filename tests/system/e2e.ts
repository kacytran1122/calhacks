import { TEST_USERS } from "../../backend/src/seed/users";
const B = process.env.SMILE_URL ?? "http://127.0.0.1:3000";
let failed = 0;
const pw = (id: string) => TEST_USERS.find((u) => u.id === id)!.password;
async function call(path: string, body?: unknown, cookie?: string) {
  const r = await fetch(B + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = r.headers.get("set-cookie")?.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null), setCookie };
}
const line = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name} — ${detail}`);
};
const signIn = async (id: string) => (await call("/api/auth/login", { id, password: pw(id) })).setCookie!;

const anon = await call("/api/desk");
line("Desk without sign-in", anon.status === 401, `HTTP ${anon.status}`);
const bad = await call("/api/auth/login", { id: "maya", password: "wrong" });
line("Wrong password", bad.status === 401, `HTTP ${bad.status}`);

const maya = await signIn("maya");
const dev = await signIn("dev");
const t01 = await signIn("t01");
line("Reset as traveler", (await call("/api/desk/reset", {}, t01)).status === 403, "refused");
line("Reset as controller", (await call("/api/desk/reset", {}, maya)).status === 200, "ok");
const tickT = await call("/api/desk/tick", {}, t01);
line("Traveler can't run the pass", tickT.status === 403, `HTTP ${tickT.status}`);
const tick = await call("/api/desk/tick", {}, dev);
line("Organizer runs the pass", tick.status === 200, `${tick.json?.done?.length} trips`);

const snapDev = (await call("/api/desk", undefined, dev)).json;
const q25 = snapDev.inbox.find((i: { tripId: string }) => i.tripId === "TR-F-25");
const forged = await call("/api/desk/answer", { itemId: q25.id, option: "approve", personId: "P-maya", role: "controller" }, dev);
line("Dev forges controller identity in the body", forged.status === 403, `${forged.status}: ${forged.json?.error}`);
const own = await call("/api/desk/answer", { itemId: q25.id, option: "approve" }, dev);
line("Dev settles their own exception (no forgery)", own.status === 403, `${own.status}: ${own.json?.error}`);
const mayaOk = await call("/api/desk/answer", { itemId: q25.id, option: "approve" }, maya);
line("Maya (controller) settles it", mayaOk.status === 200, mayaOk.json?.outcome);

const snapT = (await call("/api/desk", undefined, t01)).json;
line("Traveler T01 sees only own trips", snapT.trips.every((t: { travelerId: string }) => t.travelerId === "T01") && snapT.trialBalance.length === 0, `${snapT.trips.length} trip(s), ledger hidden`);
line("Traveler T01 can't read another trip", (await call("/api/trace/TR-F-09", undefined, t01)).status === 403, "refused");
const q01 = snapT.inbox.find((i: { tripId: string }) => i.tripId === "TR-F-01");
const t01ans = await call("/api/desk/answer", { itemId: q01.id, option: "approve" }, t01);
line("T01 re-approves own fare", t01ans.status === 200, t01ans.json?.outcome);

const snapM = (await call("/api/desk", undefined, maya)).json;
const forgedEv = snapM.audit.find((a: { action: string }) => a.action === "identity.forged");
line("Forgery is on the audit trail", Boolean(forgedEv), forgedEv?.reason ?? "missing");
line("Audit chain intact", snapM.chain.ok, JSON.stringify(snapM.chain));
line("Books balance", snapM.trialBalance.reduce((a: number, r: { balance: number }) => a + r.balance, 0) === 0, "Σ = 0");

const plan = await call("/api/plan", { zip: "95616" });
line("Anonymous plan returns a trip token", plan.status === 200 && typeof plan.json?.approvalToken === "string", `${plan.json?.trip?.id}`);
const budgetBlock = await call("/api/plan", { zip: "95616", travelerBudgetCents: 100, maxDistanceMiles: 3000 });
line("Traveler budget blocks overspend", budgetBlock.status === 200 && budgetBlock.json?.routes?.blockReason === "TRAVELER_BUDGET" && !budgetBlock.json?.routes?.pick, budgetBlock.json?.routes?.blockReason ?? "missing reason");
line("Traveler budget does not create a finance exception", budgetBlock.json?.inbox === null, budgetBlock.json?.inbox ? "unexpected inbox item" : "no controller request");
const qp = plan.json.inbox.id;
const wrongTok = await call("/api/desk/answer", { itemId: q01.id, option: "approve", tripToken: plan.json.approvalToken });
line("Trip token can't answer another trip", wrongTok.status !== 200, `HTTP ${wrongTok.status}`);
const okTok = await call("/api/desk/answer", { itemId: qp, option: "approve", tripToken: plan.json.approvalToken });
line("Trip token approves its own mandate", okTok.status === 200, okTok.json?.outcome);
const book = await call("/api/plan/book", { tripId: plan.json.trip.id, fareDeltaCents: 350, tripToken: plan.json.approvalToken });
line("Fare moved at checkout, declined, and re-approval asked", book.status === 200 && book.json?.ok === false, book.json?.detail);

await call("/api/desk/reset", {}, maya);
await call("/api/auth/logout", {}, maya);
line("Session gone after sign-out", (await call("/api/desk", undefined, maya)).status === 401, "401");
if (failed) process.exit(1);
