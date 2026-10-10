# Privacy

Print Kit is a Figma plugin that makes print-ready PDFs on your own computer. It has no server, no account and no analytics. Last updated 2026-10-10.

## Processed on your computer

- Print Kit reads the pages you choose in Figma: frames, layers, text sizes, fonts, colors and images.
- Figma renders each page as a PDF. Color conversion, gradients, page boxes and the final file are made inside the plugin window, on your computer.
- The finished PDF or ZIP is saved to your computer. Nothing is uploaded.

## Stored

- Settings, window size, language and a loaded ICC profile: in Figma's client storage, on this computer only.
- Color choices, such as fixed CMYK values, spot colors, overprint and how black prints: in the Figma file, so everyone who exports it gets the same colors.
- Print pages keep their trim, bleed and safe area as plugin data in the Figma file.

## Network

- The only download is the open-source Ghostscript color engine (15.5 MB) from `https://cdn.jsdelivr.net/npm/@okathira/ghostpdl-wasm@1.1.0/`. The plugin's manifest allows no other address.
- It loads once per plugin session, only for the print preview or an export to CMYK, grayscale or reduced images. It runs only if its SHA-256 checksum matches the pinned value.
- jsDelivr receives this download request like any other, including your IP address. No designs, file names or personal data are sent.

## Tracking

- No analytics, no cookies, no account and no personal data collected.

## Contact

- Questions: [GitHub issues](https://github.com/marco-vrinssen/print-kit/issues).
- Security reports: GitHub private vulnerability reporting, under the repository's Security tab.
