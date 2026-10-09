// Export tab: which pages go into the file and in what order, the output, and the run itself:
// check, render, convert, save.
import { fromPt } from "../shared/print.js";
import { state, update, request, send, listen, saveSettings, goTo } from "./store.js";
import { t, num } from "./i18n.js";
import { h, icon, section, labelled, segmented, checkbox, menuButton, textField, $ } from "./dom.js";
import { fetchCheck } from "./tab-check.js";
import { buildPdf } from "./pipeline.js";
import { runGhostscript } from "./engine.js";
import { BUILT_IN, resolveProfile, profileName, iccSpace } from "./profiles.js";
import { safeName } from "./pdf-output.js";

// Outputs set several options at once; "More options" shows each of them.
const OUTPUTS = {
  offset: { color: "cmyk", outputIntent: true, downsample: "" },
  digital: { color: "cmyk", outputIntent: true, downsample: "300" },
  proof: { color: "rgb", outputIntent: false, downsample: "150" },
};

const options = () => state.settings.export;

function change(values) {
  update((s) => {
    Object.assign(s.settings.export, values);
    s.result = null;
  });
  saveSettings();
}

function currentOutput() {
  return Object.keys(OUTPUTS).find((key) => Object.keys(OUTPUTS[key]).every((option) => options()[option] === OUTPUTS[key][option])) || null;
}

// Keeps the order and choices for pages still in scope; new pages join at the end.
export async function loadPages() {
  const reply = await request({ type: "pages" });
  update((s) => {
    const kept = s.pages.filter((p) => reply.pages.some((q) => q.id === p.id)).map((p) => Object.assign(reply.pages.find((q) => q.id === p.id), { include: p.include }));
    const added = reply.pages.filter((q) => !s.pages.some((p) => p.id === q.id)).map((q) => Object.assign(q, { include: true }));
    s.pages = kept.concat(added);
  });
  const missing = state.pages.filter((p) => !state.thumbs.has(p.id)).map((p) => p.id);
  if (missing.length) send({ type: "thumbs", ids: missing });
}

listen("thumb", (message) => update((s) => s.thumbs.set(message.id, URL.createObjectURL(new Blob([message.bytes], { type: "image/png" })))));

export function clearThumbs() {
  state.thumbs.forEach((url) => URL.revokeObjectURL(url));
  state.thumbs.clear();
}

function movePage(from, to) {
  update((s) => {
    const [page] = s.pages.splice(from, 1);
    s.pages.splice(Math.max(0, Math.min(s.pages.length, to)), 0, page);
  });
}

// Rows reorder by dragging, or with Alt and the arrow keys on a row's checkbox.
let dragFrom = -1;

function pageRow(page, index) {
  const thumb = state.thumbs.get(page.id);
  const size = `${num(fromPt(page.w, page.unit), 1)} × ${num(fromPt(page.h, page.unit), 1)} ${page.unit}`;
  const row = h(
    "li",
    { class: "page", draggable: "true" },
    h("input", {
      type: "checkbox",
      checked: page.include,
      "data-key": `page-${page.id}`,
      "aria-label": t("export.include", { name: page.name }),
      "aria-description": t("export.reorder"),
      onchange: (event) => update(() => (page.include = event.target.checked)),
      onkeydown: (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        movePage(index, index + (event.key === "ArrowUp" ? -1 : 1));
      },
    }),
    h("span", { class: "thumb" }, thumb ? h("img", { src: thumb, alt: "" }) : null),
    h("span", { class: "color-name" }, h("span", { text: page.name }), h("span", { class: "quiet-text", text: size })),
    icon("grip", "grip"),
  );
  row.addEventListener("dragstart", (event) => {
    dragFrom = index;
    event.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    dragFrom = -1;
    row.classList.remove("dragging");
  });
  row.addEventListener("dragover", (event) => {
    if (dragFrom < 0) return;
    event.preventDefault();
    const box = row.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    const after = row.classList.contains("drop-after");
    const to = index + (after ? 1 : 0) - (dragFrom < index ? 1 : 0);
    if (dragFrom >= 0) movePage(dragFrom, to);
  });
  return row;
}

function fileName() {
  const included = state.pages.filter((p) => p.include);
  return state.exportName || (included.length === 1 ? included[0].name : state.fileName);
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = h("a", { href: url, download: name });
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 2000);
}

async function renderPages(ids, onPage) {
  const pages = [];
  listen("export-page", (message) => {
    pages.push(message);
    onPage(pages.length);
  });
  await request({ type: "export", ids });
  return pages;
}

// Errors from the check stop the export once, until "Export anyway".
async function runExport(confirmed) {
  const ids = state.pages.filter((p) => p.include).map((p) => p.id);
  if (!ids.length) return;
  const color = options().color;
  const steps = ["check", "render"].concat(color === "rgb" && !options().downsample ? [] : ["convert"], ["save"]);
  const step = (name, detail, progress) =>
    update((s) => (s.job = { text: t("job.step", { i: steps.indexOf(name) + 1, n: steps.length, step: t(`job.${name}`) }) + (detail ? ` · ${detail}` : ""), progress }));
  update((s) => {
    s.busy = "export";
    s.result = null;
    s.confirm = null;
  });
  try {
    if (!confirmed) {
      step("check");
      const check = await fetchCheck();
      const errors = check.issues.filter((issue) => issue.severity === "error" && ids.indexOf(issue.pageId) >= 0).length;
      if (errors) return update((s) => (s.confirm = { errors }));
    }
    step("render", t("job.page", { i: 1, n: ids.length }));
    const pages = await renderPages(ids, (i) => step("render", t("job.page", { i: Math.min(i + 1, ids.length), n: ids.length })));
    const profile = color === "cmyk" ? await resolveProfile() : null;
    const gs = (args, files) => runGhostscript(args, files, (f) => step("convert", f < 1 ? t("job.engine", { percent: Math.round(f * 100) }) : "", f < 1 ? f : undefined));
    const name = safeName(fileName());
    const pdf = await buildPdf(pages, Object.assign({}, options(), { profile, black: state.colors.black, mappings: state.colors.mappings, title: name }), gs, (next) => step(next));
    const file = `${name}.${pdf.ext}`;
    download(pdf.bytes, file, pdf.type);
    update((s) => (s.result = { file, size: pdf.bytes.length, pages: pages.length, color, profile: profile && profileName(options().profile), gradients: pdf.gradients }));
    send({ type: "notify", text: t("export.saved", { file }) });
  } catch (error) {
    send({ type: "notify", text: error.message, error: true });
  } finally {
    update((s) => {
      s.busy = null;
      s.job = null;
    });
  }
}

export async function loadProfileFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const space = iccSpace(bytes);
  if (space !== "CMYK") return send({ type: "notify", text: space ? t("profile.notCmyk", { space }) : t("profile.notIcc"), error: true });
  const name = file.name.replace(/\.(icc|icm)$/i, "");
  state.customProfile = { name, bytes };
  send({ type: "save", key: "profile", value: { name, data: bytes } });
  change({ profile: "custom" });
}

function megabytes(bytes) {
  return bytes < 1e6 ? `${num(bytes / 1e3, 0)} KB` : `${num(bytes / 1e6, 1)} MB`;
}

function resultNote(r) {
  const parts = [t("count.pages", { n: r.pages }), r.color === "cmyk" ? `CMYK · ${r.profile}` : t(`color.${r.color}`), megabytes(r.size)];
  const notes = [];
  if (r.gradients.converted) notes.push(t("export.gradientsKept", { n: r.gradients.converted }));
  if (r.gradients.skipped) notes.push(t("export.gradientsRaster", { n: r.gradients.skipped }));
  return h(
    "div",
    { class: "notice" },
    icon("check", "done"),
    h("div", {}, h("p", { class: "strong", text: t("export.saved", { file: r.file }) }), h("p", { class: "note", text: parts.join(" · ") }), notes.map((text) => h("p", { class: "note", text }))),
  );
}

function confirmNote(confirm) {
  return h(
    "div",
    { class: "notice" },
    icon("error", "severity error"),
    h(
      "div",
      {},
      h("p", { text: t("export.errors", { n: confirm.errors }) }),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "secondary", type: "button", onclick: () => goTo("check") }, t("export.review")),
        h("button", { class: "secondary", type: "button", onclick: () => runExport(true) }, t("export.anyway")),
      ),
    ),
  );
}

function profileMenu() {
  const items = BUILT_IN.map((p) => ({ value: p.id, label: t(`profile.${p.id}`), detail: t(`profile.${p.id}.detail`) }));
  if (state.customProfile) items.push({ value: "custom", label: state.customProfile.name, detail: t("profile.custom.detail") });
  items.push({ separator: true }, { value: "load", label: t("profile.load") });
  return menuButton({
    key: "profile",
    value: options().profile,
    options: items,
    label: t("export.profile"),
    onChange: (value) => (value === "load" ? $("profile-file").click() : change({ profile: value })),
  });
}

function moreOptions(o) {
  return [
    labelled(
      t("export.color"),
      segmented({ key: "color", label: t("export.color"), value: o.color, options: ["cmyk", "gray", "rgb"].map((value) => ({ value, label: t(`color.${value}`) })), onChange: (color) => change({ color }) }),
    ),
    o.color === "cmyk" && checkbox({ key: "intent", label: t("export.intent"), checked: o.outputIntent, onChange: (outputIntent) => change({ outputIntent }), tip: t("help.intent") }),
    labelled(
      t("export.images"),
      menuButton({
        key: "downsample",
        value: o.downsample,
        label: t("export.images"),
        options: ["", "300", "150"].map((value) => ({ value, label: t(`images.${value || "keep"}`) })),
        onChange: (downsample) => change({ downsample }),
      }),
    ),
    labelled(
      t("export.file"),
      segmented({ key: "split", label: t("export.file"), value: o.split ? "split" : "single", options: ["single", "split"].map((value) => ({ value, label: t(`file.${value}`) })), onChange: (value) => change({ split: value === "split" }) }),
    ),
  ];
}

function outputSection(o) {
  const output = currentOutput();
  return section(
    t("export.output"),
    null,
    segmented({ key: "output", label: t("export.output"), value: output, options: Object.keys(OUTPUTS).map((value) => ({ value, label: t(`output.${value}`) })), onChange: (value) => change(OUTPUTS[value]) }),
    h("p", { class: "note", text: t(`output.${output || "custom"}.text`) }),
    o.color === "cmyk" && labelled(t("export.profile"), profileMenu(), t("help.profile")),
    h(
      "button",
      { class: "disclosure", type: "button", "aria-expanded": String(state.moreOptions), "data-key": "more", onclick: () => update((s) => (s.moreOptions = !s.moreOptions)) },
      icon("expand", state.moreOptions ? "turned" : ""),
      t("export.more"),
    ),
    state.moreOptions && h("div", { class: "stack" }, moreOptions(o)),
  );
}

function summary(included) {
  if (!state.pages.length) return t("check.summaryNone");
  const output = currentOutput();
  const parts = [t("export.pagesOf", { k: included, n: state.pages.length }), t(`output.${output || "custom"}`)];
  if (options().color === "cmyk") parts.push(profileName(options().profile));
  return parts.join(" · ");
}

export function exportView() {
  const o = options();
  const included = state.pages.filter((p) => p.include).length;
  const body = [
    state.confirm && confirmNote(state.confirm),
    state.result && resultNote(state.result),
    state.pages.length
      ? section(t("export.pages"), null, h("ul", { class: "pages" }, state.pages.map(pageRow)))
      : h("p", { class: "empty", text: t("check.empty") }),
    outputSection(o),
    section(t("export.fileName"), null, textField({ key: "filename", value: fileName(), label: t("export.fileName"), suffix: o.split && included > 1 ? ".zip" : ".pdf", onCommit: (value) => update((s) => (s.exportName = value || null)) })),
  ];
  return {
    summary: summary(included),
    body,
    primary: { label: t("export.run", { n: included }), run: () => runExport(false), disabled: !included, busy: state.busy === "export" },
  };
}
