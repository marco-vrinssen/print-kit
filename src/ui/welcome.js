// The introduction on first run: three small pictures of what Print Kit does.
import { $, h } from "./dom.js";
import { t } from "./i18n.js";

// Drawn with the same classes as the page diagram, so they follow the theme.
const ART = {
  create:
    '<rect x="19" y="5" width="26" height="38" class="d-bleed"/><rect x="22" y="8" width="20" height="32" class="d-trim"/><rect x="25" y="11" width="14" height="26" class="d-safe"/>' +
    '<path d="M22 2v4M42 2v4M22 42v4M42 42v4M13 8h4M47 8h4M13 40h4M47 40h4" class="d-mark"/>',
  check:
    '<circle cx="18" cy="13" r="3" class="a-error"/><rect x="25" y="11.5" width="24" height="3" rx="1.5" class="a-line"/>' +
    '<circle cx="18" cy="24" r="3" class="a-warning"/><rect x="25" y="22.5" width="18" height="3" rx="1.5" class="a-line"/>' +
    '<path d="m15.5 35 2 2 3.5-4" class="a-ok"/><rect x="25" y="33.5" width="21" height="3" rx="1.5" class="a-line"/>',
  export:
    '<rect x="10" y="4" width="44" height="40" rx="2" fill="#fff" stroke="var(--figma-color-border)"/>' +
    '<g style="mix-blend-mode:multiply"><rect x="14" y="8" width="18" height="18" fill="#00aeef"/><rect x="22" y="13" width="18" height="18" fill="#ec008c"/>' +
    '<rect x="30" y="18" width="18" height="18" fill="#fff200"/><rect x="24" y="24" width="12" height="16" fill="#231f20"/></g>',
};

function art(name) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 64 48");
  node.setAttribute("width", "64");
  node.setAttribute("height", "48");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = ART[name];
  return node;
}

export function showWelcome(onClose) {
  const dialog = $("welcome");
  const start = h("button", { class: "primary large", type: "button", onclick: () => dialog.close() }, t("welcome.start"));
  dialog.replaceChildren(
    h("h2", { text: t("welcome.title") }),
    h("p", { class: "note", text: t("welcome.intro") }),
    h(
      "ul",
      { class: "steps" },
      ["create", "check", "export"].map((step) =>
        h("li", {}, art(step), h("span", {}, h("span", { class: "strong", text: t(`welcome.${step}.title`) }), h("span", { class: "note", text: t(`welcome.${step}.text`) }))),
      ),
    ),
    start,
  );
  dialog.onclose = onClose;
  dialog.showModal();
  start.focus();
}
