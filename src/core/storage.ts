/**
 * Durable persistence: preferences + the saved signature library.
 *
 * Nothing here ever touches the network. Signatures are the only user content
 * that outlives a tab, and they stay on the device — in extension storage under
 * the extension, in IndexedDB on the web.
 */
import type { Preferences, SavedSignature } from './types';
import { DEFAULT_PREFS } from './types';
import { storage } from './platform';

const KEY_PREFS = 'prefs';
const KEY_SIGNATURES = 'signatures';

/** Hosts give us a few MB at best; keep the library well clear of any limit. */
const MAX_SIGNATURES = 8;

export async function loadPrefs(): Promise<Preferences> {
  const got = await storage().get(KEY_PREFS);
  return { ...DEFAULT_PREFS, ...(got[KEY_PREFS] as Partial<Preferences> | undefined) };
}

export async function savePrefs(prefs: Preferences): Promise<void> {
  await storage().set({ [KEY_PREFS]: prefs });
}

export async function loadSignatures(): Promise<SavedSignature[]> {
  const got = await storage().get(KEY_SIGNATURES);
  const list = (got[KEY_SIGNATURES] as SavedSignature[] | undefined) ?? [];
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

/** Newest first, oldest evicted past MAX_SIGNATURES. */
export async function addSignature(sig: SavedSignature): Promise<SavedSignature[]> {
  const list = [sig, ...(await loadSignatures())].slice(0, MAX_SIGNATURES);
  await storage().set({ [KEY_SIGNATURES]: list });
  return list;
}

export async function deleteSignature(id: string): Promise<SavedSignature[]> {
  const list = (await loadSignatures()).filter((s) => s.id !== id);
  await storage().set({ [KEY_SIGNATURES]: list });
  return list;
}
