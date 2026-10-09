// Converts gradients to CMYK or gray vectors before Ghostscript runs. Ghostscript rasterizes
// RGB shadings when it converts colors, at about 90 ppi, which bands in print. Shadings that
// are already CMYK or gray pass through it untouched, so Print Kit converts them itself:
// it samples linear and radial gradients, reads mesh gradients vertex by vertex, converts every
// sampled color exactly with the export profile, and writes the gradient back as a vector.
import { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { bytesToLatin1, hexOf } from "./pdf-colors.js";

const SAMPLES = 32;

const num = (context, value, fallback) => {
  const v = context.lookup(value);
  return v instanceof PDFNumber ? v.asNumber() : fallback;
};
const nums = (context, value) => {
  const v = context.lookup(value);
  return v instanceof PDFArray ? v.asArray().map((x) => num(context, x, 0)) : null;
};
const dictOf = (obj) => (obj instanceof PDFRawStream ? obj.dict : obj);

// The RGB profile of a shading, or null when the shading is not RGB.
function rgbSpace(context, space) {
  const s = context.lookup(space);
  if (s instanceof PDFName) return s.decodeText() === "DeviceRGB" ? { icc: null } : null;
  if (s instanceof PDFArray && s.size() > 1) {
    const family = context.lookup(s.get(0));
    const profile = context.lookup(s.get(1));
    if (family instanceof PDFName && family.decodeText() === "ICCBased" && profile instanceof PDFRawStream) {
      return num(context, profile.dict.get(PDFName.of("N")), 0) === 3 ? { icc: decodePDFRawStream(profile).decode() } : null;
    }
    if (family instanceof PDFName && family.decodeText() === "CalRGB") return { icc: null };
  }
  return null;
}

// PostScript calculator functions (FunctionType 4), as Figma writes them for gradient stops.
function parsePostScript(text) {
  const tokens = text.replace(/%[^\n\r]*/g, " ").match(/[{}]|[^\s{}]+/g) || [];
  let i = 0;
  const block = () => {
    const items = [];
    while (i < tokens.length) {
      const token = tokens[i++];
      if (token === "{") items.push({ proc: block() });
      else if (token === "}") return items;
      else items.push(/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(token) ? Number(token) : token);
    }
    return items;
  };
  const top = block();
  return top.length === 1 && top[0].proc ? top[0].proc : top;
}

const OPS = {
  add: (s) => s.push(s.pop() + s.pop()),
  sub: (s) => { const b = s.pop(); s.push(s.pop() - b); },
  mul: (s) => s.push(s.pop() * s.pop()),
  div: (s) => { const b = s.pop(); s.push(s.pop() / b); },
  idiv: (s) => { const b = s.pop(); s.push(Math.trunc(s.pop() / b)); },
  mod: (s) => { const b = s.pop(); s.push(s.pop() % b); },
  neg: (s) => s.push(-s.pop()),
  abs: (s) => s.push(Math.abs(s.pop())),
  ceiling: (s) => s.push(Math.ceil(s.pop())),
  floor: (s) => s.push(Math.floor(s.pop())),
  round: (s) => s.push(Math.round(s.pop())),
  truncate: (s) => s.push(Math.trunc(s.pop())),
  cvi: (s) => s.push(Math.trunc(s.pop())),
  cvr: () => {},
  sqrt: (s) => s.push(Math.sqrt(s.pop())),
  exp: (s) => { const e = s.pop(); s.push(Math.pow(s.pop(), e)); },
  ln: (s) => s.push(Math.log(s.pop())),
  log: (s) => s.push(Math.log10(s.pop())),
  sin: (s) => s.push(Math.sin((s.pop() * Math.PI) / 180)),
  cos: (s) => s.push(Math.cos((s.pop() * Math.PI) / 180)),
  atan: (s) => { const den = s.pop(); const a = (Math.atan2(s.pop(), den) * 180) / Math.PI; s.push(a < 0 ? a + 360 : a); },
  eq: (s) => s.push(s.pop() === s.pop()),
  ne: (s) => s.push(s.pop() !== s.pop()),
  gt: (s) => { const b = s.pop(); s.push(s.pop() > b); },
  ge: (s) => { const b = s.pop(); s.push(s.pop() >= b); },
  lt: (s) => { const b = s.pop(); s.push(s.pop() < b); },
  le: (s) => { const b = s.pop(); s.push(s.pop() <= b); },
  and: (s) => { const b = s.pop(); const a = s.pop(); s.push(typeof a === "boolean" ? a && b : a & b); },
  or: (s) => { const b = s.pop(); const a = s.pop(); s.push(typeof a === "boolean" ? a || b : a | b); },
  xor: (s) => { const b = s.pop(); const a = s.pop(); s.push(typeof a === "boolean" ? a !== b : a ^ b); },
  not: (s) => { const a = s.pop(); s.push(typeof a === "boolean" ? !a : ~a); },
  true: (s) => s.push(true),
  false: (s) => s.push(false),
  dup: (s) => s.push(s[s.length - 1]),
  pop: (s) => s.pop(),
  exch: (s) => { const b = s.pop(); const a = s.pop(); s.push(b, a); },
  copy: (s) => { const n = s.pop(); s.push(...s.slice(s.length - n)); },
  index: (s) => { const n = s.pop(); s.push(s[s.length - 1 - n]); },
  roll: (s) => {
    const j = s.pop();
    const n = s.pop();
    if (!n) return;
    const part = s.splice(s.length - n, n);
    const shift = ((j % n) + n) % n;
    s.push(...part.slice(n - shift), ...part.slice(0, n - shift));
  },
};

function runPostScript(program, stack) {
  for (const item of program) {
    if (typeof item === "number") stack.push(item);
    else if (item.proc) stack.push(item);
    else if (item === "if") { const proc = stack.pop(); if (stack.pop()) runPostScript(proc.proc, stack); }
    else if (item === "ifelse") { const no = stack.pop(); const yes = stack.pop(); runPostScript((stack.pop() ? yes : no).proc, stack); }
    else if (OPS[item]) OPS[item](stack);
    else throw new Error(`Unsupported operator ${item} in a gradient function`);
  }
}

// Builds an evaluator for a PDF function of one input, and reports the inputs where
// its pieces meet, so samples can land exactly on gradient stops.
function makeFunction(context, value) {
  const obj = context.lookup(value);
  if (obj instanceof PDFArray) {
    const parts = obj.asArray().map((v) => makeFunction(context, v));
    return { eval: (t) => parts.flatMap((p) => p.eval(t)), breaks: parts.flatMap((p) => p.breaks) };
  }
  const dict = dictOf(obj);
  if (!(dict instanceof PDFDict)) throw new Error("Missing gradient function");
  const type = num(context, dict.get(PDFName.of("FunctionType")), -1);
  const domain = nums(context, dict.get(PDFName.of("Domain"))) || [0, 1];
  const clampIn = (t) => Math.min(domain[1], Math.max(domain[0], t));
  if (type === 2) {
    const c0 = nums(context, dict.get(PDFName.of("C0"))) || [0];
    const c1 = nums(context, dict.get(PDFName.of("C1"))) || [1];
    const n = num(context, dict.get(PDFName.of("N")), 1);
    return { eval: (t) => { const x = Math.pow(clampIn(t), n); return c0.map((v, i) => v + x * (c1[i] - v)); }, breaks: [] };
  }
  if (type === 3) {
    const fns = context.lookup(dict.get(PDFName.of("Functions"))).asArray().map((v) => makeFunction(context, v));
    const bounds = nums(context, dict.get(PDFName.of("Bounds"))) || [];
    const encode = nums(context, dict.get(PDFName.of("Encode"))) || [];
    const edges = [domain[0], ...bounds, domain[1]];
    return {
      eval: (t) => {
        const x = clampIn(t);
        let k = bounds.findIndex((b) => x < b);
        if (k < 0) k = fns.length - 1;
        const [a, b] = [edges[k], edges[k + 1]];
        const [e0, e1] = [encode[2 * k], encode[2 * k + 1]];
        return fns[k].eval(b === a ? e0 : e0 + ((x - a) / (b - a)) * (e1 - e0));
      },
      breaks: bounds,
    };
  }
  if (type === 4 && obj instanceof PDFRawStream) {
    const code = bytesToLatin1(decodePDFRawStream(obj).decode());
    const program = parsePostScript(code);
    const outputs = (nums(context, dict.get(PDFName.of("Range"))) || [0, 1, 0, 1, 0, 1]).length / 2;
    const breaks = [];
    code.replace(/([+-]?\d*\.?\d+)\s+(?:gt|lt|ge|le)\b/g, (_, n) => breaks.push(Number(n)));
    return {
      eval: (t) => {
        const stack = [clampIn(t)];
        runPostScript(program, stack);
        return stack.slice(0, outputs).map(Number);
      },
      breaks,
    };
  }
  throw new Error(`Gradient function type ${type} is not supported`);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function samplePositions(domain, breaks) {
  const [t0, t1] = domain;
  const set = new Set([t0, t1]);
  for (let i = 1; i < SAMPLES; i++) set.add(t0 + ((t1 - t0) * i) / SAMPLES);
  for (const b of breaks) if (b > t0 && b < t1) set.add(b);
  return [...set].sort((a, b) => a - b);
}

// Reads a mesh shading's vertices when they are byte aligned, as Figma writes them.
function readMesh(context, stream) {
  const dict = stream.dict;
  const type = num(context, dict.get(PDFName.of("ShadingType")), 0);
  if (dict.get(PDFName.of("Function"))) return null;
  const flagBits = type === 4 ? num(context, dict.get(PDFName.of("BitsPerFlag")), 8) : 0;
  const coordBits = num(context, dict.get(PDFName.of("BitsPerCoordinate")), 0);
  const compBits = num(context, dict.get(PDFName.of("BitsPerComponent")), 0);
  const decode = nums(context, dict.get(PDFName.of("Decode")));
  if ((type !== 4 && type !== 5) || flagBits % 8 || coordBits % 8 || ![8, 16].includes(compBits) || !decode || decode.length !== 10) return null;
  const data = decodePDFRawStream(stream).decode();
  const fb = flagBits / 8;
  const cb = coordBits / 8;
  const kb = compBits / 8;
  const stride = fb + 2 * cb + 3 * kb;
  const max = Math.pow(2, compBits) - 1;
  const vertices = [];
  for (let at = 0; at + stride <= data.length; at += stride) {
    const color = [0, 1, 2].map((c) => {
      let raw = 0;
      for (let b = 0; b < kb; b++) raw = raw * 256 + data[at + fb + 2 * cb + c * kb + b];
      return clamp01(decode[4 + 2 * c] + (raw / max) * (decode[5 + 2 * c] - decode[4 + 2 * c]));
    });
    vertices.push({ head: data.subarray(at, at + fb + 2 * cb), color });
  }
  return { vertices, headBytes: fb + 2 * cb, coords: decode.slice(0, 4) };
}

// Finds every RGB gradient in the document, with the colors it needs converted.
export function collectGradients(doc) {
  const context = doc.context;
  const found = [];
  const seen = new Set();
  const consider = (ref, obj) => {
    const dict = dictOf(obj);
    if (!(dict instanceof PDFDict) || !dict.get(PDFName.of("ShadingType")) || seen.has(obj)) return;
    seen.add(obj);
    const space = rgbSpace(context, dict.get(PDFName.of("ColorSpace")));
    if (!space) return;
    const type = num(context, dict.get(PDFName.of("ShadingType")), 0);
    try {
      if ((type === 2 || type === 3) && dict.get(PDFName.of("Function"))) {
        const fn = makeFunction(context, dict.get(PDFName.of("Function")));
        const domain = nums(context, dict.get(PDFName.of("Domain"))) || [0, 1];
        const samples = samplePositions(domain, fn.breaks).map((t) => ({ t, color: fn.eval(t).slice(0, 3).map(clamp01) }));
        found.push({ kind: "function", dict, domain, samples, icc: space.icc });
      } else if (obj instanceof PDFRawStream && (type === 4 || type === 5)) {
        const mesh = readMesh(context, obj);
        if (mesh) found.push({ kind: "mesh", ref, stream: obj, mesh, icc: space.icc });
        else found.push({ kind: "skipped", reason: "mesh layout" });
      } else {
        found.push({ kind: "skipped", reason: `shading type ${type}` });
      }
    } catch (error) {
      found.push({ kind: "skipped", reason: error.message });
    }
  };
  // Shadings can sit directly inside a pattern inside a resource dictionary, so nested
  // dictionaries and arrays are searched too. References are skipped there, because every
  // indirect object is visited on its own.
  const visitNested = (value) => {
    if (value instanceof PDFArray) value.asArray().forEach(visitNested);
    const dict = dictOf(value);
    if (!(dict instanceof PDFDict)) return;
    if (dict.get(PDFName.of("ShadingType")) && !(value instanceof PDFRawStream)) consider(null, dict);
    for (const [, child] of dict.entries()) if (!(child instanceof PDFRef)) visitNested(child);
  };
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    consider(ref, obj);
    visitNested(obj);
  }
  return found;
}

// The unique colors all gradients need, as 8-bit hex keys and floats, plus the RGB profile.
export function gradientColors(gradients) {
  const colors = new Map();
  let icc = null;
  for (const g of gradients) {
    if (g.kind === "skipped") continue;
    icc = icc || g.icc;
    const list = g.kind === "function" ? g.samples.map((s) => s.color) : g.mesh.vertices.map((v) => v.color);
    for (const c of list) {
      const hex = hexOf(c[0], c[1], c[2]);
      if (!colors.has(hex)) colors.set(hex, c);
    }
  }
  return { colors, icc };
}

// Writes every gradient back in the target space. `converted` maps hex keys to CMYK or gray values.
export function applyGradients(doc, gradients, converted, target, plan) {
  const context = doc.context;
  const space = PDFName.of(target === "gray" ? "DeviceGray" : "DeviceCMYK");
  const valueOf = (c) => {
    const hex = hexOf(c[0], c[1], c[2]);
    if (target === "cmyk" && plan) {
      const entry = plan.lookup(hex);
      if (entry) return entry.cmyk || (entry.spot && entry.spot.cmyk) || converted.get(hex);
    }
    return converted.get(hex);
  };
  let done = 0;
  for (const g of gradients) {
    if (g.kind === "function") {
      const values = g.samples.map((s) => valueOf(s.color));
      if (values.some((v) => !v)) continue;
      const pieces = [];
      for (let i = 0; i < values.length - 1; i++) pieces.push(context.obj({ FunctionType: 2, Domain: [0, 1], C0: values[i], C1: values[i + 1], N: 1 }));
      const fn =
        pieces.length === 1
          ? pieces[0]
          : context.obj({ FunctionType: 3, Domain: g.domain, Functions: pieces, Bounds: g.samples.slice(1, -1).map((s) => s.t), Encode: pieces.flatMap(() => [0, 1]) });
      g.dict.set(PDFName.of("ColorSpace"), space);
      g.dict.set(PDFName.of("Function"), fn);
      g.dict.delete(PDFName.of("Background"));
      done++;
    } else if (g.kind === "mesh" && g.ref) {
      const { vertices, headBytes, coords } = g.mesh;
      const values = vertices.map((v) => valueOf(v.color));
      if (values.some((v) => !v)) continue;
      const comps = values[0].length;
      const data = new Uint8Array(vertices.length * (headBytes + comps));
      vertices.forEach((v, i) => {
        const at = i * (headBytes + comps);
        data.set(v.head, at);
        values[i].forEach((c, j) => (data[at + headBytes + j] = Math.round(clamp01(c) * 255)));
      });
      const dict = {};
      for (const [key, value] of g.stream.dict.entries()) {
        const k = key.decodeText();
        if (!["Filter", "DecodeParms", "Length", "ColorSpace", "BitsPerComponent", "Decode", "Background"].includes(k)) dict[k] = value;
      }
      Object.assign(dict, { ColorSpace: space, BitsPerComponent: 8, Decode: [...coords, ...values[0].flatMap(() => [0, 1])] });
      context.assign(g.ref, context.flateStream(data, dict));
      done++;
    }
  }
  return { converted: done, skipped: gradients.filter((g) => g.kind === "skipped").length };
}
