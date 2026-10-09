(() => {
  // src/shared/print.js
  var PT_PER_UNIT = { mm: 72 / 25.4, cm: 720 / 25.4, in: 72, pt: 1, px: 1 };
  var REGISTRATION_HEX = "010101";
  var REGISTRATION_RGB = { r: 1 / 255, g: 1 / 255, b: 1 / 255 };
  function toPt(value, unit) {
    return (Number(value) || 0) * (PT_PER_UNIT[unit] || PT_PER_UNIT.mm);
  }
  function fromPt(value, unit) {
    return value / (PT_PER_UNIT[unit] || PT_PER_UNIT.mm);
  }
  function roundFor(value, unit) {
    const factor = unit === "in" ? 1e4 : 100;
    return Math.round(value * factor) / factor;
  }
  function pageGeometry(settings) {
    const unit = settings.unit;
    const trimW = toPt(settings.width, unit);
    const trimH = toPt(settings.height, unit);
    const bleed = Math.max(0, toPt(settings.bleed, unit));
    const margin = Math.max(0, toPt(settings.margin, unit));
    const marks = !!settings.marks && toPt(settings.markLength, unit) > 0;
    const markGap = marks ? Math.max(bleed, toPt(settings.markOffset, unit)) : 0;
    const markLength = marks ? toPt(settings.markLength, unit) : 0;
    const markWeight = marks ? Math.max(0.1, Number(settings.markWeight) || 0.25) : 0;
    const outer = marks ? markGap + markLength : bleed;
    return {
      frameW: trimW + 2 * outer,
      frameH: trimH + 2 * outer,
      trim: { x: outer, y: outer, w: trimW, h: trimH },
      bleed,
      margin,
      marks: marks ? cropMarks({ x: outer, y: outer, w: trimW, h: trimH }, markGap, markLength, markWeight) : []
    };
  }
  function cropMarks(trim, gap, length, weight) {
    const half = weight / 2;
    const left = trim.x;
    const right = trim.x + trim.w;
    const top = trim.y;
    const bottom = trim.y + trim.h;
    return [
      { name: "Top left horizontal", x: left - gap - length, y: top - half, w: length, h: weight },
      { name: "Top left vertical", x: left - half, y: top - gap - length, w: weight, h: length },
      { name: "Top right horizontal", x: right + gap, y: top - half, w: length, h: weight },
      { name: "Top right vertical", x: right - half, y: top - gap - length, w: weight, h: length },
      { name: "Bottom left horizontal", x: left - gap - length, y: bottom - half, w: length, h: weight },
      { name: "Bottom left vertical", x: left - half, y: bottom + gap, w: weight, h: length },
      { name: "Bottom right horizontal", x: right + gap, y: bottom - half, w: length, h: weight },
      { name: "Bottom right vertical", x: right - half, y: bottom + gap, w: weight, h: length }
    ];
  }
  function pdfBoxes(frameW, frameH, trim, bleed) {
    const box = (x, y, w, h) => [x, frameH - y - h, x + w, frameH - y].map((v) => Math.round(v * 1e3) / 1e3);
    const media = [0, 0, frameW, frameH].map((v) => Math.round(v * 1e3) / 1e3);
    if (!trim) return { media, trim: media, bleed: media };
    const b = bleed == null ? null : bleed;
    const bleedBox = b == null ? media : box(
      Math.max(0, trim.x - b),
      Math.max(0, trim.y - b),
      Math.min(frameW, trim.x + trim.w + b) - Math.max(0, trim.x - b),
      Math.min(frameH, trim.y + trim.h + b) - Math.max(0, trim.y - b)
    );
    return { media, trim: box(trim.x, trim.y, trim.w, trim.h), bleed: bleedBox };
  }
  function effectivePpi(paint, w, h, imageW, imageH) {
    if (!imageW || !imageH || !w || !h) return null;
    if (paint.scaleMode === "CROP" && paint.imageTransform) {
      const t = paint.imageTransform;
      const sx = Math.hypot(t[0][0], t[1][0]);
      const sy = Math.hypot(t[0][1], t[1][1]);
      return Math.round(Math.min(72 * sx * imageW / w, 72 * sy * imageH / h));
    }
    const quarterTurn = Math.round((paint.rotation || 0) / 90) % 2 !== 0;
    const iw = quarterTurn ? imageH : imageW;
    const ih = quarterTurn ? imageW : imageH;
    let scale;
    if (paint.scaleMode === "TILE") scale = paint.scalingFactor || 1;
    else if (paint.scaleMode === "FIT") scale = Math.min(w / iw, h / ih);
    else scale = Math.max(w / iw, h / ih);
    return Math.round(72 / scale);
  }
  function hexOfColor(color) {
    const to = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
    return (to(color.r) + to(color.g) + to(color.b)).toUpperCase();
  }

  // src/main/pages.js
  var PAGE_KEY = "printkit:page";
  var PART_KEY = "printkit:part";
  var FRAME_TYPES = /* @__PURE__ */ new Set(["FRAME", "COMPONENT", "INSTANCE"]);
  function isFrameLike(node) {
    return FRAME_TYPES.has(node.type);
  }
  function markPart(node) {
    node.setPluginData(PART_KEY, "decoration");
  }
  function isDecoration(node) {
    return node.type === "SLICE" || node.getPluginData(PART_KEY) === "decoration" || node.type === "GROUP" && node.locked && node.name === "Crop marks";
  }
  function readMeta(node) {
    try {
      const meta = JSON.parse(node.getPluginData(PAGE_KEY) || "null");
      if (meta && meta.v === 1 && Math.abs(meta.frameW - node.width) < 0.01 && Math.abs(meta.frameH - node.height) < 0.01) return meta;
    } catch (e) {
    }
    return null;
  }
  function findTrimSlice(node, shallow) {
    const isTrim = (n) => n.type === "SLICE" && /trimbox/i.test(n.name);
    if (shallow) return "children" in node ? node.children.find(isTrim) || null : null;
    return "findOne" in node ? node.findOne(isTrim) : null;
  }
  function readPage(node) {
    const base = { id: node.id, name: node.name, width: node.width, height: node.height };
    const meta = readMeta(node);
    if (meta) return Object.assign(base, { trim: meta.trim, bleed: meta.bleed, margin: meta.margin, unit: meta.unit, source: "printkit" });
    const slice = findTrimSlice(node);
    if (slice) {
      const x = slice.absoluteTransform[0][2] - node.absoluteTransform[0][2];
      const y = slice.absoluteTransform[1][2] - node.absoluteTransform[1][2];
      return Object.assign(base, { trim: { x, y, w: slice.width, h: slice.height }, bleed: null, margin: 0, unit: "mm", source: "slice" });
    }
    return Object.assign(base, { trim: { x: 0, y: 0, w: node.width, h: node.height }, bleed: 0, margin: 0, unit: "mm", source: "frame" });
  }
  function boxesFor(page) {
    return pdfBoxes(page.width, page.height, page.trim, page.bleed);
  }
  function isOtherPrintPage(node) {
    return isFrameLike(node) && readMeta(node) === null && findTrimSlice(node, true) !== null;
  }
  function isPrintPage(node) {
    return isFrameLike(node) && (readMeta(node) !== null || findTrimSlice(node, true) !== null);
  }
  function pageFrameOf(node) {
    let frame = isFrameLike(node) ? node : null;
    for (let n = node.parent; n && n.type !== "PAGE" && n.type !== "SECTION"; n = n.parent) {
      if (isFrameLike(n)) frame = n;
    }
    return frame;
  }
  function targetPages() {
    const selection = figma.currentPage.selection;
    const nodes = [];
    const add = (node) => node && nodes.indexOf(node) < 0 && nodes.push(node);
    if (selection.length) {
      for (const node of selection) {
        if (node.type === "SECTION") node.children.filter(isFrameLike).forEach(add);
        else add(pageFrameOf(node));
      }
    } else {
      for (const node of figma.currentPage.children) {
        if (node.type === "SECTION") node.children.filter(isPrintPage).forEach(add);
        else if (isPrintPage(node)) add(node);
      }
    }
    return nodes.sort((a, b) => {
      const ay = a.absoluteTransform[1][2];
      const by = b.absoluteTransform[1][2];
      if (Math.abs(ay - by) > Math.min(a.height, b.height) / 2) return ay - by;
      return a.absoluteTransform[0][2] - b.absoluteTransform[0][2];
    });
  }
  async function pagesById(ids) {
    const nodes = await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
    return nodes.filter((node) => node && isFrameLike(node));
  }
  function selectionSummary() {
    const selection = figma.currentPage.selection;
    const frames = selection.filter(isFrameLike);
    return {
      selected: selection.length,
      frames: frames.length,
      printPages: frames.filter((node) => readMeta(node) !== null).length,
      otherPages: frames.filter(isOtherPrintPage).length,
      pageIds: targetPages().map((node) => node.id)
    };
  }
  function listPages() {
    return targetPages().map((node) => {
      const page = readPage(node);
      return { id: page.id, name: page.name, w: page.trim.w, h: page.trim.h, unit: page.unit, source: page.source };
    });
  }

  // src/main/create.js
  var TRIM_TINT = { r: 1, g: 0, b: 0, a: 0.1 };
  var MARGIN_TINT = { r: 0, g: 0.16, b: 1, a: 0.06 };
  var GAP = 40;
  var RELAUNCH = { check: "", export: "" };
  function band(pattern, alignment, size, color) {
    return { pattern, alignment, gutterSize: 0, count: 1, offset: 0, sectionSize: Math.max(0.01, size), visible: true, color };
  }
  function guides(g) {
    const grids = [];
    const sides = (size, color) => [
      band("ROWS", "MIN", size, color),
      band("ROWS", "MAX", size, color),
      band("COLUMNS", "MIN", size, color),
      band("COLUMNS", "MAX", size, color)
    ];
    if (g.trim.x > 0) grids.push(...sides(g.trim.x, TRIM_TINT));
    if (g.bleed > 0 && g.trim.x - g.bleed > 0.01) grids.push(...sides(g.trim.x - g.bleed, TRIM_TINT));
    if (g.margin > 0) grids.push(...sides(g.trim.x + g.margin, MARGIN_TINT));
    return grids;
  }
  function decorate(frame, g, settings, names) {
    const slice = figma.createSlice();
    slice.name = "Trimbox";
    slice.resize(g.trim.w, g.trim.h);
    frame.appendChild(slice);
    slice.x = g.trim.x;
    slice.y = g.trim.y;
    slice.locked = true;
    if (g.marks.length) {
      const rects = g.marks.map((mark) => {
        const rect = figma.createRectangle();
        rect.name = mark.name;
        rect.resize(Math.max(0.01, mark.w), Math.max(0.01, mark.h));
        rect.fills = [{ type: "SOLID", color: REGISTRATION_RGB }];
        frame.appendChild(rect);
        rect.x = mark.x;
        rect.y = mark.y;
        return rect;
      });
      const group = figma.group(rects, frame);
      group.name = names.marks;
      group.locked = true;
      markPart(group);
    }
    frame.layoutGrids = guides(g);
    frame.setRelaunchData(RELAUNCH);
    frame.setPluginData(
      PAGE_KEY,
      JSON.stringify({ v: 1, frameW: g.frameW, frameH: g.frameH, trim: g.trim, bleed: g.bleed, margin: g.margin, unit: settings.unit })
    );
  }
  function show(nodes) {
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
  }
  function createPages(settings, names) {
    const g = pageGeometry(settings);
    const count = Math.max(1, Math.min(200, Math.floor(Number(settings.pages) || 1)));
    const center = figma.viewport.center;
    const startX = Math.round(center.x - (count * (g.frameW + GAP) - GAP) / 2);
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const frame = figma.createFrame();
      frame.name = count > 1 ? `${names.format} \xB7 ${names.page} ${i + 1}` : names.format;
      frame.resizeWithoutConstraints(g.frameW, g.frameH);
      frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      frame.clipsContent = true;
      decorate(frame, g, settings, names);
      figma.currentPage.appendChild(frame);
      frame.x = startX + i * (g.frameW + GAP);
      frame.y = Math.round(center.y - g.frameH / 2);
      nodes.push(frame);
    }
    show(nodes);
    return nodes.length;
  }
  function applyToSelection(settings, names) {
    const frames = figma.currentPage.selection.filter(isFrameLike);
    const own = frames.filter((frame) => readMeta(frame) !== null);
    const others = frames.filter((frame) => readMeta(frame) === null && !isOtherPrintPage(frame));
    own.forEach((frame) => updatePage(frame, settings, names));
    const copies = others.length ? prepareCopies(others, settings, names) : [];
    show(own.concat(copies));
    return { updated: own.length, prepared: copies.length, skipped: frames.length - own.length - others.length };
  }
  function updatePage(frame, settings, names) {
    const meta = readMeta(frame);
    const g = pageGeometry(Object.assign({}, settings, { width: fromPt(meta.trim.w, settings.unit), height: fromPt(meta.trim.h, settings.unit) }));
    const dx = g.trim.x - meta.trim.x;
    const dy = g.trim.y - meta.trim.y;
    frame.children.filter(isDecoration).forEach((node) => {
      node.locked = false;
      node.remove();
    });
    frame.resizeWithoutConstraints(g.frameW, g.frameH);
    if (frame.layoutMode === "NONE") {
      frame.children.forEach((child) => {
        child.x += dx;
        child.y += dy;
      });
    }
    frame.x -= dx;
    frame.y -= dy;
    decorate(frame, g, settings, names);
  }
  function prepareCopies(sources, settings, names) {
    const right = Math.max(...sources.map((s) => s.absoluteTransform[0][2] + s.width));
    const left = Math.min(...sources.map((s) => s.absoluteTransform[0][2]));
    const shift = right - left + 200;
    return sources.map((source) => {
      const g = pageGeometry(Object.assign({}, settings, { width: fromPt(source.width, settings.unit), height: fromPt(source.height, settings.unit) }));
      const frame = figma.createFrame();
      frame.name = `${source.name} \xB7 ${names.print}`;
      frame.resizeWithoutConstraints(g.frameW, g.frameH);
      const background = "fills" in source && Array.isArray(source.fills) ? source.fills.filter((p) => p.type === "SOLID" || p.type.indexOf("GRADIENT") === 0) : [];
      frame.fills = background.length ? JSON.parse(JSON.stringify(background)) : [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      frame.clipsContent = true;
      const copy = source.type === "COMPONENT" ? source.createInstance() : source.clone();
      frame.appendChild(copy);
      copy.x = g.trim.x;
      copy.y = g.trim.y;
      decorate(frame, g, settings, names);
      figma.currentPage.appendChild(frame);
      frame.x = source.absoluteTransform[0][2] + shift - (g.frameW - source.width) / 2;
      frame.y = source.absoluteTransform[1][2] - (g.frameH - source.height) / 2;
      return frame;
    });
  }

  // src/main/inspect.js
  var MIN_TEXT_PT = 6;
  var MIN_STROKE_PT = 0.25;
  var PPI_WARNING = 300;
  var PPI_ERROR = 150;
  function walk(node, visit, clipped) {
    for (const child of node.children || []) {
      if (!child.visible || isDecoration(child)) continue;
      visit(child, clipped);
      if ("children" in child) walk(child, visit, clipped || child.type !== "GROUP" && child.clipsContent === true);
    }
  }
  function visiblePaints(paints) {
    return Array.isArray(paints) ? paints.filter((p) => p.visible !== false && (p.opacity === void 0 || p.opacity > 0)) : [];
  }
  function relativeBox(node, page) {
    const box = node.type === "TEXT" && node.absoluteRenderBounds || node.absoluteBoundingBox;
    if (!box) return null;
    return { x: box.x - page.absoluteTransform[0][2], y: box.y - page.absoluteTransform[1][2], w: box.width, h: box.height };
  }
  function strokeWeight(node) {
    if (typeof node.strokeWeight === "number") return node.strokeWeight;
    const sides = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"].map((k) => node[k]).filter((v) => typeof v === "number" && v > 0);
    return sides.length ? Math.min(...sides) : 0;
  }
  function trimSides(box, t) {
    const sides = [];
    if (Math.abs(box.x - t.x) < 0.5) sides.push("left");
    if (Math.abs(box.y - t.y) < 0.5) sides.push("top");
    if (Math.abs(box.x + box.w - (t.x + t.w)) < 0.5) sides.push("right");
    if (Math.abs(box.y + box.h - (t.y + t.h)) < 0.5) sides.push("bottom");
    return sides;
  }
  function canExtend(node) {
    const parent = node.parent;
    return node.type === "RECTANGLE" && node.rotation === 0 && !(parent && "layoutMode" in parent && parent.layoutMode !== "NONE");
  }
  async function checkPages() {
    const nodes = targetPages();
    const pages = [];
    const issues = [];
    const imageSizes = /* @__PURE__ */ new Map();
    const imageSize = (hash) => {
      if (!imageSizes.has(hash)) {
        const image = figma.getImageByHash(hash);
        imageSizes.set(hash, image ? image.getSizeAsync().catch(() => null) : Promise.resolve(null));
      }
      return imageSizes.get(hash);
    };
    for (const node of nodes) {
      const page = readPage(node);
      pages.push({ id: page.id, name: page.name });
      const add = (target, code, severity, params, fix) => issues.push({ pageId: page.id, nodeId: target.id, nodeName: target.name, code, severity, params: params || {}, fix: fix || null });
      if (page.source === "frame") add(node, "page-no-trim", "info");
      else if (page.bleed === 0) add(node, "page-no-bleed", "info");
      const t = page.trim;
      const pending = [];
      walk(node, (child, clipped) => {
        const box = relativeBox(child, node);
        if (child.type === "TEXT") {
          if (child.hasMissingFont) add(child, "font-missing", "error");
          const sizes = child.fontSize === figma.mixed ? child.getStyledTextSegments(["fontSize"]).map((s) => s.fontSize) : [child.fontSize];
          const smallest = Math.min(...sizes);
          if (smallest < MIN_TEXT_PT) add(child, "text-small", "warning", { size: Math.round(smallest * 10) / 10, min: MIN_TEXT_PT });
          if (box && page.source !== "frame") {
            const inside = Math.min(box.x - t.x, box.y - t.y, t.x + t.w - (box.x + box.w), t.y + t.h - (box.y + box.h));
            if (inside < -0.5) add(child, "text-cut", "warning");
            else if (page.margin > 0 && inside < page.margin - 0.5) add(child, "text-margin", "warning", { margin: roundFor(fromPt(page.margin, page.unit), page.unit), unit: page.unit });
          }
        }
        if (visiblePaints(child.strokes).length) {
          const weight = strokeWeight(child);
          if (weight > 0 && weight < MIN_STROKE_PT) add(child, "line-thin", "warning", { weight: Math.round(weight * 100) / 100, min: MIN_STROKE_PT }, "stroke");
        }
        for (const paint of visiblePaints(child.fills)) {
          if (paint.type !== "IMAGE" || !paint.imageHash) continue;
          pending.push(
            imageSize(paint.imageHash).then((size) => {
              const ppi = size ? effectivePpi(paint, child.width, child.height, size.width, size.height) : null;
              if (ppi !== null && ppi < PPI_ERROR) add(child, "image-low", "error", { ppi, min: PPI_WARNING });
              else if (ppi !== null && ppi < PPI_WARNING) add(child, "image-medium", "warning", { ppi, min: PPI_WARNING });
            })
          );
        }
        if (Array.isArray(child.effects) && child.effects.some((e) => e.visible !== false)) add(child, "effects", "info");
        if (!clipped && box && page.bleed > 0 && child.type !== "TEXT" && (visiblePaints(child.fills).length || child.type === "FRAME")) {
          const sides = trimSides(box, t);
          if (sides.length) add(child, "edge-trim", "warning", { sides }, canExtend(child) ? "bleed" : null);
        }
      }, false);
      await Promise.all(pending);
    }
    const rank = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return { pages, issues };
  }
  async function fixIssue(kind, nodeId, pageId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    const frame = await figma.getNodeByIdAsync(pageId);
    if (!node || !frame || node.type === "DOCUMENT" || node.type === "PAGE") return false;
    if (kind === "stroke" && "strokeWeight" in node) {
      node.strokeWeight = MIN_STROKE_PT;
      return true;
    }
    if (kind === "bleed" && node.type === "RECTANGLE" && canExtend(node)) {
      const page = readPage(frame);
      const box = relativeBox(node, frame);
      const sides = trimSides(box, page.trim);
      const edge = { left: page.trim.x - page.bleed, top: page.trim.y - page.bleed, right: page.trim.x + page.trim.w + page.bleed, bottom: page.trim.y + page.trim.h + page.bleed };
      const grow = {
        left: sides.indexOf("left") >= 0 ? box.x - edge.left : 0,
        top: sides.indexOf("top") >= 0 ? box.y - edge.top : 0,
        right: sides.indexOf("right") >= 0 ? edge.right - (box.x + box.w) : 0,
        bottom: sides.indexOf("bottom") >= 0 ? edge.bottom - (box.y + box.h) : 0
      };
      node.x -= grow.left;
      node.y -= grow.top;
      node.resize(node.width + grow.left + grow.right, node.height + grow.top + grow.bottom);
      return true;
    }
    return false;
  }
  function scanColors() {
    const colors = /* @__PURE__ */ new Map();
    const gradients = /* @__PURE__ */ new Map();
    let images = 0;
    const addColor = (hex, kind) => {
      if (hex === REGISTRATION_HEX) return;
      const entry = colors.get(hex) || { hex, count: 0, kinds: [] };
      entry.count++;
      if (entry.kinds.indexOf(kind) < 0) entry.kinds.push(kind);
      colors.set(hex, entry);
    };
    const count = (paint, kind) => {
      if (paint.type === "SOLID") {
        addColor(hexOfColor(paint.color), kind);
      } else if (paint.type.indexOf("GRADIENT") === 0) {
        const stops = (paint.gradientStops || []).map((s) => ({
          hex: hexOfColor(s.color),
          position: Math.round(s.position * 1e3) / 1e3,
          alpha: Math.round((s.color.a === void 0 ? 1 : s.color.a) * 100) / 100
        }));
        const key = paint.type + "|" + stops.map((s) => `${s.hex}@${s.position}/${s.alpha}`).join(",");
        const entry = gradients.get(key) || { type: paint.type.replace("GRADIENT_", "").toLowerCase(), stops, count: 0 };
        entry.count++;
        gradients.set(key, entry);
        stops.forEach((stop) => addColor(stop.hex, "gradient"));
      } else if (paint.type === "IMAGE") images++;
    };
    const visit = (node) => {
      if (node.type === "TEXT") {
        const segments = node.fills === figma.mixed ? node.getStyledTextSegments(["fills"]) : [{ fills: node.fills }];
        segments.forEach((s) => visiblePaints(s.fills).forEach((p) => count(p, "text")));
      } else {
        visiblePaints(node.fills).forEach((p) => count(p, "fill"));
      }
      visiblePaints(node.strokes).forEach((p) => count(p, "stroke"));
    };
    for (const page of targetPages()) {
      visit(page);
      walk(page, visit, false);
    }
    return {
      colors: [...colors.values()].sort((a, b) => b.count - a.count),
      gradients: [...gradients.values()].sort((a, b) => b.count - a.count),
      images
    };
  }

  // src/main/export.js
  var THUMB_HEIGHT = 96;
  async function exportPages(ids, post2) {
    const nodes = await pagesById(ids);
    for (let i = 0; i < nodes.length; i++) {
      const page = readPage(nodes[i]);
      const bytes = await nodes[i].exportAsync({ format: "PDF" });
      post2({ type: "export-page", index: i, total: nodes.length, name: page.name, width: page.width, height: page.height, boxes: boxesFor(page), bytes });
    }
    post2({ type: "export-end", total: nodes.length });
  }
  async function sendThumbnails(ids, post2) {
    for (const node of await pagesById(ids)) {
      const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "HEIGHT", value: THUMB_HEIGHT } });
      post2({ type: "thumb", id: node.id, bytes });
    }
  }

  // src/main/code.js
  var STORAGE = { settings: "printkit:settings", ui: "printkit:ui", profile: "printkit:profile" };
  var COLORS_KEY = "printkit:colors";
  var DEFAULT_SIZE = { width: 360, height: 640 };
  var post = (message) => figma.ui.postMessage(message);
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
      settings: await figma.clientStorage.getAsync(STORAGE.settings) || {},
      ui: await figma.clientStorage.getAsync(STORAGE.ui) || {},
      command: figma.command,
      profile: profile ? { name: profile.name } : null,
      colors: readColors(),
      selection: selectionSummary(),
      fileName: figma.root.name
    });
  }
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
        return post({ type: "profile", profile: await figma.clientStorage.getAsync(STORAGE.profile) || null });
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
    const ui = await figma.clientStorage.getAsync(STORAGE.ui) || {};
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
})();
