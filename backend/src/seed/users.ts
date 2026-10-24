/**
 * TEST-ONLY sign-in accounts for the local demo. These are not real accounts and these
 * passwords protect nothing outside this machine. Production would use the organization's
 * identity provider; never reuse these values anywhere.
 *
 * Staff:      maya (controller) · dev (organizer)
 * Travelers:  t01 … t40 (one per seeded traveler)
 */
import type { HumanRole } from "../types";

export interface TestUser {
  id: string; // sign-in name
  personId: string; // the person/traveler id the books use
  role: HumanRole;
  name: string;
  password: string;
}

export const TEST_USERS: TestUser[] = [
  { id: "maya", personId: "P-maya", role: "controller", name: "Maya R.", password: "maya-ggh-test-only" },
  { id: "dev", personId: "P-dev", role: "organizer", name: "Dev P.", password: "dev-ggh-test-only" },
  ...Array.from({ length: 40 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return { id: `t${n}`, personId: `T${n}`, role: "traveler" as const, name: `Traveler T${n}`, password: `t${n}-ggh-test-only` };
  }),
];
