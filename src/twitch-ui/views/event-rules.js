// Issue #95: Event Rule editor — the "no more hand-editing eventTriggers JSON" screen. Mounted as a
// new tab inside #94's Twitch Overview shell (views/overview.js's `TAB_LABELS`/`#render()`).
//
// -- Draft model -------------------------------------------------------------------------------
// Mirrors settings-ui.js's own "clone current config into a local draft, edit the draft, only
// `onApplyConfig` on an explicit save" model (see that file's own header comment) — this is NOT a
// live-bound editor over `state.config` (there is no such live store for config in this app; see
// src/app/boot.js's own `state.config`, which is plain, un-reactive mutable state). `EventRulesView`
// keeps its own `#draft` (a `{ [id]: EventTriggerConfig }` deep clone of `config.eventTriggers`)
// for the lifetime of the view instance, so switching to another Twitch Overview tab and back does
// NOT lose in-progress edits — only an explicit "変更を破棄" (discard) or a successful save
// resynchronizes it.
//
// -- Save/validate/reload pipeline -------------------------------------------------------------
// `save()` below calls the SAME `onApplyConfig` callback boot.js already wires into
// SettingsUI as `onApply: (cfg) => applyEditedConfig(cfg)` — i.e. this view goes through
// processConfig() -> validateConfig() -> saveToServer() -> applyLoadedConfig(), EXACTLY the pipeline
// every other settings section uses, never a parallel save path. Client-side validation before that
// call is done with #91's REAL `validateEventTriggersConfig`/`validateEventTriggerConfig`
// (src/triggers/trigger-validation.js) — never a reimplementation of its rules — plus this file's
// own small extra checks for the fields #91 doesn't know about (`cooldown`/`rateLimit`/`aggregation`
// — see this file's own header note in rule-editor.js for why those live at the rule level).
import { createEventTriggerConfig, issue } from "../../triggers/event-trigger-schema.js";
import { validateEventTriggersConfig } from "../../triggers/trigger-validation.js";
import { COOLDOWN_KEY_DIMENSIONS, isValidCooldownKeyBy } from "../../triggers/cooldown-key.js";
import { COOLDOWN_CONSUME_POINTS } from "../../triggers/cooldown-tracker.js";
import { OVERFLOW_POLICIES } from "../../actions/action-rate-limiter.js";
import { SIMULATION_FIXTURE_KINDS, simulateStreamEvent } from "../../simulation/stream-event-simulator.js";
import { navigateToIssue } from "../../settings/settings-navigation.js";
import { movePriority, orderRules, renderRuleList } from "../rules/rule-list.js";
import { renderRuleEditor } from "../rules/rule-editor.js";

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** This file's own small extension of #91/#93's real validators — covers the fields those modules
 * deliberately don't know about (`cooldown`/`rateLimit`/`aggregation` are UI/config-authoring
 * additions this issue introduces). Action validation is already delegated by
 * validateEventTriggersConfig(), so this extension only adds cross-section persona references.
 * Returns the SAME structured-issue shape (`{path, code, message,
 * severity, meta}`) as trigger-validation.js, path-prefixed identically (`["eventTriggers", id,
 * ...]`) so both sources merge into one navigable list. */
function validateExtraRuleFields(id, rule, { personaIds }) {
  const issues = [];
  const prefix = ["eventTriggers", id];
  if (rule.cooldown) {
    if (rule.cooldown.cooldownMs !== undefined && !isPositiveInteger(rule.cooldown.cooldownMs)) {
      issues.push(issue([...prefix, "cooldown", "cooldownMs"], "type.positiveInteger", "cooldown.cooldownMs は正の整数 (ミリ秒) にしてください"));
    }
    if (rule.cooldown.consumeOn !== undefined && !COOLDOWN_CONSUME_POINTS.includes(rule.cooldown.consumeOn)) {
      issues.push(issue([...prefix, "cooldown", "consumeOn"], "enum", "cooldown.consumeOn が不正です", { meta: { options: COOLDOWN_CONSUME_POINTS } }));
    }
    if (rule.cooldown.keyBy !== undefined && !isValidCooldownKeyBy(rule.cooldown.keyBy)) {
      issues.push(issue([...prefix, "cooldown", "keyBy"], "enum", "cooldown.keyBy に不正な次元が含まれています", { meta: { options: COOLDOWN_KEY_DIMENSIONS } }));
    }
  }
  if (rule.rateLimit) {
    if (!isPositiveInteger(rule.rateLimit.windowMs)) issues.push(issue([...prefix, "rateLimit", "windowMs"], "type.positiveInteger", "rateLimit.windowMs は正の整数にしてください"));
    if (!isPositiveInteger(rule.rateLimit.maxActions)) issues.push(issue([...prefix, "rateLimit", "maxActions"], "type.positiveInteger", "rateLimit.maxActions は正の整数にしてください"));
    if (rule.rateLimit.overflowPolicy !== undefined && !OVERFLOW_POLICIES.includes(rule.rateLimit.overflowPolicy)) {
      issues.push(issue([...prefix, "rateLimit", "overflowPolicy"], "enum", "rateLimit.overflowPolicy が不正です", { meta: { options: OVERFLOW_POLICIES } }));
    }
  }
  if (rule.aggregation) {
    if (!isPositiveInteger(rule.aggregation.windowMs)) issues.push(issue([...prefix, "aggregation", "windowMs"], "type.positiveInteger", "aggregation.windowMs は正の整数にしてください"));
    if (rule.aggregation.maxBatchSize !== undefined && !isPositiveInteger(rule.aggregation.maxBatchSize)) {
      issues.push(issue([...prefix, "aggregation", "maxBatchSize"], "type.positiveInteger", "aggregation.maxBatchSize は正の整数にしてください"));
    }
  }
  const actions = Array.isArray(rule.actions) ? rule.actions : [];
  actions.forEach((action, index) => {
    if (action.kind === "ai-response" && action.personaId && !personaIds.includes(action.personaId)) {
      issues.push(issue([...prefix, "actions", index, "personaId"], "reference.missing", `persona "${action.personaId}" が personas に存在しません`, { severity: "warning" }));
    }
  });
  return issues;
}

/** Full validation for the current draft: #91's real `validateEventTriggersConfig` (shape/field/
 * operator/type/condition-depth rules) plus this file's own extra checks above, merged into one
 * flat, path-ordered issue list. Exported standalone for direct unit testing without needing a
 * `EventRulesView` instance. */
export function collectRuleIssues(draftEventTriggers, { personaIds = [] } = {}) {
  const structural = validateEventTriggersConfig(draftEventTriggers);
  const issues = [...structural.issues];
  for (const [id, rule] of Object.entries(draftEventTriggers ?? {})) {
    issues.push(...validateExtraRuleFields(id, rule, { personaIds }));
  }
  return issues;
}

export function groupIssuesByRuleId(issues) {
  const map = {};
  for (const entry of issues) {
    const id = entry.path?.[1];
    if (id === undefined) continue;
    (map[id] ??= []).push(entry);
  }
  return map;
}

/** True iff `issues` contains at least one `severity: "error"` entry — save must be blocked. */
export function hasBlockingIssues(issues) {
  return issues.some((entry) => entry.severity === "error");
}

export class EventRulesView {
  constructor({ document = globalThis.document, getConfig = () => null, onApplyConfig = () => {}, client = null, log = () => {} } = {}) {
    this.document = document;
    this.getConfig = getConfig;
    this.onApplyConfig = onApplyConfig;
    this.client = client;
    this.log = log;
    this.draft = null;
    this.selectedRuleId = null;
    this.rewardsState = { status: "idle", rewards: [], errorCode: null, message: null };
    this.rewardsFetched = false;
    this.testResults = {};
    this.saveStatus = null;
    this.lastIssues = [];
    this.root = null;
    this.pendingFocusSelector = null;
  }

  #ensureDraft() {
    if (this.draft) return;
    const config = this.getConfig();
    this.draft = structuredClone(config?.eventTriggers ?? {});
  }

  /** Discards in-progress edits and re-clones from the current saved config — "変更を破棄" and also
   * used by tests to force a fresh draft. */
  resetDraft() {
    const config = this.getConfig();
    this.draft = structuredClone(config?.eventTriggers ?? {});
    this.selectedRuleId = null;
    this.testResults = {};
    this.saveStatus = null;
  }

  #personaOptions() {
    const personas = this.getConfig()?.personas ?? [];
    return personas.map((persona) => ({ value: persona.id, label: persona.name ?? persona.id }));
  }

  async refreshRewards() {
    if (!this.client) return;
    this.rewardsState = { ...this.rewardsState, status: "loading" };
    try {
      const result = await this.client.rewardsList();
      this.rewardsState = result.ok
        ? { status: "loaded", rewards: result.rewards, errorCode: null, message: null }
        : { status: "error", rewards: this.rewardsState.rewards ?? [], errorCode: result.errorCode, message: result.message };
    } catch (error) {
      this.rewardsState = { status: "error", rewards: this.rewardsState.rewards ?? [], errorCode: "unknown", message: error instanceof Error ? error.message : String(error) };
    }
    if (this.root) this.render(this.root);
  }

  async #runTest(id, fixtureKind) {
    const rule = this.draft[id];
    if (!rule) return;
    const result = await simulateStreamEvent({ fixture: fixtureKind, triggers: [{ ...rule, id }], generation: 0 });
    this.testResults = { ...this.testResults, [id]: { ...result, fixtureKind } };
    if (this.root) this.render(this.root);
  }

  #handleQuickTest(id) {
    const rule = this.draft[id];
    if (!rule) return;
    const fixtureKind = (rule.eventTypes ?? [])[0] ?? SIMULATION_FIXTURE_KINDS[0];
    this.selectedRuleId = id;
    void this.#runTest(id, fixtureKind);
    this.render(this.root);
  }

  #handleCreate() {
    let n = 1;
    while (this.draft[`rule-${n}`]) n += 1;
    const id = `rule-${n}`;
    this.draft[id] = createEventTriggerConfig({ id, eventTypes: [] });
    this.selectedRuleId = id;
    this.pendingFocusSelector = `[data-config-path="eventTriggers.${id}.name"]`;
    this.render(this.root);
  }

  #handleClone(id) {
    const source = this.draft[id];
    if (!source) return;
    let newId = `${id}-copy`;
    let n = 1;
    while (this.draft[newId]) { n += 1; newId = `${id}-copy${n}`; }
    const cloned = structuredClone(source);
    cloned.id = newId;
    if (cloned.name) cloned.name = `${cloned.name} (コピー)`;
    this.draft[newId] = cloned;
    this.selectedRuleId = newId;
    this.pendingFocusSelector = `[data-config-path="eventTriggers.${newId}.name"]`;
    this.render(this.root);
  }

  #handleDelete(id) {
    delete this.draft[id];
    delete this.testResults[id];
    if (this.selectedRuleId === id) this.selectedRuleId = null;
    // "delete/clone/focus restoration" — mirrors settings-ui.js's own `#removeBtn` convention of
    // returning focus to the list's own "add" button after a delete (the deleted row's own button
    // no longer exists to keep focus on).
    this.pendingFocusSelector = '[data-rule-list-add]';
    this.render(this.root);
  }

  #handleRename(oldId, newId) {
    if (!newId || newId === oldId) { this.render(this.root); return; }
    if (this.draft[newId]) { this.log(`ID "${newId}" は既に存在します`, "warn"); this.render(this.root); return; }
    const rebuilt = {};
    for (const [key, value] of Object.entries(this.draft)) {
      if (key === oldId) { value.id = newId; rebuilt[newId] = value; } else rebuilt[key] = value;
    }
    this.draft = rebuilt;
    this.selectedRuleId = newId;
    this.render(this.root);
  }

  /** Public (not `#private`) specifically so a test can `await` a save's full outcome directly —
   * every other handler in this class is private since DOM-click-driven tests can observe their
   * effect synchronously via the rebuilt DOM, but save() is async and its promise isn't otherwise
   * reachable from outside a click event. */
  async save() {
    const issues = collectRuleIssues(this.draft, { personaIds: (this.getConfig()?.personas ?? []).map((p) => p.id) });
    this.lastIssues = issues;
    if (hasBlockingIssues(issues)) {
      this.saveStatus = { kind: "error", message: `${issues.filter((entry) => entry.severity === "error").length}件のエラーがあるため保存できません` };
      this.render(this.root);
      return;
    }
    const config = this.getConfig();
    if (!config) {
      this.saveStatus = { kind: "error", message: "設定が読み込まれていません" };
      this.render(this.root);
      return;
    }
    this.saveStatus = { kind: "saving", message: "保存しています…" };
    this.render(this.root);
    try {
      await this.onApplyConfig({ ...config, eventTriggers: structuredClone(this.draft) });
      this.saveStatus = { kind: "saved", message: "保存して適用しました" };
    } catch (error) {
      this.saveStatus = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    this.render(this.root);
  }

  #renderIssuesPanel(document, issues) {
    if (!issues.length) return null;
    const panel = document.createElement("div");
    panel.className = "rule-issues-panel";
    for (const rawIssue of issues) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `settings-error is-${rawIssue.severity}`;
      button.textContent = `${rawIssue.path.join(".")}: ${rawIssue.message}`;
      button.addEventListener("click", () => {
        const navigable = { ...rawIssue, fieldId: rawIssue.path.join("."), tabId: rawIssue.path[1] };
        const found = navigateToIssue(this.root, navigable, (ruleId) => { this.selectedRuleId = ruleId; this.render(this.root); });
        if (!found) this.log(`該当項目を表示できません: ${navigable.fieldId}`, "warn");
      });
      panel.append(button);
    }
    return panel;
  }

  render(root) {
    if (!root || !this.document?.createElement) return;
    this.root = root;
    this.#ensureDraft();
    if (this.client && !this.rewardsFetched) {
      this.rewardsFetched = true;
      void this.refreshRewards();
    }
    const document = this.document;
    root.replaceChildren();

    const heading = document.createElement("h2");
    heading.textContent = "Event Rule";
    root.append(heading);

    const toolbar = document.createElement("div");
    toolbar.className = "rule-toolbar";
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "btn-primary";
    saveButton.textContent = "保存して適用";
    saveButton.disabled = this.saveStatus?.kind === "saving";
    saveButton.addEventListener("click", () => { void this.save(); });
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.textContent = "変更を破棄";
    discardButton.addEventListener("click", () => { this.resetDraft(); this.render(root); });
    toolbar.append(saveButton, discardButton);
    if (this.saveStatus) {
      const status = document.createElement("span");
      status.className = `rule-save-status is-${this.saveStatus.kind}`;
      status.textContent = this.saveStatus.message;
      toolbar.append(status);
    }
    root.append(toolbar);

    const issues = collectRuleIssues(this.draft, { personaIds: (this.getConfig()?.personas ?? []).map((p) => p.id) });
    this.lastIssues = issues;
    const issuesPanel = this.#renderIssuesPanel(document, issues);
    if (issuesPanel) root.append(issuesPanel);

    const body = document.createElement("div");
    root.append(body);

    if (this.selectedRuleId && this.draft[this.selectedRuleId]) {
      renderRuleEditor(body, this.draft[this.selectedRuleId], {
        id: this.selectedRuleId,
        path: `eventTriggers.${this.selectedRuleId}`,
        personaOptions: this.#personaOptions(),
        rewardsState: this.rewardsState,
        onRefreshRewards: () => { void this.refreshRewards(); },
        onStructuralChange: () => this.render(root),
        onRename: (newId) => this.#handleRename(this.selectedRuleId, newId),
        onClose: () => { this.selectedRuleId = null; this.render(root); },
        onTest: (fixtureKind) => { void this.#runTest(this.selectedRuleId, fixtureKind); },
        testResult: this.testResults[this.selectedRuleId] ?? null,
      }, document);
    } else {
      const issuesByRuleId = groupIssuesByRuleId(issues);
      renderRuleList(body, { rulesById: this.draft, selectedId: this.selectedRuleId, rewardsState: this.rewardsState, issuesByRuleId }, {
        onSelect: (id) => { this.selectedRuleId = id; this.render(root); },
        onCreate: () => this.#handleCreate(),
        onClone: (id) => this.#handleClone(id),
        onDelete: (id) => this.#handleDelete(id),
        onMoveUp: (id) => { movePriority(this.draft, id, "up"); this.render(root); },
        onMoveDown: (id) => { movePriority(this.draft, id, "down"); this.render(root); },
        onToggleEnabled: (id, enabled) => { this.draft[id].enabled = enabled; },
        onTest: (id) => this.#handleQuickTest(id),
      }, document);
    }

    // "delete/clone/focus restoration" — applied synchronously (unlike settings-ui.js's own
    // rAF-deferred `deferFocus`, which needs a real browser's requestAnimationFrame): the DOM is
    // already fully built by this point in the same render() pass, so there is nothing to wait for.
    if (this.pendingFocusSelector) {
      const target = root.querySelector(this.pendingFocusSelector);
      this.pendingFocusSelector = null;
      target?.focus?.();
    }
  }
}

export { orderRules, movePriority };
