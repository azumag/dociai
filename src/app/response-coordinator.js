export class ResponseCoordinator {
  constructor({ runtime, getGeneration, getConnector, personaRouter, contextBuilder, webResearcher = null, speechQueue, dispatch = () => {}, publish = () => {}, onError = () => {} }) {
    Object.assign(this, { runtime, getGeneration, getConnector, personaRouter, contextBuilder, webResearcher, speechQueue, dispatch, publish, onError }); this.disposed = false;
  }
  handleTrigger(triggerId, { comment = null, personaId = null, manual = false, task = null } = {}) {
    if (this.disposed) return [];
    const result = this.personaRouter.select(triggerId, { comment, personaId, ignoreCooldown: manual });
    for (const skipped of result.skipped) this.dispatch({ type: "response-skipped", triggerId, persona: skipped.persona, reason: skipped.reason });
    const personas = [];
    for (const selection of result.selected) {
      const persona = selection?.persona ?? selection;
      personas.push(persona);
      this.respond(persona, { comment, triggerId, task, selection: selection?.persona ? selection : null });
    }
    return personas;
  }
  async respond(persona, { comment = null, triggerId = "manual", task = null, selection = null } = {}) {
    const connector = this.getConnector(persona.connector);
    if (!connector) { this.personaRouter.releaseSelection?.(selection); this.onError(new Error(`Missing connector: ${persona.connector}`), persona); return null; }
    const generation = this.getGeneration();
    const admitted = selection ? this.personaRouter.commitSelection(selection) : this.personaRouter.recordReply(persona, comment);
    if (admitted === false) { this.dispatch({ type: "response-skipped", persona, triggerId, reason: "1コメント最大応答に到達" }); return null; }
    const request = this.runtime.createRequest({ generation, ownerId: `connector:${generation}:${persona.connector}`, kind: "ai-chat" });
    this.dispatch({ type: "response-started", persona, triggerId });
    try {
      let research = null;
      if (this.webResearcher?.enabled) {
        this.dispatch({ type: "research-started", persona, triggerId });
        try {
          research = await this.webResearcher.research({ comment, task, signal: request.context.signal, requestId: request.context.requestId, generation });
          this.runtime.guard(request.context);
          this.dispatch({ type: "research-completed", persona, triggerId, resultCount: research?.results?.length ?? 0 });
        } catch (error) {
          if (error?.kind === "cancelled" || error?.name === "AbortError" || request.context.signal.aborted) throw error;
          this.dispatch({ type: "research-error", persona, triggerId, error });
        }
      }
      const { messages, debugText } = this.contextBuilder.build({ persona, comment, task, research });
      this.dispatch({ type: "response-debug", persona, debugText });
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
