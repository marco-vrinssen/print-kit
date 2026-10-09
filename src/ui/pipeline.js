// The export pipeline and the print preview. Neither touches the UI, so check.mjs runs them
// with the same Ghostscript build. `gs(args, files)` runs Ghostscript once and returns /out.pdf.
import { PDFDocument } from "pdf-lib";
import { REGISTRATION_HEX } from "../shared/print.js";
import { buildPlan, rewriteDocumentColors } from "./pdf-colors.js";
import { conversionArgs, PROFILE_PATH } from "./engine.js";
import { mergePages, applyBoxes, addOutputIntent, setInfo, splitPages, zipFiles, swatchDocument, readSwatches, hexToRgb } from "./pdf-output.js";
import { collectGradients, gradientColors, applyGradients } from "./pdf-gradients.js";
import { deltaE } from "./color-codes.js";

// Mappings as the UI keeps them, { hex, mode: "cmyk" | "spot", cmyk: percentages or null,
// spotName, overprint }, turned into what the color rewriter takes. A spot color without its
// own values falls back to the converted color, and one without a name yet stays automatic.
// Crop marks print on every plate.
export function planMappings(mappings, converted) {
  const list = mappings.filter((m) => (m.mode === "spot" ? m.spotName : m.cmyk)).map((m) => ({
    hex: m.hex,
    cmyk: m.cmyk ? m.cmyk.map((v) => v / 100) : converted.get(m.hex) || [0, 0, 0, 1],
    spot: m.mode === "spot" && m.spotName ? { name: m.spotName, tint: 1 } : null,
    overprint: !!m.overprint,
  }));
  list.push({ hex: REGISTRATION_HEX, spot: { name: "All", tint: 1 }, cmyk: [1, 1, 1, 1] });
  return list;
}

const withProfile = (profile, pdf) => (profile ? { "/in.pdf": pdf, [PROFILE_PATH]: profile.bytes } : { "/in.pdf": pdf });

// Builds the print file from rendered pages. Options: color ("cmyk", "gray" or "rgb"),
// profile ({ bytes, name, condition }), outputIntent, downsample, black, mappings, title, split.
// onStep(name) reports "convert" and "save" as they start. RGB skips Ghostscript unless
// images are to be reduced.
export async function buildPdf(pages, options, gs, onStep) {
  let doc = await mergePages(pages);
  let intent = null;
  let gradientStats = { converted: 0, skipped: 0 };

  if (options.color !== "rgb") {
    onStep("convert");
    const profile = options.color === "cmyk" ? options.profile : null;
    const args = (extra) => conversionArgs(Object.assign({ color: options.color, profile: !!profile }, extra));

    // One swatch run converts gradient colors, and spot colors that have no values of their
    // own, exactly like the artwork. Ghostscript would rasterize RGB gradients, so they are
    // rebuilt in the target space before the main conversion.
    const gradients = collectGradients(doc);
    const { colors, icc } = gradientColors(gradients);
    const mappings = options.color === "cmyk" ? options.mappings : [];
    mappings.filter((m) => m.mode === "spot" && !m.cmyk && !colors.has(m.hex)).forEach((m) => colors.set(m.hex, hexToRgb(m.hex)));
    let converted = new Map();
    if (colors.size) {
      const values = await readSwatches(await gs(args(), withProfile(profile, await swatchDocument([...colors.values()], icc))), options.color);
      converted = new Map([...colors.keys()].map((hex, i) => [hex, values[i]]));
    }
    const plan = options.color === "cmyk" ? buildPlan(planMappings(mappings, converted), { black: options.black }) : null;
    if (plan) rewriteDocumentColors(doc, plan);
    if (gradients.length) gradientStats = applyGradients(doc, gradients, converted, options.color, plan);

    doc = await PDFDocument.load(await gs(args({ downsample: options.downsample }), withProfile(profile, await doc.save({ useObjectStreams: false }))));
    if (profile && options.outputIntent) intent = { icc: profile.bytes, name: profile.name, condition: profile.condition };
  } else if (options.downsample) {
    onStep("convert");
    doc = await PDFDocument.load(await gs(conversionArgs({ color: "keep", downsample: options.downsample }), { "/in.pdf": await doc.save({ useObjectStreams: false }) }));
  }

  onStep("save");
  applyBoxes(doc, pages);
  if (intent) addOutputIntent(doc, intent);
  if (options.split && pages.length > 1) {
    const files = await splitPages(doc, pages.map((p) => p.name), intent);
    return { bytes: zipFiles(files), ext: "zip", type: "application/zip", gradients: gradientStats };
  }
  setInfo(doc, options.title);
  return { bytes: await doc.save(), ext: "pdf", type: "application/pdf", gradients: gradientStats };
}

// Print preview of colors: the CMYK values each prints with, mapped values included, and how
// those look on screen. Returns hex -> { cmyk, auto, screen, shift } with fractions and ΔE.
export async function proofColors(hexes, options, gs) {
  const profile = options.profile;
  const auto = await readSwatches(await gs(conversionArgs({ color: "cmyk", profile: !!profile }), withProfile(profile, await swatchDocument(hexes.map(hexToRgb)))), "cmyk");
  const plan = buildPlan(planMappings(options.mappings, new Map(hexes.map((hex, i) => [hex, auto[i]]))), { black: options.black });
  const printed = hexes.map((hex, i) => {
    const entry = plan.lookup(hex);
    return entry ? entry.cmyk || entry.spot.cmyk : auto[i];
  });
  const screen = await readSwatches(await gs(conversionArgs({ color: "rgb", profile: !!profile }), withProfile(profile, await swatchDocument(printed))), "rgb");
  return new Map(hexes.map((hex, i) => [hex, { cmyk: printed[i], auto: auto[i], screen: screen[i], shift: deltaE(hexToRgb(hex), screen[i]) }]));
}
