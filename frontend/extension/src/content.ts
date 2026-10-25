import { mlhEvents, pageEvents, type EventChoice } from "./events";

type RoutePlan = {
  event: EventChoice;
  originLabel: string;
  destinationLabel: string;
  fastestRouteId?: string;
  routes: {
    id: string;
    mode: "train" | "bus" | "drive";
    title: string;
    durationMinutes: number;
    durationText: string;
    distanceMiles?: number;
    sourceUrl: string;
    sourceLabel: string;
    liveStatus: string;
    steps: { instruction: string; detail: string | null }[];
  }[];
  messages: string[];
  generatedAt: string;
};

declare global {
  interface Window {
    __smileTripPlanner?: { open: (event?: EventChoice) => void };
  }
}

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const WEBSITE = "https://calhacks-beta.vercel.app";
const websiteLink = () => `<div class="website">Want to learn more about S’mile? <a href="${WEBSITE}" target="_blank" rel="noreferrer">Visit the website ↗</a></div>`;

function isMlhSchedule() {
  return /(^|\.)mlh\.(com|io)$/i.test(location.hostname) && /\/seasons\/[^/]+\/events/i.test(location.pathname);
}

function addMlhButtons(events: EventChoice[], open: (event?: EventChoice) => void) {
  const cards = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[itemtype="https://schema.org/Event"]'));
  cards.forEach((card, index) => {
    if (card.querySelector(".smile-plan-trip")) return;
    card.style.position = "relative";
    const button = document.createElement("button");
    button.className = "smile-plan-trip";
    button.type = "button";
    button.textContent = "Plan trip with S’mile";
    button.style.cssText = "position:absolute;right:14px;top:14px;z-index:30;border:0;border-radius:999px;padding:10px 14px;background:#2b173f;color:#fff;font:700 13px/1 system-ui,sans-serif;box-shadow:0 8px 22px rgba(43,23,63,.28);cursor:pointer";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open(events[index]);
    });
    card.appendChild(button);
  });
}

const CSS = `
:host{all:initial;color-scheme:light}*{box-sizing:border-box}
.shell{position:fixed;top:18px;right:18px;z-index:2147483647;width:min(390px,calc(100vw - 24px));max-height:calc(100vh - 36px);overflow:auto;font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#29163d;background:#fffaf2;border:1px solid #eadfce;border-radius:26px;box-shadow:0 30px 80px rgba(43,23,63,.24),0 6px 18px rgba(43,23,63,.12)}
.top{padding:18px 20px 15px;background:linear-gradient(135deg,#fff7d7,#ffe49a);border-bottom:1px solid #ead8a5;border-radius:25px 25px 0 0}.brand{font:900 16px/1 system-ui;color:#29163d;letter-spacing:-.02em}.brand span{color:#ef5f55}
h1{font:900 25px/1.08 system-ui;margin:9px 34px 6px 0;letter-spacing:-.04em}.sub{color:#705f76;font-size:12.5px}.close{position:absolute;right:12px;top:12px;width:34px;height:34px;border:0;border-radius:50%;background:rgba(255,255,255,.72);color:#29163d;font-size:22px;cursor:pointer}
.body{padding:18px 20px 20px}.label{display:block;margin:0 0 7px;font:800 11px/1 system-ui;letter-spacing:.08em;text-transform:uppercase;color:#6e5e73}select,input{width:100%;border:1.5px solid #d9ccbb;border-radius:14px;background:#fff;color:#29163d;padding:11px 12px;font:650 14px/1.25 system-ui;outline:none}select:focus,input:focus{border-color:#745095;box-shadow:0 0 0 3px rgba(116,80,149,.13)}
.field{margin-bottom:14px}.event{display:flex;gap:11px;align-items:center;margin:0 0 16px;padding:11px;border-radius:17px;background:#f4ecfb}.thumb{width:46px;height:46px;flex:0 0 46px;border-radius:12px;object-fit:contain;background:#fff}.event-name{font-weight:850}.event-meta{color:#755f7d;font-size:12px;margin-top:2px}
.consent{padding:13px;border-radius:16px;background:#fff4cf;border:1px solid #efd67b;color:#574726;font-size:12px;margin-bottom:10px}.consent b{display:block;color:#29163d;margin-bottom:3px}.primary,.secondary,.choice{width:100%;border:0;border-radius:14px;padding:12px 14px;font:800 14px/1 system-ui;cursor:pointer}.primary{background:#ef675b;color:#fff;box-shadow:0 7px 0 #321a45}.primary:active{transform:translateY(2px);box-shadow:0 5px 0 #321a45}.primary:disabled{opacity:.58;cursor:wait}.secondary{background:#29163d;color:#fff}.divider{display:flex;align-items:center;gap:10px;margin:13px 0;color:#9a8995;font-size:11px}.divider:before,.divider:after{content:"";height:1px;background:#e7ddd2;flex:1}
.row{display:flex;gap:8px}.row input{flex:1;min-width:0}.row button{width:auto;white-space:nowrap}.status{min-height:18px;margin:8px 1px 0;color:#5f4f68;font-size:12px}.status.ok{color:#176247}.status.err{color:#af342b;font-weight:700}.choices{display:grid;grid-template-columns:1fr 1fr;gap:8px}.choice{border:1.5px solid #d9ccbb;background:#fff;color:#29163d;text-align:left;line-height:1.25}.choice b{display:block;margin-bottom:3px}.choice span{font-weight:500;color:#7b697f;font-size:11px}.choice.on{border-color:#29163d;background:#f3e9fb;box-shadow:0 0 0 2px #29163d inset}.plan{margin-top:15px}
.error{margin-top:12px;padding:11px 12px;border-radius:13px;background:#fff0ed;color:#a52d25;font-weight:700}.loading{padding:18px 3px;text-align:center;color:#735f77}.spinner{width:26px;height:26px;margin:0 auto 10px;border:3px solid #eee2d6;border-top-color:#ef675b;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.summary{display:flex;gap:11px;align-items:center;padding:11px;border-radius:17px;background:#f5edfb;margin-bottom:12px}.summary img{width:54px;height:54px;flex:0 0 54px;border-radius:13px;object-fit:cover;background:#fff}.summary-copy{min-width:0}.summary b{display:block}.summary span{display:block;font-size:12px;color:#705e77;margin-top:2px}.agent-note{margin:0 0 12px;padding:11px 12px;border-radius:15px;background:#fff4cf;border:1px solid #efd67b;color:#554524;font-size:12px}.agent-note b{display:block;color:#29163d;margin-bottom:2px}.route{border:1.5px solid #ddd0c2;border-radius:17px;background:#fff;margin-top:10px;overflow:hidden}.route.fast{border-color:#ef675b;box-shadow:0 0 0 2px rgba(239,103,91,.13)}.route-head{padding:13px 14px}.route-line{display:flex;gap:10px;align-items:flex-start}.mode{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#2b173f;color:#fff;font-size:16px;flex:0 0 auto}.route-title{font-weight:850;line-height:1.25}.time{font:900 17px/1 system-ui;margin-left:auto;white-space:nowrap}.badge{display:inline-block;border-radius:999px;padding:3px 7px;background:#ffe2dd;color:#9d2d25;font:850 9px/1 system-ui;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}.route-meta{margin:6px 0 0 44px;color:#756479;font-size:11px}.steps{border-top:1px solid #eee4d9;padding:4px 14px 12px}.step{display:grid;grid-template-columns:22px 1fr;gap:8px;padding-top:11px}.num{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:#f1e7f7;color:#5e3e77;font:800 10px/1 system-ui}.step b{display:block;font-size:12.5px;line-height:1.45}.step small{display:block;color:#7c697d;margin-top:2px}.source{display:inline-block;margin:11px 0 0;color:#9a3b34;font-weight:750;font-size:11px;text-decoration:none}.note{margin-top:11px;color:#856f7e;font-size:11px}.again{margin-top:12px;background:#f1e8f7;color:#29163d;box-shadow:none}.website{margin-top:17px;padding-top:14px;border-top:1px solid #eadfce;text-align:center;color:#7b697f;font-size:11.5px}.website a{color:#5e3e77;font-weight:800;text-decoration:none}.website a:hover{text-decoration:underline}
@media(max-width:520px){.shell{top:8px;right:8px;width:calc(100vw - 16px);max-height:calc(100vh - 16px);border-radius:21px}.top{border-radius:20px 20px 0 0}.body{padding:15px}.choices{grid-template-columns:1fr}.row{flex-direction:column}.row button{width:100%}}
`;

function createPlanner(events: EventChoice[]) {
  let host: HTMLDivElement | undefined;
  let root: ShadowRoot | undefined;
  let currentCoordinates: { lat: number; lon: number } | undefined;
  let includeSelfDrive: boolean | undefined;
  let selected = events[0] ?? pageEvents()[0]!;
  const selectedIndex = () => Math.max(0, events.findIndex((event) => event.url === selected.url && event.name === selected.name));
  const eventOptions = () => events.length > 1 ? `<div class="field"><label class="label" for="event">Choose an MLH event</label><select id="event">${events.map((event, index) => `<option value="${index}" ${index === selectedIndex() ? "selected" : ""}>${esc(event.name)} · ${esc(event.location)}</option>`).join("")}</select></div>` : "";
  const eventCard = () => `<div class="event"><img class="thumb" src="${esc(selected.imageUrl || new URL("/favicon.ico", selected.url).href)}" alt="${esc(`${selected.name} artwork`)}"><div><div class="event-name">${esc(selected.name)}</div><div class="event-meta">${esc(selected.startsAt ? `${new Date(selected.startsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ` : "")}${esc(selected.location || "Event location unavailable")}</div></div></div>`;

  function renderForm() {
    if (!root) return;
    const destinationLabel = selected.location ? "Event destination · detected from this hackathon" : "Event destination";
    root.innerHTML = `<style>${CSS}</style><section class="shell" role="dialog" aria-label="S’mile trip planner"><button class="close" aria-label="Close">×</button><header class="top"><div class="brand">s’<span>☺</span>mile</div><h1>Let’s get you there.</h1><div class="sub">The fastest route first. Clear alternatives after it.</div></header><main class="body">${eventOptions()}<div id="eventCard">${eventCard()}</div><div class="field"><label class="label" for="destination">${destinationLabel}</label><input id="destination" value="${esc(selected.location)}" placeholder="Venue, city, state or country"></div><div class="consent"><b>Use your location only to build this route?</b>Your precise location and this public event’s details are sent securely to S’mile’s routing service. Precise coordinates are used for this request and are not saved by the extension.</div><button id="geo" class="secondary">Allow &amp; use my current location</button><div class="divider">or enter a starting point</div><div class="row"><input id="origin" autocomplete="postal-code" placeholder="ZIP, city or address"><button id="typed" class="secondary">Use this</button></div><div id="locationStatus" class="status">Choose one option before planning.</div><div class="field" style="margin-top:17px"><span class="label">Will you self-drive?</span><div class="choices"><button class="choice" id="driveYes"><b>Yes, include driving</b><span>Compare a road route too</span></button><button class="choice" id="driveNo"><b>No self-drive</b><span>Show public transit only</span></button></div></div><button id="plan" class="primary plan">Find my fastest route →</button><div id="output"></div>${websiteLink()}</main></section>`;
    wireForm();
  }

  function setLocationStatus(message: string, kind = "") {
    const element = root?.querySelector<HTMLDivElement>("#locationStatus");
    if (!element) return;
    element.textContent = message;
    element.className = `status ${kind}`;
  }

  function wireForm() {
    if (!root || !host) return;
    const query = <T extends Element>(selector: string) => root!.querySelector(selector) as T;
    query<HTMLButtonElement>(".close").onclick = () => host!.remove();
    const eventSelect = root.querySelector<HTMLSelectElement>("#event");
    if (eventSelect) eventSelect.onchange = () => {
      selected = events[Number(eventSelect.value)] ?? selected;
      currentCoordinates = undefined;
      renderForm();
    };
    const originInput = query<HTMLInputElement>("#origin");
    chrome.storage.local.get(["originText", "includeSelfDrive"]).then((stored) => {
      originInput.value = typeof stored.originText === "string" ? stored.originText : "";
      if (typeof stored.includeSelfDrive === "boolean") {
        includeSelfDrive = stored.includeSelfDrive;
        query<HTMLButtonElement>(includeSelfDrive ? "#driveYes" : "#driveNo").classList.add("on");
      }
    });
    query<HTMLButtonElement>("#geo").onclick = () => {
      setLocationStatus("Waiting for Chrome’s location permission…");
      navigator.geolocation.getCurrentPosition((position) => {
        currentCoordinates = { lat: position.coords.latitude, lon: position.coords.longitude };
        setLocationStatus(`Current location ready · accuracy about ${Math.round(position.coords.accuracy)} m`, "ok");
      }, (error) => {
        currentCoordinates = undefined;
        const message = error.code === error.PERMISSION_DENIED ? "Location wasn’t allowed. Enter a ZIP, city or address instead." : "We couldn’t read your location. Enter a ZIP, city or address instead.";
        setLocationStatus(message, "err");
      }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
    };
    query<HTMLButtonElement>("#typed").onclick = async () => {
      const value = originInput.value.trim();
      if (value.length < 2) return setLocationStatus("Enter a ZIP code, city or address.", "err");
      currentCoordinates = undefined;
      await chrome.storage.local.set({ originText: value });
      setLocationStatus(`Starting from ${value}.`, "ok");
    };
    const chooseDrive = async (value: boolean) => {
      includeSelfDrive = value;
      query<HTMLButtonElement>("#driveYes").classList.toggle("on", value);
      query<HTMLButtonElement>("#driveNo").classList.toggle("on", !value);
      await chrome.storage.local.set({ includeSelfDrive: value });
    };
    query<HTMLButtonElement>("#driveYes").onclick = () => void chooseDrive(true);
    query<HTMLButtonElement>("#driveNo").onclick = () => void chooseDrive(false);
    query<HTMLButtonElement>("#plan").onclick = async () => {
      const originText = originInput.value.trim();
      const destination = query<HTMLInputElement>("#destination").value.trim();
      const output = query<HTMLDivElement>("#output");
      if (!currentCoordinates && originText.length < 2) return setLocationStatus("Choose current location or enter your starting point.", "err");
      if (includeSelfDrive === undefined) {
        output.innerHTML = `<div class="error">Choose whether to include self-driving.</div>`;
        return;
      }
      if (destination.length < 2) {
        output.innerHTML = `<div class="error">Add the event’s venue or city so S’mile knows where to route you.</div>`;
        return;
      }
      selected = { ...selected, location: destination };
      output.innerHTML = `<div class="loading"><div class="spinner"></div>Checking live routes to ${esc(selected.name)}…</div>`;
      const planButton = query<HTMLButtonElement>("#plan");
      planButton.disabled = true;
      const response = await chrome.runtime.sendMessage({ type: "route", body: { originText: originText || undefined, originCoordinates: currentCoordinates, includeSelfDrive, event: selected } }) as { ok: boolean; json: RoutePlan & { error?: string } };
      planButton.disabled = false;
      if (!response.ok) {
        output.innerHTML = `<div class="error">${esc(response.json?.error || "Route planning failed. Please try again.")}</div>`;
        return;
      }
      renderResults(response.json);
    };
  }

  function renderResults(plan: RoutePlan) {
    if (!root) return;
    const shell = root.querySelector<HTMLElement>(".shell");
    const icon = (mode: string) => mode === "drive" ? "⌁" : mode === "train" ? "▰" : "▣";
    const routes = plan.routes.map((route) => {
      const fastest = route.id === plan.fastestRouteId;
      return `<article class="route ${fastest ? "fast" : ""}"><div class="route-head">${fastest ? `<span class="badge">Fastest route</span>` : `<span class="badge" style="background:#eee7f3;color:#5b416e">Alternative</span>`}<div class="route-line"><div class="mode">${icon(route.mode)}</div><div class="route-title">${esc(route.title)}</div><div class="time">${esc(route.durationText)}</div></div><div class="route-meta">${esc(route.mode === "drive" && route.distanceMiles ? `${route.distanceMiles} miles · ` : "")}${esc(route.sourceLabel)}</div></div><div class="steps">${route.steps.map((step, index) => `<div class="step"><span class="num">${index + 1}</span><div><b>${esc(step.instruction)}</b>${step.detail ? `<small>${esc(step.detail)}</small>` : ""}</div></div>`).join("")}<a class="source" href="${esc(route.sourceUrl)}" target="_blank" rel="noreferrer">Open live source ↗</a></div></article>`;
    }).join("");
    const eventImage = plan.event.imageUrl || new URL("/favicon.ico", plan.event.url).href;
    root.querySelector<HTMLElement>(".body")!.innerHTML = `<div class="summary"><img src="${esc(eventImage)}" alt="${esc(`${plan.event.name} artwork`)}"><div class="summary-copy"><b>${esc(plan.event.name)}</b><span>${esc(plan.originLabel)} → ${esc(plan.destinationLabel)}</span></div></div>${routes ? `<div class="agent-note"><b>Your S’mile route agent mapped the handoffs.</b>Follow the street, stop, line, direction, and transfer details below. The fastest live option is first, with practical backups after it.</div>` : ""}${routes || `<div class="error">No route is available right now. ${esc(plan.messages.join(" "))}</div>`}${plan.messages.length && routes ? `<div class="note">${esc(plan.messages.join(" "))}</div>` : ""}<button id="again" class="primary again">Change trip details</button>${websiteLink()}`;
    if (shell) shell.scrollTop = 0;
    root.querySelector<HTMLButtonElement>("#again")!.onclick = renderForm;
  }

  function open(event?: EventChoice) {
    if (event) selected = event;
    if (host?.isConnected) {
      renderForm();
      return;
    }
    host = document.createElement("div");
    host.id = "smile-trip-planner";
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "open" });
    renderForm();
  }

  return { open };
}

if (!window.__smileTripPlanner) {
  const events = isMlhSchedule() ? mlhEvents() : pageEvents();
  const planner = createPlanner(events);
  window.__smileTripPlanner = planner;
  chrome.runtime.onMessage.addListener((message: { type?: string }) => {
    if (message.type === "open") planner.open();
  });
  if (isMlhSchedule()) addMlhButtons(events, planner.open);
  else planner.open();
}

export {};
