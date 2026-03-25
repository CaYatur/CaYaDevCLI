// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");

await fs.rm(distDir, { recursive: true, force: true });
await fs.mkdir(path.join(distDir, "src", "core"), { recursive: true });
await fs.mkdir(path.join(distDir, "scripts"), { recursive: true });
await fs.mkdir(path.join(distDir, "test"), { recursive: true });

await copyFile("package.json");
await copyFile("README.md");
await copyFile("scripts/build.js");
await copyFile("src/index.js");
await copyFile("src/core/banner.js");
await copyFile("src/core/checkpoints.js");
await copyFile("src/core/cli.js");
await copyFile("src/core/config.js");
await copyFile("src/core/modes.js");
await copyFile("src/core/parser.js");
await copyFile("src/core/prompts.js");
await copyFile("src/core/provider.js");
await copyFile("src/core/providers.js");
await copyFile("src/core/reasoning.js");
await copyFile("src/core/render.js");
await copyFile("src/core/tools.js");
await copyFile("src/core/utils.js");
await copyFile("src/core/workspace.js");
await copyFile("test/parser.test.js");

console.log(`Build complete: ${distDir}`);

async function copyFile(relativePath) {
  const source = path.join(rootDir, relativePath);
  const target = path.join(distDir, relativePath);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
