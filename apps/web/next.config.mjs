import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** @type {import("next").NextConfig} */
const config = {
  transpilePackages: ["@gapdesk/core"],
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  // The repo is on TypeScript 7, which has no JS API for Next's built-in check; `pnpm typecheck` runs tsc on apps/web instead.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
};

export default config;
