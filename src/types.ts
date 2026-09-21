export type Format = "npm" | "go" | "cargo" | "external";

/** One declared dependency of a manifest, before resolution. */
export interface DepRef {
  /** Declared name: npm package name, Go module path, or crate name. */
  name: string;
  /** True for npm devDependencies / Cargo dev-dependencies. */
  dev: boolean;
  /** Relative path hint from Go `replace` or Cargo `path = "..."`. */
  localPath?: string;
}

/** A discovered manifest file (package.json, go.mod or Cargo.toml). */
export interface Manifest {
  /** Absolute path to the manifest file. */
  file: string;
  /** Absolute path of the directory containing it. */
  dir: string;
  format: Exclude<Format, "external">;
  /** Node identity within its format. */
  name: string;
  deps: DepRef[];
}

export interface GraphNode {
  /** `${format}:${name}` */
  id: string;
  format: Format;
  name: string;
  manifest?: Manifest;
  external: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  dev: boolean;
  /** Both endpoints share a strongly connected component. */
  cycle: boolean;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

export function nodeId(format: Format, name: string): string {
  return `${format}:${name}`;
}
