import assert from "node:assert/strict";
import test from "node:test";
import {
  redactSecrets,
  resolveMacNotarizationCredentials,
  resolveMacKeychainCredentials,
  resolveWindowsSigningCredentials,
  describeSigningStatus,
} from "../release/signing-credentials.mjs";

test("redactSecrets replaces every occurrence of every known secret and ignores empty/undefined entries", () => {
  const text = "running notarytool submit --password hunter2 --team-id ABC123 --password hunter2";
  assert.equal(redactSecrets(text, ["hunter2", "ABC123"]), "running notarytool submit --password *** --team-id *** --password ***");
  assert.equal(redactSecrets(text, ["", undefined, null]), text, "empty/undefined secrets must not be substituted (would corrupt the string)");
  assert.equal(redactSecrets(text, []), text);
});

test("resolveMacNotarizationCredentials returns null when no credential set is fully present (fork PR / no secrets)", () => {
  assert.equal(resolveMacNotarizationCredentials({}), null);
  assert.equal(resolveMacNotarizationCredentials({ APPLE_ID: "dev@example.com" }), null, "partial apple-id set is not enough");
  assert.equal(resolveMacNotarizationCredentials({ APPLE_API_KEY: "/path/key.p8", APPLE_API_KEY_ID: "KEYID" }), null, "partial api-key set is not enough");
});

test("resolveMacNotarizationCredentials prefers the App Store Connect API key mode when both modes are present", () => {
  const env = {
    APPLE_API_KEY: "/path/key.p8",
    APPLE_API_KEY_ID: "KEYID",
    APPLE_API_ISSUER: "ISSUER",
    APPLE_ID: "dev@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "app-specific-pw",
    APPLE_TEAM_ID: "TEAMID",
  };
  const credentials = resolveMacNotarizationCredentials(env);
  assert.equal(credentials.mode, "app-store-connect-api-key");
  assert.deepEqual(credentials.secrets, ["/path/key.p8", "KEYID", "ISSUER"]);
});

test("resolveMacNotarizationCredentials falls back to apple-id-password mode", () => {
  const env = { APPLE_ID: "dev@example.com", APPLE_APP_SPECIFIC_PASSWORD: "app-specific-pw", APPLE_TEAM_ID: "TEAMID" };
  const credentials = resolveMacNotarizationCredentials(env);
  assert.equal(credentials.mode, "apple-id-password");
  assert.deepEqual(credentials.secrets, ["app-specific-pw"]);
});

test("resolveMacNotarizationCredentials treats blank/whitespace-only env values as unset", () => {
  assert.equal(resolveMacNotarizationCredentials({ APPLE_ID: "  ", APPLE_APP_SPECIFIC_PASSWORD: "x", APPLE_TEAM_ID: "y" }), null);
});

test("resolveMacKeychainCredentials requires both the certificate and its password", () => {
  assert.equal(resolveMacKeychainCredentials({}), null);
  assert.equal(resolveMacKeychainCredentials({ MACOS_CERTIFICATE_P12_BASE64: "abc" }), null);
  const credentials = resolveMacKeychainCredentials({ MACOS_CERTIFICATE_P12_BASE64: "abc", MACOS_CERTIFICATE_PASSWORD: "pw" });
  assert.deepEqual(credentials, { certificateBase64: "abc", certificatePassword: "pw", secrets: ["abc", "pw"] });
});

test("resolveWindowsSigningCredentials requires both the certificate and its password", () => {
  assert.equal(resolveWindowsSigningCredentials({}), null);
  assert.equal(resolveWindowsSigningCredentials({ WINDOWS_CERTIFICATE_PFX_BASE64: "abc" }), null);
  const credentials = resolveWindowsSigningCredentials({ WINDOWS_CERTIFICATE_PFX_BASE64: "abc", WINDOWS_CERTIFICATE_PASSWORD: "pw" });
  assert.deepEqual(credentials, { certificateBase64: "abc", certificatePassword: "pw", secrets: ["abc", "pw"] });
});

test("describeSigningStatus never leaks a secret value, only availability", () => {
  const env = {
    MACOS_CERTIFICATE_P12_BASE64: "super-secret-base64",
    MACOS_CERTIFICATE_PASSWORD: "super-secret-pw",
    WINDOWS_CERTIFICATE_PFX_BASE64: "another-secret",
    WINDOWS_CERTIFICATE_PASSWORD: "another-secret-pw",
  };
  const status = describeSigningStatus(env);
  const serialized = JSON.stringify(status);
  for (const secret of Object.values(env)) assert.equal(serialized.includes(secret), false, `leaked secret in status: ${secret}`);
  assert.match(status.macCodeSigning, /^available/);
  assert.match(status.windowsCodeSigning, /^available/);
  assert.match(status.macNotarization, /^unavailable/, "notarization creds were not set in this env fixture");
});

test("describeSigningStatus reports unavailable for every layer with no env at all", () => {
  const status = describeSigningStatus({});
  assert.match(status.macCodeSigning, /^unavailable/);
  assert.match(status.macNotarization, /^unavailable/);
  assert.match(status.windowsCodeSigning, /^unavailable/);
});
