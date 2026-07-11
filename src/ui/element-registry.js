export class ElementRegistry {
  constructor(document, selectors) {
    this.document = document;
    this.elements = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Required DOM element is missing: ${selector}`);
      this.elements[name] = element;
    }
    Object.freeze(this.elements);
  }
  get(name) {
    const element = this.elements[name];
    if (!element) throw new Error(`Unknown DOM element: ${name}`);
    return element;
  }
}
