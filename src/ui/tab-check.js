// Check tab: preflight results by page and topic, with explanations and one-click fixes.
import { state, update, request, send, isStale } from "./store.js";
import { t, list } from "./i18n.js";
import { h, icon, section } from "./dom.js";

const TOPIC = {
  "font-missing": "fonts",
  "image-low": "images",
  "image-medium": "images",
  "text-small": "text",
  "text-cut": "text",
  "text-margin": "text",
  "line-thin": "lines",
  "edge-trim": "bleed",
  effects: "effects",
  "page-no-bleed": "page",
  "page-no-trim": "page",
};
const TOPICS = ["fonts", "images", "text", "lines", "bleed", "effects", "page"];
const PASSABLE = ["fonts", "images", "text", "lines", "bleed"];

export function issueCounts(issues) {
  const counts = { error: 0, warning: 0, info: 0 };
  issues.forEach((issue) => counts[issue.severity]++);
  return counts;
}

export async function fetchCheck() {
  const result = await request({ type: "check" });
  result.pageIds = result.pages.map((page) => page.id);
  update((s) => (s.check = result));
  return result;
}

export async function runCheck() {
  update((s) => (s.busy = "check"));
  try {
    return await fetchCheck();
  } catch (error) {
    send({ type: "notify", text: error.message, error: true });
    return null;
  } finally {
    update((s) => (s.busy = null));
  }
}

async function fix(issue) {
  try {
    await request({ type: "fix", kind: issue.fix, nodeId: issue.nodeId, pageId: issue.pageId });
  } catch (error) {
    send({ type: "notify", text: error.message, error: true });
  }
  await runCheck();
}

function message(issue) {
  const params = Object.assign({}, issue.params);
  if (params.sides) params.sides = list(params.sides.map((side) => t(`side.${side}`)));
  return t(`issue.${issue.code}`, params);
}

function toggle(key) {
  update((s) => (s.expanded.has(key) ? s.expanded.delete(key) : s.expanded.add(key)));
}

function issueRow(issue) {
  const key = `${issue.nodeId}:${issue.code}`;
  const open = state.expanded.has(key);
  return h(
    "li",
    { class: "issue" },
    h(
      "div",
      { class: "issue-row" },
      h(
        "button",
        { class: "issue-main", type: "button", "data-key": `issue-${key}`, "data-tip": t("check.selectLayer"), onclick: () => send({ type: "select", id: issue.nodeId }) },
        icon(issue.severity, `severity ${issue.severity}`),
        h("span", { class: "issue-text" }, h("span", { text: message(issue) }), h("span", { class: "quiet-text", text: issue.nodeName })),
      ),
      issue.fix && h("button", { class: "secondary", type: "button", "data-key": `fix-${key}`, onclick: () => fix(issue) }, t(`fix.${issue.fix}`)),
      h(
        "button",
        { class: "icon", type: "button", "data-key": `explain-${key}`, "aria-expanded": String(open), "aria-label": t("check.explain"), "data-tip": t("check.explain"), onclick: () => toggle(key) },
        icon("expand", open ? "turned" : ""),
      ),
    ),
    open &&
      h(
        "div",
        { class: "explain" },
        h("p", {}, h("span", { class: "strong", text: t("check.why") }), " ", t(`why.${issue.code}`)),
        h("p", {}, h("span", { class: "strong", text: t("check.how") }), " ", t(`how.${issue.code}`)),
      ),
  );
}

// Issues grouped by topic, and by page when there is more than one.
function results(check) {
  const nodes = [];
  const pages = check.pages.filter((page) => check.issues.some((issue) => issue.pageId === page.id));
  for (const page of pages) {
    const own = check.issues.filter((issue) => issue.pageId === page.id);
    const groups = TOPICS.map((topic) => [topic, own.filter((issue) => TOPIC[issue.code] === topic)]).filter(([, issues]) => issues.length);
    nodes.push(
      section(
        check.pages.length > 1 ? page.name : null,
        null,
        groups.map(([topic, issues]) => h("div", { class: "group" }, h("h3", { text: t(`topic.${topic}`) }), h("ul", { class: "issues" }, issues.map(issueRow)))),
      ),
    );
  }
  const passed = PASSABLE.filter((topic) => !check.issues.some((issue) => TOPIC[issue.code] === topic && issue.severity !== "info"));
  if (passed.length) {
    nodes.push(section(t("check.passed"), null, h("ul", { class: "passed" }, passed.map((topic) => h("li", {}, icon("check"), h("span", { text: t(`pass.${topic}`) }))))));
  }
  return nodes;
}

function summary(check, n) {
  if (!check) return n ? t("check.summaryIdle", { n }) : t("check.summaryNone");
  const counts = issueCounts(check.issues);
  const parts = ["error", "warning", "info"].filter((kind) => counts[kind]).map((kind) => t(`count.${kind}`, { n: counts[kind] }));
  const pages = t("count.pages", { n: check.pages.length });
  return parts.length ? `${parts.join(" · ")} · ${pages}` : t("check.clean", { n: check.pages.length });
}

export function checkView() {
  const check = state.check;
  const n = state.selection.pageIds.length;
  const body = [];
  if (!check && !n) body.push(h("p", { class: "empty", text: t("check.empty") }));
  if (check && isStale(check)) {
    body.push(h("div", { class: "notice" }, h("p", { text: t("stale.selection") }), h("button", { class: "secondary", type: "button", onclick: runCheck }, t("check.again"))));
  }
  if (check) body.push(...results(check));
  return {
    summary: summary(check, n),
    body,
    primary: { label: check ? t("check.again") : t("check.run", { n }), run: runCheck, disabled: !n, busy: state.busy === "check" },
  };
}
