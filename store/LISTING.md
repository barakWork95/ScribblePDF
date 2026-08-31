# ScribblePDF — Chrome Web Store listing copy

Paste-ready text for the Developer Dashboard. Keep this file in sync with
`manifest.json`; the packaging script enforces the 132-character description
limit, but nothing enforces the rest.

---

## Item name

```
ScribblePDF
```

Plain product name on purpose. Store policy discourages keyword padding in
titles ("ScribblePDF — Edit PDFs Free Online!" is the kind of thing that draws a
rejection), so the value proposition lives in the summary instead.

## Category

Primary: **Productivity** → Workflow & Planning

## Short description (store limit: 132 characters)

```
Annotate and sign PDFs in your browser. Text, checkmarks, crosses and signatures — 100% local, nothing is uploaded.
```

*114 characters.* This is the same string as `manifest.json`'s `description`, and
`npm run package` fails the build if it ever exceeds the limit.

## Detailed description

```
ScribblePDF turns any PDF in your browser into something you can fill in, mark
up and sign — without uploading it anywhere.

Most "free PDF editor" sites work by taking your file, sending it to a server,
and emailing you a link. Contracts, invoices, medical forms and ID scans all end
up on somebody else's disk. ScribblePDF does the whole job inside the browser
tab. Your file is opened, edited and saved locally. There is no account, no
upload, and no server to trust.

WHAT YOU CAN DO

• Text — click anywhere to drop an editable text box, with font, size, colour,
  bold and italic controls.
• Checkmarks and crosses — stamp review marks wherever you need them.
• Signature — draw your signature once, save it, and reuse it on any document.
  Drag to reposition, drag the corner to resize.
• Download — your annotations are written into the original PDF, so the exported
  file keeps its real text layer, vectors and bookmarks. It is a proper PDF, not
  a picture of one.

HEBREW AND RIGHT-TO-LEFT TEXT

Hebrew is a first-class citizen. Text is laid out with the full Unicode Bidi
Algorithm, so mixed Hebrew and English lines read correctly, and it is embedded
as a real font rather than flattened to an image — the text in your exported PDF
stays selectable and searchable.

HOW IT HANDLES YOUR PERMISSIONS

ScribblePDF asks for no site access when you install it. When you open a PDF
from a website, it asks permission for that one site, and nothing else. You can
also open files straight from your computer, which needs no permission at all.

PRIVACY

No analytics. No tracking. No remote code. No network requests except fetching
the PDF you asked to open. Saved signatures and preferences live in your
browser profile and never leave your device. This is enforced by the extension's
content security policy, not just by promise.

GOOD TO KNOW

• Works on PDFs from the web and from your computer.
• Opening local files requires Chrome's "Allow access to file URLs" toggle,
  which you control from the extensions page.
• Arabic, CJK and emoji annotations are rendered as images rather than embedded
  text — they look correct but are not selectable in the exported file.
```

## Feature highlights (for screenshot captions)

1. **Everything happens in your tab** — open a PDF, mark it up, download it. No
   upload, no account.
2. **Text that behaves** — click to place, edit in situ, control font and colour.
3. **Sign once, reuse forever** — draw your signature and it is saved to this
   device for next time.
4. **Hebrew and RTL done properly** — real embedded fonts, correct bidirectional
   layout, still selectable after export.
5. **A real PDF out the other end** — annotations are written into the original
   file, preserving its text layer and vectors.

## Single purpose statement

```
ScribblePDF has one purpose: to let a user annotate and sign PDF documents
locally in the browser, and download the result. All processing happens on the
user's own device.
```

## Permission justifications

One box per permission in the dashboard. Reviewers read these carefully; each
should say what the permission does *for the user*.

**storage**
```
Stores the user's tool preferences (colour, font, size) and the signatures they
have chosen to save, so they do not have to redraw a signature for every
document. This data is kept in the browser profile on the user's own device and
is never transmitted.
```

**activeTab**
```
When the user clicks the ScribblePDF toolbar icon, the extension reads the URL
of the PDF in the current tab so it can open that document in the editor. It is
used only in response to that click.
```

**declarativeNetRequestWithHostAccess**
```
Powers an optional, off-by-default setting that opens PDF links in ScribblePDF
instead of Chrome's built-in viewer. The rule is registered only while the user
has enabled the setting, and only for sites the user has already granted access
to. It redirects to the extension's own viewer page and never blocks, modifies
or inspects any other request.
```

**optional host permissions (`http://*/*`, `https://*/*`)**
```
Requested one site at a time, never at install. To edit a PDF hosted on a
website, the extension must download that file into the tab. When the user opens
a PDF from example.com, ScribblePDF asks for access to example.com only. Users
who open files from their own computer never need to grant anything.
```

## Data disclosure answers

For the "Privacy practices" tab. ScribblePDF collects nothing, so every category
is **No**:

| Question | Answer |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | No |

Then certify all three:

- I do not sell or transfer user data to third parties, outside of the approved
  use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

**Remote code:** answer **No** — all JavaScript, fonts and WASM are bundled in
the package, and the manifest's CSP is `script-src 'self'`.

**Privacy policy URL:** required. Publish `docs/PRIVACY.md` (GitHub Pages on the
ScribblePDF repository is sufficient) and paste the URL.

## Assets checklist

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG | done — `public/icons/icon128.png` |
| Screenshots | 1280×800 or 640×400, 1–5 | **to do** |
| Small promo tile | 440×280 | optional |
| Marquee promo tile | 1400×560 | optional |

Suggested screenshots, in order: the toolbar over a document; a text annotation
being edited; the signature modal; a Hebrew annotation; the downloaded result
open in Chrome's own viewer.
