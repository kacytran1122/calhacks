const PARENT_ENDPOINT = "/api/map/ride-payments";
const ENDPOINT = `${PARENT_ENDPOINT}/trip`;
const MODES = new Set(["bus", "train", "taxi"]);
const usd = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

function contextFor(value) {
  if (!value || typeof value.onContinue !== "function" || !Array.isArray(value.legs) || value.legs.length > 40 || ["journeyId", "from", "to"].some((key) => typeof value[key] !== "string" || !value[key].trim())) throw new Error("This journey is missing the details needed for its summary.");
  const ids = new Set();
  const legs = value.legs.map((leg) => {
    if (!leg || !MODES.has(leg.mode) || ["legId", "service", "from", "to"].some((key) => typeof leg[key] !== "string" || !leg[key].trim()) || (leg.expectedReceiptId !== undefined && (typeof leg.expectedReceiptId !== "string" || !leg.expectedReceiptId.trim()))) throw new Error("A vehicle leg is missing the details needed for this summary.");
    const result = { legId: leg.legId.trim(), mode: leg.mode, service: leg.service.trim(), from: leg.from.trim(), to: leg.to.trim(), ...(leg.expectedReceiptId === undefined ? {} : { expectedReceiptId: leg.expectedReceiptId.trim() }) };
    if (ids.has(result.legId)) throw new Error("A vehicle leg appears more than once in this journey.");
    ids.add(result.legId);
    return result;
  });
  return { journeyId: value.journeyId.trim(), from: value.from.trim(), to: value.to.trim(), legs, hasPaymentAttempt: value.hasPaymentAttempt === true || legs.some((leg) => leg.expectedReceiptId), sessionLost: value.sessionLost === true, onContinue: value.onContinue, onDismiss: value.onDismiss };
}

function receiptFor(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !value.id || value.id.length > 200 || value.journeyId !== context.journeyId || value.from !== context.from || value.to !== context.to || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || value.currency !== "USD" || value.provenance !== "simulated" || value.captured !== false || value.provider !== "visa_simulation" || value.amountSource !== "owned_demo_receipts" || !Number.isSafeInteger(value.totalRecordedCents) || value.totalRecordedCents < 0 || !Array.isArray(value.legs) || value.legs.length !== context.legs.length) return null;
  const legs = [];
  const receiptIds = new Set();
  let total = 0;
  for (let index = 0; index < context.legs.length; index += 1) {
    const expected = context.legs[index];
    const leg = value.legs[index];
    if (!leg || ["legId", "mode", "service", "from", "to"].some((key) => leg[key] !== expected[key])) return null;
    if (leg.status === "demo_receipt_recorded") {
      if (typeof leg.receiptId !== "string" || !leg.receiptId || receiptIds.has(leg.receiptId) || !Number.isSafeInteger(leg.amountCents) || leg.amountCents <= 0 || leg.amountCents > 100000 || (expected.expectedReceiptId !== undefined && leg.receiptId !== expected.expectedReceiptId)) return null;
      receiptIds.add(leg.receiptId);
      total += leg.amountCents;
      legs.push(Object.freeze({ legId: leg.legId, mode: leg.mode, service: leg.service, from: leg.from, to: leg.to, status: leg.status, receiptId: leg.receiptId, amountCents: leg.amountCents }));
    } else if (leg.status === "no_payment_recorded" && leg.amountCents === null && leg.receiptId === undefined && expected.expectedReceiptId === undefined) {
      legs.push(Object.freeze({ legId: leg.legId, mode: leg.mode, service: leg.service, from: leg.from, to: leg.to, status: leg.status, amountCents: null }));
    } else return null;
  }
  if (total !== value.totalRecordedCents) return null;
  return Object.freeze({ id: value.id, journeyId: value.journeyId, from: value.from, to: value.to, createdAt: value.createdAt, currency: "USD", totalRecordedCents: total, legs: Object.freeze(legs), provenance: "simulated", captured: false, provider: "visa_simulation", amountSource: "owned_demo_receipts" });
}

export function mountTripReceipt() {
  const dialog = document.querySelector("#trip-receipt-dialog");
  if (!dialog) throw new Error("The trip receipt dialog is unavailable.");
  if (dialog.tripReceiptController) return dialog.tripReceiptController;
  const find = (id) => {
    const element = dialog.querySelector(`#trip-receipt-${id}`);
    if (!element) throw new Error("The trip receipt controls are unavailable.");
    return element;
  };
  const ui = { title: find("title"), journey: find("journey"), status: find("status"), content: find("content"), total: find("total"), empty: find("empty"), legs: find("legs"), missing: find("missing"), reference: find("reference"), created: find("created"), download: find("download"), done: find("done"), retry: find("retry"), dismiss: find("dismiss") };
  const attempts = new Map();
  const state = { context: null, receipt: null, record: null, phase: "idle", request: null, revision: 0, previousFocus: null, conflict: false };

  const message = (text, error = false) => { ui.status.textContent = text; ui.status.classList.toggle("error", error); };
  const update = () => {
    ui.content.hidden = !state.receipt;
    ui.dismiss.hidden = Boolean(state.receipt);
    ui.retry.hidden = state.phase !== "error" || state.record?.blocked || state.conflict;
  };
  const active = (revision) => revision === state.revision && state.context !== null;
  const lock = () => {
    state.record.blocked = true;
    state.phase = "error";
    message("The original receipt session is unavailable. Earlier demo records and their amounts cannot be confirmed, so this journey’s summary is locked to prevent an incomplete receipt. Return to the route to continue. No additional payment was made.", true);
    update();
  };
  const request = async (url, init = {}) => {
    const controller = new AbortController();
    state.request?.abort();
    state.request = controller;
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(typeof body?.error === "string" ? body.error : "The trip summary service could not complete this request.");
        error.status = response.status;
        error.code = typeof body?.code === "string" ? body.code : undefined;
        throw error;
      }
      if (!body || typeof body !== "object") throw new Error("The trip summary response could not be verified.");
      return body;
    } finally {
      window.clearTimeout(timer);
      if (state.request === controller) state.request = null;
    }
  };

  const show = (receipt, replayed = false) => {
    state.receipt = receipt;
    state.phase = "ready";
    ui.total.textContent = usd(receipt.totalRecordedCents);
    ui.empty.hidden = receipt.totalRecordedCents !== 0;
    ui.reference.textContent = receipt.id;
    ui.created.textContent = new Date(receipt.createdAt).toLocaleString();
    ui.legs.replaceChildren();
    for (const leg of receipt.legs) {
      const item = document.createElement("li");
      item.className = `trip-receipt-leg ${leg.status === "demo_receipt_recorded" ? "recorded" : "unrecorded"}`;
      const service = document.createElement("b");
      service.textContent = `${leg.service} · ${leg.mode}`;
      const journey = document.createElement("small");
      journey.textContent = `Planned: ${leg.from} → ${leg.to}`;
      const status = document.createElement("span");
      status.textContent = leg.status === "demo_receipt_recorded" ? `Demo receipt recorded · ${usd(leg.amountCents)}` : "No payment recorded";
      item.append(service, journey, status);
      if (leg.receiptId) { const reference = document.createElement("code"); reference.textContent = `Receipt ${leg.receiptId}`; item.append(reference); }
      ui.legs.append(item);
    }
    const missing = receipt.legs.filter((leg) => leg.status === "no_payment_recorded").length;
    ui.missing.textContent = missing ? `${missing} vehicle leg${missing === 1 ? " has" : "s have"} no payment recorded. The total includes recorded demo payments only; it does not represent the full journey fare.` : receipt.legs.length ? "The total includes recorded demo payments only. It is not an operator fare or proof of payment." : "This journey has no bus, train, or taxi demo payments to list.";
    message(replayed ? "Your saved trip summary is ready. No additional payment was made." : "Your trip summary is ready. No additional payment was made.");
    update();
    ui.download.focus();
  };

  const lookup = async (revision) => {
    const body = await request(ENDPOINT);
    if (!active(revision)) return null;
    if (!Array.isArray(body.receipts)) throw new Error("Saved trip summaries could not be verified.");
    const existing = body.receipts.find((receipt) => receipt?.journeyId === state.context.journeyId);
    if (!existing) return null;
    const receipt = receiptFor(existing, state.context);
    if (!receipt) throw new Error("The saved summary does not match this journey’s recorded details.");
    return receipt;
  };

  const generate = async () => {
    if (!state.context || state.conflict) return;
    if (state.record.blocked) { lock(); return; }
    const revision = state.revision;
    state.phase = "checking";
    message("Gathering this journey’s saved demo receipts…");
    update();
    try {
      if (state.record.attempted) {
        const saved = await lookup(revision);
        if (!active(revision)) return;
        if (saved) { show(saved, true); return; }
      }
      const protectedSession = state.record.attempted || state.record.protected;
      const owner = await request(`${PARENT_ENDPOINT}${protectedSession ? "?recover=1" : ""}`);
      if (!active(revision)) return;
      if (!Array.isArray(owner.receipts)) throw new Error("The journey’s saved payment records could not be verified.");
      for (const leg of state.context.legs) {
        if (leg.expectedReceiptId && !owner.receipts.some((receipt) => receipt?.id === leg.expectedReceiptId && receipt.legId === leg.legId && receipt.journeyId === state.context.journeyId)) throw new Error("A previously recorded demo receipt could not be recovered. An incomplete summary will not be generated.");
      }
      state.record.attempted = true;
      state.record.protected = true;
      state.record.allowContextChange = false;
      state.phase = "creating";
      message("Creating one summary from saved demo payments. No additional payment is being made.");
      update();
      try {
        const body = await request(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ journeyId: state.context.journeyId, from: state.context.from, to: state.context.to, legs: state.context.legs, completed: true }) });
        if (!active(revision)) return;
        if (typeof body.replayed !== "boolean") throw new Error("The trip summary response could not be verified.");
        const receipt = receiptFor(body.receipt, state.context);
        if (!receipt) throw new Error("The trip summary response could not be verified.");
        show(receipt, body.replayed);
      } catch (error) {
        if (!active(revision)) return;
        if (error.status === 401) throw error;
        if (error.status === 400 || error.code === "ride_demo_trip_unverifiable") {
          state.record.attempted = false;
          state.record.allowContextChange = true;
          throw error;
        }
        const saved = await lookup(revision);
        if (!active(revision)) return;
        if (saved) { show(saved, true); return; }
        throw error;
      }
    } catch (error) {
      if (!active(revision)) return;
      if (error.status === 401 && (state.record.attempted || state.record.protected)) { lock(); return; }
      state.phase = "error";
      message(error.name === "AbortError" ? "The trip summary could not be confirmed in time. Try again or return to the route." : error.message, true);
      update();
    }
  };

  const close = (done) => {
    if (!state.context || (done && !state.receipt)) return;
    const callback = done ? state.context.onContinue : state.context.onDismiss;
    const outcome = done ? { receipt: state.receipt } : { attempted: state.record.attempted, sessionLost: state.record.blocked };
    state.revision += 1;
    state.request?.abort();
    state.context = null;
    state.phase = "idle";
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    if (state.previousFocus instanceof HTMLElement && state.previousFocus.isConnected) state.previousFocus.focus();
    if (typeof callback === "function") callback(outcome);
  };
  ui.retry.addEventListener("click", () => { if (state.phase === "error") void generate(); });
  ui.dismiss.addEventListener("click", () => close(false));
  ui.done.addEventListener("click", () => close(true));
  ui.download.addEventListener("click", () => {
    if (!state.receipt) return;
    const receipt = state.receipt;
    const lines = ["S’mile consolidated trip demo receipt", "SIMULATION ONLY — NO FUNDS MOVED", "", `Summary reference: ${receipt.id}`, `Journey: ${receipt.journeyId}`, `Planned start: ${receipt.from}`, `Planned destination: ${receipt.to}`, `Created: ${receipt.createdAt}`, `Recorded demo total: ${usd(receipt.totalRecordedCents)} USD`, ""];
    if (receipt.totalRecordedCents === 0) lines.push("No simulated payments recorded. This is not the actual cost of the journey.", "");
    receipt.legs.forEach((leg, index) => {
      lines.push(`${index + 1}. ${leg.service} (${leg.mode})`, `Planned: ${leg.from} → ${leg.to}`, leg.status === "demo_receipt_recorded" ? `Demo receipt recorded: ${usd(leg.amountCents)} USD · Receipt ${leg.receiptId}` : "No payment recorded", "");
    });
    lines.push("The total sums saved demo receipts only. Missing records are not free or paid rides.", "This summary creates no additional payment. No real Visa API was used.", "No funds were charged, transferred, or paid to an operator.", "This is not an operator receipt, does not validate a ticket, and is not valid for reimbursement.", "Completion was confirmed by the traveler. GPS and operator proof were not collected.");
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `smile-trip-demo-receipt-${receipt.id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    message("Your trip demo receipt was downloaded. Keep this copy before closing the summary.");
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (state.receipt) message("Your trip summary is still here. Download a copy or choose Done.");
    else close(false);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dialog.dispatchEvent(new Event("cancel", { cancelable: true })); }
    if (event.key !== "Tab") return;
    const elements = [...dialog.querySelectorAll("button:not([disabled])")].filter((element) => !element.closest("[hidden]"));
    const first = elements[0];
    const last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ui.title)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  const controller = {
    isOpen: () => dialog.hasAttribute("open"),
    open: (input) => {
      if (dialog.hasAttribute("open")) return false;
      const context = contextFor(input);
      const signature = JSON.stringify({ from: context.from, to: context.to, legs: context.legs });
      let record = attempts.get(context.journeyId);
      if (!record) { record = { signature, attempted: false, blocked: false, protected: context.hasPaymentAttempt, allowContextChange: true }; attempts.set(context.journeyId, record); }
      if (record.signature !== signature && record.allowContextChange && !record.blocked) record.signature = signature;
      record.protected ||= context.hasPaymentAttempt;
      record.blocked ||= context.sessionLost;
      state.context = context;
      state.record = record;
      state.receipt = null;
      state.conflict = record.signature !== signature;
      state.phase = "checking";
      state.previousFocus = document.activeElement;
      state.revision += 1;
      ui.journey.textContent = `${context.from} → ${context.to}`;
      update();
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      ui.title.focus();
      if (state.conflict) { state.phase = "error"; message("This journey already has a summary attempt with different details. Return to the original route before trying again.", true); update(); }
      else void generate();
      return true;
    },
  };
  dialog.tripReceiptController = controller;
  return controller;
}
