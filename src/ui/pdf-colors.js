// Rewrites the colors in Figma's exported PDFs before CMYK conversion:
// mapped RGB colors become fixed CMYK values or spot colors, optionally overprinting.
// Figma paints vectors and text with `r g b scn` in one ICC-based RGB space, so the
// rewrite works on content stream operators. Gradients have their own module, and
// images are left to Ghostscript.
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const PAINT_FILL = new Set(["f", "F", "f*", "Tj", "TJ", "'", '"']);
const PAINT_STROKE = new Set(["S", "s"]);
const PAINT_BOTH = new Set(["B", "B*", "b", "b*"]);
const FILL_COLOR = new Set(["cs", "sc", "scn", "rg", "g", "k"]);

// Black shapes at least this wide and tall print in rich black when that choice is on:
// 25 mm. Text and lines stay pure K, since Figma writes each glyph as its own small shape.
export const RICH_MIN_PT = (25 * 72) / 25.4;
export const RICH_BLACK = [0.6, 0.4, 0.4, 1];

export function bytesToLatin1(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

export function latin1ToBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

// Splits a content stream into operations. Each operation keeps its raw text, so
// unchanged operations are written back byte for byte.
export function parseOperations(text) {
  const ops = [];
  let operands = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  const code = (j) => text.charCodeAt(j);

  const skipString = (j) => {
    let depth = 0;
    for (; j < n; j++) {
      const c = code(j);
      if (c === 92) j++;
      else if (c === 40) depth++;
      else if (c === 41 && --depth === 0) return j + 1;
    }
    return n;
  };
  const skipBalanced = (j, open, close) => {
    let depth = 0;
    while (j < n) {
      if (code(j) === 40) { j = skipString(j); continue; }
      if (text.startsWith(open, j)) { depth++; j += open.length; continue; }
      if (text.startsWith(close, j)) { depth--; j += close.length; if (depth === 0) return j; continue; }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = code(i);
    if (WHITESPACE.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && code(i) !== 10 && code(i) !== 13) i++; continue; }
    const tokenStart = i;
    if (c === 40) {
      i = skipString(i);
      operands.push({ kind: "string", raw: text.slice(tokenStart, i) });
    } else if (text.startsWith("<<", i)) {
      i = skipBalanced(i, "<<", ">>");
      operands.push({ kind: "dict", raw: text.slice(tokenStart, i) });
    } else if (c === 60) {
      i = text.indexOf(">", i) + 1 || n;
      operands.push({ kind: "hex", raw: text.slice(tokenStart, i) });
    } else if (c === 91) {
      i = skipBalanced(i, "[", "]");
      operands.push({ kind: "array", raw: text.slice(tokenStart, i) });
    } else if (c === 47) {
      i++;
      while (i < n && !WHITESPACE.has(code(i)) && !DELIMITERS.has(code(i))) i++;
      operands.push({ kind: "name", raw: text.slice(tokenStart, i), value: text.slice(tokenStart + 1, i) });
    } else if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      i++;
      while (i < n && /[0-9.]/.test(text[i])) i++;
      const raw = text.slice(tokenStart, i);
      operands.push({ kind: "number", raw, value: parseFloat(raw) });
    } else {
      i++;
      while (i < n && !WHITESPACE.has(code(i)) && !DELIMITERS.has(code(i))) i++;
      const op = text.slice(tokenStart, i);
      if (op === "BI") {
        // Inline image: the binary data after ID runs to an EI surrounded by whitespace.
        const id = text.indexOf("ID", i);
        let end = id + 3;
        while (end < n) {
          end = text.indexOf("EI", end);
          if (end < 0) { end = n; break; }
          const before = code(end - 1);
          const after = end + 2 < n ? code(end + 2) : 32;
          if (WHITESPACE.has(before) && WHITESPACE.has(after)) break;
          end += 2;
        }
        i = Math.min(n, end + 2);
      }
      ops.push({ op, operands, raw: text.slice(start, i) });
      operands = [];
      start = i;
    }
  }
  if (start < n) ops.push({ op: null, operands, raw: text.slice(start) });
  return ops;
}

export function hexOf(r, g, b) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  return (to(r) + to(g) + to(b)).toUpperCase();
}

const fmt = (v) => String(Math.round(v * 10000) / 10000);

// Resolves a color space name to "rgb", "gray", "cmyk" or "other".
function spaceKind(name, colorSpaces, context) {
  if (name === "DeviceRGB" || name === "CalRGB") return "rgb";
  if (name === "DeviceGray" || name === "CalGray") return "gray";
  if (name === "DeviceCMYK") return "cmyk";
  if (!colorSpaces) return "other";
  const entry = context.lookup(colorSpaces.get(PDFName.of(name)));
  if (entry instanceof PDFName) return spaceKind(entry.decodeText(), null, context);
  if (entry instanceof PDFArray && entry.size() > 1) {
    const family = context.lookup(entry.get(0));
    if (family instanceof PDFName && family.decodeText() === "ICCBased") {
      const profile = context.lookup(entry.get(1));
      const components = profile && profile.dict ? context.lookup(profile.dict.get(PDFName.of("N"))) : null;
      const count = components instanceof PDFNumber ? components.asNumber() : 0;
      return count === 3 ? "rgb" : count === 1 ? "gray" : count === 4 ? "cmyk" : "other";
    }
    if (family instanceof PDFName && family.decodeText() === "CalRGB") return "rgb";
  }
  return "other";
}

const numbersOf = (operands) => operands.filter((t) => t.kind === "number").map((t) => t.value);

// Multiplies two PDF matrices [a b c d e f]: first m, then n.
function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

// Tells whether the fill color set at ops[from] paints a large shape: one subpath at least
// RICH_MIN_PT wide and tall on the page. It looks ahead until the next fill color or the end
// of the enclosing q … Q.
export function paintsLargeArea(ops, from, ctm) {
  const stack = [];
  let m = ctm;
  let box = null;
  let large = false;
  const grow = (x, y) => {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    box = box ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py];
  };
  const endSubpath = () => {
    if (box && box[2] - box[0] >= RICH_MIN_PT && box[3] - box[1] >= RICH_MIN_PT) large = true;
    box = null;
  };
  for (let i = from + 1; i < ops.length; i++) {
    const { op, operands } = ops[i];
    const n = numbersOf(operands);
    if (op === "q") stack.push(m);
    else if (op === "Q") {
      if (!stack.length) return false;
      m = stack.pop();
    } else if (op === "cm" && n.length === 6) m = multiply(n, m);
    else if (FILL_COLOR.has(op) && !stack.length) return false;
    else if (op === "m") {
      endSubpath();
      grow(n[0], n[1]);
    } else if (op === "re" && n.length === 4) {
      endSubpath();
      grow(n[0], n[1]);
      grow(n[0] + n[2], n[1] + n[3]);
      endSubpath();
    } else if (op === "l" || op === "c" || op === "v" || op === "y") {
      for (let j = 0; j + 1 < n.length; j += 2) grow(n[j], n[j + 1]);
    } else if (PAINT_FILL.has(op) || PAINT_BOTH.has(op)) {
      endSubpath();
      if (large) return true;
    } else if (PAINT_STROKE.has(op) || op === "n") {
      box = null;
      large = false;
    }
  }
  return false;
}

// Rewrites one content stream. Returns the new text and which resources it needs.
export function rewriteContent(text, colorSpaces, context, plan) {
  const ops = parseOperations(text);
  const usedSpots = new Set();
  const usedStates = new Set();
  let changed = false;
  const out = [];
  let state = { fill: initialSide(), stroke: initialSide(), op: [false, false], ctm: [1, 0, 0, 1, 0, 0] };
  const stack = [];

  for (let index = 0; index < ops.length; index++) {
    const item = ops[index];
    const { op, operands } = item;
    if (op === "q") { stack.push(cloneState(state)); out.push(item.raw); continue; }
    if (op === "Q") { if (stack.length) state = stack.pop(); out.push(item.raw); continue; }
    if (op === "cm") {
      const n = numbersOf(operands);
      if (n.length === 6) state.ctm = multiply(n, state.ctm);
      out.push(item.raw);
      continue;
    }

    // Writes the replacement for a mapped color and records what is now in effect.
    // Black with a rich variant uses it for large shapes, without overprint.
    const emitMapped = (side, entry, isFill, lead) => {
      changed = true;
      if (entry.rich && isFill && paintsLargeArea(ops, index, state.ctm)) entry = { cmyk: entry.rich, overprint: false };
      side.mapped = entry;
      if (entry.spot) {
        usedSpots.add(entry.spot.key);
        side.emitted = entry.spot.key;
        out.push(`${lead}/${entry.spot.key} ${isFill ? "cs" : "CS"} ${fmt(entry.spot.tint)} ${isFill ? "scn" : "SCN"}`);
      } else {
        side.emitted = "DeviceCMYK";
        out.push(`${lead}${entry.cmyk.map(fmt).join(" ")} ${isFill ? "k" : "K"}`);
      }
    };

    if (op === "cs" || op === "CS") {
      const isFill = op === "cs";
      const side = isFill ? state.fill : state.stroke;
      const nameToken = operands[operands.length - 1];
      side.space = nameToken && nameToken.kind === "name" ? nameToken.value : null;
      side.emitted = side.space;
      side.mapped = null;
      out.push(item.raw);
      // A new RGB space starts out black, and Figma relies on that for its invisible text layer.
      if (spaceKind(side.space, colorSpaces, context) === "rgb") {
        const entry = plan.lookup("000000");
        if (entry) emitMapped(side, entry, isFill, " ");
      }
      continue;
    }

    const isFillColor = op === "sc" || op === "scn" || op === "rg";
    const isStrokeColor = op === "SC" || op === "SCN" || op === "RG";
    if (isFillColor || isStrokeColor) {
      const side = isFillColor ? state.fill : state.stroke;
      const numbers = numbersOf(operands);
      const isRgbOp = op === "rg" || op === "RG";
      const kind = isRgbOp ? "rgb" : spaceKind(side.space, colorSpaces, context);
      if (kind === "rgb" && numbers.length === 3 && operands.length === 3) {
        const hex = hexOf(numbers[0], numbers[1], numbers[2]);
        const entry = plan.lookup(hex);
        if (entry) {
          const lead = item.raw.slice(0, item.raw.length - item.raw.trimStart().length);
          emitMapped(side, entry, isFillColor, lead);
          if (isRgbOp) side.space = "DeviceRGB";
          continue;
        }
        side.mapped = null;
        if (isRgbOp) {
          side.space = "DeviceRGB";
          side.emitted = "DeviceRGB";
        } else if (side.emitted !== side.space && side.space) {
          // An earlier rewrite switched the space; restore it before the original operands.
          changed = true;
          out.push(` /${side.space} ${isFillColor ? "cs" : "CS"}`);
          side.emitted = side.space;
        }
        out.push(item.raw);
        continue;
      }
      if (isRgbOp) { side.space = "DeviceRGB"; side.emitted = "DeviceRGB"; }
      side.mapped = null;
      out.push(item.raw);
      continue;
    }

    if (op === "g" || op === "k" || op === "G" || op === "K") {
      const side = op === "g" || op === "k" ? state.fill : state.stroke;
      side.space = op.toLowerCase() === "g" ? "DeviceGray" : "DeviceCMYK";
      side.emitted = side.space;
      side.mapped = null;
      out.push(item.raw);
      continue;
    }

    if (op && (PAINT_FILL.has(op) || PAINT_STROKE.has(op) || PAINT_BOTH.has(op)) && plan.usesOverprint) {
      const fillOp = PAINT_FILL.has(op) || PAINT_BOTH.has(op) ? !!(state.fill.mapped && state.fill.mapped.overprint) : state.op[0];
      const strokeOp = PAINT_STROKE.has(op) || PAINT_BOTH.has(op) ? !!(state.stroke.mapped && state.stroke.mapped.overprint) : state.op[1];
      if (fillOp !== state.op[0] || strokeOp !== state.op[1]) {
        const key = `PMop${fillOp ? 1 : 0}${strokeOp ? 1 : 0}`;
        usedStates.add(key);
        changed = true;
        out.push(` /${key} gs`);
        state.op = [fillOp, strokeOp];
      }
    }
    out.push(item.raw);
  }
  return { text: changed ? out.join("") : text, changed, usedSpots, usedStates };
}

function initialSide() {
  return { space: "DeviceGray", emitted: "DeviceGray", mapped: null };
}

function cloneState(state) {
  return { fill: { ...state.fill }, stroke: { ...state.stroke }, op: state.op.slice(), ctm: state.ctm };
}

// Builds a lookup from the mapping list the UI keeps. `black` is "pure" for K 100,
// "rich" for K 100 with rich black in large areas, or "auto" to leave black to the profile.
export function buildPlan(mappings, options) {
  const byHex = new Map();
  for (const m of mappings || []) {
    if (!m || !m.hex) continue;
    const entry = { overprint: !!m.overprint };
    if (m.spot && m.spot.name) {
      entry.spot = { name: m.spot.name, key: "PMsp" + byHex.size, tint: m.spot.tint == null ? 1 : m.spot.tint, cmyk: m.cmyk };
    } else if (Array.isArray(m.cmyk) && m.cmyk.length === 4) {
      entry.cmyk = m.cmyk.map((v) => Math.max(0, Math.min(1, v)));
    } else if (!entry.overprint) {
      continue;
    }
    byHex.set(m.hex.replace("#", "").toUpperCase(), entry);
  }
  const black = (options && options.black) || "pure";
  const usesOverprint = [...byHex.values()].some((e) => e.overprint);
  return {
    usesOverprint,
    entries: byHex,
    lookup(hex) {
      const entry = byHex.get(hex);
      if (entry && (entry.cmyk || entry.spot)) return entry;
      if (hex !== "000000" || black === "auto") return null;
      return { cmyk: [0, 0, 0, 1], rich: black === "rich" ? RICH_BLACK : null, overprint: !!(entry && entry.overprint) };
    },
  };
}

// Applies a plan to every page and form XObject of a loaded pdf-lib document.
export function rewriteDocumentColors(pdfDoc, plan) {
  const context = pdfDoc.context;
  const done = new Set();
  let streams = 0;

  const spotSpaces = new Map();
  const spotSpace = (spot) => {
    if (spotSpaces.has(spot.key)) return spotSpaces.get(spot.key);
    const cmyk = spot.cmyk && spot.cmyk.length === 4 ? spot.cmyk : [0, 0, 0, 1];
    const fn = context.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: cmyk, N: 1 });
    const ref = context.register(context.obj([PDFName.of("Separation"), PDFName.of(spot.name), PDFName.of("DeviceCMYK"), fn]));
    spotSpaces.set(spot.key, ref);
    return ref;
  };
  const spotsByKey = new Map();
  for (const entry of plan.entries.values()) if (entry.spot) spotsByKey.set(entry.spot.key, entry.spot);

  const ensureDict = (parent, key) => {
    let dict = context.lookup(parent.get(PDFName.of(key)));
    if (!(dict instanceof PDFDict)) {
      dict = context.obj({});
      parent.set(PDFName.of(key), dict);
    }
    return dict;
  };

  const processStream = (streamRef, resources) => {
    const id = streamRef instanceof PDFRef ? streamRef.toString() : null;
    if (id && done.has(id)) return;
    if (id) done.add(id);
    const stream = context.lookup(streamRef);
    if (!(stream instanceof PDFRawStream)) return;
    const colorSpaces = resources ? context.lookup(resources.get(PDFName.of("ColorSpace"))) : null;
    const text = bytesToLatin1(decodePDFRawStream(stream).decode());
    const result = rewriteContent(text, colorSpaces instanceof PDFDict ? colorSpaces : null, context, plan);
    if (result.changed) {
      const replacement = context.flateStream(latin1ToBytes(result.text));
      for (const [key, value] of stream.dict.entries()) {
        const k = key.decodeText();
        if (k !== "Filter" && k !== "Length" && k !== "DecodeParms") replacement.dict.set(key, value);
      }
      if (id) context.assign(streamRef, replacement);
      streams++;
      if (resources) {
        if (result.usedSpots.size) {
          const spaces = ensureDict(resources, "ColorSpace");
          for (const key of result.usedSpots) spaces.set(PDFName.of(key), spotSpace(spotsByKey.get(key)));
        }
        if (result.usedStates.size) {
          const states = ensureDict(resources, "ExtGState");
          for (const key of result.usedStates) {
            const fillOp = key[4] === "1";
            const strokeOp = key[5] === "1";
            states.set(PDFName.of(key), context.obj({ Type: "ExtGState", op: fillOp, OP: strokeOp, OPM: 1 }));
          }
        }
      }
    }
    // Recurse into form XObjects drawn by this stream.
    const xobjects = resources ? context.lookup(resources.get(PDFName.of("XObject"))) : null;
    if (xobjects instanceof PDFDict) {
      for (const [, ref] of xobjects.entries()) {
        const xo = context.lookup(ref);
        if (xo instanceof PDFRawStream && context.lookup(xo.dict.get(PDFName.of("Subtype"))) === PDFName.of("Form")) {
          const own = context.lookup(xo.dict.get(PDFName.of("Resources")));
          processStream(ref, own instanceof PDFDict ? own : resources);
        }
      }
    }
  };

  for (const page of pdfDoc.getPages()) {
    const node = page.node;
    const resources = node.Resources();
    const contents = node.get(PDFName.of("Contents"));
    const resolved = context.lookup(contents);
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) processStream(resolved.get(i), resources);
    } else if (contents) {
      processStream(contents, resources);
    }
  }
  return { streamsChanged: streams };
}
