// Yunshu AI mark: "Open Y", Medium weight. Single source of truth for every logo asset.
//
// Golden-ratio construction (φ = 1.618…):
//  - the arms meet at 108°, so the triangle formed by the arm tips and the hub is a golden
//    gnomon (tip-to-tip distance = φ × arm length);
//  - the hub divides the height in the golden ratio: stem ÷ upper part = φ.
// All nodes connect through the violet hub, like parties settling through one point on-chain.

export const PHI = (1 + Math.sqrt(5)) / 2;
const DEG = Math.PI / 180;
const round = (n) => Math.round(n * 100) / 100;

/** Node and stroke sizes on a 48 × 48 grid. `small` is the heavier drawing used at 32 px and below. */
const WEIGHTS = {
  regular: { stroke: 4, node: 4.5, top: 6.5, bottom: 41.5 },
  small: { stroke: 4.2, node: 4.6, top: 7, bottom: 41 },
};

/**
 * @param {{ small?: boolean }} [opts]
 * @returns {{ stroke: number, lines: [number, number, number, number][], nodes: { cx: number, cy: number, r: number, hub: boolean }[] }}
 */
export function logoGeometry({ small = false } = {}) {
  const { stroke, node, top, bottom } = small ? WEIGHTS.small : WEIGHTS.regular;
  const height = bottom - top;
  const arm = height / (Math.cos(54 * DEG) * (1 + PHI));
  const hub = [24, top + arm * Math.cos(54 * DEG)];
  const left = [24 - arm * Math.sin(54 * DEG), top];
  const right = [24 + arm * Math.sin(54 * DEG), top];
  const base = [24, bottom];
  const seg = (a, b) => [round(a[0]), round(a[1]), round(b[0]), round(b[1])];
  const pt = (p, r, isHub = false) => ({ cx: round(p[0]), cy: round(p[1]), r: round(r), hub: isHub });
  return {
    stroke,
    lines: [seg(left, hub), seg(right, hub), seg(hub, base)],
    nodes: [pt(left, node), pt(right, node), pt(base, node), pt(hub, node * 1.22, true)],
  };
}

/**
 * Standalone SVG markup (literal colours, for files and images).
 * @param {{ small?: boolean, accent?: string, hub?: string, background?: string, mono?: string }} [opts]
 */
export function logoSvg({ small = false, accent = '#22D3EE', hub = '#8B5CF6', background, mono } = {}) {
  const g = logoGeometry({ small });
  const line = mono ?? accent;
  const bg = background ? `<rect width="48" height="48" rx="11" fill="${background}"/>` : '';
  const lines = g.lines
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
    .join('');
  const nodes = g.nodes
    .map((n) => `<circle cx="${n.cx}" cy="${n.cy}" r="${n.r}" fill="${n.hub ? (mono ?? hub) : line}"/>`)
    .join('');
  const body = `<g stroke="${line}" stroke-width="${g.stroke}" stroke-linecap="round">${lines}</g>${nodes}`;
  // On a tile, inset the mark so the outer nodes clear the rounded corners
  const content = background ? `${bg}<g transform="translate(24 24) scale(0.8) translate(-24 -24)">${body}</g>` : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${content}</svg>\n`;
}
