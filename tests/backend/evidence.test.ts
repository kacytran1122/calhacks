import assert from "node:assert/strict";
import test from "node:test";
import { usefulStopResults } from "../../backend/src/agents/evidence";

test("stop evidence keeps specific places and removes generic search pages", () => {
  const results = usefulStopResults([
    { title: "TOP 10 BEST Coffee & Tea in Durham, NC", link: "https://www.yelp.com/search?find_desc=Coffee&find_loc=Durham" },
    { title: "Duke Coffeehouse - Durham, NC", link: "https://joe.coffee/locations/nc/durham/duke-coffeehouse-durham/" },
    { title: "Late Night Coffee Shops Research Triangle Park", link: "https://www.yelp.com/search?find_desc=Late+Night+Coffee" },
  ]);
  assert.deepEqual(results.map((result) => result.title), ["Duke Coffeehouse - Durham, NC"]);
});
