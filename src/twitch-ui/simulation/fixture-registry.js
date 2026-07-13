// Issue #96: "official相当fixture registryを作成" — this UI's fixture options are a THIN wrapper
// around #93's REAL `SIMULATION_FIXTURE_KINDS`/`SIMULATION_FIXTURES`/`buildFixtureEvent`
// (src/simulation/stream-event-simulator.js), never a second/divergent fixture list — the exact same
// "don't invent a duplicate list" principle #95's condition-builder.js already applies to
// src/triggers/event-field-registry.js (see that file's own header comment).
//
// What this module ADDS on top of that real registry is purely UI-facing: Japanese labels and,
// per "fixture typeに応じたschema-driven formを実装", the list of EDITABLE fields for a given fixture
// kind — derived from #91's REAL `event-field-registry.js` (the same allow-list
// src/twitch-ui/rules/condition-builder.js already narrows against), filtered to that kind's own
// `data.*` fields, so a new registered field is picked up automatically and this form can never let
// an operator type a field name the registry doesn't actually recognize for that kind.
import { SIMULATION_FIXTURES, SIMULATION_FIXTURE_KINDS, buildFixtureEvent } from "../../simulation/stream-event-simulator.js";
import { EVENT_FIELD_KEYS, getFieldDefinition } from "../../triggers/event-field-registry.js";

export { SIMULATION_FIXTURE_KINDS, buildFixtureEvent };

export const FIXTURE_KIND_LABEL = Object.freeze({
  cheer: "cheer (bits)",
  subscription: "subscription (新規サブスク)",
  resub: "resub (継続サブスク)",
  "gift-subscription": "gift-subscription (ギフトサブスク)",
  "reward-redemption": "reward-redemption (チャネルポイント)",
});

/** Every `data.*` field the registry allows for `kind` — the schema-driven field list a simulation
 * form builds its inputs from, in registry order. Never includes `actor.*`/`channel.*` base fields
 * (those get their own fixed, always-present actor-override controls in simulation-form.js, common
 * to every kind, unlike a per-kind `data` field). */
export function fieldsForFixtureKind(kind) {
  return EVENT_FIELD_KEYS.filter((key) => key.startsWith("data.")).map((key) => ({ key, ...getFieldDefinition(key) })).filter((entry) => entry.kinds.includes(kind));
}

/** The fixture's own baked-in default `data` values for `kind` (from #93's real fixture builder) —
 * used to prefill the schema-driven form so an operator starts from a KNOWN-VALID event, per
 * stream-event-simulator.js's own "deliberately realistic... exercises the real matcher immediately"
 * design note, rather than an empty/zeroed form. */
export function defaultDataForFixtureKind(kind) {
  const builder = SIMULATION_FIXTURES[kind];
  if (!builder) return {};
  return { ...builder().data };
}
