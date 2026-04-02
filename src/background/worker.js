importScripts("../common/protocol.js");

const { MESSAGE_TYPES, STATUS, SITE_LABELS, SITES } = self.CAT_MONITOR_PROTOCOL;

const DEFAULT_SITE_ENABLED = {
  [SITES.CHATGPT]: true,
  [SITES.GEMINI]: true,
  [SITES.CLAUDE]: true,
  [SITES.DEEPSEEK]: true,
  [SITES.KIMI]: true
};

const statusByTabSite = new Map();
const openAiTabs = new Map();
let lastDoneRef = null;
let badgeFlashUntil = 0;
let badgeFlashLabel = "";

const BADGE_FLASH_MS = 6000;
const lang = detectUiLang();
const I18N = {
  zh: {
    donePrefix: "已完成",
    runningTitle: (count) => `运行中: ${count} 个标签页`,
    idleTitle: "AI 输出状态猫监控",
    unknownInstance: "某个实例"
  },
  en: {
    donePrefix: "Done",
    runningTitle: (count) => `Running: ${count} tab(s)`,
    idleTitle: "AI Output Cat Monitor",
    unknownInstance: "an instance"
  }
};

function detectUiLang() {
  const raw = (chrome.i18n?.getUILanguage?.() || "en").toLowerCase();
  return raw.startsWith("zh") ? "zh" : "en";
}

function i18n() {
  return I18N[lang] || I18N.en;
}

function makeKey(tabId, site) {
  return `${tabId}:${site}`;
}

function detectSiteFromUrl(urlString) {
  if (!urlString) {
    return null;
  }
  try {
    const host = new URL(urlString).hostname;
    if (/(^|\.)chatgpt\.com$/i.test(host) || /(^|\.)chat\.openai\.com$/i.test(host)) {
      return SITES.CHATGPT;
    }
    if (/(^|\.)gemini\.google\.com$/i.test(host)) {
      return SITES.GEMINI;
    }
    if (/(^|\.)claude\.ai$/i.test(host)) {
      return SITES.CLAUDE;
    }
    if (/(^|\.)chat\.deepseek\.com$/i.test(host) || /(^|\.)deepseek\.com$/i.test(host) || /(^|\.)www\.deepseek\.com$/i.test(host)) {
      return SITES.DEEPSEEK;
    }
    if (/(^|\.)kimi\.moonshot\.cn$/i.test(host) || /(^|\.)kimi\.com$/i.test(host) || /(^|\.)www\.kimi\.com$/i.test(host)) {
      return SITES.KIMI;
    }
    return null;
  } catch {
    return null;
  }
}

function upsertOpenAiTab(tab) {
  const tabId = tab?.id;
  if (typeof tabId !== "number") {
    return;
  }
  const site = detectSiteFromUrl(tab.url);
  if (!site) {
    openAiTabs.delete(tabId);
    return;
  }
  openAiTabs.set(tabId, {
    tabId,
    site,
    title: tab.title || "",
    url: tab.url || ""
  });
}

function refreshOpenAiTabs(callback) {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) {
      if (callback) {
        callback();
      }
      return;
    }
    openAiTabs.clear();
    for (const tab of tabs) {
      upsertOpenAiTab(tab);
    }
    if (callback) {
      callback();
    }
  });
}

function buildInstances() {
  const mergedByKey = new Map();

  for (const row of statusByTabSite.values()) {
    mergedByKey.set(makeKey(row.tabId, row.site), { ...row });
  }
  for (const row of openAiTabs.values()) {
    const key = makeKey(row.tabId, row.site);
    if (!mergedByKey.has(key)) {
      mergedByKey.set(key, {
        tabId: row.tabId,
        site: row.site,
        status: STATUS.IDLE,
        ts: Date.now(),
        title: row.title || "",
        url: row.url || ""
      });
    }
  }

  const rows = Array.from(mergedByKey.values()).sort((a, b) => {
    if (a.site !== b.site) {
      return a.site.localeCompare(b.site);
    }
    return a.tabId - b.tabId;
  });

  const perSiteCounter = {};
  return rows.map((row) => {
    const count = (perSiteCounter[row.site] || 0) + 1;
    perSiteCounter[row.site] = count;

    return {
      site: row.site,
      tabId: row.tabId,
      status: row.status,
      ts: row.ts,
      title: row.title || "",
      url: row.url || "",
      instanceIndex: count,
      displayName: `${SITE_LABELS[row.site] || row.site} #${count}`
    };
  });
}

function computeAggregateState() {
  const instances = buildInstances();
  const activeSites = new Set();
  const generatingInstances = [];
  const idleInstances = [];

  for (const item of instances) {
    if (item.status === STATUS.GENERATING) {
      activeSites.add(item.site);
      generatingInstances.push(item);
    } else {
      idleInstances.push(item);
    }
  }

  let lastDone = null;
  if (lastDoneRef) {
    const match = instances.find((x) => x.site === lastDoneRef.site && x.tabId === lastDoneRef.tabId);
    if (match) {
      lastDone = {
        site: match.site,
        tabId: match.tabId,
        displayName: match.displayName,
        title: match.title,
        ts: Date.now()
      };
    }
  }

  return {
    globalStatus: generatingInstances.length > 0 ? STATUS.GENERATING : STATUS.IDLE,
    activeSites: Array.from(activeSites),
    generatingInstances,
    idleInstances,
    instances,
    lastDone,
    ts: Date.now()
  };
}

function broadcast(message) {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !tabs) {
      return;
    }

    for (const tab of tabs) {
      if (!tab.id) {
        continue;
      }
      chrome.tabs.sendMessage(tab.id, message, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function setBadge(text, color, title) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

function applyBadgeFromAggregate(aggregate) {
  const textMap = i18n();
  if (Date.now() < badgeFlashUntil) {
    setBadge("!", "#16a34a", `${textMap.donePrefix}: ${badgeFlashLabel}`);
    return;
  }

  const runningCount = aggregate.generatingInstances.length;
  if (runningCount > 0) {
    const text = runningCount > 99 ? "99+" : String(runningCount);
    setBadge(text, "#f97316", textMap.runningTitle(runningCount));
    return;
  }

  setBadge("", "#6b7280", textMap.idleTitle);
}

function flashDoneBadge(label) {
  badgeFlashLabel = label || i18n().unknownInstance;
  badgeFlashUntil = Date.now() + BADGE_FLASH_MS;
  applyBadgeFromAggregate(computeAggregateState());
}

function broadcastAggregate() {
  refreshOpenAiTabs(() => {
    const aggregate = computeAggregateState();
    applyBadgeFromAggregate(aggregate);
    const payload = {
      type: MESSAGE_TYPES.CAT_STATE_UPDATE,
      data: aggregate
    };
    broadcast(payload);
  });
}

function ensureDefaults() {
  chrome.storage.local.get(["siteEnabled", "debug"], (store) => {
    const next = {};
    if (!store.siteEnabled) {
      next.siteEnabled = DEFAULT_SITE_ENABLED;
    }
    if (typeof store.debug !== "boolean") {
      next.debug = false;
    }
    if (Object.keys(next).length > 0) {
      chrome.storage.local.set(next);
    }
  });
}

function cleanupTab(tabId) {
  let changed = false;
  const toDelete = [];
  for (const key of statusByTabSite.keys()) {
    if (key.startsWith(`${tabId}:`)) {
      toDelete.push(key);
    }
  }

  for (const key of toDelete) {
    statusByTabSite.delete(key);
    changed = true;
  }

  if (lastDoneRef?.tabId === tabId) {
    lastDoneRef = null;
    changed = true;
  }

  return changed;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults();
  refreshOpenAiTabs();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults();
  broadcastAggregate();
});

chrome.tabs.onCreated.addListener((tab) => {
  upsertOpenAiTab(tab);
  broadcastAggregate();
});

chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
  if (typeof tabId !== "number") {
    return;
  }
  upsertOpenAiTab({ ...tab, id: tabId });
  broadcastAggregate();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const hadOpenTab = openAiTabs.delete(tabId);
  const hadStatus = cleanupTab(tabId);
  if (hadOpenTab || hadStatus) {
    broadcastAggregate();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === MESSAGE_TYPES.REQUEST_STATE) {
    refreshOpenAiTabs(() => {
      sendResponse({ ok: true, data: computeAggregateState() });
    });
    return true;
  }

  if (message.type !== MESSAGE_TYPES.STATUS_CHANGED) {
    return;
  }

  const event = message.data;
  const tabId = event?.tabId ?? sender?.tab?.id;

  if (typeof tabId !== "number" || !event?.site || !event?.status) {
    sendResponse({ ok: false, error: "invalid STATUS_CHANGED payload" });
    return;
  }

  const key = makeKey(tabId, event.site);
  const previous = statusByTabSite.get(key);

  statusByTabSite.set(key, {
    tabId,
    site: event.site,
    status: event.status,
    ts: event.ts || Date.now(),
    title: sender?.tab?.title || event?.title || "",
    url: sender?.tab?.url || event?.url || ""
  });
  upsertOpenAiTab({
    id: tabId,
    url: sender?.tab?.url || event?.url || "",
    title: sender?.tab?.title || event?.title || ""
  });

  if (previous?.status === STATUS.GENERATING && event.status === STATUS.IDLE) {
    lastDoneRef = { site: event.site, tabId };
    const snapshot = computeAggregateState();
    const instance = snapshot.instances.find((x) => x.site === event.site && x.tabId === tabId);
    const displayName = instance?.displayName || SITE_LABELS[event.site] || event.site;

    flashDoneBadge(displayName);

    broadcast({
      type: MESSAGE_TYPES.SITE_DONE,
      data: {
        site: event.site,
        tabId,
        ts: Date.now(),
        displayName,
        title: instance?.title || ""
      }
    });
  }

  broadcastAggregate();
  sendResponse({ ok: true });
});
