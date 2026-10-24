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

test("detects a known hackathon destination from its page name", () => {
  document.head.innerHTML = `<meta property="og:title" content="HackTX 26 — Freetail Hackers"><meta property="og:image" content="/hacktx-card.png">`;
  document.body.innerHTML = "";
  const events = pageEvents(document, "https://hacktx.com/");
  expect(events[0]).toMatchObject({ name: "HackTX 26 — Freetail Hackers", location: "Austin, TX", imageUrl: "https://hacktx.com/hacktx-card.png", lat: 30.2672, lon: -97.7431 });
});

test("uses the event site's icon when no event artwork is available", () => {
  document.head.innerHTML = `<title>Technica</title><link rel="icon" href="/icon.png">`;
  document.body.innerHTML = "";
  const events = pageEvents(document, "https://gotechnica.org/");
  expect(events[0]).toMatchObject({ name: "Technica", location: "College Park, MD", imageUrl: "https://gotechnica.org/icon.png" });
});

test("detects more collegiate hackathon destinations from their names", () => {
  document.head.innerHTML = `<meta property="og:title" content="PennApps XXVIII"><meta property="og:image" content="/social.png">`;
  document.body.innerHTML = "";
  const events = pageEvents(document, "https://pennapps.com/");
  expect(events[0]).toMatchObject({ name: "PennApps XXVIII", location: "Philadelphia, PA", imageUrl: "https://pennapps.com/social.png" });
});
