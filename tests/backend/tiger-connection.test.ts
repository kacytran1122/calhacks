import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createSecureContext, rootCertificates, TLSSocket } from "node:tls";
import test from "node:test";
import { tigerDatabasePgOptions, TigerConnectionError } from "../../backend/src/tigerConnection";
import { tourContributionPgOptions } from "../../backend/src/tourContributions";

const { Client } = createRequire(new URL("../../backend/package.json", import.meta.url))("pg");

test("uses the shared verified database TLS configuration for photo uploads", () => {
  const trust = { caPem: rootCertificates[0]!.replace(/\n/g, "\\n") };
  const url = "postgresql://user:unused@database.example/test?sslmode=require&uselibpqcompat=true&application_name=smile";
  const shared = tigerDatabasePgOptions(url, trust);
  const photos = tourContributionPgOptions(url, trust);
  assert.deepEqual(photos, shared);
  for (const options of [photos, shared]) {
    const actual = new Client(options).connectionParameters.ssl;
    assert.equal(actual.rejectUnauthorized, true);
    assert.equal(actual.checkServerIdentity, undefined);
    assert.equal(actual.ca, rootCertificates[0]!.trim());
    assert.equal(new URL(options.connectionString).searchParams.has("sslmode"), false);
    assert.equal(new URL(options.connectionString).searchParams.has("uselibpqcompat"), false);
  }
});

test("photo uploads use their independent CA without accepting insecure environment defaults", () => {
  const previous = { ca: process.env.PHOTO_DATABASE_CA_PEM, file: process.env.PHOTO_DATABASE_CA_FILE, tiger: process.env.TIGER_DATABASE_CA_PEM, mode: process.env.PGSSLMODE };
  process.env.PHOTO_DATABASE_CA_PEM = rootCertificates[0]!;
  delete process.env.PHOTO_DATABASE_CA_FILE;
  process.env.TIGER_DATABASE_CA_PEM = "unrelated invalid TigerData certificate";
  process.env.PGSSLMODE = "no-verify";
  try {
    for (const options of [tourContributionPgOptions("postgresql://user:unused@database.example/test")]) {
      const actual = new Client(options).connectionParameters.ssl;
      assert.equal(actual.rejectUnauthorized, true);
      assert.equal(actual.ca, rootCertificates[0]!.trim());
      assert.equal(actual.checkServerIdentity, undefined);
    }
  } finally {
    for (const [key, value] of [["PHOTO_DATABASE_CA_PEM", previous.ca], ["PHOTO_DATABASE_CA_FILE", previous.file], ["TIGER_DATABASE_CA_PEM", previous.tiger], ["PGSSLMODE", previous.mode]]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});

test("rejects insecure or invalid shared settings with a generic error that omits secrets", () => {
  for (const query of ["sslmode=disable", "sslmode=no-verify", "ssl=false", "ssl=0", "sslnegotiation=invalid"]) {
    assert.throws(() => tigerDatabasePgOptions(`postgresql://private-user:private-password@database.example/test?${query}`), (error: unknown) => error instanceof TigerConnectionError && !/private-user|private-password|database\.example/.test(error.message));
  }
  assert.throws(() => tigerDatabasePgOptions("postgresql://user:unused@database.example/test", { caPem: "invalid" }), TigerConnectionError);
});

test("preserves the configured trust bundle for direct TLS negotiation instead of letting URL parsing replace it", () => {
  for (const optionsFor of [tourContributionPgOptions, tigerDatabasePgOptions]) {
    for (const negotiation of ["direct", "postgres"]) {
      const options = optionsFor(`postgresql://user:unused@database.example/test?sslnegotiation=${negotiation}&sslmode=require`, { caPem: rootCertificates[0]! });
      const actual = new Client(options).connectionParameters;
      assert.equal(actual.ssl.ca, rootCertificates[0]!.trim());
      assert.equal(actual.ssl.rejectUnauthorized, true);
      assert.equal(actual.ssl.checkServerIdentity, undefined);
      assert.equal(actual.sslnegotiation, negotiation);
      assert.equal(new URL(options.connectionString).searchParams.has("sslnegotiation"), false);
    }
  }
});

test("verifies a real PostgreSQL TLS handshake against the configured CA and rejects a wrong hostname", { timeout: 20_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smile-database-tls-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, "server-key.pem");
  const certFile = path.join(directory, "server-cert.pem");
  const configFile = path.join(directory, "openssl.cnf");
  fs.writeFileSync(configFile, "[req]\nprompt = no\ndistinguished_name = subject\nx509_extensions = server\n[subject]\nCN = localhost\n[server]\nsubjectAltName = DNS:localhost\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage = serverAuth\n", { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-config", configFile], { stdio: "pipe", timeout: 10_000 });
  const caPem = fs.readFileSync(certFile, "utf8");
  const secureContext = createSecureContext({ cert: caPem, key: fs.readFileSync(keyFile) });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(5_000, () => socket.destroy());
    socket.once("data", (request) => {
      if (request.byteLength !== 8 || request.readInt32BE(4) !== 80877103) return socket.destroy();
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, secureContext });
      sockets.add(secure);
      secure.on("close", () => sockets.delete(secure));
      secure.on("error", () => {});
      secure.once("data", () => secure.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])));
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const optionsFor of [tourContributionPgOptions, tigerDatabasePgOptions]) {
    const correct = new Client({ ...optionsFor(`postgresql://user:unused@localhost:${address.port}/test?sslmode=require&uselibpqcompat=true`, { caPem }), connectionTimeoutMillis: 2_000 });
    await correct.connect();
    assert.equal(correct.connection.stream.authorized, true);
    assert.equal(correct.connection.stream.getPeerCertificate().subject.CN, "localhost");
    await correct.end();
    const wrongHost = new Client({ ...optionsFor(`postgresql://user:unused@127.0.0.1:${address.port}/test?sslmode=verify-ca`, { caPem }), connectionTimeoutMillis: 2_000 });
    await assert.rejects(wrongHost.connect(), (error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_TLS_CERT_ALTNAME_INVALID");
    await wrongHost.end();
    const unknownCa = new Client({ ...optionsFor(`postgresql://user:unused@localhost:${address.port}/test`, { caPem: rootCertificates[0]! }), connectionTimeoutMillis: 2_000 });
    await assert.rejects(unknownCa.connect(), (error: unknown) => /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_UNTRUSTED/.test((error as NodeJS.ErrnoException).code ?? ""));
    await unknownCa.end();
  }
});
