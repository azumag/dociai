export class RuntimeGenerationManager {
  #current = 0;
  #history = [];

  current() { return this.#current; }

  next(reason = "runtime reload") {
    if (!Number.isSafeInteger(this.#current) || this.#current >= Number.MAX_SAFE_INTEGER) throw new Error("runtime generation limit reached");
    const previous = this.#current;
    this.#current += 1;
    this.#history.push({ generation: this.#current, previous, reason, at: Date.now() });
    if (this.#history.length > 32) this.#history.shift();
    return this.#current;
  }

  isCurrent(generation) { return generation === this.#current; }

  history() { return this.#history.map((entry) => ({ ...entry })); }
}
