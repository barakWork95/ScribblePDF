# ScribblePDF

A Chrome (Manifest V3) extension for editing and annotating PDFs directly in a
browser tab. Everything happens on your machine — **no file is ever uploaded**.

- **Text** — click anywhere to drop an editable text box; font, size, colour, bold/italic.
- **Checkmark / Cross** — stamp review marks.
- **Signature** — draw once, save it, reuse and resize it on any page.
- **Download** — annotations are burned into the original PDF with `pdf-lib`,
  preserving its text layer, vectors and bookmarks.

Hebrew and mixed Hebrew/English text is fully supported: it is laid out with the
Unicode Bidi Algorithm and embedded as a real subsetted font, so it stays
selectable and searchable in the exported file.

## Install (development)

```bash
npm install
npm run build
```

Run the checks with `npm run check` (type-check plus the bidi/font-coverage
regression suite).

Then open `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked**, and select the `dist/` folder.

Open a PDF and click the extension icon in the toolbar, or open the viewer and
drag a PDF onto it.

## Shortcuts

| Key | Action |
|---|---|
| `V` / `T` / `C` / `X` / `S` | Select / Text / Check / Cross / Signature |
| `⌘S` | Download the annotated PDF |
| `⌘Z` / `⇧⌘Z` | Undo / Redo |
| `⌘+` / `⌘-` | Zoom |
| Arrows (`⇧` for 10x) | Nudge the selection |
| `⌫` | Delete the selection |
| `Esc` | Deselect / close dialog |

## Privacy

The extension makes exactly one kind of network request: fetching the PDF you
asked it to open. There is no analytics, no CDN, no remote font, and no upload.
This is enforced by the manifest CSP (`script-src 'self'`).

Saved signatures live in `chrome.storage.local`, in your browser profile only.

## Third-party assets

Noto Sans Hebrew (Regular and Bold) is bundled under the SIL Open Font License;
the full licence text ships alongside it in `public/fonts/OFL.txt`.

## Development

See [CLAUDE.md](CLAUDE.md) for architecture, the coordinate-system contract, and
known limitations. Machine-readable status lives in `.claude/context.json`.
