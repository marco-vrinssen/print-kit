// Finds print pages and reads their trim and bleed.
import { pdfBoxes } from "../shared/print.js";

export const PAGE_KEY = "printkit:page";
const PART_KEY = "printkit:part";
const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE"]);

export function isFrameLike(node) {
  return FRAME_TYPES.has(node.type);
}

// Crop marks and the trim slice belong to the page, not to the artwork. Older pages only
// carry the English group name.
export function markPart(node) {
  node.setPluginData(PART_KEY, "decoration");
}

export function isDecoration(node) {
  return node.type === "SLICE" || node.getPluginData(PART_KEY) === "decoration" || (node.type === "GROUP" && node.locked && node.name === "Crop marks");
}

export function readMeta(node) {
  try {
    const meta = JSON.parse(node.getPluginData(PAGE_KEY) || "null");
    if (meta && meta.v === 1 && Math.abs(meta.frameW - node.width) < 0.01 && Math.abs(meta.frameH - node.height) < 0.01) return meta;
  } catch (e) {
    // Damaged metadata falls back to slice detection.
  }
  return null;
}

// Other print plugins mark the trim with a slice whose name contains "trimbox".
// The shallow form looks at direct children only, which is enough to recognize a page cheaply.
function findTrimSlice(node, shallow) {
  const isTrim = (n) => n.type === "SLICE" && /trimbox/i.test(n.name);
  if (shallow) return "children" in node ? node.children.find(isTrim) || null : null;
  return "findOne" in node ? node.findOne(isTrim) : null;
}

export function readPage(node) {
  const base = { id: node.id, name: node.name, width: node.width, height: node.height };
  const meta = readMeta(node);
  if (meta) return Object.assign(base, { trim: meta.trim, bleed: meta.bleed, margin: meta.margin, unit: meta.unit, source: "printkit" });
  const slice = findTrimSlice(node);
  if (slice) {
    const x = slice.absoluteTransform[0][2] - node.absoluteTransform[0][2];
    const y = slice.absoluteTransform[1][2] - node.absoluteTransform[1][2];
    return Object.assign(base, { trim: { x, y, w: slice.width, h: slice.height }, bleed: null, margin: 0, unit: "mm", source: "slice" });
  }
  return Object.assign(base, { trim: { x: 0, y: 0, w: node.width, h: node.height }, bleed: 0, margin: 0, unit: "mm", source: "frame" });
}

export function boxesFor(page) {
  return pdfBoxes(page.width, page.height, page.trim, page.bleed);
}

// A page made by Print for Figma or Printery.
export function isOtherPrintPage(node) {
  return isFrameLike(node) && readMeta(node) === null && findTrimSlice(node, true) !== null;
}

function isPrintPage(node) {
  return isFrameLike(node) && (readMeta(node) !== null || findTrimSlice(node, true) !== null);
}

// The frame a layer sits on: its topmost frame below the canvas or a section.
function pageFrameOf(node) {
  let frame = isFrameLike(node) ? node : null;
  for (let n = node.parent; n && n.type !== "PAGE" && n.type !== "SECTION"; n = n.parent) {
    if (isFrameLike(n)) frame = n;
  }
  return frame;
}

// Selected frames are pages, and so is the frame around any selected layer. A selected
// section stands for the frames inside it. With nothing selected, every print page on the
// current Figma page counts. Pages come in reading order: rows first, then left to right.
export function targetPages() {
  const selection = figma.currentPage.selection;
  const nodes = [];
  const add = (node) => node && nodes.indexOf(node) < 0 && nodes.push(node);
  if (selection.length) {
    for (const node of selection) {
      if (node.type === "SECTION") node.children.filter(isFrameLike).forEach(add);
      else add(pageFrameOf(node));
    }
  } else {
    for (const node of figma.currentPage.children) {
      if (node.type === "SECTION") node.children.filter(isPrintPage).forEach(add);
      else if (isPrintPage(node)) add(node);
    }
  }
  return nodes.sort((a, b) => {
    const ay = a.absoluteTransform[1][2];
    const by = b.absoluteTransform[1][2];
    if (Math.abs(ay - by) > Math.min(a.height, b.height) / 2) return ay - by;
    return a.absoluteTransform[0][2] - b.absoluteTransform[0][2];
  });
}

export async function pagesById(ids) {
  const nodes = await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
  return nodes.filter((node) => node && isFrameLike(node));
}

// What the UI needs to label its buttons and lists.
export function selectionSummary() {
  const selection = figma.currentPage.selection;
  const frames = selection.filter(isFrameLike);
  return {
    selected: selection.length,
    frames: frames.length,
    printPages: frames.filter((node) => readMeta(node) !== null).length,
    otherPages: frames.filter(isOtherPrintPage).length,
    pageIds: targetPages().map((node) => node.id),
  };
}

// The Export tab's page list, with trim sizes in points.
export function listPages() {
  return targetPages().map((node) => {
    const page = readPage(node);
    return { id: page.id, name: page.name, w: page.trim.w, h: page.trim.h, unit: page.unit, source: page.source };
  });
}
