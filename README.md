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
3. Set a personal budget and compare routes by price, time, emissions, and missed-kickoff risk.
4. Approve one exact quote; a changed fare requires a new approval.
5. Send the trip, evidence, and consent trail to the organizer desk.
6. Reconcile receipts, settlements, check-ins, and policy into balanced books.

The public traveler entry point is `https://smilefromhereto.work/landing`. Finding nearby events moves to `/finding-events`, while route guidance lives at `/map`. The typed starting point is remembered in tab-scoped session storage; precise coordinates remain only in page memory and are not retained after a full refresh. The root address and older `/find` links redirect to the canonical paths without retaining legacy location parameters in the address bar.

## End-of-ride payment demo

After a bus, train, or taxi leg, S’mile asks the traveler to confirm that they have left the vehicle. GPS proximity can offer this prompt but does not prove that someone has stepped off. The traveler enters a USD amount for the demo and explicitly selects **Pay with Visa (simulation)**. A generated, downloadable receipt is marked simulated, records the traveler-entered amount, and confirms that no funds moved. It is not an operator ticket, a real Visa transaction, or valid reimbursement evidence.

Demo receipts are kept separately from booking authorizations, mandates, and the reimbursement ledger. A private browser cookie scopes access for 30 days; download a copy to retain it beyond the demo session. Retrying the same ride request within that session returns its existing receipt. If a session is lost during an uncertain request, another attempt for that ride is blocked rather than creating a new receipt. A traveler may skip the demo after confirming exit, or stop guidance without marking a ride complete. Real transport must still be paid for under the operator’s own rules.

## Architecture

| Area | Responsibility |
|---|---|
| `frontend/app` | Landing page, event search, traveler planning, GPS route guidance, chat, and organizer desk |
| `frontend/extension` | Read-only Chrome extension for public event pages |
| `backend/src/agents` | Scout, Evidence, Route, Discover, Heat, Pricing, and the @smile Concierge |
| `backend/src/scheduler.ts` | Wakes the agents on a timer: backlog, price, weather, and event-date checks |
| `backend/src/carbon.ts` | CO₂e per traveler for every way to get there, from published emission factors |
| `backend/src/integrations` | Bright Data, Google Flights live pricing, public transit, official fares, weather, and geocoding |
| `backend/src` | Shared permissions, orchestration, authentication, persistence, and runtime model inference |
| `backend/photon` | Photon 2.0 iMessage transport |
| `backend/visa` | Sandbox authorization, simulated mandates, and payment execution |
| `backend/hyphenate` | Finance policy, approval controls, ledger, audit trail, reconciliation, and audit explanations |
| `backend/ml` | Trained model artifacts and training notebooks |
| `backend/scripts` | Setup, seed, discovery, evaluation, and scheduler entry points |
| `backend/.data` | Local SQLite books, auth, and event snapshots; never committed |

The chat concierge runs a bounded reasoning loop: it chooses a specialist tool, reads the result, and decides whether another step is needed. Its tools include event discovery, trip planning, current flight prices, historical price estimates, and venue heat. Tool calls run under separate permissions and enter the audit trail. The auditor also uses model reasoning over evidence. Routing scores, finance policy, payment controls, and ledger reconciliation use deterministic code, while scheduled jobs revisit prices, weather, and event changes. This is a hybrid agent system with specialist workers; the registered worker names do not mean every worker is an independent reasoning model.

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

To let S’mile act on its own, run the scheduler next to the app (or have a cron call `GET /api/scheduler/run` with `Authorization: Bearer $CRON_SECRET`):

```bash
npm run scheduler --prefix backend            # wakes every SCHEDULER_INTERVAL_MINUTES (default 5)
npm run scheduler --prefix backend -- --once  # one pass, then exit
```

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

- `tests/frontend`: user interaction and location-entry behavior.
- `tests/backend`: policy boundaries, deterministic seed data, geocoding validation, ledger balance, price-model parity, heat scoring, and emission factors and the low-carbon rule.
- `tests/agents`: least privilege, audited agent calls, scheduler jobs and notices, the @smile tool loop and its amount check, Photon event filtering, 40-case evaluation, and adversarial controls.
- `tests/system`: sign-in, role isolation, trip-token scope, approval, booking, and repository-structure checks.

## CI/CD

`.github/workflows/ci.yml` runs independent jobs for repository structure, backend, agents, frontend, and the complete HTTP workflow. Pull requests must pass every layer. A passing push to `main` produces a versioned delivery artifact containing the production Next.js build, Chrome extension, and backend runtime source.

No production deployment occurs without an explicitly configured hosting environment and credentials.

## Integration status

| Integration | Use |
|---|---|
| Anthropic | Public-page extraction, explanations, audit defense, and the @smile concierge that chooses its tools; amounts remain deterministic |
| Bright Data | Live logged-out event, route, fare, and stop pages |
| Hyphenate track | Our organizer finance implementation: evidence matching, exception routing, control totals, and close readiness; not a Hyphenate API integration |
| Photon 2.0 | Private one-to-one `@smile` iMessage conversations and short-lived route handoffs |
| TigerData | Time-series event snapshots for detecting event-date and venue changes |
| Neon | Independent private PostgreSQL storage adapter for venue-photo submissions and actual image bytes |
| Visa | Traveler-approved fare binding, category and expiry controls, replay protection, and signed sandbox authorization with capture disabled |
| Open-Meteo | Live forecast and ERA5 history for the venue heat map (no key) |
| OpenStreetMap | Map tiles and place search for `/map`; OSRM road routes, alternatives, maneuver progress, road distance, and drive time |
| U.S. EPA, CARB | Published emission factors for the CO₂e estimates (no key) |

## Private iMessage conversations

The Photon 2.0 worker accepts only one-to-one iMessage spaces. It responds only when a message explicitly mentions `@smile`, sends its reply to that same private conversation, and ignores group events. Every follow-up answer must include the mention as well. Exact-price approval links appear only in the requesting traveler's direct chat.

The trip result creates a short-lived QR for the project's dedicated Photon iMessage line. The prefilled message contains only an expiring claim code; the website never asks for the traveler's phone number or email address, and the browser never receives the Photon project key or trip token. After the traveler sends the message, `@smile` replies in that private conversation with an opaque, expiring `https://smilefromhereto.work/map` handoff.

Run the web API on the persistent Railway web service with `SMILE_DATA_DIR` pointing to its mounted volume. Chat transcripts, each sender's preferences, follow-up answers, event selections, and exact message results live in `chat.db` there. Vercel must proxy `/api` to that service; chat refuses to use an ephemeral serverless filesystem. Each direct Photon space is isolated as its own room. Multiple processes sharing the same database serialize each room with expiring, renewed locks. Separate machines with separate volumes are not a shared chat cluster.

Keep the Photon worker's cursor on its own persistent volume using `PHOTON_CURSOR_FILE` or `SMILE_DATA_DIR`. Set the same `PHOTON_PROJECT_ID` and `PHOTON_BRIDGE_SECRET` on the worker and web API, set the project-scoped `PHOTON_API_KEY` on both services, configure the dedicated E.164 address as `PHOTON_LINE_ADDRESS`, and set `SMILE_WEB_URL=https://smilefromhereto.work`. The worker forwards the original message ID; the bridge reuses the saved response for retries, and the planner stores its trip result with the books so a repeated message does not create another trip or mandate.

Automated tests exercise direct-space filtering, explicit-mention filtering, one-conversation claim codes, opaque map handoffs, restart recovery, concurrent delivery, replay conflicts, and remembered travel preferences without sending real iMessages. For live verification, create a trip, scan its QR code, send the prefilled `@smile open my route …` message, and tap the secure `/map` link in the reply. Confirm that the link opens the correct route and that a different sender cannot claim the same code before calling the deployment live-tested.

## Venue tours and photo contributions

LA Hacks opens the James West Alumni Center concept at `/tour`. Cal Hacks opens the Palace of Fine Arts concept at `/venue`. These are approximate visualizations, not verified current floor plans, event assignments, or accessible-navigation instructions. Other event cards link to `/tours/contribute` with the selected event prefilled instead of implying a tour is available.

The contribution form accepts one to six JPEG, PNG, or WebP photos, with a combined input limit of 3 MiB. `/api/tours/contributions` validates and decodes the images and removes embedded metadata. Photo storage has its own server-side configuration and does not affect TigerData event snapshots. `TOUR_CONTRIBUTION_STORAGE=sqlite` stores the submission and actual image bytes together as BLOBs in a private SQLite database under `SMILE_DATA_DIR` when local storage is selected.

For a separate Neon Free photo database, configure these server-only variables on the persistent Railway web service:

```text
TOUR_CONTRIBUTION_STORAGE=postgres
PHOTO_DATABASE_URL=<direct PostgreSQL URL from Neon Connect, with sslmode=verify-full>
PHOTO_DATABASE_MAX_BYTES=268435456
```

In Neon Connect, select the intended production branch, database, and role, and turn connection pooling off to obtain the direct PostgreSQL URL. Keep the provider's exact hostname and credentials, and require `sslmode=verify-full`. The backend uses a small PostgreSQL connection pool and verifies both the certificate chain and hostname using its trusted system roots. Leave `PHOTO_DATABASE_CA_PEM` and `PHOTO_DATABASE_CA_FILE` empty unless the provider supplies an official custom CA bundle. Do not use an HTTP dashboard URL or API key as the database connection string. [Neon's secure-connection documentation](https://neon.com/docs/connect/connect-securely) explains certificate verification. These credentials do not belong in frontend variables, source control, screenshots, or chat. Verify the hosted connection, migration hashes, private grants, and a new production upload before considering a deployment complete.

Photos live as PostgreSQL `BYTEA` in the private `smile_photos` schema. The adapter enables row-level security and revokes schema and table access from public and API roles. No public bucket, anonymous API key, or browser-side database client is needed. Set the photo payload quota to 256 MiB with `PHOTO_DATABASE_MAX_BYTES=268435456`, or lower it to leave more space for database overhead. Monitor the provider's actual database size and free-plan usage as well; the payload quota is not a guarantee that all database storage or compute stays within the plan. Free database compute can suspend when idle, so the first connection after inactivity may take longer.

Supabase remains an optional alternative. Set `TOUR_CONTRIBUTION_STORAGE=supabase`, use its exact Session pooler PostgreSQL connection string on port 5432, and place the official certificate from Database Settings → SSL Configuration in `PHOTO_DATABASE_CA_PEM` or `PHOTO_DATABASE_CA_FILE`. Keep the private `smile_photos` schema out of the Data API. Supabase mode caps photo payloads at 256 MiB, and `PHOTO_DATABASE_MAX_BYTES` can lower that limit.

When the selector is omitted, `PHOTO_DATABASE_URL` selects PostgreSQL, with Supabase hosts recognized automatically; without it, photos use SQLite. `TIGER_DATABASE_URL` remains dedicated to event history and does not redirect photo storage. Explicit legacy `TOUR_CONTRIBUTION_STORAGE=tigerdata` is still supported with that URL and `TIGER_DATABASE_CA_PEM` or `TIGER_DATABASE_CA_FILE`. Every configured photo database requires certificate and hostname verification, and a failed connection fails the upload rather than silently saving somewhere else. Never disable verification or automatically trust an unverified server certificate.

Legacy file-based submissions are imported without deleting their originals; incomplete legacy material stops the migration instead of losing a photo. Switching from SQLite to verified PostgreSQL imports existing image bytes and records transactionally, retaining receipt IDs and local originals. Conflicting records or an exceeded quota roll back the migration. After a rolling cutover, compare source and destination receipts and image hashes once the old SQLite-writing instance has stopped, then rerun initialization if late source uploads need copying.

The response confirms a durable submission reference, not a generated model. Material needs manual review and a separate modelling workflow before a tour can be published. Requests require explicit consent, pass an origin check, and are subject to shared storage, concurrency, and rate limits. There is no public image-download endpoint. Route `/api` to the persistent Railway service rather than an ephemeral Vercel filesystem.

The `/tour` experience is a native React and TypeScript client route bundled by Next.js, with its Three.js scene lifecycle contained inside the route. The LA Hacks model is a checked-in GLB; the Cal Hacks walkthrough generates its scene in code. Runtime scripts and model files are served locally rather than loaded from a third-party script CDN. The former `/3d-tour/index.html` address permanently redirects to `/tour` for existing bookmarks.

## Price prediction and heat map

Two planning aids in the trip pane: **a model produces evidence, plain code decides**.

**Live flight price + forecast.** For domestic interstate trips, the Pricing agent builds a new Google Flights search for the selected airport pair and travel date. A first request starts one asynchronous Bright Data collection and returns its snapshot ID; the trip pane keeps checking that same snapshot until a current USD fare is ready. It records the observed fare, provider, source link, and timestamp, alongside the p10 / p50 / p90 range from the trained models. If collection cannot start or its completed data has no verified fare, the agent can inspect the same public page and validate the extracted price against an exact quoted phrase. The chat concierge can invoke this worker and resume its pending search, and the scheduled price watcher revisits active trips. An unavailable source remains unavailable. No observation approves, books, or silently replaces a trip amount.

**Price by time of day.** Gradient-boosted quantile models predict a p10 / p50 / p90 range, and the trip pane charts the same trip at every hour of the day with your departure and the cheapest hour that still arrives on time.

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

## Agents, scheduler and @smile

Every agent acts through `runAgent` (`backend/src/agents/run.ts`): the caller must hold the capability that lets it ask (for example `price.estimate`), the agent must hold every capability its work needs, and the call is written to the hash-chained audit trail whether it succeeds, fails, or is refused. Discovery, heat, and pricing are registered agents, so `/api/events`, `/api/heat`, and `/api/price-estimate` go through the same checks.

| Agent | Can | Can’t |
|---|---|---|
| Discover | read public listings, save event snapshots | sign in, register, or RSVP |
| Heat | read public weather models | change a plan or a price |
| Pricing | read public Google Flights fares and the road network, run the trained models | approve, book, charge, or silently replace a price |
| Scheduler | wake agents, send notices | approve, charge, or change an amount |
| Concierge (@smile) | find events, plan a trip, estimate prices, check heat | charge, approve, request a mandate, or post to the ledger |

**Scheduler** (`backend/src/scheduler.ts`). Each job reads the books, does its network work without holding them, then writes evidence and notices in one short transaction.

| Job | Every | What it does |
|---|---|---|
| `reconcile` | 15 min | Re-runs the reimbursement backlog |
| `price_watch` | 6 h | Re-checks live Google Flights fares and trained forecasts for trips in the next 120 days; a notice when the observed fare moves 15% or more from its prior live observation (or the trip reference on the first check) |
| `weather_watch` | 3 h | Heat at the venue for trips in the next 3 days; a notice at NWS Caution or worse |
| `event_watch` | 12 h | Re-reads listings; when an event’s date or venue changed, updates it, records the change, and tells each traveler |

Notices are inbox items with one “Got it” button. They are sent once per topic and approve nothing. Staff can run any job from the Desk.

**@smile** (`backend/src/agents/concierge.ts`). When Claude is configured, each message that mentions @smile goes to a Claude tool-use loop that decides which of four strict tools to call: `find_events`, `plan_trip`, `estimate_prices`, `heat_at_venue`. Plans are only for the sender, with a ZIP and event link the sender gave. Approval links are issued by code and never pass through the model. Every dollar amount in the reply must appear in a tool result; otherwise the reply is replaced by one written in code. Without a key, the rule-based planner answers as before.

## Emissions

Environmental impact changes the recommendation, and every number shows how it was made.

- **CO₂e for every way to get there**: train, bus, carpool, driving alone, rideshare, and flight, per traveler. Emissions = published factor × distance. Car, bus, rail, and air factors are the [U.S. EPA GHG Emission Factors Hub 2025](https://www.epa.gov/climateleadership/ghg-emission-factors-hub), Table 10 (CO₂, CH₄, and N₂O combined with AR5 warming potentials). Rideshare uses [CARB’s Clean Miles Standard](https://ww2.arb.ca.gov/our-work/programs/clean-miles-standard) measured fleet average of 301 g CO₂ per passenger-mile, which counts the 38.5% of miles driven empty. Distance is the live road route (OSRM) or, when unavailable, the straight line × 1.2. Flights use the nearest airports plus the rides to them; the factors leave out contrails, so flights are a lower bound.
- **Best low-carbon route alongside the fastest**: each plan marks the recommended, lowest-carbon, and fastest options, and the trip pane lists every mode with its formula and source link.
- **Trains and buses preferred when reasonable** (rule R13): a train or bus replaces the cheapest pick when it costs at most $10 or 25% more, takes at most 30 minutes or 25% longer, is about as reliable, and emits less. Both travel times must be known. A traveler’s arrival deadline outranks R13.
- **Carpools**: nearby travelers to the same event are matched into one car (up to four), and the plan shows emissions per passenger against driving alone, including pickup detours.
- **Organizer totals**: the Desk shows CO₂e emitted by the chosen routes and avoided compared with every attendee driving alone, per event.
- Nothing is labeled low-carbon without its calculation and data source next to it.

## Safety boundaries

- Public, logged-out web data only.
- Human approval is required for the exact trip price.
- AI output cannot directly post or pay an amount.
- Agent capabilities are enforced in code, not prompts; every agent call is audited.
- The @smile concierge holds no money capabilities, and every dollar amount it writes must come from a tool result.
- Scheduler notices never change an amount or approve anything.
- Ledger entries must balance and carry evidence or rule references.
- Posted entries and hash-chained audit history are immutable.
- Secrets, local databases, build output, and dependency folders are ignored.
