/**
 * Coinbase x402 on Base Sepolia TESTNET — the Evidence agent pays per call for data it
 * needs, inside hard spend controls enforced by the CDP SDK (not by a prompt):
 *   ≤ $0.05 per payment · ≤ $1.00 per rolling 24h · Base Sepolia only.
 * Every purchase is booked to 5200 Data & Tools Expense, so the agent's own spending
 * shows up in the same books it keeps for everyone else.
 *
 * The SDKs are imported lazily so the app runs (and says "x402 not configured") without keys.
 */
const USDC_BASE_SEPOLIA = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
export const X402_NETWORK = "eip155:84532";

export function x402Configured(): boolean {
  return Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET);
}

export type X402Result =
  | { ok: true; status: number; body: unknown; priceUsd?: string; payer?: string }
  | { ok: false; reason: "not_configured" | "spend_control" | "http_error" | "network_error"; detail: string };

export async function payAndFetch(url: string): Promise<X402Result> {
  if (!x402Configured()) return { ok: false, reason: "not_configured", detail: "set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET" };
  const { CdpX402Client, SpendControlError } = await import("@coinbase/cdp-sdk/x402");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const client = new CdpX402Client({
    environment: "development",
    spendControls: {
      maxAmountPerPayment: { atomic: 50_000n, asset: USDC_BASE_SEPOLIA },
      maxCumulativeSpend: { atomic: 1_000_000n, asset: USDC_BASE_SEPOLIA },
      maxCumulativeSpendWindow: "24h",
      allowedNetworks: [X402_NETWORK],
    },
  });
  const fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, client);
  try {
    const res = await fetchWithPayment(url);
    if (!res.ok) return { ok: false, reason: "http_error", detail: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    const body = ct.includes("json") ? await res.json() : await res.text();
    const { evmAddress } = await client.getAddresses();
    return { ok: true, status: res.status, body, payer: evmAddress };
  } catch (e) {
    if (e instanceof SpendControlError) return { ok: false, reason: "spend_control", detail: String((e as { code?: string }).code ?? e.message) };
    return { ok: false, reason: "network_error", detail: (e as Error).message };
  }
}
