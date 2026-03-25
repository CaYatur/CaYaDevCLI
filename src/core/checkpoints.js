// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";

import { copyWorkspaceSnapshot, ensureDir, formatTimestamp, pathExists } from "./utils.js";

export async function saveCheckpoint({
  sessionDir,
  checkpointIndex,
  turn,
  cwd
}) {
  const checkpointId = String(checkpointIndex).padStart(3, "0");
  const baseDir = path.join(sessionDir, "checkpoints", checkpointId);
  const workspaceDir = path.join(baseDir, "workspace");

  await ensureDir(baseDir);
  await copyWorkspaceSnapshot(cwd, workspaceDir);

  const manifest = {
    id: checkpointId,
    createdAt: formatTimestamp(),
    mode: turn.modeName,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    toolsUsed: turn.toolsUsed,
    changes: turn.changes ?? {
      totalAdded: 0,
      totalRemoved: 0,
      files: []
    }
  };

  await fs.writeFile(
    path.join(baseDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  return manifest;
}

export async function ensureInitialCheckpoint({
  sessionDir,
  cwd,
  modeName,
  providerId,
  model
}) {
  const checkpointsDir = path.join(sessionDir, "checkpoints");
  const checkpointId = "000";
  const baseDir = path.join(checkpointsDir, checkpointId);
  const manifestPath = path.join(baseDir, "manifest.json");

  if (await pathExists(manifestPath)) {
    const content = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(content);
  }

  const workspaceDir = path.join(baseDir, "workspace");
  await ensureDir(baseDir);
  await copyWorkspaceSnapshot(cwd, workspaceDir);

  const manifest = {
    id: checkpointId,
    createdAt: formatTimestamp(),
    mode: modeName,
    providerId,
    model,
    userMessage: "(initial workspace snapshot)",
    assistantMessage: "Initial checkpoint before the first chat turn.",
    toolsUsed: [],
    changes: {
      totalAdded: 0,
      totalRemoved: 0,
      files: []
    },
    initial: true
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

export function getCheckpointWorkspaceDir(sessionDir, checkpointId) {
  return path.join(sessionDir, "checkpoints", checkpointId, "workspace");
}

export async function listCheckpoints(sessionDir) {
  const checkpointsDir = path.join(sessionDir, "checkpoints");

  if (!(await pathExists(checkpointsDir))) {
    return [];
  }

  const entries = await fs.readdir(checkpointsDir, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.join(checkpointsDir, entry.name, "manifest.json");

    if (!(await pathExists(manifestPath))) {
      continue;
    }

    const content = await fs.readFile(manifestPath, "utf8");
    manifests.push(JSON.parse(content));
  }

  return manifests.sort((left, right) => left.id.localeCompare(right.id));
}
