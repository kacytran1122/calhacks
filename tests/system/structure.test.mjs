import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expected = [".github", ".gitignore", "README.md", "backend", "frontend", "tests"];

test("repository root stays intentionally small", async () => {
  const actual = (await readdir(root)).filter((name) => name !== ".git" && name !== ".DS_Store").sort();
  assert.deepEqual(actual, expected.sort());
});
