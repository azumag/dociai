const speechLabels = { waiting: "待機", speaking: "発話中", done: "完了", submitted: "送信済", skipped: "スキップ", cancelled: "取消", dropped: "破棄", failed: "失敗" };

export class ConsoleView {
  constructor(document) { this.document = document; }
  element(selector) {
    const element = this.document.querySelector(selector);
    if (!element) throw new Error(`Required DOM element is missing: ${selector}`);
    return element;
  }
  appendSystemLog({ message, level, time }) {
    const li = this.document.createElement("li");
    if (level === "error") li.className = "is-error";
    if (level === "warn") li.className = "is-warn";
    li.innerHTML = `<span class="time">${time}</span>`;
    li.append(message);
    const log = this.element("#event-log");
    log.prepend(li);
    while (log.children.length > 200) log.lastChild.remove();
  }
  appendReply(model) {
    const li = this.document.createElement("li");
    li.className = `reply-item${model.error ? " is-error" : ""}`;
    li.style.setProperty("--persona-color", model.color);
    const head = this.document.createElement("div");
    head.className = "reply-head";
    head.innerHTML = `<span class="persona-name"></span><span class="time">${model.time}</span><span>trigger: ${model.triggerId}</span>`;
    head.querySelector(".persona-name").textContent = model.personaName;
    if (model.contentLabel && model.contentTitle) {
      const detail = this.document.createElement("span");
      detail.textContent = `${model.contentLabel}: ${model.contentTitle.slice(0, 24)}`;
      head.append(detail);
    }
    const body = this.document.createElement("div");
    body.className = "reply-text";
    body.textContent = model.error ? `応答失敗: ${model.error}` : model.text;
    li.append(head, body);
    const log = this.element("#reply-log");
    log.prepend(li);
    while (log.children.length > 80) log.lastChild.remove();
  }
  renderConfig(model) {
    const element = this.element("#config-status");
    element.textContent = model.loaded ? `設定: 読込済 (${model.source} ${model.time})` : "設定: 未読込";
    element.className = `chip ${model.loaded ? "is-ok" : "is-warn"}`;
  }
  renderTally(personas) {
    const tally = this.element("#tally"); tally.replaceChildren();
    for (const persona of personas) {
      const lamp = this.document.createElement("span");
      lamp.className = `tally-lamp is-${persona.state}`;
      lamp.title = { off: "無効", ready: "待機", thinking: "思考中", speaking: "発話中" }[persona.state];
      const dot = this.document.createElement("span"); dot.className = "dot";
      lamp.append(dot, persona.name); tally.append(lamp);
    }
  }
  renderConnectors(connectors) {
    const list = this.element("#connector-list"); list.replaceChildren();
    for (const connector of connectors) {
      const li = this.document.createElement("li");
      li.innerHTML = `<div class="grow"><div class="name"></div><div class="detail"></div></div>`;
      li.querySelector(".name").textContent = connector.id;
      li.querySelector(".detail").textContent = `${connector.provider} / ${connector.model} / key: ${connector.apiKeyMasked}`;
      list.append(li);
    }
    if (!list.children.length) list.innerHTML = `<li class="detail">設定を読み込むと表示されます</li>`;
    const failed = connectors.filter((connector) => connector.apiKeyMasked === "(初期化失敗)").length;
    this.element("#connector-summary").textContent = connectors.length ? `${connectors.length}件${failed ? ` · 要確認 ${failed}` : ""}` : "未設定";
  }
  renderPersonas(personas, actions) {
    const list = this.element("#persona-list"); list.replaceChildren();
    for (const persona of personas) {
      const li = this.document.createElement("li");
      const dot = this.document.createElement("span"); dot.className = `persona-dot is-${persona.state}`; dot.style.background = persona.dotColor;
      const grow = this.document.createElement("div"); grow.className = "grow"; grow.innerHTML = `<div class="name"></div><div class="detail"></div>`;
      grow.querySelector(".name").textContent = persona.name; grow.querySelector(".detail").textContent = persona.detail;
      const switchLabel = this.document.createElement("label"); switchLabel.className = "switch"; switchLabel.title = "ペルソナのON/OFF";
      const checkbox = this.document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = persona.enabled;
      checkbox.addEventListener("change", () => actions.setPersonaEnabled(persona.id, checkbox.checked));
      const track = this.document.createElement("span"); track.className = "track"; switchLabel.append(checkbox, track);
      const fire = this.document.createElement("button"); fire.type = "button"; fire.textContent = "発話"; fire.title = "このペルソナを手動で発話させる";
      fire.addEventListener("click", () => actions.firePersona(persona.id));
      li.append(dot, grow, switchLabel, fire); list.append(li);
    }
    if (!list.children.length) list.innerHTML = `<li class="detail">設定を読み込むと表示されます</li>`;
    const enabled = personas.filter((persona) => persona.enabled).length;
    const active = personas.filter((persona) => persona.state === "speaking" || persona.state === "thinking").length;
    this.element("#persona-summary").textContent = personas.length ? `有効 ${enabled}/${personas.length}${active ? ` · 稼働中 ${active}` : ""}` : "未設定";
  }
  renderTriggers(triggers, actions) {
    const list = this.element("#trigger-list"); list.replaceChildren();
    for (const trigger of triggers) {
      const li = this.document.createElement("li");
      const badge = this.document.createElement("span"); badge.className = "badge"; badge.textContent = trigger.type;
      const grow = this.document.createElement("div"); grow.className = "grow"; grow.innerHTML = `<div class="name"></div><div class="detail"></div>`;
      grow.querySelector(".name").textContent = trigger.id; grow.querySelector(".detail").textContent = trigger.detail;
      const fire = this.document.createElement("button"); fire.type = "button"; fire.textContent = "発火"; fire.addEventListener("click", () => actions.fireTrigger(trigger.id));
      li.append(badge, grow, fire); list.append(li);
    }
    if (!list.children.length) list.innerHTML = `<li class="detail">設定を読み込むと表示されます</li>`;
    const unused = triggers.filter((trigger) => trigger.unused).length;
    this.element("#trigger-summary").textContent = triggers.length ? `${triggers.length}件${unused ? ` · 未使用 ${unused}` : ""}` : "未設定";
  }
  renderSpeech(model) {
    const renderItems = (selector, items, empty) => {
      const list = this.element(selector); list.replaceChildren();
      for (const item of items) {
        const li = this.document.createElement("li");
        const badge = this.document.createElement("span"); badge.className = `badge state-${item.state}`; badge.textContent = speechLabels[item.state] ?? item.state;
        const grow = this.document.createElement("div"); grow.className = "grow"; grow.innerHTML = `<div class="detail"></div>`;
        grow.querySelector(".detail").textContent = `${item.personaName}: ${item.text.slice(0, 60)}${item.error ? ` (${item.error})` : ""}`;
        li.append(badge, grow); list.append(li);
      }
      if (!items.length) list.innerHTML = `<li class="detail">${empty}</li>`;
    };
    this.element("#speech-current").textContent = model.current ? `${model.current.personaName}: ${model.current.text}` : "再生中なし";
    renderItems("#speech-pending", model.pending, "待機なし");
    this.element("#speech-diagnostics").textContent = model.diagnostics;
    const chip = this.element("#speech-state"); chip.textContent = model.status; chip.className = model.statusClass;
  }
  renderComments(comments) {
    const list = this.element("#comment-log"); list.replaceChildren();
    for (const comment of comments) {
      const li = this.document.createElement("li"); li.innerHTML = `<span class="time">${comment.time}</span><span class="author"></span>`;
      li.querySelector(".author").textContent = comment.author; li.append(comment.text);
      if (comment.speechState) {
        const badge = this.document.createElement("span");
        badge.className = `badge state-${comment.speechState}`;
        badge.textContent = speechLabels[comment.speechState] ?? comment.speechState;
        li.append(badge);
      }
      list.append(li);
    }
  }
  renderDebug(model) {
    this.element("#debug-meta").textContent = model.meta;
    this.element("#debug-prompt").textContent = model.text;
  }
}
