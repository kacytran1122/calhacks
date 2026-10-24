declare global {
  interface Window {
    __smileLens?: boolean;
  }
}

const SERVER = "http://127.0.0.1:3000";

function readHints() {
  const jsonLd: unknown[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      jsonLd.push(JSON.parse(s.textContent ?? ""));
    } catch {}
  });
  return { url: location.href, title: document.title, jsonLd };
}

const CSS = `
:host{all:initial}
.p{position:fixed;top:16px;right:16px;z-index:2147483647;width:320px;font:14px/1.45 system-ui,sans-serif;color:#2B1B3D;background:#FFF8EF;border-radius:20px;border-top:6px solid #FF6B5B;box-shadow:0 30px 60px -24px rgba(43,27,61,.45),0 4px 12px rgba(43,27,61,.12);padding:16px 18px}
.k{font:700 11px system-ui;letter-spacing:.1em;text-transform:uppercase;color:#C93A2C}
h1{font:800 22px/1.1 system-ui;margin:8px 0 6px;letter-spacing:-.02em}
.m{color:#7F6A5C;font-size:12.5px}
.row{display:flex;gap:8px;margin-top:10px}
input{flex:1;min-width:0;font:600 16px system-ui;padding:9px 12px;border:2px solid #2B1B3D;border-radius:99px;background:#fff;color:#2B1B3D}
button{border:0;border-radius:99px;padding:10px 14px;font:700 14px system-ui;background:#FF6B5B;color:#fff;cursor:pointer}
button:disabled{opacity:.55}
.x{position:absolute;top:10px;right:12px;background:none;color:#7F6A5C;padding:4px 8px;font-size:18px}
.r{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #F0E2D2;font-size:13px}
.r:last-child{border:0}
.err{color:#C93A2C;font-weight:600;margin-top:8px}
a{color:#C93A2C;font-weight:700}
.tag{font:800 10px system-ui;letter-spacing:.08em;padding:2px 6px;border-radius:99px;background:#E3F6EC;color:#14583F;margin-left:6px}
.tag.w{background:#FFF6D1;color:#7A5B00}`;

function mount() {
  const host = document.createElement("div");
  host.id = "smile-lens";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "closed" });
  const hints = readHints();
  const ldCount = hints.jsonLd.length;
  root.innerHTML = `<style>${CSS}</style>
    <div class="p" role="dialog" aria-label="S'mile Lens">
      <button class="x" aria-label="Close">×</button>
      <div class="k">S'mile Lens</div>
      <h1>Plan this page</h1>
      <div class="m">${ldCount ? `Event details found on this page.` : `No event markup here — S'mile will read the page itself.`} Reads public details only; never cookies or form fields.</div>
      <div class="row"><input id="zip" inputmode="numeric" maxlength="5" placeholder="Your ZIP" aria-label="Home ZIP"><button id="go">Plan</button></div>
      <div id="out"></div>
    </div>`;
  const $ = <T extends Element>(s: string) => root.querySelector(s) as T;
  const zip = $<HTMLInputElement>("#zip");
  const go = $<HTMLButtonElement>("#go");
  const out = $<HTMLDivElement>("#out");
  $<HTMLButtonElement>(".x").onclick = () => {
    host.remove();
    window.__smileLens = false;
  };
  chrome.storage.local.get("zip").then((v) => (zip.value = (v.zip as string) ?? ""));

  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  go.onclick = async () => {
    const z = zip.value.trim();
    if (!/^\d{5}$/.test(z)) {
      out.innerHTML = `<div class="err">Enter a 5-digit ZIP.</div>`;
      return;
    }
    await chrome.storage.local.set({ zip: z });
    go.disabled = true;
    go.textContent = "Collecting…";
    out.innerHTML = `<div class="m" style="margin-top:10px">Fetching the page, fares, weather and stops. Live web pages can take 2–40 s.</div>`;
    const res = (await chrome.runtime.sendMessage({ type: "plan", body: { zip: z, eventUrl: hints.url, hints } })) as { ok: boolean; json: any };
    go.disabled = false;
    go.textContent = "Plan";
    if (!res.ok) {
      out.innerHTML = `<div class="err">${esc(res.json?.error ?? "Planning failed")}</div>`;
      return;
    }
    const p = res.json;
    const page = (p.evidence as any[]).find((e) => e.kind === "event_page");
    const verified = page?.data?.verified;
    const pick = p.routes?.pick;
    out.innerHTML = `
      <div style="margin-top:10px">
        <div class="r"><span>${esc(p.event.name)}</span><span class="tag ${verified ? "" : "w"}">${verified ? "VERIFIED" : "UNVERIFIED"}</span></div>
        <div class="r"><span>Kickoff</span><b>${esc(new Date(p.event.startsAt).toLocaleString())}</b></div>
        ${pick ? `<div class="r"><span>Best: ${esc(pick.mode)}</span><b>${money(pick.costCents)} · ${Math.round(pick.pMiss * 100)}% miss</b></div>` : `<div class="err">No option under the policy cap.</div>`}
        <div class="r"><span>Distance</span><b>${esc(p.trip.distanceMiles)} mi</b></div>
      </div>
      <div class="m" style="margin-top:8px">Nothing is charged until you approve the exact amount.</div>
      <div style="margin-top:8px"><a href="${SERVER}/desk#approve=${encodeURIComponent(p.approvalToken)}&trip=${encodeURIComponent(p.trip.id)}" target="_blank" rel="noreferrer">Review &amp; approve in S'mile →</a></div>`;
  };
}

if (!window.__smileLens) {
  window.__smileLens = true;
  mount();
}

export {};
