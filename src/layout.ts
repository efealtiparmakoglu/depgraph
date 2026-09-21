import type { Graph } from "./types.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  /** node id -> box (canvas coordinates) */
  boxes: Map<string, Box>;
  width: number;
  height: number;
}

const FONT_CHAR_W = 8; // 13px monospace, approx advance width
const BOX_PAD_X = 20;
const BOX_H = 38;
const COL_GAP = 28;
const ROW_GAP = 78;
const MARGIN = 40;
const TITLE_BAND = 46;
const LEGEND_BAND = 64;

export const FONT = {
  charW: FONT_CHAR_W,
  boxH: BOX_H,
};

/**
 * Layered layout: y comes from the BFS level, x from the sorted order
 * within the level. Same input graph always yields the same canvas.
 */
export function computeLayout(
  graph: Graph,
  levels: Map<string, number>,
  opts?: { minWidth?: number },
): Layout {
  const rows = new Map<number, string[]>();
  for (const [id, level] of levels) {
    if (!graph.nodes.has(id)) continue;
    const row = rows.get(level) ?? [];
    row.push(id);
    rows.set(level, row);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => {
      const na = graph.nodes.get(a) as { format: string; name: string };
      const nb = graph.nodes.get(b) as { format: string; name: string };
      return na.format < nb.format ? -1
        : na.format > nb.format ? 1
        : na.name < nb.name ? -1
        : na.name > nb.name ? 1
        : 0;
    });
  }

  const boxes = new Map<string, Box>();
  const levelKeys = [...rows.keys()].sort((a, b) => a - b);
  let maxRowWidth = 0;
  const widths = new Map<number, number>();
  for (const level of levelKeys) {
    const row = rows.get(level) as string[];
    let width = 0;
    for (let i = 0; i < row.length; i += 1) {
      const node = graph.nodes.get(row[i]) as { name: string };
      const w = BOX_PAD_X * 2 + Math.max(node.name.length, 4) * FONT_CHAR_W;
      boxes.set(row[i], { x: 0, y: 0, w, h: BOX_H });
      width += w + (i > 0 ? COL_GAP : 0);
    }
    widths.set(level, width);
    maxRowWidth = Math.max(maxRowWidth, width);
  }

  const contentH =
    TITLE_BAND +
    levelKeys.length * ROW_GAP +
    LEGEND_BAND;
  const canvasW = Math.max(maxRowWidth + MARGIN * 2, 480, opts?.minWidth ?? 0);
  const canvasH = contentH + MARGIN;

  for (let r = 0; r < levelKeys.length; r += 1) {
    const level = levelKeys[r];
    const row = rows.get(level) as string[];
    const rowWidth = widths.get(level) as number;
    let x = (canvasW - rowWidth) / 2;
    const y = TITLE_BAND + MARGIN / 2 + r * ROW_GAP;
    for (const id of row) {
      const box = boxes.get(id) as Box;
      box.x = x;
      box.y = y;
      x += box.w + COL_GAP;
    }
  }
  return { boxes, width: Math.round(canvasW), height: Math.round(canvasH) };
}
