import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  findManifests,
  parseManifest,
} from "./manifest.ts";
import type { Graph, GraphEdge, GraphNode, Manifest } from "./types.ts";
import { nodeId } from "./types.ts";

export interface BuildOptions {
  /** Render unresolved dependencies as gray external stub nodes. */
  externals: boolean;
}

/**
 * Build the dependency graph of a directory tree. Edges are drawn only
 * between manifests found in the scan (or to external stubs when
 * `externals` is on): the tool never touches the network.
 */
export function buildGraph(root: string, opts: BuildOptions): Graph {
  const manifests = findManifests(root);
  const graph: Graph = { nodes: new Map(), edges: [] };
  for (const m of manifests) {
    const id = nodeId(m.format, m.name);
    if (!graph.nodes.has(id)) {
      graph.nodes.set(id, { id, format: m.format, name: m.name, manifest: m, external: false });
    }
  }
  // Cargo path deps resolve through the filesystem, so they may point at
  // manifests outside the scanned tree when the scan root sits inside one.
  const cargoByDir = new Map<string, Manifest>();
  for (const m of manifests) {
    if (m.format === "cargo") cargoByDir.set(m.dir, m);
  }

  const edgeSeen = new Set<string>();
  const addEdge = (from: string, to: string, dev: boolean) => {
    // One arrow per pair: a package that is both a normal and a dev
    // dependency of the same node keeps its first (non-dev) edge.
    const key = `${from}->${to}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    graph.edges.push({ from, to, dev, cycle: false });
  };
  const targetFor = (m: Manifest, name: string, localPath?: string): GraphNode | null => {
    if (m.format === "npm") {
      return graph.nodes.get(nodeId("npm", name)) ?? null;
    }
    if (m.format === "go") {
      if (localPath !== undefined) {
        const abs = resolve(m.dir, localPath);
        const found = parseManifest(resolve(abs, "go.mod"));
        if (found) return graph.nodes.get(nodeId("go", found.name)) ?? null;
        return null;
      }
      return graph.nodes.get(nodeId("go", name)) ?? null;
    }
    // cargo
    if (localPath !== undefined) {
      const abs = resolve(m.dir, localPath);
      const found = cargoByDir.get(abs) ??
        (existsSync(resolve(abs, "Cargo.toml")) ? parseManifest(resolve(abs, "Cargo.toml")) : null);
      if (found) return graph.nodes.get(nodeId("cargo", found.name)) ?? null;
      return null;
    }
    return graph.nodes.get(nodeId("cargo", name)) ?? null;
  };

  for (const m of manifests) {
    const from = nodeId(m.format, m.name);
    for (const dep of m.deps) {
      const target = targetFor(m, dep.name, dep.localPath);
      if (target) {
        addEdge(from, target.id, dep.dev);
      } else if (opts.externals) {
        const extId = nodeId("external", dep.name);
        if (!graph.nodes.has(extId)) {
          graph.nodes.set(extId, { id: extId, format: "external", name: dep.name, external: true });
        }
        addEdge(from, extId, dep.dev);
      }
    }
  }
  return graph;
}

/**
 * Tarjan's strongly connected components. Components of size > 1 (or a
 * self loop) contain a dependency cycle.
 */
export function tarjanSCC(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const e of successors(graph, v)) {
      if (!index.has(e)) {
        strongconnect(e);
        low.set(v, Math.min(low.get(v) as number, low.get(e) as number));
      } else if (onStack.has(e)) {
        low.set(v, Math.min(low.get(v) as number, index.get(e) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  };

  for (const id of graph.nodes.keys()) {
    if (!index.has(id)) strongconnect(id);
  }
  return components;
}

function successors(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.from === id).map((e) => e.to);
}

/** Nodes involved in a cycle: members of non-trivial SCCs plus self loops. */
export function cyclicNodes(graph: Graph): Set<string> {
  const cyclic = new Set<string>();
  for (const component of tarjanSCC(graph)) {
    if (component.length > 1) {
      for (const id of component) cyclic.add(id);
    }
  }
  for (const e of graph.edges) {
    if (e.from === e.to) {
      cyclic.add(e.from);
      cyclic.add(e.to);
    }
  }
  return cyclic;
}

/** Elementary cycles as node-id lists (one per non-trivial SCC, ordered). */
export function findCycles(graph: Graph): string[][] {
  const cycles: string[][] = [];
  for (const e of graph.edges) {
    if (e.from === e.to) cycles.push([e.from]);
  }
  for (const component of tarjanSCC(graph)) {
    if (component.length > 1) {
      cycles.push([...component].sort());
    }
  }
  return cycles;
}

/** Mark edges that stay inside a single non-trivial SCC (or self loops). */
export function markCycleEdges(graph: Graph): void {
  const componentOf = new Map<string, string>();
  for (const component of tarjanSCC(graph)) {
    const key = [...component].sort().join("|");
    for (const id of component) componentOf.set(id, key);
  }
  for (const e of graph.edges) {
    e.cycle = e.from === e.to || componentOf.get(e.from) === componentOf.get(e.to);
  }
}

/** BFS distance from root nodes (no incoming edges). */
export function computeLevels(graph: Graph): Map<string, number> {
  const incoming = new Map<string, number>();
  for (const id of graph.nodes.keys()) incoming.set(id, 0);
  for (const e of graph.edges) {
    incoming.set(e.to, (incoming.get(e.to) as number) + 1);
  }
  const levels = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, count] of incoming) {
    if (count === 0) {
      levels.set(id, 0);
      queue.push(id);
    }
  }
  // A pure cycle has no roots: seed every node at level 0 instead.
  if (queue.length === 0) {
    for (const id of graph.nodes.keys()) {
      levels.set(id, 0);
      queue.push(id);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    const level = levels.get(id) as number;
    for (const e of graph.edges) {
      if (e.from !== id) continue;
      const next = level + 1;
      // Inside a cycle the seed level can exceed the natural distance;
      // keep the minimum level seen.
      const current = levels.get(e.to);
      if (current === undefined || next < current) {
        levels.set(e.to, next);
        queue.push(e.to);
      }
    }
  }
  // Sub-cycles unreachable from any root never entered the BFS: pin them
  // at level 0 so they still render.
  for (const id of graph.nodes.keys()) {
    if (!levels.has(id)) levels.set(id, 0);
  }
  return levels;
}

export interface LimitResult {
  graph: Graph;
  dropped: number;
}

/**
 * Restrict the graph to nodes within `maxDepth` BFS levels from the roots.
 * Root nodes always survive; returns the trimmed graph and how many nodes
 * were dropped.
 */
export function limitDepth(graph: Graph, maxDepth: number): LimitResult {
  const levels = computeLevels(graph);
  const kept = new Set<string>();
  for (const [id, level] of levels) {
    if (level <= maxDepth) kept.add(id);
  }
  // Roots (level 0) are never dropped, even if maxDepth were 0.
  const incoming = new Map<string, number>();
  for (const id of graph.nodes.keys()) incoming.set(id, 0);
  for (const e of graph.edges) incoming.set(e.to, (incoming.get(e.to) as number) + 1);
  for (const [id, count] of incoming) {
    if (count === 0) kept.add(id);
  }

  const nodes = new Map<string, GraphNode>();
  for (const [id, node] of graph.nodes) {
    if (kept.has(id)) nodes.set(id, node);
  }
  const edges = graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  return {
    graph: { nodes, edges },
    dropped: graph.nodes.size - nodes.size,
  };
}
