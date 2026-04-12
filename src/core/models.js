// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

/**
 * Model management system - Presets, capabilities, and recommended configurations
 * for known models across providers.
 */

const MODEL_PRESETS = {
  // OpenAI models
  "gpt-5": {
    provider: "openai",
    label: "GPT-5",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    recommendedTimeout: 15 * 60 * 1000,
    capabilities: ["code", "reasoning", "vision", "tools"],
    tier: "flagship",
    costTier: "high"
  },
  "gpt-5-mini": {
    provider: "openai",
    label: "GPT-5 Mini",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    recommendedTimeout: 10 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools"],
    tier: "balanced",
    costTier: "low"
  },
  "gpt-4.1": {
    provider: "openai",
    label: "GPT-4.1",
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    recommendedTimeout: 15 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools"],
    tier: "flagship",
    costTier: "medium"
  },
  "gpt-4.1-mini": {
    provider: "openai",
    label: "GPT-4.1 Mini",
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    recommendedTimeout: 10 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools"],
    tier: "balanced",
    costTier: "low"
  },
  "gpt-4.1-nano": {
    provider: "openai",
    label: "GPT-4.1 Nano",
    contextWindow: 1047576,
    maxOutputTokens: 16384,
    recommendedTimeout: 5 * 60 * 1000,
    capabilities: ["code", "tools"],
    tier: "fast",
    costTier: "very_low"
  },
  "o3": {
    provider: "openai",
    label: "o3",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    recommendedTimeout: 30 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools", "deep_thinking"],
    tier: "reasoning",
    costTier: "high"
  },
  "o3-mini": {
    provider: "openai",
    label: "o3-mini",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    recommendedTimeout: 20 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools", "deep_thinking"],
    tier: "reasoning",
    costTier: "medium"
  },
  "o4-mini": {
    provider: "openai",
    label: "o4-mini",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    recommendedTimeout: 20 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools", "deep_thinking"],
    tier: "reasoning",
    costTier: "medium"
  },

  // Anthropic models
  "claude-sonnet-4-20250514": {
    provider: "anthropic",
    label: "Claude Sonnet 4",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    recommendedTimeout: 20 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools", "deep_thinking"],
    tier: "flagship",
    costTier: "medium"
  },
  "claude-opus-4-20250514": {
    provider: "anthropic",
    label: "Claude Opus 4",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    recommendedTimeout: 30 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools", "deep_thinking"],
    tier: "flagship",
    costTier: "high"
  },
  "claude-3-5-haiku-20241022": {
    provider: "anthropic",
    label: "Claude 3.5 Haiku",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    recommendedTimeout: 10 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools"],
    tier: "fast",
    costTier: "low"
  },

  // Common Ollama models
  "llama3.3:70b": {
    provider: "ollama",
    label: "Llama 3.3 70B",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    recommendedTimeout: 30 * 60 * 1000,
    capabilities: ["code", "reasoning"],
    tier: "flagship",
    costTier: "local"
  },
  "llama3.2:latest": {
    provider: "ollama",
    label: "Llama 3.2",
    contextWindow: 131072,
    maxOutputTokens: 4096,
    recommendedTimeout: 15 * 60 * 1000,
    capabilities: ["code", "reasoning"],
    tier: "balanced",
    costTier: "local"
  },
  "qwen2.5-coder:32b": {
    provider: "ollama",
    label: "Qwen 2.5 Coder 32B",
    contextWindow: 32768,
    maxOutputTokens: 8192,
    recommendedTimeout: 30 * 60 * 1000,
    capabilities: ["code", "reasoning"],
    tier: "flagship",
    costTier: "local"
  },
  "qwen2.5-coder:7b": {
    provider: "ollama",
    label: "Qwen 2.5 Coder 7B",
    contextWindow: 32768,
    maxOutputTokens: 4096,
    recommendedTimeout: 10 * 60 * 1000,
    capabilities: ["code"],
    tier: "fast",
    costTier: "local"
  },
  "deepseek-coder-v2:16b": {
    provider: "ollama",
    label: "DeepSeek Coder V2 16B",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    recommendedTimeout: 20 * 60 * 1000,
    capabilities: ["code", "reasoning"],
    tier: "balanced",
    costTier: "local"
  },
  "codellama:34b": {
    provider: "ollama",
    label: "Code Llama 34B",
    contextWindow: 16384,
    maxOutputTokens: 4096,
    recommendedTimeout: 20 * 60 * 1000,
    capabilities: ["code"],
    tier: "balanced",
    costTier: "local"
  },
  "mistral:latest": {
    provider: "ollama",
    label: "Mistral",
    contextWindow: 32768,
    maxOutputTokens: 4096,
    recommendedTimeout: 10 * 60 * 1000,
    capabilities: ["code", "reasoning"],
    tier: "fast",
    costTier: "local"
  },
  "gemma2:27b": {
    provider: "ollama",
    label: "Gemma 2 27B",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    recommendedTimeout: 15 * 60 * 1000,
    capabilities: ["code", "reasoning"],
    tier: "balanced",
    costTier: "local"
  },

  // OpenRouter popular models
  "openai/gpt-5-mini": {
    provider: "openrouter",
    label: "GPT-5 Mini (OpenRouter)",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    recommendedTimeout: 10 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools"],
    tier: "balanced",
    costTier: "low"
  },
  "anthropic/claude-sonnet-4": {
    provider: "openrouter",
    label: "Claude Sonnet 4 (OpenRouter)",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    recommendedTimeout: 20 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools", "deep_thinking"],
    tier: "flagship",
    costTier: "medium"
  },
  "google/gemini-2.5-pro": {
    provider: "openrouter",
    label: "Gemini 2.5 Pro (OpenRouter)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    recommendedTimeout: 20 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools", "deep_thinking"],
    tier: "flagship",
    costTier: "medium"
  },
  "google/gemini-2.5-flash": {
    provider: "openrouter",
    label: "Gemini 2.5 Flash (OpenRouter)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    recommendedTimeout: 10 * 60 * 1000,
    capabilities: ["code", "reasoning", "tools"],
    tier: "fast",
    costTier: "low"
  },
  "deepseek/deepseek-r1": {
    provider: "openrouter",
    label: "DeepSeek R1 (OpenRouter)",
    contextWindow: 64000,
    maxOutputTokens: 8192,
    recommendedTimeout: 30 * 60 * 1000,
    capabilities: ["code", "reasoning", "deep_thinking"],
    tier: "reasoning",
    costTier: "low"
  }
};

/**
 * Look up a model preset by exact name or fuzzy match.
 * Returns null if no preset found.
 */
export function getModelPreset(modelName) {
  const name = String(modelName ?? "").trim().toLowerCase();
  if (!name) return null;

  // Exact match
  if (MODEL_PRESETS[modelName]) return { ...MODEL_PRESETS[modelName], modelId: modelName };

  // Case-insensitive match
  for (const [key, preset] of Object.entries(MODEL_PRESETS)) {
    if (key.toLowerCase() === name) {
      return { ...preset, modelId: key };
    }
  }

  // Partial match (e.g. "gpt-5" matches "gpt-5")
  for (const [key, preset] of Object.entries(MODEL_PRESETS)) {
    if (name.includes(key.toLowerCase()) || key.toLowerCase().includes(name)) {
      return { ...preset, modelId: key };
    }
  }

  return null;
}

/**
 * Get recommended timeout for a model name. Returns null if unknown.
 */
export function getModelRecommendedTimeout(modelName) {
  const preset = getModelPreset(modelName);
  return preset?.recommendedTimeout ?? null;
}

/**
 * Get the capabilities list for a model. Returns empty array if unknown.
 */
export function getModelCapabilities(modelName) {
  const preset = getModelPreset(modelName);
  return preset?.capabilities ?? [];
}

/**
 * Check if a model supports deep thinking (extended reasoning).
 */
export function isDeepThinkingModel(modelName) {
  const caps = getModelCapabilities(modelName);
  return caps.includes("deep_thinking");
}

/**
 * Get model info summary string for display.
 */
export function getModelInfoSummary(modelName) {
  const preset = getModelPreset(modelName);
  if (!preset) return null;

  const parts = [preset.label];
  parts.push(`Context: ${formatTokenCount(preset.contextWindow)}`);
  parts.push(`Max output: ${formatTokenCount(preset.maxOutputTokens)}`);
  parts.push(`Tier: ${preset.tier}`);
  parts.push(`Cost: ${preset.costTier}`);

  if (preset.capabilities.length > 0) {
    parts.push(`Capabilities: ${preset.capabilities.join(", ")}`);
  }

  return parts.join(" | ");
}

/**
 * List presets filtered by provider.
 */
export function listModelPresetsForProvider(providerId) {
  return Object.entries(MODEL_PRESETS)
    .filter(([, preset]) => preset.provider === providerId)
    .map(([key, preset]) => ({ modelId: key, ...preset }));
}

/**
 * Get the recommended mode for a model based on its capabilities.
 */
export function getRecommendedMode(modelName) {
  const preset = getModelPreset(modelName);
  if (!preset) return "normal";

  if (preset.tier === "flagship" || preset.tier === "reasoning") return "advanced";
  if (preset.tier === "balanced") return "medium";
  if (preset.tier === "fast") return "normal";
  return "low";
}

/**
 * Get the recommended thinking level for a model.
 */
export function getRecommendedThinking(modelName) {
  const preset = getModelPreset(modelName);
  if (!preset) return "medium";

  if (preset.capabilities.includes("deep_thinking")) return "extra_high";
  if (preset.tier === "flagship") return "high";
  if (preset.tier === "balanced") return "medium";
  return "low";
}

function formatTokenCount(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(0)}K`;
  return String(count);
}
