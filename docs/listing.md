# Figma Community listing

The text for Figma's publish dialog, field by field. The cover is `docs/cover.png`, rendered from `docs/cover.html`; the icon is `docs/icon-128.png`. Figma takes one name, tagline and description, so the listing is in English with a short summary in German, Spanish and French at the end.

## Name

```text
Print Kit
```

## Tagline

```text
Print-ready PDFs made on your device: bleed, preflight and CMYK. No uploads, no account.
```

## Description

```text
Print Kit turns Figma frames into print-ready PDFs, and it does all of it on your device. Your designs never leave your computer: no uploads, no account, no tracking, and no waiting for a server.

Private by design
• Pages, colors and files are processed locally, inside Figma
• Nothing is sent anywhere. The only download is the open-source color engine Ghostscript (15.5 MB), loaded once per session from cdn.jsdelivr.net and checked against a fixed checksum before it runs
• No account, no analytics, no export limits
• Open source, so anyone can verify this

Light and efficient
• Nothing runs in the background. Checks and color scans start when you open their tab, the color engine only loads when you preview colors or export
• No round trip to a server: conversion starts right away and works on slow connections
• Gradients stay smooth vectors and images keep their resolution unless you reduce them

Create
• Print pages in A6 to A1, DL, square, business card and US sizes, with bleed, safe area and crop marks
• Turn existing frames into print pages, or update bleed and marks later
• Type any unit: 3mm, 0.125in, 1/8"

Check
• Images below 300 ppi, text under 6 pt, lines under 0.25 pt, missing fonts, text near the edge, artwork that stops at the trim
• Every finding explains why it matters and how to fix it
• One-click fixes for thin lines and backgrounds that miss the bleed

Colors
• Pure black (K 100) for crisp text, rich black for large areas
• Fixed CMYK values or spot colors per color, with overprint
• Spot names complete as you type for Pantone, HKS and RAL
• Preview how each color will print, and see which ones shift

Export
• CMYK for coated (FOGRA39) or uncoated (FOGRA47) paper, or your print shop's ICC profile
• Exact trim and bleed boxes and an output intent
• Presets for offset print, digital print and RGB proofs
• One PDF, or one PDF per page

Languages: English, Deutsch, Español, Français. The plugin follows your system language, and you can switch it in its menu.

Deutsch: Druckfertige PDFs direkt in Figma, mit Beschnitt, Prüfung und CMYK. Alles läuft auf deinem Gerät, nichts wird hochgeladen.
Español: PDF listos para imprenta en Figma, con sangrado, revisión y CMYK. Todo se ejecuta en tu dispositivo y no se sube nada.
Français : des PDF prêts à imprimer dans Figma, avec fond perdu, contrôle et CMJN. Tout s'exécute sur votre appareil, rien n'est envoyé.

Source code (AGPL-3.0): https://github.com/marco-vrinssen/print-kit
```

## Category and tags

- Category: Import & export.
- Tags: print, CMYK, PDF, bleed, crop marks, prepress, preflight, privacy.

## Network access

- Choose Restricted, with `https://cdn.jsdelivr.net`.
- Reason, as in `manifest.json`:

```text
Downloads the Ghostscript color engine, which is checked against a pinned SHA-256 before it runs. No designs or personal data leave the computer.
```

## Security disclosure

- Data collected: none. Print Kit has no server, account or analytics.
- Data stored: settings and a loaded ICC profile in Figma's client storage on the user's machine, and color choices in the Figma file.
- Network: one download of a public, checksum-verified engine file. Nothing is sent.

## Support contact

```text
https://github.com/marco-vrinssen/print-kit/issues
```
