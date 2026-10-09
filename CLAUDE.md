# Print Kit

## Rules

- Figma loads `dist/code.js` and `dist/ui.html`. Run `npm run build` after any change in `src/`.
- Run `npm run check` after changing `src/shared/`, `src/ui/pdf-*.js`, `src/ui/pipeline.js`, `src/ui/color-codes.js` or the Ghostscript arguments in `src/ui/engine.js`. It uses the same Ghostscript build the plugin downloads.
- Designs never leave the computer. All PDF work stays in the UI iframe. The only network host is `cdn.jsdelivr.net`, for the engine.
- Nothing heavy runs without a click or a tab the user opened. Check and Colors run when their tab opens; a changed selection only marks results stale. The engine loads only for the print preview or an export. Don't add preloading.
- Changing the engine version means updating `ENGINE.url`, `ENGINE.sha256` and `ENGINE.size` together, and the manifest's `allowedDomains` if the host changes.
- `src/main/` is bundled to ES2017 for Figma's sandbox. Don't use newer runtime APIs there.
- Run `npm run typecheck` after changing `src/main/`. It checks the Figma API calls against `@figma/plugin-typings`, because the main thread can't run outside Figma.
- The main thread sends issue codes and numbers, never sentences. Every text the user sees lives in `src/ui/i18n.js`, in English, German, Spanish and French. A new key needs all four.
- Match Figma's UI3 by hand, as in the Cosmos plugin: native radios under segmented controls, one shared `popover` menu styled like Figma's dark menus instead of `<select>`, Inter embedded in `src/ui/inter.css`. Popovers don't nest, so a control inside the settings popover can't open the menu.
- Each tab module returns `{ summary, body, primary, status }`; `app.js` draws it. Controls carry a `data-key`, so a redraw keeps focus.
- Crop marks are filled with `REGISTRATION_HEX` (`#010101`) and export as the registration color `All`. Artwork must not use that color.
- The color rewriter only maps solid colors set with `sc`, `scn` or `rg` in RGB color spaces, including the default black of a fresh color space. Rich black picks shapes by size with `paintsLargeArea`, looking ahead from the color to the paths it paints.
- Ghostscript rasterizes RGB gradients when it converts colors, but passes CMYK and gray ones through. `src/ui/pdf-gradients.js` therefore converts gradient colors first (one swatch run with the export profile) and rebuilds every gradient in the target space. Keep that step before the main conversion. Figma writes linear and radial gradients as shadings with PostScript calculator functions and angular and diamond gradients as type 4 triangle meshes; `test/fixtures/gradient-*.pdf` holds one of each.
- Ghostscript runs with `-dSAFER`. Any file it reads besides `/in.pdf` needs `--permit-file-read`.
- `-dAutoRotatePages=/None` stays, or Ghostscript rotates pages it thinks are sideways.
- Print pages store their geometry in plugin data `printkit:page`, in points, and crop mark groups carry `printkit:part`. Pages from other plugins are recognized by a slice whose name contains "trimbox".
- `docs/cover.html` renders the 1920 × 1080 Community cover from the real `dist/ui.html`: serve the repo root and capture it to `docs/cover.png` after a UI change. `docs/listing.md` holds the publish dialog texts.
- `docs/icon.svg` is the source of the icon: a beige iOS-style squircle (`#F4EFE6`), a dark gray P and four crop marks (`#2E2E2E`). Render `docs/icon.png` (1024 px) and `docs/icon-128.png` from it after a change.
- The built-in profiles are colord's CC0 FOGRA39L and FOGRA47L, taken from Arch Linux's `colord` package. ECI profiles such as PSO Coated v3 may not be redistributed. Ship no Pantone, HKS or RAL values; they are licensed.

## Checks

- `test/harness.html` hosts `dist/ui.html` in a sandboxed `srcdoc` iframe with Figma's theme tokens and a fake main thread. Serve the folder with `python3 -m http.server 8765 --bind 127.0.0.1`. Query: `?dark`, `?lang=de`, `?tab=colors`, `?welcome`, `?gradient`.
- The iframe is sandboxed, so drive it through Playwright's accessibility snapshot refs, not the parent's DOM.
- The main thread runs only in Figma. `use_figma` can run its functions on a test file if `setPluginData`, `getPluginData` and `setRelaunchData` are swapped for a map, since that tool doesn't support them.
