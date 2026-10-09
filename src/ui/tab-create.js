// Create tab: new print pages in a format, or print copies of selected frames, with bleed,
// safe area and crop marks. Selected print pages are updated in place.
import { PRESETS, roundFor, parseLength, convertSnapped, toPt, fromPt } from "../shared/print.js";
import { state, update, request, send, saveSettings, goTo } from "./store.js";
import { t, num, has } from "./i18n.js";
import { h, section, labelled, numberField, segmented, checkbox, openMenu } from "./dom.js";
import { pageDiagram } from "./diagram.js";

const LENGTHS = ["bleed", "margin", "markOffset", "markLength"];

// Limits in millimeters, so typos can't make a 5 m bleed.
const LIMITS_MM = { width: [1, 5000], height: [1, 5000], bleed: [0, 25], margin: [0, 100], markOffset: [0, 25], markLength: [0, 25] };

const settings = () => state.settings.create;

function change(values) {
  update((s) => {
    Object.assign(s.settings.create, values);
    s.done = null;
  });
  saveSettings();
}

export function presetLabel(preset) {
  return has(`format.${preset.id}`) ? t(`format.${preset.id}`) : preset.label;
}

// The preset a size matches, in either orientation.
function matchPreset(s) {
  return PRESETS.find((p) => p.unit === s.unit && ((p.width === s.width && p.height === s.height) || (p.width === s.height && p.height === s.width))) || null;
}

export function formatName(s) {
  const preset = matchPreset(s);
  if (!preset) return `${num(s.width)} × ${num(s.height)} ${s.unit}`;
  const rotated = preset.width !== preset.height && preset.width !== s.width;
  return rotated ? t(s.width > s.height ? "format.landscape" : "format.portrait", { name: presetLabel(preset) }) : presetLabel(preset);
}

const length = (value, unit) => `${num(value, unit === "in" ? 4 : 2)}\u00a0${unit}`;

// Presets come in their natural orientation; bleed and marks move to the preset's unit.
function choosePreset(preset) {
  const s = settings();
  const next = { preset: preset.id, unit: preset.unit, width: preset.width, height: preset.height };
  for (const key of LENGTHS) next[key] = convertSnapped(s[key], s.unit, preset.unit);
  change(next);
}

function setUnit(unit) {
  const s = settings();
  const next = { unit, width: roundFor(fromPt(toPt(s.width, s.unit), unit), unit), height: roundFor(fromPt(toPt(s.height, s.unit), unit), unit) };
  for (const key of LENGTHS) next[key] = convertSnapped(s[key], s.unit, unit);
  change(next);
}

function setOrientation(value) {
  const s = settings();
  if ((value === "landscape") !== s.width > s.height) change({ width: s.height, height: s.width });
}

function clampLength(key, value, unit) {
  const [min, max] = LIMITS_MM[key].map((mm) => fromPt(toPt(mm, "mm"), unit));
  return roundFor(Math.max(min, Math.min(max, value)), unit);
}

function lengthField(key, label, prefix) {
  const s = settings();
  return numberField({
    key,
    label,
    prefix,
    value: num(s[key], 4, false),
    suffix: s.unit,
    step: s.unit === "in" ? 0.125 : 1,
    parse: (text) => parseLength(text, s.unit),
    onCommit: (value) => change({ [key]: clampLength(key, value, s.unit) }),
  });
}

function weightField(s) {
  return numberField({
    key: "markWeight",
    label: t("create.markWeight"),
    value: num(s.markWeight, 2, false),
    suffix: "pt",
    step: 0.05,
    parse: (text) => parseLength(text, "pt"),
    onCommit: (value) => change({ markWeight: Math.round(Math.max(0.1, Math.min(2, value)) * 100) / 100 }),
  });
}

function pagesField(s) {
  return numberField({
    key: "pages",
    label: t("create.pages"),
    value: String(s.pages),
    step: 1,
    parse: (text) => (/^\s*\d+\s*$/.test(text) ? Number(text) : null),
    onCommit: (value) => change({ pages: Math.max(1, Math.min(200, Math.round(value))) }),
  });
}

function tile(preset, pressed) {
  const ratio = preset.width / preset.height;
  const w = ratio >= 1 ? 20 : 20 * ratio;
  const hh = ratio >= 1 ? 20 / ratio : 20;
  return h(
    "button",
    { class: "tile", type: "button", "aria-pressed": String(pressed), "data-key": `tile-${preset.id}`, onclick: () => choosePreset(preset) },
    h("span", { class: "tile-shape", style: `width:${w}px;height:${hh}px` }),
    h("span", { class: "tile-label", text: presetLabel(preset) }),
  );
}

// The formats without a tile, in a menu. When one of them is current, the tile shows its name.
function moreTile(current) {
  const button = h(
    "button",
    { class: "tile", type: "button", "aria-pressed": String(!!current), "aria-haspopup": "menu", "data-key": "tile-more" },
    h("span", { class: "tile-shape more", "aria-hidden": "true" }),
    h("span", { class: "tile-label", text: current ? presetLabel(current) : t("create.more") }),
  );
  button.addEventListener("click", () => {
    const items = PRESETS.filter((p) => !p.tile).map((p) => ({ value: p.id, label: presetLabel(p), detail: `${num(p.width)} × ${num(p.height)} ${p.unit}`, checked: p === current }));
    openMenu(button, items, (id) => choosePreset(PRESETS.find((p) => p.id === id)));
  });
  return button;
}

function formatSection(s) {
  const current = matchPreset(s);
  return section(
    t("create.format"),
    null,
    h("div", { class: "tiles" }, PRESETS.filter((p) => p.tile).map((p) => tile(p, p === current)), moreTile(current && !current.tile ? current : null)),
    h("div", { class: "grid" }, lengthField("width", t("create.width"), t("create.w")), lengthField("height", t("create.height"), t("create.h"))),
    h(
      "div",
      { class: "grid" },
      segmented({ key: "unit", label: t("create.unit"), value: s.unit, options: [{ value: "mm", label: "mm" }, { value: "in", label: "in" }], onChange: setUnit }),
      segmented({
        key: "orientation",
        label: t("create.orientation"),
        value: s.width > s.height ? "landscape" : "portrait",
        options: [
          { value: "portrait", label: t("create.portrait"), icon: "portrait" },
          { value: "landscape", label: t("create.landscape"), icon: "landscape" },
        ],
        onChange: setOrientation,
      }),
    ),
    h("div", { class: "grid" }, labelled(t("create.pages"), pagesField(s))),
  );
}

function selectionSection(sel) {
  const lines = [sel.frames ? t("create.framesSelected", { n: sel.frames }) : t("create.noFrames")];
  if (sel.printPages) lines.push(t("create.printPagesSelected", { n: sel.printPages }));
  if (sel.otherPages) lines.push(t("create.otherSkipped", { n: sel.otherPages }));
  return section(t("create.selection"), null, h("p", { class: "note", text: t("create.selectionHelp") }), h("p", { text: lines.join(" ") }));
}

function bleedSection(s, fromSelection) {
  const legend = [
    { kind: "trim", title: fromSelection ? t("diagram.trimFrame") : t("diagram.trim", { value: `${num(s.width)} × ${num(s.height)} ${s.unit}` }), text: t("diagram.trimText") },
    s.bleed > 0 && { kind: "bleed", title: t("diagram.bleed", { value: length(s.bleed, s.unit) }), text: t("diagram.bleedText") },
    s.margin > 0 && { kind: "safe", title: t("diagram.safe", { value: length(s.margin, s.unit) }), text: t("diagram.safeText") },
    s.marks && { kind: "marks", title: t("diagram.marks"), text: t("diagram.marksText") },
  ].filter(Boolean);
  return section(
    t("create.bleedMarks"),
    null,
    pageDiagram(fromSelection ? 0.75 : s.width / s.height, { bleed: s.bleed > 0, margin: s.margin > 0, marks: s.marks }, legend),
    h("div", { class: "grid" }, labelled(t("create.bleed"), lengthField("bleed", t("create.bleed")), t("help.bleed")), labelled(t("create.margin"), lengthField("margin", t("create.margin")), t("help.margin"))),
    checkbox({ key: "marks", label: t("create.marks"), checked: s.marks, onChange: (marks) => change({ marks }), tip: t("help.marks") }),
    s.marks &&
      h(
        "div",
        { class: "grid three" },
        labelled(t("create.markOffset"), lengthField("markOffset", t("create.markOffset")), t("help.markOffset")),
        labelled(t("create.markLength"), lengthField("markLength", t("create.markLength"))),
        labelled(t("create.markWeight"), weightField(s)),
      ),
  );
}

function doneText(done) {
  const lines = [];
  if (done.count) lines.push(t("done.created", { n: done.count }));
  if (done.prepared) lines.push(t("done.prepared", { n: done.prepared }));
  if (done.updated) lines.push(t("done.updated", { n: done.updated }));
  if (done.skipped) lines.push(t("create.otherSkipped", { n: done.skipped }));
  return lines.join(" ");
}

// What happened, and what to do next.
function doneNote(done) {
  return h(
    "div",
    { class: "notice" },
    h("p", { text: `${doneText(done)} ${t("done.next")}` }),
    h("button", { class: "secondary", type: "button", onclick: () => goTo("check") }, t("done.check")),
  );
}

function layerNames(s) {
  return { format: formatName(s), page: t("layer.page"), print: t("layer.print"), marks: t("layer.marks") };
}

async function run(type) {
  update((s) => (s.busy = type));
  try {
    const reply = await request({ type, settings: settings(), names: layerNames(settings()) });
    update((s) => (s.done = reply));
    send({ type: "notify", text: doneText(reply) || t("create.noFrames") });
  } catch (error) {
    send({ type: "notify", text: error.message, error: true });
  } finally {
    update((s) => (s.busy = null));
  }
}

function summary(s, sel) {
  const parts = [];
  if (s.mode === "new") {
    const name = formatName(s);
    parts.push(name);
    if (matchPreset(s)) parts.push(`${num(s.width)} × ${num(s.height)} ${s.unit}`);
  } else {
    parts.push(sel.frames ? t("create.framesSelected", { n: sel.frames }) : t("create.summaryNoFrames"));
  }
  if (s.bleed > 0) parts.push(t("summary.bleed", { value: length(s.bleed, s.unit) }));
  if (s.marks) parts.push(t("summary.marks"));
  return parts.join(" · ");
}

function primary(s, sel) {
  if (s.mode === "new") return { label: t("create.create", { n: s.pages }), run: () => run("create") };
  const n = sel.frames - sel.otherPages;
  if (!n) return { label: t("create.selectFrames"), disabled: true };
  return { label: t(sel.printPages === n ? "create.update" : "create.prepare", { n }), run: () => run("apply") };
}

export function createView() {
  const s = settings();
  const sel = state.selection;
  const fromSelection = s.mode === "selection";
  return {
    summary: summary(s, sel),
    body: [
      state.done && doneNote(state.done),
      h(
        "div",
        { class: "block" },
        segmented({
          key: "mode",
          label: t("create.mode"),
          value: s.mode,
          options: [
            { value: "new", label: t("create.new") },
            { value: "selection", label: t("create.fromSelection") },
          ],
          onChange: (mode) => change({ mode }),
        }),
      ),
      fromSelection ? selectionSection(sel) : formatSection(s),
      bleedSection(s, fromSelection),
    ],
    primary: Object.assign(primary(s, sel), { busy: state.busy === "create" || state.busy === "apply" }),
  };
}
