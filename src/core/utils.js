// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";

const IGNORED_NAMES = new Set([
  ".cayadev",
  ".git",
  "node_modules",
  "dist",
  "coverage"
]);

export async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

export function getIgnoredNames() {
  return new Set(IGNORED_NAMES);
}

export function resolveWorkspacePath(cwd, relativePath) {
  const normalized = String(relativePath ?? "").trim();

  if (!normalized) {
    throw new Error("A relative path is required.");
  }

  const resolved = path.resolve(cwd, normalized);
  const relative = path.relative(cwd, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace: ${relativePath}`);
  }

  return resolved;
}

export function toRelativePath(cwd, absolutePath) {
  return path.relative(cwd, absolutePath).replaceAll("\\", "/");
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function copyWorkspaceSnapshot(sourceDir, targetDir) {
  await ensureDir(targetDir);
  await copyDirectory(sourceDir, targetDir, sourceDir);
}

async function copyDirectory(sourceDir, targetDir, rootDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(rootDir, sourcePath);
    const destinationPath = path.join(targetDir, relativePath);

    if (entry.isDirectory()) {
      await ensureDir(destinationPath);
      await copyDirectory(sourcePath, targetDir, rootDir);
      continue;
    }

    await ensureDir(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath);
  }
}

export function formatTimestamp(date = new Date()) {
  return date.toISOString();
}
