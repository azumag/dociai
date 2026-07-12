// Issue #84: holds the non-secret facts about the currently-trusted Twitch token — which account
// it belongs to, which scopes it actually carries (per Twitch's own /validate response, not just
// whatever scopes were originally requested), when it expires, when it was last confirmed live,
// and a monotonic `authGeneration` that increments every time the underlying token identity
// changes (a brand-new Device Code Grant token, or a successful refresh rotation).
//
// Deliberately in-memory only, not persisted to disk: access/refresh tokens themselves are the
// only thing that must survive an app restart (via #42's SecretStore, see twitch-token-
// provider.ts), and this repository is always rebuilt from a fresh /validate call before anything
// is trusted again at startup (see twitch-token-provider.ts's initialize()). Persisting metadata
// separately would just be a second, potentially-stale copy of what /validate already tells us
// authoritatively every time we ask.
//
// NEVER holds accessToken/refreshToken — see twitch-token-provider.test.mjs's assertNoSecretLeak
// for the standing invariant this exists to make trivially true by construction (there is no
// field here a future refactor could accidentally leak).
export type TwitchAuthAccount = { userId: string; login: string };

export type TwitchAuthMetadata = {
  account: TwitchAuthAccount | null;
  clientId: string | null;
  scopes: string[];
  expiresAt: string | null;
  validatedAt: string | null;
  authGeneration: number;
};

function emptyMetadata(): TwitchAuthMetadata {
  return { account: null, clientId: null, scopes: [], expiresAt: null, validatedAt: null, authGeneration: 0 };
}

export class AuthMetadataRepository {
  #metadata: TwitchAuthMetadata = emptyMetadata();

  /** Always returns a fresh copy — callers may never mutate the repository's internal state via
   * the returned object. */
  get(): TwitchAuthMetadata {
    return { ...this.#metadata, account: this.#metadata.account ? { ...this.#metadata.account } : null, scopes: [...this.#metadata.scopes] };
  }

  /** Records the outcome of a successful /validate call. Does NOT touch authGeneration — a
   * validate confirms the *same* token identity is still good, it does not establish a new one
   * (see bumpGeneration(), called only when the underlying token itself changes). */
  recordValidated(input: { account: TwitchAuthAccount; clientId: string; scopes: string[]; expiresAt: string; validatedAt: string }): void {
    this.#metadata = { ...this.#metadata, account: { ...input.account }, clientId: input.clientId, scopes: [...input.scopes], expiresAt: input.expiresAt, validatedAt: input.validatedAt };
  }

  /** Called exactly when a new access/refresh token pair becomes the one in effect (a fresh
   * Device Code Grant, or a successful refresh rotation) — never on a mere revalidation of the
   * same token. Returns the new generation number. */
  bumpGeneration(): number {
    this.#metadata = { ...this.#metadata, authGeneration: this.#metadata.authGeneration + 1 };
    return this.#metadata.authGeneration;
  }

  /** Drops account/scopes/expiry (but keeps authGeneration monotonic) — used when a brand-new
   * Device Code Grant token supersedes whatever account/scopes were previously recorded, so a
   * stale scope list from a previous, differently-scoped authorization can never linger. */
  resetIdentity(): void {
    this.#metadata = { ...emptyMetadata(), authGeneration: this.#metadata.authGeneration };
  }

  /** Full reset including authGeneration — used only when the provider itself is disposed. */
  clear(): void {
    this.#metadata = emptyMetadata();
  }
}
