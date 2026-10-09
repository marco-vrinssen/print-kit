// UI state and the message channel to Figma's main thread. Tabs read the state, change it,
// and call update() to redraw.
import { DEFAULT_SETTINGS } from "../shared/print.js";

export const DEFAULT_EXPORT = { color: "cmyk", profile: "fogra39", outputIntent: true, downsample: "", split: false };

export const state = {
  tab: "create",
  ui: { width: 360, height: 640, lang: "auto", welcomed: false },
  settings: { create: Object.assign({}, DEFAULT_SETTINGS), export: Object.assign({}, DEFAULT_EXPORT) },
  colors: { black: "pure", mappings: [] },
  selection: { selected: 0, frames: 0, printPages: 0, otherPages: 0, pageIds: [] },
  fileName: "Print",
  customProfile: null,

  // Results, each with the page ids it covers, so a changed selection can mark it stale.
  done: null,
  check: null,
  scan: null,
  proof: new Map(),
  pages: [],
  thumbs: new Map(),
  exportName: null,
  confirm: null,
  result: null,

  // What runs right now, and the issues whose explanations are open.
  busy: null,
  job: null,
  expanded: new Set(),
  moreOptions: false,
};

let redraw = () => {};
let opened = () => {};

export function onUpdate(fn) {
  redraw = fn;
}

export function onTabOpen(fn) {
  opened = fn;
}

export function update(change) {
  if (change) change(state);
  redraw();
}

export function goTo(tab) {
  state.tab = tab;
  state.ui.tab = tab;
  saveUi();
  update();
  opened(tab);
}

export function send(message) {
  parent.postMessage({ pluginMessage: message }, "*");
}

// Main-thread replies, by the type of message they answer.
const REPLIES = { check: "checked", scan: "scanned", pages: "pages", fix: "fixed", "load-profile": "profile", create: "created", apply: "applied", export: "export-end" };
const waiting = new Map();
const listeners = new Map();

export function request(message) {
  return new Promise((resolve, reject) => {
    waiting.set(REPLIES[message.type], { resolve, reject });
    send(message);
  });
}

export function listen(type, fn) {
  listeners.set(type, fn);
}

export function receive(message) {
  if (message.type === "error") {
    const pending = waiting.get(REPLIES[message.during]);
    waiting.delete(REPLIES[message.during]);
    if (pending) return pending.reject(new Error(message.text));
  }
  const pending = waiting.get(message.type);
  if (pending) {
    waiting.delete(message.type);
    pending.resolve(message);
  }
  const fn = listeners.get(message.type);
  if (fn) fn(message);
}

function debounce(fn, ms) {
  let timer = 0;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

export const saveSettings = debounce(() => send({ type: "save", key: "settings", value: state.settings }), 400);
export const saveUi = debounce(() => send({ type: "save", key: "ui", value: state.ui }), 400);
export const saveColors = debounce(() => send({ type: "save-colors", colors: state.colors }), 400);

// True when the pages a result covers no longer include everything now in scope.
export function isStale(result) {
  return !!result && state.selection.pageIds.some((id) => result.pageIds.indexOf(id) < 0);
}
