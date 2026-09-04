/**
 * Review-prompt eligibility.
 *
 * Deliberately separate from the toast that renders it: the rule ("ask once,
 * and only after the tool has actually proved useful") is the part worth being
 * able to reason about and test on its own.
 */

import { storage } from './platform';

/** Storage keys, fixed by the product spec. */
const KEY_SAVE_COUNT = 'pdfSaveCount';
const KEY_PROMPTED = 'hasPromptedForReview';

/** Successful exports before asking. Three means they came back twice. */
const SAVES_BEFORE_PROMPT = 3;

/**
 * The listing's review page.
 *
 * NOTE: the id below must match the real Chrome Web Store listing. ScribblePDF
 * is not published yet, so until the first submission goes through this link
 * will 404 — verify it after publishing.
 */
export const REVIEW_URL =
  'https://chromewebstore.google.com/detail/scribblepdf/bjifddabolpnopkphamnoandkflhfepc/reviews';

/** Count one successful export. Returns the new total. */
export async function recordPdfSaved(): Promise<number> {
  const stored = await storage().get(KEY_SAVE_COUNT);
  const previous = stored[KEY_SAVE_COUNT];
  const next = (typeof previous === 'number' && Number.isFinite(previous) ? previous : 0) + 1;
  await storage().set({ [KEY_SAVE_COUNT]: next });
  return next;
}

/** True only when the user has saved enough and has never been asked. */
export async function shouldPromptForReview(): Promise<boolean> {
  const stored = await storage().get([KEY_SAVE_COUNT, KEY_PROMPTED]);
  if (stored[KEY_PROMPTED]) return false;
  const count = stored[KEY_SAVE_COUNT];
  return typeof count === 'number' && count >= SAVES_BEFORE_PROMPT;
}

/** Record that the prompt has been shown, so it never appears again. */
export async function markReviewPrompted(): Promise<void> {
  await storage().set({ [KEY_PROMPTED]: true });
}
