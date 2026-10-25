import { X509Certificate } from "node:crypto";
import fs from "node:fs";

export interface TigerDatabaseTrust {
  caPem?: string;
  caFile?: string;
}

export class TigerConnectionError extends Error {
  constructor() {
    super("Database connection settings require verified TLS and a valid trusted CA certificate when configured.");
    this.name = "TigerConnectionError";
  }
}

function certificateFile(file: string): string {
  if (!file || fs.statSync(file).size > 1024 * 1024) throw new Error("Invalid certificate file");
  return fs.readFileSync(file, "utf8");
}

function certificateBundle(value: string): string {
  const pem = value.replace(/\\n/g, "\n").trim();
  if (Buffer.byteLength(pem) > 1024 * 1024) throw new Error("Invalid certificate bundle");
  const certificates = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
  if (!certificates.length || certificates.length > 64) throw new Error("Invalid certificate bundle");
  for (const [certificate] of certificates) new X509Certificate(certificate);
  return pem;
}

export function tigerDatabasePgOptions(url: string, trust: TigerDatabaseTrust = { caPem: process.env.TIGER_DATABASE_CA_PEM, caFile: process.env.TIGER_DATABASE_CA_FILE }) {
  try {
    const connection = new URL(url);
    const mode = connection.searchParams.get("sslmode");
    const sslValue = connection.searchParams.get("ssl");
    const negotiation = connection.searchParams.get("sslnegotiation");
    if (!["postgres:", "postgresql:"].includes(connection.protocol) || (mode !== null && !["prefer", "require", "verify-ca", "verify-full"].includes(mode)) || (sslValue !== null && !["true", "1"].includes(sslValue)) || (negotiation !== null && negotiation !== "postgres" && negotiation !== "direct")) throw new Error("Invalid TLS settings");
    const ssl: { rejectUnauthorized: boolean; ca?: string; cert?: string; key?: string } = { rejectUnauthorized: true };
    const rootFile = connection.searchParams.get("sslrootcert");
    const customCa = rootFile ? certificateFile(rootFile) : trust.caPem?.trim() ? trust.caPem : trust.caFile?.trim() ? certificateFile(trust.caFile) : undefined;
    if (customCa) ssl.ca = certificateBundle(customCa);
    const certFile = connection.searchParams.get("sslcert");
    const keyFile = connection.searchParams.get("sslkey");
    if (certFile) ssl.cert = certificateFile(certFile);
    if (keyFile) ssl.key = certificateFile(keyFile);
    for (const parameter of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat", "sslnegotiation"]) connection.searchParams.delete(parameter);
    return { connectionString: connection.toString(), ssl, ...(negotiation ? { sslnegotiation: negotiation as "postgres" | "direct" } : {}), max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 };
  } catch {
    throw new TigerConnectionError();
  }
}
