import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { signedVisaHeaders } from "../../backend/visa/visaAcceptance";

test("Visa Acceptance signs the exact request body and required headers", () => {
  const body = JSON.stringify({ orderInformation: { amountDetails: { totalAmount: "12.00", currency: "USD" } } });
  const date = "Sat, 24 Oct 2026 19:00:00 GMT";
  const secretKey = Buffer.from("sandbox-secret").toString("base64");
  const headers = signedVisaHeaders(body, date, { merchantId: "merchant", keyId: "key", secretKey });
  const digest = `SHA-256=${createHash("sha256").update(body).digest("base64")}`;
  const canonical = ["host: apitest.cybersource.com", `date: ${date}`, "request-target: post /pts/v2/payments/", `digest: ${digest}`, "v-c-merchant-id: merchant"].join("\n");
  const signature = createHmac("sha256", Buffer.from(secretKey, "base64")).update(canonical).digest("base64");
  assert.equal(headers.Digest, digest);
  assert.match(headers.Signature, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(headers["v-c-merchant-id"], "merchant");
});
