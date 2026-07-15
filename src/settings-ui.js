// 設定UIエディタ (issue #15)
// connectors / personas / triggers / context(screenCapture) / voicevox / news / topics / commentSources を
// UIから追加・編集・削除できる。編集した設定はメモリ上の draft に保持し、「保存して適用」で
// onApply(config) を呼ぶ (src/app/boot.js の applyEditedConfig)。保存先はBrowser版なら
// scripts/serve.py 経由の config.local.json、Electron版なら window.dociai.config/secrets IPC
// (config.json + safeStorage) で、保存に対応しないサーバー (python -m http.server 等) では失敗し、
// モーダルは閉じずエラーを表示する。
// APIキーは localStorage/sessionStorage には書かない (issue #13)。「JSONエクスポート」は
// ファイルダウンロードによる手動バックアップ/保存失敗時のフォールバック用。
//
// 設計: 各入力に input/change リスナーを付け、draft を直接更新する。タブ切替・追加・削除の
// ときだけ再描画する (入力フォーカスは失われるが、入力値は draft に反映済みなので保持される)。

import { validateConfig } from "./config-loader.js";
import { DEFAULT_COMMON_RULES } from "./config/config-defaults.js";
import { registryOptions } from "./config/config-registry.js";
import { CONFIG_UI_METADATA } from "./config/config-ui-metadata.js";
import { SettingsController } from "./settings/settings-controller.js";
import { processConfig } from "./config/config-pipeline.js";
import { validateConfigStructure } from "./config/config-validation.js";
import { fieldMetadataForIssue } from "./settings/settings-field-registry.js";
import { navigateToIssue } from "./settings/settings-navigation.js";
import { showDiscardChangesDialog } from "./ui/dialogs/discard-changes-dialog.js";
import { serializeConfigExport } from "./config/config-export.js";
import { createTabsController } from "./settings/a11y/tabs-controller.js";
import { createLiveAnnouncer } from "./settings/a11y/live-region.js";
import { deferFocus, restoreFocus } from "./settings/a11y/focus-controller.js";
import { fieldIds } from "./settings/a11y/field-a11y.js";

const PROVIDERS = registryOptions("providers");
const TRIGGER_TYPES = registryOptions("triggerTypes");
const VOICE_ENGINES = registryOptions("voiceEngines");
const NEWS_MODES = registryOptions("newsModes");
const NEWS_SOURCE_TYPES = registryOptions("newsSourceTypes");
const TOPIC_SOURCE_TYPES = registryOptions("topicSourceTypes");

function configUiMetadata(path) {
  const segments = path.split(".");
  return Object.entries(CONFIG_UI_METADATA).find(([pattern]) => {
    const expected = pattern.split(".");
    return expected.length === segments.length && expected.every((part, index) => part === "*" || part === segments[index]);
  })?.[1] ?? {};
}

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
// 壊れた/手編集された config.local.json で配列であるべき値が文字列などになっていても
// .join() でクラッシュしないようにする (クラッシュするとタブ全体が描画されず入力欄ごと消える)。
const asArray = (v) => (Array.isArray(v) ? v : []);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class SettingsUI {
  get dirty() { return Boolean(this.controller?.state.dirty); }

  constructor({ getCurrent = () => null, onApply = () => {}, log = () => {} } = {}) {
    this.getCurrent = getCurrent;
    this.onApply = onApply;
    this.log = log;
    this.draft = null;
    this.activeTab = "connectors";
    this.root = null;
    this._opener = null;
    this._pendingFocusSelector = null;
    this._built = false;
    this.controller = new SettingsController({
      confirmDiscard: async () => showDiscardChangesDialog(document),
      save: async (draft) => { const { errors } = validateConfig(draft); if (errors.length) throw new Error(errors[0]); await this.onApply(clone(draft)); if (this.root?.open) this.root.close(); },
    });
    this._voices = [];
    this._voiceSupported = typeof window !== "undefined" && "speechSynthesis" in window;
    if (this._voiceSupported) {
      this.#refreshVoices();
      speechSynthesis.addEventListener?.("voiceschanged", () => {
        this.#refreshVoices();
        if (this.root?.open) this.#render();
      });
    }
    // Electronにはブラウザのような入力デバイス選択UIが無いため、マイク監視の対象デバイスを
    // 明示指定できるようここでenumerateDevices()する (issue #32のフォローアップ)。ラベルは
    // マイク権限が許可済みの場合のみ得られる (この操作卓はconsoleウィンドウのmedia権限を
    // electron/main/security/permissions.tsで常時許可しているため、通常は取得できる)。
    this._micDevices = [];
    this._micDeviceSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.enumerateDevices;
    if (this._micDeviceSupported) {
      this.#refreshMicDevices();
      navigator.mediaDevices.addEventListener?.("devicechange", () => this.#refreshMicDevices());
    }
  }

  open() {
    const current = this.getCurrent();
    if (!current) {
      this.log("設定を読み込んでから編集してください", "warn");
      return;
    }
    this._opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.draft = clone(current);
    this.controller.open(this.draft);
    this.activeTab = "connectors";
    this.#ensureBuilt();
    if (!this.root.open) this.root.showModal();
    this.#render();
    deferFocus(this._tabs?.find((tab) => tab.dataset.tab === this.activeTab));
    this._announcer?.announce("設定エディタを開きました");
  }

  async close(reason = "close-button") {
    const result = await this.controller.requestClose(reason);
    if (result === "closed" && this.root?.open) this.root.close();
    if (result === "continued") deferFocus(this._closeButton);
    return result;
  }

  #refreshVoices() {
    try { this._voices = speechSynthesis.getVoices() ?? []; } catch { this._voices = []; }
  }

  // webspeech の voice.name 用セレクト肢。ブラウザにインストール済みの音声一覧 + default。
  // 現在の値がこのブラウザに無い音声名でも (別環境で設定された等) 選択肢に残して消さない。
  #voiceNameOptions(current) {
    const opts = [{ value: "default", label: "default (自動選択: 日本語音声)" }];
    const sorted = [...this._voices].sort((a, b) => {
      const aJa = a.lang?.startsWith("ja") ? 0 : 1;
      const bJa = b.lang?.startsWith("ja") ? 0 : 1;
      return aJa !== bJa ? aJa - bJa : a.name.localeCompare(b.name);
    });
    for (const v of sorted) opts.push({ value: v.name, label: `${v.name} (${v.lang})` });
    if (current && current !== "default" && !this._voices.some((v) => v.name === current)) {
      opts.push({ value: current, label: `${current} (未検出)` });
    }
    return opts;
  }

  async #refreshMicDevices() {
    try {
      this._micDevices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    } catch {
      this._micDevices = [];
    }
    if (this.root?.open && this.activeTab === "micMonitor") this.#render();
  }

  // micMonitor.deviceId 用select肢。ラベルはマイク権限が許可済みでないと空文字になる
  // (ブラウザ/Electron共通の仕様) — その場合はdeviceIdの先頭を仮ラベルとして出す。
  #micDeviceOptions(current) {
    const opts = [{ value: "", label: "既定のデバイス (OS/ブラウザの既定を使用)" }];
    for (const d of this._micDevices) {
      opts.push({ value: d.deviceId, label: d.label || `マイク (${d.deviceId.slice(0, 8)}…)` });
    }
    if (current && !this._micDevices.some((d) => d.deviceId === current)) {
      opts.push({ value: current, label: `${current} (未検出)` });
    }
    return opts;
  }

  // voice.name の select フィールドに「試聴」ボタンを付け足す (select と同じ行に並べる)。
  // getContext() は試聴時点の { rate, pitch } を返す (draft の最新値を毎回読むため関数で渡す)。
  #withTestVoiceButton(fieldWrap, getContext) {
    const sel = fieldWrap.querySelector("select");
    const row = document.createElement("div");
    row.className = "field-row";
    sel.replaceWith(row);
    row.append(sel);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-test-voice";
    btn.textContent = "▶ 試聴";
    btn.title = this._voiceSupported ? "選択中の音声でテスト再生" : "このブラウザは音声合成 (Web Speech API) に対応していません";
    btn.disabled = !this._voiceSupported;
    btn.addEventListener("click", () => {
      const { rate, pitch } = getContext();
      this.#testSpeakVoice({ name: sel.value, rate, pitch });
    });
    row.append(btn);
    return fieldWrap;
  }

  #testSpeakVoice({ name, rate, pitch } = {}) {
    if (!this._voiceSupported) {
      this.log("このブラウザは音声合成 (Web Speech API) に対応していません", "warn");
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("こんにちは、これはテスト音声です。");
    const hit = name && name !== "default"
      ? this._voices.find((v) => v.name === name) ?? this._voices.find((v) => v.name.includes(name))
      : null;
    const voice = hit ?? this._voices.find((v) => v.lang?.startsWith("ja"));
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? "ja-JP";
    const rateNum = Number(rate);
    const pitchNum = Number(pitch);
    u.rate = clamp(Number.isFinite(rateNum) ? rateNum : 1, 0.5, 2);
    u.pitch = clamp(Number.isFinite(pitchNum) ? pitchNum : 1, 0, 2);
    speechSynthesis.speak(u);
  }

  #ensureBuilt() {
    if (this._built) return;
    const dlg = document.createElement("dialog");
    dlg.className = "settings-modal";
    dlg.setAttribute("aria-labelledby", "settings-dialog-title");
    dlg.setAttribute("aria-describedby", "settings-dialog-description");
    this.root = dlg;
    document.body.append(dlg);
    // 背景クリックでの close は行わない。閉じるのは ×/キャンセル/保存して適用のみ
    // (誤クリックで編集内容を失わないため)。

    const header = document.createElement("header");
    header.className = "settings-header";
    const title = document.createElement("div");
    title.className = "settings-title";
    const icon = document.createElement("span");
    icon.className = "settings-title-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚙";
    const heading = document.createElement("h2");
    heading.id = "settings-dialog-title";
    heading.textContent = "設定エディタ";
    title.append(icon, heading);
    header.append(title);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "閉じる";
    closeBtn.setAttribute("aria-label", "設定エディタを閉じる");
    closeBtn.addEventListener("click", () => this.close("close-button"));
    header.append(closeBtn);
    this._closeButton = closeBtn;

    // sidebar + main を包むシェル
    const shell = document.createElement("div");
    shell.className = "settings-shell";

    const nav = document.createElement("nav");
    nav.className = "settings-sidebar";
    nav.setAttribute("aria-label", "設定カテゴリ");
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-orientation", "vertical");
    const tabs = [
      ["connectors", "コネクタ", "AIプロバイダ"],
      ["personas", "ペルソナ", "応答キャラクター"],
      ["triggers", "トリガー", "発火条件"],
      ["context", "画面・文脈", "vision / 履歴"],
      ["voicevox", "VOICEVOX", "音声合成エンジン"],
      ["bouyomi", "棒読みちゃん", "HTTP 読み上げ連携"],
      ["micMonitor", "マイク監視", "発話で読み上げを保留"],
      ["commentReader", "コメント読み上げ", "全コメントを音声で読み上げ"],
      ["news", "ニュース", "RSS / 要約"],
      ["topics", "話題", "Todoist / 配信ネタ"],
      ["sources", "コメントソース", "Twitch 等"],
    ];
    for (const [id, label, desc] of tabs) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.tab = id;
      b.id = `settings-tab-${id}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", `settings-panel-${id}`);
      b.innerHTML = `<span class="tab-label"></span><span class="tab-desc"></span>`;
      b.querySelector(".tab-label").textContent = label;
      b.querySelector(".tab-desc").textContent = desc;
      b.addEventListener("click", () => {
        this.#activateTab(id, { announce: true });
      });
      nav.append(b);
    }

    const main = document.createElement("div");
    main.className = "settings-main";

    const body = document.createElement("div");
    body.className = "settings-body";
    body.tabIndex = 0;
    body.setAttribute("role", "tabpanel");

    const footer = document.createElement("footer");
    footer.className = "settings-footer";
    const errors = document.createElement("div");
    errors.className = "settings-errors";
    errors.id = "settings-visible-errors";
    const status = document.createElement("div");
    status.className = "settings-status";
    status.id = "settings-dialog-description";
    status.textContent = "設定を編集できます";
    const footerActions = document.createElement("div");
    footerActions.className = "settings-actions";
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn-ghost";
    exportBtn.innerHTML = `<span>&#8595;</span> JSONエクスポート`;
    exportBtn.addEventListener("click", () => this.#export());
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn-ghost";
    cancelBtn.textContent = "キャンセル";
    cancelBtn.addEventListener("click", () => this.close("cancel-button"));
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "btn-primary";
    applyBtn.innerHTML = `<span>&#10003;</span> 保存して適用`;
    applyBtn.addEventListener("click", () => this.#apply());
    this._applyBtn = applyBtn;
    footerActions.append(exportBtn, cancelBtn, applyBtn);
    footer.append(status, errors, footerActions);

    const live = document.createElement("div");
    live.className = "sr-only";
    live.id = "settings-status-live";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    const errorLive = document.createElement("div");
    errorLive.className = "sr-only";
    errorLive.id = "settings-error-live";
    errorLive.setAttribute("aria-live", "assertive");
    errorLive.setAttribute("aria-atomic", "true");

    main.append(body, footer);
    shell.append(nav, main);
    dlg.append(header, shell, live, errorLive);
    dlg.addEventListener("cancel", (event) => { event.preventDefault(); this.close("escape"); });
    dlg.addEventListener("close", () => { restoreFocus(this._opener); this._opener = null; });
    dlg.addEventListener("keydown", (event) => {
      const targetPath = event.target?.dataset?.configPath ?? "";
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !targetPath.endsWith(".keys")) {
        event.preventDefault();
        if (this.controller.state.dirty) this.#apply();
      }
    });
    dlg.addEventListener("input", () => this.controller.changed(this.draft));
    dlg.addEventListener("change", () => this.controller.changed(this.draft));
    this._body = body;
    this._errors = errors;
    this._status = status;
    this._announcer = createLiveAnnouncer(live);
    this._errorAnnouncer = createLiveAnnouncer(errorLive);
    this._tabs = [...nav.querySelectorAll('[role="tab"]')];
    this._tabsController = createTabsController({
      tabs: () => this._tabs,
      orientation: () => getComputedStyle(nav).flexDirection === "row" ? "horizontal" : "vertical",
      activate: (id, options) => this.#activateTab(id, options),
    });
    const updateTabOrientation = () => nav.setAttribute("aria-orientation", getComputedStyle(nav).flexDirection === "row" ? "horizontal" : "vertical");
    addEventListener("resize", updateTabOrientation);
    updateTabOrientation();
    for (const tab of this._tabs) tab.addEventListener("keydown", (event) => this._tabsController.onKeydown(event));
    this._built = true;
  }

  #render() {
    for (const b of this._tabs) {
      const active = b.dataset.tab === this.activeTab;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", String(active));
      b.tabIndex = active ? 0 : -1;
      const issues = this.controller.state.issues.filter((issue) => issue.tabId === b.dataset.tab);
      const errors = issues.filter((issue) => issue.severity === "error").length;
      const warnings = issues.length - errors;
      b.dataset.issueCount = issues.length ? String(issues.length) : "";
      b.setAttribute("aria-label", `${b.querySelector(".tab-label")?.textContent ?? b.dataset.tab}${errors ? `、エラー${errors}件` : ""}${warnings ? `、警告${warnings}件` : ""}`);
    }
    this._body.replaceChildren();
    this._body.id = `settings-panel-${this.activeTab}`;
    this._body.setAttribute("aria-labelledby", `settings-tab-${this.activeTab}`);
    const tab = this.activeTab;
    if (tab === "connectors") this.#renderConnectors();
    else if (tab === "personas") this.#renderPersonas();
    else if (tab === "triggers") this.#renderTriggers();
    else if (tab === "context") this.#renderContext();
    else if (tab === "voicevox") this.#renderVoicevox();
    else if (tab === "bouyomi") this.#renderBouyomi();
    else if (tab === "micMonitor") this.#renderMicMonitor();
    else if (tab === "commentReader") this.#renderCommentReader();
    else if (tab === "news") this.#renderNews();
    else if (tab === "topics") this.#renderTopics();
    else if (tab === "sources") this.#renderSources();
    this._body.scrollTop = 0;
    this.#applyIssueA11y();
    if (this._pendingFocusSelector) {
      const target = this._body.querySelector(this._pendingFocusSelector);
      this._pendingFocusSelector = null;
      deferFocus(target);
    }
  }

  #activateTab(id, { focus = false, announce = false } = {}) {
    if (!this._tabs?.some((tab) => tab.dataset.tab === id)) return;
    this.activeTab = id;
    this.#render();
    const tab = this._tabs.find((candidate) => candidate.dataset.tab === id);
    if (focus) deferFocus(tab);
    if (announce) {
      const issues = this.controller.state.issues.filter((issue) => issue.tabId === id && issue.severity === "error").length;
      this._announcer?.announce(`${tab?.querySelector(".tab-label")?.textContent ?? id} タブ${issues ? `、エラー ${issues}件` : ""}`);
    }
  }

  #applyIssueA11y() {
    for (const issue of this.controller.state.issues) {
      const field = this._body.querySelector(`[data-config-path="${CSS.escape(issue.fieldId)}"]`);
      if (!field) continue;
      const ids = fieldIds(issue.fieldId);
      field.setAttribute("aria-invalid", String(issue.severity === "error"));
      field.setAttribute("aria-describedby", ids.error);
      const message = document.createElement("span");
      message.id = ids.error;
      message.className = "sr-only";
      message.textContent = issue.message;
      field.after(message);
    }
  }

  // ---- draft への setter ヘルパ ----
  #setPath(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // ---- 共通フォーム部品 ----
  #fieldShell(label, path, { inline = false } = {}) {
    const ids = fieldIds(path);
    const wrap = document.createElement("div");
    wrap.className = `field${inline ? " field-inline" : ""}`;
    const lab = document.createElement("label");
    lab.className = "field-label";
    lab.id = ids.label;
    lab.htmlFor = ids.input;
    lab.textContent = label;
    wrap.append(lab);
    return { wrap, ids };
  }

  #attachFieldInput(shell, input, path) {
    input.id = shell.ids.input;
    input.dataset.configPath = path;
    input.setAttribute("aria-labelledby", shell.ids.label);
    shell.wrap.append(input);
    return shell.wrap;
  }

  // path 経由で draft に書き込む入力
  #pathField(label, path, { type = "text", value = "", placeholder = "", attrs = {}, csv = false, textarea = false, rows = 3 } = {}) {
    const metadata = configUiMetadata(path);
    const inputType = metadata.secret && type === "text" ? "password" : type;
    const inputAttrs = { ...attrs, ...(metadata.min != null ? { min: metadata.min } : {}), ...(metadata.max != null ? { max: metadata.max } : {}) };
    const shell = this.#fieldShell(metadata.label ?? label, path);
    let input;
    if (textarea) {
      input = document.createElement("textarea");
      input.rows = rows;
    } else {
      input = document.createElement("input");
      input.type = inputType;
    }
    input.value = value ?? "";
    if (placeholder) input.placeholder = placeholder;
    for (const [k, v] of Object.entries(inputAttrs)) input[k] = v;
    const handler = () => {
      let v = input.value;
      if (type === "number") v = v === "" ? null : Number(v);
      if (csv) v = v.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
      this.#setPath(this.draft, path, v);
    };
    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
    return this.#attachFieldInput(shell, input, path);
  }

  #pathSelect(label, options, path, { value = "" } = {}) {
    const shell = this.#fieldShell(label, path);
    const sel = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      const isObj = typeof opt === "object" && opt !== null;
      o.value = isObj ? opt.value : opt;
      o.textContent = isObj ? opt.label : opt;
      sel.append(o);
    }
    sel.value = value ?? "";
    sel.addEventListener("change", () => this.#setPath(this.draft, path, sel.value || null));
    return this.#attachFieldInput(shell, sel, path);
  }

  #pathCheckbox(label, path, { value = false } = {}) {
    const shell = this.#fieldShell(label, path, { inline: true });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.addEventListener("change", () => this.#setPath(this.draft, path, cb.checked));
    return this.#attachFieldInput(shell, cb, path);
  }

  // リスト要素のフィールド (オブジェクトマップ版)。onChange で setter 呼び出し。
  #mapField(label, mapName, key, field, { type = "text", value = "", placeholder = "", attrs = {} } = {}) {
    const metadata = field === "__id__" ? {} : configUiMetadata(`${mapName}.${key}.${field}`);
    const inputType = metadata.secret && type === "text" ? "password" : type;
    const inputAttrs = { ...attrs, ...(metadata.min != null ? { min: metadata.min } : {}), ...(metadata.max != null ? { max: metadata.max } : {}) };
    const path = `${mapName}.${key}.${field === "__id__" ? "id" : field}`;
    const shell = this.#fieldShell(metadata.label ?? label, path);
    const input = document.createElement("input");
    input.type = inputType;
    input.value = value ?? "";
    if (placeholder) input.placeholder = placeholder;
    for (const [k, v] of Object.entries(inputAttrs)) input[k] = v;
    if (field === "__id__") {
      // ID変更はキー変更(=オブジェクトの再構築+再描画)を伴うため、input(キー入力の都度)ではなく
      // change(フォーカスが外れた時)で確定する。inputで#render()すると入力中のinput要素ごと
      // 作り直されてしまい、1文字入力するたびにフォーカスが外れる不具合になる。
      input.addEventListener("change", () => this.#renameMapKey(mapName, key, input.value || key));
    } else {
      const handler = () => {
        let v = input.value;
        if (type === "number") v = v === "" ? null : Number(v);
        this.draft[mapName][key][field] = v;
      };
      input.addEventListener("input", handler);
    }
    return this.#attachFieldInput(shell, input, path);
  }

  #mapSelect(label, options, mapName, key, field, { value = "" } = {}) {
    const metadata = configUiMetadata(`${mapName}.${key}.${field}`);
    const path = `${mapName}.${key}.${field}`;
    const shell = this.#fieldShell(metadata.label ?? label, path);
    const sel = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      const isObj = typeof opt === "object" && opt !== null;
      o.value = isObj ? opt.value : opt;
      o.textContent = isObj ? opt.label : opt;
      sel.append(o);
    }
    sel.value = value ?? "";
    sel.addEventListener("change", () => {
      this.draft[mapName][key][field] = sel.value;
      if (field === "type") this.#render(); // type 別フィールド再描画
    });
    return this.#attachFieldInput(shell, sel, path);
  }

  #mapCheckbox(label, mapName, key, field, { value = false } = {}) {
    const metadata = configUiMetadata(`${mapName}.${key}.${field}`);
    const path = `${mapName}.${key}.${field}`;
    const shell = this.#fieldShell(metadata.label ?? label, path, { inline: true });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.addEventListener("change", () => { this.draft[mapName][key][field] = cb.checked; });
    return this.#attachFieldInput(shell, cb, path);
  }

  #renameMapKey(mapName, oldKey, newKey) {
    if (oldKey === newKey) return;
    const map = this.draft[mapName];
    if (map[newKey]) {
      this.log(`ID "${newKey}" は既に存在します`, "warn");
      return;
    }
    const order = Object.keys(map);
    const rebuilt = {};
    for (const k of order) {
      if (k === oldKey) rebuilt[newKey] = map[k];
      else rebuilt[k] = map[k];
    }
    this.draft[mapName] = rebuilt;
    // personas/triggers の参照も更新
    if (mapName === "connectors") {
      for (const p of this.draft.personas ?? []) {
        if (p.connector === oldKey) p.connector = newKey;
      }
      if (this.draft.context?.screenCapture?.connector === oldKey) {
        this.draft.context.screenCapture.connector = newKey;
      }
    }
    if (mapName === "triggers") {
      for (const p of this.draft.personas ?? []) {
        p.triggers = (p.triggers ?? []).map((t) => (t === oldKey ? newKey : t));
      }
      if (this.draft.news?.trigger === oldKey) this.draft.news.trigger = newKey;
      if (this.draft.topics?.trigger === oldKey) this.draft.topics.trigger = newKey;
    }
    this.#render();
  }

  // 配列要素のフィールド (personas, news.sources, topics.sources)
  #arrField(label, arrPath, index, field, { type = "text", value = "", placeholder = "", attrs = {}, textarea = false, rows = 3 } = {}) {
    const metadata = configUiMetadata(`${arrPath}.${index}.${field}`);
    const inputType = metadata.secret && type === "text" ? "password" : type;
    const inputAttrs = { ...attrs, ...(metadata.min != null ? { min: metadata.min } : {}), ...(metadata.max != null ? { max: metadata.max } : {}) };
    const path = `${arrPath}.${index}.${field}`;
    const shell = this.#fieldShell(metadata.label ?? label, path);
    let input;
    if (textarea) {
      input = document.createElement("textarea");
      input.rows = rows;
    } else {
      input = document.createElement("input");
      input.type = inputType;
    }
    input.value = value ?? "";
    if (placeholder) input.placeholder = placeholder;
    for (const [k, v] of Object.entries(inputAttrs)) input[k] = v;
    input.addEventListener("input", () => {
      const arr = this.#getArr(arrPath);
      let v = input.value;
      if (type === "number") v = v === "" ? null : Number(v);
      this.#setPath(arr[index], field, v);
    });
    return this.#attachFieldInput(shell, input, path);
  }

  #arrSelect(label, options, arrPath, index, field, { value = "" } = {}) {
    const metadata = configUiMetadata(`${arrPath}.${index}.${field}`);
    const path = `${arrPath}.${index}.${field}`;
    const shell = this.#fieldShell(metadata.label ?? label, path);
    const sel = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      const isObj = typeof opt === "object" && opt !== null;
      o.value = isObj ? opt.value : opt;
      o.textContent = isObj ? opt.label : opt;
      sel.append(o);
    }
    sel.value = value ?? "";
    sel.addEventListener("change", () => {
      const arr = this.#getArr(arrPath);
      this.#setPath(arr[index], field, sel.value);
      this.#render();
    });
    return this.#attachFieldInput(shell, sel, path);
  }

  #arrCheckbox(label, arrPath, index, field, { value = false } = {}) {
    const path = `${arrPath}.${index}.${field}`;
    const shell = this.#fieldShell(label, path, { inline: true });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.addEventListener("change", () => {
      const arr = this.#getArr(arrPath);
      this.#setPath(arr[index], field, cb.checked);
    });
    return this.#attachFieldInput(shell, cb, path);
  }

  #getArr(path) {
    const parts = path.split(".");
    let cur = this.draft;
    for (const p of parts) {
      if (cur[p] == null) cur[p] = Array.isArray(cur) ? [] : {};
      cur = cur[p];
    }
    if (!Array.isArray(cur)) {
      this.#setPath(this.draft, path, []);
      cur = this.#getArr(path);
    }
    return cur;
  }

  #listHeader(title, onAdd) {
    const h = document.createElement("div");
    h.className = "list-header";
    const t = document.createElement("h3");
    t.textContent = title;
    h.append(t);
    if (onAdd) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-add";
      b.innerHTML = `<span>+</span> 追加`;
      b.setAttribute("aria-label", `${title}を追加`);
      b.addEventListener("click", onAdd);
      h.append(b);
    }
    return h;
  }

  // カードを作成し、head 部と body 部を分離して返す。body に要素を append する。
  #card(headContent) {
    const card = document.createElement("div");
    card.className = "card";
    const head = document.createElement("div");
    head.className = "card-head";
    if (headContent) head.append(...headContent);
    const body = document.createElement("div");
    body.className = "card-body";
    card.append(head, body);
    return { card, head, body };
  }

  #removeBtn(onRemove, label = "削除") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-remove";
    b.innerHTML = `<span>&times;</span>`;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", onRemove);
    return b;
  }

  // ---- connectors ----
  #renderConnectors() {
    const body = this._body;
    body.append(this.#listHeader("コネクタ", () => {
      let i = 1;
      while (this.draft.connectors[`new_connector_${i}`]) i++;
      this.draft.connectors[`new_connector_${i}`] = { provider: "mock" };
      this._pendingFocusSelector = `[data-config-path="connectors.new_connector_${i}.id"]`;
      this.#render();
      this._announcer?.announce(`コネクタ new_connector_${i} を追加しました`);
    }));
    const entries = Object.entries(this.draft.connectors ?? {});
    if (!entries.length) {
      const m = document.createElement("p");
      m.className = "muted";
      m.textContent = "コネクタがありません。「+ 追加」で作成してください";
      body.append(m);
      return;
    }
    for (const [id, c] of entries) {
      const { card, body: cardBody } = this.#card(null);
      card.classList.add("compact");
      const row1 = document.createElement("div");
      row1.className = "compact-row";
      row1.append(
        this.#mapField("ID", "connectors", id, "__id__", { value: id, attrs: { spellcheck: "false" } }),
        this.#mapSelect("provider", PROVIDERS, "connectors", id, "provider", { value: c.provider }),
        this.#mapField("model", "connectors", id, "model", { value: c.model ?? "", attrs: { spellcheck: "false" } }),
        this.#removeBtn(() => {
          delete this.draft.connectors[id];
          for (const p of this.draft.personas ?? []) {
            if (p.connector === id) p.connector = "";
          }
          if (this.draft.context?.screenCapture?.connector === id) this.draft.context.screenCapture.connector = "";
          this._pendingFocusSelector = ".list-header .btn-add";
          this.#render();
          this._announcer?.announce(`コネクタ ${id} を削除しました`);
        }, `コネクタ「${id}」を削除`),
      );
      const row2 = document.createElement("div");
      row2.className = "compact-row";
      row2.append(
        this.#mapField("apiKey", "connectors", id, "apiKey", { value: c.apiKey ?? "", placeholder: c.apiKeyConfigured && !c.apiKey ? "設定済み（変更する場合のみ入力）" : "", attrs: { spellcheck: "false", autocomplete: "off" } }),
        this.#mapField("baseUrl", "connectors", id, "baseUrl", { value: c.baseUrl ?? "", attrs: { spellcheck: "false" } }),
        this.#mapField("timeoutMs (ms)", "connectors", id, "timeoutMs", { type: "number", value: c.timeoutMs ?? "" }),
        this.#mapField("maxTokens", "connectors", id, "maxTokens", { type: "number", value: c.maxTokens ?? "", attrs: { step: 1 } }),
      );
      cardBody.append(row1, row2);
      this._body.append(card);
    }
  }

  // ---- personas ----
  #renderPersonas() {
    const body = this._body;
    body.append(this.#listHeader("ペルソナ", () => {
      let i = 1;
      while (this.draft.personas.some((p) => p.id === `new_persona_${i}`)) i++;
      this.draft.personas.push({
        id: `new_persona_${i}`,
        name: `新規ペルソナ${i}`,
        connector: Object.keys(this.draft.connectors ?? {})[0] ?? "",
        enabled: true,
        systemPrompt: "",
        triggers: [],
        voice: { enabled: true, engine: "webspeech", name: "default", rate: 1.0, pitch: 1.0 },
      });
      this._pendingFocusSelector = `[data-config-path="personas.${this.draft.personas.length - 1}.id"]`;
      this.#render();
      this._announcer?.announce(`ペルソナ new_persona_${i} を追加しました`);
    }));
    const connectorIds = Object.keys(this.draft.connectors ?? {});
    const triggerIds = Object.keys(this.draft.triggers ?? {});
    for (const [i, p] of (this.draft.personas ?? []).entries()) {
      const headEls = [
        this.#arrField("ID", "personas", i, "id", { value: p.id, attrs: { spellcheck: "false" } }),
        this.#arrField("表示名", "personas", i, "name", { value: p.name }),
        this.#arrCheckbox("有効", "personas", i, "enabled", { value: p.enabled }),
        this.#removeBtn(() => {
          this.draft.personas.splice(i, 1);
          this._pendingFocusSelector = ".list-header .btn-add";
          this.#render();
          this._announcer?.announce(`ペルソナ ${p.name || p.id} を削除しました`);
        }, `ペルソナ「${p.name || p.id}」を削除`),
      ];
      const { card, body: cardBody } = this.#card(headEls);
      const grid = document.createElement("div");
      grid.className = "card-grid";
      grid.append(this.#arrSelect("connector", connectorIds, "personas", i, "connector", { value: p.connector }));
      cardBody.append(grid);
      cardBody.append(this.#arrField("systemPrompt", "personas", i, "systemPrompt", { value: p.systemPrompt ?? "", textarea: true, rows: 3 }));
      // triggers: チェックボックス群
      const trigWrap = document.createElement("div");
      trigWrap.className = "field";
      const tlab = document.createElement("span");
      tlab.className = "field-label";
      tlab.textContent = "triggers";
      trigWrap.append(tlab);
      const trigBox = document.createElement("div");
      trigBox.className = "checkbox-group";
      for (const tid of triggerIds) {
        const lab = document.createElement("label");
        lab.className = "chip-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = (p.triggers ?? []).includes(tid);
        cb.addEventListener("change", () => {
          const set = new Set(this.draft.personas[i].triggers ?? []);
          if (cb.checked) set.add(tid); else set.delete(tid);
          this.draft.personas[i].triggers = [...set];
        });
        lab.append(cb, document.createTextNode(tid));
        trigBox.append(lab);
      }
      if (!triggerIds.length) {
        const m = document.createElement("span");
        m.className = "muted";
        m.textContent = "(トリガーがありません)";
        trigBox.append(m);
      }
      trigWrap.append(trigBox);
      cardBody.append(trigWrap);
      // voice
      const v = p.voice ?? {};
      const voiceHead = document.createElement("div");
      voiceHead.className = "sub-section";
      voiceHead.innerHTML = `<span class="sub-section-label">voice</span>`;
      cardBody.append(voiceHead);
      const voiceGrid = document.createElement("div");
      voiceGrid.className = "card-grid";
      voiceGrid.append(this.#arrCheckbox("voice.enabled", "personas", i, "voice.enabled", { value: v.enabled }));
      voiceGrid.append(this.#arrSelect("voice.engine", VOICE_ENGINES, "personas", i, "voice.engine", { value: v.engine ?? "webspeech" }));
      voiceGrid.append(this.#withTestVoiceButton(
        this.#arrSelect("voice.name (webspeech)", this.#voiceNameOptions(v.name), "personas", i, "voice.name", { value: v.name ?? "default" }),
        () => {
          const voice = this.#getArr("personas")[i]?.voice ?? {};
          return { rate: voice.rate ?? voice.speed, pitch: voice.pitch };
        },
      ));
      voiceGrid.append(this.#arrField("voice.speaker (voicevox)", "personas", i, "voice.speaker", { type: "number", value: v.speaker ?? "" }));
      // webspeech は voice.rate、voicevox は voice.speed を見る (src/speech-queue.js)。
      // 1つの入力欄で両方に同じ値を書き込み、エンジンを切り替えても効くようにする。
      const rateField = this.#arrField("voice.rate / speed", "personas", i, "voice.rate", { type: "number", value: v.rate ?? v.speed ?? "" });
      rateField.querySelector("input").addEventListener("input", (e) => {
        const val = e.target.value === "" ? null : Number(e.target.value);
        this.#getArr("personas")[i].voice.speed = val;
      });
      voiceGrid.append(rateField);
      voiceGrid.append(this.#arrField("voice.pitch", "personas", i, "voice.pitch", { type: "number", value: v.pitch ?? "" }));
      voiceGrid.append(this.#arrField("voice.intonation", "personas", i, "voice.intonation", { type: "number", value: v.intonation ?? "" }));
      voiceGrid.append(this.#arrField("voice.volume", "personas", i, "voice.volume", { type: "number", value: v.volume ?? "" }));
      cardBody.append(voiceGrid);
      this._body.append(card);
    }
  }

  // ---- triggers ----
  #renderTriggers() {
    const body = this._body;
    body.append(this.#listHeader("トリガー", () => {
      let i = 1;
      while (this.draft.triggers[`new_trigger_${i}`]) i++;
      this.draft.triggers[`new_trigger_${i}`] = { type: "manual" };
      this._pendingFocusSelector = `[data-config-path="triggers.new_trigger_${i}.id"]`;
      this.#render();
      this._announcer?.announce(`トリガー new_trigger_${i} を追加しました`);
    }));
    for (const [id, t] of Object.entries(this.draft.triggers ?? {})) {
      const { card, body: cardBody } = this.#card(null);
      card.classList.add("compact");
      const row1 = document.createElement("div");
      row1.className = "compact-row";
      row1.append(
        this.#mapField("ID", "triggers", id, "__id__", { value: id, attrs: { spellcheck: "false" } }),
        this.#mapSelect("type", TRIGGER_TYPES, "triggers", id, "type", { value: t.type }),
        this.#removeBtn(() => {
          delete this.draft.triggers[id];
          for (const p of this.draft.personas ?? []) {
            p.triggers = (p.triggers ?? []).filter((x) => x !== id);
          }
          if (this.draft.news?.trigger === id) this.draft.news.trigger = "";
          this._pendingFocusSelector = ".list-header .btn-add";
          this.#render();
          this._announcer?.announce(`トリガー ${id} を削除しました`);
        }, `トリガー「${id}」を削除`),
      );
      cardBody.append(row1);

      const row2 = document.createElement("div");
      row2.className = "compact-row";
      if (t.type === "keyword") {
        const kwField = this.#mapField("keywords (カンマ区切り)", "triggers", id, "keywords", { value: asArray(t.keywords).join(", ") });
        const inp = kwField.querySelector("input");
        inp.addEventListener("input", () => {
          this.draft.triggers[id].keywords = inp.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
        });
        row2.append(kwField);
      } else if (t.type === "hotkey") {
        row2.append(this.#mapField("keys (例: Alt+1)", "triggers", id, "keys", { value: t.keys ?? "", attrs: { spellcheck: "false" } }), this.#mapCheckbox("グローバル (Electron)", "triggers", id, "global", { value: t.global }));
      } else if (t.type === "interval") {
        const g = document.createElement("div");
        g.className = "card-grid";
        g.append(this.#mapField("minutes", "triggers", id, "minutes", { type: "number", value: t.minutes ?? "" }));
        g.append(this.#mapField("seconds", "triggers", id, "seconds", { type: "number", value: t.seconds ?? "" }));
        row2.append(g);
      } else if (t.type === "random") {
        row2.append(this.#mapField("probability (0-1)", "triggers", id, "probability", { type: "number", value: t.probability ?? "" }));
      }
      if (!row2.children.length) row2.style.display = "none";
      cardBody.append(row2);
      this._body.append(card);
    }
  }

  // ---- context / screenCapture / router ----
  #renderContext() {
    const connectorIds = Object.keys(this.draft.connectors ?? {});
    const sc = this.draft.context?.screenCapture ?? {};
    const ctx = this.draft.context ?? {};

    // screenCapture
    const scTitle = document.createElement("div");
    scTitle.className = "card-title";
    scTitle.textContent = "画面キャプチャ (vision_model)";
    const { card: scCard, body: scBody } = this.#card([scTitle]);
    scBody.append(this.#pathCheckbox("screenCapture.enabled", "context.screenCapture.enabled", { value: sc.enabled }));
    scBody.append(this.#pathSelect("screenCapture.connector", ["", ...connectorIds], "context.screenCapture.connector", { value: sc.connector ?? "" }));
    const scGrid = document.createElement("div");
    scGrid.className = "card-grid";
    scGrid.append(this.#pathField("sourceName (画面/ウィンドウ名)", "context.screenCapture.sourceName", { value: sc.sourceName ?? "", attrs: { spellcheck: "false" } }));
    scGrid.append(this.#pathField("maxAgeSeconds", "context.screenCapture.maxAgeSeconds", { type: "number", value: sc.maxAgeSeconds ?? 120 }));
    scGrid.append(this.#pathField("maxTokens", "context.screenCapture.maxTokens", { type: "number", value: sc.maxTokens ?? 768 }));
    scGrid.append(this.#pathField("commentHistoryLimit", "context.commentHistoryLimit", { type: "number", value: ctx.commentHistoryLimit ?? 80 }));
    scGrid.append(this.#pathField("includeRecentComments", "context.includeRecentComments", { type: "number", value: ctx.includeRecentComments ?? 20 }));
    scGrid.append(this.#pathField("maxPromptChars", "context.maxPromptChars", { type: "number", value: ctx.maxPromptChars ?? 4000 }));
    scBody.append(scGrid);
    this._body.append(scCard);

    // commonRules — 全ペルソナのsystemPromptの後ろに共通で付加される指示文 (issue: ハードコード
    // されていたものをconfig化)。空にすると何も付加されない (persona.systemPromptのみになる)。
    const crTitle = document.createElement("div");
    crTitle.className = "card-title";
    crTitle.textContent = "共通ルール (全ペルソナのプロンプトに自動で付加)";
    const { card: crCard, body: crBody } = this.#card([crTitle]);
    crBody.append(this.#pathField("commonRules", "context.commonRules", { value: ctx.commonRules ?? DEFAULT_COMMON_RULES, textarea: true, rows: 5 }));
    this._body.append(crCard);

    // router
    const rTitle = document.createElement("div");
    rTitle.className = "card-title";
    rTitle.textContent = "router";
    const { card: rCard, body: rBody } = this.#card([rTitle]);
    const rg = document.createElement("div");
    rg.className = "card-grid";
    rg.append(this.#pathSelect("defaultPersona", (this.draft.personas ?? []).map((p) => p.id), "router.defaultPersona", { value: this.draft.router?.defaultPersona ?? "" }));
    rg.append(this.#pathField("maxRepliesPerComment", "router.maxRepliesPerComment", { type: "number", value: this.draft.router?.maxRepliesPerComment ?? 1 }));
    rg.append(this.#pathField("cooldownSeconds", "router.cooldownSeconds", { type: "number", value: this.draft.router?.cooldownSeconds ?? 8 }));
    rBody.append(rg);
    this._body.append(rCard);
  }

  // ---- voicevox ----
  #renderVoicevox() {
    const v = this.draft.voicevox ?? {};
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "VOICEVOX エンジン";
    const { card, body: cardBody } = this.#card([title]);
    cardBody.append(this.#pathCheckbox("voicevox.enabled", "voicevox.enabled", { value: v.enabled }));
    const g = document.createElement("div");
    g.className = "card-grid";
    g.append(this.#pathField("baseUrl", "voicevox.baseUrl", { value: v.baseUrl ?? "http://127.0.0.1:50021", attrs: { spellcheck: "false" } }));
    g.append(this.#pathField("defaultSpeaker", "voicevox.defaultSpeaker", { type: "number", value: v.defaultSpeaker ?? 3 }));
    g.append(this.#pathField("maxChars", "voicevox.maxChars", { type: "number", value: v.maxChars ?? 200 }));
    g.append(this.#pathField("timeoutMs (ms)", "voicevox.timeoutMs", { type: "number", value: v.timeoutMs ?? 30000 }));
    cardBody.append(g);
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "話者IDは engine の /speakers の style id (例: 3 = ずんだもん ノーマル)。CORS は engine が localhost 系 Origin を許可する既定で通ります。";
    this._body.append(note);
  }

  // ---- bouyomi (issue #30) ----
  #renderBouyomi() {
    const b = this.draft.bouyomi ?? {};
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "棒読みちゃん HTTP 連携";
    const { card, body: cardBody } = this.#card([title]);
    cardBody.append(this.#pathCheckbox("bouyomi.enabled", "bouyomi.enabled", { value: b.enabled }));
    const g = document.createElement("div");
    g.className = "card-grid";
    g.append(this.#pathField("baseUrl", "bouyomi.baseUrl", { value: b.baseUrl ?? "http://127.0.0.1:50080", attrs: { spellcheck: "false" } }));
    g.append(this.#pathField("timeoutMs (ms)", "bouyomi.timeoutMs", { type: "number", value: b.timeoutMs ?? 5000 }));
    g.append(this.#pathField("voice", "bouyomi.voice", { type: "number", value: b.voice ?? 0 }));
    g.append(this.#pathField("volume", "bouyomi.volume", { type: "number", value: b.volume ?? -1 }));
    g.append(this.#pathField("speed", "bouyomi.speed", { type: "number", value: b.speed ?? -1 }));
    g.append(this.#pathField("tone", "bouyomi.tone", { type: "number", value: b.tone ?? -1 }));
    g.append(this.#pathField("charsPerSecond (待機時間の見積り基準)", "bouyomi.charsPerSecond", { type: "number", value: b.charsPerSecond ?? 6, attrs: { step: "0.5", min: "0.5" } }));
    cardBody.append(g);
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "棒読みちゃんの「HTTP連携」を有効にし、通常は 127.0.0.1:50080 を使います。コメント読み上げまたはペルソナ音声の engine に bouyomi を選択してください。charsPerSecond は「他backendとの音声かぶり防止」のための発話時間見積り (speed=100相当で1秒に読む文字数、既定6) で、実際の再生速度には影響しません。読み上げが速い/遅い声を使っていて待機が長すぎる・短すぎる場合はここを調整してください。";
    this._body.append(note);
  }

  // ---- micMonitor (issue #32) ----
  #renderMicMonitor() {
    const m = this.draft.micMonitor ?? {};
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "マイク監視 (発話ゲーティング)";
    const { card, body: cardBody } = this.#card([title]);
    const enabledField = this.#pathCheckbox("micMonitor.enabled", "micMonitor.enabled", { value: m.enabled });
    enabledField.querySelector("input").addEventListener("change", () => this.#render());
    cardBody.append(enabledField);
    if (m.enabled) {
      const g = document.createElement("div");
      g.className = "card-grid";
      g.append(this.#pathField("threshold (0-1)", "micMonitor.threshold", { type: "number", value: m.threshold ?? 0.05, attrs: { step: "0.01", min: "0", max: "1" } }));
      g.append(this.#pathField("minSpeechMs", "micMonitor.minSpeechMs", { type: "number", value: m.minSpeechMs ?? 150 }));
      g.append(this.#pathField("silenceHoldMs", "micMonitor.silenceHoldMs", { type: "number", value: m.silenceHoldMs ?? 800 }));
      g.append(this.#pathSelect("device (入力デバイス)", this.#micDeviceOptions(m.deviceId), "micMonitor.deviceId", { value: m.deviceId ?? "" }));
      cardBody.append(g);
    }
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "配信者の発話を検知するとAI音声キューを保留し、無音に戻ると再開します (中断された発話は最初から読み上げ直されます)。スピーカー環境ではAI自身の声を誤検知することがあるため、ヘッドホンや仮想オーディオデバイスでの分離を推奨します (docs/obs-mode.md 参照)。deviceが「既定のデバイス」以外に一覧されない場合は、一度「監視開始」でマイク権限を許可してから設定を開き直してください。";
    this._body.append(note);
  }

  // ---- commentReader (issue #31) ----
  #renderCommentReader() {
    const cr = this.draft.commentReader ?? {};
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "コメント読み上げ";
    const { card, body: cardBody } = this.#card([title]);
    const enabledField = this.#pathCheckbox("commentReader.enabled", "commentReader.enabled", { value: cr.enabled });
    enabledField.querySelector("input").addEventListener("change", () => this.#render());
    cardBody.append(enabledField);
    if (cr.enabled) {
      const g = document.createElement("div");
      g.className = "card-grid";
      g.append(this.#pathSelect("engine", VOICE_ENGINES, "commentReader.engine", { value: cr.engine ?? "webspeech" }));
      g.append(this.#withTestVoiceButton(
        this.#pathSelect("name (webspeech音声名)", this.#voiceNameOptions(cr.name), "commentReader.name", { value: cr.name ?? "default" }),
        () => ({ rate: this.draft.commentReader?.rate, pitch: this.draft.commentReader?.pitch }),
      ));
      g.append(this.#pathField("rate (webspeech/voicevox速度)", "commentReader.rate", { type: "number", value: cr.rate ?? 1.0, attrs: { step: "0.1" } }));
      g.append(this.#pathField("pitch", "commentReader.pitch", { type: "number", value: cr.pitch ?? 1.0, attrs: { step: "0.1" } }));
      g.append(this.#pathField("speaker (voicevox話者ID)", "commentReader.speaker", { type: "number", value: cr.speaker ?? "" }));
      g.append(this.#pathField("voice (棒読みちゃん話者)", "commentReader.voice", { type: "number", value: cr.voice ?? this.draft.bouyomi?.voice ?? 0 }));
      g.append(this.#pathField("speed (棒読みちゃん速度)", "commentReader.speed", { type: "number", value: cr.speed ?? -1 }));
      cardBody.append(g);
      cardBody.append(this.#pathCheckbox("ユーザー名を読み上げる", "commentReader.includeAuthor", { value: cr.includeAuthor !== false }));
      cardBody.append(this.#pathCheckbox("エモートを読み上げない", "commentReader.skipEmotes", { value: !!cr.skipEmotes }));
      cardBody.append(this.#pathField("読み上げを無視するユーザー (カンマ区切り)", "commentReader.ignoreUsers", { value: asArray(cr.ignoreUsers).join(", "), csv: true, attrs: { spellcheck: "false" } }));
    }
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "Twitch等に投稿された全コメントを、トリガー条件やAI応答の有無に関わらずそのまま読み上げます。同じ読み上げキューを使うため、AIペルソナが応答する場合は「コメント読み上げ → AI応答」の順に再生されます。エモート除去はTwitchの emotes タグ (正確な文字範囲) を使うため、Twitch経由のコメントのみ対象です。rate は webspeech/voicevox 用の速度 (0.5〜2程度)、speed は棒読みちゃん用の速度 (50〜200、既定 -1 は棒読みちゃん本体の設定に従う) で、スケールが異なるため別々に設定します。engine が bouyomi のときに待機時間が長すぎる/短すぎる場合は speed、または bouyomi タブの charsPerSecond を調整してください。";
    this._body.append(note);
  }

  // ---- news ----
  #renderNews() {
    const n = this.draft.news ?? { enabled: false, sources: [], mode: "topic" };
    if (!this.draft.news) this.draft.news = n;
    const triggerIds = Object.keys(this.draft.triggers ?? {});
    const personaIds = (this.draft.personas ?? []).map((p) => p.id);

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "ニュース";
    const { card, body: cardBody } = this.#card([title]);
    const g = document.createElement("div");
    g.className = "card-grid";
    g.append(this.#pathCheckbox("news.enabled", "news.enabled", { value: n.enabled }));
    g.append(this.#pathSelect("trigger", ["", ...triggerIds], "news.trigger", { value: n.trigger ?? "" }));
    g.append(this.#pathSelect("persona", ["", ...personaIds], "news.persona", { value: n.persona ?? "" }));
    g.append(this.#pathSelect("mode", NEWS_MODES, "news.mode", { value: n.mode ?? "topic" }));
    g.append(this.#pathField("maxItems", "news.maxItems", { type: "number", value: n.maxItems ?? 3 }));
    g.append(this.#pathCheckbox("dedupe", "news.dedupe", { value: n.dedupe ?? true }));
    cardBody.append(g);
    cardBody.append(this.#pathField("corsProxy", "news.corsProxy", { value: n.corsProxy ?? "", attrs: { spellcheck: "false" } }));
    cardBody.append(this.#pathField("style", "news.style", { value: n.style ?? "", textarea: true, rows: 2 }));
    this._body.append(card);

    this._body.append(this.#listHeader("ニュースソース", () => {
      this.draft.news.sources.push({ name: "新規ソース", type: "rss", url: "", enabled: true });
      this._pendingFocusSelector = `[data-config-path="news.sources.${this.draft.news.sources.length - 1}.name"]`;
      this.#render();
      this._announcer?.announce("ニュースソースを追加しました");
    }));
    for (const [i, s] of (n.sources ?? []).entries()) {
      const headEls = [
        this.#arrField("name", "news.sources", i, "name", { value: s.name ?? "" }),
        this.#arrCheckbox("enabled", "news.sources", i, "enabled", { value: s.enabled ?? true }),
        this.#removeBtn(() => {
          this.draft.news.sources.splice(i, 1);
          this._pendingFocusSelector = ".list-header .btn-add";
          this.#render();
          this._announcer?.announce(`ニュースソース ${s.name || i + 1} を削除しました`);
        }, `ニュースソース「${s.name || i + 1}」を削除`),
      ];
      const { card: c, body: cBody } = this.#card(headEls);
      const g2 = document.createElement("div");
      g2.className = "card-grid";
      g2.append(this.#arrSelect("type", NEWS_SOURCE_TYPES, "news.sources", i, "type", { value: s.type ?? "rss" }));
      g2.append(this.#arrField("url", "news.sources", i, "url", { value: s.url ?? "", attrs: { spellcheck: "false" } }));
      cBody.append(g2);
      this._body.append(c);
    }
  }

  // ---- topics ----
  #renderTopics() {
    const t = this.draft.topics ?? { enabled: false, sources: [] };
    if (!this.draft.topics) this.draft.topics = t;
    if (!Array.isArray(t.sources)) t.sources = [];
    const triggerIds = Object.keys(this.draft.triggers ?? {});
    const personaIds = (this.draft.personas ?? []).map((p) => p.id);

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "話題";
    const { card, body: cardBody } = this.#card([title]);
    const g = document.createElement("div");
    g.className = "card-grid";
    g.append(this.#pathCheckbox("topics.enabled", "topics.enabled", { value: t.enabled }));
    g.append(this.#pathSelect("trigger", ["", ...triggerIds], "topics.trigger", { value: t.trigger ?? "" }));
    g.append(this.#pathSelect("persona", ["", ...personaIds], "topics.persona", { value: t.persona ?? "" }));
    g.append(this.#pathField("maxItems", "topics.maxItems", { type: "number", value: t.maxItems ?? 3 }));
    g.append(this.#pathCheckbox("dedupe", "topics.dedupe", { value: t.dedupe ?? true }));
    cardBody.append(g);
    cardBody.append(this.#pathField("intro", "topics.intro", { value: t.intro ?? "", textarea: true, rows: 2 }));
    cardBody.append(this.#pathField("style", "topics.style", { value: t.style ?? "", textarea: true, rows: 2 }));
    this._body.append(card);

    this._body.append(this.#listHeader("話題ソース", () => {
      this.draft.topics.sources.push({ name: "配信ネタ (Todoist)", type: "todoist", enabled: true, token: "", projectId: "" });
      this._pendingFocusSelector = `[data-config-path="topics.sources.${this.draft.topics.sources.length - 1}.name"]`;
      this.#render();
      this._announcer?.announce("話題ソースを追加しました");
    }));
    for (const [i, s] of t.sources.entries()) {
      const headEls = [
        this.#arrField("name", "topics.sources", i, "name", { value: s.name ?? "" }),
        this.#arrCheckbox("enabled", "topics.sources", i, "enabled", { value: s.enabled ?? true }),
        this.#removeBtn(() => {
          this.draft.topics.sources.splice(i, 1);
          this._pendingFocusSelector = ".list-header .btn-add";
          this.#render();
          this._announcer?.announce(`話題ソース ${s.name || i + 1} を削除しました`);
        }, `話題ソース「${s.name || i + 1}」を削除`),
      ];
      const { card: c, body: cBody } = this.#card(headEls);
      const g2 = document.createElement("div");
      g2.className = "card-grid";
      g2.append(this.#arrSelect("type", TOPIC_SOURCE_TYPES, "topics.sources", i, "type", { value: s.type ?? "todoist" }));
      g2.append(this.#arrField("token (Todoist個人アクセストークン)", "topics.sources", i, "token", { value: s.token ?? "", placeholder: s.tokenConfigured && !s.token ? "設定済み（変更する場合のみ入力）" : "", attrs: { spellcheck: "false", autocomplete: "off" } }));
      g2.append(this.#arrField("projectId", "topics.sources", i, "projectId", { value: s.projectId ?? "", attrs: { spellcheck: "false" } }));
      cBody.append(g2);
      this._body.append(c);
    }
  }

  // ---- comment sources ----
  #renderSources() {
    const t = this.draft.commentSources?.twitch ?? { enabled: false, channels: [] };
    if (!this.draft.commentSources) this.draft.commentSources = { twitch: t };
    if (!this.draft.commentSources.twitch) this.draft.commentSources.twitch = t;

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "Twitch";
    const { card, body: cardBody } = this.#card([title]);
    cardBody.append(this.#pathCheckbox("twitch.enabled", "commentSources.twitch.enabled", { value: t.enabled }));
    cardBody.append(this.#pathField("channels (カンマ区切り)", "commentSources.twitch.channels", { value: asArray(t.channels).join(", "), csv: true, attrs: { spellcheck: "false" } }));
    cardBody.append(this.#pathField("nick (省略可)", "commentSources.twitch.nick", { value: t.nick ?? "", attrs: { spellcheck: "false" } }));
    cardBody.append(this.#pathField("url (省略可)", "commentSources.twitch.url", { value: t.url ?? "", attrs: { spellcheck: "false" } }));
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "手動入力は常に有効です。Twitch は読み取り専用なら OAuth 不要です。";
    this._body.append(note);
  }

  // ---- 適用 / エクスポート ----
  async #apply() {
    const processed = processConfig(this.draft);
    const structured = processed.ok ? validateConfigStructure(processed.config) : processed;
    const { errors, warnings } = validateConfig(processed.ok ? processed.config : this.draft);
    this._errors.replaceChildren();
    const structuredIssues = structured.issues?.map(fieldMetadataForIssue) ?? [];
    this.controller.state.issues = structuredIssues;
    for (const issue of structuredIssues) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `settings-error is-${issue.severity}`;
      button.textContent = `${issue.fieldId}: ${issue.message}`;
      button.addEventListener("click", () => {
        const found = navigateToIssue(this.root, issue, (tab) => { this.activeTab = tab; this.#render(); });
        if (!found) this.log(`該当入力を表示できません: ${issue.fieldId}`, "warn");
      });
      this._errors.append(button);
    }
    if (errors.length || structuredIssues.some((issue) => issue.severity === "error")) {
      for (const e of errors) {
        const div = document.createElement("div");
        div.className = "settings-error";
        div.textContent = e;
        this._errors.append(div);
      }
      this.log(`設定エディタ: ${errors.length + structuredIssues.filter((issue) => issue.severity === "error").length}件のエラーで適用を中止`, "error");
      const count = errors.length + structuredIssues.filter((issue) => issue.severity === "error").length;
      this._status.textContent = `保存できません。${count}件のエラーがあります`;
      this._errorAnnouncer?.announce(`設定を保存できません。${count}件のエラーがあります`);
      this.#render();
      return;
    }
    for (const w of warnings) this.log(`設定エディタの警告: ${w}`, "warn");
    this._applyBtn.disabled = true;
    this._status.textContent = "保存して適用しています";
    this._announcer?.announce("設定を保存して適用しています");
    try {
      await this.onApply(clone(this.draft));
      this.log("設定を保存し、適用しました");
      this.controller.changed(this.draft);
      this.controller.state.dirty = false;
      this._announcer?.announce("設定を保存して適用しました");
      this.close("saved");
    } catch (e) {
      const div = document.createElement("div");
      div.className = "settings-error";
      div.textContent = `${e.message} (「JSONエクスポート」で手動保存もできます)`;
      this._errors.append(div);
      this.log(`設定エディタ: 保存に失敗しました (${e.message})`, "error");
      this._status.textContent = "保存に失敗しました。JSONエクスポートで手動保存できます";
      this._errorAnnouncer?.announce("設定の保存に失敗しました");
    } finally {
      this._applyBtn.disabled = false;
    }
  }

  #export() {
    const json = serializeConfigExport(this.draft);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dociai-config-export.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.log("秘密値を除外した設定packageをエクスポートしました");
    this._status.textContent = "秘密値を除外した設定 package をエクスポートしました";
    this._announcer?.announce("秘密値を除外した設定 package をエクスポートしました");
  }
}
