// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

const PROVIDERS = {
  ollama: {
    id: "ollama",
    label: "Ollama",
    protocol: "ollama",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "",
    requiresApiKey: false,
    apiKeyEnv: "OLLAMA_API_KEY"
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    requiresApiKey: true,
    apiKeyEnv: "OPENAI_API_KEY"
  },
  anthropic: {
    id: "anthropic",
    label: "Claude / Anthropic",
    protocol: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-20250514",
    requiresApiKey: true,
    apiKeyEnv: "ANTHROPIC_API_KEY"
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-5-mini",
    requiresApiKey: true,
    apiKeyEnv: "OPENROUTER_API_KEY"
  },
  custom: {
    id: "custom",
    label: "Custom",
    protocol: "openai",
    defaultBaseUrl: "",
    defaultModel: "",
    requiresApiKey: false,
    apiKeyEnv: "CAYA_API_KEY"
  }
};

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

export function getProviderDefinition(providerId) {
  return PROVIDERS[providerId] ?? PROVIDERS.custom;
}

export function isProviderId(value) {
  return Object.hasOwn(PROVIDERS, value);
}

export function listProviders() {
  return PROVIDER_IDS.map((providerId) => getProviderDefinition(providerId));
}
