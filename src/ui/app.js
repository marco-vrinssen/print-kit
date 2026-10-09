// Print Kit UI: puts the current tab on screen and handles what all tabs share: the tab bar,
// the summary line, the main action with Enter, the window size and the first-run introduction.
// All PDF work happens in this iframe; the main thread only reads and changes the Figma file.
import { DEFAULT_SETTINGS } from "../shared/print.js";
import { state, update, send, receive, listen, onUpdate, onTabOpen, goTo, saveUi, isStale, DEFAULT_EXPORT } from "./store.js";
import { t, setLanguage, LANGUAGES } from "./i18n.js";
import { $, h, icon, labelled, segmented, replaceKeepingFocus, installGlobalHandlers } from "./dom.js";
import { createView } from "./tab-create.js";
import { checkView, runCheck, issueCounts } from "./tab-check.js";
import { colorsView, runScan } from "./tab-colors.js";
import { exportView, loadPages, clearThumbs, loadProfileFile } from "./tab-export.js";
import { showWelcome } from "./welcome.js";

const TABS = { create: createView, check: checkView, colors: colorsView, export: exportView };
const SIZE = { minWidth: 300, maxWidth: 720, minHeight: 240, maxHeight: 1000 };

let view = null;

function badge(tab) {
  if (tab !== "check" || !state.check) return null;
  const counts = issueCounts(state.check.issues);
  const kind = counts.error ? "error" : counts.warning ? "warning" : null;
  return kind ? h("span", { class: `badge ${kind}`, text: String(counts[kind]), "aria-label": t(`count.${kind}`, { n: counts[kind] }) }) : null;
}

function tabKeys(event) {
  const names = Object.keys(TABS);
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  goTo(names[(names.indexOf(state.tab) + step + names.length) % names.length]);
  $(`tab-${state.tab}`).focus();
}

function renderTabs() {
  return Object.keys(TABS).map((tab) =>
    h(
      "button",
      { role: "tab", id: `tab-${tab}`, type: "button", "aria-selected": String(state.tab === tab), "aria-controls": "panel", tabindex: state.tab === tab ? "0" : "-1", "data-key": `tab-${tab}`, onclick: () => goTo(tab), onkeydown: tabKeys },
      t(`tab.${tab}`),
      badge(tab),
    ),
  );
}

function renderFooter() {
  const job = state.job;
  $("status").replaceChildren(h("span", { text: job ? job.text : view.status || "" }));
  if (job && job.progress !== undefined) $("status").append(h("progress", { value: String(job.progress), max: "1" }));
  const primary = view.primary;
  const button = $("primary");
  button.replaceChildren(h("span", { text: primary.label }), primary.run ? h("kbd", { text: "↵", "aria-hidden": "true" }) : null);
  button.disabled = !!primary.disabled || (!!state.busy && !primary.busy);
  button.classList.toggle("loading", !!primary.busy);
  button.setAttribute("data-tip", t("primary.enter"));
}

function render() {
  view = TABS[state.tab]();
  replaceKeepingFocus($("tabs"), renderTabs());
  $("panel").setAttribute("aria-labelledby", `tab-${state.tab}`);
  $("summary").textContent = view.summary || "";
  replaceKeepingFocus($("content"), view.body.filter(Boolean));
  renderFooter();
  $("settings-button").setAttribute("aria-label", t("settings.open"));
  $("settings-button").setAttribute("data-tip", t("settings.open"));
}

function runPrimary() {
  if (view && view.primary.run && !view.primary.disabled && !state.busy) view.primary.run();
}

// Enter runs the main action unless a field, button or menu has the key. In a field, Enter
// only confirms the value, so a second Enter is needed: typing never starts an export.
// Cmd or Ctrl with Enter confirms the field and runs the action at once.
function onEnter(event) {
  if (event.key !== "Enter" || event.isComposing || event.defaultPrevented) return;
  const target = event.target;
  const inField = target.matches && target.matches("input:not([type=checkbox]):not([type=radio]), textarea");
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    if (inField) target.blur();
    return runPrimary();
  }
  if (inField || (target.closest && target.closest("button, a, dialog, [popover]"))) return;
  event.preventDefault();
  runPrimary();
}

// The window height follows the content, up to the height the user dragged it to.
let dragging = false;
let sentHeight = 0;

function naturalHeight() {
  return ["top", "summary", "content", "footer"].reduce((sum, id) => sum + $(id).offsetHeight, 0);
}

function fit() {
  if (dragging) return;
  const height = Math.round(Math.max(SIZE.minHeight, Math.min(state.ui.height, naturalHeight())));
  if (height === sentHeight) return;
  sentHeight = height;
  send({ type: "resize", width: state.ui.width, height });
}

function installGrip() {
  const grip = $("grip");
  let start = null;
  grip.addEventListener("pointerdown", (event) => {
    grip.setPointerCapture(event.pointerId);
    start = { x: event.screenX, y: event.screenY, width: innerWidth, height: innerHeight };
    dragging = true;
  });
  grip.addEventListener("pointermove", (event) => {
    if (!start) return;
    state.ui.width = Math.round(Math.max(SIZE.minWidth, Math.min(SIZE.maxWidth, start.width + event.screenX - start.x)));
    state.ui.height = Math.round(Math.max(SIZE.minHeight, Math.min(SIZE.maxHeight, start.height + event.screenY - start.y)));
    send({ type: "resize", width: state.ui.width, height: state.ui.height });
  });
  grip.addEventListener("pointerup", () => {
    start = null;
    dragging = false;
    sentHeight = 0;
    saveUi();
    fit();
  });
}

function renderSettings() {
  const languages = [["auto", t("settings.auto")]].concat(LANGUAGES.map(([code]) => [code, code.toUpperCase()]));
  $("settings").replaceChildren(
    labelled(
      t("settings.language"),
      segmented({
        key: "lang",
        label: t("settings.language"),
        value: state.ui.lang,
        options: languages.map(([value, label]) => ({ value, label })),
        onChange: (lang) => {
          state.ui.lang = lang;
          setLanguage(lang);
          saveUi();
          renderSettings();
          update();
        },
      }),
    ),
    h("button", { class: "secondary", type: "button", onclick: () => ($("settings").hidePopover(), openWelcome()) }, t("settings.welcome")),
  );
}

function openWelcome() {
  showWelcome(() => {
    state.ui.welcomed = true;
    saveUi();
  });
}

// A remembered tab with nothing to work on gives way to Create.
function startTab(command, remembered) {
  if (TABS[command]) return command;
  if (remembered && remembered !== "create" && TABS[remembered] && state.selection.pageIds.length) return remembered;
  return "create";
}

// Opening Check or Colors runs them, since that is what the tab is for. A changed selection
// only marks results as outdated, so nothing runs without a click.
onTabOpen((tab) => {
  const pages = state.selection.pageIds.length;
  if (tab === "check" && pages && !state.busy && (!state.check || isStale(state.check))) runCheck();
  if (tab === "colors" && pages && !state.busy && (!state.scan || isStale(state.scan))) runScan();
  if (tab === "export") {
    clearThumbs();
    loadPages();
  }
});

listen("init", (message) => {
  update((s) => {
    Object.assign(s.ui, message.ui);
    s.settings.create = Object.assign({}, DEFAULT_SETTINGS, message.settings.create);
    s.settings.export = Object.assign({}, DEFAULT_EXPORT, message.settings.export);
    s.colors = message.colors;
    s.selection = message.selection;
    s.fileName = message.fileName || "Print";
    s.customProfile = message.profile ? { name: message.profile.name, bytes: null } : null;
    if (s.settings.export.profile === "custom" && !s.customProfile) s.settings.export.profile = DEFAULT_EXPORT.profile;
  });
  setLanguage(state.ui.lang);
  goTo(startTab(message.command, message.ui.tab));
  if (!state.ui.welcomed) openWelcome();
});

listen("selection", (message) => {
  update((s) => (s.selection = message.selection));
  if (state.tab === "export") loadPages();
});

listen("error", (message) => {
  if (message.during === "selection" || message.during === "thumbs") send({ type: "notify", text: message.text, error: true });
});

window.addEventListener("message", (event) => {
  const message = event.data && event.data.pluginMessage;
  if (message) receive(message);
});

onUpdate(render);
installGlobalHandlers();
installGrip();
document.addEventListener("keydown", onEnter);
$("primary").addEventListener("click", runPrimary);
$("settings-button").append(icon("more"));
$("settings").addEventListener("beforetoggle", (event) => event.newState === "open" && renderSettings());
$("profile-file").addEventListener("change", () => {
  const file = $("profile-file").files[0];
  $("profile-file").value = "";
  if (file) loadProfileFile(file);
});
new ResizeObserver(fit).observe($("content"));
new ResizeObserver(fit).observe($("footer"));
setLanguage("auto");
render();

// Ask for the stored settings once this script listens, so the answer can't arrive too early.
send({ type: "ready" });
