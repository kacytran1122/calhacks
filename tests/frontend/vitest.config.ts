import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const testModules = path.resolve(here, "../node_modules");

export default {
  root: path.resolve(here, "../../frontend"),
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(here, "../../frontend") },
      { find: /^react$/, replacement: path.resolve(testModules, "react/index.js") },
      { find: /^react\/(.+)$/, replacement: path.resolve(testModules, "react/$1") },
      { find: /^react-dom$/, replacement: path.resolve(testModules, "react-dom/index.js") },
      { find: /^react-dom\/(.+)$/, replacement: path.resolve(testModules, "react-dom/$1") },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: [path.resolve(here, "setup.ts")],
    include: [path.resolve(here, "*.test.tsx")],
    restoreMocks: true,
  },
};
