/**
 * Platform adapter for the Chrome extension host.
 *
 * The only file outside src/background that is allowed to touch `chrome.*` on
 * behalf of core.
 */
import type { KeyValueStore, Platform } from '@/core/platform';

const extensionStorage: KeyValueStore = {
  get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
  set: (items) => chrome.storage.local.set(items),
};

export const extensionPlatform: Platform = {
  assetUrl: (path) => chrome.runtime.getURL(path),
  storage: extensionStorage,
  isExtension: true,
};
