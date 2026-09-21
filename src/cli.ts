#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildGraph, findCycles, limitDepth, markCycleEdges } from "./graph.ts";
import { renderSVG } from "./svg.ts";
import type { Format, Graph } from "./types.ts";

const USAGE = `depgraph v1.0.0 — dependency graph visualizer for npm / Go / Cargo trees

USAGE
  depgraph [ROOT] [options]

ARGS
  ROOT                  directory to scan (default: .)

OPTIONS
  -o, --out <file>      output SVG path (default: dependencies.svg)
  -d, --depth <N>       keep nodes within N levels of the roots (default: 8)
      --externals       include unresolved dependencies as gray stub nodes
      --cycles-only     print cycles instead of drawing; exit 1 if any
      --format <f>      keep only one format: npm | go | cargo
      --title <text>    SVG title (default: "Dependency graph — <root>")
      --stdout          write the SVG to stdout instead of a file
  -h, --help            show this help
  -V, --version         print version

Zero dependencies, fully offline: edges are drawn between manifests found
on disk only (npm names, Go local replace/path modules, Cargo path deps).`;

interface CliArgs {
  root: string;
  out: string;
  depth: number;
  externals: boolean;
  cyclesOnly: boolean;
  format: Format | null;
  title: string | null;
  stdout: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): { ok: true; args: CliArgs } | { ok: false; message: string } {
  const args: CliArgs = {
    root: ".",
    out: "dependencies.svg",
    depth: 8,
    externals: false,
    cyclesOnly: false,
    format: null,
    title: null,
    stdout: false,
    help: false,
    version: false,
  };
  let positional = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needValue = (flag: string): string | null => {
      const value = argv[i + 1];
      if (value === undefined) {
        return null;
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "-o":
      case "--out": {
        const v = needValue(arg);
        if (v === null) return { ok: false, message: `${arg} requires a file path` };
        args.out = v;
        break;
      }
      case "-d":
      case "--depth": {
        const v = needValue(arg);
        if (v === null) return { ok: false, message: `${arg} requires a number` };
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) {
          return { ok: false, message: `${arg} expects a non-negative integer, got "${v}"` };
        }
        args.depth = n;
        break;
      }
      case "--externals":
        args.externals = true;
        break;
      case "--cycles-only":
        args.cyclesOnly = true;
        break;
      case "--format": {
        const v = needValue(arg);
        if (v === null) return { ok: false, message: `${arg} requires npm | go | cargo` };
        if (v !== "npm" && v !== "go" && v !== "cargo") {
          return { ok: false, message: `unknown format "${v}" (expected npm | go | cargo)` };
        }
        args.format = v;
        break;
      }
      case "--title": {
        const v = needValue(arg);
        if (v === null) return { ok: false, message: `${arg} requires text` };
        args.title = v;
        break;
      }
      case "--stdout":
        args.stdout = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        return { ok: true, args };
      case "-V":
      case "--version":
        args.version = true;
        return { ok: true, args };
      case "--":
        break;
      default:
        if (arg.startsWith("-")) {
          return { ok: false, message: `unknown option "${arg}"` };
        }
        if (positional > 0) {
          return { ok: false, message: `unexpected extra argument "${arg}"` };
        }
        positional += 1;
        args.root = arg;
        break;
    }
  }
  return { ok: true, args };
}

function fail(message: string): never {
  process.stderr.write(`depgraph: ${message}\n`);
  process.stderr.write(`depgraph: run 'depgraph --help' for usage\n`);
  process.exit(2);
}

export function run(argv: string[]): void {
  const parsed = parseArgs(argv);
  if (!parsed.ok) fail(parsed.message);
  const args = parsed.args;
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (args.version) {
    process.stdout.write("depgraph 1.0.0\n");
    return;
  }

  const root = resolve(args.root);
  let graph = buildGraph(root, { externals: args.externals });
  if (graph.nodes.size === 0) {
    process.stderr.write(
      `depgraph: no package.json / go.mod / Cargo.toml found under '${args.root}'\n`,
    );
    process.exit(1);
  }

  markCycleEdges(graph);
  if (args.format !== null) {
    graph = filterFormat(graph, args.format);
    if (graph.nodes.size === 0) {
      process.stderr.write(`depgraph: no ${args.format} manifests found under '${args.root}'\n`);
      process.exit(1);
    }
  }

  if (args.cyclesOnly) {
    const cycles = findCycles(graph);
    if (cycles.length === 0) {
      process.stdout.write("no cycles\n");
      return;
    }
    for (const cycle of cycles) {
      process.stdout.write(`cycle: ${cycle.map(prettyId).join(" -> ")} -> ${prettyId(cycle[0])}\n`);
    }
    process.exit(1);
  }

  const limited = limitDepth(graph, args.depth);
  graph = limited.graph;
  if (graph.nodes.size === 0) {
    process.stderr.write("depgraph: depth limit removed every node; raise --depth\n");
    process.exit(1);
  }

  const title = args.title ?? `Dependency graph — ${args.root}`;
  const svg = renderSVG(graph, { title });
  if (args.stdout) {
    process.stdout.write(svg);
  } else {
    writeFileSync(resolve(args.out), svg);
    const cycles = findCycles(graph).length;
    process.stderr.write(
      `depgraph: ${graph.nodes.size} nodes, ${graph.edges.length} edges, ${cycles} cycle(s)` +
        (limited.dropped > 0 ? `, ${limited.dropped} dropped by depth` : "") +
        ` -> ${args.out}\n`,
    );
  }
}

function filterFormat(graph: Graph, format: Format): Graph {
  const nodes = new Map(graph.nodes);
  for (const [id, node] of graph.nodes) {
    if (node.format !== format) nodes.delete(id);
  }
  const edges = graph.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { nodes, edges };
}

function prettyId(id: string): string {
  const at = id.indexOf(":");
  return at === -1 ? id : id.slice(at + 1);
}

// Exported for tests; executed as CLI when run directly.
export const __internals = { parseArgs, USAGE };

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2));
}
