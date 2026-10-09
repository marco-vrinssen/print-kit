// Builds print pages: new blank pages, print copies of frames, and updates of existing print pages.
import { pageGeometry, fromPt, REGISTRATION_RGB } from "../shared/print.js";
import { PAGE_KEY, isFrameLike, isOtherPrintPage, readMeta, markPart, isDecoration } from "./pages.js";

const TRIM_TINT = { r: 1, g: 0, b: 0, a: 0.1 };
const MARGIN_TINT = { r: 0, g: 0.16, b: 1, a: 0.06 };
const GAP = 40;

// The Properties panel shows these buttons whenever a print page is selected.
const RELAUNCH = { check: "", export: "" };

function band(pattern, alignment, size, color) {
  return { pattern, alignment, gutterSize: 0, count: 1, offset: 0, sectionSize: Math.max(0.01, size), visible: true, color };
}

// Translucent bands outside the trim, a darker one outside the bleed, and the safe margin.
function guides(g) {
  const grids = [];
  const sides = (size, color) => [
    band("ROWS", "MIN", size, color),
    band("ROWS", "MAX", size, color),
    band("COLUMNS", "MIN", size, color),
    band("COLUMNS", "MAX", size, color),
  ];
  if (g.trim.x > 0) grids.push(...sides(g.trim.x, TRIM_TINT));
  if (g.bleed > 0 && g.trim.x - g.bleed > 0.01) grids.push(...sides(g.trim.x - g.bleed, TRIM_TINT));
  if (g.margin > 0) grids.push(...sides(g.trim.x + g.margin, MARGIN_TINT));
  return grids;
}

// Adds the trim slice, crop marks, guides and metadata to a frame laid out by pageGeometry.
function decorate(frame, g, settings, names) {
  const slice = figma.createSlice();
  slice.name = "Trimbox";
  slice.resize(g.trim.w, g.trim.h);
  frame.appendChild(slice);
  slice.x = g.trim.x;
  slice.y = g.trim.y;
  slice.locked = true;

  if (g.marks.length) {
    const rects = g.marks.map((mark) => {
      const rect = figma.createRectangle();
      rect.name = mark.name;
      rect.resize(Math.max(0.01, mark.w), Math.max(0.01, mark.h));
      rect.fills = [{ type: "SOLID", color: REGISTRATION_RGB }];
      frame.appendChild(rect);
      rect.x = mark.x;
      rect.y = mark.y;
      return rect;
    });
    const group = figma.group(rects, frame);
    group.name = names.marks;
    group.locked = true;
    markPart(group);
  }

  frame.layoutGrids = guides(g);
  frame.setRelaunchData(RELAUNCH);
  frame.setPluginData(
    PAGE_KEY,
    JSON.stringify({ v: 1, frameW: g.frameW, frameH: g.frameH, trim: g.trim, bleed: g.bleed, margin: g.margin, unit: settings.unit }),
  );
}

function show(nodes) {
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
}

// `names` holds the layer names in the user's language: format, page, print and marks.
export function createPages(settings, names) {
  const g = pageGeometry(settings);
  const count = Math.max(1, Math.min(200, Math.floor(Number(settings.pages) || 1)));
  const center = figma.viewport.center;
  const startX = Math.round(center.x - (count * (g.frameW + GAP) - GAP) / 2);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const frame = figma.createFrame();
    frame.name = count > 1 ? `${names.format} · ${names.page} ${i + 1}` : names.format;
    frame.resizeWithoutConstraints(g.frameW, g.frameH);
    frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    frame.clipsContent = true;
    decorate(frame, g, settings, names);
    figma.currentPage.appendChild(frame);
    frame.x = startX + i * (g.frameW + GAP);
    frame.y = Math.round(center.y - g.frameH / 2);
    nodes.push(frame);
  }
  show(nodes);
  return nodes.length;
}

// Selected print pages get the new bleed, margin and marks in place. Other selected frames
// are copied into new print pages with the frame's size as trim; the originals stay untouched.
// Pages from other plugins are left alone, since wrapping them would add a second bleed.
export function applyToSelection(settings, names) {
  const frames = figma.currentPage.selection.filter(isFrameLike);
  const own = frames.filter((frame) => readMeta(frame) !== null);
  const others = frames.filter((frame) => readMeta(frame) === null && !isOtherPrintPage(frame));
  own.forEach((frame) => updatePage(frame, settings, names));
  const copies = others.length ? prepareCopies(others, settings, names) : [];
  show(own.concat(copies));
  return { updated: own.length, prepared: copies.length, skipped: frames.length - own.length - others.length };
}

// Moves the artwork by the change in outer margin and the frame by the opposite amount,
// so nothing shifts on the canvas.
function updatePage(frame, settings, names) {
  const meta = readMeta(frame);
  const g = pageGeometry(Object.assign({}, settings, { width: fromPt(meta.trim.w, settings.unit), height: fromPt(meta.trim.h, settings.unit) }));
  const dx = g.trim.x - meta.trim.x;
  const dy = g.trim.y - meta.trim.y;
  frame.children.filter(isDecoration).forEach((node) => {
    node.locked = false;
    node.remove();
  });
  frame.resizeWithoutConstraints(g.frameW, g.frameH);
  if (frame.layoutMode === "NONE") {
    frame.children.forEach((child) => {
      child.x += dx;
      child.y += dy;
    });
  }
  frame.x -= dx;
  frame.y -= dy;
  decorate(frame, g, settings, names);
}

function prepareCopies(sources, settings, names) {
  const right = Math.max(...sources.map((s) => s.absoluteTransform[0][2] + s.width));
  const left = Math.min(...sources.map((s) => s.absoluteTransform[0][2]));
  const shift = right - left + 200;
  return sources.map((source) => {
    const g = pageGeometry(Object.assign({}, settings, { width: fromPt(source.width, settings.unit), height: fromPt(source.height, settings.unit) }));
    const frame = figma.createFrame();
    frame.name = `${source.name} · ${names.print}`;
    frame.resizeWithoutConstraints(g.frameW, g.frameH);

    // The background repeats into the bleed, so the copy needs no artwork changes.
    const background = "fills" in source && Array.isArray(source.fills) ? source.fills.filter((p) => p.type === "SOLID" || p.type.indexOf("GRADIENT") === 0) : [];
    frame.fills = background.length ? JSON.parse(JSON.stringify(background)) : [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    frame.clipsContent = true;
    const copy = source.type === "COMPONENT" ? source.createInstance() : source.clone();
    frame.appendChild(copy);
    copy.x = g.trim.x;
    copy.y = g.trim.y;
    decorate(frame, g, settings, names);

    // Copies go on the page itself, so a source inside an auto layout or section stays as it was.
    figma.currentPage.appendChild(frame);
    frame.x = source.absoluteTransform[0][2] + shift - (g.frameW - source.width) / 2;
    frame.y = source.absoluteTransform[1][2] - (g.frameH - source.height) / 2;
    return frame;
  });
}
