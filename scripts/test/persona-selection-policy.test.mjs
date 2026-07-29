import assert from "node:assert/strict";
import test from "node:test";
import { resolvePersona } from "../../src/personas/persona-selection-policy.js";

const fixed = { id: "fixed", enabled: true };
const personaA = { id: "a", enabled: true };
const personaB = { id: "b" };
const disabled = { id: "disabled", enabled: false };
const personas = new Map([fixed, personaA, personaB, disabled].map((persona) => [persona.id, persona]));
const router = {
  get: (id) => personas.get(id) ?? null,
  defaultPersona: () => personaA,
};

test("fixed selection preserves the legacy fixed -> default fallback", () => {
  assert.equal(resolvePersona({ fixedPersonaId: "fixed", personaRouter: router }), fixed);
  assert.equal(resolvePersona({ fixedPersonaId: "missing", personaRouter: router }), personaA);
});

test("random selection filters missing/disabled/duplicate candidates and uses injected randomness", () => {
  const input = { fixedPersonaId: "fixed", randomEnabled: true, candidatePersonaIds: ["missing", "disabled", "a", "a", "b"], personaRouter: router };
  assert.equal(resolvePersona({ ...input, random: () => 0 }), personaA);
  assert.equal(resolvePersona({ ...input, random: () => 0.999 }), personaB);
});

test("random selection falls back when no valid candidate remains", () => {
  assert.equal(resolvePersona({ fixedPersonaId: "fixed", randomEnabled: true, candidatePersonaIds: ["missing", "disabled"], personaRouter: router, random: () => 0.5 }), fixed);
  assert.equal(resolvePersona({ fixedPersonaId: "missing", randomEnabled: true, candidatePersonaIds: [], personaRouter: router, random: () => 0.5 }), personaA);
});

test("injected out-of-contract random values are safely bounded", () => {
  const input = { randomEnabled: true, candidatePersonaIds: ["a", "b"], personaRouter: router };
  assert.equal(resolvePersona({ ...input, random: () => -1 }), personaA);
  assert.equal(resolvePersona({ ...input, random: () => 1 }), personaB);
  assert.equal(resolvePersona({ ...input, random: () => Number.NaN }), personaA);
});
