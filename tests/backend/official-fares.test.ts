import assert from "node:assert/strict";
import test from "node:test";
import { metrolinkFareFromPage } from "../../backend/src/integrations/official-fares";

const officialPage = `<main><p>Each Metrolink ticket or pass includes free transfers to most local transit providers.</p><ul><li>Weekdays: $19</li><li>Saturdays &amp; Sundays: $12</li><li>Holidays: $12</li></ul></main>`;

test("official Metrolink page yields the weekend trip total", () => {
  const fare = metrolinkFareFromPage(officialPage, "2026-10-25T00:30:00.000Z");
  assert.equal(fare?.amountUsd, 12);
  assert.equal(fare?.mode, "train");
  assert.match(fare?.quote ?? "", /free transfers/i);
});

test("official Metrolink page yields the weekday trip total", () => {
  const fare = metrolinkFareFromPage(officialPage, "2026-10-27T00:30:00.000Z");
  assert.equal(fare?.amountUsd, 19);
});

test("fare extraction rejects a page without transfer coverage", () => {
  assert.equal(metrolinkFareFromPage("<p>Weekdays: $19 Saturdays &amp; Sundays: $12</p>", "2026-10-25T00:30:00.000Z"), undefined);
});
