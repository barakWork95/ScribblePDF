# ScribblePDF — Privacy Policy

**Last updated: 31 August 2026**

## The short version

ScribblePDF does not collect, transmit, store or share any of your data. Your
PDFs are opened, edited and saved entirely inside your own browser. There is no
account, no server, and nothing is ever uploaded.

## What we collect

Nothing.

ScribblePDF has no analytics, no telemetry, no crash reporting, no advertising
identifiers, and no third-party SDKs. We do not know how many people use it, or
what they open with it.

## What stays on your device

Two things are saved in your browser's local extension storage, on your own
computer:

1. **Your preferences** — the tool, colour, font and size you last used.
2. **Signatures you chose to save** — the drawing itself, so you can reuse it
   instead of redrawing it for every document.

Both are stored using Chrome's `storage.local` API. They are never transmitted
anywhere, are not synced between your devices, and are deleted when you remove
the extension. You can delete saved signatures individually from the signature
dialog at any time.

**Your PDF files are never stored.** A document lives in the tab's memory only
while you are working on it, and is gone when you close or navigate away.

## Network access

ScribblePDF makes exactly one kind of network request: downloading the PDF you
asked it to open, from the site you opened it from. That request goes to that
site and nowhere else.

There are no other requests. No content delivery networks, no remote fonts, no
remote code, no "phone home" check. Every script, font and asset the extension
uses is contained in the package you installed. This is enforced technically by
the extension's Content Security Policy (`script-src 'self'`), not only by
policy — the browser will refuse to load remote code even if the extension asked
for it.

## Permissions, and why each exists

ScribblePDF requests **no access to any website when you install it.**

| Permission | Why |
|---|---|
| `storage` | Saves your preferences and signatures on your device. |
| `activeTab` | When you click the toolbar icon, reads the URL of the PDF in the current tab so it can open that document. |
| `declarativeNetRequestWithHostAccess` | Powers an optional, off-by-default setting that opens PDF links in ScribblePDF instead of Chrome's built-in viewer. |
| Site access, requested individually | To edit a PDF hosted on a website, the extension must download that file. It asks for one site at a time, when you open a PDF from it. |

If you only open PDFs from your own computer, ScribblePDF never needs access to
any website at all.

You can review or revoke site access at any time from
`chrome://extensions` → ScribblePDF → **Site access**.

## Local files

Opening a PDF stored on your own computer requires Chrome's *"Allow access to
file URLs"* toggle, which you control from the extensions page and which is off
by default. ScribblePDF reads such a file only when you explicitly open it, and
still does not transmit it.

## Children

ScribblePDF is a document utility that collects no data. It is not directed at
children and gathers no information from anyone, of any age.

## Changes to this policy

If this policy ever changes, the updated version will be published at this URL
and the date above will change. Because the extension collects nothing, we do
not have a mailing list to notify — please check here.

## Contact

Questions about this policy or the extension:

**<CONTACT_EMAIL>**

Source code: <REPOSITORY_URL>

<!--
  Before publishing: replace <CONTACT_EMAIL> and <REPOSITORY_URL>.

  Use an address you are willing to make public — a store listing's privacy
  policy is indexed, and the address will be scraped. An alias or a
  project-specific address is a better idea than a personal inbox.
-->
