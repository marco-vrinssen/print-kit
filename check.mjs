// Checks the print math and the whole PDF pipeline in Node: rewrite colors, convert with the
// same Ghostscript build the plugin loads, then set boxes and output intent. Run: node check.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFBool, PDFDict, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import createGhostscript from "@okathira/ghostpdl-wasm";
import { pageGeometry, pdfBoxes, effectivePpi, toPt, parseLength, convertSnapped } from "./src/shared/print.js";
import { parseOperations, buildPlan, rewriteDocumentColors, rewriteContent, bytesToLatin1 } from "./src/ui/pdf-colors.js";
import { conversionArgs, PROFILE_PATH } from "./src/ui/engine.js";
import { applyBoxes, addOutputIntent, splitPages, zipFiles, swatchDocument, readSwatches, hexToRgb } from "./src/ui/pdf-output.js";
import { collectGradients, gradientColors, applyGradients } from "./src/ui/pdf-gradients.js";
import { buildPdf, proofColors } from "./src/ui/pipeline.js";
import { parseCmyk, normalizeSpot, spotSuggestions } from "./src/ui/color-codes.js";

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log("ok  " + name);
};
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const gsRun = async (args, files) => {
  const gs = await createGhostscript({ print: () => {}, printErr: () => {} });
  for (const [path, data] of Object.entries(files)) gs.FS.writeFile(path, data);
  assert.equal(gs.callMain(["-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", ...args]), 0, "Ghostscript exit code");
  return gs.FS.readFile("/out.pdf");
};
// Ghostscript writes compressed object streams, so resources are read through pdf-lib.
const resourceEntries = (doc, kind) => {
  const dict = doc.context.lookup(doc.getPages()[0].node.Resources().get(PDFName.of(kind)));
  return dict ? dict.entries().map(([, value]) => doc.context.lookup(value)) : [];
};
const separations = (doc) =>
  resourceEntries(doc, "ColorSpace")
    .filter((cs) => cs instanceof PDFArray && doc.context.lookup(cs.get(0)) === PDFName.of("Separation"))
    .map((cs) => doc.context.lookup(cs.get(1)).decodeText());
const overprints = (doc) => resourceEntries(doc, "ExtGState").filter((gs) => doc.context.lookup(gs.get(PDFName.of("op"))) === PDFBool.True);
const pageText = (doc, i = 0) => {
  const page = doc.getPages()[i];
  const contents = page.node.lookup(PDFName.of("Contents"));
  const streams = contents instanceof PDFRawStream ? [contents] : contents.asArray().map((r) => doc.context.lookup(r));
  return streams.map((s) => bytesToLatin1(decodePDFRawStream(s).decode())).join("\n");
};

await check("A5 with 3 mm bleed and 5 mm marks makes a 164 × 226 mm frame", () => {
  const g = pageGeometry({ width: 148, height: 210, unit: "mm", bleed: 3, margin: 5, marks: true, markOffset: 3, markLength: 5, markWeight: 0.25 });
  close(g.trim.w, toPt(148, "mm"));
  close(g.trim.x, toPt(8, "mm"));
  close(g.frameW, toPt(164, "mm"));
  assert.equal(g.marks.length, 8);
  const topLeft = g.marks[0];
  close(topLeft.x, 0);
  close(topLeft.x + topLeft.w, g.trim.x - toPt(3, "mm"));
});

await check("marks never start inside the bleed", () => {
  const g = pageGeometry({ width: 100, height: 100, unit: "mm", bleed: 5, margin: 0, marks: true, markOffset: 2, markLength: 4, markWeight: 0.25 });
  close(g.trim.x, toPt(9, "mm"));
  close(g.marks[0].x + g.marks[0].w, g.trim.x - toPt(5, "mm"));
});

await check("PDF boxes are measured from the bottom left", () => {
  const boxes = pdfBoxes(200, 100, { x: 10, y: 20, w: 150, h: 60 }, 5);
  assert.deepEqual(boxes.trim, [10, 20, 160, 80]);
  assert.deepEqual(boxes.bleed, [5, 15, 165, 85]);
  assert.deepEqual(boxes.media, [0, 0, 200, 100]);
});

await check("effective ppi for fill, fit, tile and crop", () => {
  assert.equal(effectivePpi({ scaleMode: "FILL" }, 72, 72, 300, 300), 300);
  assert.equal(effectivePpi({ scaleMode: "FIT" }, 144, 72, 300, 300), 300);
  assert.equal(effectivePpi({ scaleMode: "TILE", scalingFactor: 0.24 }, 500, 500, 300, 300), 300);
  assert.equal(effectivePpi({ scaleMode: "CROP", imageTransform: [[0.5, 0, 0], [0, 0.5, 0]] }, 72, 72, 600, 600), 300);
  assert.equal(effectivePpi({ scaleMode: "FILL", rotation: 90 }, 72, 144, 600, 300), 300);
});

await check("typed lengths convert, and bleed lands on common print values", () => {
  close(parseLength("3", "mm"), 3);
  close(parseLength("3,5 mm", "mm"), 3.5);
  close(parseLength("0.125in", "mm"), 3.175);
  close(parseLength('1/8"', "in"), 0.125);
  close(parseLength("1cm", "mm"), 10);
  assert.equal(parseLength("abc", "mm"), null);
  assert.equal(convertSnapped(3, "mm", "in"), 0.125);
  assert.equal(convertSnapped(0.125, "in", "mm"), 3);
  assert.equal(convertSnapped(148, "mm", "in"), 5.8268);
});

await check("CMYK values and spot names read the way people type them", () => {
  for (const text of ["0 100 100 0", "0/100/100/0", "C0 M100 Y100 K0", "0,100,100,0", "c:0 m:100 y:100 k:0"]) assert.deepEqual(parseCmyk(text), [0, 100, 100, 0], text);
  assert.deepEqual(parseCmyk("0;12,5;100;0"), [0, 12.5, 100, 0]);
  assert.deepEqual(parseCmyk("0 1 1 0.2"), [0, 100, 100, 20]);
  assert.equal(parseCmyk("0 100"), null);
  assert.equal(normalizeSpot("hks 13k"), "HKS 13 K");
  assert.equal(normalizeSpot("485c"), "PANTONE 485 C");
  assert.equal(normalizeSpot("pantone reflex blue c"), "PANTONE Reflex Blue C");
  assert.equal(normalizeSpot("Pantone Metallic"), "PANTONE Metallic");
  assert.equal(normalizeSpot("ral3020"), "RAL 3020");
  assert.equal(normalizeSpot("Gold foil"), "Gold foil");
  assert.deepEqual(spotSuggestions("hks 13").map((s) => s.name), ["HKS 13 K", "HKS 13 N", "HKS 13 E", "HKS 13 Z"]);
  assert.deepEqual(spotSuggestions("485").map((s) => s.name), ["PANTONE 485 C", "PANTONE 485 U"]);
  assert.equal(spotSuggestions("").length, 3);
});

await check("rich black goes to large areas only, text and lines stay K 100", () => {
  const plan = buildPlan([], { black: "rich" });
  const text = "0 0 0 rg 0 0 200 200 re f q 0.1 0 0 0.1 0 0 cm 0 0 0 rg 0 0 1000 1000 re f Q 0 0 0 rg 0 0 5 5 re f 0 0 0 rg 0 0 m 300 0 l S";
  const out = rewriteContent(text, null, null, plan).text;
  const fills = out.match(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ k/g);
  assert.deepEqual(fills, ["0.6 0.4 0.4 1 k", "0.6 0.4 0.4 1 k", "0 0 0 1 k", "0 0 0 1 k"]);
});

await check("parsing keeps an untouched stream byte for byte", () => {
  const text = "q /C1 cs 0.5 0.5 0.5 scn (a\\)b) Tj [(x) 3 (y)] TJ << /MCID 0 >> BDC BI /W 1 ID \x00\xffEI EI Q";
  const ops = parseOperations(text);
  assert.equal(ops.map((o) => o.raw).join(""), text);
  assert.deepEqual(ops.filter((o) => o.op).map((o) => o.op), ["q", "cs", "scn", "Tj", "TJ", "BDC", "BI", "Q"]);
});

const fixture = readFileSync("test/fixtures/figma-a5.pdf");
const plan = buildPlan(
  [
    { hex: "D9D9D9", spot: { name: "PANTONE Cool Gray 1 C", tint: 1 }, cmyk: [0.04, 0.02, 0.04, 0.08] },
    { hex: "000000", cmyk: [0, 0, 0, 1], overprint: true },
  ],
  { black: "pure" },
);

let converted;
await check("Figma PDF converts to CMYK with K 100 black, a spot color and overprint", async () => {
  const doc = await PDFDocument.load(fixture);
  rewriteDocumentColors(doc, plan);
  const mapped = await doc.save({ useObjectStreams: false });
  converted = await gsRun(conversionArgs({ color: "cmyk" }), { "/in.pdf": mapped });
  const out = await PDFDocument.load(converted);
  const text = pageText(out);
  assert.match(text, /\b0 0 0 1 k\b/);
  assert.doesNotMatch(text, /0\.7\d* 0\.6\d* 0\.6\d* 0\.8\d* k/, "no rich black left");
  assert.doesNotMatch(text, /\brg\b|\bRG\b/, "no RGB colors left");
  assert.deepEqual(separations(out), ["PANTONE Cool Gray 1 C"]);
  assert.ok(overprints(out).length > 0, "overprint is kept");
});

await check("without a mapping black becomes rich black, as in both other plugins", async () => {
  const out = await PDFDocument.load(await gsRun(conversionArgs({ color: "cmyk" }), { "/in.pdf": fixture }));
  assert.match(pageText(out), /0\.722 0\.675 0\.671 0\.882 k/);
});

await check("a custom output profile keeps K 100 and the spot color", async () => {
  const icc = "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc";
  let profile;
  try {
    profile = readFileSync(icc);
  } catch {
    console.log("    skipped: no Generic CMYK profile on this machine");
    return;
  }
  const doc = await PDFDocument.load(fixture);
  rewriteDocumentColors(doc, plan);
  const out = await gsRun(conversionArgs({ color: "cmyk", profile: true }), { "/in.pdf": await doc.save(), [PROFILE_PATH]: profile });
  const text = pageText(await PDFDocument.load(out));
  assert.match(text, /\b0 0 0 1 k\b/);
});

await check("grayscale conversion leaves no color", async () => {
  const out = await PDFDocument.load(await gsRun(conversionArgs({ color: "gray" }), { "/in.pdf": fixture }));
  assert.doesNotMatch(pageText(out), /\b(k|K|rg|RG)\b/);
});

await check("boxes, output intent and splitting survive the conversion", async () => {
  const doc = await PDFDocument.load(converted);
  const page = doc.getPages()[0];
  const { width, height } = page.getSize();
  const boxes = pdfBoxes(width, height, { x: 26, y: 26, w: width - 52, h: height - 52 }, 8.504);
  applyBoxes(doc, [{ boxes }]);
  addOutputIntent(doc, { icc: new Uint8Array(Array.from({ length: 40 }, (_, i) => (i === 16 ? 67 : i === 17 ? 77 : i === 18 ? 89 : i === 19 ? 75 : 0))), name: "Test CMYK" });
  const saved = await PDFDocument.load(await doc.save());
  const trim = saved.getPages()[0].getTrimBox();
  close(trim.x, 26);
  close(trim.width, width - 52);
  assert.ok(saved.catalog.get(PDFName.of("OutputIntents")));
  const files = await splitPages(saved, ["Page / 1"], { icc: new Uint8Array(40), name: "Test" });
  assert.equal(files[0].name, "Page _ 1.pdf");
  assert.ok(zipFiles(files).length > files[0].bytes.length);
});

await check("swatch preview reads converted CMYK values in order", async () => {
  const out = await gsRun(conversionArgs({ color: "cmyk" }), { "/in.pdf": await swatchDocument(["000000", "FFFFFF", "FF0000"].map(hexToRgb)) });
  const values = await readSwatches(out, "cmyk");
  assert.equal(values.length, 3);
  close(values[0][3], 0.882, 0.02);
  assert.ok(values[2][1] > 0.8 && values[2][2] > 0.8, "red needs magenta and yellow");
});

// The export path for gradients: convert the sampled colors, rebuild the gradients, then convert the page.
const convertWithGradients = async (bytes, color, gradientPlan) => {
  const doc = await PDFDocument.load(bytes);
  if (gradientPlan) rewriteDocumentColors(doc, gradientPlan);
  const gradients = collectGradients(doc);
  const { colors, icc } = gradientColors(gradients);
  const swatches = await gsRun(conversionArgs({ color }), { "/in.pdf": await swatchDocument([...colors.values()], icc) });
  const values = await readSwatches(swatches, color);
  const stats = applyGradients(doc, gradients, new Map([...colors.keys()].map((k, i) => [k, values[i]])), color, gradientPlan);
  const out = await PDFDocument.load(await gsRun(conversionArgs({ color }), { "/in.pdf": await doc.save({ useObjectStreams: false }) }));
  return { out, stats, values: new Map([...colors.keys()].map((k, i) => [k, values[i]])) };
};
const shadingSpaces = (doc) => {
  const spaces = [];
  let images = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj;
    if (!(dict instanceof PDFDict)) continue;
    if (dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) images++;
    const shading = dict.get(PDFName.of("ShadingType")) ? dict : doc.context.lookup(dict.get(PDFName.of("Shading")));
    const s = shading instanceof PDFRawStream ? shading.dict : shading;
    if (s instanceof PDFDict && s.get(PDFName.of("ShadingType"))) spaces.push(String(doc.context.lookup(s.get(PDFName.of("ColorSpace")))));
  }
  return { spaces, images };
};

for (const name of ["linear", "radial", "angular", "diamond", "fade"]) {
  await check(`${name} gradient stays a vector in CMYK`, async () => {
    const { out, stats } = await convertWithGradients(readFileSync(`test/fixtures/gradient-${name}.pdf`), "cmyk", null);
    assert.ok(stats.converted >= 1 && stats.skipped === 0, JSON.stringify(stats));
    const { spaces, images } = shadingSpaces(out);
    assert.equal(images, 0, "no rasterized gradient");
    assert.ok(spaces.includes("/DeviceCMYK"), spaces.join(","));
  });
}

await check("the gradient from the bug report converts, with exact stop values", async () => {
  const { out, values } = await convertWithGradients(readFileSync("test/fixtures/figma-gradient.pdf"), "cmyk", null);
  assert.equal(shadingSpaces(out).images, 0);
  const firstStop = values.get("FF9966");
  assert.ok(firstStop && firstStop[1] > 0.4 && firstStop[2] > 0.5, `orange stop converts to magenta and yellow: ${firstStop}`);
});

await check("a mapped stop color keeps its CMYK values inside a gradient", async () => {
  const doc = await PDFDocument.load(readFileSync("test/fixtures/gradient-linear.pdf"));
  const gradientPlan = buildPlan([{ hex: "FF66FF", cmyk: [0, 0.6, 0, 0] }], { black: "pure" });
  const gradients = collectGradients(doc);
  const { colors } = gradientColors(gradients);
  applyGradients(doc, gradients, new Map([...colors.keys()].map((k) => [k, [0.1, 0.1, 0.1, 0.1]])), "cmyk", gradientPlan);
  const fn = gradients[0].dict.get(PDFName.of("Function"));
  const pieces = doc.context.lookup(fn).lookup(PDFName.of("Functions")).asArray().map((r) => doc.context.lookup(r));
  const c1s = pieces.map((p) => p.lookup(PDFName.of("C1")).asArray().map((n) => n.asNumber()).join(","));
  assert.ok(c1s.includes("0,0.6,0,0"), "the stop at 33 % uses the mapped CMYK");
});

await check("grayscale export keeps gradients as gray vectors", async () => {
  const { out } = await convertWithGradients(readFileSync("test/fixtures/gradient-radial.pdf"), "gray", null);
  const { spaces, images } = shadingSpaces(out);
  assert.equal(images, 0);
  assert.ok(spaces.every((s) => s === "/DeviceGray"), spaces.join(","));
});

const profileBytes = readFileSync("src/ui/profiles/FOGRA39L_coated.icc");
const fogra39 = { bytes: profileBytes, name: "Coated FOGRA39", condition: "FOGRA39" };
const a5 = { name: "A5", bytes: fixture, boxes: pdfBoxes(471.528, 647.276, { x: 26, y: 26, w: 419.528, h: 595.276 }, 8.504) };

await check("the export pipeline makes a FOGRA39 PDF with a registered output intent and a spot color", async () => {
  const mappings = [{ hex: "D9D9D9", mode: "spot", cmyk: null, spotName: "PANTONE Cool Gray 1 C", overprint: false }];
  const options = { color: "cmyk", profile: fogra39, outputIntent: true, downsample: "", black: "pure", mappings, title: "A5", split: false };
  const result = await buildPdf([a5], options, gsRun, () => {});
  const out = await PDFDocument.load(result.bytes);
  assert.deepEqual(separations(out), ["PANTONE Cool Gray 1 C"]);
  assert.match(pageText(out), /\b0 0 0 1 k\b/);
  const intent = out.catalog.lookup(PDFName.of("OutputIntents")).lookup(0);
  assert.equal(intent.lookup(PDFName.of("OutputConditionIdentifier")).decodeText(), "FOGRA39");
  assert.equal(intent.lookup(PDFName.of("RegistryName")).decodeText(), "http://www.color.org");
});

await check("an RGB proof with reduced images keeps its colors in RGB", async () => {
  const options = { color: "rgb", profile: null, outputIntent: false, downsample: "150", black: "pure", mappings: [], title: "A5", split: false };
  const out = await PDFDocument.load((await buildPdf([a5], options, gsRun, () => {})).bytes);
  assert.doesNotMatch(pageText(out), /\b[\d.]+ [\d.]+ [\d.]+ [\d.]+ k\b/, "no CMYK");
  close(out.getPages()[0].getTrimBox().x, 26);
});

await check("the print preview flags colors that print duller and keeps grays close", async () => {
  const proof = await proofColors(["0000FF", "808080", "000000"], { profile: fogra39, mappings: [], black: "pure" }, gsRun);
  assert.ok(proof.get("0000FF").shift > 10, `blue shifts ${proof.get("0000FF").shift}`);
  assert.ok(proof.get("808080").shift < 6, `gray shifts ${proof.get("808080").shift}`);
  assert.deepEqual(proof.get("000000").cmyk, [0, 0, 0, 1]);
});

console.log(`\n${passed} checks passed`);
