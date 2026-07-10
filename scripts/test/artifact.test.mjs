import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistArtifacts, redactSecrets, writeFailureArtifact } from "./artifact.mjs";

test("failure artifacts redact known and supplied secrets", async () => {
  const secret = "known-test-secret";
  const redacted = redactSecrets({ apiKey: "sk-testsecret123", authorization: "Bearer abc.def", note: secret }, [secret]);
  assert.doesNotMatch(redacted, /testsecret123|abc\.def|known-test-secret/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dociai-artifact-"));
  try {
    const file = await writeFailureArtifact(directory, "failure.log", redacted);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const persisted = `${directory}-persisted`;
    await persistArtifacts(directory, persisted);
    assert.equal(await fs.readFile(path.join(persisted, "failure.log"), "utf8"), redacted);
    await fs.rm(persisted, { recursive: true, force: true });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
