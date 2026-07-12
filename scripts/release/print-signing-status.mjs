#!/usr/bin/env node
// print-signing-status.mjs (#73): CI/localで「今回のbuildは何を署名/notarizeするか」を
// secretの値そのものを一切出さずに1行ずつ表示する。workflow内のログで
// "unsigned PR build" と "signed build" のどちらの経路を通ったか目視確認できるようにする。
import { describeSigningStatus } from "./signing-credentials.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const status = describeSigningStatus(process.env);
  console.log(`INFO | signing-status | macOS code signing: ${status.macCodeSigning}`);
  console.log(`INFO | signing-status | macOS notarization: ${status.macNotarization}`);
  console.log(`INFO | signing-status | Windows code signing: ${status.windowsCodeSigning}`);
}
