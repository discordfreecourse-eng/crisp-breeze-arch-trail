#!/usr/bin/env node
/**
 * Nitro/Vercel bundles @electric-sql/pglite into _libs/*.mjs but does not
 * emit pglite.data / *.wasm next to it. vite preview of the production
 * build (no DATABASE_URL) then crashes on PGLite bootstrap. Copy the
 * sidecar files into known output dirs.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "node_modules/@electric-sql/pglite/dist");
const files = ["pglite.data", "pglite.wasm", "initdb.wasm"];

const targets = [];

function walk(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_libs" || entry.name === "chunks") targets.push(path);
      if (entry.name !== "node_modules") walk(path, depth + 1);
    }
  }
}

for (const base of [".vercel/output", ".output", "dist"]) {
  const abs = join(root, base);
  if (existsSync(abs)) walk(abs);
}

// Always include the known Vercel function lib dir if present.
const vercelLibs = join(root, ".vercel/output/functions/__server.func/_libs");
if (existsSync(dirname(vercelLibs))) {
  mkdirSync(vercelLibs, { recursive: true });
  targets.push(vercelLibs);
}

const unique = [...new Set(targets)];
if (unique.length === 0) {
  console.log("[pglite-assets] no output dirs yet — skip");
  process.exit(0);
}

for (const destDir of unique) {
  mkdirSync(destDir, { recursive: true });
  for (const name of files) {
    const from = join(srcDir, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(destDir, name));
  }
  console.log(`[pglite-assets] copied into ${destDir}`);
}
