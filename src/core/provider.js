// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

function buildUrl(baseUrl, suffix) {
  const normalizedBase = String(baseUrl ?? "").replace(/\/+$/, "");
  const normalizedSuffix = String(suffix ?? "").replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedSuffix}`;
}

export async function generateAssistantMessage({
  providerProtocol,
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  keepAlive = "24h",
  signal
}) {
  if (!baseUrl) {
    throw new Error("Missing provider base URL.");
  }

  switch (providerProtocol) {
    case "anthropic":
      return generateAnthropicMessage({ apiKey, baseUrl, model, messages, temperature, signal });
    case "ollama":
      return generateOllamaMessage({ apiKey, baseUrl, model, messages, temperature, keepAlive, signal });
    default:
      return generateOpenAiCompatibleMessage({ apiKey, baseUrl, model, messages, temperature, signal });
  }
}

export async function listAvailableModels({
  providerProtocol,
  apiKey,
  baseUrl
}) {
  if (!baseUrl) {
    return [];
  }

  try {
    switch (providerProtocol) {
      case "anthropic":
        return await listAnthropicModels({ apiKey, baseUrl });
      case "ollama":
        return await listOllamaModels({ apiKey, baseUrl });
      default:
        return await listOpenAiCompatibleModels({ apiKey, baseUrl });
    }
  } catch {
    return [];
  }
}

export async function shutdownProviderModels({
  providerProtocol,
  apiKey,
  baseUrl,
  model
}) {
  if (providerProtocol !== "ollama" || !baseUrl) {
    return {
      attemptedCount: 0,
      stoppedCount: 0,
      failedCount: 0,
      errors: []
    };
  }

  const headers = {};

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const runningModels = await listRunningOllamaModels({ headers, baseUrl });
  const fallbackModel = String(model ?? "").trim();
  const candidateModels = runningModels.length > 0
    ? runningModels
    : fallbackModel
      ? [fallbackModel]
      : [];
  const modelsToStop = [...new Set(candidateModels)];
  const errors = [];
  let stoppedCount = 0;

  for (const runningModel of modelsToStop) {
    try {
      const response = await fetchWithTimeout(buildUrl(baseUrl, "api/generate"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers
        },
        body: JSON.stringify({
          model: runningModel,
          prompt: "",
          stream: false,
          keep_alive: 0
        })
      });

      if (response.ok) {
        stoppedCount += 1;
        continue;
      }

      errors.push(`${runningModel} (${response.status})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${runningModel} (${message})`);
    }
  }

  return {
    attemptedCount: modelsToStop.length,
    stoppedCount,
    failedCount: errors.length,
    errors
  };
}

async function generateOpenAiCompatibleMessage({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  signal
}) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(buildUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Provider request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  return extractTextContent(content, "OpenAI-compatible provider response was missing content.");
}

async function generateAnthropicMessage({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  signal
}) {
  if (!apiKey) {
    throw new Error("Missing API key for Claude / Anthropic.");
  }

  const { system, conversation } = toAnthropicPayload(messages);
  const response = await fetch(buildUrl(baseUrl, "v1/messages"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature,
      system,
      messages: conversation
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Provider request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const content = Array.isArray(data?.content)
    ? data.content
        .filter((entry) => entry?.type === "text")
        .map((entry) => entry.text ?? "")
        .join("")
        .trim()
    : "";

  if (!content) {
    throw new Error("Anthropic response was missing text content.");
  }

  return content;
}

async function generateOllamaMessage({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  keepAlive,
  signal
}) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const chatRequest = {
    model,
    stream: false,
    keep_alive: keepAlive,
    options: {
      temperature
    },
    messages
  };

  try {
    const response = await fetch(buildUrl(baseUrl, "api/chat"), {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify(chatRequest)
    });

    if (response.ok) {
      const data = await response.json();
      const content = extractOllamaChatContent(data);

      if (content) {
        return content;
      }
    }
  } catch (error) {
    if (isAbortLike(error)) {
      throw error;
    }
  }

  return generateOllamaFallbackMessage({
    apiKey,
    baseUrl,
    model,
    messages,
    temperature,
    keepAlive,
    signal
  });
}

async function listOpenAiCompatibleModels({ apiKey, baseUrl }) {
  const headers = {};

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(buildUrl(baseUrl, "models"), {
    headers
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data?.data)
    ? data.data
        .map((entry) => entry?.id)
        .filter(Boolean)
        .slice(0, 100)
    : [];
}

async function listAnthropicModels({ apiKey, baseUrl }) {
  if (!apiKey) {
    return [];
  }

  const response = await fetch(buildUrl(baseUrl, "v1/models"), {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data?.data)
    ? data.data
        .map((entry) => entry?.id)
        .filter(Boolean)
        .slice(0, 100)
    : [];
}

async function listOllamaModels({ apiKey, baseUrl }) {
  const headers = {};

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(buildUrl(baseUrl, "api/tags"), {
    headers
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  return Array.isArray(data?.models)
    ? data.models
        .map((entry) => entry?.name)
        .filter(Boolean)
        .slice(0, 100)
    : [];
}

async function listRunningOllamaModels({ headers, baseUrl }) {
  try {
    const response = await fetchWithTimeout(buildUrl(baseUrl, "api/ps"), {
      headers
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data?.models)
      ? data.models
          .map((entry) => String(entry?.name ?? entry?.model ?? "").trim())
          .filter(Boolean)
          .slice(0, 64)
      : [];
  } catch {
    return [];
  }
}

function toAnthropicPayload(messages) {
  const systemParts = [];
  const conversation = [];

  messages.forEach((message) => {
    if (message.role === "system") {
      systemParts.push(String(message.content ?? ""));
      return;
    }

    if (message.role === "user" || message.role === "assistant") {
      conversation.push({
        role: message.role,
        content: String(message.content ?? "")
      });
    }
  });

  return {
    system: systemParts.join("\n\n"),
    conversation
  };
}

function extractTextContent(content, errorMessage) {
  if (Array.isArray(content)) {
    const text = content
      .map((part) => part?.text ?? "")
      .join("")
      .trim();

    if (text) {
      return text;
    }
  }

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  throw new Error(errorMessage);
}

function extractOllamaChatContent(data) {
  const candidates = [
    data?.message?.content,
    data?.message?.text,
    data?.response,
    data?.content,
    data?.output_text,
    data?.text
  ];

  for (const candidate of candidates) {
    try {
      return extractTextContent(candidate, "");
    } catch {
      // Try the next candidate.
    }
  }

  return "";
}

async function generateOllamaFallbackMessage({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  keepAlive,
  signal
}) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(buildUrl(baseUrl, "api/generate"), {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: keepAlive,
      options: {
        temperature
      },
      prompt: toOllamaGeneratePrompt(messages)
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed on both chat and generate endpoints (${response.status}): ${body}`);
  }

  const data = await response.json();
  const content = extractOllamaChatContent(data);

  if (content) {
    return content;
  }

  throw new Error("Ollama response was missing usable text content on both chat and generate endpoints.");
}

function toOllamaGeneratePrompt(messages) {
  return messages
    .map((message) => {
      const role = String(message?.role ?? "user").toUpperCase();
      const content = String(message?.content ?? "").trim();
      return `${role}:\n${content}`;
    })
    .join("\n\n") + "\n\nASSISTANT:\n";
}

function isAbortLike(error) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

async function fetchWithTimeout(url, options, timeoutMs = 3500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}
