# AI Output Cat Monitor

[English](./README.md)

Chrome Manifest V3 扩展，用来监控多个 AI 站点是否正在输出，并在页面右下角显示一只“状态猫”。

## 支持站点
- ChatGPT: `chatgpt.com`, `chat.openai.com`
- Gemini: `gemini.google.com`
- Claude: `claude.ai`
- DeepSeek: `chat.deepseek.com`, `deepseek.com`, `www.deepseek.com`

## 核心功能（当前实现）
- 基于站点适配器的生成状态检测（`generating` / `idle`）。
- 跨标签页聚合：同一站点多开时按实例显示（如 `ChatGPT #1`、`ChatGPT #2`）。
- 所有页面注入悬浮面板（`<all_urls>`），可随时查看全局运行状态。
- UI 文案自动跟随浏览器语言（`zh*` 显示中文，其他显示英文）。
- 右下角猫咪动画：
  - 有任一实例在生成时：`running` 动画。
  - 某实例从生成切为空闲时：`notify` 动画。
- 扩展图标 badge：
  - 运行中显示数量（最多 `99+`）。
  - 某实例刚完成时，短暂显示 `!`。
- 面板支持折叠（仅猫咪图标），折叠状态持久化到本地存储。
- 不采集、不存储聊天内容。

## 状态检测策略
- 显式信号：优先识别 Stop/Send 按钮、输入区等 DOM 特征。
- 启发式兜底：
  - 最小切换间隔（防抖）避免抖动。
  - 生成信号超时后自动回落空闲。
  - 长时间无页面变更时从生成回落空闲。

关键参数（见 `src/content/main.js`）：
- `MIN_SWITCH_MS = 700`
- `IDLE_BY_INACTIVITY_MS = 2200`
- `CHECK_INTERVAL_MS = 900`

## 项目结构
- `manifest.json`：扩展清单（MV3 权限、注入、background worker）
- `src/common/protocol.js`：消息类型、站点常量、状态常量
- `src/background/worker.js`：跨标签页状态聚合、badge 更新、完成事件广播
- `src/content/main.js`：站点识别、状态检测、悬浮 UI
- `src/assets/cat.png`：猫咪图标资源

## 消息协议
- `STATUS_CHANGED`：内容脚本上报单标签页状态变化
- `REQUEST_STATE`：内容脚本请求全局快照
- `CAT_STATE_UPDATE`：后台广播聚合状态
- `SITE_DONE`：某实例完成时广播完成事件
- `REGISTER_VIEW`：预留（当前未使用）

## 本地存储键
- `siteEnabled`: `{ chatgpt, gemini, claude, deepseek }`（默认全开）
- `debug`: `boolean`（默认 `false`）
- `catCollapsed`: `boolean`（面板折叠状态）

## 安装方式（开发模式）
1. 打开 `chrome://extensions`
2. 开启 **Developer mode**
3. 点击 **Load unpacked**
4. 选择本目录：`/Users/boyuanwang/Project/gpt_cctv`

## 已知限制
- 依赖 DOM 结构和关键词匹配，站点改版后可能需要更新选择器。
- 扩展会注入到 `<all_urls>`，但只有在支持站点标签页才会执行状态检测。
- 当前不包含桌面通知和声音提醒。
