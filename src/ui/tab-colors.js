// Colors tab: how black prints, and for each color whether it converts automatically, gets fixed
// CMYK values or becomes a spot color. The print preview needs the color engine, so it runs
// only when asked.
import { state, update, request, send, saveColors, isStale } from "./store.js";
import { t, num, list } from "./i18n.js";
import { h, icon, section, labelled, numberField, segmented, checkbox, menuButton, combobox, help } from "./dom.js";
import { parseCmyk, spotSuggestions, normalizeSpot, roughCmyk } from "./color-codes.js";
import { hexToRgb } from "./pdf-output.js";
import { proofColors } from "./pipeline.js";
import { runGhostscript, engineLoaded } from "./engine.js";
import { resolveProfile, profileName } from "./profiles.js";

// From this color difference on, the preview flags a color as looking different in print.
const NOTICEABLE = 10;

export async function runScan() {
  update((s) => (s.busy = "scan"));
  try {
    const result = await request({ type: "scan" });
    result.pageIds = state.selection.pageIds.slice();
    update((s) => {
      s.scan = result;
      s.proof = new Map();
    });
  } catch (error) {
    send({ type: "notify", text: error.message, error: true });
  } finally {
    update((s) => (s.busy = null));
  }
}

const mappingOf = (hex) => state.colors.mappings.find((m) => m.hex === hex) || null;

// A change of null makes the color automatic again.
function setMapping(hex, change) {
  update((s) => {
    const current = mappingOf(hex);
    const rest = s.colors.mappings.filter((m) => m.hex !== hex);
    s.colors.mappings = change ? rest.concat(Object.assign({ hex, mode: "cmyk", cmyk: null, spotName: "", overprint: false }, current, change)) : rest;
    s.proof.delete(hex);
  });
  saveColors();
}

const percent = (fractions) => fractions.map((v) => Math.round(v * 1000) / 10);
const cmykText = (values) => ["C", "M", "Y", "K"].map((letter, i) => `${letter}${num(values[i], 0)}`).join(" ");

function setMode(hex, mode) {
  const current = mappingOf(hex);
  const proof = state.proof.get(hex);
  if (mode === "auto") return setMapping(hex, null);
  if (mode === "cmyk") return setMapping(hex, { mode, cmyk: (current && current.cmyk) || (proof ? percent(proof.auto) : roughCmyk(hexToRgb(hex))) });
  setMapping(hex, { mode });
}

function setBlack(black) {
  update((s) => {
    s.colors.black = black;
    s.proof.delete("000000");
  });
  saveColors();
}

function modeOptions() {
  return ["auto", "cmyk", "spot"].map((value) => ({ value, label: t(`mode.${value}`), detail: t(`mode.${value}.detail`) }));
}

// Four percentage fields. Pasting "0/100/100/0" or "C0 M100 Y100 K0" into any of them fills all four.
function cmykFields(hex, values, placeholder, onChange) {
  return h(
    "div",
    { class: "cmyk" },
    ["C", "M", "Y", "K"].map((letter, i) => {
      const field = numberField({
        key: `${hex}-${letter}`,
        prefix: letter,
        value: values ? num(values[i], 1, false) : "",
        placeholder: placeholder ? num(placeholder[i], 0, false) : "",
        label: t("colors.channel", { letter, hex }),
        step: 1,
        parse: (text) => {
          const value = Number(String(text).replace(",", "."));
          return String(text).trim() !== "" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
        },
        onCommit: (value) => onChange(Object.assign([], values || placeholder || [0, 0, 0, 0], { [i]: value })),
      });
      field.querySelector("input").addEventListener("paste", (event) => {
        const all = parseCmyk(event.clipboardData.getData("text"));
        if (!all) return;
        event.preventDefault();
        onChange(all);
      });
      return field;
    }),
  );
}

function overprintBox(hex, mapping) {
  return checkbox({ key: `${hex}-op`, label: t("colors.overprint"), checked: !!mapping.overprint, onChange: (overprint) => setMapping(hex, { overprint }), tip: t("help.overprint") });
}

// Left half as on screen, right half as it will print, once the preview has run.
function swatch(hex, proof) {
  const print = proof ? `rgb(${proof.screen.map((v) => Math.round(v * 255)).join(",")})` : null;
  return h(
    "span",
    { class: "swatch", "data-tip": print ? t("colors.swatchTip") : null },
    h("span", { style: `background:#${hex}` }),
    print && h("span", { style: `background:${print}` }),
  );
}

function autoLine(hex, proof) {
  if (hex === "000000" && state.colors.black !== "auto") return h("p", { class: "note", text: t(`black.short.${state.colors.black}`) });
  if (proof) return h("p", { class: "note", text: t("colors.printsAs", { values: cmykText(percent(proof.cmyk)) }) });
  return null;
}

function colorRow(entry) {
  const hex = entry.hex;
  const mapping = mappingOf(hex);
  const mode = mapping ? mapping.mode : "auto";
  const proof = state.proof.get(hex);
  const kinds = list(entry.kinds.map((kind) => t(`kind.${kind}`)));
  const usage = entry.count ? `${kinds.charAt(0).toUpperCase()}${kinds.slice(1)} · ${entry.count}×` : t("colors.notOnPages");
  const details = [];
  if (mode === "auto") details.push(autoLine(hex, proof));
  if (mode === "cmyk") {
    details.push(cmykFields(hex, mapping.cmyk, null, (cmyk) => setMapping(hex, { cmyk })), overprintBox(hex, mapping));
  }
  if (mode === "spot") {
    details.push(
      labelled(
        t("colors.spotName"),
        combobox({
          key: `${hex}-spot`,
          value: mapping.spotName,
          label: t("colors.spotName"),
          placeholder: t("colors.spotPlaceholder"),
          suggest: (text) => spotSuggestions(text).map((item) => ({ value: item.name, label: item.name, detail: item.note ? t(`spot.${item.note}`) : "" })),
          onCommit: (name) => setMapping(hex, { spotName: normalizeSpot(name) }),
        }),
      ),
      labelled(t("colors.fallback"), cmykFields(hex, mapping.cmyk, proof ? percent(proof.auto) : null, (cmyk) => setMapping(hex, { cmyk })), t("help.fallback")),
      overprintBox(hex, mapping),
    );
  }
  if (proof && proof.shift >= NOTICEABLE && hex !== "000000") details.push(h("p", { class: "flag" }, icon("warning", "severity warning"), h("span", { text: t("colors.shift") })));
  const shown = details.filter(Boolean);
  return h(
    "li",
    { class: "color" },
    h(
      "div",
      { class: "color-head" },
      swatch(hex, proof),
      h("span", { class: "color-name" }, h("span", { text: `#${hex}` }), h("span", { class: "quiet-text", text: usage })),
      menuButton({ key: `mode-${hex}`, value: mode, options: modeOptions(), label: t("colors.modeFor", { hex }), onChange: (value) => setMode(hex, value), className: "mode" }),
    ),
    shown.length ? h("div", { class: "color-detail" }, shown) : null,
  );
}

function gradientRow(gradient) {
  const bar = (colorOf) => `linear-gradient(90deg, ${gradient.stops.map((stop) => `${colorOf(stop)} ${Math.round(stop.position * 100)}%`).join(", ")})`;
  const screen = bar((stop) => `#${stop.hex}${Math.round(stop.alpha * 255).toString(16).padStart(2, "0")}`);
  const proofs = gradient.stops.map((stop) => state.proof.get(stop.hex));
  const print = proofs.every(Boolean) ? bar((stop) => `rgba(${state.proof.get(stop.hex).screen.map((v) => Math.round(v * 255)).join(",")},${stop.alpha})`) : null;
  return h(
    "li",
    { class: "gradient" },
    h("span", { class: "bars", "data-tip": print ? t("colors.swatchTip") : null }, h("span", { style: `background:${screen}` }), print && h("span", { style: `background:${print}` })),
    h("span", { class: "color-name" }, h("span", { text: t(`gradient.${gradient.type}`) }), h("span", { class: "quiet-text", text: `${t("count.stops", { n: gradient.stops.length })} · ${gradient.count}×` })),
  );
}

// Scanned colors first, then mappings for colors that aren't on these pages, so they can be reset.
function rows() {
  const scanned = state.scan ? state.scan.colors : [];
  const extra = state.colors.mappings.filter((m) => !scanned.some((c) => c.hex === m.hex)).map((m) => ({ hex: m.hex, count: 0, kinds: [] }));
  return scanned.concat(extra);
}

async function preview() {
  const hexes = rows().map((row) => row.hex);
  if (!hexes.length) return;
  const progress = (fraction) => update((s) => (s.job = fraction < 1 ? { text: t("job.engine", { percent: Math.round(fraction * 100) }), progress: fraction } : { text: t("job.preview") }));
  update((s) => {
    s.busy = "proof";
    s.job = { text: t("job.preview") };
  });
  try {
    const profile = await resolveProfile();
    const gs = (args, files) => runGhostscript(args, files, progress);
    const proof = await proofColors(hexes, { profile, mappings: state.colors.mappings, black: state.colors.black }, gs);
    update((s) => (s.proof = proof));
  } catch (error) {
    send({ type: "notify", text: error.message, error: true });
  } finally {
    update((s) => {
      s.busy = null;
      s.job = null;
    });
  }
}

function summary(scan, n) {
  if (!scan) return n ? t("colors.summaryIdle", { n }) : t("check.summaryNone");
  const parts = [t("count.colors", { n: scan.colors.length })];
  if (scan.gradients.length) parts.push(t("count.gradients", { n: scan.gradients.length }));
  parts.push(t(`black.summary.${state.colors.black}`));
  return parts.join(" · ");
}

export function colorsView() {
  const scan = state.scan;
  const n = state.selection.pageIds.length;
  const black = state.colors.black;
  const body = [
    section(
      t("colors.black"),
      help(t("help.black")),
      segmented({
        key: "black",
        label: t("colors.black"),
        value: black,
        options: ["pure", "rich", "auto"].map((value) => ({ value, label: t(`black.${value}`) })),
        onChange: setBlack,
      }),
      h("p", { class: "note", text: t(`black.text.${black}`) }),
    ),
  ];
  if (scan && isStale(scan)) body.push(h("div", { class: "notice" }, h("p", { text: t("stale.selection") }), h("button", { class: "secondary", type: "button", onclick: runScan }, t("colors.scanAgain"))));
  const entries = rows();
  if (entries.length) body.push(section(t("colors.colors"), null, h("ul", { class: "colors" }, entries.map(colorRow))));
  else if (scan) body.push(h("p", { class: "empty", text: t("colors.none") }));
  else if (!n) body.push(h("p", { class: "empty", text: t("check.empty") }));
  if (scan && scan.gradients.length) body.push(section(t("colors.gradients"), null, h("ul", { class: "colors" }, scan.gradients.map(gradientRow)), h("p", { class: "note", text: t("colors.gradientNote") })));
  if (scan && scan.images) body.push(h("p", { class: "note", text: t("colors.images", { n: scan.images }) }));

  const status = state.proof.size ? t("colors.proofFor", { profile: profileName(state.settings.export.profile) }) : engineLoaded() ? "" : t("colors.engineNote");
  return {
    summary: summary(scan, n),
    body,
    status,
    primary: { label: t("colors.preview"), run: preview, disabled: !entries.length, busy: state.busy === "proof" },
  };
}
