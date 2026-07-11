export const createSettingsState = () => ({ status: "closed", base: null, draft: null, dirty: false, activeTab: "connectors", issues: [], touchedPaths: new Set(), scrollByTab: {}, saveError: null });
