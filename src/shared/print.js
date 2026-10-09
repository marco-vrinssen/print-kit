// Print geometry shared by the main thread, the UI and the checks.
// One Figma pixel is one PDF point, so all page math happens in points.

export const PT_PER_UNIT = { mm: 72 / 25.4, cm: 720 / 25.4, in: 72, pt: 1, px: 1 };

// Crop marks use this near-black so the export can tell them apart from black artwork
// and print them in registration color on every plate.
export const REGISTRATION_HEX = "010101";
export const REGISTRATION_RGB = { r: 1 / 255, g: 1 / 255, b: 1 / 255 };

// Tiles are the formats the Create tab shows first; the rest sit in its "More" menu.
export const PRESETS = [
  { id: "a6", label: "A6", width: 105, height: 148, unit: "mm", tile: true },
  { id: "a5", label: "A5", width: 148, height: 210, unit: "mm", tile: true },
  { id: "a4", label: "A4", width: 210, height: 297, unit: "mm", tile: true },
  { id: "a3", label: "A3", width: 297, height: 420, unit: "mm", tile: true },
  { id: "dl", label: "DL", width: 99, height: 210, unit: "mm", tile: true },
  { id: "square", label: "Square", width: 210, height: 210, unit: "mm", tile: true },
  { id: "card-eu", label: "Business card", width: 85, height: 55, unit: "mm", tile: true },
  { id: "a2", label: "A2", width: 420, height: 594, unit: "mm" },
  { id: "a1", label: "A1", width: 594, height: 841, unit: "mm" },
  { id: "poster-50", label: "Poster 50 × 70", width: 500, height: 700, unit: "mm" },
  { id: "letter", label: "US Letter", width: 8.5, height: 11, unit: "in" },
  { id: "legal", label: "US Legal", width: 8.5, height: 14, unit: "in" },
  { id: "tabloid", label: "Tabloid", width: 11, height: 17, unit: "in" },
  { id: "card-us", label: "US business card", width: 3.5, height: 2, unit: "in" },
];

export const DEFAULT_SETTINGS = {
  mode: "new",
  preset: "a5",
  width: 148,
  height: 210,
  unit: "mm",
  pages: 1,
  bleed: 3,
  margin: 5,
  marks: true,
  markOffset: 3,
  markLength: 5,
  markWeight: 0.25,
};

export function toPt(value, unit) {
  return (Number(value) || 0) * (PT_PER_UNIT[unit] || PT_PER_UNIT.mm);
}

export function fromPt(value, unit) {
  return value / (PT_PER_UNIT[unit] || PT_PER_UNIT.mm);
}

// Fields show as many decimals as the unit needs: 0.1 mm, 1/16 in, 0.01 pt.
export function roundFor(value, unit) {
  const factor = unit === "in" ? 10000 : 100;
  return Math.round(value * factor) / factor;
}

// Reads what someone types into a length field, such as "3", "3,5", "3 mm", "0.125in" or '1/8"'.
// Returns the value in `unit`, or null when the text isn't a length.
export function parseLength(text, unit) {
  const match = String(text).trim().toLowerCase().replace(",", ".").match(/^(\d*\.?\d+)(?:\s*\/\s*(\d+))?\s*(mm|cm|in|"|pt|px)?$/);
  if (!match) return null;
  const value = match[2] ? Number(match[1]) / Number(match[2]) : Number(match[1]);
  const from = match[3] === '"' ? "in" : match[3] || unit;
  return fromPt(toPt(value, from), unit);
}

const COMMON = {
  mm: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25],
  in: [0.0625, 0.125, 0.1875, 0.25, 0.375, 0.5, 0.75, 1],
};

// Converts bleed and margins between units and lands on the value printers ask for:
// 3 mm becomes 0.125 in rather than 0.1181 in, and back.
export function convertSnapped(value, from, to) {
  const exact = fromPt(toPt(value, from), to);
  const near = (COMMON[to] || []).find((v) => Math.abs(v - exact) <= v * 0.07);
  return near === undefined ? roundFor(exact, to) : near;
}

// Lays out one print page: the frame is the trim plus bleed, plus room for the
// crop marks when they are on. Marks start at least one bleed away from the trim,
// so they never reach into the printed area.
export function pageGeometry(settings) {
  const unit = settings.unit;
  const trimW = toPt(settings.width, unit);
  const trimH = toPt(settings.height, unit);
  const bleed = Math.max(0, toPt(settings.bleed, unit));
  const margin = Math.max(0, toPt(settings.margin, unit));
  const marks = !!settings.marks && toPt(settings.markLength, unit) > 0;
  const markGap = marks ? Math.max(bleed, toPt(settings.markOffset, unit)) : 0;
  const markLength = marks ? toPt(settings.markLength, unit) : 0;
  const markWeight = marks ? Math.max(0.1, Number(settings.markWeight) || 0.25) : 0;
  const outer = marks ? markGap + markLength : bleed;
  return {
    frameW: trimW + 2 * outer,
    frameH: trimH + 2 * outer,
    trim: { x: outer, y: outer, w: trimW, h: trimH },
    bleed,
    margin,
    marks: marks ? cropMarks({ x: outer, y: outer, w: trimW, h: trimH }, markGap, markLength, markWeight) : [],
  };
}

// Eight thin rectangles centered on the trim lines, outside the bleed.
export function cropMarks(trim, gap, length, weight) {
  const half = weight / 2;
  const left = trim.x;
  const right = trim.x + trim.w;
  const top = trim.y;
  const bottom = trim.y + trim.h;
  return [
    { name: "Top left horizontal", x: left - gap - length, y: top - half, w: length, h: weight },
    { name: "Top left vertical", x: left - half, y: top - gap - length, w: weight, h: length },
    { name: "Top right horizontal", x: right + gap, y: top - half, w: length, h: weight },
    { name: "Top right vertical", x: right - half, y: top - gap - length, w: weight, h: length },
    { name: "Bottom left horizontal", x: left - gap - length, y: bottom - half, w: length, h: weight },
    { name: "Bottom left vertical", x: left - half, y: bottom + gap, w: weight, h: length },
    { name: "Bottom right horizontal", x: right + gap, y: bottom - half, w: length, h: weight },
    { name: "Bottom right vertical", x: right - half, y: bottom + gap, w: weight, h: length },
  ];
}

// PDF boxes in points with the origin at the bottom left, as [llx, lly, urx, ury].
export function pdfBoxes(frameW, frameH, trim, bleed) {
  const box = (x, y, w, h) => [x, frameH - y - h, x + w, frameH - y].map((v) => Math.round(v * 1000) / 1000);
  const media = [0, 0, frameW, frameH].map((v) => Math.round(v * 1000) / 1000);
  if (!trim) return { media, trim: media, bleed: media };
  const b = bleed == null ? null : bleed;
  const bleedBox =
    b == null
      ? media
      : box(
          Math.max(0, trim.x - b),
          Math.max(0, trim.y - b),
          Math.min(frameW, trim.x + trim.w + b) - Math.max(0, trim.x - b),
          Math.min(frameH, trim.y + trim.h + b) - Math.max(0, trim.y - b),
        );
  return { media, trim: box(trim.x, trim.y, trim.w, trim.h), bleed: bleedBox };
}

// Effective resolution of an image paint on a layer of w × h points.
// Fill, Fit and Tile scale the whole image; Crop shows the part its transform selects.
export function effectivePpi(paint, w, h, imageW, imageH) {
  if (!imageW || !imageH || !w || !h) return null;
  if (paint.scaleMode === "CROP" && paint.imageTransform) {
    const t = paint.imageTransform;
    const sx = Math.hypot(t[0][0], t[1][0]);
    const sy = Math.hypot(t[0][1], t[1][1]);
    return Math.round(Math.min((72 * sx * imageW) / w, (72 * sy * imageH) / h));
  }
  const quarterTurn = Math.round((paint.rotation || 0) / 90) % 2 !== 0;
  const iw = quarterTurn ? imageH : imageW;
  const ih = quarterTurn ? imageW : imageH;
  let scale;
  if (paint.scaleMode === "TILE") scale = paint.scalingFactor || 1;
  else if (paint.scaleMode === "FIT") scale = Math.min(w / iw, h / ih);
  else scale = Math.max(w / iw, h / ih);
  return Math.round(72 / scale);
}

export function hexOfColor(color) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return (to(color.r) + to(color.g) + to(color.b)).toUpperCase();
}
