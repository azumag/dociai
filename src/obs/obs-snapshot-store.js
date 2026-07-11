const clip = (value, max) => {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
};
const freeze = (snapshot) => Object.freeze({ ...snapshot, comment: snapshot.comment ? Object.freeze({ ...snapshot.comment }) : null, reply: snapshot.reply ? Object.freeze({ ...snapshot.reply }) : null, speech: snapshot.speech ? Object.freeze({ ...snapshot.speech }) : null });

export class ObsSnapshotStore {
  constructor({ serverInstanceId = crypto.randomUUID(), maxTextLength = 500 } = {}) {
    this.serverInstanceId = serverInstanceId;
    this.maxTextLength = maxTextLength;
    this.snapshot = freeze({ serverInstanceId, generation: 0, sequence: 0, comment: null, reply: null, speech: null });
  }

  getSnapshot() { return this.snapshot; }

  apply(event, generation = this.snapshot.generation) {
    const changedGeneration = generation !== this.snapshot.generation;
    const next = { serverInstanceId: this.serverInstanceId, generation, sequence: changedGeneration ? 1 : this.snapshot.sequence + 1, comment: changedGeneration ? null : this.snapshot.comment, reply: changedGeneration ? null : this.snapshot.reply, speech: changedGeneration ? null : this.snapshot.speech };
    if (event?.kind === "comment") next.comment = { author: clip(event.author, this.maxTextLength), text: clip(event.text, this.maxTextLength), time: Number(event.time) || Date.now() };
    if (event?.kind === "reply") next.reply = { personaName: clip(event.personaName, this.maxTextLength), text: clip(event.text, this.maxTextLength), color: event.color ?? "" };
    if (event?.kind === "speech") next.speech = { state: event.state === "speaking" ? "speaking" : "idle", personaName: clip(event.personaName, this.maxTextLength) };
    this.snapshot = freeze(next);
    return this.snapshot;
  }

  reset(generation) { return this.apply({ kind: "reset" }, generation); }
}
