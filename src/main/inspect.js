// Preflight checks, their one-click fixes, and the color scan over print pages.
// Issues carry a code and numbers; the UI words them in the user's language.
import { effectivePpi, hexOfColor, fromPt, roundFor, REGISTRATION_HEX } from "../shared/print.js";
import { readPage, targetPages, isDecoration } from "./pages.js";

const MIN_TEXT_PT = 6;
const MIN_STROKE_PT = 0.25;
const PPI_WARNING = 300;
const PPI_ERROR = 150;

// Visits visible layers below a page. `clipped` tells whether a frame between the
// page and the layer clips it, which decides whether the layer could reach the bleed.
function walk(node, visit, clipped) {
  for (const child of node.children || []) {
    if (!child.visible || isDecoration(child)) continue;
    visit(child, clipped);
    if ("children" in child) walk(child, visit, clipped || (child.type !== "GROUP" && child.clipsContent === true));
  }
}

function visiblePaints(paints) {
  return Array.isArray(paints) ? paints.filter((p) => p.visible !== false && (p.opacity === undefined || p.opacity > 0)) : [];
}

// Text uses its painted bounds, so empty space in a fixed-size text box doesn't count.
function relativeBox(node, page) {
  const box = (node.type === "TEXT" && node.absoluteRenderBounds) || node.absoluteBoundingBox;
  if (!box) return null;
  return { x: box.x - page.absoluteTransform[0][2], y: box.y - page.absoluteTransform[1][2], w: box.width, h: box.height };
}

function strokeWeight(node) {
  if (typeof node.strokeWeight === "number") return node.strokeWeight;
  const sides = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"].map((k) => node[k]).filter((v) => typeof v === "number" && v > 0);
  return sides.length ? Math.min(...sides) : 0;
}

// Sides where a layer's edge sits on the trim line.
function trimSides(box, t) {
  const sides = [];
  if (Math.abs(box.x - t.x) < 0.5) sides.push("left");
  if (Math.abs(box.y - t.y) < 0.5) sides.push("top");
  if (Math.abs(box.x + box.w - (t.x + t.w)) < 0.5) sides.push("right");
  if (Math.abs(box.y + box.h - (t.y + t.h)) < 0.5) sides.push("bottom");
  return sides;
}

// Only unrotated rectangles outside auto layout can grow without changing their look.
function canExtend(node) {
  const parent = node.parent;
  return node.type === "RECTANGLE" && node.rotation === 0 && !(parent && "layoutMode" in parent && parent.layoutMode !== "NONE");
}

export async function checkPages() {
  const nodes = targetPages();
  const pages = [];
  const issues = [];
  const imageSizes = new Map();

  const imageSize = (hash) => {
    if (!imageSizes.has(hash)) {
      const image = figma.getImageByHash(hash);
      imageSizes.set(hash, image ? image.getSizeAsync().catch(() => null) : Promise.resolve(null));
    }
    return imageSizes.get(hash);
  };

  for (const node of nodes) {
    const page = readPage(node);
    pages.push({ id: page.id, name: page.name });
    const add = (target, code, severity, params, fix) =>
      issues.push({ pageId: page.id, nodeId: target.id, nodeName: target.name, code, severity, params: params || {}, fix: fix || null });

    if (page.source === "frame") add(node, "page-no-trim", "info");
    else if (page.bleed === 0) add(node, "page-no-bleed", "info");

    const t = page.trim;
    const pending = [];
    walk(node, (child, clipped) => {
      const box = relativeBox(child, node);

      if (child.type === "TEXT") {
        if (child.hasMissingFont) add(child, "font-missing", "error");
        const sizes = child.fontSize === figma.mixed ? child.getStyledTextSegments(["fontSize"]).map((s) => s.fontSize) : [child.fontSize];
        const smallest = Math.min(...sizes);
        if (smallest < MIN_TEXT_PT) add(child, "text-small", "warning", { size: Math.round(smallest * 10) / 10, min: MIN_TEXT_PT });
        if (box && page.source !== "frame") {
          const inside = Math.min(box.x - t.x, box.y - t.y, t.x + t.w - (box.x + box.w), t.y + t.h - (box.y + box.h));
          if (inside < -0.5) add(child, "text-cut", "warning");
          else if (page.margin > 0 && inside < page.margin - 0.5) add(child, "text-margin", "warning", { margin: roundFor(fromPt(page.margin, page.unit), page.unit), unit: page.unit });
        }
      }

      if (visiblePaints(child.strokes).length) {
        const weight = strokeWeight(child);
        if (weight > 0 && weight < MIN_STROKE_PT) add(child, "line-thin", "warning", { weight: Math.round(weight * 100) / 100, min: MIN_STROKE_PT }, "stroke");
      }

      for (const paint of visiblePaints(child.fills)) {
        if (paint.type !== "IMAGE" || !paint.imageHash) continue;
        pending.push(
          imageSize(paint.imageHash).then((size) => {
            const ppi = size ? effectivePpi(paint, child.width, child.height, size.width, size.height) : null;
            if (ppi !== null && ppi < PPI_ERROR) add(child, "image-low", "error", { ppi, min: PPI_WARNING });
            else if (ppi !== null && ppi < PPI_WARNING) add(child, "image-medium", "warning", { ppi, min: PPI_WARNING });
          }),
        );
      }

      if (Array.isArray(child.effects) && child.effects.some((e) => e.visible !== false)) add(child, "effects", "info");

      // Artwork that ends exactly at the trim leaves a white edge if the cut is off.
      if (!clipped && box && page.bleed > 0 && child.type !== "TEXT" && (visiblePaints(child.fills).length || child.type === "FRAME")) {
        const sides = trimSides(box, t);
        if (sides.length) add(child, "edge-trim", "warning", { sides }, canExtend(child) ? "bleed" : null);
      }
    }, false);
    await Promise.all(pending);
  }
  const rank = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { pages, issues };
}

// Thin lines get the minimum weight; rectangles that stop at the trim grow into the bleed.
export async function fixIssue(kind, nodeId, pageId) {
  const node = await figma.getNodeByIdAsync(nodeId);
  const frame = await figma.getNodeByIdAsync(pageId);
  if (!node || !frame || node.type === "DOCUMENT" || node.type === "PAGE") return false;
  if (kind === "stroke" && "strokeWeight" in node) {
    node.strokeWeight = MIN_STROKE_PT;
    return true;
  }
  if (kind === "bleed" && node.type === "RECTANGLE" && canExtend(node)) {
    const page = readPage(frame);
    const box = relativeBox(node, frame);
    const sides = trimSides(box, page.trim);
    const edge = { left: page.trim.x - page.bleed, top: page.trim.y - page.bleed, right: page.trim.x + page.trim.w + page.bleed, bottom: page.trim.y + page.trim.h + page.bleed };
    const grow = {
      left: sides.indexOf("left") >= 0 ? box.x - edge.left : 0,
      top: sides.indexOf("top") >= 0 ? box.y - edge.top : 0,
      right: sides.indexOf("right") >= 0 ? edge.right - (box.x + box.w) : 0,
      bottom: sides.indexOf("bottom") >= 0 ? edge.bottom - (box.y + box.h) : 0,
    };
    node.x -= grow.left;
    node.y -= grow.top;
    node.resize(node.width + grow.left + grow.right, node.height + grow.top + grow.bottom);
    return true;
  }
  return false;
}

// Lists solid colors, and gradients with their stops. Stop colors join the color list, so a
// brand color mapped there keeps its CMYK values inside gradients too.
export function scanColors() {
  const colors = new Map();
  const gradients = new Map();
  let images = 0;
  const addColor = (hex, kind) => {
    if (hex === REGISTRATION_HEX) return;
    const entry = colors.get(hex) || { hex, count: 0, kinds: [] };
    entry.count++;
    if (entry.kinds.indexOf(kind) < 0) entry.kinds.push(kind);
    colors.set(hex, entry);
  };
  const count = (paint, kind) => {
    if (paint.type === "SOLID") {
      addColor(hexOfColor(paint.color), kind);
    } else if (paint.type.indexOf("GRADIENT") === 0) {
      const stops = (paint.gradientStops || []).map((s) => ({
        hex: hexOfColor(s.color),
        position: Math.round(s.position * 1000) / 1000,
        alpha: Math.round((s.color.a === undefined ? 1 : s.color.a) * 100) / 100,
      }));
      const key = paint.type + "|" + stops.map((s) => `${s.hex}@${s.position}/${s.alpha}`).join(",");
      const entry = gradients.get(key) || { type: paint.type.replace("GRADIENT_", "").toLowerCase(), stops, count: 0 };
      entry.count++;
      gradients.set(key, entry);
      stops.forEach((stop) => addColor(stop.hex, "gradient"));
    } else if (paint.type === "IMAGE") images++;
  };
  const visit = (node) => {
    if (node.type === "TEXT") {
      const segments = node.fills === figma.mixed ? node.getStyledTextSegments(["fills"]) : [{ fills: node.fills }];
      segments.forEach((s) => visiblePaints(s.fills).forEach((p) => count(p, "text")));
    } else {
      visiblePaints(node.fills).forEach((p) => count(p, "fill"));
    }
    visiblePaints(node.strokes).forEach((p) => count(p, "stroke"));
  };
  for (const page of targetPages()) {
    visit(page);
    walk(page, visit, false);
  }
  return {
    colors: [...colors.values()].sort((a, b) => b.count - a.count),
    gradients: [...gradients.values()].sort((a, b) => b.count - a.count),
    images,
  };
}
