/**
 * Dev-harness shim for the `chrome.*` APIs.
 *
 * Lets the real viewer bundle run as an ordinary web page so it can be driven
 * by browser automation without packing and installing the extension. Only the
 * extension surface is faked; everything else is the shipping code.
 */
(() => {
  const mem = JSON.parse(localStorage.getItem('pa-dev-store') || '{}');
  const session = {};
  const persist = () => localStorage.setItem('pa-dev-store', JSON.stringify(mem));

  // Origins "granted" in the harness. Set to [] to exercise the grant prompt.
  const granted = new Set(JSON.parse(localStorage.getItem('pa-dev-origins') || '["*"]'));
  const saveOrigins = () =>
    localStorage.setItem('pa-dev-origins', JSON.stringify([...granted]));

  const area = (store, onPersist) => ({
    get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
    set: async (o) => {
      Object.assign(store, o);
      onPersist?.();
    },
    remove: async (k) => {
      delete store[k];
      onPersist?.();
    },
  });

  window.chrome = {
    runtime: {
      getURL: (p) => new URL('/' + p.replace(/^\//, ''), location.origin).href,
      // No service worker in the harness: the viewer falls back to navigating.
      sendMessage: async () => undefined,
      onMessage: { addListener() {} },
    },
    storage: {
      local: area(mem, persist),
      session: area(session),
      onChanged: { addListener() {} },
    },
    permissions: {
      contains: async ({ origins = [] }) =>
        granted.has('*') || origins.every((o) => granted.has(o)),
      request: async ({ origins = [] }) => {
        // Mirrors a user accepting the Chrome prompt.
        origins.forEach((o) => granted.add(o));
        saveOrigins();
        return true;
      },
      getAll: async () => ({ origins: [...granted] }),
      onAdded: { addListener() {} },
      onRemoved: { addListener() {} },
    },
  };

  // Test helpers, exposed for automation.
  window.__paHarness = {
    revokeAll: () => {
      granted.clear();
      saveOrigins();
    },
    grantAll: () => {
      granted.add('*');
      saveOrigins();
    },
    granted: () => [...granted],
  };
})();
