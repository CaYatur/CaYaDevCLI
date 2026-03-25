import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureInitialCheckpoint, listCheckpoints } from "../src/core/checkpoints.js";

async function run(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await run("ensureInitialCheckpoint creates 000 snapshot once", async () => {
  const rootDir = path.join(process.cwd(), ".cayadev-test-output");
  const sessionDir = path.join(rootDir, "session");
  const workspaceDir = path.join(rootDir, "workspace");

  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "example.txt"), "hello\n", "utf8");

  const manifest = await ensureInitialCheckpoint({
    sessionDir,
    cwd: workspaceDir,
    modeName: "advanced",
    providerId: "ollama",
    model: "qwen2.5-coder:7b"
  });

  const manifests = await listCheckpoints(sessionDir);
  const restoredFile = await fs.readFile(path.join(sessionDir, "checkpoints", "000", "workspace", "example.txt"), "utf8");

  assert.equal(manifest.id, "000");
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].id, "000");
  assert.equal(restoredFile, "hello\n");

  const again = await ensureInitialCheckpoint({
    sessionDir,
    cwd: workspaceDir,
    modeName: "advanced",
    providerId: "ollama",
    model: "qwen2.5-coder:7b"
  });

  assert.equal(again.id, "000");
  assert.equal((await listCheckpoints(sessionDir)).length, 1);

  await fs.rm(rootDir, { recursive: true, force: true });
});
