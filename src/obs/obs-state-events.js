export function commentStateEvent(comment = {}) {
  return Object.freeze({ kind: "comment", author: String(comment.author ?? ""), text: String(comment.text ?? ""), time: Number(comment.time) || 0 });
}

export function replyStateEvent({ persona = {}, text = "", color = "" } = {}) {
  return Object.freeze({ kind: "reply", personaName: String(persona.name ?? ""), text: String(text), color: String(color) });
}

export function speechStateEvent(queue = {}) {
  const current = queue.current;
  return Object.freeze({ kind: "speech", state: current ? "speaking" : "idle", personaName: String(current?.personaName ?? "") });
}
