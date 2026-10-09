// A schematic of one print page next to a legend with the current values. The bands are drawn
// wider than to scale, so a 3 mm bleed on a poster stays visible. Colors match the guides
// Print Kit draws in Figma: red for the bleed, blue for the safe area.
import { h } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";
const W = 104;
const H = 128;

function shape(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// `ratio` is width / height of the trim; `parts` says which of bleed, margin and marks are on.
// `legend` lists { kind, title, text } rows.
export function pageDiagram(ratio, parts, legend) {
  const markRoom = parts.marks ? 14 : 0;
  const bleed = parts.bleed ? 6 : 0;
  const room = markRoom + bleed + 2;
  const fit = Math.min((W - 2 * room) / ratio, H - 2 * room);
  const tw = fit * ratio;
  const th = fit;
  const x = (W - tw) / 2;
  const y = (H - th) / 2;

  const svg = shape("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "diagram", "aria-hidden": "true" });
  if (bleed) svg.append(shape("rect", { x: x - bleed, y: y - bleed, width: tw + 2 * bleed, height: th + 2 * bleed, class: "d-bleed" }));
  svg.append(shape("rect", { x, y, width: tw, height: th, class: "d-trim" }));
  if (parts.margin) {
    const inset = Math.min(8, tw / 4, th / 4);
    svg.append(shape("rect", { x: x + inset, y: y + inset, width: tw - 2 * inset, height: th - 2 * inset, class: "d-safe" }));
  }
  if (parts.marks) {
    const gap = bleed + 2;
    const len = 9;
    const lines = [];
    for (const [cx, sx] of [[x, -1], [x + tw, 1]]) {
      for (const [cy, sy] of [[y, -1], [y + th, 1]]) {
        lines.push([cx + sx * gap, cy, cx + sx * (gap + len), cy], [cx, cy + sy * gap, cx, cy + sy * (gap + len)]);
      }
    }
    for (const [x1, y1, x2, y2] of lines) svg.append(shape("line", { x1, y1, x2, y2, class: "d-mark" }));
  }

  return h(
    "div",
    { class: "diagram-row" },
    svg,
    h(
      "ul",
      { class: "legend" },
      legend.map((row) => h("li", {}, h("span", { class: `key key-${row.kind}`, "aria-hidden": "true" }), h("span", {}, h("span", { class: "legend-title", text: row.title }), h("span", { class: "legend-text", text: row.text })))),
    ),
  );
}
