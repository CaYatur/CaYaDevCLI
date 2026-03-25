// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, getIgnoredNames, pathExists, toRelativePath } from "./utils.js";

export async function captureWorkspaceState(cwd) {
  const files = new Map();
  await collectWorkspaceFiles(cwd, cwd, files);
  return files;
}

export function summarizeWorkspaceChanges(beforeState, afterState) {
  const allPaths = new Set([...beforeState.keys(), ...afterState.keys()]);
  const files = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const filePath of [...allPaths].sort()) {
    const before = beforeState.get(filePath);
    const after = afterState.get(filePath);

    if (before === after) {
      continue;
    }

    const summary = diffText(before ?? "", after ?? "");

    totalAdded += summary.added;
    totalRemoved += summary.removed;
    files.push({
      path: filePath,
      added: summary.added,
      removed: summary.removed,
      status: before == null ? "created" : after == null ? "deleted" : "modified"
    });
  }

  return {
    totalAdded,
    totalRemoved,
    files
  };
}

export async function restoreWorkspaceFromSnapshot(snapshotDir, cwd) {
  const snapshotState = new Map();
  await collectWorkspaceFiles(snapshotDir, snapshotDir, snapshotState);

  const liveState = await captureWorkspaceState(cwd);
  const ignored = getIgnoredNames();

  for (const relativePath of liveState.keys()) {
    if (snapshotState.has(relativePath)) {
      continue;
    }

    const target = path.join(cwd, relativePath);
    await fs.rm(target, { force: true });
  }

  for (const [relativePath, content] of snapshotState.entries()) {
    const target = path.join(cwd, relativePath);
    await ensureDir(path.dirname(target));
    await fs.writeFile(target, content, "utf8");
  }

  await removeEmptyDirectories(cwd, ignored);
}

async function collectWorkspaceFiles(rootDir, currentDir, files) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const ignored = getIgnoredNames();

  for (const entry of entries) {
    if (ignored.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await collectWorkspaceFiles(rootDir, fullPath, files);
      continue;
    }

    const relativePath = toRelativePath(rootDir, fullPath);
    const content = await fs.readFile(fullPath, "utf8").catch(() => null);

    if (content == null) {
      continue;
    }

    files.set(relativePath, content);
  }
}

async function removeEmptyDirectories(rootDir, ignored) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || ignored.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    await removeEmptyDirectories(fullPath, ignored);
    const inner = await fs.readdir(fullPath);

    if (inner.length === 0 && (await pathExists(fullPath))) {
      await fs.rmdir(fullPath);
    }
  }
}

function diffText(beforeText, afterText) {
  const beforeLines = beforeText === "" ? [] : beforeText.split(/\r?\n/);
  const afterLines = afterText === "" ? [] : afterText.split(/\r?\n/);
  const beforeCounts = countLines(beforeLines);
  const afterCounts = countLines(afterLines);
  let added = 0;
  let removed = 0;

  for (const [line, count] of afterCounts.entries()) {
    const previous = beforeCounts.get(line) ?? 0;
    if (count > previous) {
      added += count - previous;
    }
  }

  for (const [line, count] of beforeCounts.entries()) {
    const next = afterCounts.get(line) ?? 0;
    if (count > next) {
      removed += count - next;
    }
  }

  return { added, removed };
}

function countLines(lines) {
  const counts = new Map();

  lines.forEach((line) => {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  });

  return counts;
}
