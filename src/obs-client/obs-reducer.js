import { evaluateSequence } from "../obs/obs-protocol.js";

export function reduceObsMessage(state, message) {
  const verdict = evaluateSequence(state, message);
  if (message.type === "snapshot") return { state: { ...message.payload, serverInstanceId: message.serverInstanceId, generation: message.generation, sequence: message.sequence }, verdict: "snapshot" };
  if (message.type !== "state" || verdict !== "next") return { state, verdict };
  const next = { ...state, serverInstanceId: message.serverInstanceId, generation: message.generation, sequence: message.sequence };
  if (message.payload.kind === "comment") next.comment = message.payload;
  if (message.payload.kind === "reply") next.reply = message.payload;
  if (message.payload.kind === "speech") next.speech = message.payload;
  if (message.payload.kind === "news-attribution") next.attribution = message.payload;
  return { state: next, verdict };
}
