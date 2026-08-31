/**
 * chrome.storage.local persistence: preferences + the saved signature library.
 *
 * Nothing here ever touches the network. Signatures are the only user content
 * that outlives a tab, and they stay in the profile's local extension storage.
 */
import type { Preferences, SavedSignature } from './types';
import { DEFAULT_PREFS } from './types';

const KEY_PREFS = 'prefs';
const KEY_SIGNATURES = 'signatures';

/** chrome.storage.local is 10 MB total; keep the library well clear of it. */
const MAX_SIGNATURES = 8;

export async function loadPrefs(): Promise<Preferences> {
  const got = await chrome.storage.local.get(KEY_PREFS);
  return { ...DEFAULT_PREFS, ...(got[KEY_PREFS] as Partial<Preferences> | undefined) };
}

export async function savePrefs(prefs: Preferences): Promise<void> {
  await chrome.storage.local.set({ [KEY_PREFS]: prefs });
}

export async function loadSignatures(): Promise<SavedSignature[]> {
  const got = await chrome.storage.local.get(KEY_SIGNATURES);
  const list = (got[KEY_SIGNATURES] as SavedSignature[] | undefined) ?? [];
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

/** Newest first, oldest evicted past MAX_SIGNATURES. */
export async function addSignature(sig: SavedSignature): Promise<SavedSignature[]> {
  const list = [sig, ...(await loadSignatures())].slice(0, MAX_SIGNATURES);
  await chrome.storage.local.set({ [KEY_SIGNATURES]: list });
  return list;
}

export async function deleteSignature(id: string): Promise<SavedSignature[]> {
  const list = (await loadSignatures()).filter((s) => s.id !== id);
  await chrome.storage.local.set({ [KEY_SIGNATURES]: list });
  return list;
}
