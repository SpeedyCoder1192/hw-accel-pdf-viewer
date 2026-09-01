// MV3 service worker: takes over PDF navigations.
//
// There is no blocking webRequest in MV3, so interception is done with
// declarativeNetRequest redirect rules. They are installed dynamically rather
// than shipped as static rules because the redirect target contains the
// extension's own id, which is only known at runtime.
//
// Two rules, because neither alone is enough:
//   1. URLs that end in .pdf              -- catches the common case immediately.
//   2. Responses whose Content-Type is a  -- catches /download?id=123 style URLs.
//      PDF (Chrome 128+)
// Rule 2 is skipped on browsers that do not support response-header conditions.

const RULE_BY_URL = 1;
const RULE_BY_TYPE = 2;
const STORE_KEY = 'takeover';

const viewerUrl = () => chrome.runtime.getURL('viewer.html');

function urlRule() {
  return {
    id: RULE_BY_URL,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${viewerUrl()}?file=\\1` } },
    condition: {
      // The whole URL is captured so \1 can be pasted after ?file=.
      regexFilter: '^((?:https?|file)://[^\\s]+?\\.pdf(?:[?#][^\\s]*)?)$',
      isUrlFilterCaseSensitive: false,
      resourceTypes: ['main_frame'],
    },
  };
}

function typeRule() {
  return {
    id: RULE_BY_TYPE,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${viewerUrl()}?file=\\1` } },
    condition: {
      regexFilter: '^(https?://[^\\s]+)$',
      isUrlFilterCaseSensitive: false,
      resourceTypes: ['main_frame'],
      responseHeaders: [
        { header: 'content-type', values: ['application/pdf*', 'application/x-pdf*'] },
      ],
      // A server asking for a download gets a download, not a viewer.
      excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
    },
  };
}

async function clearRules() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_BY_URL, RULE_BY_TYPE],
  });
}

/** Response-header conditions landed in Chrome 128. */
function supportsResponseHeaders() {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent || '');
  return m ? Number(m[1]) >= 128 : false;
}

async function installRules() {
  await clearRules();
  const rules = supportsResponseHeaders() ? [urlRule(), typeRule()] : [urlRule()];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  } catch (err) {
    console.warn('content-type rule rejected, falling back to .pdf URLs only:', err?.message);
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [urlRule()] });
  }
  await verifyTypeRule();
}

/**
 * Rule 2 is a catch-all narrowed only by its response-header condition. A
 * browser that accepted the rule but dropped that condition would redirect
 * every page to the viewer, so the rule is read back and removed unless the
 * condition survived.
 */
async function verifyTypeRule() {
  const installed = await chrome.declarativeNetRequest.getDynamicRules();
  const rule = installed.find((r) => r.id === RULE_BY_TYPE);
  if (rule && !rule.condition?.responseHeaders?.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_BY_TYPE] });
    console.warn('response-header conditions unsupported; takeover limited to .pdf URLs');
  }
}

async function sync() {
  const { [STORE_KEY]: enabled = true } = await chrome.storage.sync.get(STORE_KEY);
  if (enabled) await installRules();
  else await clearRules();
  await chrome.action.setTitle({
    title: enabled ? 'Open GPU PDF Viewer' : 'Open GPU PDF Viewer (PDF takeover off)',
  });
}

chrome.runtime.onInstalled.addListener(() => sync());
chrome.runtime.onStartup.addListener(() => sync());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && STORE_KEY in changes) sync();
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: viewerUrl() });
});

// ---------------------------------------------------------- pending lookups
//
// The redirect passes the document URL in the query string, but that handoff is
// one URL rewrite deep and easy to lose (an odd URL, a browser that normalizes
// the substitution). So every PDF navigation is also recorded here, per tab,
// and the viewer can ask what it was opened for if it arrives without a URL.
// Observation only -- MV3 has no blocking webRequest, and none is wanted.

const PENDING_TTL = 60_000;
const pending = new Map(); // tabId -> { url, at }

const PDF_URL = /^(?:https?|file):\/\/[^\s]+?\.pdf(?:[?#][^\s]*)?$/i;

function remember(tabId, url) {
  if (tabId < 0 || !url || url.startsWith(chrome.runtime.getURL(''))) return;
  pending.set(tabId, { url, at: Date.now() });
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (PDF_URL.test(d.url)) remember(d.tabId, d.url);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

// Catches PDFs served from URLs that do not end in .pdf. This cannot redirect
// (non-blocking), but it means the viewer can still recover the URL.
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const headers = d.responseHeaders || [];
    const get = (name) =>
      headers.find((h) => h.name.toLowerCase() === name)?.value?.toLowerCase() || '';
    if (!/^application\/(x-)?pdf/.test(get('content-type'))) return;
    if (get('content-disposition').startsWith('attachment')) return;
    remember(d.tabId, d.url);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => pending.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'pendingUrl') return false;
  const tabId = sender.tab?.id;
  const entry = tabId === undefined ? null : pending.get(tabId);
  const fresh = entry && Date.now() - entry.at < PENDING_TTL;
  sendResponse({ url: fresh ? entry.url : null });
  return false;
});
