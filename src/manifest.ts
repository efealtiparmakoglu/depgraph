import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import type { DepRef, Manifest } from "./types.ts";

const MANIFEST_FILES = new Set(["package.json", "go.mod", "Cargo.toml"]);
const SKIP_DIRS = new Set([
  "node_modules", "target", "vendor", ".git", ".hg", ".svn",
  ".venv", "venv", "dist", "build", "__pycache__", ".deps",
]);

/**
 * Recursively find package.json / go.mod / Cargo.toml under `root`,
 * skipping dependency trees and hidden directories. Deterministic order:
 * manifests are sorted by path.
 */
export function findManifests(root: string): Manifest[] {
  const out: Manifest[] = [];
  const seen = new Set<string>();
  const stack = [resolve(root)];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir: skip silently
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          stack.push(full);
        }
        continue;
      }
      if (!entry.isFile() || !MANIFEST_FILES.has(entry.name)) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      const m = parseManifest(full);
      if (m) out.push(m);
    }
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

export function parseManifest(file: string): Manifest | null {
  const abs = resolve(file);
  switch (basename(abs)) {
    case "package.json":
      return parseNpm(abs);
    case "go.mod":
      return parseGo(abs);
    case "Cargo.toml":
      return parseCargo(abs);
    default:
      return null;
  }
}

function readFile(file: string): string {
  return readFileSync(file, "utf8");
}

// --- npm -----------------------------------------------------------------

function parseNpm(file: string): Manifest | null {
  let pkg;
  try {
    pkg = JSON.parse(readFile(file));
  } catch {
    return null; // unparseable manifest: skip
  }
  if (typeof pkg !== "object" || pkg === null) return null;
  const deps: DepRef[] = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    deps.push({ name, dev: false });
  }
  for (const name of Object.keys(pkg.devDependencies ?? {})) {
    deps.push({ name, dev: true });
  }
  const name = typeof pkg.name === "string" && pkg.name !== ""
    ? pkg.name
    : basename(resolve(file, ".."));
  return { file, dir: resolve(file, ".."), format: "npm", name, deps };
}

// --- go ------------------------------------------------------------------

/**
 * Minimal go.mod reader: `module`, single and block `require`,
 * and local `replace old => ./path` directives.
 */
export function parseGoModText(text: string): {
  module: string | null;
  requires: DepRef[];
  replaces: Map<string, string>;
} {
  const module: { value: string | null } = { value: null };
  const requires: DepRef[] = [];
  const replaces = new Map<string, string>();
  const lines = text.split("\n");
  let inRequire = false;
  for (const raw of lines) {
    const line = stripGoComment(raw).trim();
    if (line === "") continue;
    if (inRequire) {
      if (line === ")") { inRequire = false; continue; }
      const req = parseRequireLine(line);
      if (req) requires.push(req);
      continue;
    }
    let m = /^module\s+(\S+)$/.exec(line);
    if (m) { module.value = m[1]; continue; }
    if (/^require\s+\($/.test(line)) { inRequire = true; continue; }
    m = /^require\s+(\S+)\s+v\S+/.exec(line);
    if (m) { requires.push({ name: m[1], dev: false }); continue; }
    m = /^replace\s+(\S+)\s*=>\s*(\S+)$/.exec(line);
    if (m) {
      const target = m[2];
      // versioned replacement (module => module v1.2.3) is remote; a bare
      // relative path means a local directory on disk.
      if (!/^v\d/.test(target) && !/^[a-z][a-z0-9-]*\.[a-z]/i.test(target)) {
        replaces.set(m[1], target);
      }
    }
  }
  return { module: module.value, requires, replaces };
}

function parseRequireLine(line: string): DepRef | null {
  const m = /^(\S+)\s+v\S+/.exec(line);
  return m ? { name: m[1], dev: false } : null;
}

function stripGoComment(line: string): string {
  const i = line.indexOf("//");
  return i === -1 ? line : line.slice(0, i);
}

function parseGo(file: string): Manifest | null {
  const parsed = parseGoModText(readFile(file));
  const dir = resolve(file, "..");
  if (parsed.module === null) return null;
  const deps: DepRef[] = parsed.requires.map((r) => {
    const local = parsed.replaces.get(r.name);
    return local !== undefined ? { ...r, localPath: local } : r;
  });
  return { file, dir, format: "go", name: parsed.module, deps };
}

// --- cargo ---------------------------------------------------------------

export interface CargoParsed {
  name: string | null;
  workspace: boolean;
  deps: DepRef[];
}

/** Minimal TOML subset reader for Cargo.toml manifests. */
export function parseCargoTomlText(text: string): CargoParsed {
  const result: CargoParsed = { name: null, workspace: false, deps: [] };
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sec = /^\[(.+?)\]\s*$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    if (section === "package") {
      const m = /^name\s*=\s*"([^"]+)"/.exec(line);
      if (m) result.name = m[1];
    } else if (section === "workspace") {
      result.workspace = true;
    } else if (section === "dependencies" || section === "dev-dependencies") {
      const dep = parseCargoDepLine(line, section === "dev-dependencies");
      if (dep) result.deps.push(dep);
    }
  }
  return result;
}

function parseCargoDepLine(line: string, dev: boolean): DepRef | null {
  // name = "1.2"  |  name = { path = "../x" }  |  name = { workspace = true }
  const inline = /^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}\s*$/.exec(line);
  if (inline) {
    const name = inline[1];
    const body = inline[2];
    const pathM = /path\s*=\s*"([^"]+)"/.exec(body);
    return { name, dev, localPath: pathM ? pathM[1] : undefined };
  }
  const plain = /^([A-Za-z0-9_-]+)\s*=\s*"/.exec(line);
  if (plain) return { name: plain[1], dev };
  return null;
}

function parseCargo(file: string): Manifest | null {
  const parsed = parseCargoTomlText(readFile(file));
  const dir = resolve(file, "..");
  const name = parsed.name ?? basename(dir);
  return { file, dir, format: "cargo", name, deps: parsed.deps };
}
