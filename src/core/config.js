// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";

import { getModeConfig, isModeName } from "./modes.js";
import { getProviderDefinition, isProviderId } from "./providers.js";
import { getReasoningConfig, isReasoningName } from "./reasoning.js";
import { ensureDir, pathExists } from "./utils.js";

export function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : true;

    args[key] = value;

    if (value !== true) {
      index += 1;
    }
  }

  return args;
}

export async function loadAppConfig(cwd) {
  const appDir = path.join(cwd, ".cayadev");
  const configPath = path.join(appDir, "config.json");

  if (!(await pathExists(configPath))) {
    return {
      appDir,
      configPath,
      values: {}
    };
  }

  const content = await fs.readFile(configPath, "utf8");
  const values = JSON.parse(content);

  return {
    appDir,
    configPath,
    values
  };
}

export async function saveAppConfig(configPath, values) {
  await ensureDir(path.dirname(configPath));
  await fs.writeFile(configPath, JSON.stringify(values, null, 2), "utf8");
}

export function buildRuntimeConfig(argv, cwd, storedConfig = {}) {
  const args = parseArgs(argv);
  const modeName = normalizeMode(args.mode ?? process.env.CAYA_MODE ?? storedConfig.modeName ?? "advanced");
  const sessionId = String(args.session ?? createSessionId());
  const providerId = normalizeProviderId(
    args.provider ?? process.env.CAYA_PROVIDER ?? storedConfig.providerId ?? ""
  );
  const provider = getProviderDefinition(providerId || "custom");
  const providerProtocol = normalizeProtocol(
    args.protocol ?? process.env.CAYA_PROTOCOL ?? storedConfig.providerProtocol ?? provider.protocol
  );
  const reasoningName = normalizeReasoning(
    args.thinking ??
    args.reasoning ??
    process.env.CAYA_THINKING ??
    process.env.CAYA_REASONING ??
    storedConfig.reasoningName ??
    "extra_high"
  );
  const reasoning = getReasoningConfig(reasoningName);
  const baseUrl = normalizeBaseUrl(
    String(args["base-url"] ?? process.env.CAYA_BASE_URL ?? storedConfig.baseUrl ?? provider.defaultBaseUrl ?? "")
  );
  const apiKey =
    resolveApiKey(providerId, storedConfig, args) ??
    (provider.requiresApiKey ? "" : String(storedConfig.apiKey ?? ""));
  const model = String(args.model ?? process.env.CAYA_MODEL ?? storedConfig.model ?? provider.defaultModel ?? "");
  const keepAlive = String(args["keep-alive"] ?? process.env.CAYA_KEEP_ALIVE ?? storedConfig.keepAlive ?? "24h");

  return {
    cwd,
    modeName,
    mode: getModeConfig(modeName),
    providerId,
    providerLabel: provider.label,
    providerProtocol,
    reasoningName,
    reasoning,
    model,
    baseUrl,
    apiKey,
    keepAlive,
    maxSteps: toPositiveInteger(args["max-steps"], reasoning.maxSteps),
    sessionId,
    sessionDir: path.join(cwd, ".cayadev", "sessions", sessionId)
  };
}

export function createStoredConfigFromState(state) {
  return {
    modeName: state.modeName,
    providerId: state.providerId,
    providerProtocol: state.providerProtocol,
    reasoningName: state.reasoningName,
    model: state.model,
    baseUrl: state.baseUrl,
    apiKey: state.apiKey,
    keepAlive: state.keepAlive
  };
}

function normalizeMode(mode) {
  const value = String(mode).toLowerCase();
  return isModeName(value) ? value : "advanced";
}

function normalizeProviderId(providerId) {
  const value = String(providerId ?? "").toLowerCase();
  return isProviderId(value) ? value : "";
}

function normalizeReasoning(reasoning) {
  const value = String(reasoning ?? "").toLowerCase();
  return isReasoningName(value) ? value : "extra_high";
}

function normalizeProtocol(protocol) {
  const value = String(protocol ?? "").toLowerCase();
  return value === "anthropic" || value === "ollama" ? value : "openai";
}

function normalizeBaseUrl(baseUrl) {
  const normalized = String(baseUrl ?? "").trim();
  if (!normalized) {
    return "";
  }

  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function createSessionId() {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `session-${timestamp}`;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveApiKey(providerId, storedConfig, args) {
  if (args["api-key"]) {
    return String(args["api-key"]);
  }

  if (process.env.CAYA_API_KEY) {
    return process.env.CAYA_API_KEY;
  }

  const provider = getProviderDefinition(providerId || storedConfig.providerId || "custom");
  const providerEnv = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : "";

  if (providerEnv) {
    return providerEnv;
  }

  if (storedConfig.apiKey) {
    return String(storedConfig.apiKey);
  }

  return "";
}
