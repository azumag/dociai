// Issue #96: the Simulation tab — "本番eventなしで全ルールを安全にsimulationできる". Runs #93's REAL
// `simulateStreamEvent()` against the CURRENT config's `eventTriggers` (the exact same source of
// truth views/event-rules.js's own "test this rule" button reads from), records every run into the
// SAME shared `EventHistoryStore` the Event History tab renders (see views/overview.js — one store,
// two views, so a simulation run is never a dead end nor a second, disconnected history), and gates
// `productionEquivalent: true` behind an explicit, hard-to-misclick confirmation step
// (simulation-form.js's `renderProductionConfirmDialog`) before ever passing it to the simulator.
//
// `actionRunner` is an OPTIONAL injected dependency (default `null`), mirroring
// views/event-rules.js's own `client = null` pattern: no Main-process/Renderer-wide `ActionRunner`
// (real AI/speech/OBS execution) is wired into this app's boot sequence yet anywhere (see
// rule-editor.js's own `renderTestResult()` doc comment: "ActionRunner has no wiring into this
// Renderer-side runtime yet anywhere in this app") — wiring one for real is out of this issue's own
// file list (`src/twitch-ui/simulation/*` only) and scope. With `actionRunner: null`,
// `simulateStreamEvent()` still runs the REAL matcher/planner end to end and returns REAL
// `matches`/`skipped`/`plans` — only the final execution step (`results`) is empty, which
// simulation-result.js/trigger-trace-drawer.js both render as an explicit "not executed" state, never
// silently as "nothing happened". When a future issue wires a real `ActionRunner` in, injecting it
// here is the only change needed for this view to actually execute plans.
import { SIMULATION_FIXTURE_KINDS, buildFixtureEvent } from "../simulation/fixture-registry.js";
import { simulateStreamEvent } from "../../simulation/stream-event-simulator.js";
import { buildOverridesFromDraft, renderSimulationForm } from "../simulation/simulation-form.js";
import { renderSimulationResult } from "../simulation/simulation-result.js";

/** Real `EventTriggerConfig[]`, from the CURRENT config's `eventTriggers` map — never a hardcoded/
 * separate rule list, so a simulation run exercises exactly what the operator has actually
 * configured (same principle as views/event-rules.js's own `#runTest()`). */
function triggersFromConfig(getConfig) {
  const eventTriggers = getConfig?.()?.eventTriggers ?? {};
  return Object.entries(eventTriggers).map(([id, rule]) => ({ ...rule, id }));
}

export class SimulationView {
  constructor({ document = globalThis.document, getConfig = () => null, historyStore, actionRunner = null, onOpenTrace = () => {}, log = () => {} } = {}) {
    this.document = document;
    this.getConfig = getConfig;
    this.historyStore = historyStore;
    this.actionRunner = actionRunner;
    this.onOpenTrace = onOpenTrace;
    this.log = log;
    this.fixtureKind = SIMULATION_FIXTURE_KINDS[0];
    this.draft = { data: {} };
    this.confirmingProduction = false;
    this.productionAcknowledged = false;
    this.running = false;
    this.lastEntry = null;
    this.root = null;
  }

  /** Public (not `#private`) so a test can `await` a run's full outcome directly — mirrors
   * views/event-rules.js's own public `save()` for the identical reason. `productionEquivalent`
   * defaults `false`; the ONLY caller allowed to pass `true` is `#confirmProductionRun()` below,
   * which only runs after the operator has both opened AND explicitly acknowledged the confirmation
   * dialog — this is the entire "誤操作しにくいconfirmation" guarantee, enforced structurally (no
   * other code path in this class ever sets `productionEquivalent: true`). */
  async run({ productionEquivalent = false } = {}) {
    this.running = true;
    this.render(this.root);
    try {
      const overrides = buildOverridesFromDraft(this.fixtureKind, this.draft);
      const event = buildFixtureEvent(this.fixtureKind, overrides);
      const triggers = triggersFromConfig(this.getConfig);
      const result = await simulateStreamEvent({
        event,
        triggers,
        actionRunner: this.actionRunner ?? undefined,
        options: productionEquivalent ? { productionEquivalent: true } : {},
        generation: 0,
      });
      this.lastEntry = this.historyStore.recordSimulation({ event: result.event ?? event, result });
      this.log(`simulation実行: fixture=${this.fixtureKind} productionEquivalent=${productionEquivalent}`, "info");
      return this.lastEntry;
    } finally {
      this.running = false;
      this.confirmingProduction = false;
      this.productionAcknowledged = false;
      this.render(this.root);
    }
  }

  #confirmProductionRun() {
    if (!this.productionAcknowledged) return;
    void this.run({ productionEquivalent: true });
  }

  render(root) {
    if (!root || !this.document?.createElement) return;
    this.root = root;
    const document = this.document;
    root.replaceChildren();

    const heading = document.createElement("h2");
    heading.textContent = "Simulation";
    const intro = document.createElement("p");
    intro.className = "muted";
    intro.textContent = "本番のTwitchイベントなしでEvent Ruleを安全にテストします。既定では音声/OBSは実行されず、AIはmockが使われます。";
    root.append(heading, intro);

    const formRoot = document.createElement("div");
    renderSimulationForm(formRoot, {
      fixtureKind: this.fixtureKind,
      draft: this.draft,
      confirmingProduction: this.confirmingProduction,
      productionAcknowledged: this.productionAcknowledged,
      running: this.running,
    }, {
      onFixtureKindChange: (kind) => { this.fixtureKind = kind; this.draft = { data: {} }; this.render(root); },
      onFieldChange: (key, value) => { this.draft = { ...this.draft, data: { ...this.draft.data, [key]: value } }; },
      onActorFieldChange: (key, value) => { this.draft = { ...this.draft, [key]: value }; },
      onRun: () => { void this.run({ productionEquivalent: false }); },
      onRequestProductionRun: () => { this.confirmingProduction = true; this.productionAcknowledged = false; this.render(root); },
      onAcknowledgeProduction: (checked) => { this.productionAcknowledged = checked; },
      onConfirmProductionRun: () => this.#confirmProductionRun(),
      onCancelProductionRun: () => { this.confirmingProduction = false; this.productionAcknowledged = false; this.render(root); },
    }, document);
    root.append(formRoot);

    const resultRoot = document.createElement("div");
    renderSimulationResult(resultRoot, this.lastEntry, { getConfig: this.getConfig, onOpenTrace: (id) => this.onOpenTrace(id) }, document);
    root.append(resultRoot);
  }
}
