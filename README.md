# S’mile

> Every mile ends in a smile.

S’mile helps hackers find an event, compare realistic ways to get there, approve an exact travel price, and hand the same trip record to the organizer’s reimbursement desk. The money path is deterministic: AI may read and explain messy evidence, but it cannot invent an amount, approve an exception, or post an unbalanced journal entry.

## Repository map

```text
frontend/           Next.js experience and Chrome extension
backend/            Agents, policy engine, ledger, integrations, and Photon worker
.github/workflows/  CI checks and continuous-delivery artifacts
tests/              Frontend, backend, agent, and full-system tests
.gitignore
README.md
```

Only these product areas live at the repository root. Generated files, credentials, databases, and dependency folders remain ignored.

## Product flow

1. Enter a ZIP or a U.S. city and state.
2. Choose the maximum trip distance and discover live public events.
3. Set a personal budget and compare routes by price, time, and missed-kickoff risk.
4. Approve one exact quote; a changed fare requires a new approval.
5. Send the trip, evidence, and consent trail to the organizer desk.
6. Reconcile receipts, settlements, check-ins, and policy into balanced books.

## Architecture

| Area | Responsibility |
|---|---|
| `frontend/app` | Landing page, event search, traveler planning, chat, organizer desk, and the walk-through of the venue |
| `frontend/extension` | Read-only Chrome extension for public event pages |
| `backend/src/agents` | Scout, Evidence, Route, Policy, Payments, Reconciler, and Auditor |
| `backend/src/integrations` | Bright Data, public transit, official fares, weather, geocoding, and Visa sandbox adapters |
| `backend/src` | Policy, permissions, orchestration, authentication, ledger, and audit trail |
| `backend/photon` | Photon 2.0 iMessage transport |
| `backend/.data` | Local SQLite books, auth, and event snapshots; never committed |

## Local development

Requires Node.js 22 or newer.

```bash
npm ci --prefix backend
npm ci --prefix frontend
npm ci --prefix tests
cp backend/.env.example backend/.env
npm run seed --prefix backend
npm run dev --prefix frontend
```

Open `http://127.0.0.1:3000`.

All sponsor credentials are optional. Missing services report that they are unavailable; the application never fabricates live data. Keep every secret in `backend/.env`.

## Test suites

```bash
npm run typecheck --prefix backend
npm run test:backend --prefix backend
npm run test:agents --prefix backend
npm run eval --prefix backend

npm run typecheck --prefix frontend
npm test --prefix frontend
npm run extension:build --prefix frontend
npm run build --prefix frontend
```

For the full HTTP system test, start the frontend and run:

```bash
npm run test:system --prefix backend
```

The test pyramid lives entirely under `tests/`:

- `tests/frontend`: user interaction, location-entry behavior, and the venue's floor-plan data, search and walking routes.
- `tests/backend`: policy boundaries, deterministic seed data, geocoding validation, ledger balance, price-model parity, and heat scoring.
- `tests/agents`: least privilege, Photon event filtering, 40-case evaluation, and adversarial controls.
- `tests/system`: sign-in, role isolation, trip-token scope, approval, booking, and repository-structure checks.

## CI/CD

`.github/workflows/ci.yml` runs independent jobs for repository structure, backend, agents, frontend, and the complete HTTP workflow. Pull requests must pass every layer. A passing push to `main` produces a versioned delivery artifact containing the production Next.js build, Chrome extension, and backend runtime source.

No production deployment occurs without an explicitly configured hosting environment and credentials.

## Integration status

| Integration | Use |
|---|---|
| Anthropic | Public-page extraction, explanations, and audit defense; amounts remain deterministic |
| Bright Data | Live logged-out event, route, fare, and stop pages |
| Hyphenate | Organizer finance desk, reconciliation, controls, and accountable handoffs |
| Photon 2.0 | `@smile` group conversation and private trip-scoped approval links |
| TigerData | Time-series snapshots for event date and venue changes |
| Visa | Reviewed, exact-amount travel basket; signed Visa Acceptance sandbox authorization when configured, capture disabled |
| Open-Meteo | Live forecast and ERA5 history for the venue heat map (no key) |
| OpenStreetMap | Map tiles for the heat map |

## Price prediction and heat map

Two planning aids in the trip pane: **a model produces evidence, plain code decides**.

**Price outlook — each time of day has its own price.** Gradient-boosted quantile models predict a p10 / p50 / p90 range, and the trip pane charts the same trip at every hour of the day with your departure and the cheapest hour that still arrives on time.

| Model | Trained on (public data) | Held-out test | Typical error (p50) | Baseline | p10–p90 holds |
|---|---|---|---|---|---|
| Rideshare (Uber, Lyft) | 5.0M NYC TLC high-volume trips, Feb + Aug 2026 | last week of Aug 2026, 665,722 trips | $6.40 (R² 0.78) | flat per-mile rate $7.41 · same model without time features $6.63 | 79% |
| Airfare, route level | U.S. DOT Consumer Airfare Report, 2015–2025 | last 4 quarters, 8,281 routes | $32.64 (R² 0.51) | distance only $51.47 | 73% |
| Flight departure hour | 162,809 Expedia fares with departure times (Mendeley Data, CC BY 4.0) | last 3 weeks of travel dates, 28,963 fares | NZ$63.75 | same-route daily median NZ$78.89 | 80% |

- **Rideshare** uses the road distance (live OSRM) and the time of the request: hour, weekday, hour of week, weekend and named day periods (late night, early morning, morning rush, midday, evening rush, evening, night). Trip minutes are deliberately not an input — before a trip the app only knows free-flow drive time, so traffic and surge have to come from the time features. Riders paid $5.29/mile weekday late nights vs $7.46 in the evening rush; the model's weekday swing for the same 8-mile ride is 37% ($28.66 at 4 am, $39.18 at 5 pm). Learned from New York City prices, which the UI says.
- **Flights** combine the season-level fare for the airport pair (DOT) with a departure-hour shape learned from fares that record each flight's departure time, scaled so the day's departures average to the route fare. The DOT data has no times of day; the departure-time data has no booking date, so how far ahead you book is not modeled. Airports are chosen counting ground travel at the policy's IRS mileage rate.
- **Past vs predicted.** Each hourly chart draws two lines: the model's prediction for your trip (solid) and the past pattern (dashed) — what riders actually paid per mile at that hour for similar-length trips on the same kind of day, times your distance; for flights, how nonstop fares actually varied by departure hour, times the route fare. Hours with fewer than 30 past trips or flights are left as gaps. Built by `backend/ml/notebooks/smile_price_history.ipynb` into `backend/ml/models/price_history.json`.
- Estimates are never the approvable amount: a traveler still approves an exact, live-quoted price.
- Training runs on a GPU in `backend/ml/notebooks/smile_price_models.ipynb` (XGBoost). Trees are exported to compact JSON in `backend/ml/models/` and evaluated in TypeScript (`backend/src/ml/gbdt.ts`); the notebook and `tests/backend/price-models.test.ts` both check the TypeScript numbers against XGBoost.

**Heat at the venue** (`backend/src/agents/heat.ts`):

```text
select region (grid around the venue)
  -> thermal evidence per cell (feels-like °F at kickoff, GFS + ECMWF via Open-Meteo)
  -> hotspot candidates: discard cells < 1°F above the area median
  -> severity (NWS heat-index bands) × confidence (lead time × model agreement)
  -> ranked hotspots on an OpenStreetMap map
```

Evidence is live forecast temperature, or the same date over the last three years (ERA5) when the event is more than 15 days out. Values are relative planning evidence, not calibrated measurements. Forecast models are a few miles across, so small hotspots inside a neighborhood are usually not resolvable.

## 3D venue: Cal Hacks 13.0 at the Palace of Fine Arts

`/venue` puts you inside the main floor at eye level, starting at the business entrance where attendees arrive. It's linked from the trip pane for Cal Hacks events. Drag to look around; walk with W A S D, the arrow keys or the on-screen pad; tap the floor or the little map to walk there. Search for a sponsor (by name or booth number), a place or a spot, and S'mile lights a beacon over it, says how far it is, and on "Walk me there" walks you along the aisles to stand in front of it.

- **Built from the event's floor plan, in code.** `frontend/app/venue/palace.ts` holds the data in plan pixels, so the plan can be corrected in place. The 263 main-floor hacker tables, 43 sponsor booths and 16 places were found by color on the plan image, so they sit exactly where the plan puts them. The curved walls are circles fitted to the plan (the hall is a band about 290–370 ft from its center of curvature), and rooms, blocked areas, the stage, the bleachers and the theater are traced. Scale is 4.3 px per foot, from Breakout #7's 54 ft side and the 6 ft table spacing.
- **three.js, no model files.** `scene.ts` extrudes the floor, walls and rooms, places tables and chairs as instanced meshes oriented across the hall, prints each sponsor's name on its banner, and keeps signs (HTML over the canvas) for areas and places you can actually see from where you stand. The ceiling height, roof trusses, skylights and windows are there for a sense of the space; they aren't measured.
- **Walking.** `walk.ts` cuts the floor into ~0.6 m cells: open where you could stand clear of walls, closed areas, rooms, the stage and the stairs, and costlier under tables and booths. Routes are A* over that grid, pulled tight into a few straight legs, so they keep to the aisles. Booths are seen square on from the front, rooms from outside their door, and anything else from the side with the most floor around it.
- **Not yet:** the mezzanine (Mezzanine #2–#4, rooms M5–M8 and the other 41 hacker tables), hacker table numbers (the plan has positions but not numbers), and 11 sponsor names that couldn't be matched to a booth. Those booths show as "Sponsor table" rather than a guess.

## Safety boundaries

- Public, logged-out web data only.
- Human approval is required for the exact trip price.
- AI output cannot directly post or pay an amount.
- Agent capabilities are enforced in code, not prompts.
- Ledger entries must balance and carry evidence or rule references.
- Posted entries and hash-chained audit history are immutable.
- Secrets, local databases, build output, and dependency folders are ignored.
