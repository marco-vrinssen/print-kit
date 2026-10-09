// DOM helpers and the Figma UI3 controls the tabs are built from: fields, segmented controls,
// checkboxes, menus, a combobox and tooltips. Figma has no component library for plugins, so
// these match its look by hand and keep native elements underneath for keyboard and screen readers.

export const $ = (id) => document.getElementById(id);

export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return node;
}

// UI3 icons on a 24 px grid with 1 px strokes.
const ICONS = {
  chevron: '<path d="m9.5 11 2.5 2.5 2.5-2.5" fill="none" stroke="currentColor"/>',
  expand: '<path d="m10.5 9.5 2.5 2.5-2.5 2.5" fill="none" stroke="currentColor"/>',
  help: '<circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor"/><path d="M10.6 10.6a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9v.4" fill="none" stroke="currentColor"/><circle cx="12" cy="15" r=".6" fill="currentColor"/>',
  more: '<circle cx="7.5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="16.5" cy="12" r="1" fill="currentColor"/>',
  portrait: '<rect x="8.5" y="6.5" width="7" height="11" rx="1" fill="none" stroke="currentColor"/>',
  landscape: '<rect x="6.5" y="8.5" width="11" height="7" rx="1" fill="none" stroke="currentColor"/>',
  error: '<circle cx="12" cy="12" r="5.5" fill="currentColor"/><path d="M12 9v3.5" stroke="var(--figma-color-bg)"/><circle cx="12" cy="14.8" r=".7" fill="var(--figma-color-bg)"/>',
  warning: '<path d="M12 6.5 18 17H6z" fill="currentColor" stroke="currentColor" stroke-linejoin="round"/><path d="M12 10.5v3" stroke="var(--figma-color-bg)"/><circle cx="12" cy="15.3" r=".6" fill="var(--figma-color-bg)"/>',
  info: '<circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor"/><path d="M12 11v4" stroke="currentColor"/><circle cx="12" cy="9.2" r=".6" fill="currentColor"/>',
  check: '<path d="m8 12 2.5 2.5L16 9" fill="none" stroke="currentColor"/>',
  grip: '<g fill="currentColor"><circle cx="10" cy="8" r="1"/><circle cx="14" cy="8" r="1"/><circle cx="10" cy="12" r="1"/><circle cx="14" cy="12" r="1"/><circle cx="10" cy="16" r="1"/><circle cx="14" cy="16" r="1"/></g>',
};

export function icon(name, className) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("width", "24");
  node.setAttribute("height", "24");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("aria-hidden", "true");
  if (className) node.setAttribute("class", className);
  node.innerHTML = ICONS[name];
  return node;
}

export function section(title, extra, ...children) {
  return h("section", { class: "section" }, title ? h("div", { class: "section-head" }, h("h2", { text: title }), extra) : null, ...children);
}

// A labelled control: a short label above, the control below.
export function labelled(text, control, tip) {
  return h("div", { class: "labelled" }, h("span", { class: "label" }, text, tip ? help(tip) : null), control);
}

// A Figma number field. `parse` turns typed text into a number or null; arrow keys step by
// `step`, ten times with Shift. Enter commits and leaves the field, Escape restores it.
// Cmd or Ctrl with Enter passes through, to run the tab's main action.
export function numberField({ key, value, prefix, suffix, parse, step, onCommit, label, placeholder }) {
  const input = h("input", { class: "bare", type: "text", inputmode: "decimal", value, "data-key": key, "aria-label": label, placeholder, autocomplete: "off", spellcheck: "false" });
  const commit = () => {
    const next = parse(input.value);
    if (next === null) input.value = value;
    else if (String(next) !== String(parse(value))) onCommit(next);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const current = parse(input.value);
      if (current === null || !step) return;
      const delta = (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
      onCommit(Math.round((current + delta) * 10000) / 10000);
    } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      input.blur();
    } else if (event.key === "Escape") {
      input.value = value;
      input.blur();
    }
  });
  input.addEventListener("change", commit);
  input.addEventListener("focus", () => input.select());
  return h("label", { class: "field input" }, prefix ? h("span", { class: "affix", text: prefix }) : null, input, suffix ? h("span", { class: "affix", text: suffix }) : null);
}

export function textField({ key, value, label, placeholder, suffix, onCommit }) {
  const input = h("input", { class: "bare", type: "text", value, "data-key": key, "aria-label": label, placeholder, autocomplete: "off", spellcheck: "false" });
  input.addEventListener("change", () => onCommit(input.value.trim()));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    input.blur();
  });
  return h("label", { class: "field input" }, input, suffix ? h("span", { class: "affix", text: suffix }) : null);
}

// Radios underneath, so arrow keys and screen readers work as usual. One thumb slides to the
// checked segment. Options take a label or an icon with a label for screen readers.
export function segmented({ key, label, value, options, onChange }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return h(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": label, style: `--count:${options.length};--index:${index}`, "data-checked": options.some((o) => o.value === value) ? "true" : "false" },
    options.map((option) =>
      h(
        "label",
        { "data-tip": option.icon ? option.label : null },
        h("input", { type: "radio", name: key, value: option.value, checked: option.value === value, "data-key": `${key}-${option.value}`, "aria-label": option.icon ? option.label : null, onchange: () => onChange(option.value) }),
        h("span", {}, option.icon ? icon(option.icon) : option.label),
      ),
    ),
  );
}

export function checkbox({ key, label, checked, onChange, tip }) {
  return h(
    "label",
    { class: "check" },
    h("input", { type: "checkbox", checked, "data-key": key, onchange: (event) => onChange(event.target.checked) }),
    h("span", { text: label }),
    tip ? help(tip) : null,
  );
}

// A question mark that explains a setting on hover or focus.
export function help(text) {
  return h("button", { class: "help", type: "button", "aria-label": text, "data-tip": text }, icon("help"));
}

// Menus: one shared popover, styled like Figma's dark menus. A native select would open
// the operating system's menu instead.
let menuOwner = null;
let menuWasOpen = false;

export function menuButton({ key, value, options, onChange, label, className }) {
  const current = options.find((o) => o.value === value);
  const button = h(
    "button",
    { class: `field select ${className || ""}`, type: "button", "data-key": key, "aria-haspopup": "menu", "aria-label": label },
    h("span", { text: current ? current.short || current.label : "" }),
    icon("chevron", "chevron"),
  );
  button.addEventListener("pointerdown", () => (menuWasOpen = menuOwner === button && $("menu").matches(":popover-open")));
  button.addEventListener("click", () => {
    if (menuWasOpen) return (menuWasOpen = false);
    openMenu(button, options.map((o) => Object.assign({ checked: o.value === value }, o)), onChange);
  });
  return button;
}

// Opens the shared menu below `anchor`, or above when there is more room there.
// Items are { value, label, detail, checked } or { separator: true }.
export function openMenu(anchor, items, onPick) {
  const menu = $("menu");
  menuOwner = anchor;
  menu.replaceChildren(
    ...items.map((item) => {
      if (item.separator) return h("div", { role: "separator" });
      const button = h(
        "button",
        { type: "button", role: "menuitemradio", "aria-checked": String(!!item.checked) },
        h("span", { class: "menu-label", text: item.label }),
        item.detail ? h("span", { class: "menu-detail", text: item.detail }) : null,
      );
      button.addEventListener("click", () => {
        menu.hidePopover();
        anchor.focus();
        onPick(item.value);
      });
      return button;
    }),
  );
  menu.showPopover();
  const box = anchor.getBoundingClientRect();
  const below = innerHeight - box.bottom - 8;
  const above = box.top - 8;
  const height = Math.min(menu.scrollHeight, Math.max(below, above));
  const top = below >= height || below >= above ? box.bottom + 4 : box.top - 4 - height;
  Object.assign(menu.style, { top: `${top}px`, left: `${Math.min(box.left, innerWidth - 8 - Math.max(box.width, 160))}px`, minWidth: `${box.width}px`, maxHeight: `${height}px` });
  const focus = menu.querySelector("[aria-checked=true]") || menu.querySelector("button");
  if (focus) focus.focus();
}

function menuKeys(event) {
  const items = [...$("menu").querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  items[Math.max(0, Math.min(items.length - 1, next))].focus();
}

// A text field with suggestions below it. Focus stays in the field; arrow keys move the
// highlight and Enter takes it.
export function combobox({ key, value, label, placeholder, suggest, onCommit }) {
  const input = h("input", { class: "bare", type: "text", value, "data-key": key, "aria-label": label, placeholder, role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", autocomplete: "off", spellcheck: "false" });
  let active = -1;
  let items = [];
  const list = $("suggestions");
  const close = () => {
    if (list.matches(":popover-open")) list.hidePopover();
    input.setAttribute("aria-expanded", "false");
  };
  const show = () => {
    items = suggest(input.value);
    active = -1;
    list.replaceChildren(
      ...items.map((item, i) =>
        h("div", { id: `suggestion-${i}`, role: "option", onpointerdown: (event) => { event.preventDefault(); pick(i); } }, h("span", { class: "menu-label", text: item.label }), item.detail ? h("span", { class: "menu-detail", text: item.detail }) : null),
      ),
    );
    if (!items.length) return close();
    if (!list.matches(":popover-open")) list.showPopover();
    const box = input.closest(".field").getBoundingClientRect();
    Object.assign(list.style, { top: `${box.bottom + 4}px`, left: `${box.left}px`, width: `${box.width}px` });
    input.setAttribute("aria-expanded", "true");
  };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((child, j) => child.setAttribute("aria-selected", String(j === i)));
    input.setAttribute("aria-activedescendant", i >= 0 ? `suggestion-${i}` : "");
  };
  // Leaving the field commits, and keeps the list from opening again after the re-render.
  const pick = (i) => {
    input.value = items[i].value;
    input.blur();
  };
  input.addEventListener("focus", show);
  input.addEventListener("input", show);
  input.addEventListener("blur", () => {
    close();
    if (input.value.trim() !== value) onCommit(input.value.trim());
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) highlight((active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      if (active >= 0) pick(active);
      else input.blur();
    } else if (event.key === "Escape") close();
  });
  return h("label", { class: "field input" }, input);
}

// One tooltip for the whole window, shown after a short pause like Figma's.
let tipTimer = 0;

function showTip(target) {
  const tip = $("tip");
  tip.textContent = target.getAttribute("data-tip");
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  const width = tip.offsetWidth;
  const below = box.bottom + 6 + tip.offsetHeight < innerHeight;
  tip.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, box.left + box.width / 2 - width / 2))}px`;
  tip.style.top = `${below ? box.bottom + 6 : box.top - 6 - tip.offsetHeight}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  $("tip").hidden = true;
}

export function installGlobalHandlers() {
  $("menu").addEventListener("keydown", menuKeys);
  document.addEventListener("pointerover", (event) => {
    const target = event.target.closest("[data-tip]");
    hideTip();
    if (target) tipTimer = setTimeout(() => showTip(target), 500);
  });
  document.addEventListener("focusin", (event) => {
    hideTip();
    if (event.target.matches(".help:focus-visible")) showTip(event.target);
  });
  document.addEventListener("pointerdown", hideTip);
  document.addEventListener("scroll", hideTip, true);
  document.addEventListener("keydown", (event) => event.key === "Escape" && hideTip());
}

// Re-rendering replaces controls, so the focused one is found again by its data-key.
export function replaceKeepingFocus(parent, children) {
  const active = document.activeElement;
  const key = active && parent.contains(active) ? active.getAttribute("data-key") : null;
  parent.replaceChildren(...children);
  if (!key) return;
  const next = parent.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (next) next.focus({ preventScroll: true });
}
