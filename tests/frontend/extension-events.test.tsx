import { expect, test } from "vitest";
import { mlhEvents, pageEvents } from "../../frontend/extension/src/events";

test("reads official MLH event cards into route-ready choices", () => {
  document.body.innerHTML = `<a href="https://calhacks.io/?utm_source=mlh" itemtype="https://schema.org/Event"><meta itemprop="url" content="https://calhacks.io/"><meta itemprop="image" content="https://images.example/calhacks.png"><meta itemprop="startDate" content="2026-10-23T17:00:00Z"><span itemprop="address"><meta itemprop="addressLocality" content="San Francisco"><meta itemprop="addressRegion" content="California"><meta itemprop="addressCountry" content="US"></span><h4>Cal Hacks 13.0</h4></a>`;
  const events = mlhEvents(document);
  expect(events).toEqual([{
    name: "Cal Hacks 13.0",
    url: "https://calhacks.io/",
    location: "San Francisco, California, US",
    startsAt: "2026-10-23T17:00:00Z",
    imageUrl: "https://images.example/calhacks.png",
  }]);
});

test("reads a collegiate hackathon JSON-LD venue without page-wide access", () => {
  document.body.innerHTML = `<script type="application/ld+json">{"@type":"Hackathon","name":"Campus Hack","startDate":"2027-02-12T18:00:00-05:00","url":"https://campus.example","location":{"@type":"Place","name":"Student Center","address":{"streetAddress":"1 College Way","addressLocality":"Boston","addressRegion":"MA","postalCode":"02110"},"geo":{"latitude":42.36,"longitude":-71.06}}}</script>`;
  const events = pageEvents(document, "https://campus.example");
  expect(events[0]).toMatchObject({ name: "Campus Hack", url: "https://campus.example", location: "Student Center, 1 College Way, Boston, MA, 02110", lat: 42.36, lon: -71.06 });
});
