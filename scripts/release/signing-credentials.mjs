// signing-credentials.mjs (#73): 署名/notarization用credentialの検出とlog向けmaskingを一箇所に
// まとめる。electron-builder自体のCSC_LINK/CSC_KEY_PASSWORD検出(macCodeSign.js/winPackager.js)
// はここでは複製しない — このmoduleが担うのは、電子-builderに渡す前の「notarizationするか/
// windows署名対象かを我々自身のscript/workflowがどう判定するか」という、テスト可能な純粋関数。
// fork PR(secretなし)では全て「no credentials」に倒れ、呼び出し側は必ずgracefulにskipする
// (実装は notarize.mjs / print-signing-status.mjs を参照)。

// 値を伏せた状態でしかlogに出さないための共通マスク。
// 対象文字列の完全一致(部分文字列含む)を "***" に置換する。空文字/未定義は対象から除外する
// (空文字をmaskしようとすると全文字列が壊れるため)。
export function redactSecrets(text, secrets) {
  if (typeof text !== "string") return text;
  let redacted = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
}

function trimmedOrUndefined(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

// macOS notarization (scripts/release/notarize.mjs の afterSign hook が使う)。
// Appleが文書化している2方式をサポートする:
//   1. App Store Connect API key: APPLE_API_KEY (.p8 fileへのpath) + APPLE_API_KEY_ID + APPLE_API_ISSUER
//   2. Apple ID + app-specific password: APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
// 1を優先する(Appleが推奨: 2要素より長期的に安定し、2要素認証の影響を受けない)。
// どちらも揃っていなければcredentials無しとしてnullを返す — 呼び出し側はこれをそのままskip理由にできる。
export function resolveMacNotarizationCredentials(env = process.env) {
  const apiKey = trimmedOrUndefined(env.APPLE_API_KEY);
  const apiKeyId = trimmedOrUndefined(env.APPLE_API_KEY_ID);
  const apiIssuer = trimmedOrUndefined(env.APPLE_API_ISSUER);
  if (apiKey && apiKeyId && apiIssuer) {
    return { mode: "app-store-connect-api-key", keyFile: apiKey, keyId: apiKeyId, issuer: apiIssuer, secrets: [apiKey, apiKeyId, apiIssuer] };
  }

  const appleId = trimmedOrUndefined(env.APPLE_ID);
  const appSpecificPassword = trimmedOrUndefined(env.APPLE_APP_SPECIFIC_PASSWORD);
  const teamId = trimmedOrUndefined(env.APPLE_TEAM_ID);
  if (appleId && appSpecificPassword && teamId) {
    return { mode: "apple-id-password", appleId, appSpecificPassword, teamId, secrets: [appSpecificPassword] };
  }

  return null;
}

// macOS一時keychainのcertificate import (scripts/release/setup-macos-keychain.sh が使う判定と
// 対称になるようNode側にも用意する。workflow側のconditionalやCIログ表示に使う)。
export function resolveMacKeychainCredentials(env = process.env) {
  const certificateBase64 = trimmedOrUndefined(env.MACOS_CERTIFICATE_P12_BASE64);
  const certificatePassword = trimmedOrUndefined(env.MACOS_CERTIFICATE_PASSWORD);
  if (!certificateBase64 || !certificatePassword) return null;
  return { certificateBase64, certificatePassword, secrets: [certificateBase64, certificatePassword] };
}

// Windows codesigning: base64-encoded PFXをsecretとして受け取り、一時fileへdecodeして
// electron-builderへ CSC_LINK(file path)/CSC_KEY_PASSWORD として渡す方式に決定した(#73の
// 「Windows certificate注入方式を決定」の答え)。理由はdocs/signing.mdを参照:
// Windowsには "temporary keychain" に相当するOS機能が無く、electron-builder自身が
// CSC_LINK/CSC_KEY_PASSWORDを直接読むため、macOSのような専用importスクリプトは不要。
export function resolveWindowsSigningCredentials(env = process.env) {
  const certificateBase64 = trimmedOrUndefined(env.WINDOWS_CERTIFICATE_PFX_BASE64);
  const certificatePassword = trimmedOrUndefined(env.WINDOWS_CERTIFICATE_PASSWORD);
  if (!certificateBase64 || !certificatePassword) return null;
  return { certificateBase64, certificatePassword, secrets: [certificateBase64, certificatePassword] };
}

// CI/local実行時の可読なstatus行を作る (print-signing-status.mjs から使う)。値そのものは
// 一切含めない — bool判定結果とmodeだけ。
export function describeSigningStatus(env = process.env) {
  const macKeychain = resolveMacKeychainCredentials(env);
  const macNotarize = resolveMacNotarizationCredentials(env);
  const windowsSigning = resolveWindowsSigningCredentials(env);
  return {
    macCodeSigning: macKeychain ? "available (MACOS_CERTIFICATE_P12_BASE64 set)" : "unavailable, will build unsigned",
    macNotarization: macNotarize ? `available (${macNotarize.mode})` : "unavailable, will skip notarization",
    windowsCodeSigning: windowsSigning ? "available (WINDOWS_CERTIFICATE_PFX_BASE64 set)" : "unavailable, will build unsigned",
  };
}
