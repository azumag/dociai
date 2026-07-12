import { TwitchUiStore } from "../twitch-ui-store.js";
import { TwitchUiClient } from "../twitch-ui-client.js";
import { computePreflightChecks, renderPreflightChecks } from "../components/preflight-check.js";
import { renderConnectionCard, updateConnectionCountdown } from "../components/connection-card.js";
import { renderAuthorizationView, updateAuthorizationCountdown } from "./authorization.js";
import { renderSubscriptionsView } from "./subscriptions.js";

// Issue #94: the mount point for the whole Twitch overview screen (dialog root -> tabs ->
// overview/authorization/subscriptions content), mirroring src/ui/integrations/integration-panel.js's
// role as the Integration Health UI's own container (issue #94's explicit architectural precedent).
// Owns: the TwitchUiStore + TwitchUiClient pair, tab switching (itself the "failed checkから該当
// viewへdeep-link" destination), the countdown re-render interval, and translating raw client
// actions into store-tracked busy/error state (via TwitchUiClient.runAction).
const TAB_LABELS = { overview: "概要", authorization: "認可", subscriptions: "購読" };

function defaultCopyToClipboard(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => {});
}

export class TwitchOverviewApp {
  constructor(root, {
    document = root?.ownerDocument ?? globalThis.document,
    client = new TwitchUiClient(),
    store = new TwitchUiStore(),
    copyToClipboard = defaultCopyToClipboard,
    onOpenSettings = () => {},
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    now = Date.now,
  } = {}) {
    this.root = root;
    this.document = document;
    this.client = client;
    this.store = store;
    this.copyToClipboard = copyToClipboard;
    this.onOpenSettings = onOpenSettings;
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.disposeStoreConnection = null;
    this.unsubscribeStore = null;
    this.timer = null;
    if (!root || !document?.createElement) return;
    this.#build();
  }

  #build() {
    const document = this.document;
    this.root.replaceChildren();
    const tabs = document.createElement("div");
    tabs.className = "twitch-tabs";
    this.tabButtons = {};
    for (const view of Object.keys(TAB_LABELS)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = TAB_LABELS[view];
      button.addEventListener("click", () => this.store.dispatch({ type: "twitch/select-view", view }));
      this.tabButtons[view] = button;
      tabs.append(button);
    }
    this.errorRoot = document.createElement("p");
    this.errorRoot.className = "twitch-error";
    this.errorRoot.hidden = true;
    this.contentRoot = document.createElement("div");
    this.contentRoot.className = "twitch-tab-content";
    this.root.append(tabs, this.errorRoot, this.contentRoot);
    this.unsubscribeStore = this.store.subscribe(() => this.#render());
    this.#render();
  }

  #callbacks() {
    const run = (key, action) => this.client.runAction(this.store, key, action);
    return {
      onNavigate: (deepLink) => {
        if (!deepLink) return;
        if (deepLink.kind === "settings") this.onOpenSettings();
        else this.store.dispatch({ type: "twitch/select-view", view: deepLink.view });
      },
      onConnect: () => run("connect", () => this.client.connect()),
      onReconnect: () => run("reconnect", () => this.client.reconnect()),
      onStop: () => run("stop", () => this.client.stopConnection()),
      onDismissNotice: (id) => this.store.dispatch({ type: "twitch/dismiss-notice", id }),
      onStartAuth: () => run("startAuth", () => this.client.startAuth()),
      onCancelAuth: () => run("cancelAuth", () => this.client.cancelAuth()),
      onUpgradeScopes: () => run("upgradeScopes", () => this.client.upgradeScopes()),
      onOpenVerificationUri: () => run("openVerificationUri", () => this.client.openVerificationUri()),
      // Only ever handed `flow.userCode` by views/authorization.js — never a token/device_code.
      onCopy: (text) => { if (text) this.copyToClipboard(text); },
      onRequestSwitchAccount: () => this.store.dispatch({ type: "twitch/confirm-dialog-open", action: "switch-account" }),
      onRequestLogout: () => this.store.dispatch({ type: "twitch/confirm-dialog-open", action: "logout" }),
      onCancelConfirmDialog: () => this.store.dispatch({ type: "twitch/confirm-dialog-close" }),
      onConfirmDialog: (action) => {
        this.store.dispatch({ type: "twitch/confirm-dialog-close" });
        if (action === "logout") void run("logout", () => this.client.logout());
        else void run("switchAccount", () => this.client.switchAccount());
      },
      onRetry: () => run("reconnect", () => this.client.reconnect()),
    };
  }

  #render() {
    const state = this.store.getSnapshot();
    for (const [view, button] of Object.entries(this.tabButtons)) button.className = view === state.view ? "is-active" : "";
    this.errorRoot.hidden = !state.error;
    this.errorRoot.textContent = state.error ?? "";
    const callbacks = this.#callbacks();
    this.contentRoot.replaceChildren();
    if (state.view === "overview") {
      const preflightRoot = this.document.createElement("div");
      renderPreflightChecks(preflightRoot, computePreflightChecks(state), callbacks, this.document);
      const connectionRoot = this.document.createElement("div");
      renderConnectionCard(connectionRoot, state, callbacks, this.document);
      this.contentRoot.append(preflightRoot, connectionRoot);
    } else if (state.view === "authorization") {
      renderAuthorizationView(this.contentRoot, state, callbacks, this.document);
    } else if (state.view === "subscriptions") {
      renderSubscriptionsView(this.contentRoot, state, callbacks, this.document);
    }
  }

  /** Lets the mounting code (boot.js) feed in the 3 preflight rows this screen has no other way to
   * know about — trigger rules / speech backend / OBS window state. */
  setContext(context) {
    this.store.dispatch({ type: "twitch/context", context });
  }

  open() {
    if (!this.disposeStoreConnection) this.disposeStoreConnection = this.client.connectStore(this.store);
    if (!this.timer) this.timer = this.setIntervalImpl(() => this.#tick(), 1000);
    if (typeof this.root?.showModal === "function") this.root.showModal();
    else if (this.root) this.root.open = true;
  }

  close() {
    if (!this.root) return;
    if (this.root.open && typeof this.root.close === "function") this.root.close();
    else this.root.open = false;
  }

  #tick() {
    updateConnectionCountdown(this.contentRoot, this.now());
    updateAuthorizationCountdown(this.contentRoot, this.now());
  }

  dispose() {
    this.unsubscribeStore?.();
    this.disposeStoreConnection?.();
    if (this.timer) this.clearIntervalImpl(this.timer);
    this.timer = null;
  }
}
