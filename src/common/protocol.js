(function initProtocol(global) {
  const MESSAGE_TYPES = {
    STATUS_CHANGED: "STATUS_CHANGED",
    CAT_STATE_UPDATE: "CAT_STATE_UPDATE",
    SITE_DONE: "SITE_DONE",
    REQUEST_STATE: "REQUEST_STATE",
    REGISTER_VIEW: "REGISTER_VIEW"
  };

  const SITES = {
    CHATGPT: "chatgpt",
    GEMINI: "gemini",
    CLAUDE: "claude",
    DEEPSEEK: "deepseek",
    KIMI: "kimi"
  };

  const SITE_LABELS = {
    [SITES.CHATGPT]: "ChatGPT",
    [SITES.GEMINI]: "Gemini",
    [SITES.CLAUDE]: "Claude",
    [SITES.DEEPSEEK]: "DeepSeek",
    [SITES.KIMI]: "Kimi"
  };

  const STATUS = {
    GENERATING: "generating",
    IDLE: "idle"
  };

  global.CAT_MONITOR_PROTOCOL = {
    MESSAGE_TYPES,
    SITES,
    SITE_LABELS,
    STATUS
  };
})(typeof self !== "undefined" ? self : window);
