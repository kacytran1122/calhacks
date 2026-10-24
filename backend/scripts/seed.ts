import "./env";
import { buildSeed, saveState, BOOKS_FILE, ensureUsers, verifyChain } from "../src/index";

const { state, answerKey } = buildSeed();
saveState(state);
ensureUsers();
const planted = Object.values(answerKey).filter((k) => !k.plant.startsWith("(clean)")).length;
console.log(`Seeded ${state.company.name}: ${state.trips.length} trips (${planted} planted errors in the backlog), ${state.journal.length} journal entries.`);
console.log(`Audit chain: ${JSON.stringify(verifyChain(state.audit))}`);
console.log(`Books: ${BOOKS_FILE} (SQLite; ledger invariants enforced by triggers)`);
console.log("Test-only sign-ins: see backend/src/seed/users.ts");
