// Print Kit main thread: routes UI messages and keeps settings.
// Settings live in this machine's client storage; color mappings live in the file,
// so everyone who opens the file exports the same colors.
import { createPages, applyToSelection } from "./create.js";
import { checkPages, fixIssue, scanColors } from "./inspect.js";
import { exportPages, sendThumbnails } from "./export.js";
import { selectionSummary, listPages } from "./pages.js";

const STORAGE = { settings: "printkit:settings", ui: "printkit:ui", profile: "printkit:profile" };
const COLORS_KEY = "printkit:colors";
const DEFAULT_SIZE = { width: 360, height: 640 };

const post = (message) => figma.ui.postMessage(message);

// Older files stored a black switch instead of the black choice.
function readColors() {
  let stored = null;
  try {
    stored = JSON.parse(figma.root.getPluginData(COLORS_KEY) || "null");
  } catch (e) {
    stored = null;
  }
  const colors = stored || { mappings: [] };
  return { black: colors.black || (colors.blackToK === false ? "auto" : "pure"), mappings: colors.mappings || [] };
}

async function init() {
  const profile = await figma.clientStorage.getAsync(STORAGE.profile);
  post({
    type: "init",
    settings: (await figma.clientStorage.getAsync(STORAGE.settings)) || {},
    ui: (await figma.clientStorage.getAsync(STORAGE.ui)) || {},
    command: figma.command,
    profile: profile ? { name: profile.name } : null,
    colors: readColors(),
    selection: selectionSummary(),
    fileName: figma.root.name,
  });
}

// Selection updates run outside the message handler, so they catch their own errors.
function postSelection() {
  try {
    post({ type: "selection", selection: selectionSummary() });
  } catch (error) {
    post({ type: "error", text: error && error.message ? error.message : String(error), during: "selection" });
  }
}

async function handle(message) {
  switch (message.type) {
    case "ready":
      return init();
    case "save":
      return message.value == null ? figma.clientStorage.deleteAsync(STORAGE[message.key]) : figma.clientStorage.setAsync(STORAGE[message.key], message.value);
    case "save-colors":
      return figma.root.setPluginData(COLORS_KEY, JSON.stringify(message.colors));
    case "load-profile":
      return post({ type: "profile", profile: (await figma.clientStorage.getAsync(STORAGE.profile)) || null });
    case "create":
      return post({ type: "created", count: createPages(message.settings, message.names) });
    case "apply":
      return post(Object.assign({ type: "applied" }, applyToSelection(message.settings, message.names)));
    case "check":
      return post(Object.assign({ type: "checked" }, await checkPages()));
    case "fix":
      return post({ type: "fixed", ok: await fixIssue(message.kind, message.nodeId, message.pageId) });
    case "scan":
      return post(Object.assign({ type: "scanned" }, scanColors()));
    case "pages":
      return post({ type: "pages", pages: listPages() });
    case "thumbs":
      return sendThumbnails(message.ids, post);
    case "export":
      return exportPages(message.ids, post);
    case "select": {
      const node = await figma.getNodeByIdAsync(message.id);
      if (node && node.type !== "DOCUMENT" && node.type !== "PAGE") {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
      return;
    }
    case "notify":
      figma.notify(message.text, { error: !!message.error });
      return;
    case "resize":
      figma.ui.resize(Math.round(message.width), Math.round(message.height));
      return;
  }
}

async function start() {
  const ui = (await figma.clientStorage.getAsync(STORAGE.ui)) || {};
  figma.showUI(__html__, { width: ui.width || DEFAULT_SIZE.width, height: ui.height || DEFAULT_SIZE.height, themeColors: true });
  figma.ui.onmessage = async (message) => {
    try {
      await handle(message);
    } catch (error) {
      post({ type: "error", text: error && error.message ? error.message : String(error), during: message.type });
    }
  };
  figma.on("selectionchange", postSelection);
  figma.on("currentpagechange", postSelection);
}

start();
