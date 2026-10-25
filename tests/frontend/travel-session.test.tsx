import { beforeEach, expect, test, vi } from "vitest";
import { clearTravelSession, legacyTravelOrigin, rememberTravelOrigin, restoreTravelSession } from "../../frontend/lib/travelSession";

beforeEach(() => clearTravelSession());

test("does not accept invalid legacy locations or out-of-range coordinates", () => {
  expect(legacyTravelOrigin(new URLSearchParams("zip=bad&lat=33&lon=-117"))).toBeNull();
  expect(legacyTravelOrigin(new URLSearchParams("zip=61401&lat=300&lon=-117"))).toEqual({ zip: "61401", label: "61401" });
  expect(legacyTravelOrigin(new URLSearchParams("zip=61401&lat=&lon="))).toEqual({ zip: "61401", label: "61401" });
});

test("a legacy GPS placeholder is not restored as a current device location without coordinates", () => {
  expect(legacyTravelOrigin(new URLSearchParams("zip=61401&origin=Current+location"))).toEqual({ zip: "61401", label: "61401" });
});

test("malformed saved session data is ignored", () => {
  window.sessionStorage.setItem("smile.travel-origin.v1", "not-json");
  expect(restoreTravelSession()).toBeNull();
  window.sessionStorage.setItem("smile.travel-origin.v1", JSON.stringify({ version: 1, active: true, zip: "bad", label: "Current location" }));
  expect(restoreTravelSession()).toBeNull();
});

test("the live session works even when browser storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  rememberTravelOrigin({ zip: "61401", label: "Current location", coordinates: { lat: 33.6405, lon: -117.8443 }, enteredOrigin: { zip: "61401", label: "61401" } });
  expect(restoreTravelSession()?.origin.coordinates).toEqual({ lat: 33.6405, lon: -117.8443 });
});
