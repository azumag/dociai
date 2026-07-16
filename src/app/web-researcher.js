export class WebResearcher {
  constructor({ config, getConnector }) {
    this.config = config.research ?? {};
    this.getConnector = getConnector;
  }

  get enabled() { return this.config.enabled === true; }

  async research({ comment = null, task = null, signal, requestId, generation } = {}) {
    if (!this.enabled) return null;
    const query = String(task ?? comment?.text ?? "").trim().slice(0, 500);
    if (!query) return null;
    const connectorId = String(this.config.connector ?? "").trim();
    const connector = this.getConnector(connectorId);
    if (!connector?.search) throw new Error(`Web調査connectorが利用できません: ${connectorId || "(未設定)"}`);
    const response = await connector.search(query, { signal, requestId, generation });
    const maxResults = Math.max(1, Math.min(10, Math.floor(Number(this.config.maxResults ?? 5) || 5)));
    return { query, results: (response?.results ?? []).slice(0, maxResults) };
  }
}
