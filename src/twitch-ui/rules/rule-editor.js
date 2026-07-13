// Issue #95: the per-rule edit form — "priority/stop propagationを編集" + "cooldown key/seconds/
// consumeOnを編集" + "rate limit/overflow/aggregationを編集" + hosts condition-builder.js/
// action-editor.js + the "test this rule" fixture button. Mutates the live draft rule object in
// place (mirrors condition-builder.js's own convention); `ctx.onStructuralChange()` triggers a full
// re-render for edits that change WHICH controls should show (eventTypes changing the condition
// builder's field options, cooldown/rateLimit/aggregation being toggled on/off).
import { STREAM_EVENT_KINDS } from "../../stream-events/contract.js";
import { COOLDOWN_KEY_DIMENSIONS } from "../../triggers/cooldown-key.js";
import { COOLDOWN_CONSUME_POINTS, DEFAULT_CONSUME_ON } from "../../triggers/cooldown-tracker.js";
import { OVERFLOW_POLICIES, DEFAULT_OVERFLOW_POLICY } from "../../actions/action-rate-limiter.js";
import { SIMULATION_FIXTURE_KINDS } from "../../simulation/stream-event-simulator.js";
import { renderTemplateSpeech } from "../../actions/template-speech-action.js";
import { renderConditionBuilder } from "./condition-builder.js";
import { renderActionList } from "./action-editor.js";

const EVENT_KIND_LABEL = { cheer: "cheer (bits)", subscription: "subscription", resub: "resub", "gift-subscription": "gift-subscription", "reward-redemption": "reward-redemption" };
const COOLDOWN_DIMENSION_LABEL = { actor: "視聴者ごと", reward: "reward ごと", eventType: "event種別ごと" };
const CONSUME_ON_LABEL = { scheduled: "発火が決定した時点", started: "action実行開始時点", completed: "action完了時点" };
const OVERFLOW_LABEL = { drop: "破棄", aggregate: "集約してまとめて応答", "template-only": "テンプレ発話のみ" };

function section(document, titleText) {
  // "card" reuses the existing bordered-panel/title vocabulary (styles/main.css's `.card` +
  // `.card h3, .card h4`) instead of a parallel section style — this box (a title followed by a
  // flat run of fields) is exactly card-shaped, it just doesn't split a card-head/card-body.
  const box = document.createElement("div");
  box.className = "rule-editor-section card";
  const title = document.createElement("h4");
  title.textContent = titleText;
  box.append(title);
  return box;
}

function secondsField(document, { label, ms, path, min = 1, onChange }) {
  const wrap = document.createElement("label");
  wrap.className = "field-inline";
  wrap.append(document.createTextNode(`${label}: `));
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.value = typeof ms === "number" ? Math.round(ms / 1000) : "";
  input.dataset.configPath = path;
  input.addEventListener("input", () => onChange(input.value === "" ? null : Math.max(0, Number(input.value)) * 1000));
  wrap.append(input, document.createTextNode(" 秒"));
  return wrap;
}

function renderEventTypesField(document, rule, path, onStructuralChange) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = "eventTypes";
  wrap.append(label);
  const box = document.createElement("div");
  box.className = "checkbox-group";
  for (const kind of STREAM_EVENT_KINDS) {
    const optionLabel = document.createElement("label");
    optionLabel.className = "chip-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (rule.eventTypes ?? []).includes(kind);
    cb.dataset.configPath = `${path}.eventTypes`;
    cb.addEventListener("change", () => {
      const set = new Set(rule.eventTypes ?? []);
      if (cb.checked) set.add(kind); else set.delete(kind);
      rule.eventTypes = [...set];
      onStructuralChange();
    });
    optionLabel.append(cb, document.createTextNode(EVENT_KIND_LABEL[kind] ?? kind));
    box.append(optionLabel);
  }
  wrap.append(box);
  return wrap;
}

function renderCooldownSection(document, rule, path) {
  const box = section(document, "cooldown");
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "field-inline";
  const enabledCb = document.createElement("input");
  enabledCb.type = "checkbox";
  enabledCb.checked = Boolean(rule.cooldown);
  const body = document.createElement("div");
  body.className = "rule-editor-subfields";
  body.hidden = !rule.cooldown;
  enabledCb.addEventListener("change", () => {
    if (enabledCb.checked) rule.cooldown = rule.cooldown ?? { cooldownMs: 30000, consumeOn: DEFAULT_CONSUME_ON, keyBy: [] };
    else delete rule.cooldown;
    body.hidden = !rule.cooldown;
  });
  enabledLabel.append(enabledCb, document.createTextNode(" cooldownを設定する"));
  box.append(enabledLabel);

  const cooldown = rule.cooldown ?? { cooldownMs: 30000, consumeOn: DEFAULT_CONSUME_ON, keyBy: [] };
  body.append(secondsField(document, { label: "cooldown秒数", ms: cooldown.cooldownMs, path: `${path}.cooldown.cooldownMs`, onChange: (ms) => { rule.cooldown.cooldownMs = ms; } }));

  const consumeSelect = document.createElement("select");
  consumeSelect.dataset.configPath = `${path}.cooldown.consumeOn`;
  for (const point of COOLDOWN_CONSUME_POINTS) {
    const option = document.createElement("option");
    option.value = point;
    option.textContent = `${point}: ${CONSUME_ON_LABEL[point] ?? point}`;
    option.selected = point === (cooldown.consumeOn ?? DEFAULT_CONSUME_ON);
    consumeSelect.append(option);
  }
  consumeSelect.addEventListener("change", () => { rule.cooldown.consumeOn = consumeSelect.value; });
  const consumeLabel = document.createElement("label");
  consumeLabel.className = "field-inline";
  consumeLabel.append(document.createTextNode("consumeOn: "), consumeSelect);
  body.append(consumeLabel);

  const keyByBox = document.createElement("div");
  keyByBox.className = "checkbox-group";
  for (const dim of COOLDOWN_KEY_DIMENSIONS) {
    const optionLabel = document.createElement("label");
    optionLabel.className = "chip-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (cooldown.keyBy ?? []).includes(dim);
    cb.dataset.configPath = `${path}.cooldown.keyBy`;
    cb.addEventListener("change", () => {
      const set = new Set(rule.cooldown.keyBy ?? []);
      if (cb.checked) set.add(dim); else set.delete(dim);
      rule.cooldown.keyBy = [...set];
    });
    optionLabel.append(cb, document.createTextNode(COOLDOWN_DIMENSION_LABEL[dim] ?? dim));
    keyByBox.append(optionLabel);
  }
  const keyByWrap = document.createElement("div");
  keyByWrap.className = "field";
  const keyByLabel = document.createElement("span");
  keyByLabel.className = "field-label";
  keyByLabel.textContent = "keyBy (匿名actorはactor次元で自動的にcooldown対象外になります)";
  keyByWrap.append(keyByLabel, keyByBox);
  body.append(keyByWrap);

  box.append(body);
  return box;
}

function renderRateLimitAndAggregationSection(document, rule, path) {
  const box = section(document, "rate limit / overflow / aggregation");

  const rlEnabledLabel = document.createElement("label");
  rlEnabledLabel.className = "field-inline";
  const rlEnabledCb = document.createElement("input");
  rlEnabledCb.type = "checkbox";
  rlEnabledCb.checked = Boolean(rule.rateLimit);
  const rlBody = document.createElement("div");
  rlBody.className = "rule-editor-subfields";
  rlBody.hidden = !rule.rateLimit;
  rlEnabledCb.addEventListener("change", () => {
    if (rlEnabledCb.checked) rule.rateLimit = rule.rateLimit ?? { windowMs: 60000, maxActions: 5, overflowPolicy: DEFAULT_OVERFLOW_POLICY };
    else delete rule.rateLimit;
    rlBody.hidden = !rule.rateLimit;
  });
  rlEnabledLabel.append(rlEnabledCb, document.createTextNode(" rate limitを設定する"));
  box.append(rlEnabledLabel);

  const rateLimit = rule.rateLimit ?? { windowMs: 60000, maxActions: 5, overflowPolicy: DEFAULT_OVERFLOW_POLICY };
  rlBody.append(secondsField(document, { label: "window", ms: rateLimit.windowMs, path: `${path}.rateLimit.windowMs`, onChange: (ms) => { rule.rateLimit.windowMs = ms; } }));
  const maxActionsLabel = document.createElement("label");
  maxActionsLabel.className = "field-inline";
  const maxActionsInput = document.createElement("input");
  maxActionsInput.type = "number";
  maxActionsInput.min = "1";
  maxActionsInput.value = rateLimit.maxActions ?? 5;
  maxActionsInput.dataset.configPath = `${path}.rateLimit.maxActions`;
  maxActionsInput.addEventListener("input", () => { rule.rateLimit.maxActions = maxActionsInput.value === "" ? null : Number(maxActionsInput.value); });
  maxActionsLabel.append(document.createTextNode("maxActions: "), maxActionsInput);
  rlBody.append(maxActionsLabel);

  const overflowSelect = document.createElement("select");
  overflowSelect.dataset.configPath = `${path}.rateLimit.overflowPolicy`;
  for (const policy of OVERFLOW_POLICIES) {
    const option = document.createElement("option");
    option.value = policy;
    option.textContent = `${policy}: ${OVERFLOW_LABEL[policy] ?? policy}`;
    option.selected = policy === (rateLimit.overflowPolicy ?? DEFAULT_OVERFLOW_POLICY);
    overflowSelect.append(option);
  }
  overflowSelect.addEventListener("change", () => { rule.rateLimit.overflowPolicy = overflowSelect.value; });
  const overflowLabel = document.createElement("label");
  overflowLabel.className = "field-inline";
  overflowLabel.append(document.createTextNode("overflowPolicy: "), overflowSelect);
  rlBody.append(overflowLabel);
  box.append(rlBody);

  const aggEnabledLabel = document.createElement("label");
  aggEnabledLabel.className = "field-inline";
  const aggEnabledCb = document.createElement("input");
  aggEnabledCb.type = "checkbox";
  aggEnabledCb.checked = Boolean(rule.aggregation);
  const aggBody = document.createElement("div");
  aggBody.className = "rule-editor-subfields";
  aggBody.hidden = !rule.aggregation;
  aggEnabledCb.addEventListener("change", () => {
    if (aggEnabledCb.checked) rule.aggregation = rule.aggregation ?? { windowMs: 5000, maxBatchSize: 20 };
    else delete rule.aggregation;
    aggBody.hidden = !rule.aggregation;
  });
  aggEnabledLabel.append(aggEnabledCb, document.createTextNode(" overflowPolicy: aggregate 用の集約windowを設定する"));
  box.append(aggEnabledLabel);

  const aggregation = rule.aggregation ?? { windowMs: 5000, maxBatchSize: 20 };
  aggBody.append(secondsField(document, { label: "集約window", ms: aggregation.windowMs, path: `${path}.aggregation.windowMs`, onChange: (ms) => { rule.aggregation.windowMs = ms; } }));
  const maxBatchLabel = document.createElement("label");
  maxBatchLabel.className = "field-inline";
  const maxBatchInput = document.createElement("input");
  maxBatchInput.type = "number";
  maxBatchInput.min = "1";
  maxBatchInput.value = aggregation.maxBatchSize ?? 20;
  maxBatchInput.dataset.configPath = `${path}.aggregation.maxBatchSize`;
  maxBatchInput.addEventListener("input", () => { rule.aggregation.maxBatchSize = maxBatchInput.value === "" ? null : Number(maxBatchInput.value); });
  maxBatchLabel.append(document.createTextNode("maxBatchSize: "), maxBatchInput);
  aggBody.append(maxBatchLabel);
  box.append(aggBody);

  return box;
}

function renderTestSection(document, rule, ctx) {
  const box = section(document, "テスト実行 (fixtureに対して実行)");
  const fixtureOptions = SIMULATION_FIXTURE_KINDS.filter((kind) => (rule.eventTypes ?? []).includes(kind));
  const select = document.createElement("select");
  const kinds = fixtureOptions.length ? fixtureOptions : SIMULATION_FIXTURE_KINDS;
  for (const [index, kind] of kinds.entries()) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = kind;
    // A native <select> auto-selects its first <option> when none carries `selected` — set it
    // explicitly rather than relying on that implicit browser default, so `select.value` (read by
    // the run button below) is never an empty string.
    option.selected = index === 0;
    select.append(option);
  }
  const runButton = document.createElement("button");
  runButton.type = "button";
  runButton.textContent = "実行";
  runButton.disabled = !select.value;
  runButton.addEventListener("click", () => ctx.onTest?.(select.value));
  box.append(select, runButton);

  if (ctx.testResult) box.append(renderTestResult(document, ctx.testResult));
  return box;
}

/** Renders the last "test this rule" run's result — real `matchEvent()`/`planActions()` output (see
 * views/event-rules.js's own `runRuleTest`), never a synthetic/simplified summary. Action EXECUTION
 * (the actual AI call / speech / OBS publish) is intentionally NOT run by this button — ActionRunner
 * has no wiring into this Renderer-side runtime yet anywhere in this app (ai-response actions
 * currently DO reach the real matcher/planner/pipeline; the template-speech text itself is genuinely
 * PRE-RENDERED below via the real `renderTemplateSpeech()` so a template can be sanity-checked
 * without waiting for a real event) — see this module's own header comment for why. */
export function renderTestResult(document, result) {
  const box = document.createElement("div");
  box.className = "rule-test-result";
  if (!result) return box;
  const matched = result.matches.length > 0;
  const status = document.createElement("p");
  status.className = matched ? "rule-test-status is-match" : "rule-test-status is-no-match";
  status.textContent = matched ? `マッチしました (fixture: ${result.fixtureKind})` : `マッチしませんでした (fixture: ${result.fixtureKind})`;
  box.append(status);

  const detailSource = matched ? result.matches[0] : result.skipped[0];
  if (detailSource?.details?.length) {
    const list = document.createElement("ul");
    list.className = "rule-test-condition-trace";
    for (const detail of detailSource.details) {
      const item = document.createElement("li");
      item.className = detail.passed ? "is-pass" : "is-fail";
      item.textContent = `${detail.field ?? "?"} ${detail.operator ?? "?"} ${JSON.stringify(detail.expected)} — 実際値: ${JSON.stringify(detail.actual)} (${detail.passed ? "一致" : detail.reason ?? "不一致"})`;
      list.append(item);
    }
    box.append(list);
  } else if (detailSource?.reason) {
    const reason = document.createElement("p");
    reason.className = "muted";
    reason.textContent = `理由: ${detailSource.reason}`;
    box.append(reason);
  }

  if (matched) {
    const plans = document.createElement("ul");
    plans.className = "rule-test-plans";
    for (const plan of result.plans) {
      const item = document.createElement("li");
      if (plan.kind === "template-speech") {
        const rendered = renderTemplateSpeech(plan.action.template, result.event);
        item.textContent = `テンプレ発話 → "${rendered.text}"${rendered.unresolvedPlaceholders.length ? ` (未解決placeholder: ${rendered.unresolvedPlaceholders.join(", ")})` : ""}`;
      } else {
        item.textContent = `AI応答 (persona: ${plan.action.personaId ?? "(未選択)"}) — 実際のAI呼び出しはテストでは行いません`;
      }
      plans.append(item);
    }
    for (const skip of result.planSkips) {
      const item = document.createElement("li");
      item.className = "is-fail";
      item.textContent = `action[${skip.actionIndex}] スキップ: ${skip.reason}`;
      plans.append(item);
    }
    box.append(plans);
  }
  return box;
}

/**
 * Renders the full per-rule editor. `ctx`: `{ id, path, personaOptions, rewardsState,
 * onRefreshRewards, onStructuralChange, onRename, onClose, onTest, testResult }`. `path` is the
 * `data-config-path` prefix (`eventTriggers.<id>`), matching trigger-validation.js's own issue path
 * shape.
 */
export function renderRuleEditor(root, rule, ctx, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const { id, path, onStructuralChange, onRename, onClose } = ctx;

  const head = document.createElement("div");
  head.className = "rule-editor-head";
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "← 一覧へ戻る";
  closeButton.addEventListener("click", () => onClose?.());
  head.append(closeButton);
  root.append(head);

  const basics = section(document, "基本設定");
  const idLabel = document.createElement("label");
  idLabel.className = "field-inline";
  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.value = id;
  idInput.dataset.configPath = `${path}.id`;
  idInput.addEventListener("change", () => { if (idInput.value && idInput.value !== id) onRename?.(idInput.value); });
  idLabel.append(document.createTextNode("ID: "), idInput);
  basics.append(idLabel);

  const nameLabel = document.createElement("label");
  nameLabel.className = "field-inline";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = rule.name ?? "";
  nameInput.placeholder = "表示名 (省略可)";
  nameInput.dataset.configPath = `${path}.name`;
  nameInput.addEventListener("input", () => { rule.name = nameInput.value; });
  nameLabel.append(document.createTextNode("name: "), nameInput);
  basics.append(nameLabel);

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "field-inline";
  const enabledInput = document.createElement("input");
  enabledInput.type = "checkbox";
  enabledInput.checked = rule.enabled !== false;
  enabledInput.dataset.configPath = `${path}.enabled`;
  enabledInput.addEventListener("change", () => { rule.enabled = enabledInput.checked; });
  enabledLabel.append(enabledInput, document.createTextNode(" enabled"));
  basics.append(enabledLabel);

  basics.append(renderEventTypesField(document, rule, path, onStructuralChange));

  const priorityLabel = document.createElement("label");
  priorityLabel.className = "field-inline";
  const priorityInput = document.createElement("input");
  priorityInput.type = "number";
  priorityInput.value = rule.priority ?? 0;
  priorityInput.dataset.configPath = `${path}.priority`;
  priorityInput.addEventListener("input", () => { rule.priority = priorityInput.value === "" ? 0 : Number(priorityInput.value); });
  priorityLabel.append(document.createTextNode("priority (高いほど先に評価): "), priorityInput);
  basics.append(priorityLabel);

  const stopLabel = document.createElement("label");
  stopLabel.className = "field-inline";
  const stopInput = document.createElement("input");
  stopInput.type = "checkbox";
  stopInput.checked = rule.stopPropagation === true;
  stopInput.dataset.configPath = `${path}.stopPropagation`;
  stopInput.addEventListener("change", () => { rule.stopPropagation = stopInput.checked; });
  stopLabel.append(stopInput, document.createTextNode(" stopPropagation (マッチしたら以降の低priority ruleを評価しない)"));
  basics.append(stopLabel);
  root.append(basics);

  const conditionSection = section(document, "条件 (condition)");
  const conditionRoot = document.createElement("div");
  renderConditionBuilder(conditionRoot, rule.condition, {
    eventTypes: rule.eventTypes ?? [],
    path: `${path}.condition`,
    onStructuralChange,
    rewardsState: ctx.rewardsState,
    onRefreshRewards: ctx.onRefreshRewards,
  }, document);
  conditionSection.append(conditionRoot);
  root.append(conditionSection);

  root.append(renderCooldownSection(document, rule, path));
  root.append(renderRateLimitAndAggregationSection(document, rule, path));

  const actionsSection = section(document, "action (AI応答 / テンプレ発話)");
  const actionsRoot = document.createElement("div");
  if (!Array.isArray(rule.actions)) rule.actions = [];
  renderActionList(actionsRoot, rule.actions, { path: `${path}.actions`, personaOptions: ctx.personaOptions ?? [], onStructuralChange }, document);
  actionsSection.append(actionsRoot);
  root.append(actionsSection);

  root.append(renderTestSection(document, rule, ctx));
}
