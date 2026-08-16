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
import { isMiniMaxSearchConnector } from "./config/minimax-search-config.js";
import {
  hasElectronTranslationService,
  translationModelStatusThroughElectron,
  installTranslationModelThroughElectron,
  cancelTranslationModelInstallThroughElectron,
  deleteTranslationModelThroughElectron,
  subscribeTranslationModelProgressThroughElectron,
  translationStatusThroughElectron,
  warmUpTranslationThroughElectron,
} from "./platform/electron-services.js";

const PROVIDERS = registryOptions("providers");
const TRIGGER_TYPES = registryOptions("triggerTypes");
const VOICE_ENGINES = registryOptions("voiceEngines");
const NEWS_MODES = registryOptions("newsModes");
const NEWS_SOURCE_TYPES = registryOptions("newsSourceTypes");
const TOPIC_SOURCE_TYPES = registryOptions("topicSourceTypes");
const AUTOMATION_SHARED_TRIGGER_MODES = registryOptions("automationSharedTriggerModes");
const TRANSLATION_SOURCE_LANGUAGES = registryOptions("translationSourceLanguages");
const TRANSLATION_OUTPUT_MODES = registryOptions("translationOutputModes");
const TRANSLATION_FAILURE_POLICIES = registryOptions("translationFailurePolicies");
const TRANSLATION_MODEL_STATE_LABELS = { not_installed: "未導入", downloading: "ダウンロード中", installed: "利用可能", error: "エラー" };

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

  // issue #282: onSetSecret/onSecretStatus は「draft configを一切経由せずにsecret storeへ直接
  // 書く」ための口。OBS WebSocketパスワードだけはconnectors.*.apiKey方式 (draftへ書いて保存時に
  // splitConnectorSecretsで分離) を使えない — config-validation.js が captions.obs.password の
  // 存在自体をerrorとして拒否する (平文でconfigに残る経路を1つも作らないため) ので、draftへ
  // 置いた瞬間に保存がブロックされてしまう。Browser版では未指定のままなので入力欄も出ない。
  constructor({ getCurrent = () => null, onApply = () => {}, log = () => {}, onSetSecret = null, onSecretStatus = null } = {}) {
    this.getCurrent = getCurrent;
    this.onApply = onApply;
    this.log = log;
    this.onSetSecret = onSetSecret;
    this.onSecretStatus = onSecretStatus;
    this._captionSecretStatus = null;
    this.draft = null;
    this.activeTab = "connectors";
    this.root = null;
    this._opener = null;
    this._pendingFocusSelector = null;
    this._built = false;
    this._translationModelStatus = null;
    this._translationModelStatusLoading = false;
    this._translationModelStatusGeneration = 0;
    this._translationRuntimeStatus = null;
    this._translationRuntimeStatusLoading = false;
    this._translationModelProgress = null;
    this._translationModelRenderedState = null;
    this._translationModelBusy = false;
    this._unsubscribeTranslationModelProgress = null;
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
    this.#invalidateTranslationModelStatus();
    // _translationRuntimeStatusはdialogの生存期間ずっとcacheされ、open()のたびに取り直される
    // 前提の下のコメント (#ensureTranslationRuntimeStatusLoaded参照) と実装が食い違っていた
    // (PRレビュー指摘)。翻訳失敗はdialogを開いたまま起きるわけではなく、大抵はコメント読み上げ
    // 中 (dialogが閉じている間) に起きるため、ここでリセットしないと「翻訳に失敗した後で
    // 設定を開き直しても、まだ試行前だった頃のidle状態が表示され続ける」という、この機能の
    // 目的そのものを損なう不具合になっていた。
    this._translationRuntimeStatus = null;
    this._translationModelProgress = null;
    this.#ensureBuilt();
    if (hasElectronTranslationService()) {
      // 再入 (open()呼び出し中にもう一度open()される) で前回分の購読を孤児化させない。
      this._unsubscribeTranslationModelProgress?.();
      this._unsubscribeTranslationModelProgress = subscribeTranslationModelProgressThroughElectron((event) => {
        this._translationModelProgress = event;
        // 完了・失敗、および (ダウンロード中状態を初めて知った時点で) status()を取り直す。
        // "downloading"を逃すと、インストール中ずっとcacheされたnot_installedのままとなり
        // キャンセルボタンが一切出せない状態が続く (PRレビュー指摘)。既にdownloading反映済みなら
        // 進捗イベントの度に再取得しない。
        const alreadyDownloading = this._translationModelStatus?.value?.state === "downloading";
        if (event.state === "installed" || event.state === "failed" || event.state === "cancelled" || (event.state === "downloading" && !alreadyDownloading)) {
          this.#invalidateTranslationModelStatus();
        }
        if (event.state === "installed") this._announcer?.announce("翻訳モデルの導入が完了しました");
        else if (event.state === "failed") this._announcer?.announce("翻訳モデルの導入に失敗しました");
        else if (event.state === "cancelled") this._announcer?.announce("翻訳モデルの導入をキャンセルしました");
        this.#refreshTranslationModelStatusUI();
      });
    }
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
    // ネイティブの dialog close イベントで確実に購読解除する (Escapeキー等、this.close()を
    // 経由しない閉じ方でも translation:model:progress の購読が残り続けないようにするため)。
    dlg.addEventListener("close", () => { this._unsubscribeTranslationModelProgress?.(); this._unsubscribeTranslationModelProgress = null; });

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
      ["captions", "英語CC", "Twitch 英語字幕"],
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
    else if (tab === "captions") this.#renderCaptions();
    this._body.scrollTop = 0;
    this.#applyIssueA11y();
    if (this._pendingFocusSelector) {
      const target = this._body.querySelector(this._pendingFocusSelector);
      this._pendingFocusSelector = null;
      const card = target?.closest(".card");
      const body = target?.closest(".settings-body");
      const block = card && body && card.getBoundingClientRect().height > body.getBoundingClientRect().height
        ? "start"
        : "nearest";
      (card ?? target)?.scrollIntoView({ block });
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

  #pathCheckbox(label, path, { value = false, onChange = null } = {}) {
    const shell = this.#fieldShell(label, path, { inline: true });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.addEventListener("change", () => {
      this.#setPath(this.draft, path, cb.checked);
      onChange?.(cb.checked);
    });
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
      if (this.draft.research?.connector === oldKey) this.draft.research.connector = newKey;
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

  #listHeader(title) {
    const h = document.createElement("div");
    h.className = "list-header";
    const t = document.createElement("h3");
    t.textContent = title;
    h.append(t);
    return h;
  }

  #listAddButton(listId, title, onAdd) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-add";
    b.dataset.listAdd = listId;
    b.innerHTML = `<span>+</span> 追加`;
    b.setAttribute("aria-label", `${title}を追加`);
    b.addEventListener("click", () => {
      onAdd();
      this.controller.changed(this.draft);
    });
    return b;
  }

  #emptyListMessage(title) {
    const message = document.createElement("p");
    message.className = "muted list-empty";
    message.textContent = `${title}がありません。「+ 追加」で作成してください`;
    return message;
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
    b.addEventListener("click", () => {
      onRemove();
      this.controller.changed(this.draft);
    });
    return b;
  }

  // ---- connectors ----
  #renderConnectors() {
    const body = this._body;
    body.append(this.#listHeader("コネクタ"));
    const addButton = this.#listAddButton("connectors", "コネクタ", () => {
      // 描画側は `?? {}` で空状態を出すため、connectors キーの無い設定からも押せてしまう。
      this.draft.connectors ??= {};
      let i = 1;
      while (this.draft.connectors[`new_connector_${i}`]) i++;
      this.draft.connectors[`new_connector_${i}`] = { provider: "mock" };
      this._pendingFocusSelector = `[data-config-path="connectors.new_connector_${i}.id"]`;
      this.#render();
      this._announcer?.announce(`コネクタ new_connector_${i} を追加しました`);
    });
    const entries = Object.entries(this.draft.connectors ?? {});
    if (!entries.length) body.append(this.#emptyListMessage("コネクタ"));
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
          if (this.draft.research?.connector === id) this.draft.research.connector = "";
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
        this.#mapField("maxTokens", "connectors", id, "maxTokens", { type: "number", value: c.maxTokens ?? "", placeholder: "既定: 2048", attrs: { step: 1 } }),
      );
      cardBody.append(row1, row2);
      this._body.append(card);
    }
    body.append(addButton);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "AIの長い返答が文の途中で終わる場合は、読み上げではなく生成側のmaxTokens上限に達している可能性があります。未指定時は2048です。システムログに出力上限の警告が出る場合は、この値を増やしてください。";
    body.append(note);
  }

  // ---- personas ----
  #renderPersonas() {
    const body = this._body;
    body.append(this.#listHeader("ペルソナ"));
    const addButton = this.#listAddButton("personas", "ペルソナ", () => {
      // 描画側は `?? []` で空状態を出すため、personas キーの無い設定からも押せてしまう。
      this.draft.personas ??= [];
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
    });
    const connectorIds = Object.keys(this.draft.connectors ?? {});
    const triggerIds = Object.keys(this.draft.triggers ?? {});
    const personas = this.draft.personas ?? [];
    if (!personas.length) body.append(this.#emptyListMessage("ペルソナ"));
    for (const [i, p] of personas.entries()) {
      const headEls = [
        this.#arrField("ID", "personas", i, "id", { value: p.id, attrs: { spellcheck: "false" } }),
        this.#arrField("表示名", "personas", i, "name", { value: p.name }),
        this.#arrCheckbox("有効", "personas", i, "enabled", { value: p.enabled }),
        this.#removeBtn(() => {
          this.draft.personas.splice(i, 1);
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
    body.append(addButton);
  }

  // ---- triggers ----
  #renderTriggers() {
    const body = this._body;
    body.append(this.#listHeader("トリガー"));
    const addButton = this.#listAddButton("triggers", "トリガー", () => {
      // 描画側は `?? {}` で空状態を出すため、triggers キーの無い設定からも押せてしまう。
      this.draft.triggers ??= {};
      let i = 1;
      while (this.draft.triggers[`new_trigger_${i}`]) i++;
      this.draft.triggers[`new_trigger_${i}`] = { type: "manual" };
      this._pendingFocusSelector = `[data-config-path="triggers.new_trigger_${i}.id"]`;
      this.#render();
      this._announcer?.announce(`トリガー new_trigger_${i} を追加しました`);
    });
    const entries = Object.entries(this.draft.triggers ?? {});
    if (!entries.length) body.append(this.#emptyListMessage("トリガー"));
    for (const [id, t] of entries) {
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
    body.append(addButton);
  }

  // ---- context / screenCapture / router ----
  #renderContext() {
    const connectorIds = Object.keys(this.draft.connectors ?? {});
    const sc = this.draft.context?.screenCapture ?? {};
    const ctx = this.draft.context ?? {};
    const research = this.draft.research ?? { enabled: false, connector: "", maxResults: 5 };
    const researchConnectorIds = connectorIds.filter((id) => isMiniMaxSearchConnector(this.draft.connectors?.[id]));
    if (!this.draft.research) this.draft.research = research;

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

    const researchTitle = document.createElement("div");
    researchTitle.className = "card-title";
    researchTitle.textContent = "Web調査 prepass (MiniMax)";
    const { card: researchCard, body: researchBody } = this.#card([researchTitle]);
    const researchGrid = document.createElement("div");
    researchGrid.className = "card-grid";
    researchGrid.append(this.#pathCheckbox("有効", "research.enabled", { value: research.enabled }));
    researchGrid.append(this.#pathSelect("検索担当connector", ["", ...researchConnectorIds], "research.connector", { value: research.connector ?? "" }));
    researchGrid.append(this.#pathField("最大検索結果数", "research.maxResults", { type: "number", value: research.maxResults ?? 5, attrs: { min: 1, max: 10, step: 1 } }));
    researchBody.append(researchGrid);
    const researchHelp = document.createElement("p");
    researchHelp.className = "muted";
    researchHelp.textContent = "コメント・手動依頼・話題の読み上げへの返答前にMiniMax Web検索を行います。Token Planの利用料金が発生する場合があります。検索失敗時は通常回答へフォールバックします。";
    researchBody.append(researchHelp);
    this._body.append(researchCard);

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
    note.textContent = "配信者の発話を検知すると次のAI音声の開始を保留し、無音に戻ると再開します (再生中の読み上げは止めずに最後まで続きます)。スピーカー環境ではAI自身の声を誤検知することがあるため、ヘッドホンや仮想オーディオデバイスでの分離を推奨します (docs/obs-mode.md 参照)。deviceが「既定のデバイス」以外に一覧されない場合は、一度「監視開始」でマイク権限を許可してから設定を開き直してください。";
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
      g.append(this.#pathField("読み上げ間隔 (秒)", "commentReader.intervalSeconds", { type: "number", value: cr.intervalSeconds ?? 0, attrs: { min: 0, max: 3600, step: 0.5 } }));
      const webspeech = cr.webspeech ?? {};
      const voicevox = cr.voicevox ?? {};
      const bouyomi = cr.bouyomi ?? {};
      g.append(this.#withTestVoiceButton(
        this.#pathSelect("Web Speech: 音声名", this.#voiceNameOptions(webspeech.name), "commentReader.webspeech.name", { value: webspeech.name ?? "default" }),
        () => ({ rate: this.draft.commentReader?.webspeech?.rate, pitch: this.draft.commentReader?.webspeech?.pitch }),
      ));
      g.append(this.#pathField("Web Speech: rate", "commentReader.webspeech.rate", { type: "number", value: webspeech.rate ?? 1.0, attrs: { min: 0.5, max: 2, step: 0.1 } }));
      g.append(this.#pathField("Web Speech: pitch", "commentReader.webspeech.pitch", { type: "number", value: webspeech.pitch ?? 1.0, attrs: { min: 0, max: 2, step: 0.1 } }));
      g.append(this.#pathField("VOICEVOX: 話者ID", "commentReader.voicevox.speaker", { type: "number", value: voicevox.speaker ?? "", attrs: { min: 0, step: 1 } }));
      g.append(this.#pathField("VOICEVOX: speed", "commentReader.voicevox.speed", { type: "number", value: voicevox.speed ?? 1.0, attrs: { min: 0.5, max: 2, step: 0.1 } }));
      g.append(this.#pathField("VOICEVOX: pitch", "commentReader.voicevox.pitch", { type: "number", value: voicevox.pitch ?? 0, attrs: { min: -0.15, max: 0.15, step: 0.01 } }));
      g.append(this.#pathField("VOICEVOX: intonation", "commentReader.voicevox.intonation", { type: "number", value: voicevox.intonation ?? 1.0, attrs: { min: 0, max: 2, step: 0.1 } }));
      g.append(this.#pathField("VOICEVOX: volume", "commentReader.voicevox.volume", { type: "number", value: voicevox.volume ?? 1.0, attrs: { min: 0, max: 2, step: 0.1 } }));
      g.append(this.#pathField("棒読みちゃん: 話者", "commentReader.bouyomi.voice", { type: "number", value: bouyomi.voice ?? this.draft.bouyomi?.voice ?? 0, attrs: { min: 0, step: 1 } }));
      g.append(this.#pathField("棒読みちゃん: speed", "commentReader.bouyomi.speed", { type: "number", value: bouyomi.speed ?? this.draft.bouyomi?.speed ?? -1, attrs: { min: -1, max: 200, step: 1 } }));
      g.append(this.#pathField("棒読みちゃん: tone", "commentReader.bouyomi.tone", { type: "number", value: bouyomi.tone ?? this.draft.bouyomi?.tone ?? -1, attrs: { min: -1, max: 200, step: 1 } }));
      g.append(this.#pathField("棒読みちゃん: volume", "commentReader.bouyomi.volume", { type: "number", value: bouyomi.volume ?? this.draft.bouyomi?.volume ?? -1, attrs: { min: -1, max: 100, step: 1 } }));
      cardBody.append(g);
      cardBody.append(this.#pathCheckbox("ユーザー名を読み上げる", "commentReader.includeAuthor", { value: cr.includeAuthor !== false }));
      cardBody.append(this.#pathCheckbox("エモートを読み上げない", "commentReader.skipEmotes", { value: !!cr.skipEmotes }));
      cardBody.append(this.#pathCheckbox("連続する絵文字を1つにまとめる", "commentReader.collapseConsecutiveEmoji", { value: !!cr.collapseConsecutiveEmoji }));
      const bypassCheckbox = this.#pathCheckbox("マイク発話中でも短いコメントはすぐ読み上げる", "commentReader.bypassMicHoldForShortComments", { value: !!cr.bypassMicHoldForShortComments });
      bypassCheckbox.querySelector("input").addEventListener("change", () => this.#render());
      cardBody.append(bypassCheckbox);
      if (cr.bypassMicHoldForShortComments) {
        cardBody.append(this.#pathField("短いコメントの文字数上限", "commentReader.shortCommentMaxChars", { type: "number", value: cr.shortCommentMaxChars ?? 12, attrs: { min: 1, max: 200, step: 1 } }));
      }
      cardBody.append(this.#pathField("読み上げを無視するユーザー (カンマ区切り)", "commentReader.ignoreUsers", { value: asArray(cr.ignoreUsers).join(", "), csv: true, attrs: { spellcheck: "false" } }));
      cardBody.append(this.#pathField("読み上げ除外マーカー", "commentReader.excludeAfterMarker", { value: cr.excludeAfterMarker ?? "", placeholder: "例: ここまで", attrs: { spellcheck: "false" } }));
    }
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "Twitch等に投稿された全コメントを、トリガー条件やAI応答の有無に関わらずそのまま読み上げます。同じ読み上げキューを使うため、AIペルソナが応答する場合は「コメント読み上げ → AI応答」の順に再生されます。「読み上げ間隔 (秒)」は、あるコメントの読み上げが終わってから次のコメントの読み上げを始めるまでの最短待機時間です (既定0=間隔なし)。コメントが連続で届いても機関銃のように読み上げ続けないよう調整できます。同じキューにコメント読み上げより後ろに積まれたAI応答は、この待機の間も自分の順番を待つため、間隔を長くするとAI応答の開始も遅れる場合があります。「連続する絵文字を1つにまとめる」は、単独の絵文字は残し、空白を挟んだ絵文字の連投も先頭1つだけ読み上げます (Twitchのエモートコードの連投も同様にまとめます)。Web Speech・VOICEVOX・棒読みちゃんの音高/速度は別々に保持され、engineを切り替えても各設定が残ります。棒読みちゃんの待機時間が合わない場合は同engineのspeed、または棒読みちゃんタブのcharsPerSecondを調整してください。「読み上げ除外マーカー」に文字列を設定すると、コメント内にこの文字列がある場合、最初に出現した位置以降は読み上げません (例:「ここまで」と設定すると、「よろしくお願いします ここまで 個人情報」というコメントは「よろしくお願いします」まで読み上げます)。コメント表示自体は変更されません。空欄 (未設定) のときはこの機能は働きません。";
    this._body.append(note);
    if (cr.enabled) this.#renderCommentReaderTranslation(cr);
  }

  // ---- commentReader.translation (issue #257 Phase 4, #263) ----
  #renderCommentReaderTranslation(cr) {
    const t = cr.translation ?? {};
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "外国語コメントの翻訳読み上げ";
    const { card, body: cardBody } = this.#card([title]);
    const enabledField = this.#pathCheckbox("外国語コメントを日本語に翻訳して読み上げる", "commentReader.translation.enabled", { value: !!t.enabled, onChange: () => this.#render() });
    cardBody.append(enabledField);
    if (t.enabled) {
      const g = document.createElement("div");
      g.className = "card-grid";
      g.append(this.#translationSourceLanguages(asArray(t.sourceLanguages)));
      g.append(this.#pathSelect("読み上げ方法", TRANSLATION_OUTPUT_MODES, "commentReader.translation.outputMode", { value: t.outputMode ?? "translated" }));
      g.append(this.#pathSelect("翻訳失敗時", TRANSLATION_FAILURE_POLICIES, "commentReader.translation.onFailure", { value: t.onFailure ?? "readOriginal" }));
      g.append(this.#pathField("言語判定の信頼度 (0〜1)", "commentReader.translation.minimumConfidence", { type: "number", value: t.minimumConfidence ?? 0.7, attrs: { min: 0, max: 1, step: 0.05 } }));
      g.append(this.#pathField("翻訳timeout (ms)", "commentReader.translation.timeoutMs", { type: "number", value: t.timeoutMs ?? 25000, attrs: { min: 500, max: 30000, step: 100 } }));
      g.append(this.#pathField("翻訳する最大文字数", "commentReader.translation.maxInputChars", { type: "number", value: t.maxInputChars ?? 500, attrs: { min: 1, max: 1000, step: 10 } }));
      cardBody.append(g);
      cardBody.append(this.#translationModelStatusBlock());
    }
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "英語・フランス語のコメントを端末内で日本語へ翻訳し、翻訳後のテキストだけをコメント読み上げに使います。元コメントの表示・履歴・OBS通知・AIペルソナへの入力は原文のままです。翻訳は外部API/AIへ一切送信せず、下の翻訳モデルを事前に導入したうえで完全にオフラインで動作します。日本語コメント・対象外言語・短い定型反応 (GG/LOL等) は原則として翻訳せず原文のまま読み上げます。";
    this._body.append(note);
  }

  #translationSourceLanguages(selectedLanguages) {
    // draftの値をそのまま描画する — 空配列を["en","fr"]へフォールバックして描画すると、
    // 両方チェックを外した直後に無関係な再描画 (他フィールドのonChange等) が走った際、
    // チェックボックスの見た目だけ両方ONに戻りdraftの[]と食い違う (PRレビュー指摘)。
    // 空選択のフィードバックはvalidationの「翻訳元言語を選択してください」に委ねる。
    const selected = new Set(selectedLanguages);
    const wrap = document.createElement("div");
    wrap.className = "field";
    // このチェックボックス群には対応する単一の<input>が無いため、他フィールドのように
    // #attachFieldInput()経由でdata-config-pathが付かない — navigateToIssue()/#applyIssueA11y()
    // が`[data-config-path="commentReader.translation.sourceLanguages"]`を探しても見つからず、
    // フッターのエラー一覧から「該当入力を表示できません」となり、aria-invalid/aria-describedby
    // による通知も届かなかった (PRレビュー指摘)。グループのwrapper自体をfieldとして扱う。
    wrap.dataset.configPath = "commentReader.translation.sourceLanguages";
    wrap.tabIndex = -1; // 非interactiveな要素だがnavigateToIssue()がfocus()できるようにする
    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = "対象言語";
    const box = document.createElement("div");
    box.className = "checkbox-group";
    for (const opt of TRANSLATION_SOURCE_LANGUAGES) {
      const lab = document.createElement("label");
      lab.className = "chip-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = opt.value;
      cb.checked = selected.has(opt.value);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(opt.value); else selected.delete(opt.value);
        this.#setPath(this.draft, "commentReader.translation.sourceLanguages", [...selected]);
      });
      lab.append(cb, document.createTextNode(opt.label));
      box.append(lab);
    }
    wrap.append(label, box);
    return wrap;
  }

  // _translationModelStatusをnullへ戻す全ての箇所をこれ経由にする — generationを一緒に
  // 進めることで、「古いfetchがまだ飛行中のうちに新しい無効化 (例: downloading中に届いた
  // cancelledイベント) が起きる」競合を検出できるようにする (下記#ensureTranslationModelStatusLoaded
  // 参照)。
  #invalidateTranslationModelStatus() {
    this._translationModelStatus = null;
    this._translationModelStatusGeneration += 1;
  }

  #ensureTranslationModelStatusLoaded() {
    if (this._translationModelStatus || this._translationModelStatusLoading) return;
    this._translationModelStatusLoading = true;
    const generation = this._translationModelStatusGeneration;
    translationModelStatusThroughElectron()
      .then((result) => { if (generation === this._translationModelStatusGeneration) this._translationModelStatus = result; })
      // ipcRenderer.invoke() 自体がreject する経路 (Main process側のResult<T>包み込み以前の
      // 異常) も拾っておく — さもないと「状態を確認しています…」が復帰不能に固定表示される。
      .catch((error) => { if (generation === this._translationModelStatusGeneration) this._translationModelStatus = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }; })
      .finally(() => {
        this._translationModelStatusLoading = false;
        // このfetchが飛んでいる間に別の無効化 (例: downloading中に届いたcancelledイベント) が
        // 起きていた場合、上のthen/catchは意図的に結果を捨てている — _translationModelStatusは
        // まだnullのままなので、この#refreshTranslationModelStatusUI()が
        // #ensureTranslationModelStatusLoaded()を再度呼び直し、最新のgenerationで
        // 取り直しになる。取り直さずにここで終えると、古い(downloading時点の)結果で
        // 上書きされたままcancelled後もチップが固定され続けていた (PRレビュー指摘: 実際に
        // ライブ検証で再現・特定したrace)。
        this.#refreshTranslationModelStatusUI();
      });
  }

  // モデルファイルの導入状態 (_translationModelStatus) とは別に、翻訳runtime (onnxruntime-node
  // 経由でのモデルロード・推論の実行可否) 自体の状態を取得する。モデルファイルは導入済みでも
  // packaged buildでruntimeの読み込みが失敗する既知の問題があり (#257関連)、その場合ここだけが
  // 実際の失敗理由 (lastError) を持っている。#ensureTranslationModelStatusLoadedと違い進捗
  // イベントは無いため、開くたびに一度だけ取得する簡易版でよい。
  #ensureTranslationRuntimeStatusLoaded() {
    if (this._translationRuntimeStatus || this._translationRuntimeStatusLoading) return;
    this._translationRuntimeStatusLoading = true;
    translationStatusThroughElectron()
      .then((result) => { this._translationRuntimeStatus = result; })
      .catch((error) => { this._translationRuntimeStatus = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }; })
      .finally(() => {
        this._translationRuntimeStatusLoading = false;
        if (this.root?.open && this.activeTab === "commentReader") this.#refreshTranslationModelStatusUI();
      });
  }

  // ダウンロード中は`translation:model:progress`が~500msごとに発火する。以前はここで毎回
  // 全体の#render()を呼んでおり、replaceChildren()でbody全体を作り直すため、フォーカス中の
  // 入力・開いていたselect・スクロール位置が0.5秒ごとに吹き飛んでいた — 630MB級のダウンロード中
  // (数分間) はキーボード/スクリーンリーダー利用者が設定ダイアログを一切操作できなくなっていた
  // (PRレビュー指摘の重大なaccessibility不具合)。翻訳モデル状態ブロック単体だけを差し替える —
  // ここまでが最初の修正。だが state (チップ) 自体は変わらない純粋な進捗tickでも
  // existing.replaceWith(...)でブロック全体を毎回作り直していたため、その中にしか無い
  // キャンセルボタン自体が0.5秒ごとに消えて再生成され、キーボード利用者がタブでフォーカスして
  // 押そうとした瞬間にボタンが無くなる、という同種の不具合が一段深いところに残っていた
  // (再レビューで指摘)。state不変の進捗tickでは進捗バー/テキストだけをin-placeで書き換える。
  #refreshTranslationModelStatusUI() {
    if (!this.root?.open) return;
    if (this.activeTab !== "commentReader") return; // 非表示タブの内容は次にそのタブへ切り替わった時の#render()が最新状態を反映する
    const existing = this._body.querySelector(".translation-model-status");
    if (!existing) { this.#render(); return; } // まだ一度もブロックが描画されていない (翻訳を初めて有効化した直後など) — この場合だけは全体描画が必要
    const currentState = this._translationModelStatus?.ok ? this._translationModelStatus.value.state : null;
    if (currentState != null && currentState === this._translationModelRenderedState && this.#updateTranslationProgressInPlace(existing)) {
      return; // stateが変わらない進捗tick — ボタン等はそのまま、フォーカスも維持される
    }
    this._translationModelRenderedState = currentState;
    existing.replaceWith(this.#translationModelStatusBlock());
  }

  // 進捗バーの見た目 (fill幅・aria-valuenow・ファイル番号/%テキスト) だけをin-placeで
  // 更新できたらtrueを返す。進捗バー自体が現在表示されていない (ダウンロード中でない) 場合は
  // falseを返し、呼び出し側に通常のフルブロック差し替えへフォールバックさせる。
  #updateTranslationProgressInPlace(existing) {
    const bar = existing.querySelector(".download-progress");
    const progress = this._translationModelProgress;
    if (!bar || !progress) return false;
    const percent = Math.round(progress.percent ?? 0);
    bar.setAttribute("aria-valuenow", String(percent));
    const fill = bar.querySelector(".download-progress-fill");
    if (fill) fill.style.width = `${percent}%`;
    const progressText = bar.nextElementSibling;
    if (progressText?.tagName === "P") {
      // fileIndex+1は"downloading"中のみ意味を持つ (verifying/installedはfileIndex===fileCount)。
      const fileLabel = progress.state === "downloading" ? `${progress.fileIndex + 1}/${progress.fileCount}` : `${progress.fileCount}/${progress.fileCount}`;
      progressText.textContent = `${progress.fileName || ""} (${fileLabel}) ${percent}%`;
    }
    return true;
  }

  async #installTranslationModel() {
    if (this._translationModelBusy) return;
    this._translationModelBusy = true;
    this._translationModelProgress = null;
    this.#render();
    try {
      // ipcRenderer.invoke()自体がreject する経路 (#ensureTranslationModelStatusLoaded()が
      // 既に想定・catchしている異常) をここでも拾う。try/finally無しで単純にawaitしていた旧実装
      // では、そのrejectがonClickハンドラの`void onClick()`に未処理rejectionとして飲み込まれ、
      // _translationModelBusyがtrueのまま復帰不能になっていた (「処理中…」が固定表示、ダイアログ
      // の閉じ直しでも治らない — PRレビュー指摘)。
      const result = await installTranslationModelThroughElectron();
      if (!result.ok && result.error.code !== "CANCELLED") this.log(`翻訳モデルの導入に失敗しました: ${result.error.message}`, "error");
      // issue #257 (PR #269 review指摘): 翻訳を有効化した後にモデルを導入するという順序 (この
      // ボタン自体、翻訳有効化チェックボックスがONの時にしか表示されない) では、boot.jsの
      // applyLoadedConfig()経由のウォームアップは既にconfig適用時に一度発火済みだが、その時点
      // ではモデル未導入で早期returnしていた。導入完了のこの瞬間にも改めて発火させないと、
      // 実際のコメントが届くまでモデルが常駐しないまま (#257要件のwarmUpの意味が無くなる)。
      if (result.ok) void warmUpTranslationThroughElectron();
    } catch (error) {
      this.log(`翻訳モデルの導入に失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this._translationModelBusy = false;
      this._translationModelProgress = null;
      this.#invalidateTranslationModelStatus(); // 最新状態を取り直す
      if (this.root?.open) this.#render();
    }
  }

  async #cancelTranslationModelInstall() {
    try {
      await cancelTranslationModelInstallThroughElectron();
    } catch (error) {
      // #installTranslationModel/#ensureTranslationModelStatusLoadedと同じ、
      // ipcRenderer.invoke()自体がrejectする経路のガード (再レビュー指摘: ここだけ抜けていた)。
      this.log(`翻訳モデルの導入キャンセルに失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async #deleteTranslationModel() {
    if (this._translationModelBusy) return;
    this._translationModelBusy = true;
    this.#render();
    try {
      const result = await deleteTranslationModelThroughElectron();
      if (!result.ok) this.log(`翻訳モデルの削除に失敗しました: ${result.error.message}`, "error");
    } catch (error) {
      this.log(`翻訳モデルの削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      this._translationModelBusy = false;
      this.#invalidateTranslationModelStatus();
      if (this.root?.open) this.#render();
    }
  }

  #translationModelActionButton(label, onClick, { disabled = false } = {}) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-ghost";
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener("click", () => { void onClick(); });
    return btn;
  }

  #translationModelStatusBlock() {
    const wrap = document.createElement("div");
    wrap.className = "field translation-model-status";
    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = "翻訳モデルの状態";
    wrap.append(label);

    if (!hasElectronTranslationService()) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "翻訳モデルの導入・管理はElectron版でのみ利用できます。";
      wrap.append(note);
      return wrap;
    }

    this.#ensureTranslationModelStatusLoaded();
    this.#ensureTranslationRuntimeStatusLoaded();
    const body = document.createElement("div");
    body.className = "translation-model-status-body";
    const result = this._translationModelStatus;

    if (!result) {
      const loading = document.createElement("p");
      loading.className = "muted";
      loading.textContent = "状態を確認しています…";
      body.append(loading);
      wrap.append(body);
      return wrap;
    }
    if (!result.ok) {
      const errP = document.createElement("p");
      errP.className = "muted";
      errP.textContent = `状態の取得に失敗しました: ${result.error.message}`;
      body.append(errP);
      wrap.append(body);
      return wrap;
    }

    const { state, catalogModel, installed, lastError } = result.value;
    const chip = document.createElement("span");
    chip.className = `chip translation-model-chip is-${state}`;
    chip.textContent = TRANSLATION_MODEL_STATE_LABELS[state] ?? state;
    body.append(chip);

    const info = document.createElement("p");
    info.className = "muted";
    const sizeMb = Math.ceil((installed?.totalSizeBytes ?? catalogModel.totalSizeBytes) / (1024 * 1024));
    info.textContent = `${catalogModel.displayName} — 約${sizeMb}MB — ライセンス: ${catalogModel.license.name}`;
    body.append(info);
    if (catalogModel.license.url) {
      const licenseLink = document.createElement("a");
      licenseLink.href = catalogModel.license.url;
      licenseLink.target = "_blank";
      licenseLink.rel = "noopener noreferrer";
      licenseLink.className = "muted translation-model-license-link";
      licenseLink.textContent = "ライセンス全文を見る";
      body.append(licenseLink);
    }

    const progress = this._translationModelProgress;
    if ((state === "downloading" || this._translationModelBusy) && progress) {
      const percent = Math.round(progress.percent ?? 0);
      const bar = document.createElement("div");
      bar.className = "download-progress";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(percent));
      bar.setAttribute("aria-label", "翻訳モデルのダウンロード進捗");
      const fill = document.createElement("div");
      fill.className = "download-progress-fill";
      fill.style.width = `${percent}%`;
      bar.append(fill);
      body.append(bar);
      const progressText = document.createElement("p");
      progressText.className = "muted";
      // fileIndex+1は"downloading"中 (0始まりの現在ファイル番号) にのみ意味がある。
      // "verifying"/"installed"はrepository.ts側でfileIndex===fileCountとして発火するため、
      // +1すると「(7/6)」のように総数を超えて表示されてしまっていた (PRレビュー指摘)。
      const fileLabel = progress.state === "downloading" ? `${progress.fileIndex + 1}/${progress.fileCount}` : `${progress.fileCount}/${progress.fileCount}`;
      progressText.textContent = `${progress.fileName || ""} (${fileLabel}) ${Math.round(progress.percent ?? 0)}%`;
      body.append(progressText);
    }

    if (lastError) {
      const errP = document.createElement("p");
      errP.className = "muted translation-model-error";
      errP.textContent = `エラー: ${lastError.message}`;
      body.append(errP);
    }

    // モデルファイルは導入済み (installed) でも、runtime側 (onnxruntime-node) が実行時に
    // ロードできず翻訳自体は一度も成功していない場合がある — 上のlastErrorはモデル
    // ダウンロード側のエラーであり、こちらとは別物。
    if (state === "installed" && this._translationRuntimeStatus?.ok && this._translationRuntimeStatus.value.state === "error") {
      const runtimeErrP = document.createElement("p");
      runtimeErrP.className = "muted translation-model-error";
      const runtimeMessage = this._translationRuntimeStatus.value.lastError?.message ?? "不明なエラー";
      runtimeErrP.textContent = `モデルは導入済みですが、翻訳を実行できません: ${runtimeMessage}`;
      body.append(runtimeErrP);
    }

    const actions = document.createElement("div");
    actions.className = "btn-row";
    if (this._translationModelBusy && state !== "downloading") {
      const busy = document.createElement("span");
      busy.className = "muted";
      busy.textContent = "処理中…";
      actions.append(busy);
    } else if (state === "not_installed" || state === "error") {
      actions.append(this.#translationModelActionButton(state === "error" ? "再試行" : "ダウンロード", () => this.#installTranslationModel()));
    } else if (state === "downloading") {
      actions.append(this.#translationModelActionButton("キャンセル", () => this.#cancelTranslationModelInstall()));
    } else if (state === "installed") {
      actions.append(this.#translationModelActionButton("削除", () => this.#deleteTranslationModel()));
    }
    body.append(actions);
    wrap.append(body);
    return wrap;
  }

  // ---- news ----
  #personaCandidatePool(section, selectedIds = []) {
    const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
    const personas = this.draft.personas ?? [];
    const personasById = new Map(personas.map((persona) => [persona.id, persona]));
    const candidateIds = [...new Set([...personas.map((persona) => persona.id), ...selected])].filter(Boolean);
    const poolWrap = document.createElement("div");
    poolWrap.className = "field persona-candidate-pool";
    poolWrap.dataset.personaSection = section;
    const poolLab = document.createElement("span");
    poolLab.className = "field-label";
    poolLab.textContent = "personas (ランダム候補)";
    const poolBox = document.createElement("div");
    poolBox.className = "checkbox-group";
    const warning = document.createElement("p");
    warning.className = "settings-inline-warning";
    warning.setAttribute("role", "status");

    const refreshWarning = () => {
      const validCount = [...selected].filter((id) => personasById.get(id)?.enabled !== false && personasById.has(id)).length;
      warning.textContent = selected.size === 0
        ? "候補が0件です。固定ペルソナ、またはdefaultペルソナへフォールバックします。"
        : validCount === 0
          ? "有効な候補がありません。固定ペルソナ、またはdefaultペルソナへフォールバックします。"
          : "";
      warning.hidden = !warning.textContent;
    };

    for (const pid of candidateIds) {
      const persona = personasById.get(pid);
      const unavailable = !persona || persona.enabled === false;
      const lab = document.createElement("label");
      lab.className = `chip-check${unavailable ? " is-unavailable" : ""}`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = pid;
      cb.checked = selected.has(pid);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(pid); else selected.delete(pid);
        this.draft[section].personas = [...selected];
        refreshWarning();
      });
      const description = !persona
        ? `${pid} (存在しません・抽選対象外)`
        : `${persona.name ?? pid} (${pid})${persona.enabled === false ? " — 無効・抽選対象外" : ""}`;
      lab.append(cb, document.createTextNode(description));
      poolBox.append(lab);
    }
    if (!candidateIds.length) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "(ペルソナがありません)";
      poolBox.append(empty);
    }
    refreshWarning();
    poolWrap.append(poolLab, poolBox, warning);
    return poolWrap;
  }

  #renderNews() {
    const n = this.draft.news ?? { enabled: false, sources: [], mode: "topic" };
    if (!this.draft.news) this.draft.news = n;
    if (!Array.isArray(n.sources)) n.sources = [];
    if (!Array.isArray(n.personas)) n.personas = [];
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
    // news.triggerとtopics.triggerが同じtriggerを指しているときの衝突挙動。設定パスは
    // newsとtopicsで共有 (automation.sharedTriggerMode) なので、topics側にも同じ項目を置いて
    // どちらのタブからでも気づけるようにしている (#renderTopics参照)。
    g.append(this.#pathSelect("トリガーが話題と同じ場合", AUTOMATION_SHARED_TRIGGER_MODES, "automation.sharedTriggerMode", { value: this.draft.automation?.sharedTriggerMode ?? "both" }));
    g.append(this.#pathSelect("persona (固定/フォールバック)", ["", ...personaIds], "news.persona", { value: n.persona ?? "" }));
    g.append(this.#pathSelect("mode", NEWS_MODES, "news.mode", { value: n.mode ?? "topic" }));
    g.append(this.#pathField("maxItems", "news.maxItems", { type: "number", value: n.maxItems ?? 3 }));
    g.append(this.#pathCheckbox("dedupe", "news.dedupe", { value: n.dedupe ?? true }));
    g.append(this.#pathCheckbox("ペルソナをランダムに選ぶ", "news.randomPersona", {
      value: !!n.randomPersona,
      onChange: () => {
        this._pendingFocusSelector = '[data-config-path="news.randomPersona"]';
        this.#render();
      },
    }));
    cardBody.append(g);
    if (n.randomPersona) cardBody.append(this.#personaCandidatePool("news", n.personas));
    cardBody.append(this.#pathField("corsProxy", "news.corsProxy", { value: n.corsProxy ?? "", attrs: { spellcheck: "false" } }));
    cardBody.append(this.#pathField("style", "news.style", { value: n.style ?? "", textarea: true, rows: 2 }));
    this._body.append(card);

    this._body.append(this.#listHeader("ニュースソース"));
    const addButton = this.#listAddButton("news-sources", "ニュースソース", () => {
      this.draft.news.sources.push({ name: "新規ソース", type: "rss", url: "", enabled: true });
      this._pendingFocusSelector = `[data-config-path="news.sources.${this.draft.news.sources.length - 1}.name"]`;
      this.#render();
      this._announcer?.announce("ニュースソースを追加しました");
    });
    const sources = n.sources;
    if (!sources.length) this._body.append(this.#emptyListMessage("ニュースソース"));
    for (const [i, s] of sources.entries()) {
      const headEls = [
        this.#arrField("name", "news.sources", i, "name", { value: s.name ?? "" }),
        this.#arrCheckbox("enabled", "news.sources", i, "enabled", { value: s.enabled ?? true }),
        this.#removeBtn(() => {
          this.draft.news.sources.splice(i, 1);
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
    this._body.append(addButton);
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
    // #renderNews側と同じconfigパス (automation.sharedTriggerMode) — ニュースと話題どちらの
    // タブから設定してもよい。
    g.append(this.#pathSelect("トリガーがニュースと同じ場合", AUTOMATION_SHARED_TRIGGER_MODES, "automation.sharedTriggerMode", { value: this.draft.automation?.sharedTriggerMode ?? "both" }));
    g.append(this.#pathSelect("persona", ["", ...personaIds], "topics.persona", { value: t.persona ?? "" }));
    g.append(this.#pathField("maxItems", "topics.maxItems", { type: "number", value: t.maxItems ?? 3 }));
    g.append(this.#pathCheckbox("dedupe", "topics.dedupe", { value: t.dedupe ?? true }));
    g.append(this.#pathCheckbox("ランダムに複数ペルソナで読む", "topics.randomPersona", { value: !!t.randomPersona }));
    cardBody.append(g);
    // ニュースと共通の候補UI。削除済み/無効化中の保存済みIDも可視化し、
    // runtimeの共通selection policyと同じフォールバック条件を伝える。
    cardBody.append(this.#personaCandidatePool("topics", t.personas));
    cardBody.append(this.#pathField("intro", "topics.intro", { value: t.intro ?? "", textarea: true, rows: 2 }));
    cardBody.append(this.#pathField("style", "topics.style", { value: t.style ?? "", textarea: true, rows: 2 }));
    this._body.append(card);

    this._body.append(this.#listHeader("話題ソース"));
    const addButton = this.#listAddButton("topics-sources", "話題ソース", () => {
      this.draft.topics.sources.push({ name: "配信ネタ (Todoist)", type: "todoist", enabled: true, token: "", projectId: "" });
      this._pendingFocusSelector = `[data-config-path="topics.sources.${this.draft.topics.sources.length - 1}.name"]`;
      this.#render();
      this._announcer?.announce("話題ソースを追加しました");
    });
    const sources = t.sources;
    if (!sources.length) this._body.append(this.#emptyListMessage("話題ソース"));
    for (const [i, s] of sources.entries()) {
      const headEls = [
        this.#arrField("name", "topics.sources", i, "name", { value: s.name ?? "" }),
        this.#arrCheckbox("enabled", "topics.sources", i, "enabled", { value: s.enabled ?? true }),
        this.#removeBtn(() => {
          this.draft.topics.sources.splice(i, 1);
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
    this._body.append(addButton);
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

  // ---- 英語クローズドキャプション (issue #282) ----
  #renderCaptions() {
    const c = this.draft.captions ?? {};
    if (!this.draft.captions) this.draft.captions = c;
    if (!c.obs) c.obs = { host: "127.0.0.1", port: 4455, microphoneInputName: "" };
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "英語クローズドキャプション";
    const { card, body: cardBody } = this.#card([title]);
    const enabledField = this.#pathCheckbox("配信者の日本語音声を英語字幕としてTwitchへ送る", "captions.enabled", { value: !!c.enabled, onChange: () => this.#render() });
    cardBody.append(enabledField);
    if (c.enabled) {
      const grid = document.createElement("div");
      grid.className = "card-grid";
      grid.append(this.#pathSelect("音声認識", registryOptions("captionRecognitionEngines"), "captions.recognitionEngine", { value: c.recognitionEngine ?? "chrome-web-speech" }));
      grid.append(this.#pathSelect("翻訳", registryOptions("captionTranslationEngines"), "captions.translationEngine", { value: c.translationEngine ?? "chrome-translator" }));
      grid.append(this.#pathField("Chrome実行ファイル (省略時は自動検出)", "captions.chromeExecutable", { value: c.chromeExecutable ?? "", attrs: { spellcheck: "false" } }));
      grid.append(this.#pathField("字幕ワーカーのポート (0で自動)", "captions.workerPort", { type: "number", value: c.workerPort ?? 0 }));
      grid.append(this.#pathField("OBS WebSocketホスト", "captions.obs.host", { value: c.obs.host ?? "127.0.0.1", attrs: { spellcheck: "false" } }));
      grid.append(this.#pathField("OBS WebSocketポート", "captions.obs.port", { type: "number", value: c.obs.port ?? 4455 }));
      grid.append(this.#pathField("対象OBSマイク入力名 (省略時はミュート判定なし)", "captions.obs.microphoneInputName", { value: c.obs.microphoneInputName ?? "", attrs: { spellcheck: "false" } }));
      grid.append(this.#pathField("送出待ちの上限", "captions.maxPending", { type: "number", value: c.maxPending ?? 2 }));
      grid.append(this.#pathField("字幕の有効時間 (ms)", "captions.maxAgeMs", { type: "number", value: c.maxAgeMs ?? 5000 }));
      grid.append(this.#pathField("字幕の最大文字数 (0で分割しない)", "captions.maxCaptionChars", { type: "number", value: c.maxCaptionChars ?? 0 }));
      cardBody.append(grid);
      cardBody.append(this.#pathCheckbox("字幕の受理をログに残す (本文は残しません)", "captions.logCaptions", { value: !!c.logCaptions }));
      if (this.onSetSecret) cardBody.append(this.#captionPasswordField());
    }
    this._body.append(card);
    const note = document.createElement("p");
    note.className = "muted settings-note";
    note.textContent = "配信者のマイク音声をデスクトップ版Google ChromeのWeb Speech APIで日本語文字起こしし、Chrome内蔵の翻訳で英訳して、OBS WebSocketの SendStreamCaption からTwitch公式クローズドキャプションへ送ります。翻訳に失敗した字幕は日本語のまま送らずに破棄します。操作卓の「英語CC」パネルから開始・停止できます。Chromeの音声認識はGoogleの音声認識サービスへ音声を送信します。OBSパスワードは設定ファイルではなくOS側の安全な保管領域へ保存され、設定のエクスポートには含まれません。";
    this._body.append(note);
  }

  // OBS WebSocketパスワード。draft configには一切書かず、secret storeへ直接保存する
  // (このクラスのコンストラクタのコメント参照)。
  #captionPasswordField() {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.textContent = "OBS WebSocketパスワード";
    label.htmlFor = "captions-obs-password";
    const input = document.createElement("input");
    input.type = "password";
    input.id = "captions-obs-password";
    input.autocomplete = "off";
    input.placeholder = this._captionSecretStatus?.configured ? "保存済み (変更する場合のみ入力)" : "未設定";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "パスワードを保存";
    const status = document.createElement("span");
    status.className = "muted";
    // 保存結果 (成功/失敗) を読み上げる。このファイルの他の動的status表示・
    // このPR自身の#caption-status/#message同様、role="status"で通知する。
    status.setAttribute("role", "status");
    button.addEventListener("click", () => {
      const value = input.value;
      if (!value) { status.textContent = "パスワードを入力してください"; return; }
      void Promise.resolve(this.onSetSecret("captions.obs.password", value)).then((result) => {
        if (result?.ok) {
          // 失敗時は入力内容を残す — クリアしてしまうと、失敗に気付かないまま何を入力したか
          // わからなくなる (role="status"を付けても、視覚的に空欄が正常保存に見えてしまう)。
          input.value = "";
          this._captionSecretStatus = { configured: true };
          status.textContent = "保存しました";
        } else {
          status.textContent = `保存に失敗しました: ${result?.error?.message ?? "unknown error"}`;
        }
      });
    });
    const row = document.createElement("div");
    row.className = "compact-row";
    row.append(input, button, status);
    wrap.append(label, row);
    if (this.onSecretStatus && this._captionSecretStatus === null) {
      this._captionSecretStatus = { configured: false };
      void Promise.resolve(this.onSecretStatus(["captions.obs.password"])).then((result) => {
        if (!result?.ok) return;
        const entry = result.value.find((item) => item.key === "captions.obs.password");
        this._captionSecretStatus = { configured: Boolean(entry?.configured) };
        if (this.root?.open && this.activeTab === "captions") this.#render();
      });
    }
    return wrap;
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
      this.controller.markSaved(this.draft);
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
