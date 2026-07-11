export class ResponseCoordinator {
  constructor({ runtime, getGeneration, getConnector, personaRouter, contextBuilder, speechQueue, dispatch = () => {}, publish = () => {}, onError = () => {} }) {
    Object.assign(this, { runtime, getGeneration, getConnector, personaRouter, contextBuilder, speechQueue, dispatch, publish, onError }); this.disposed = false;
  }
  handleTrigger(triggerId, { comment = null, personaId = null, manual = false, task = null } = {}) {
    if (this.disposed) return [];
    const result = this.personaRouter.select(triggerId, { comment, personaId, ignoreCooldown: manual });
    for (const skipped of result.skipped) this.dispatch({ type: "response-skipped", triggerId, persona: skipped.persona, reason: skipped.reason });
    for (const persona of result.selected) this.respond(persona, { comment, triggerId, task });
    return result.selected;
  }
  async respond(persona, { comment = null, triggerId = "manual", task = null } = {}) {
    const connector = this.getConnector(persona.connector);
    if (!connector) { this.onError(new Error(`Missing connector: ${persona.connector}`), persona); return null; }
    const generation = this.getGeneration();
    const request = this.runtime.createRequest({ generation, ownerId: `connector:${generation}:${persona.connector}`, kind: "ai-chat" });
    this.personaRouter.recordReply(persona, comment);
    this.dispatch({ type: "response-started", persona, triggerId });
    const { messages, debugText } = this.contextBuilder.build({ persona, comment, task });
    this.dispatch({ type: "response-debug", persona, debugText });
    try {
      const result = await connector.chat(messages, { signal: request.context.signal, requestId: request.context.requestId, generation });
      this.runtime.guard(request.context);
      this.dispatch({ type: "response-final", persona, triggerId, text: result.text });
      this.publish("reply", { personaId: persona.id, personaName: persona.name, text: result.text, time: Date.now() });
      this.speechQueue.enqueue({ personaId: persona.id, personaName: persona.name, text: result.text, voice: persona.voice });
      return result.text;
    } catch (error) {
      if (error?.kind !== "cancelled" && error?.name !== "AbortError") { this.dispatch({ type: "response-error", persona, triggerId, error }); this.onError(error, persona); }
      return null;
    } finally { request.complete(); this.dispatch({ type: "response-finished", persona, triggerId, generation }); }
  }
  dispose() { if (this.disposed) return false; this.disposed = true; return true; }
}
