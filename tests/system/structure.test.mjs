import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expected = [".github", ".gitignore", "README.md", "backend", "docs", "frontend", "tests"];

test("repository root stays intentionally small", async () => {
  const actual = (await readdir(root)).filter((name) => name !== ".git" && name !== ".DS_Store").sort();
  assert.deepEqual(actual, expected.sort());
});

const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".ts", ".tsx"]);
const absoluteUrl = /(?:https?|wss?|file):\/\/[^\s"'`<>]+/giu;
const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("0.0.0.0", "ipv4");
loopbackAddresses.addAddress("::", "ipv6");
loopbackAddresses.addAddress("::1", "ipv6");
loopbackAddresses.addAddress("::ffff:0.0.0.0", "ipv6");
loopbackAddresses.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function localHostname(value) {
  const dotted = value.toLowerCase().replace(/\.+$/u, "");
  const hostname = dotted.startsWith("[") && dotted.endsWith("]") ? dotted.slice(1, -1) : dotted;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  const family = isIP(hostname);
  return family === 4 ? loopbackAddresses.check(hostname, "ipv4") : family === 6 ? loopbackAddresses.check(hostname, "ipv6") : false;
}

function containsForbiddenUrl(source) {
  for (const [literal] of source.matchAll(absoluteUrl)) {
    try {
      const url = new URL(literal.replace(/[),.;]+$/u, ""));
      if (url.protocol === "file:" || localHostname(url.hostname)) return true;
    } catch {}
  }
  return false;
}

test("local URL guard recognizes normalized loopback aliases", () => {
  for (const value of [
    "http://localhost:3000",
    "https://localhost.",
    "wss://service.localhost./socket",
    "https://127.1",
    "https://2130706433",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "file:///private/build/output",
  ]) assert.equal(containsForbiddenUrl(value), true, value);
  assert.equal(containsForbiddenUrl("https://smilefromhereto.work/landing"), false);
});

async function authoredFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".data", ".next", "coverage", "node_modules"].includes(entry.name) || entry.name.endsWith(".map") || entry.name === "package-lock.json") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await authoredFiles(file));
    else if (textExtensions.has(path.extname(entry.name))) files.push(file);
  }
  return files;
}

test("deployable authored source never contains a local URL", async () => {
  const files = [path.join(root, "README.md"), ...await authoredFiles(path.join(root, "frontend")), ...await authoredFiles(path.join(root, "backend"))];
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (containsForbiddenUrl(source)) violations.push(path.relative(root, file));
  }
  assert.deepEqual(violations, [], `Local URLs are forbidden in deployable source: ${violations.join(", ")}`);
});

test("authored screens do not render generic arrow glyphs", async () => {
  const files = (await authoredFiles(path.join(root, "frontend"))).filter((file) => !file.endsWith("leaflet.js") && !file.endsWith("leaflet.css"));
  const genericArrow = /[→←↑↓↗↘↖↙➜➝➞➡⟶⟵]/u;
  const violations = [];
  for (const file of files) {
    if (genericArrow.test(await readFile(file, "utf8"))) violations.push(path.relative(root, file));
  }
  assert.deepEqual(violations, [], `Generic arrows are forbidden in authored screens: ${violations.join(", ")}`);
});

test("README keeps the requested plain voice and avoids dash or arrow glyphs", async () => {
  const source = await readFile(path.join(root, "README.md"), "utf8");
  assert.equal(/[—–→←↑↓↗↘↖↙➜➝➞➡⟶⟵]/u.test(source), false);
});
