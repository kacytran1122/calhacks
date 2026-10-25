import assert from "node:assert/strict";
import test from "node:test";
import { distinctRouteGuides, itineraryFares, routeGuideTimings, usefulStopResults, type RouteGuide } from "../../backend/src/agents/evidence";

test("stop evidence keeps specific places and removes generic search pages", () => {
  const results = usefulStopResults([
    { title: "TOP 10 BEST Coffee & Tea in Durham, NC", link: "https://www.yelp.com/search?find_desc=Coffee&find_loc=Durham" },
    { title: "Duke Coffeehouse - Durham, NC", link: "https://joe.coffee/locations/nc/durham/duke-coffeehouse-durham/" },
    { title: "Late Night Coffee Shops Research Triangle Park", link: "https://www.yelp.com/search?find_desc=Late+Night+Coffee" },
  ]);
  assert.deepEqual(results.map((result) => result.title), ["Duke Coffeehouse - Durham, NC"]);
});

test("keeps distinct same-line transit alternatives and removes self-drive even from extracted guides", () => {
  const first: RouteGuide = { mode: "train", title: "Public transit via Orange County Line", durationText: "90 min", durationMinutes: 90, sourceUrl: "https://transitous.org/sources/", sourceQuote: "Scheduled public transit", steps: [{ instruction: "Board at Union Station and get off at Tustin.", detail: "Board at 9:00 AM" }] };
  const next = { ...first, steps: [{ ...first.steps[0]!, detail: "Board at 9:30 AM" }] };
  const road: RouteGuide = { ...first, mode: "drive", title: "Self-drive" };
  const guides = distinctRouteGuides([first, first, next, road], false);
  assert.equal(guides.length, 2);
  assert.deepEqual(guides, [first, next]);
  assert.ok(guides.every(guide => guide.mode !== "drive"));
});

test("does not bind a generic fare to one of several distinct same-mode itineraries", () => {
  const guide: RouteGuide = { mode: "train", title: "Express train", durationText: "60 min", sourceUrl: "https://transitous.org/sources/", sourceQuote: "Scheduled train", steps: [{ instruction: "Board the express train.", detail: null }] };
  const fares = [{ mode: "train", amountUsd: 15 }, { mode: "train", amountUsd: 22, routeTitle: "Express train" }, { mode: "bus", amountUsd: 10 }];
  assert.deepEqual(itineraryFares(fares, [guide, { ...guide, title: "Local train" }]), fares.slice(1));
  assert.deepEqual(itineraryFares(fares, [guide]), fares);
});

test("colliding cross-source route titles cannot overwrite timing or bind a fare to the wrong itinerary", () => {
  const guide: RouteGuide = { mode: "train", title: "Regional train", durationText: "60 min", durationMinutes: 60, sourceUrl: "https://transitous.org/sources/", sourceQuote: "Scheduled train", steps: [{ instruction: "Board the express train.", detail: null }] };
  const different = { ...guide, durationMinutes: 95, durationText: "95 min", sourceUrl: "https://operator.example/route" };
  const bus: RouteGuide = { ...guide, mode: "bus", title: "Express bus", durationMinutes: 120 };
  const fares = [{ mode: "train", amountUsd: 20, routeTitle: "Regional train" }, { mode: "bus", amountUsd: 10, routeTitle: "Express bus" }];
  assert.deepEqual(itineraryFares(fares, [guide, different, bus]), [fares[1]]);
  assert.deepEqual(routeGuideTimings([guide, different, bus]), { "Express bus": { minutes: 120, source: bus.sourceUrl } });
});
