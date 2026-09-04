/**
 * The seam between core logic and its host.
 *
 * Everything in `src/core` is framework- and host-agnostic: it runs unchanged
 * inside the Chrome extension and inside the plain web/PWA build. Only two
 * things actually differ between those hosts, so only two things live here.
 *
 *   assetUrl  where bundled files (the pdf.js worker, cmaps, the Hebrew font)
 *             can be fetched from. An extension resolves these through
 *             chrome.runtime.getURL; the web build resolves them relative to
 *             the page.
 *
 *   storage   durable key-value storage for preferences and saved signatures.
 *             chrome.storage.local in the extension, IndexedDB on the web.
 *
 * A host installs its implementation with `setPlatform()` before any core
 * module is used. Core never imports an adapter, so a `chrome.*` reference
 * cannot leak back in — the import direction enforces it.
 */

/** Minimal async key-value contract, shaped to what the app actually needs. */
export interface KeyValueStore {
  /** Read one key or several. Missing keys are simply absent from the result. */
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  /** Write several keys at once. */
  set(items: Record<string, unknown>): Promise<void>;
}

export interface Platform {
  /** Absolute URL for a packaged asset path, e.g. "vendor/pdf.worker.mjs". */
  assetUrl(path: string): string;
  storage: KeyValueStore;
  /**
   * True only inside the browser extension. Lets shared UI hide affordances
   * that make no sense on the web (exiting back to the original PDF tab,
   * the store review prompt) without those features leaking into core.
   */
  readonly isExtension: boolean;
}

let active: Platform | undefined;

export function setPlatform(platformImpl: Platform): void {
  active = platformImpl;
}

export function platform(): Platform {
  if (!active) {
    throw new Error(
      'ScribblePDF: no platform configured. Call setPlatform() from the host entry point before using core.',
    );
  }
  return active;
}

/** Convenience wrappers, so call sites stay readable. */
export const assetUrl = (path: string): string => platform().assetUrl(path);
export const storage = (): KeyValueStore => platform().storage;
