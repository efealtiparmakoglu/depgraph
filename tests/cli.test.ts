import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSVG, escapeXml } from "../src/svg.ts";
import { computeLayout } from "../src/layout.ts";
import { buildGraph, computeLevels, markCycleEdges } from "../src/graph.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function write(dir: string, rel: string, content: string) {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "depgraph-svg-"));
}

function mixedTree(dir: string) {
  write(dir, "package.json", JSON.stringify({ name: "web-ui", dependencies: { "api-lib": "^1" } }));
  write(dir, "packages/api-lib/package.json", JSON.stringify({ name: "api-lib" }));
  write(dir, "go.mod", `
module example.com/worker
require example.com/worker/shared v0.0.0
replace example.com/worker/shared => ./shared
`);
  write(dir, "shared/go.mod", "module example.com/worker/shared\n");
}

test("renderSVG: deterministic, well-formed shell, legend and formats", () => {
  const dir = scratch();
  try {
    mixedTree(dir);
    const g = buildGraph(dir, { externals: false });
    const levels = computeLevels(g);
    const a = renderSVG(g, { title: "Demo" });
    const b = renderSVG(g, { title: "Demo" });
    assert.equal(a, b, "same input -> byte-identical output");
    assert.ok(a.startsWith("<svg xmlns="));
    assert.ok(a.endsWith("</svg>\n"));
    assert.ok(a.includes("npm"), "legend lists npm");
    assert.ok(a.includes("example.com/worker"), "go node rendered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderSVG: cycle edges get the red cycle class marker", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "a", dependencies: { b: "1" } }));
    write(dir, "b/package.json", JSON.stringify({ name: "b", dependencies: { a: "1" } }));
    const g = buildGraph(dir, { externals: false });
    markCycleEdges(g);
    const svg = renderSVG(g, { title: "Loop" });
    assert.ok(svg.includes("#c62828"), "red cycle color present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escapeXml handles all five XML entities", () => {
  assert.equal(escapeXml(`a<&>"'&b`), `a&lt;&amp;&gt;&quot;&apos;&amp;b`);
});

test("computeLayout: boxes stay inside the canvas", () => {
  const dir = scratch();
  try {
    mixedTree(dir);
    const g = buildGraph(dir, { externals: false });
    const levels = computeLevels(g);
    const lay = computeLayout(g, levels);
    for (const box of lay.boxes.values()) {
      assert.ok(box.x >= 0 && box.y >= 0, "non-negative origin");
      assert.ok(box.x + box.w <= lay.width, "right edge inside canvas");
      assert.ok(box.y + box.h <= lay.height, "bottom edge inside canvas");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI end-to-end -------------------------------------------------------

function runCli(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

test("CLI: writes SVG, reports counts on stderr, exit 0", () => {
  const dir = scratch();
  try {
    mixedTree(dir);
    const outSvg = join(dir, "out.svg");
    const res = runCli([".", "-o", outSvg, "--title", "Mixed repo"], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /4 nodes, 2 edges/);
    const svg = readFileSync(outSvg, "utf8");
    assert.ok(svg.includes("web-ui"));
    assert.ok(svg.includes("example.com/worker"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --cycles-only exits 1 and prints the loop", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "a", dependencies: { b: "1" } }));
    write(dir, "b/package.json", JSON.stringify({ name: "b", dependencies: { a: "1" } }));
    const res = runCli([".", "--cycles-only"], dir);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /cycle: a -> b -> a/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --cycles-only exits 0 on a clean graph", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "solo" }));
    const res = runCli([".", "--cycles-only"], dir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /no cycles/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exit 1 when no manifests exist", () => {
  const dir = scratch();
  try {
    const res = runCli(["."], dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no package\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: usage errors exit 2", () => {
  const cases: string[][] = [
    ["--nope"],
    ["--depth", "x"],
    ["--depth"],
    ["--format", "pypi"],
    ["a", "b"],
  ];
  for (const argv of cases) {
    const res = runCli(argv);
    assert.equal(res.status, 2, `expected exit 2 for ${JSON.stringify(argv)}`);
    assert.match(res.stderr, /depgraph:/);
  }
});

test("CLI: --depth 0 keeps only root nodes", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "top", dependencies: { deep: "1" } }));
    write(dir, "deep/package.json", JSON.stringify({ name: "deep" }));
    const outSvg = join(dir, "out.svg");
    const res = runCli([".", "-d", "0", "-o", "out.svg"], dir);
    assert.equal(res.status, 0, res.stderr);
    const svg = readFileSync(outSvg, "utf8");
    assert.ok(svg.includes("top"));
    assert.ok(!svg.includes(">deep<"), "deep node dropped at depth 0");
    assert.match(res.stderr, /1 dropped by depth/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --stdout prints SVG without touching files", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "solo" }));
    const res = runCli([".", "--stdout"], dir);
    assert.equal(res.status, 0);
    assert.ok(res.stdout.startsWith("<svg"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --help exits 0 with usage text", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /USAGE/);
});

test("CLI: --version exits 0", () => {
  const res = runCli(["--version"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /1\.0\.0/);
});

test("CLI: determinism across runs (byte-identical files)", () => {
  const dir = scratch();
  try {
    mixedTree(dir);
    const one = runCli([".", "--stdout", "--title", "T"], dir);
    const two = runCli([".", "--stdout", "--title", "T"], dir);
    assert.equal(one.stdout, two.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
