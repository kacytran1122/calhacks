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

## Architecture

| Area | Responsibility |
|---|---|
| `frontend/app` | Landing page, event search, traveler planning, chat, and organizer desk |
| `frontend/extension` | Read-only Chrome extension for public event pages |
| `backend/src/agents` | Scout, Evidence, Route, Discover, Heat, Pricing, the @smile Concierge, and the team: the board agents message each other on (`board.ts`), the Claude loop every agent thinks with (`brain.ts`), and each agent's goal and tools (`team.ts`) |
| `backend/src/scheduler.ts` | Wakes the team on a timer: backlog, price, weather, and event-date checks become findings on the board |
| `backend/src/carbon.ts` | CO₂e per traveler for every way to get there, from published emission factors |
| `backend/src/integrations` | Bright Data, Google Flights live pricing, public transit, official fares, weather, and geocoding |
| `backend/src` | Shared permissions, orchestration, authentication, persistence, and runtime model inference |
| `backend/photon` | Photon 2.0 iMessage transport |
| `backend/visa` | Sandbox authorization, simulated mandates, and payment execution |
| `backend/hyphenate` | Finance policy, approval controls, ledger, audit trail, reconciliation, and audit explanations |
| `backend/ml` | Trained model artifacts and training notebooks |
| `backend/scripts` | Setup, seed, discovery, evaluation, and scheduler entry points |
| `backend/.data` | Local SQLite books, auth, and event snapshots; never committed |

S'mile is a multi-agent system. Eleven of its thirteen agents think with Claude: each runs its own bounded tool loop with its own goal and tools, and the agents coordinate by leaving each other notes on a shared team board. Findings flow toward the orchestrator, which decides what reaches a person and who else should look; the auditor and the reconciler argue decisions out between them. The scheduler (a clock) and payments (which moves money only on a person's approval) stay plain code by design. Prices, policy, payment controls, and ledger postings are computed by code, never by a model; agents decide what to do, not what anything costs. Without a Claude key, every agent falls back to its code, so S'mile behaves as it did before agents could think.

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
- `tests/agents`: least privilege, audited agent calls, scheduler jobs and notices, the @smile tool loop and its amount check, the team board (findings passed along in code, agents judging and coordinating with Claude, the auditor–reconciler exchange, holds, refused messages, chain limits, invented amounts), Photon event filtering, 40-case evaluation, and adversarial controls.
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
| Photon 2.0 | `@smile` group conversation and private trip-scoped approval links |
| TigerData | Time-series snapshots for event date and venue changes |
| Visa | Traveler-approved fare binding, category and expiry controls, replay protection, and signed sandbox authorization with capture disabled |
| Open-Meteo | Live forecast and ERA5 history for the venue heat map (no key) |
| OpenStreetMap | Map tiles for the heat map; OSRM road distance and drive time |
| U.S. EPA, CARB | Published emission factors for the CO₂e estimates (no key) |

## iMessage group chats

The Photon 2.0 worker responds only to an explicit `@smile` mention and sends its reply to the same conversation. Every follow-up answer must include the mention as well. Exact-price approval links go to the requesting traveler privately, never into the group reply.

Photon's shared iMessage lines are one-to-one. Group chats require a dedicated iMessage line assigned to this project's account, whether provisioned through sponsored access or the appropriate Photon plan. A connected event socket does not establish that a usable iMessage number exists. Do not purchase a line or change a subscription just to run the tests.

Run the web API on the persistent Railway web service with `SMILE_DATA_DIR` pointing to its mounted volume. Chat transcripts, each sender's preferences, follow-up answers, event selections, and exact message results live in `chat.db` there. Vercel must proxy `/api` to that service; chat refuses to use an ephemeral serverless filesystem. Multiple processes sharing the same database serialize each room with expiring, renewed locks. Separate machines with separate volumes are not a shared chat cluster.

Keep the Photon worker's cursor on its own persistent volume using `PHOTON_CURSOR_FILE` or `SMILE_DATA_DIR`. Set the same `PHOTON_PROJECT_ID` and `PHOTON_BRIDGE_SECRET` on the worker and web API, and point `SMILE_WEB_URL` at the web API's HTTPS origin. The worker forwards the original message ID; the bridge reuses the saved response for retries, and the planner stores its trip result with the books so a repeated message does not create another trip or mandate.

Automated tests exercise group routing, mention filtering, private approvals, restart recovery, concurrent delivery, replay conflicts, and remembered travel preferences without sending real iMessages. Live verification still requires adding the assigned dedicated agent number to an actual iMessage group, sending a message without the mention, then sending `@smile` and a follow-up from two group members. Confirm one reply to each mention in that group and no reply to ordinary conversation before calling the deployment live-tested.

## Venue tours and photo contributions

LA Hacks opens the James West Alumni Center concept at `/tour`. Cal Hacks opens the Palace of Fine Arts concept at `/venue`. These are approximate visualizations, not verified current floor plans, event assignments, or accessible-navigation instructions. Other event cards link to `/tours/contribute` with the selected event prefilled instead of implying a tour is available.

The contribution form accepts one to six JPEG, PNG, or WebP photos, with a combined input limit of 3 MiB. `/api/tours/contributions` validates and decodes the images, removes embedded metadata, and saves them privately on the persistent Railway volume under `SMILE_DATA_DIR`. The response confirms a submission reference, not a generated model. Material needs manual review and a separate modelling workflow before a tour can be published. Requests require explicit consent, pass an origin check, and are subject to storage and rate limits. This endpoint must not run on an ephemeral Vercel filesystem.

`npm run dev --prefix frontend` and `npm run build --prefix frontend` build the local Three.js viewer automatically. The LA Hacks model is a checked-in GLB; the Cal Hacks walkthrough generates its scene in code. Runtime scripts and model files are served locally rather than loaded from a third-party script CDN.

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

**Scheduler** (`backend/src/scheduler.ts`). Each job is a sensor: it reads the books, does its network work without holding them, records what it saw as evidence, posts what changed to the board for the agent who owns it, and then runs the board until the team is done.

| Job | Every | What it does |
|---|---|---|
| `reconcile` | 15 min | Hands the reimbursement backlog to the reconciler, whose decisions then go to the auditor |
| `price_watch` | 6 h | Re-checks live Google Flights fares and trained forecasts for trips in the next 120 days; a notice when the observed fare moves 15% or more from its prior live observation (or the trip reference on the first check) |
| `weather_watch` | 3 h | Heat at the venue for trips in the next 3 days; a notice at NWS Caution or worse |
| `event_watch` | 12 h | Re-reads listings; when an event’s date or venue changed, updates it, records the change, and tells each traveler |

Notices are inbox items with one “Got it” button. They are sent once per topic and approve nothing. Staff can run any job from the Desk.

### How the agents coordinate

Agents leave each other notes on the team board (`backend/src/agents/board.ts`): a finding ("the rideshare forecast rose 50%"), a task ("read this event page"), or the reply to a task. Each agent wakes for the notes addressed to it, thinks with Claude using only its own tools, and says what it did; that answer is kept on the note, and when the sender asked for an answer it goes back to them. The Desk's **Team board** shows every note, who handled it, and whether Claude or code did.

| Agent | Thinks about | Can message |
|---|---|---|
| Orchestrator | what reaches the traveler, the controller, or the group chat, and who else should look | route, evidence, policy, scout, pricing, concierge |
| Pricing | whether a price move matters (booked yet? how close is the event?), re-checking a live fare | orchestrator |
| Heat | who to warn and what to suggest for how they travel | orchestrator |
| Discover | confirming an event change before anyone is told, with scout's help | orchestrator, scout |
| Scout | what an event page itself says | discover, orchestrator |
| Route | whether the planned route still makes sense after a change | orchestrator, evidence |
| Evidence | its own fare searches when a plan has no verified fare | orchestrator, route |
| Policy | exceptions and over-cap prices, put to the controller with the rule and amounts | orchestrator |
| Reconciler | working the backlog; holding a payout for a person when something looks off; defending decisions | auditor, orchestrator |
| Auditor | which decisions to question, and whether the answer holds up | reconciler, orchestrator |
| Concierge (@smile) | chat replies (its own tool loop); posts team updates in the group chat a trip was planned in | orchestrator |
| Scheduler, Payments | nothing: a clock and a money mover, both code | the agents that own their findings |

A typical chain: the price watch sees a 50% rise → pricing judges it matters two days out → the orchestrator sends the traveler one notice and posts a heads-up in their group chat. Or: the reconciler decides a pass → the auditor challenges one decision → the reconciler defends it → the auditor isn't convinced and escalates → the orchestrator puts it in front of the controller.

The limits are code, not prompts. Who may message whom is fixed (`TALKS_TO` in `permissions.ts`) and checked on every post, which is audited. A chain stops after four hand-offs; a note being handled is claimed so no two wake-ups take it; each agent gets at most eight turns. Anything an agent writes for a person or another agent, including its final answer, may only repeat dollar amounts from its task or a tool result, so a figure can't be invented and passed along. Watchers think on Claude Haiku 5.5; the orchestrator, policy, reconciler, and auditor on Claude Opus 5.5. Set `SMILE_AGENTS=off` to keep every agent on code.

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
- Agents message each other only along fixed lines, every message is audited, and nothing an agent writes may carry a dollar amount that code didn't compute.
- An agent may make an outcome more cautious (hold a payout for a person, escalate), never less; questions it puts to people are notices that approve nothing.
- Ledger entries must balance and carry evidence or rule references.
- Posted entries and hash-chained audit history are immutable.
- Secrets, local databases, build output, and dependency folders are ignored.
