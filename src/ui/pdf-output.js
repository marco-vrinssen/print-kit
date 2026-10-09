// Assembles the final PDF: pages, boxes, output intent, metadata, splitting and ZIP.
import { PDFDocument, PDFName, PDFString, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { zipSync } from "fflate";
import { bytesToLatin1 } from "./pdf-colors.js";

export async function mergePages(pages) {
  const doc = await PDFDocument.create();
  for (const page of pages) {
    const source = await PDFDocument.load(page.bytes);
    const [copy] = await doc.copyPages(source, [0]);
    doc.addPage(copy);
  }
  return doc;
}

// Boxes come from the main thread as [llx, lly, urx, ury] in points.
export function applyBoxes(doc, pages) {
  doc.getPages().forEach((page, i) => {
    const { media, bleed, trim } = pages[i].boxes;
    page.setMediaBox(media[0], media[1], media[2] - media[0], media[3] - media[1]);
    page.setCropBox(media[0], media[1], media[2] - media[0], media[3] - media[1]);
    page.setBleedBox(bleed[0], bleed[1], bleed[2] - bleed[0], bleed[3] - bleed[1]);
    page.setTrimBox(trim[0], trim[1], trim[2] - trim[0], trim[3] - trim[1]);
  });
}

// Records the printing condition, so preflight tools and printers know the target profile.
// A registered condition such as FOGRA39 names the ICC registry, as PDF/X expects.
export function addOutputIntent(doc, intent) {
  const { icc, name, condition } = intent;
  const space = String.fromCharCode(icc[16], icc[17], icc[18], icc[19]);
  const profile = doc.context.register(doc.context.flateStream(icc, { N: space === "GRAY" ? 1 : 4 }));
  const entry = doc.context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFX",
    OutputConditionIdentifier: PDFString.of(condition || name),
    Info: PDFString.of(name),
    DestOutputProfile: profile,
  });
  if (condition) entry.set(PDFName.of("RegistryName"), PDFString.of("http://www.color.org"));
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([entry]));
}

export function setInfo(doc, title) {
  doc.setTitle(title);
  doc.setCreator("Print Kit");
  doc.setProducer("Print Kit with pdf-lib and Ghostscript");
}

export function safeName(name) {
  return (name || "Print").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "Print";
}

// One PDF per page, each with its own title and the same output intent.
export async function splitPages(doc, names, intent) {
  const files = [];
  const used = new Map();
  for (let i = 0; i < doc.getPageCount(); i++) {
    const single = await PDFDocument.create();
    const [copy] = await single.copyPages(doc, [i]);
    single.addPage(copy);
    if (intent) addOutputIntent(single, intent);
    setInfo(single, names[i]);
    const base = safeName(names[i]);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    files.push({ name: `${count > 1 ? `${base} ${count}` : base}.pdf`, bytes: await single.save() });
  }
  return files;
}

// PDFs are compressed already, so the ZIP only stores them.
export function zipFiles(files) {
  const entries = {};
  for (const file of files) entries[file.name] = [file.bytes, { level: 0 }];
  return zipSync(entries);
}

export function hexToRgb(hex) {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

// One page per color, so a conversion run shows each color's converted values. Pages keep
// the colors apart even when two of them convert to the same values. With the file's own
// RGB profile, the patches convert exactly like the artwork. Four values make a CMYK patch.
export async function swatchDocument(colors, icc) {
  const doc = await PDFDocument.create();
  const context = doc.context;
  const space = icc ? context.register(context.obj([PDFName.of("ICCBased"), context.register(context.flateStream(icc, { N: 3 }))])) : null;
  for (const color of colors) {
    const page = doc.addPage([20, 20]);
    const values = color.map((v) => String(Math.round(v * 100000) / 100000)).join(" ");
    let content = `${values} ${color.length === 4 ? "k" : "rg"} 0 0 20 20 re f`;
    if (space && color.length === 3) {
      page.node.set(PDFName.of("Resources"), context.obj({ ColorSpace: { CS0: space } }));
      content = `/CS0 cs ${values} scn 0 0 20 20 re f`;
    }
    page.node.set(PDFName.of("Contents"), context.register(context.flateStream(content)));
  }
  return doc.save({ useObjectStreams: false });
}

// Reads the converted fill of every swatch page: four CMYK values, three RGB values, or one
// gray value. Ghostscript leaves out a color that equals the default black, so a missing one
// means black.
export async function readSwatches(bytes, target) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.lookup(PDFName.of("Contents"));
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
    const text = streams
      .filter((s) => s instanceof PDFRawStream)
      .map((s) => bytesToLatin1(decodePDFRawStream(s).decode()))
      .join("\n");
    if (target === "gray") {
      const gray = text.match(/(-?[\d.]+)\s+g\b/);
      return [gray ? Number(gray[1]) : 0];
    }
    if (target === "rgb") {
      const rgb = text.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg\b/);
      if (rgb) return rgb.slice(1, 4).map(Number);
      const gray = text.match(/(-?[\d.]+)\s+g\b/);
      return gray ? [1, 1, 1].map(() => Number(gray[1])) : [0, 0, 0];
    }
    const cmyk = text.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+k\b/);
    if (cmyk) return cmyk.slice(1, 5).map(Number);
    const gray = text.match(/(-?[\d.]+)\s+g\b/);
    return [0, 0, 0, gray ? 1 - Number(gray[1]) : 1];
  });
}
