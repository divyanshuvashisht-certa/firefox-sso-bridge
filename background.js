/*
 * Firefox-only OAuth handoff prototype.
 *
 * Security model:
 * - Client sites run in native Firefox containers, so Firefox isolates their
 *   cookies and storage without header rewriting.
 * - Only an authorization navigation to Google's accounts host moves to the
 *   default Firefox cookie store, where the existing Google SSO session lives.
 * - The add-on cancels the callback before the default store sends it to Certa,
 *   then loads that exact short-lived callback URL in the original container.
 *
 * This supports OAuth 2.0/OIDC authorization-code flows returning code/state in
 * a top-level query-string navigation. It intentionally fails closed for
 * implicit, fragment, form_post, or state-less flows.
 */

const DEFAULT_STORE = 'firefox-default';
const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.google.co.in']);
const CLIENT_SUFFIXES = ['.certa.site', '.certa.in', '.certaqa.com', '.certaqa.site', '.certa.com']; // Restrict interception to known company client hosts.
const pending = new Map(); // OAuth state -> handoff record
const MANAGED_CONTAINERS_KEY = 'managedContainerIds';

function isClientHost(hostname) {
  const host = hostname.toLowerCase();
  return CLIENT_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}
function isGoogleAuthorization(url) {
  // Google can use AccountChooser or a versioned OAuth path before presenting
  // the picker. OAuth parameters are the stable signal, not the path itself.
  return GOOGLE_AUTH_HOSTS.has(url.hostname.toLowerCase()) &&
    url.searchParams.has('client_id') && url.searchParams.has('redirect_uri');
}
function callbackBase(url) { return `${url.origin}${url.pathname}`; }
function bridgeUrl(state) { return browser.runtime.getURL(`bridge.html?state=${encodeURIComponent(state)}`); }

async function beginGoogleHandoff(details, url) {
  const sourceTab = await browser.tabs.get(details.tabId);
  if (sourceTab.cookieStoreId === DEFAULT_STORE) return {};

  const state = url.searchParams.get('state');
  const redirectUri = url.searchParams.get('redirect_uri');
  const responseType = url.searchParams.get('response_type') || '';
  const responseMode = url.searchParams.get('response_mode');
  if (!state || !redirectUri || !responseType.split(/\s+/).includes('code') || (responseMode && responseMode !== 'query')) {
    console.warn('Refusing unsupported OAuth request; no container handoff made.', details.url);
    return {};
  }

  let callback;
  try { callback = new URL(redirectUri); } catch { return {}; }
  // if (callback.protocol !== 'https:' || !isClientHost(callback.hostname)) return {};
  if (callback.protocol !== 'https:') return {};

  // OAuth state is an opaque, app-generated correlation token. Never invent or
  // reuse it; the client application validates it after the handoff.
  const record = {
    sourceTabId: details.tabId,
    sourceStoreId: sourceTab.cookieStoreId,
    callbackBase: callbackBase(callback),
    oauthTabId: null,
    createdAt: Date.now()
  };
  pending.set(state, record);

  try {
    const oauthTab = await browser.tabs.create({
      url: details.url,
      cookieStoreId: DEFAULT_STORE,
      active: true,
      openerTabId: details.tabId
    });
    record.oauthTabId = oauthTab.id;
    await browser.tabs.update(details.tabId, { url: bridgeUrl(state), active: false });
    return { cancel: true };
  } catch (error) {
    pending.delete(state);
    console.error('Could not create default-store OAuth tab.', error);
    return {};
  }
}

async function finishGoogleHandoff(details, url) {
  const state = url.searchParams.get('state');
  const record = state && pending.get(state);
  if (!record || details.tabId !== record.oauthTabId || callbackBase(url) !== record.callbackBase) return {};

  pending.delete(state);
  try {
    // Loading the callback in the original tab restores the app's container
    // cookie/state context. The authorization code remains single-use.
    await browser.tabs.update(record.sourceTabId, { url: details.url, active: true });
    await browser.tabs.remove(details.tabId);
    return { cancel: true };
  } catch (error) {
    console.error('Could not return OAuth callback to its container.', error);
    return { cancel: true }; // Never leak a callback into the default store.
  }
}

browser.webRequest.onBeforeRequest.addListener(async (details) => {
  if (details.type !== 'main_frame' || details.tabId < 0) return {};
  let url;
  try { url = new URL(details.url); } catch { return {}; }
  if (isGoogleAuthorization(url)) return beginGoogleHandoff(details, url);
  if (isClientHost(url.hostname)) return finishGoogleHandoff(details, url);
  // if (url.protocol == 'https:') return finishGoogleHandoff(details, url);
  return {};
}, { urls: ['<all_urls>'], types: ['main_frame'] }, ['blocking']);

// Avoid retaining abandoned login attempts. OAuth state values are never logged.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, record] of pending) if (record.createdAt < cutoff) pending.delete(state);
}, 60 * 1000);

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.type === 'create-container') {
    const name = String(message.name || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('Enter a client name.');
    const container = await browser.contextualIdentities.create({ name: name.slice(0, 80), color: message.color, icon: 'briefcase' });
    const stored = await browser.storage.local.get(MANAGED_CONTAINERS_KEY);
    const ids = new Set(stored[MANAGED_CONTAINERS_KEY] || []);
    ids.add(container.cookieStoreId);
    await browser.storage.local.set({ [MANAGED_CONTAINERS_KEY]: [...ids] });
    return container;
  }
  if (message?.type === 'open-container') {
    return browser.tabs.create({ url: message.url || 'about:blank', cookieStoreId: message.cookieStoreId, active: true });
  }
  if (message?.type === 'containers') {
    const stored = await browser.storage.local.get(MANAGED_CONTAINERS_KEY);
    const allContainers = await browser.contextualIdentities.query({});
    // One-time migration: retain existing custom containers made with the first
    // prototype release, but omit Firefox's four built-in identities.
    const builtInIds = new Set(['firefox-container-1', 'firefox-container-2', 'firefox-container-3', 'firefox-container-4']);
    const managedIds = Array.isArray(stored[MANAGED_CONTAINERS_KEY])
      ? stored[MANAGED_CONTAINERS_KEY]
      : allContainers.filter((container) => !builtInIds.has(container.cookieStoreId)).map((container) => container.cookieStoreId);
    const ids = new Set(managedIds);
    const containers = allContainers.filter((container) => ids.has(container.cookieStoreId));
    const existing = new Set(containers.map((container) => container.cookieStoreId));
    if (!Array.isArray(stored[MANAGED_CONTAINERS_KEY]) || existing.size !== ids.size) await browser.storage.local.set({ [MANAGED_CONTAINERS_KEY]: [...existing] });
    return containers;
  }
  if (message?.type === 'remove-container') {
    const stored = await browser.storage.local.get(MANAGED_CONTAINERS_KEY);
    const ids = new Set(stored[MANAGED_CONTAINERS_KEY] || []);
    if (!ids.has(message.cookieStoreId)) throw new Error('This container is not managed by this extension.');
    const tabs = await browser.tabs.query({ cookieStoreId: message.cookieStoreId });
    if (tabs.length) await browser.tabs.remove(tabs.map((tab) => tab.id));
    await browser.contextualIdentities.remove(message.cookieStoreId);
    ids.delete(message.cookieStoreId);
    await browser.storage.local.set({ [MANAGED_CONTAINERS_KEY]: [...ids] });
    return { ok: true };
  }
  throw new Error('Unknown message.');
});
