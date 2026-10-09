// Renders print pages with Figma's own PDF export and hands them to the UI with their boxes.
import { readPage, boxesFor, pagesById } from "./pages.js";

const THUMB_HEIGHT = 96;

export async function exportPages(ids, post) {
  const nodes = await pagesById(ids);
  for (let i = 0; i < nodes.length; i++) {
    const page = readPage(nodes[i]);
    const bytes = await nodes[i].exportAsync({ format: "PDF" });
    post({ type: "export-page", index: i, total: nodes.length, name: page.name, width: page.width, height: page.height, boxes: boxesFor(page), bytes });
  }
  post({ type: "export-end", total: nodes.length });
}

// Small previews for the page list, one message each, so the list fills in as they arrive.
export async function sendThumbnails(ids, post) {
  for (const node of await pagesById(ids)) {
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "HEIGHT", value: THUMB_HEIGHT } });
    post({ type: "thumb", id: node.id, bytes });
  }
}
