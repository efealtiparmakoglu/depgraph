import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findManifests, parseGoModText, parseCargoTomlText } from "../src/manifest.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "depgraph-manifest-"));
}

test("parseGoModText: module, require block, local replace", () => {
  const parsed = parseGoModText(`
module example.com/app

go 1.22

require (
    example.com/lib v1.2.3
    github.com/remote v0.1.0 // indirect
)

require example.com/solo v0.0.1

replace example.com/lib => ./lib
`);
  assert.equal(parsed.module, "example.com/app");
  assert.deepEqual(
    parsed.requires.map((r) => r.name),
    ["example.com/lib", "github.com/remote", "example.com/solo"],
  );
  assert.equal(parsed.replaces.get("example.com/lib"), "./lib");
  assert.equal(parsed.replaces.size, 1, "versioned replace must not count as local");
});

test("parseGoModText: remote replace is ignored as local path", () => {
  const parsed = parseGoModText(`
module example.com/app
replace github.com/old => github.com/new v1.0.0
`);
  assert.equal(parsed.replaces.size, 0);
});

test("parseCargoTomlText: plain, inline table and dev deps", () => {
  const parsed = parseCargoTomlText(`
[package]
name = "app-core"
version = "0.1.0"

[dependencies]
serde = "1.0"
utils = { path = "../utils" }
ws = { version = "1.0", workspace = true }

[dev-dependencies]
criterion = "0.5"
`);
  assert.equal(parsed.name, "app-core");
  assert.equal(parsed.workspace, false);
  assert.deepEqual(
    parsed.deps.map((d) => [d.name, d.dev, d.localPath]),
    [
      ["serde", false, undefined],
      ["utils", false, "../utils"],
      ["ws", false, undefined],
      ["criterion", true, undefined],
    ],
  );
});

test("parseCargoTomlText: workspace section is flagged", () => {
  const parsed = parseCargoTomlText(`
[workspace]
members = ["crates/*"]

[package]
name = "root-crate"
`);
  assert.equal(parsed.workspace, true);
  assert.equal(parsed.name, "root-crate");
});

test("findManifests: finds all three formats, skips node_modules and hidden dirs", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root-npm" }));
    writeFileSync(join(dir, "go.mod"), "module example.com/root\n");
    mkdirSync(join(dir, "crates", "alpha"), { recursive: true });
    writeFileSync(join(dir, "crates", "alpha", "Cargo.toml"), '[package]\nname = "alpha"\n');
    mkdirSync(join(dir, "node_modules", "somelib"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "somelib", "package.json"),
      JSON.stringify({ name: "somelib" }),
    );
    mkdirSync(join(dir, ".hidden"), { recursive: true });
    writeFileSync(join(dir, ".hidden", "package.json"), JSON.stringify({ name: "hidden" }));

    const found = findManifests(dir);
    const byFormat = new Map(found.map((m) => [m.format, m.name]));
    assert.equal(found.length, 3);
    assert.equal(byFormat.get("npm"), "root-npm");
    assert.equal(byFormat.get("go"), "example.com/root");
    assert.equal(byFormat.get("cargo"), "alpha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findManifests: package.json without a name falls back to directory name", () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, "unnamed-pkg"));
    writeFileSync(join(dir, "unnamed-pkg", "package.json"), '{"version":"1.0.0"}');
    const found = findManifests(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "unnamed-pkg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
