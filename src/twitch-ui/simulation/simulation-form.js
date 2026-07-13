// Issue #96: "fixture typeに応じたschema-driven formを実装" + "safe default: ignore cooldown ON、
// mock AI ON、speech/OBS OFF" + "production AI/speech/OBS利用時に明示確認". Pure `render(root, state,
// callbacks, document)` function, mirroring src/twitch-ui/rules/condition-builder.js's own render
// style — no internal state of its own; views/simulation.js owns the draft/confirmation state.
import { DEFAULT_SIMULATION_OPTIONS, PRODUCTION_EQUIVALENT_OPTIONS } from "../../simulation/stream-event-simulator.js";
import { FIXTURE_KIND_LABEL, SIMULATION_FIXTURE_KINDS, defaultDataForFixtureKind, fieldsForFixtureKind } from "./fixture-registry.js";

/** Coerces a raw `<input>` string value to `field.type`'s real JS type — never a hand-rolled
 * per-field parser, just the SAME 3 value types event-field-registry.js's own registry defines. */
export function coerceFieldValue(type, raw) {
  if (type === "number") return raw === "" ? 0 : Number(raw);
  if (type === "boolean") return raw === true || raw === "true";
  return String(raw ?? "");
}

function fieldLocalKey(fieldKey) {
  return fieldKey.slice("data.".length);
}

/** Builds the `overrides` object `buildFixtureEvent(kind, overrides)` expects, from the form's own
 * `{ actorDisplayName, isAnonymous, data }` draft — merging user-touched values over the fixture's
 * own realistic defaults (`defaultDataForFixtureKind`) so an untouched field still submits a valid
 * value. Exported standalone (pure) for direct unit testing without needing a DOM. */
export function buildOverridesFromDraft(fixtureKind, draft = {}) {
  const overrides = {};
  if (draft.actorDisplayName !== undefined || draft.isAnonymous !== undefined) {
    overrides.actor = {};
    if (draft.actorDisplayName !== undefined) overrides.actor.displayName = draft.actorDisplayName;
    if (draft.isAnonymous !== undefined) overrides.actor.isAnonymous = draft.isAnonymous;
  }
  overrides.data = { ...defaultDataForFixtureKind(fixtureKind), ...(draft.data ?? {}) };
  return overrides;
}

function field(document, { label, input }) {
  const wrap = document.createElement("label");
  wrap.className = "field-inline";
  wrap.append(document.createTextNode(`${label}: `), input);
  return wrap;
}

function renderDataFields(document, fixtureKind, draftData, onFieldChange) {
  const box = document.createElement("div");
  box.className = "simulation-form-fields";
  const defaults = defaultDataForFixtureKind(fixtureKind);
  for (const definition of fieldsForFixtureKind(fixtureKind)) {
    const key = fieldLocalKey(definition.key);
    const current = draftData?.[key] !== undefined ? draftData[key] : defaults[key];
    let input;
    if (definition.type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(current);
      input.addEventListener("change", () => onFieldChange(key, coerceFieldValue("boolean", input.checked)));
    } else if (definition.type === "number") {
      input = document.createElement("input");
      input.type = "number";
      input.value = current ?? 0;
      input.addEventListener("input", () => onFieldChange(key, coerceFieldValue("number", input.value)));
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = current ?? "";
      input.addEventListener("input", () => onFieldChange(key, coerceFieldValue("string", input.value)));
    }
    input.dataset.simulationField = key;
    box.append(field(document, { label: definition.key, input }));
  }
  return box;
}

function renderSafeOptionsSummary(document) {
  const box = document.createElement("div");
  box.className = "simulation-safe-options";
  const title = document.createElement("p");
  title.textContent = "安全な既定値 (この画面からは変更できません):";
  const list = document.createElement("ul");
  const rows = [
    ["cooldownを無視", DEFAULT_SIMULATION_OPTIONS.bypassCooldown],
    ["AIはmockを使用 (実際のAPI呼び出しなし)", DEFAULT_SIMULATION_OPTIONS.useMockAi],
    ["音声読み上げ", DEFAULT_SIMULATION_OPTIONS.enableSpeech],
    ["OBS通知", DEFAULT_SIMULATION_OPTIONS.enableObs],
  ];
  for (const [label, value] of rows) {
    const item = document.createElement("li");
    item.textContent = `${label}: ${value ? "ON" : "OFF"}`;
    list.append(item);
  }
  box.append(title, list);
  return box;
}

function renderProductionConfirmDialog(document, state, callbacks) {
  const box = document.createElement("div");
  box.className = "simulation-production-confirm";
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-label", "本番相当simulationの確認");
  const warning = document.createElement("p");
  warning.className = "simulation-production-warning";
  warning.textContent = "本番相当で実行すると、実際のAI応答・音声読み上げ・OBS通知が行われ、cooldownも通常どおり適用されます。テスト目的で安易に実行しないでください。";
  const ackLabel = document.createElement("label");
  ackLabel.className = "field-inline";
  const ackCheckbox = document.createElement("input");
  ackCheckbox.type = "checkbox";
  ackCheckbox.checked = Boolean(state.productionAcknowledged);
  ackCheckbox.dataset.productionAck = "true";
  ackLabel.append(ackCheckbox, document.createTextNode(" 本番のAI/音声/OBSが実際に呼び出されることを理解しました"));
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "btn-danger";
  confirmButton.textContent = "本番相当で実行する";
  confirmButton.dataset.simulationProductionConfirm = "true";
  // The confirm button's enabled state is gated LOCALLY on the checkbox (mirrors
  // rule-editor.js's own "toggle a dependent control directly, no full re-render" convention for
  // exactly this kind of dependent-visibility case) — a full re-render on every checkbox click
  // would be an unnecessary extra render pass for a purely local enable/disable toggle. The
  // `onAcknowledgeProduction` callback still fires so the OWNING view's state stays in sync for
  // any OTHER reason it might re-render (e.g. switching fixture kind cancels the confirmation).
  confirmButton.disabled = !state.productionAcknowledged;
  ackCheckbox.addEventListener("change", () => {
    confirmButton.disabled = !ackCheckbox.checked;
    callbacks.onAcknowledgeProduction?.(ackCheckbox.checked);
  });
  confirmButton.addEventListener("click", () => callbacks.onConfirmProductionRun?.());
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "キャンセル";
  cancelButton.addEventListener("click", () => callbacks.onCancelProductionRun?.());
  box.append(warning, ackLabel, confirmButton, cancelButton);
  return box;
}

/**
 * `state`: `{ fixtureKind, draft: { actorDisplayName, isAnonymous, data }, confirmingProduction,
 * productionAcknowledged, running }`.
 * `callbacks`: `{ onFixtureKindChange, onFieldChange, onActorFieldChange, onRun,
 * onRequestProductionRun, onAcknowledgeProduction, onConfirmProductionRun, onCancelProductionRun }`.
 */
export function renderSimulationForm(root, state = {}, callbacks = {}, document = root?.ownerDocument ?? globalThis.document) {
  if (!root || !document?.createElement) return;
  root.replaceChildren();
  const { fixtureKind = SIMULATION_FIXTURE_KINDS[0], draft = {}, confirmingProduction = false, running = false } = state;

  const kindLabel = document.createElement("label");
  kindLabel.className = "field-inline";
  const kindSelect = document.createElement("select");
  kindSelect.dataset.simulationFixtureKind = "true";
  for (const kind of SIMULATION_FIXTURE_KINDS) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = FIXTURE_KIND_LABEL[kind] ?? kind;
    option.selected = kind === fixtureKind;
    kindSelect.append(option);
  }
  kindSelect.addEventListener("change", () => callbacks.onFixtureKindChange?.(kindSelect.value));
  kindLabel.append(document.createTextNode("fixture: "), kindSelect);
  root.append(kindLabel);

  const actorNameInput = document.createElement("input");
  actorNameInput.type = "text";
  actorNameInput.placeholder = "シミュレーション視聴者";
  actorNameInput.value = draft.actorDisplayName ?? "";
  actorNameInput.dataset.simulationField = "actor.displayName";
  actorNameInput.addEventListener("input", () => callbacks.onActorFieldChange?.("actorDisplayName", actorNameInput.value));
  root.append(field(document, { label: "actor.displayName", input: actorNameInput }));

  const anonymousInput = document.createElement("input");
  anonymousInput.type = "checkbox";
  anonymousInput.checked = Boolean(draft.isAnonymous);
  anonymousInput.dataset.simulationField = "actor.isAnonymous";
  anonymousInput.addEventListener("change", () => callbacks.onActorFieldChange?.("isAnonymous", anonymousInput.checked));
  root.append(field(document, { label: "actor.isAnonymous", input: anonymousInput }));

  root.append(renderDataFields(document, fixtureKind, draft.data, (key, value) => callbacks.onFieldChange?.(key, value)));
  root.append(renderSafeOptionsSummary(document));

  const buttonRow = document.createElement("div");
  buttonRow.className = "btn-row";
  const runButton = document.createElement("button");
  runButton.type = "button";
  runButton.className = "btn-primary";
  runButton.textContent = "実行 (安全な既定値)";
  runButton.disabled = running;
  runButton.addEventListener("click", () => callbacks.onRun?.());
  const productionButton = document.createElement("button");
  productionButton.type = "button";
  productionButton.dataset.simulationProductionRequest = "true";
  productionButton.textContent = "本番相当で実行…";
  productionButton.disabled = running;
  productionButton.addEventListener("click", () => callbacks.onRequestProductionRun?.());
  buttonRow.append(runButton, productionButton);
  root.append(buttonRow);

  if (confirmingProduction) root.append(renderProductionConfirmDialog(document, state, callbacks));
}

export { DEFAULT_SIMULATION_OPTIONS, PRODUCTION_EQUIVALENT_OPTIONS };
