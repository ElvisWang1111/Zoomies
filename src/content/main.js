(function initCatMonitor() {
  if (typeof chrome === "undefined" || !chrome.runtime) {
    return;
  }

  const { MESSAGE_TYPES, STATUS, SITES, SITE_LABELS } = window.CAT_MONITOR_PROTOCOL;

  const SITE_HOST_PATTERNS = [
    { site: SITES.CHATGPT, pattern: /(^|\.)chatgpt\.com$/i },
    { site: SITES.CHATGPT, pattern: /(^|\.)chat\.openai\.com$/i },
    { site: SITES.GEMINI, pattern: /(^|\.)gemini\.google\.com$/i },
    { site: SITES.CLAUDE, pattern: /(^|\.)claude\.ai$/i },
    { site: SITES.DEEPSEEK, pattern: /(^|\.)chat\.deepseek\.com$/i },
    { site: SITES.DEEPSEEK, pattern: /(^|\.)deepseek\.com$/i },
    { site: SITES.DEEPSEEK, pattern: /(^|\.)www\.deepseek\.com$/i }
  ];

  const MIN_SWITCH_MS = 700;
  const IDLE_BY_INACTIVITY_MS = 2200;
  const CHECK_INTERVAL_MS = 900;

  const STOP_KEYWORDS = ["stop", "停止", "cancel"];
  const SEND_KEYWORDS = ["send", "发送", "submit", "run"];
  const UI_STRINGS = {
    zh: {
      panelTitle: "LLM 状态概览",
      collapse: "收起",
      expand: "展开",
      running: "运行中",
      idle: "空闲",
      noTracked: "无已跟踪模型",
      clickToExpand: "点击展开面板",
      clickToCollapse: "点击折叠面板",
      catAlt: "状态猫"
    },
    en: {
      panelTitle: "LLM Status Overview",
      collapse: "Collapse",
      expand: "Expand",
      running: "Running",
      idle: "Idle",
      noTracked: "No tracked models",
      clickToExpand: "Click to expand panel",
      clickToCollapse: "Click to collapse panel",
      catAlt: "Status cat"
    }
  };

  let debugEnabled = false;
  const lang = detectUiLang();

  function detectUiLang() {
    const raw = (chrome.i18n?.getUILanguage?.() || navigator.language || "en").toLowerCase();
    return raw.startsWith("zh") ? "zh" : "en";
  }

  function t(key) {
    return UI_STRINGS[lang][key] || UI_STRINGS.en[key] || key;
  }

  function logDebug(...args) {
    if (debugEnabled) {
      console.debug("[cat-monitor]", ...args);
    }
  }

  function normalizeText(value) {
    return (value || "").toString().trim().toLowerCase();
  }

  function elementTextBucket(el) {
    if (!el) {
      return "";
    }
    const parts = [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-testid"),
      el.getAttribute("name"),
      el.textContent
    ];
    return normalizeText(parts.filter(Boolean).join(" "));
  }

  function hasKeywordControl(root, keywords) {
    const controls = root.querySelectorAll("button, [role='button']");
    for (const ctrl of controls) {
      const bucket = elementTextBucket(ctrl);
      for (const keyword of keywords) {
        if (bucket.includes(keyword)) {
          return true;
        }
      }
    }
    return false;
  }

  function hasLikelyEnabledSendControl(root) {
    const controls = root.querySelectorAll("button, [role='button']");
    for (const ctrl of controls) {
      const bucket = elementTextBucket(ctrl);
      const disabled = ctrl.hasAttribute("disabled") || ctrl.getAttribute("aria-disabled") === "true";
      if (disabled) {
        continue;
      }
      for (const keyword of SEND_KEYWORDS) {
        if (bucket.includes(keyword)) {
          return true;
        }
      }
    }
    return false;
  }

  function makeGenericAdapter(site) {
    return {
      site,
      detectGenerating(root) {
        return hasKeywordControl(root, STOP_KEYWORDS);
      },
      detectIdle(root) {
        return !this.detectGenerating(root) && hasLikelyEnabledSendControl(root);
      }
    };
  }

  const adapters = {
    [SITES.CHATGPT]: {
      site: SITES.CHATGPT,
      detectGenerating(root) {
        return !!root.querySelector("button[data-testid='stop-button']") || hasKeywordControl(root, STOP_KEYWORDS);
      },
      detectIdle(root) {
        const hasSend =
          !!root.querySelector("button[data-testid='send-button']") ||
          !!root.querySelector("button[aria-label*='Send']") ||
          hasLikelyEnabledSendControl(root);
        return !this.detectGenerating(root) && hasSend;
      }
    },
    [SITES.GEMINI]: {
      site: SITES.GEMINI,
      detectGenerating(root) {
        return hasKeywordControl(root, STOP_KEYWORDS) || !!root.querySelector("button[aria-label*='Stop']");
      },
      detectIdle(root) {
        const hasPromptArea = !!root.querySelector("rich-textarea, textarea, [contenteditable='true']");
        return !this.detectGenerating(root) && hasPromptArea;
      }
    },
    [SITES.CLAUDE]: {
      site: SITES.CLAUDE,
      detectGenerating(root) {
        return hasKeywordControl(root, STOP_KEYWORDS) || !!root.querySelector("button[data-testid='stop-button']");
      },
      detectIdle(root) {
        const hasComposer = !!root.querySelector("textarea, [contenteditable='true']");
        return !this.detectGenerating(root) && hasComposer;
      }
    },
    [SITES.DEEPSEEK]: {
      site: SITES.DEEPSEEK,
      detectGenerating(root) {
        return hasKeywordControl(root, STOP_KEYWORDS) || !!root.querySelector("button[aria-label*='Stop']");
      },
      detectIdle(root) {
        const hasComposer = !!root.querySelector("textarea, [contenteditable='true']");
        return !this.detectGenerating(root) && hasComposer;
      }
    }
  };

  for (const key of Object.keys(adapters)) {
    const adapter = adapters[key];
    if (!adapter.detectGenerating || !adapter.detectIdle) {
      adapters[key] = makeGenericAdapter(key);
    }
  }

  function detectCurrentSite() {
    const host = window.location.hostname;
    for (const item of SITE_HOST_PATTERNS) {
      if (item.pattern.test(host)) {
        return item.site;
      }
    }
    return null;
  }

  function createOverlay() {
    const host = document.createElement("div");
    host.id = "cat-monitor-overlay-host";
    host.style.all = "initial";

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .wrap {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        font-family: "SF Pro Text", "Segoe UI", sans-serif;
        pointer-events: none;
      }
      .card {
        --text-main: #0f172a;
        --text-sub: rgba(15, 23, 42, 0.76);
        --surface: linear-gradient(135deg, rgba(248, 250, 252, 0.5), rgba(241, 245, 249, 0.36));
        --border: rgba(255, 255, 255, 0.2);
        --provider-bg: rgba(255, 255, 255, 0.26);
        --provider-border: rgba(148, 163, 184, 0.3);
        --provider-run-bg: rgba(14, 165, 233, 0.18);
        --provider-run-border: rgba(104, 181, 228, 0.08);
        --cat-color: #f59e0b;
        color: var(--text-main);
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 18px;
        background: var(--surface);
        border: 1px solid var(--border);
        backdrop-filter: blur(16px) saturate(160%);
        -webkit-backdrop-filter: blur(16px) saturate(160%);
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.2);
        min-width: 300px;
        max-width: 420px;
        pointer-events: auto;
      }
      .card.collapsed {
        min-width: 0;
        max-width: none;
        padding: 8px;
        border-radius: 999px;
        gap: 0;
      }
      .cat {
        width: 44px;
        height: 44px;
        object-fit: contain;
        transform-origin: center;
        flex: 0 0 auto;
        margin-top: -2px;
        cursor: pointer;
        user-select: none;
      }
      .card.collapsed .cat {
        margin-top: 0;
      }
      .cat.running {
        animation: cat-run 0.45s infinite ease-in-out;
      }
      .cat.notify {
        animation: cat-notify 0.8s ease-in-out 3;
      }
      .status {
        display: flex;
        flex-direction: column;
        line-height: 1.3;
        min-width: 0;
        gap: 6px;
        width: 100%;
      }
      .card.collapsed .status {
        display: none;
      }
      .topline {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .title {
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0.2px;
      }
      .collapse-btn {
        pointer-events: auto;
        cursor: pointer;
        border: 1px solid var(--provider-border);
        background: rgba(255, 255, 255, 0.35);
        color: var(--text-main);
        border-radius: 999px;
        font-size: 10px;
        padding: 2px 8px;
      }
      .card.collapsed .collapse-btn {
        display: none;
      }
      .provider-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px;
      }
      .provider-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        border: 1px solid var(--provider-border);
        border-radius: 10px;
        background: var(--provider-bg);
        padding: 6px 8px;
      }
      .provider-row.running {
        border-color: var(--provider-run-border);
        background: var(--provider-run-bg);
      }
      .provider-name {
        font-weight: 700;
      }
      .provider-counts {
        color: var(--text-sub);
      }
      .row {
        font-size: 11px;
        color: var(--text-sub);
      }
      @keyframes cat-run {
        0% { transform: translateX(0) translateY(0); }
        50% { transform: translateX(2px) translateY(-2px); }
        100% { transform: translateX(0) translateY(0); }
      }
      @keyframes cat-notify {
        0% { transform: translateX(0) scale(1); }
        50% { transform: translateX(2px) scale(1.03); }
        100% { transform: translateX(0) scale(1); }
      }
    `;

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const card = document.createElement("div");
    card.className = "card";

    const cat = document.createElement("img");
    cat.className = "cat";
    cat.src = chrome.runtime.getURL("src/assets/cat.png");
    cat.alt = t("catAlt");

    const status = document.createElement("div");
    status.className = "status";
    const topline = document.createElement("div");
    topline.className = "topline";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = t("panelTitle");
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "collapse-btn";
    collapseBtn.textContent = t("collapse");
    topline.appendChild(title);
    topline.appendChild(collapseBtn);

    const providerGrid = document.createElement("div");
    providerGrid.className = "provider-grid";

    status.appendChild(topline);
    status.appendChild(providerGrid);
    card.appendChild(cat);
    card.appendChild(status);
    wrap.appendChild(card);
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    const mount = () => {
      if (!document.documentElement.contains(host)) {
        document.documentElement.appendChild(host);
      }
    };
    if (document.documentElement) {
      mount();
    } else {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    }

    let collapsed = false;

    function renderInstanceCards(instances) {
      const rows = Array.isArray(instances)
        ? [...instances].sort((a, b) => {
            if (a.site !== b.site) {
              return a.site.localeCompare(b.site);
            }
            return (a.instanceIndex || 0) - (b.instanceIndex || 0);
          })
        : [];

      providerGrid.replaceChildren();
      for (const item of rows) {
        const row = document.createElement("div");
        row.className = "provider-row";
        if (item.status === STATUS.GENERATING) {
          row.classList.add("running");
        }
        const name = document.createElement("div");
        name.className = "provider-name";
        name.textContent = item.displayName || `${SITE_LABELS[item.site] || item.site}`;
        const counts = document.createElement("div");
        counts.className = "provider-counts";
        counts.textContent = item.status === STATUS.GENERATING ? t("running") : t("idle");
        row.appendChild(name);
        row.appendChild(counts);
        providerGrid.appendChild(row);
      }

      if (providerGrid.childElementCount === 0) {
        const empty = document.createElement("div");
        empty.className = "row";
        empty.textContent = t("noTracked");
        providerGrid.appendChild(empty);
      }
    }

    function applyCollapsed(nextCollapsed, persist = true) {
      collapsed = !!nextCollapsed;
      card.classList.toggle("collapsed", collapsed);
      collapseBtn.textContent = collapsed ? t("expand") : t("collapse");
      cat.title = collapsed ? t("clickToExpand") : t("clickToCollapse");
      if (persist) {
        chrome.storage.local.set({ catCollapsed: collapsed });
      }
    }

    collapseBtn.addEventListener("click", () => {
      applyCollapsed(!collapsed);
    });
    cat.addEventListener("click", () => {
      applyCollapsed(!collapsed);
    });

    cat.addEventListener("animationend", (event) => {
      if (event.animationName === "cat-notify") {
        cat.classList.remove("notify");
      }
    });

    return {
      applyCollapsed,
      setState(data) {
        const globalStatus = data?.globalStatus || STATUS.IDLE;
        const instances = Array.isArray(data?.instances) ? data.instances : [];
        if (globalStatus === STATUS.GENERATING) {
          cat.classList.remove("notify");
          cat.classList.add("running");
        } else {
          cat.classList.remove("running");
        }
        renderInstanceCards(instances);
      },
      setDone() {
        // Completion events are cross-tab and should not override global running state.
        cat.classList.remove("notify");
        void cat.offsetWidth;
        cat.classList.add("notify");
      }
    };
  }

  function startDetection(site, adapter) {
    let currentStatus = null;
    let pendingStatus = null;
    let pendingSince = 0;
    let lastMutationTs = 0;
    let lastSeenGeneratingTs = 0;
    const GENERATING_SIGNAL_TIMEOUT_MS = 1800;

    function sendStatus(nextStatus) {
      if (nextStatus === currentStatus) {
        return;
      }

      currentStatus = nextStatus;
      const payload = {
        type: MESSAGE_TYPES.STATUS_CHANGED,
        data: {
          site,
          status: nextStatus,
          ts: Date.now(),
          title: document.title,
          url: window.location.href
        }
      };

      chrome.runtime.sendMessage(payload, () => {
        void chrome.runtime.lastError;
      });

      logDebug("status change", { site, status: nextStatus });
    }

    function decideByHeuristic(explicitGenerating, explicitIdle) {
      const now = Date.now();

      if (explicitGenerating) {
        lastSeenGeneratingTs = now;
        return STATUS.GENERATING;
      }
      if (explicitIdle) {
        return STATUS.IDLE;
      }

      // If stop/running signal has disappeared for a while, force idle.
      if (currentStatus === STATUS.GENERATING && now - lastSeenGeneratingTs >= GENERATING_SIGNAL_TIMEOUT_MS) {
        return STATUS.IDLE;
      }

      if (currentStatus === STATUS.GENERATING) {
        if (now - lastMutationTs >= IDLE_BY_INACTIVITY_MS) {
          return STATUS.IDLE;
        }
        return STATUS.GENERATING;
      }
      return STATUS.IDLE;
    }

    function evaluate() {
      const root = document.body;
      if (!root) {
        return;
      }

      const explicitGenerating = adapter.detectGenerating(root);
      const explicitIdle = adapter.detectIdle(root);
      if (explicitGenerating) {
        lastSeenGeneratingTs = Date.now();
      }
      const next = decideByHeuristic(explicitGenerating, explicitIdle);

      if (currentStatus === null) {
        sendStatus(next);
        pendingStatus = null;
        return;
      }

      if (next === currentStatus) {
        pendingStatus = null;
        return;
      }

      const now = Date.now();
      if (pendingStatus !== next) {
        pendingStatus = next;
        pendingSince = now;
        return;
      }

      if (now - pendingSince >= MIN_SWITCH_MS) {
        sendStatus(next);
        pendingStatus = null;
      }
    }

    const observer = new MutationObserver(() => {
      lastMutationTs = Date.now();
      evaluate();
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-label", "title", "disabled", "aria-disabled", "data-testid"]
      });
    }

    const timer = window.setInterval(evaluate, CHECK_INTERVAL_MS);
    window.addEventListener("beforeunload", () => {
      observer.disconnect();
      window.clearInterval(timer);
    });

    evaluate();
  }

  const overlay = createOverlay();
  chrome.storage.local.get(["catCollapsed"], (store) => {
    overlay.applyCollapsed(!!store?.catCollapsed, false);
  });

  chrome.runtime.sendMessage({ type: MESSAGE_TYPES.REQUEST_STATE }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }
    if (response?.ok && response.data) {
      overlay.setState(response.data);
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) {
      return;
    }

    if (message.type === MESSAGE_TYPES.CAT_STATE_UPDATE) {
      overlay.setState(message.data);
      return;
    }

    if (message.type === MESSAGE_TYPES.SITE_DONE) {
      overlay.setDone(message.data);
    }
  });

  const site = detectCurrentSite();
  if (!site) {
    return;
  }

  const adapter = adapters[site] || makeGenericAdapter(site);
  chrome.storage.local.get(["siteEnabled", "debug"], (store) => {
    const enabled = store?.siteEnabled?.[site] !== false;
    debugEnabled = !!store?.debug;

    if (!enabled) {
      logDebug("site disabled", site);
      return;
    }

    startDetection(site, adapter);
  });
})();
