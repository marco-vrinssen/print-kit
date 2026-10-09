// Builds the two files Figma loads: dist/code.js and dist/ui.html. Run: npm run build
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

// Figma's sandbox predates optional chaining in some clients, so main targets ES2017.
await build({
  entryPoints: ["src/main/code.js"],
  bundle: true,
  format: "iife",
  target: "es2017",
  outfile: "dist/code.js",
  logLevel: "warning",
});

// The Ghostscript loader only imports Node's "module" on Node, so it stays external here.
const ui = await build({
  entryPoints: ["src/ui/app.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
  external: ["module"],
  define: { "import.meta.url": "undefined" },
  // The two built-in print profiles ship inside the UI, 120 KB each.
  loader: { ".icc": "binary" },
  logLevel: "warning",
});

const js = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = ["src/ui/styles.css", "src/ui/inter.css"].map((file) => readFileSync(file, "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");
const html = readFileSync("src/ui/index.html", "utf8")
  .replace("/*__CSS__*/", () => css)
  .replace("/*__JS__*/", () => js);
writeFileSync("dist/ui.html", html);
console.log(`dist/code.js and dist/ui.html (${Math.round(html.length / 1024)} KB)`);
