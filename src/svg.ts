import type { Graph } from "./types.ts";
import type { Box, Layout } from "./layout.ts";
import { computeLayout } from "./layout.ts";
import { computeLevels } from "./graph.ts";

const FILL: Record<string, string> = {
  npm: "#e8f5e9",
  go: "#e0f7fa",
  cargo: "#fff3e0",
  external: "#f5f5f5",
};
const STROKE: Record<string, string> = {
  npm: "#2e7d32",
  go: "#00838f",
  cargo: "#ef6c00",
  external: "#9e9e9e",
};
const LABEL: Record<string, string> = {
  npm: "npm",
  go: "go",
  cargo: "cargo",
  external: "external",
};

export interface RenderOptions {
  title: string;
}

/** Escape text for XML/SVG content and attribute contexts. */
export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Render the graph as a standalone SVG string. Deterministic: identical
 * input always produces byte-identical output.
 */
export function renderSVG(graph: Graph, opts: RenderOptions, layout?: Layout): string {
  const lay =
    layout ??
    computeLayout(graph, computeLevels(graph), { minWidth: legendWidth() });
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${lay.width}" height="${lay.height}" ` +
      `viewBox="0 0 ${lay.width} ${lay.height}" font-family="monospace">`,
  );
  parts.push(
    `  <defs>` +
      `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="#616161"/>` +
      `</marker>` +
      `<marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M 0 0 L 10 5 L 0 10 z" fill="#c62828"/>` +
      `</marker>` +
      `</defs>`,
  );
  parts.push(`  <rect width="100%" height="100%" fill="#ffffff"/>`);
  parts.push(
    `  <text x="20" y="30" font-size="16" font-weight="bold" fill="#212121">` +
      `${escapeXml(opts.title)}</text>`,
  );

  for (const e of graph.edges) {
    parts.push(`  ${edgeSvg(e, lay.boxes)}`);
  }

  for (const node of sortedNodes(graph)) {
    const box = lay.boxes.get(node.id);
    if (!box) continue;
    parts.push(`  ${nodeSvg(node, box)}`);
  }

  parts.push(legendSvg(lay.height));
  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

function sortedNodes(graph: Graph) {
  return [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function edgeSvg(e: { from: string; to: string; dev: boolean; cycle: boolean }, boxes: Map<string, Box>): string {
  const a = boxes.get(e.from);
  const b = boxes.get(e.to);
  if (!a || !b) return `<!-- missing box for ${e.from} -> ${e.to} -->`;
  const color = e.cycle ? "#c62828" : "#616161";
  const marker = e.cycle ? "arrow-cycle" : "arrow";
  const dash = e.dev ? ` stroke-dasharray="5,4"` : "";
  if (e.from === e.to) {
    // Self loop: small arc bulging to the right of the box.
    const cx = a.x + a.w;
    const cy = a.y + a.h / 2;
    return (
      `<path d="M ${cx} ${cy - 8} C ${cx + 34} ${cy - 26}, ${cx + 34} ${cy + 26}, ${cx} ${cy + 8}" ` +
      `fill="none" stroke="${color}" stroke-width="1.5"${dash} marker-end="url(#${marker})"/>`
    );
  }
  const x1 = a.x + a.w / 2;
  const y1 = a.y + a.h;
  const x2 = b.x + b.w / 2;
  const y2 = b.y;
  if (Math.abs(b.y - a.y) < 1) {
    // Same row: arc over the tops instead of crossing the row.
    const peak = Math.min(a.y, b.y) - 30;
    return (
      `<path d="M ${x1} ${a.y} C ${x1} ${peak}, ${x2} ${peak}, ${x2} ${b.y}" ` +
      `fill="none" stroke="${color}" stroke-width="1.5"${dash} marker-end="url(#${marker})"/>`
    );
  }
  const down = y2 >= y1;
  if (down) {
    const my = (y1 + y2) / 2;
    return (
      `<path d="M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" ` +
      `fill="none" stroke="${color}" stroke-width="1.5"${dash} marker-end="url(#${marker})"/>`
    );
  }
  // Upward edge (cycle back-edge): route around the right side.
  const mx = Math.max(a.x + a.w, b.x + b.w) + 34;
  return (
    `<path d="M ${x1} ${a.y + a.h / 2} C ${mx} ${a.y + a.h / 2}, ${mx} ${b.y + b.h / 2}, ${b.x + b.w} ${b.y + b.h / 2}" ` +
    `fill="none" stroke="${color}" stroke-width="1.5"${dash} marker-end="url(#${marker})"/>`
  );
}

function nodeSvg(node: { id: string; format: string; name: string; external: boolean }, box: Box): string {
  const fill = FILL[node.format] ?? FILL.external;
  const stroke = STROKE[node.format] ?? STROKE.external;
  const dash = node.external ? ` stroke-dasharray="4,3"` : "";
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return (
    `<g><rect x="${r2(box.x)}" y="${r2(box.y)}" width="${r2(box.w)}" height="${box.h}" rx="8" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash}/>` +
    `<text x="${r2(cx)}" y="${r2(cy + 4)}" font-size="13" text-anchor="middle" fill="#212121">` +
    `${escapeXml(node.name)}</text></g>`
  );
}

interface LegendItem {
  kind: "box" | "line";
  format?: string;
  attrs?: string;
  label: string;
}

const LEGEND_ITEMS: LegendItem[] = [
  { kind: "box", format: "npm", label: "npm" },
  { kind: "box", format: "go", label: "go" },
  { kind: "box", format: "cargo", label: "cargo" },
  { kind: "box", format: "external", label: "external" },
  { kind: "line", attrs: `stroke="#616161" marker-end="url(#arrow)"`, label: "depends on" },
  { kind: "line", attrs: `stroke="#616161" stroke-dasharray="5,4" marker-end="url(#arrow)"`, label: "dev dep" },
  { kind: "line", attrs: `stroke="#c62828" stroke-dasharray="5,4" marker-end="url(#arrow-cycle)"`, label: "cycle" },
];

/** Advance-x simulation so the canvas can reserve room for the legend. */
export function legendWidth(): number {
  let x = 20;
  for (const item of LEGEND_ITEMS) {
    x +=
      item.kind === "box"
        ? 28 + (item.label.length * 8) + 24
        : 32 + (item.label.length * 8) + 18;
  }
  return x + 20;
}

function legendSvg(canvasH: number): string {
  const y = canvasH - 40;
  const items: string[] = [];
  let x = 20;
  for (const item of LEGEND_ITEMS) {
    if (item.kind === "box") {
      const format = item.format as string;
      items.push(
        `<rect x="${x}" y="${y - 11}" width="22" height="14" rx="4" fill="${FILL[format]}" stroke="${STROKE[format]}" stroke-width="1.2"/>` +
          `<text x="${x + 28}" y="${y}" font-size="12" fill="#424242">${LABEL[format]}</text>`,
      );
      x += 28 + LABEL[format].length * 8 + 24;
    } else {
      items.push(
        `<line x1="${x}" y1="${y - 4}" x2="${x + 26}" y2="${y - 4}" stroke-width="1.5" ${item.attrs}/>` +
          `<text x="${x + 32}" y="${y}" font-size="12" fill="#424242">${item.label}</text>`,
      );
      x += 32 + item.label.length * 8 + 18;
    }
  }
  return `  <g>${items.join("")}</g>`;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
