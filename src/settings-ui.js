// 設定UIエディタ (issue #15)
// connectors / personas / triggers / context(screenCapture) / voicevox / news / commentSources を
// UIから追加・編集・削除できる。編集した設定はメモリ上の draft に保持し、「適用」で onApply(config)。
// APIキーは localStorage/sessionStorage には書かない (issue #13)。エクスポートはユーザー操作で
// ファイルダウンロードのみ。
//
// 設計: 各入力に input/change リスナーを付け、draft を直接更新する。タブ切替・追加・削除の
// ときだけ再描画する (入力フォーカスは失われるが、入力値は draft に反映済みなので保持される)。

import { validateConfig } from "./config-loader.js";

const PROVIDERS = ["openai", "openrouter", "openai-compatible", "ollama", "minimax", "mock"];
const TRIGGER_TYPES = ["keyword", "hotkey", "interval", "random", "manual"];
const VOICE_ENGINES = ["webspeech", "voicevox"];
const NEWS_MODES = ["topic", "current", "simple"];
const NEWS_SOURCE_TYPES = ["rss", "mock"];

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

export class SettingsUI {
  constructor({ getCurrent = () => null, onApply = () => {}, log = () => {} } = {}) {
    this.getCurrent = getCurrent;
    this.onApply = onApply;
    this.log = log;
    this.draft = null;
    this.activeTab = "connectors";
    this.root = null;
    this._built = false;
  }

  open() {
    const current = this.getCurrent();
    if (!current) {
      this.log("設定を読み込んでから編集してください", "warn");
      return;
    }
    this.draft = clone(current);
    this.activeTab = "connectors";
    this.#ensureBuilt();
    this.#render();
    if (!this.root.open) this.root.showModal();
  }

  close() {
    if (this.root?.open) this.root.close();
  }

  #ensureBuilt() {
    if (this._built) return;
    const dlg = document.createElement("dialog");
    dlg.className = "settings-modal";
    this.root = dlg;
    document.body.append(dlg);
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) this.close();
    });

    const header = document.createElement("header");
    header.className = "settings-header";
    header.innerHTML = `<h2>設定エディタ</h2>`;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());
    header.append(closeBtn);

    const nav = document.createElement("nav");
    nav.className = "settings-tabs";
    const tabs = [
      ["connectors", "コネクタ"],
      ["personas", "ペルソナ"],
      ["triggers", "トリガー"],
      ["context", "画面・文脈"],
      ["voicevox", "VOICEVOX"],
      ["news", "ニュース"],
      ["sources", "コメントソース"],
    ];
    for (const [id, label] of tabs) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.tab = id;
      b.textContent = label;
      b.addEventListener("click", () => {
        this.activeTab = id;
        this.#render();
      });
      nav.append(b);
    }

    const body = document.createElement("div");
    body.className = "settings-body";

    const footer = document.createElement("footer");
    footer.className = "settings-footer";
    const errors = document.createElement("div");
    errors.className = "settings-errors";
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.textContent = "JSONエクスポート";
    exportBtn.addEventListener("click", () => this.#export());
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "キャンセル";
    cancelBtn.addEventListener("click", () => this.close());
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "primary";
    applyBtn.textContent = "適用して再読込";
    applyBtn.addEventListener("click", () => this.#apply());
    footer.append(errors, spacer, exportBtn, cancelBtn, applyBtn);

    dlg.append(header, nav, body, footer);
    this._body = body;
    this._errors = errors;
    this._built = true;
  }

  #render() {
    for (const b of this.root.querySelectorAll(".settings-tabs button")) {
      b.classList.toggle("is-active", b.dataset.tab === this.activeTab);
    }
    this._body.replaceChildren();
    const tab = this.activeTab;
    if (tab === "connectors") this.#renderConnectors();
    else if (tab === "personas") this.#renderPersonas();
    else if (tab === "triggers") this.#renderTriggers();
    else if (tab === "context") this.#renderContext();
    else if (tab === "voicevox") this.#renderVoicevox();
    else if (tab === "news") this.#renderNews();
    else if (tab === "sources") this.#renderSources();
    this._body.scrollTop = 0;
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
  // path 経由で draft に書き込む入力
  #pathField(label, path, { type = "text", value = "", placeholder = "", attrs = {}, csv = false, textarea = false, rows = 3 } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    let input;
    if (textarea) {
      input = document.createElement("textarea");
      input.rows = rows;
    } else {
      input = document.createElement("input");
      input.type = type;
    }
    input.value = value ?? "";
    if (placeholder) input.placeholder = placeholder;
    for (const [k, v] of Object.entries(attrs)) input[k] = v;
    const handler = () => {
      let v = input.value;
      if (type === "number") v = v === "" ? null : Number(v);
      if (csv) v = v.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
      this.#setPath(this.draft, path, v);
    };
    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
    wrap.append(lab, input);
    return wrap;
  }

  #pathSelect(label, options, path, { value = "" } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    const sel = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.append(o);
    }
    sel.value = value ?? "";
    sel.addEventListener("change", () => this.#setPath(this.draft, path, sel.value || null));
    wrap.append(lab, sel);
    return wrap;
  }

  #pathCheckbox(label, path, { value = false } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field field-inline";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.addEventListener("change", () => this.#setPath(this.draft, path, cb.checked));
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    wrap.append(cb, lab);
    return wrap;
  }

  // リスト要素のフィールド (オブジェクトマップ版)。onChange で setter 呼び出し。
  #mapField(label, mapName, key, field, { type = "text", value = "", attrs = {} } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.value = value ?? "";
    for (const [k, v] of Object.entries(attrs)) input[k] = v;
    input.addEventListener("input", () => {
      let v = input.value;
      if (type === "number") v = v === "" ? null : Number(v);
      if (field === "__id__") {
        this.#renameMapKey(mapName, key, v || key);
      } else {
        this.draft[mapName][key][field] = v;
      }
    });
    wrap.append(lab, input);
    return wrap;
  }

  #mapSelect(label, options, mapName, key, field, { value = "" } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    const sel = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.append(o);
    }
    sel.value = value ?? "";
    sel.addEventListener("change", () => {
      this.draft[mapName][key][field] = sel.value;
      if (field === "type") this.#render(); // type 別フィールド再描画
    });
    wrap.append(lab, sel);
    return wrap;
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
    }
    this.#render();
  }

  // 配列要素のフィールド (personas, news.sources)
  #arrField(label, arrPath, index, field, { type = "text", value = "", attrs = {}, textarea = false, rows = 3 } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    let input;
    if (textarea) {
      input = document.createElement("textarea");
      input.rows = rows;
    } else {
      input = document.createElement("input");
      input.type = type;
    }
    input.value = value ?? "";
    for (const [k, v] of Object.entries(attrs)) input[k] = v;
    input.addEventListener("input", () => {
      const arr = this.#getArr(arrPath);
      let v = input.value;
      if (type === "number") v = v === "" ? null : Number(v);
      this.#setPath(arr[index], field, v);
    });
    wrap.append(lab, input);
    return wrap;
  }

  #arrSelect(label, options, arrPath, index, field, { value = "" } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    const sel = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      sel.append(o);
    }
    sel.value = value ?? "";
    sel.addEventListener("change", () => {
      const arr = this.#getArr(arrPath);
      this.#setPath(arr[index], field, sel.value);
      this.#render();
    });
    wrap.append(lab, sel);
    return wrap;
  }

  #arrCheckbox(label, arrPath, index, field, { value = false } = {}) {
    const wrap = document.createElement("label");
    wrap.className = "field field-inline";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!value;
    cb.addEventListener("change", () => {
      const arr = this.#getArr(arrPath);
      this.#setPath(arr[index], field, cb.checked);
    });
    const lab = document.createElement("span");
    lab.className = "field-label";
    lab.textContent = label;
    wrap.append(cb, lab);
    return wrap;
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
      b.textContent = "+ 追加";
      b.addEventListener("click", onAdd);
      h.append(b);
    }
    return h;
  }

  #removeBtn(onRemove, label = "削除") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "danger";
    b.textContent = label;
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
      this.#render();
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
      const card = document.createElement("div");
      card.className = "card";
      const idRow = document.createElement("div");
      idRow.className = "card-row";
      idRow.append(this.#mapField("ID", "connectors", id, "__id__", { value: id, attrs: { spellcheck: "false" } }));
      idRow.append(this.#removeBtn(() => {
        delete this.draft.connectors[id];
        // 参照を外す
        for (const p of this.draft.personas ?? []) {
          if (p.connector === id) p.connector = "";
        }
        if (this.draft.context?.screenCapture?.connector === id) this.draft.context.screenCapture.connector = "";
        this.#render();
      }));
      card.append(idRow);
      const fields = document.createElement("div");
      fields.className = "card-grid";
      fields.append(this.#mapSelect("provider", PROVIDERS, "connectors", id, "provider", { value: c.provider }));
      fields.append(this.#mapField("model", "connectors", id, "model", { value: c.model ?? "", attrs: { spellcheck: "false" } }));
      fields.append(this.#mapField("apiKey", "connectors", id, "apiKey", { value: c.apiKey ?? "", attrs: { spellcheck: "false", autocomplete: "off" } }));
      fields.append(this.#mapField("baseUrl", "connectors", id, "baseUrl", { value: c.baseUrl ?? "", attrs: { spellcheck: "false" } }));
      fields.append(this.#mapField("timeoutMs", "connectors", id, "timeoutMs", { type: "number", value: c.timeoutMs ?? "" }));
      card.append(fields);
      body.append(card);
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
      this.#render();
    }));
    const connectorIds = Object.keys(this.draft.connectors ?? {});
    const triggerIds = Object.keys(this.draft.triggers ?? {});
    for (const [i, p] of (this.draft.personas ?? []).entries()) {
      const card = document.createElement("div");
      card.className = "card";
      const top = document.createElement("div");
      top.className = "card-row";
      top.append(this.#arrField("ID", "personas", i, "id", { value: p.id, attrs: { spellcheck: "false" } }));
      top.append(this.#arrField("表示名", "personas", i, "name", { value: p.name }));
      top.append(this.#arrCheckbox("有効", "personas", i, "enabled", { value: p.enabled }));
      top.append(this.#removeBtn(() => {
        this.draft.personas.splice(i, 1);
        this.#render();
      }));
      card.append(top);
      const grid = document.createElement("div");
      grid.className = "card-grid";
      grid.append(this.#arrSelect("connector", connectorIds, "personas", i, "connector", { value: p.connector }));
      card.append(grid);
      card.append(this.#arrField("systemPrompt", "personas", i, "systemPrompt", { value: p.systemPrompt ?? "", textarea: true, rows: 3 }));
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
      card.append(trigWrap);
      // voice
      const v = p.voice ?? {};
      const voiceHead = document.createElement("h4");
      voiceHead.textContent = "voice";
      card.append(voiceHead);
      const voiceGrid = document.createElement("div");
      voiceGrid.className = "card-grid";
      voiceGrid.append(this.#arrCheckbox("voice.enabled", "personas", i, "voice.enabled", { value: v.enabled }));
      voiceGrid.append(this.#arrSelect("voice.engine", VOICE_ENGINES, "personas", i, "voice.engine", { value: v.engine ?? "webspeech" }));
      voiceGrid.append(this.#arrField("voice.name (webspeech)", "personas", i, "voice.name", { value: v.name ?? "" }));
      voiceGrid.append(this.#arrField("voice.speaker (voicevox)", "personas", i, "voice.speaker", { type: "number", value: v.speaker ?? "" }));
      voiceGrid.append(this.#arrField("voice.rate / speed", "personas", i, "voice.rate", { type: "number", value: v.rate ?? v.speed ?? "" }));
      voiceGrid.append(this.#arrField("voice.pitch", "personas", i, "voice.pitch", { type: "number", value: v.pitch ?? "" }));
      voiceGrid.append(this.#arrField("voice.intonation", "personas", i, "voice.intonation", { type: "number", value: v.intonation ?? "" }));
      voiceGrid.append(this.#arrField("voice.volume", "personas", i, "voice.volume", { type: "number", value: v.volume ?? "" }));
      card.append(voiceGrid);
      body.append(card);
    }
  }

  // ---- triggers ----
  #renderTriggers() {
    const body = this._body;
    body.append(this.#listHeader("トリガー", () => {
      let i = 1;
      while (this.draft.triggers[`new_trigger_${i}`]) i++;
      this.draft.triggers[`new_trigger_${i}`] = { type: "manual" };
      this.#render();
    }));
    for (const [id, t] of Object.entries(this.draft.triggers ?? {})) {
      const card = document.createElement("div");
      card.className = "card";
      const top = document.createElement("div");
      top.className = "card-row";
      top.append(this.#mapField("ID", "triggers", id, "__id__", { value: id, attrs: { spellcheck: "false" } }));
      top.append(this.#removeBtn(() => {
        delete this.draft.triggers[id];
        for (const p of this.draft.personas ?? []) {
          p.triggers = (p.triggers ?? []).filter((x) => x !== id);
        }
        if (this.draft.news?.trigger === id) this.draft.news.trigger = "";
        this.#render();
      }));
      card.append(top);
      card.append(this.#mapSelect("type", TRIGGER_TYPES, "triggers", id, "type", { value: t.type }));
      if (t.type === "keyword") {
        card.append(this.#mapField("keywords (カンマ区切り)", "triggers", id, "keywords", { value: (t.keywords ?? []).join(", ") }));
        // keywords は配列。入力時に配列へ変換するため専用ハンドラに差し替え
        const inp = card.querySelector("input:last-of-type");
        inp.addEventListener("input", () => {
          this.draft.triggers[id].keywords = inp.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
        });
      } else if (t.type === "hotkey") {
        card.append(this.#mapField("keys (例: Alt+1)", "triggers", id, "keys", { value: t.keys ?? "", attrs: { spellcheck: "false" } }));
      } else if (t.type === "interval") {
        const g = document.createElement("div");
        g.className = "card-grid";
        g.append(this.#mapField("minutes", "triggers", id, "minutes", { type: "number", value: t.minutes ?? "" }));
        g.append(this.#mapField("seconds", "triggers", id, "seconds", { type: "number", value: t.seconds ?? "" }));
        card.append(g);
      } else if (t.type === "random") {
        card.append(this.#mapField("probability (0-1)", "triggers", id, "probability", { type: "number", value: t.probability ?? "" }));
      }
      body.append(card);
    }
  }

  // ---- context / screenCapture / router ----
  #renderContext() {
    const body = this._body;
    const connectorIds = Object.keys(this.draft.connectors ?? {});
    const sc = this.draft.context?.screenCapture ?? {};
    const ctx = this.draft.context ?? {};
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("h3");
    h.textContent = "画面キャプチャ (vision_model)";
    card.append(h);
    card.append(this.#pathCheckbox("screenCapture.enabled", "context.screenCapture.enabled", { value: sc.enabled }));
    card.append(this.#pathSelect("screenCapture.connector", ["", ...connectorIds], "context.screenCapture.connector", { value: sc.connector ?? "" }));
    const g = document.createElement("div");
    g.className = "card-grid";
    g.append(this.#pathField("maxAgeSeconds", "context.screenCapture.maxAgeSeconds", { type: "number", value: sc.maxAgeSeconds ?? 120 }));
    g.append(this.#pathField("maxTokens", "context.screenCapture.maxTokens", { type: "number", value: sc.maxTokens ?? 768 }));
    g.append(this.#pathField("commentHistoryLimit", "context.commentHistoryLimit", { type: "number", value: ctx.commentHistoryLimit ?? 80 }));
    g.append(this.#pathField("includeRecentComments", "context.includeRecentComments", { type: "number", value: ctx.includeRecentComments ?? 20 }));
    g.append(this.#pathField("maxPromptChars", "context.maxPromptChars", { type: "number", value: ctx.maxPromptChars ?? 4000 }));
    card.append(g);
    body.append(card);

    const rcard = document.createElement("div");
    rcard.className = "card";
    const rh = document.createElement("h3");
    rh.textContent = "router";
    rcard.append(rh);
    const rg = document.createElement("div");
    rg.className = "card-grid";
    rg.append(this.#pathSelect("defaultPersona", (this.draft.personas ?? []).map((p) => p.id), "router.defaultPersona", { value: this.draft.router?.defaultPersona ?? "" }));
    rg.append(this.#pathField("maxRepliesPerComment", "router.maxRepliesPerComment", { type: "number", value: this.draft.router?.maxRepliesPerComment ?? 1 }));
    rg.append(this.#pathField("cooldownSeconds", "router.cooldownSeconds", { type: "number", value: this.draft.router?.cooldownSeconds ?? 8 }));
    rcard.append(rg);
    body.append(rcard);
  }

  // ---- voicevox ----
  #renderVoicevox() {
    const body = this._body;
    const v = this.draft.voicevox ?? {};
    const card = document.createElement("div");
    card.className = "card";
    card.append(this.#pathCheckbox("voicevox.enabled", "voicevox.enabled", { value: v.enabled }));
    const g = document.createElement("div");
    g.className = "card-grid";
    g.append(this.#pathField("baseUrl", "voicevox.baseUrl", { value: v.baseUrl ?? "http://127.0.0.1:50021", attrs: { spellcheck: "false" } }));
    g.append(this.#pathField("defaultSpeaker", "voicevox.defaultSpeaker", { type: "number", value: v.defaultSpeaker ?? 3 }));
    g.append(this.#pathField("maxChars", "voicevox.maxChars", { type: "number", value: v.maxChars ?? 200 }));
    g.append(this.#pathField("timeoutMs", "voicevox.timeoutMs", { type: "number", value: v.timeoutMs ?? 30000 }));
    card.append(g);
    body.append(card);
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "話者IDは engine の /speakers の style id (例: 3 = ずんだもん ノーマル)。CORS は engine が localhost 系 Origin を許可する既定で通ります。";
    body.append(note);
  }

  // ---- news ----
  #renderNews() {
    const body = this._body;
    const n = this.draft.news ?? { enabled: false, sources: [], mode: "topic" };
    if (!this.draft.news) this.draft.news = n;
    const triggerIds = Object.keys(this.draft.triggers ?? {});
    const personaIds = (this.draft.personas ?? []).map((p) => p.id);
    const card = document.createElement("div");
    card.className = "card";
    card.append(this.#listHeader("ニュース", null));
    const g = document.createElement("div");
    g.className = "card-grid";
    g.append(this.#pathCheckbox("news.enabled", "news.enabled", { value: n.enabled }));
    g.append(this.#pathSelect("trigger", ["", ...triggerIds], "news.trigger", { value: n.trigger ?? "" }));
    g.append(this.#pathSelect("persona", ["", ...personaIds], "news.persona", { value: n.persona ?? "" }));
    g.append(this.#pathSelect("mode", NEWS_MODES, "news.mode", { value: n.mode ?? "topic" }));
    g.append(this.#pathField("maxItems", "news.maxItems", { type: "number", value: n.maxItems ?? 3 }));
    g.append(this.#pathCheckbox("dedupe", "news.dedupe", { value: n.dedupe ?? true }));
    card.append(g);
    card.append(this.#pathField("corsProxy", "news.corsProxy", { value: n.corsProxy ?? "", attrs: { spellcheck: "false" } }));
    card.append(this.#pathField("style", "news.style", { value: n.style ?? "", textarea: true, rows: 2 }));
    body.append(card);

    body.append(this.#listHeader("ニュースソース", () => {
      this.draft.news.sources.push({ name: "新規ソース", type: "rss", url: "", enabled: true });
      this.#render();
    }));
    for (const [i, s] of (n.sources ?? []).entries()) {
      const c = document.createElement("div");
      c.className = "card";
      const top = document.createElement("div");
      top.className = "card-row";
      top.append(this.#arrField("name", "news.sources", i, "name", { value: s.name ?? "" }));
      top.append(this.#arrCheckbox("enabled", "news.sources", i, "enabled", { value: s.enabled ?? true }));
      top.append(this.#removeBtn(() => {
        this.draft.news.sources.splice(i, 1);
        this.#render();
      }));
      c.append(top);
      const g2 = document.createElement("div");
      g2.className = "card-grid";
      g2.append(this.#arrSelect("type", NEWS_SOURCE_TYPES, "news.sources", i, "type", { value: s.type ?? "rss" }));
      g2.append(this.#arrField("url", "news.sources", i, "url", { value: s.url ?? "", attrs: { spellcheck: "false" } }));
      c.append(g2);
      body.append(c);
    }
  }

  // ---- comment sources ----
  #renderSources() {
    const body = this._body;
    const t = this.draft.commentSources?.twitch ?? { enabled: false, channels: [] };
    if (!this.draft.commentSources) this.draft.commentSources = { twitch: t };
    if (!this.draft.commentSources.twitch) this.draft.commentSources.twitch = t;
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("h3");
    h.textContent = "Twitch";
    card.append(h);
    card.append(this.#pathCheckbox("twitch.enabled", "commentSources.twitch.enabled", { value: t.enabled }));
    const channelsInput = this.#pathField("channels (カンマ区切り)", "commentSources.twitch.channels", { value: (t.channels ?? []).join(", "), attrs: { spellcheck: "false" } });
    // channels は配列。入力時に配列へ変換
    const inp = channelsInput.querySelector("input");
    inp.addEventListener("input", () => {
      this.draft.commentSources.twitch.channels = inp.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean);
    });
    card.append(channelsInput);
    card.append(this.#pathField("nick (省略可)", "commentSources.twitch.nick", { value: t.nick ?? "", attrs: { spellcheck: "false" } }));
    card.append(this.#pathField("url (省略可)", "commentSources.twitch.url", { value: t.url ?? "", attrs: { spellcheck: "false" } }));
    body.append(card);
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "手動入力は常に有効です。Twitch は読み取り専用なら OAuth 不要です。";
    body.append(note);
  }

  // ---- 適用 / エクスポート ----
  #apply() {
    const { errors, warnings } = validateConfig(this.draft);
    this._errors.replaceChildren();
    if (errors.length) {
      for (const e of errors) {
        const div = document.createElement("div");
        div.className = "settings-error";
        div.textContent = e;
        this._errors.append(div);
      }
      this.log(`設定エディタ: ${errors.length}件のエラーで適用を中止`, "error");
      return;
    }
    for (const w of warnings) this.log(`設定エディタの警告: ${w}`, "warn");
    this.onApply(clone(this.draft));
    this.log("設定をUI編集内容で上書き適用しました");
    this.close();
  }

  #export() {
    const json = JSON.stringify(this.draft, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "config.local.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.log("設定を config.local.json としてエクスポートしました (APIキーを含むため取扱注意)");
  }
}
