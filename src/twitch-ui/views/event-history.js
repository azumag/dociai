// Issue #96: the Event History tab — "event受信から最終action結果まで1件単位で追跡できる" +
// "productionとsimulationを誤認しない". Renders `EventHistoryStore`'s combined (production +
// simulation) bounded history as a filterable row list, with a per-row trace drawer
// (src/twitch-ui/history/trigger-trace-drawer.js) and a scoped "clear history" confirmation.
//
// Production sync: on first render, fetches `dociai.streamEvents.list()`'s snapshot (the
// Main-process StreamEventBus's OWN already-bounded history, #89) and subscribes to the live
// "stream-event" push for everything published from then on — mirrors twitch-ui-client.js's own
// `connectStore()` "fetch snapshot once, then live-push" idiom, just for this one extra IPC surface.
// In Browser mode (no `dociai` bridge) this is a no-op — the view still fully works for simulation
// entries, which never need Main-process IPC at all.
import { STREAM_EVENT_KINDS } from "../../stream-events/contract.js";
import { formatStreamEvent } from "../../stream-events/display.js";
import { sanitizeInlineText } from "../../actions/action-schema.js";
import { collectApiKeys, scrubSecrets } from "../../security.js";
import { createLiveAnnouncer } from "../../settings/a11y/live-region.js";
import { HISTORY_CONTEXT_FILTERS, HISTORY_RESULT_FILTERS, createHistoryFilterState, filterHistoryEntries } from "../history/history-filter.js";
import { renderTriggerTraceDrawer } from "../history/trigger-trace-drawer.js";

const STATUS_LABEL = { pending: "保留中", handled: "処理済み", skipped: "スキップ", failed: "失敗" };
const CONTEXT_LABEL = { production: "本番", simulation: "シミュレーション" };
const CLEAR_SCOPE_LABEL = { all: "すべて", production: "本番のみ", simulation: "シミュレーションのみ", olderThan: "指定時間より古いもの" };

function safeFormat(event) {
  try {
    return formatStreamEvent(event);
  } catch {
    return { icon: "❔", label: "不明", summary: "", value: 0 };
  }
}

/** The one free-text field a StreamEvent kind may carry (mirrors
 * src/context/stream-event-context.js's own `extractUntrustedText()` — the SAME two fields, so the
 * row list's collapsed preview and the trace drawer's prompt-preview quotation always agree on what
 * counts as "the untrusted text"). */
function extractRawMessage(event) {
  if (event?.kind === "cheer" || event?.kind === "resub") return event?.data?.message ?? null;
  if (event?.kind === "reward-redemption") return event?.data?.userInput ?? null;
  return null;
}

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

export class EventHistoryView {
  constructor({ document = globalThis.document, client = null, historyStore, getConfig = () => null, log = () => {} } = {}) {
    this.document = document;
    this.client = client;
    this.store = historyStore;
    this.getConfig = getConfig;
    this.log = log;
    this.filters = createHistoryFilterState();
    this.selectedEntryId = null;
    this.confirmClear = null;
    this.connected = false;
    this.unsubscribeStream = null;
    this.root = null;
    this.liveRegion = null;
    this.announcer = null;
    this.pendingFocusSelector = null;
  }

  /** Idempotent — safe to call on every render(); only does real work (the snapshot fetch + push
   * subscription) once per view instance. */
  connect() {
    if (this.connected || !this.client?.available) return;
    this.connected = true;
    void this.client.streamEventsList()
      .then((result) => {
        for (const published of result?.events ?? []) this.store.recordProduction(published);
        this.#announce(`${result?.events?.length ?? 0}件の本番イベント履歴を読み込みました`);
        if (this.root) this.render(this.root);
      })
      .catch((error) => this.log(error instanceof Error ? error.message : String(error), "warn"));
    this.unsubscribeStream = this.client.subscribeStreamEvents((published) => {
      this.store.recordProduction(published);
      this.#announce("新しいイベントを受信しました");
      if (this.root) this.render(this.root);
    });
  }

  /** Called when the whole Twitch Overview dialog is torn down (mirrors TwitchOverviewApp's own
   * `dispose()`) — stops the live push subscription so a disposed view is never invoked again. */
  dispose() {
    this.unsubscribeStream?.();
    this.unsubscribeStream = null;
    this.connected = false;
  }

  #announce(message) {
    this.announcer?.announce(message);
  }

  #openTrace(entryId) {
    this.selectedEntryId = entryId;
    this.pendingFocusSelector = "[data-trace-drawer-close]";
    this.render(this.root);
  }

  #closeTrace() {
    const closingId = this.selectedEntryId;
    this.selectedEntryId = null;
    this.pendingFocusSelector = closingId ? `[data-history-row-open="${closingId}"]` : null;
    this.render(this.root);
  }

  #performClear() {
    const config = this.confirmClear;
    if (!config) return;
    const scope = config.scope === "olderThan" ? { olderThanMs: Math.max(0, Number(config.olderThanMinutes) || 0) * 60_000 } : config.scope;
    const removed = this.store.clear(scope);
    // The Main-process StreamEventBus's OWN replay buffer (#89) is only cleared for a FULL-scope
    // clear ("all"/"production") — a scoped "older than X" clear must never wipe RECENT production
    // events the operator explicitly chose to keep, so it only ever touches this Renderer-side
    // combined store.
    if ((config.scope === "all" || config.scope === "production") && this.client?.available) {
      void this.client.streamEventsClear().catch((error) => this.log(error instanceof Error ? error.message : String(error), "warn"));
    }
    this.#announce(`${removed}件の履歴を削除しました (対象: ${CLEAR_SCOPE_LABEL[config.scope] ?? config.scope})`);
    this.confirmClear = null;
    this.selectedEntryId = null;
    this.render(this.root);
  }

  #renderFilterControls(document, root) {
    const box = document.createElement("div");
    box.className = "history-toolbar";

    const contextSelect = document.createElement("select");
    contextSelect.setAttribute("aria-label", "context (本番/シミュレーション) で絞り込み");
    for (const value of HISTORY_CONTEXT_FILTERS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "all" ? "全context" : CONTEXT_LABEL[value];
      option.selected = value === this.filters.context;
      contextSelect.append(option);
    }
    contextSelect.addEventListener("change", () => { this.filters = { ...this.filters, context: contextSelect.value }; this.render(root); });

    const typeSelect = document.createElement("select");
    typeSelect.setAttribute("aria-label", "eventの種類で絞り込み");
    for (const value of ["all", ...STREAM_EVENT_KINDS]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "all" ? "全type" : value;
      option.selected = value === this.filters.type;
      typeSelect.append(option);
    }
    typeSelect.addEventListener("change", () => { this.filters = { ...this.filters, type: typeSelect.value }; this.render(root); });

    const resultSelect = document.createElement("select");
    resultSelect.setAttribute("aria-label", "結果で絞り込み");
    for (const value of HISTORY_RESULT_FILTERS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "all" ? "全result" : STATUS_LABEL[value];
      option.selected = value === this.filters.result;
      resultSelect.append(option);
    }
    resultSelect.addEventListener("change", () => { this.filters = { ...this.filters, result: resultSelect.value }; this.render(root); });

    const textInput = document.createElement("input");
    textInput.type = "search";
    textInput.placeholder = "テキストで検索";
    textInput.value = this.filters.text;
    textInput.setAttribute("aria-label", "テキストで検索");
    textInput.addEventListener("input", () => { this.filters = { ...this.filters, text: textInput.value }; this.render(root); });

    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.dataset.historyClearOpen = "true";
    clearButton.textContent = "履歴をクリア…";
    clearButton.addEventListener("click", () => { this.confirmClear = { scope: "all", olderThanMinutes: 60 }; this.render(root); });

    box.append(contextSelect, typeSelect, resultSelect, textInput, clearButton);
    return box;
  }

  #renderClearConfirm(document, root) {
    const box = document.createElement("div");
    box.className = "history-clear-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-label", "履歴クリアの確認");
    const message = document.createElement("p");
    message.textContent = "削除した履歴は元に戻せません。対象を選んでください。";
    box.append(message);

    const scopeGroup = document.createElement("div");
    scopeGroup.className = "checkbox-group";
    for (const scope of ["all", "production", "simulation", "olderThan"]) {
      const label = document.createElement("label");
      label.className = "chip-check";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "history-clear-scope";
      radio.value = scope;
      radio.checked = this.confirmClear.scope === scope;
      radio.dataset.historyClearScope = scope;
      radio.addEventListener("change", () => { this.confirmClear = { ...this.confirmClear, scope }; this.render(root); });
      label.append(radio, document.createTextNode(CLEAR_SCOPE_LABEL[scope]));
      scopeGroup.append(label);
    }
    box.append(scopeGroup);

    if (this.confirmClear.scope === "olderThan") {
      const minutesLabel = document.createElement("label");
      minutesLabel.className = "field-inline";
      const minutesInput = document.createElement("input");
      minutesInput.type = "number";
      minutesInput.min = "1";
      minutesInput.value = this.confirmClear.olderThanMinutes ?? 60;
      minutesInput.dataset.historyClearMinutes = "true";
      minutesInput.addEventListener("input", () => { this.confirmClear = { ...this.confirmClear, olderThanMinutes: Number(minutesInput.value) }; });
      minutesLabel.append(document.createTextNode("何分より古い履歴を削除: "), minutesInput, document.createTextNode(" 分"));
      box.append(minutesLabel);
    }

    const buttonRow = document.createElement("div");
    buttonRow.className = "btn-row";
    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "btn-danger";
    confirmButton.dataset.historyClearConfirm = "true";
    confirmButton.textContent = "削除する";
    confirmButton.addEventListener("click", () => this.#performClear());
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "キャンセル";
    cancelButton.addEventListener("click", () => { this.confirmClear = null; this.render(root); });
    buttonRow.append(confirmButton, cancelButton);
    box.append(buttonRow);
    return box;
  }

  #renderRow(document, entry, scrub) {
    const display = safeFormat(entry.event);
    const row = document.createElement("li");
    row.className = `history-row is-${entry.status}`;
    row.dataset.historyRow = entry.id;

    const contextBadge = document.createElement("span");
    contextBadge.className = `history-row-badge is-${entry.context}`;
    contextBadge.textContent = CONTEXT_LABEL[entry.context] ?? entry.context;

    const time = document.createElement("span");
    time.className = "history-row-time";
    time.textContent = formatTime(entry.receivedAtMs);

    const type = document.createElement("span");
    type.className = "history-row-type";
    type.textContent = `${display.icon} ${display.label}`;

    const actor = document.createElement("span");
    actor.className = "history-row-actor";
    actor.textContent = entry.event?.actor?.isAnonymous ? "匿名" : entry.event?.actor?.displayName ?? "";

    const value = document.createElement("span");
    value.className = "history-row-value";
    value.textContent = String(display.value ?? "");

    const resultBadge = document.createElement("span");
    resultBadge.className = `history-row-result is-${entry.status}`;
    resultBadge.textContent = STATUS_LABEL[entry.status] ?? entry.status;

    row.append(contextBadge, time, type, actor, value, resultBadge);

    // "user textを既定折畳み" — a native <details> (keyboard-operable with zero extra JS: Enter/Space
    // on the focused <summary> toggles it) whose content is the SANITIZED (control-char-stripped,
    // length-capped, secret-scrubbed) message — never the raw field, never shown open by default.
    const rawMessage = extractRawMessage(entry.event);
    if (rawMessage) {
      const details = document.createElement("details");
      details.className = "history-row-message";
      const summary = document.createElement("summary");
      summary.textContent = "メッセージを表示";
      const body = document.createElement("p");
      body.textContent = scrub(sanitizeInlineText(rawMessage));
      details.append(summary, body);
      row.append(details);
    }

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.dataset.historyRowOpen = entry.id;
    openButton.textContent = "詳細 (trace)";
    openButton.addEventListener("click", () => this.#openTrace(entry.id));
    row.append(openButton);

    return row;
  }

  render(root) {
    if (!root || !this.document?.createElement) return;
    this.root = root;
    const document = this.document;
    root.replaceChildren();
    this.connect();

    const heading = document.createElement("h2");
    heading.textContent = "Event History";
    root.append(heading);

    // The live region node (and its announcer) is created ONCE and REUSED across every render() —
    // never recreated — because createLiveAnnouncer()'s announcement is deferred a microtask (see
    // src/settings/a11y/live-region.js), and this view's own render() fully rebuilds `root` via
    // replaceChildren() on every call (including the one #performClear() itself triggers right
    // after announcing "N件削除しました"); a freshly `createElement()`-ed region on every render
    // would silently discard any announcement still in flight on the previous (now-detached) node.
    if (!this.liveRegion) {
      this.liveRegion = document.createElement("p");
      this.liveRegion.className = "sr-only";
      this.liveRegion.setAttribute("aria-live", "polite");
      this.announcer = createLiveAnnouncer(this.liveRegion);
    }
    root.append(this.liveRegion);

    if (this.selectedEntryId) {
      const entry = this.store.get(this.selectedEntryId);
      const drawerRoot = document.createElement("div");
      renderTriggerTraceDrawer(drawerRoot, entry, { getConfig: this.getConfig, onClose: () => this.#closeTrace() }, document);
      const closeButton = drawerRoot.querySelector?.("button");
      if (closeButton) closeButton.dataset.traceDrawerClose = "true";
      root.append(drawerRoot);
      this.#restorePendingFocus(root);
      return;
    }

    root.append(this.#renderFilterControls(document, root));
    if (this.confirmClear) root.append(this.#renderClearConfirm(document, root));

    const keys = (() => {
      try {
        return collectApiKeys(this.getConfig?.() ?? {});
      } catch {
        return [];
      }
    })();
    const scrub = (text) => scrubSecrets(text ?? "", keys);

    const filtered = filterHistoryEntries(this.store.list(), this.filters).slice().reverse();
    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "条件に一致する履歴はありません";
      root.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "history-row-list";
      for (const entry of filtered) list.append(this.#renderRow(document, entry, scrub));
      root.append(list);
    }

    const stats = this.store.stats();
    const statsLine = document.createElement("p");
    statsLine.className = "muted history-stats";
    statsLine.textContent = `合計 ${stats.size}/${stats.maxEntries}件 (本番 ${stats.production}件 / シミュレーション ${stats.simulation}件)`;
    root.append(statsLine);

    this.#restorePendingFocus(root);
  }

  #restorePendingFocus(root) {
    if (!this.pendingFocusSelector) return;
    const target = root.querySelector(this.pendingFocusSelector);
    this.pendingFocusSelector = null;
    target?.focus?.();
  }
}
