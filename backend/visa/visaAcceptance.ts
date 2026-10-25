import { createHash, createHmac } from "node:crypto";
import type { Cents } from "../src/types";

const HOST = "apitest.cybersource.com";
const RESOURCE = "/pts/v2/payments/";

export function visaAcceptanceConfigured() {
  return Boolean(
    process.env.VA_MERCHANT_ID &&
    process.env.VA_MERCHANT_KEY_ID &&
    process.env.VA_MERCHANT_SECRET_KEY &&
    process.env.VA_TEST_CARD_NUMBER &&
    process.env.VA_TEST_CARD_EXPIRATION_MONTH &&
    process.env.VA_TEST_CARD_EXPIRATION_YEAR,
  );
}

export function signedVisaHeaders(body: string, date: string, credentials: { merchantId: string; keyId: string; secretKey: string }) {
  const digest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
  const signing = [`host: ${HOST}`, `date: ${date}`, `request-target: post ${RESOURCE}`, `digest: ${digest}`, `v-c-merchant-id: ${credentials.merchantId}`].join("\n");
  const signature = createHmac("sha256", Buffer.from(credentials.secretKey, "base64")).update(signing).digest("base64");
  return {
    Accept: "application/hal+json;charset=utf-8",
    "Content-Type": "application/json;charset=utf-8",
    Host: HOST,
    Date: date,
    Digest: digest,
    "v-c-merchant-id": credentials.merchantId,
    Signature: `keyid="${credentials.keyId}", algorithm="HmacSHA256", headers="host date request-target digest v-c-merchant-id", signature="${signature}"`,
  };
}

export type VisaAcceptanceResult =
  | { configured: false; ok: false; reason: "not_configured"; detail: string }
  | { configured: true; ok: true; id: string; status: string; authCode?: string; correlationId?: string }
  | { configured: true; ok: false; reason: "declined" | "network"; detail: string; id?: string; status?: string; correlationId?: string };

export async function authorizeVisaAcceptance(args: { amountCents: Cents; reference: string }): Promise<VisaAcceptanceResult> {
  if (!visaAcceptanceConfigured()) return { configured: false, ok: false, reason: "not_configured", detail: "Visa Acceptance sandbox credentials are not configured." };
  const body = JSON.stringify({
    clientReferenceInformation: { code: args.reference },
    processingInformation: { capture: false },
    paymentInformation: {
      card: {
        number: process.env.VA_TEST_CARD_NUMBER,
        expirationMonth: process.env.VA_TEST_CARD_EXPIRATION_MONTH,
        expirationYear: process.env.VA_TEST_CARD_EXPIRATION_YEAR,
        securityCode: process.env.VA_TEST_CARD_SECURITY_CODE,
      },
    },
    orderInformation: {
      amountDetails: { totalAmount: (args.amountCents / 100).toFixed(2), currency: "USD" },
      billTo: {
        firstName: "Smile",
        lastName: "Traveler",
        address1: "1 Market Street",
        locality: "San Francisco",
        administrativeArea: "CA",
        postalCode: "94105",
        country: "US",
        email: "sandbox@smilefromhereto.work",
      },
    },
  });
  const date = new Date().toUTCString();
  const headers = signedVisaHeaders(body, date, {
    merchantId: process.env.VA_MERCHANT_ID!,
    keyId: process.env.VA_MERCHANT_KEY_ID!,
    secretKey: process.env.VA_MERCHANT_SECRET_KEY!,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const response = await fetch(`https://${HOST}${RESOURCE}`, { method: "POST", headers, body, signal: ctrl.signal });
    const correlationId = response.headers.get("v-c-correlation-id") ?? undefined;
    const payload = (await response.json().catch(() => ({}))) as { id?: string; status?: string; processorInformation?: { approvalCode?: string }; message?: string; reason?: string };
    const approved = response.ok && ["AUTHORIZED", "AUTHORIZED_PENDING_REVIEW"].includes(payload.status ?? "");
    if (approved && payload.id) return { configured: true, ok: true, id: payload.id, status: payload.status!, authCode: payload.processorInformation?.approvalCode, correlationId };
    return { configured: true, ok: false, reason: "declined", detail: payload.message || payload.reason || `Visa Acceptance returned HTTP ${response.status}`, id: payload.id, status: payload.status, correlationId };
  } catch (error) {
    return { configured: true, ok: false, reason: "network", detail: (error as Error).name === "AbortError" ? "Visa Acceptance took longer than 12 seconds." : (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
