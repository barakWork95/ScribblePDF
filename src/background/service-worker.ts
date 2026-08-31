/**
 * MV3 service worker. Deliberately thin — it holds no document state and does
 * no PDF work. Three jobs:
 *
 *   1. Toolbar click → open the current tab's PDF in the viewer.
 *   2. Optionally (off by default) intercept .pdf navigations and route them to
 *      the viewer instead of Chrome's built-in one.
 *   3. Return a tab to the original PDF when the user exits the editor.
 *
 * PERMISSIONS MODEL: the extension declares no host permissions at install
 * time. Sites are granted one at a time by the user, from the viewer, and the
 * redirect rules are rebuilt from whatever has actually been granted. That
 * keeps the install-time prompt empty and means auto-open can only ever fire on
 * a site the user explicitly approved.
 */
import { DEFAULT_PREFS } from '@/core/types';
import type { Preferences } from '@/core/types';
import type { ExitEditorResponse, Message } from '@/core/messages';

const REDIRECT_RULE_ID = 1;

/**
 * Host patterns that mean "every site". The current model never requests these
 * — it asks for one concrete origin at a time — so if one is granted it was
 * either carried over from the pre-refactor build (which declared
 * `host_permissions: ["<all_urls>"]`) or chosen deliberately by the user in
 * chrome://extensions.
 */
const BROAD_HOST_PATTERNS = new Set([
  '<all_urls>',
  '*://*/*',
  'http://*/*',
  'https://*/*',
]);

/**
 * Marks the legacy revoke as done. Chrome keeps granted optional host
 * permissions across an unpacked reload (the extension ID is stable), so an
 * install that once declared <all_urls> keeps showing "On all sites" even after
 * the declaration is removed.
 */
const LEGACY_REVOKE_KEY = 'revokedLegacyBroadHosts';

/**
 * Tabs whose next navigation must NOT be redirected back into the viewer.
 * Held in session storage rather than a module variable because the service
 * worker can be terminated between the exit request and the navigation.
 */
const BYPASS_KEY = 'redirectBypassTabs';

const viewerUrl = (fileUrl?: string): string => {
  const base = chrome.runtime.getURL('viewer/viewer.html');
  return fileUrl ? `${base}?file=${encodeURIComponent(fileUrl)}` : base;
};

const isPdfUrl = (url: string | undefined): boolean =>
  !!url && /\.pdf(\?|#|$)/i.test(url) && /^(https?|file):/i.test(url);

// ------------------------------------------------------------ bypass state

async function getBypassTabs(): Promise<number[]> {
  const got = await chrome.storage.session.get(BYPASS_KEY);
  return (got[BYPASS_KEY] as number[] | undefined) ?? [];
}

async function setBypassTabs(ids: number[]): Promise<void> {
  await chrome.storage.session.set({ [BYPASS_KEY]: ids });
}

// ------------------------------------------------------------- redirect rule

interface DomainFilter {
  /** True when the user granted every host, so no domain filter is needed. */
  all: boolean;
  domains: string[];
}

/** Reduce granted origin patterns to a declarativeNetRequest domain filter. */
function domainFilter(origins: string[]): DomainFilter {
  const domains = new Set<string>();
  for (const pattern of origins) {
    const match = /^https?:\/\/([^/]+)\//.exec(pattern);
    if (!match) continue;
    const host = match[1]!;
    if (host === '*') return { all: true, domains: [] };
    // requestDomains already matches subdomains, so "*.example.com" collapses.
    domains.add(host.replace(/^\*\./, ''));
  }
  return { all: false, domains: [...domains] };
}

/**
 * Rebuild the single redirect rule from current preferences, granted origins
 * and bypassed tabs.
 *
 * Session-scoped rather than dynamic: `excludedTabIds` is only supported for
 * session rules, and that is what lets "exit editor" escape without bouncing
 * straight back in. Session rules are cleared when the browser restarts, which
 * is why onStartup re-registers.
 */
async function rebuildRedirectRule(): Promise<void> {
  const [prefs, bypass, permissions] = await Promise.all([
    loadPrefs(),
    getBypassTabs(),
    chrome.permissions.getAll(),
  ]);

  const filter = domainFilter(permissions.origins ?? []);
  const enabled = prefs.autoOpen && (filter.all || filter.domains.length > 0);

  const condition: chrome.declarativeNetRequest.RuleCondition = {
    // `\0` in regexSubstitution is the whole match. The filter deliberately
    // excludes URLs carrying a query string: the substituted URL is raw, and an
    // unencoded `&` in the source would split our own `file=` parameter.
    regexFilter: String.raw`^https?://[^?#]+\.pdf$`,
    resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
  };
  if (!filter.all) condition.requestDomains = filter.domains;
  if (bypass.length > 0) condition.excludedTabIds = bypass;

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REDIRECT_RULE_ID],
    addRules: enabled
      ? [
          {
            id: REDIRECT_RULE_ID,
            priority: 1,
            action: {
              type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
              redirect: {
                regexSubstitution: `${chrome.runtime.getURL('viewer/viewer.html')}?file=\\0`,
              },
            },
            condition,
          },
        ]
      : [],
  });
}

async function loadPrefs(): Promise<Preferences> {
  const got = await chrome.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...(got.prefs as Partial<Preferences> | undefined) };
}

/**
 * One-time migration: drop broad host grants inherited from the old manifest.
 *
 * Deliberately runs ONCE, not on every startup. The chrome://extensions site
 * access dropdown lets a user choose "On all sites" for themselves, which
 * grants exactly these patterns — revoking on every start would silently undo
 * that choice and fight the user.
 */
async function revokeLegacyBroadHostGrants(): Promise<void> {
  const done = await chrome.storage.local.get(LEGACY_REVOKE_KEY);
  if (done[LEGACY_REVOKE_KEY]) return;

  try {
    const { origins = [] } = await chrome.permissions.getAll();
    const broad = origins.filter((o) => BROAD_HOST_PATTERNS.has(o));
    if (broad.length > 0) {
      const removed = await chrome.permissions.remove({ origins: broad });
      console.info(
        `[scribblepdf] legacy broad host grants ${removed ? 'revoked' : 'could not be revoked'}:`,
        broad,
      );
    }
  } catch (err) {
    // Not fatal: the user can still reset access from chrome://extensions.
    console.warn('[scribblepdf] could not revoke legacy host grants', err);
  } finally {
    await chrome.storage.local.set({ [LEGACY_REVOKE_KEY]: true });
  }
}

// ----------------------------------------------------------------- listeners

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (typeof tab.id !== 'number') return;
    if (isPdfUrl(tab.url)) {
      // Replace the current tab so the back button still returns to the source.
      await chrome.tabs.update(tab.id, { url: viewerUrl(tab.url) });
      return;
    }
    if (!tab.url) {
      // activeTab should populate tab.url at invocation. If a future Chrome
      // withholds it, open an empty viewer rather than failing silently — the
      // user can still pick a file from disk.
      console.warn('[scribblepdf] tab.url unavailable on action click; opening picker');
    }
    await chrome.tabs.create({ url: viewerUrl() });
  })();
});

chrome.runtime.onMessage.addListener(
  (message: Message, sender, sendResponse: (r: ExitEditorResponse) => void) => {
    if (message?.type !== 'exitEditor') return undefined;

    void (async () => {
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, reason: 'no-tab' });
        return;
      }
      // Suppress our own redirect for this tab's next navigation. Without it,
      // exiting while auto-open is enabled would bounce straight back in.
      const bypass = await getBypassTabs();
      if (!bypass.includes(tabId)) {
        await setBypassTabs([...bypass, tabId]);
        await rebuildRedirectRule();
      }
      try {
        await chrome.tabs.update(tabId, { url: message.url });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, reason: String(err) });
      }
    })();

    return true; // response is asynchronous
  },
);

/** Clear a tab's bypass once its navigation has settled. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  void (async () => {
    const bypass = await getBypassTabs();
    if (!bypass.includes(tabId)) return;
    await setBypassTabs(bypass.filter((id) => id !== tabId));
    await rebuildRedirectRule();
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const bypass = await getBypassTabs();
    if (!bypass.includes(tabId)) return;
    await setBypassTabs(bypass.filter((id) => id !== tabId));
    await rebuildRedirectRule();
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await revokeLegacyBroadHostGrants();
    await rebuildRedirectRule();
  })();
});
chrome.runtime.onStartup.addListener(() => void rebuildRedirectRule());

// A newly granted site may need a redirect rule; a revoked one must lose it.
chrome.permissions.onAdded.addListener(() => void rebuildRedirectRule());
chrome.permissions.onRemoved.addListener(() => void rebuildRedirectRule());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.prefs) return;
  const next = changes.prefs.newValue as Preferences | undefined;
  const prev = changes.prefs.oldValue as Preferences | undefined;
  if (next?.autoOpen !== prev?.autoOpen) void rebuildRedirectRule();
});
