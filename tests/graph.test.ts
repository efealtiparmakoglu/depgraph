import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph, findCycles, limitDepth, markCycleEdges, computeLevels } from "../src/graph.ts";

function write(dir: string, rel: string, content: string) {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "depgraph-graph-"));
}

function npmTree(dir: string) {
  write(dir, "package.json", JSON.stringify({ name: "app", dependencies: { lib: "^1" }, devDependencies: { util: "^2" } }));
  write(dir, "packages/lib/package.json", JSON.stringify({ name: "lib", dependencies: { app: "^1" } }));
  write(dir, "packages/util/package.json", JSON.stringify({ name: "util" }));
}

test("buildGraph: npm internal edges by name, dev flag preserved", () => {
  const dir = scratch();
  try {
    npmTree(dir);
    const g = buildGraph(dir, { externals: false });
    assert.equal(g.nodes.size, 3); // app, lib, util
    const appToLib = g.edges.find((e) => e.from === "npm:app" && e.to === "npm:lib");
    assert.ok(appToLib, "app -> lib edge");
    assert.equal(appToLib.dev, false);
    const appToUtil = g.edges.find((e) => e.to === "npm:util");
    assert.ok(appToUtil, "app -> util edge exists via devDependency");
    assert.equal(appToUtil.dev, true, "dev dep edge is flagged dev");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGraph: externals flag adds gray stubs, off by default", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "solo", dependencies: { leftpad: "^1" } }));
    const plain = buildGraph(dir, { externals: false });
    assert.equal(plain.nodes.size, 1);
    assert.equal(plain.edges.length, 0);
    const ext = buildGraph(dir, { externals: true });
    assert.equal(ext.nodes.size, 2);
    assert.ok(ext.nodes.has("external:leftpad"));
    assert.equal(ext.nodes.get("external:leftpad")?.external, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGraph: go local replace links modules", () => {
  const dir = scratch();
  try {
    write(dir, "go.mod", `
module example.com/app

require example.com/lib v1.0.0

replace example.com/lib => ./lib
`);
    write(dir, "lib/go.mod", "module example.com/lib\n");
    const g = buildGraph(dir, { externals: false });
    assert.equal(g.nodes.size, 2);
    assert.ok(g.edges.some((e) => e.from === "go:example.com/app" && e.to === "go:example.com/lib"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildGraph: cargo path deps and same-scan crate names link", () => {
  const dir = scratch();
  try {
    write(dir, "Cargo.toml", `
[workspace]

[package]
name = "rocket-app"

[dependencies]
engine = { path = "crates/engine" }
math-kit = "2.0"
`);
    write(dir, "crates/engine/Cargo.toml", `
[package]
name = "engine"

[dependencies]
math-kit = "2.0"
`);
    const g = buildGraph(dir, { externals: false });
    // rocket-app -> engine (path), engine -> rocket-app? no: math-kit unresolved
    assert.deepEqual([...g.nodes.keys()].sort(), ["cargo:engine", "cargo:rocket-app"]);
    assert.ok(g.edges.some((e) => e.from === "cargo:rocket-app" && e.to === "cargo:engine"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cycles: SCC marks the loop and findCycles reports it", () => {
  const dir = scratch();
  try {
    npmTree(dir); // app -> lib -> app
    write(dir, "packages/standalone/package.json", JSON.stringify({ name: "standalone" }));
    const g = buildGraph(dir, { externals: false });
    markCycleEdges(g);
    const cycles = findCycles(g);
    assert.equal(cycles.length, 1);
    assert.deepEqual([...cycles[0]].sort(), ["npm:app", "npm:lib"]);
    const bridge = g.edges.find((e) => e.from === "npm:app" && e.to === "npm:lib");
    assert.equal(bridge?.cycle, true, "edge inside SCC marked as cycle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cycles: two separate loops do not mark a bridge between them", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "a", dependencies: { b: "1" } }));
    write(dir, "b/package.json", JSON.stringify({ name: "b", dependencies: { a: "1", c: "1" } }));
    write(dir, "c/package.json", JSON.stringify({ name: "c", dependencies: { d: "1" } }));
    write(dir, "d/package.json", JSON.stringify({ name: "d", dependencies: { c: "1" } }));
    const g = buildGraph(dir, { externals: false });
    markCycleEdges(g);
    const cToD = g.edges.find((e) => e.from === "npm:c" && e.to === "npm:d");
    assert.equal(cToD?.cycle, true, "c<->d loop edge marked");
    const bToC = g.edges.find((e) => e.from === "npm:b" && e.to === "npm:c");
    assert.equal(bToC?.cycle, false, "bridge between two loops is not a cycle edge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cycles: self dependency is reported", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "selfish", dependencies: { selfish: "1.0" } }));
    const g = buildGraph(dir, { externals: false });
    const cycles = findCycles(g);
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0], ["npm:selfish"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeLevels: roots are level 0, distances grow downward", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "top", dependencies: { mid: "1" } }));
    write(dir, "mid/package.json", JSON.stringify({ name: "mid", dependencies: { leaf: "1" } }));
    write(dir, "leaf/package.json", JSON.stringify({ name: "leaf" }));
    const g = buildGraph(dir, { externals: false });
    const levels = computeLevels(g);
    assert.equal(levels.get("npm:top"), 0);
    assert.equal(levels.get("npm:mid"), 1);
    assert.equal(levels.get("npm:leaf"), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("limitDepth: drops nodes beyond the limit, keeps roots", () => {
  const dir = scratch();
  try {
    write(dir, "package.json", JSON.stringify({ name: "top", dependencies: { mid: "1" } }));
    write(dir, "mid/package.json", JSON.stringify({ name: "mid", dependencies: { leaf: "1" } }));
    write(dir, "leaf/package.json", JSON.stringify({ name: "leaf" }));
    const g = buildGraph(dir, { externals: false });
    const limited = limitDepth(g, 1);
    assert.deepEqual([...limited.graph.nodes.keys()].sort(), ["npm:mid", "npm:top"]);
    assert.equal(limited.dropped, 1);
    assert.equal(limited.graph.edges.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
