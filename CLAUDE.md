# Print Kit

Figma plugin for print-ready CMYK PDFs. `README.md` covers the features, `PRIVACY.md` what the plugin stores and fetches.

## Commands

- `npm run build` after any change in `src/`. Figma loads `dist/code.js` and `dist/ui.html`, which are committed.
- `npm run check` after changing `src/shared/`, `src/ui/pdf-*.js`, `src/ui/pipeline.js`, `src/ui/color-codes.js` or the Ghostscript arguments in `src/ui/engine.js`. It uses the same Ghostscript build the plugin downloads.
- `npm run typecheck` after changing `src/main/`. It checks the Figma API calls against `@figma/plugin-typings`, because the main thread can't run outside Figma.

## Rules

- Designs never leave the computer. All PDF work stays in the UI iframe. The only network address is the engine's package path, `https://cdn.jsdelivr.net/npm/@okathira/ghostpdl-wasm@1.1.0/`. The manifest allows nothing else.
- Nothing heavy runs without a click or a tab the user opened. Check and Colors run when their tab opens. A changed selection only marks results stale. The engine loads only for the print preview or an export. Don't add preloading.
- Changing the engine version means updating `ENGINE.url`, `ENGINE.sha256` and `ENGINE.size` together, plus the package path in the manifest's `allowedDomains`, `PRIVACY.md`, `README.md` and `docs/listing.md`.
- `src/main/` is bundled to ES2017 for Figma's sandbox.
- The main thread sends issue codes and numbers, never sentences. Every text the user sees lives in `src/ui/i18n.js`, in English, German, Spanish and French. A new key needs all four. Errors for the user are thrown as `new Error(code)` and shown with `errorText`, which words `error.<code>` and sends anything else to the console.
- Inter is embedded in `src/ui/inter.css`. One shared `popover` menu serves every dropdown. Popovers don't nest, so a control inside the settings popover can't open the menu.
- Each tab module returns `{ summary, body, primary, status }` for `app.js` to draw. Controls carry a `data-key`, so a redraw keeps focus.
- Crop marks are filled with `REGISTRATION_HEX` (`#010101`) and export as the registration color `All`. Artwork must not use that color.
- The color rewriter only maps solid colors set with `sc`, `scn` or `rg` in RGB color spaces, including the default black of a fresh color space. Rich black picks shapes by size with `paintsLargeArea`, looking ahead from the color to the paths it paints.
- Ghostscript rasterizes RGB gradients when it converts colors but passes CMYK and gray ones through. `src/ui/pdf-gradients.js` therefore converts gradient colors first (one swatch run with the export profile) and rebuilds every gradient in the target space. Keep that step before the main conversion. Figma writes linear and radial gradients as shadings with PostScript calculator functions. It writes angular and diamond gradients as type 4 triangle meshes. `test/fixtures/gradient-*.pdf` holds one of each.
- Ghostscript runs with `-dSAFER`. Any file it reads besides `/in.pdf` needs `--permit-file-read`.
- `-dAutoRotatePages=/None` stays, or Ghostscript rotates pages it thinks are sideways.
- Print pages store their geometry in plugin data `printkit:page`, in points. Crop mark groups carry `printkit:part`. Pages from other plugins are recognized by a slice whose name contains "trimbox".
- The manifest `id` is `print-kit-local` until publish.
- `docs/cover.html` renders the 1920 × 1080 Community cover from the real `dist/ui.html`. Serve the repo root and capture it to `docs/cover.png` after a UI change.
- Brand: beige `#F4EFE6`, soft black `#2D2B28`, Inter with -4 % letter spacing. `docs/icon.svg` holds an iOS-style squircle, Inter Bold "P" as outlines and four crop marks, each 96 long and 48 away from the page corner on the 1024 grid. Render `docs/icon.png` (1024 px) from it after a change, plus `docs/icon-figma-128.png` with a full square background, since Figma rounds uploaded icons itself.
- The built-in profiles are colord's CC0 FOGRA39L and FOGRA47L, taken from Arch Linux's `colord` package. ECI profiles such as PSO Coated v3 may not be redistributed. Ship no Pantone, HKS or RAL values, since they are licensed.
- `references/` is git-ignored. It holds third-party plugin bundles reviewed for comparison, which are not ours to redistribute. Never commit them.

## Checks

- `test/harness.html` hosts `dist/ui.html` in a sandboxed `srcdoc` iframe with Figma's theme tokens and a fake main thread. Serve the folder with `python3 -m http.server 8765 --bind 127.0.0.1`. Query: `?dark`, `?lang=de`, `?tab=colors`, `?welcome`, `?gradient`.
- `use_figma` doesn't support `setPluginData`, `getPluginData` and `setRelaunchData`. Swap them for a map when running main-thread functions there.
