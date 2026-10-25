const ENDPOINT = "/api/map/ride-payments";
const MODES = new Set(["bus", "train", "taxi"]);

function usd(cents) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function amountCents(value) {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const [dollars, fraction = ""] = text.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100000 ? cents : null;
}

function receiptFor(value, leg, expectedAmount) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const valid = typeof value.id === "string" && value.id.length > 0 && value.id.length < 200
    && value.legId === leg.legId && value.mode === leg.mode && value.service === leg.service
    && value.from === leg.from && value.to === leg.to
    && Number.isSafeInteger(value.amountCents) && value.amountCents > 0 && value.amountCents <= 100000
    && (expectedAmount === undefined || value.amountCents === expectedAmount)
    && value.currency === "USD" && typeof value.paidAt === "string" && Number.isFinite(Date.parse(value.paidAt))
    && value.provenance === "simulated" && value.captured === false
    && value.provider === "visa_simulation" && value.amountSource === "traveler_entered_demo";
  if (!valid) return null;
  return Object.freeze({ id: value.id, legId: value.legId, mode: value.mode, service: value.service, from: value.from, to: value.to, amountCents: value.amountCents, currency: "USD", paidAt: value.paidAt, provenance: "simulated", captured: false, provider: "visa_simulation", amountSource: "traveler_entered_demo" });
}

export function mountRideCheckout() {
  const dialog = document.querySelector("#ride-checkout-dialog");
  if (!dialog) throw new Error("The ride checkout dialog is unavailable.");
  if (dialog.rideCheckoutController) return dialog.rideCheckoutController;
  const find = (id) => {
    const element = dialog.querySelector(`#ride-checkout-${id}`);
    if (!element) throw new Error("The ride checkout controls are unavailable.");
    return element;
  };
  const ui = {
    title: find("title"), service: find("service"), journey: find("journey"), preview: find("preview"),
    form: find("form"), completed: find("completed"), completedLabel: find("completed-label"), amount: find("amount"), consent: find("consent"),
    pay: find("pay"), status: find("status"), retry: find("retry"), skip: find("skip"), dismiss: find("dismiss"), receipt: find("receipt"),
    receiptAmount: find("receipt-amount"), receiptService: find("receipt-service"), receiptFrom: find("receipt-from"), receiptTo: find("receipt-to"),
    receiptDate: find("receipt-date"), receiptId: find("receipt-id"), download: find("download"), continue: find("continue"),
  };
  const state = { leg: null, receipt: null, phase: "idle", lookupReady: false, attemptedAmount: null, request: null, previousFocus: null, revision: 0 };
  const attemptedLegAmounts = new Map();
  const blockedLegIds = new Set();
  const isBlocked = () => Boolean(state.leg && blockedLegIds.has(state.leg.legId));

  const message = (text, error = false) => {
    ui.status.textContent = text;
    ui.status.classList.toggle("error", error);
  };

  const update = () => {
    const busy = state.phase === "checking" || state.phase === "paying";
    const paid = Boolean(state.receipt);
    const blocked = isBlocked();
    ui.form.hidden = paid;
    ui.receipt.hidden = !paid;
    ui.skip.hidden = paid;
    ui.dismiss.hidden = paid;
    ui.dismiss.disabled = state.phase === "paying";
    ui.completed.disabled = busy;
    ui.consent.disabled = busy || blocked;
    ui.amount.disabled = busy || blocked;
    ui.amount.readOnly = state.attemptedAmount !== null;
    ui.amount.setAttribute("aria-invalid", String(Boolean(ui.amount.value.trim()) && amountCents(ui.amount.value) === null));
    ui.pay.disabled = busy || paid || blocked || !state.lookupReady || !ui.completed.checked || !ui.consent.checked || amountCents(ui.amount.value) === null;
    ui.pay.textContent = state.phase === "paying" ? "Creating demo receipt…" : "Pay with Visa (simulation)";
    ui.skip.disabled = busy || !ui.completed.checked;
    ui.skip.textContent = blocked ? "Continue without another payment attempt" : "Skip without payment and continue";
    ui.retry.hidden = state.lookupReady || paid || busy || blocked;
  };

  const lockCurrentLeg = () => {
    if (!state.leg) return;
    blockedLegIds.add(state.leg.legId);
    state.phase = "blocked";
    state.lookupReady = false;
    message("The receipt session changed while this ride’s demo record was being created. Its result cannot be confirmed, so another payment attempt for this ride is locked to avoid a duplicate. No real funds moved. Confirm your exit to continue, or return to the route.", true);
    update();
  };

  const request = async (init = {}) => {
    const controller = new AbortController();
    state.request?.abort();
    state.request = controller;
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const endpoint = init.method === "POST" || state.attemptedAmount === null ? ENDPOINT : `${ENDPOINT}?recover=1`;
      const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store", ...init, signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(typeof body?.error === "string" ? body.error : "The demo receipt service could not complete this request.");
        error.status = response.status;
        error.code = typeof body?.code === "string" ? body.code : undefined;
        throw error;
      }
      if (!body || typeof body !== "object") throw new Error("The demo receipt service returned an unreadable response.");
      return body;
    } finally {
      window.clearTimeout(timer);
      if (state.request === controller) state.request = null;
    }
  };

  const showReceipt = (receipt, replayed = false) => {
    state.receipt = receipt;
    state.phase = "paid";
    state.lookupReady = true;
    state.attemptedAmount = receipt.amountCents;
    attemptedLegAmounts.set(receipt.legId, receipt.amountCents);
    ui.amount.value = (receipt.amountCents / 100).toFixed(2);
    ui.receiptAmount.textContent = usd(receipt.amountCents);
    ui.receiptService.textContent = `${receipt.service} · ${receipt.mode}`;
    ui.receiptFrom.textContent = receipt.from;
    ui.receiptTo.textContent = receipt.to;
    ui.receiptDate.textContent = new Date(receipt.paidAt).toLocaleString();
    ui.receiptId.textContent = receipt.id;
    message(replayed ? "This ride already has a demo receipt. Its original amount is unchanged." : "Demo receipt created. No funds moved.");
    update();
    ui.download.focus();
  };

  const checkReceipts = async (afterError) => {
    if (isBlocked()) { lockCurrentLeg(); return; }
    const revision = state.revision;
    state.phase = "checking";
    state.lookupReady = false;
    message("Checking this browser’s saved demo receipts…");
    update();
    try {
      const body = await request();
      if (revision !== state.revision || !state.leg) return;
      if (!Array.isArray(body.receipts)) throw new Error("Saved demo receipts could not be verified.");
      const existing = body.receipts.find((item) => item?.legId === state.leg.legId);
      if (existing) {
        const receipt = receiptFor(existing, state.leg);
        if (!receipt) throw new Error("The saved receipt could not be verified. No new record was created.");
        showReceipt(receipt, true);
        return;
      }
      state.phase = "ready";
      state.lookupReady = true;
      message(afterError || "Confirm you have left the vehicle, then choose a demo amount or skip payment.", Boolean(afterError));
    } catch (error) {
      if (revision !== state.revision || !state.leg) return;
      if (error.status === 401 && state.attemptedAmount !== null) { lockCurrentLeg(); return; }
      state.phase = "error";
      message(error.name === "AbortError" ? "The receipt check timed out. Try again, or skip payment after confirming you have left the vehicle." : `${error.message} Check saved receipts again before retrying payment.`, true);
    }
    update();
  };

  const finish = () => {
    if (!state.leg || state.phase === "paying" || state.phase === "checking") return;
    if (!state.receipt && !ui.completed.checked) return;
    const onContinue = state.leg.onContinue;
    state.revision += 1;
    state.request?.abort();
    state.leg = null;
    state.phase = "idle";
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    if (state.previousFocus instanceof HTMLElement && state.previousFocus.isConnected) state.previousFocus.focus();
    onContinue();
  };

  const dismiss = () => {
    if (!state.leg || state.receipt || state.phase === "paying") return;
    const onDismiss = state.leg.onDismiss;
    state.revision += 1;
    state.request?.abort();
    state.leg = null;
    state.phase = "idle";
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    if (state.previousFocus instanceof HTMLElement && state.previousFocus.isConnected) state.previousFocus.focus();
    if (typeof onDismiss === "function") onDismiss();
  };

  ui.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (ui.pay.disabled || !state.leg || isBlocked()) return;
    const cents = state.attemptedAmount ?? amountCents(ui.amount.value);
    if (cents === null || !ui.completed.checked || !ui.consent.checked) return;
    const revision = state.revision;
    state.attemptedAmount = cents;
    attemptedLegAmounts.set(state.leg.legId, cents);
    state.phase = "paying";
    message("Creating a simulation record. No funds will move.");
    update();
    try {
      const body = await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legId: state.leg.legId, mode: state.leg.mode, service: state.leg.service, from: state.leg.from, to: state.leg.to, amountCents: cents, completed: true, consent: true }) });
      if (revision !== state.revision || !state.leg) return;
      if (typeof body.replayed !== "boolean") throw new Error("The demo receipt response could not be verified.");
      const receipt = receiptFor(body.receipt, state.leg, body.replayed ? undefined : cents);
      if (!receipt) throw new Error("The demo receipt response could not be verified.");
      showReceipt(receipt, body.replayed);
    } catch (error) {
      if (revision !== state.revision || !state.leg) return;
      if (error.status === 401) { lockCurrentLeg(); return; }
      await checkReceipts(error.name === "AbortError" ? "The response timed out and no receipt was found. Retry the same ride, or skip payment." : `${error.message} No verified receipt was found. Retrying uses the same ride and amount.`);
    }
  });

  ui.amount.addEventListener("input", update);
  ui.completed.addEventListener("change", update);
  ui.consent.addEventListener("change", update);
  ui.retry.addEventListener("click", () => { if (state.leg) void checkReceipts(); });
  ui.skip.addEventListener("click", finish);
  ui.dismiss.addEventListener("click", dismiss);
  ui.continue.addEventListener("click", finish);
  ui.download.addEventListener("click", () => {
    if (!state.receipt) return;
    const receipt = state.receipt;
    const text = [
      "S’mile demo receipt", "SIMULATION ONLY — NO FUNDS MOVED", "",
      `Reference: ${receipt.id}`, `Ride: ${receipt.legId}`, `Service: ${receipt.service}`, `Mode: ${receipt.mode}`,
      `Planned boarding point: ${receipt.from}`, `Planned destination: ${receipt.to}`, `Demo amount: ${usd(receipt.amountCents)} USD`, `Created: ${receipt.paidAt}`, "",
      "Provider: Visa simulation. No real Visa API was used.", "Amount source: traveler-entered demo amount. This is not a live fare.",
      "Captured: false. No funds were charged, transferred, or paid to an operator.",
      "Exit was confirmed by the traveler. GPS and operator proof were not collected.",
      "This is not an operator receipt and is not valid for reimbursement.",
      "This simulation does not buy or validate a ticket. Follow the operator’s actual payment rules.",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `smile-demo-receipt-${receipt.id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    message("Demo receipt downloaded. Keep this copy before continuing your trip.");
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (state.receipt) message("Your demo receipt is still here. Download a copy or choose Continue trip.");
    else if (state.phase === "paying") message("Please wait while this demo receipt is checked. No funds are moving.");
    else dismiss();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]')].filter((element) => !element.closest("[hidden]"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ui.title)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const controller = {
    isOpen: () => dialog.hasAttribute("open"),
    open: (leg) => {
      if (dialog.hasAttribute("open")) return false;
      if (!leg || !MODES.has(leg.mode) || typeof leg.onContinue !== "function" || ["legId", "service", "from", "to"].some((key) => typeof leg[key] !== "string" || !leg[key].trim())) throw new Error("This vehicle leg is missing the details needed for checkout.");
      state.leg = { ...leg, legId: leg.legId.trim(), service: leg.service.trim(), from: leg.from.trim(), to: leg.to.trim() };
      state.receipt = null;
      state.phase = "checking";
      state.lookupReady = false;
      state.attemptedAmount = attemptedLegAmounts.get(state.leg.legId) ?? null;
      state.revision += 1;
      state.previousFocus = document.activeElement;
      ui.title.textContent = `Have you left this ${leg.mode}?`;
      ui.completedLabel.textContent = `Yes, I have left this ${leg.mode}.`;
      ui.service.textContent = state.leg.service;
      ui.journey.textContent = `${state.leg.from} → ${state.leg.to}`;
      ui.preview.textContent = leg.preview
        ? "Route preview only. This is not a confirmed ride, and GPS proximity is not proof that you rode or left a vehicle."
        : "GPS proximity can suggest arrival, but it cannot prove you have left the vehicle. Confirm this yourself below.";
      ui.completed.checked = false;
      ui.consent.checked = false;
      ui.amount.value = state.attemptedAmount === null ? "" : (state.attemptedAmount / 100).toFixed(2);
      update();
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      ui.title.focus();
      if (isBlocked()) lockCurrentLeg();
      else void checkReceipts();
      return true;
    },
  };
  dialog.rideCheckoutController = controller;
  return controller;
}
