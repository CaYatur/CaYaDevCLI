// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

// Default timeout values (in milliseconds)
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for model responses
const EXTENDED_REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes for very long thinking
const STREAM_CHUNK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes between streaming chunks before considering hung
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

// Ollama-specific timeouts: local models can be extremely slow (loading, quantizing, CPU inference)
// A single token can take 600+ seconds on weak hardware, so we must be very patient.
const OLLAMA_INITIAL_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour for first response (model loading)
const OLLAMA_STREAM_CHUNK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes between chunks (slow CPU inference)
const OLLAMA_MAX_RETRY_ATTEMPTS = 10; // More retries for local connection issues

// Direct HTTP request for Ollama (bypasses Node.js fetch/undici internal timeouts).
// Node.js native fetch uses undici which has hidden bodyTimeout/headersTimeout/connectTimeout
// that cannot be configured without importing undici (which isn't always available).
// Using node:http directly eliminates all intermediate timeout layers.
function ollamaHttpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "GET",
        headers: options.headers,
        timeout: 0
      },
      (res) => {
        // Disable Node.js socket timeout entirely
        res.socket?.setTimeout?.(0);

        // Convert Node.js stream to Web ReadableStream so getReader() works
        let webStream;
        try {
          webStream = Readable.toWeb(res);
        } catch {
          // Fallback: wrap the node stream manually
          webStream = new ReadableStream({
            start(controller) {
              res.on("data", (chunk) => controller.enqueue(chunk));
              res.on("end", () => controller.close());
              res.on("error", (err) => controller.error(err));
            }
          });
        }

        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: {
            get: (name) => res.headers[name.toLowerCase()]
          },
          body: webStream,
          text: () =>
            new Promise((r, j) => {
              let data = "";
              res.setEncoding("utf-8");
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () => r(data));
              res.on("error", j);
            })
        });
      }
    );

    // Handle abort signal
    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy();
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        return;
      }
      options.signal.addEventListener(
        "abort",
        () => {
          req.destroy();
        },
        { once: true }
      );
    }

    req.on("error", (err) => {
      if (options.signal?.aborted) {
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      } else {
        reject(new TypeError(`fetch failed: ${err.message}`));
      }
    });

    // Disable all socket-level timeouts
    req.setTimeout(0);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// Reference to the native fetch so we can detect test mocking
const _nativeFetch = globalThis.fetch;

// Fetch wrapper for Ollama: uses node:http to bypass undici's internal timeouts,
// but transparently falls back to global.fetch when it's been mocked (e.g. in tests).
function ollamaFetch(url, options) {
  if (globalThis.fetch !== _nativeFetch) {
    return globalThis.fetch(url, options);
  }
  return ollamaHttpFetch(url, options);
}

// Combine two AbortSignals so either one can abort
function combineSignals(externalSignal, timeoutSignal) {
  if (!externalSignal) return timeoutSignal;
  if (!timeoutSignal) return externalSignal;

  const controller = new AbortController();
  const abort = () => controller.abort();

  if (externalSignal.aborted || timeoutSignal.aborted) {
    controller.abort();
    return controller.signal;
  }

  externalSignal.addEventListener("abort", abort, { once: true });
  timeoutSignal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

// Custom error classes for better error handling
export class ProviderError extends Error {
  constructor(message, type = "unknown", details = {}) {
    super(message);
    this.name = "ProviderError";
    this.type = type;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

export class NetworkError extends ProviderError {
  constructor(message, details = {}) {
    super(message, "network", details);
    this.name = "NetworkError";
    this.retryable = true;
    this.partialContent = details.partialContent || "";
  }
}

export class TimeoutError extends ProviderError {
  constructor(message, timeoutMs, details = {}) {
    super(message, "timeout", { ...details, timeoutMs });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
    this.retryable = true;
  }
}

export class ServerError extends ProviderError {
  constructor(message, statusCode, details = {}) {
    super(message, "server", { ...details, statusCode });
    this.name = "ServerError";
    this.statusCode = statusCode;
    this.retryable = statusCode >= 500 && statusCode < 600;
  }
}

export class RateLimitError extends ProviderError {
  constructor(message, retryAfter = null, details = {}) {
    super(message, "rate_limit", { ...details, retryAfter });
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
    this.retryable = true;
  }
}

function buildUrl(baseUrl, suffix) {
  const normalizedBase = String(baseUrl ?? "").replace(/\/+$/, "");
  const normalizedSuffix = String(suffix ?? "").replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedSuffix}`;
}

// Sleep utility for retry delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Calculate exponential backoff delay
function getRetryDelay(attempt, baseDelay = RETRY_BASE_DELAY_MS) {
  const delay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(delay + jitter, 60000); // Cap at 60 seconds
}

// Wrap fetch with timeout support and better error handling
async function fetchWithTimeoutAndRetry(url, options = {}, config = {}) {
  const {
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries = MAX_RETRY_ATTEMPTS,
    retryOn = ["network", "timeout", "server_5xx"],
    onRetry = null,
    signal: externalSignal = null
  } = config;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    let timeout = null;

    // Link external signal (e.g., user abort) to our controller
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw new ProviderError("Request aborted by user", "aborted");
      }
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      // Set up timeout
      timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeout);

      // Check for rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
        throw new RateLimitError(
          `Rate limit exceeded. ${retryAfter ? `Retry after ${retryAfter} seconds.` : "Please wait before retrying."}`,
          retryAfterMs
        );
      }

      // Check for server errors (5xx)
      if (response.status >= 500 && response.status < 600) {
        const body = await response.text().catch(() => "");
        throw new ServerError(
          `Server error (${response.status}): ${body.slice(0, 200) || "No details available"}`,
          response.status
        );
      }

      return response;
    } catch (error) {
      clearTimeout(timeout);

      // Handle user abort - don't retry
      if (externalSignal?.aborted || error.name === "AbortError" && !timeout) {
        throw new ProviderError("Request aborted by user", "aborted");
      }

      // Handle timeout
      if (error.name === "AbortError") {
        lastError = new TimeoutError(
          `Request timed out after ${Math.round(timeoutMs / 1000)} seconds. The model may be taking longer than expected to respond.`,
          timeoutMs,
          { url, attempt }
        );
      }
      // Handle network errors
      else if (error.name === "TypeError" || error.message?.includes("fetch")) {
        lastError = new NetworkError(
          error.message || "Connection failed",
          { url, attempt, originalError: error.message }
        );
      }
      // Keep our custom errors
      else if (error instanceof ProviderError) {
        lastError = error;
      }
      // Unknown errors
      else {
        lastError = new ProviderError(
          error.message || "Unknown error occurred",
          "unknown",
          { url, attempt, originalError: error.message }
        );
      }

      // Check if we should retry
      const shouldRetry =
        attempt < maxRetries &&
        lastError.retryable &&
        !externalSignal?.aborted &&
        (
          (retryOn.includes("network") && lastError instanceof NetworkError) ||
          (retryOn.includes("timeout") && lastError instanceof TimeoutError) ||
          (retryOn.includes("server_5xx") && lastError instanceof ServerError) ||
          (retryOn.includes("rate_limit") && lastError instanceof RateLimitError)
        );

      if (shouldRetry) {
        let delayMs;

        // For rate limits, use the server's suggested delay if available
        if (lastError instanceof RateLimitError && lastError.retryAfter) {
          delayMs = lastError.retryAfter;
        } else {
          delayMs = getRetryDelay(attempt);
        }

        // Notify about retry if callback provided
        if (onRetry) {
          onRetry({
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: lastError
          });
        }

        await sleep(delayMs);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError;
}

export async function generateAssistantMessage({
  providerProtocol,
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  keepAlive = "24h",
  signal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxRetries = MAX_RETRY_ATTEMPTS,
  onRetry = null,
  onToken = null
}) {
  if (!baseUrl) {
    throw new ProviderError("Missing provider base URL.", "configuration");
  }

  const retryConfig = {
    timeoutMs,
    maxRetries,
    signal,
    onRetry
  };

  switch (providerProtocol) {
    case "anthropic":
      return generateAnthropicMessage({ apiKey, baseUrl, model, messages, temperature, signal, retryConfig });
    case "ollama":
      return generateOllamaMessage({ apiKey, baseUrl, model, messages, temperature, keepAlive, signal, retryConfig, onToken });
    default:
      return generateOpenAiCompatibleMessage({ apiKey, baseUrl, model, messages, temperature, signal, retryConfig, onToken });
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
  signal,
  retryConfig = {},
  onToken = null
}) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const url = buildUrl(baseUrl, "chat/completions");
  const requestBody = JSON.stringify({
    model,
    temperature,
    messages,
    stream: true
  });

  const timeoutMs = retryConfig.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = retryConfig.maxRetries ?? MAX_RETRY_ATTEMPTS;
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Create a timeout controller that aborts if the total request exceeds timeoutMs
    const timeoutController = new AbortController();
    const combinedSignal = combineSignals(retryConfig.signal || signal, timeoutController.signal);
    let requestTimer = setTimeout(() => timeoutController.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        signal: combinedSignal,
        body: requestBody
      });

      if (!response.ok) {
        const body = await response.text();
        throw new ServerError(`Provider request failed (${response.status}): ${body}`, response.status);
      }

      // Read OpenAI-compatible streaming response with rolling timeout
      const content = await readOpenAiStreamResponse(response, combinedSignal, () => {
        // Reset timeout on each chunk to allow long but active streams
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => timeoutController.abort(), STREAM_CHUNK_TIMEOUT_MS);
      }, onToken);
      clearTimeout(requestTimer);
      return extractTextContent(content, "OpenAI-compatible provider response was missing content.");
    } catch (error) {
      clearTimeout(requestTimer);

      // Detect timeout abort vs user abort
      if (timeoutController.signal.aborted && !(retryConfig.signal || signal)?.aborted) {
        lastError = new TimeoutError(
          `Request timed out after ${Math.round(timeoutMs / 1000)} seconds. The model may be taking longer than expected to respond.`,
          timeoutMs,
          { url, attempt }
        );
      } else if (isAbortLike(error) || error?.type === "aborted") {
        throw error;
      } else {
        lastError = error;
      }
      
      // Check if we should retry
      const isRetryable = 
        lastError instanceof TimeoutError ||
        error.name === "TypeError" || 
        error.message?.includes("fetch") ||
        error.message?.includes("network") ||
        error.message?.includes("Stream") ||
        (error instanceof ServerError && error.statusCode >= 500);
      
      if (isRetryable && attempt < maxRetries) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
        
        if (retryConfig.onRetry) {
          retryConfig.onRetry({
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: lastError instanceof TimeoutError ? lastError : new NetworkError(error.message || "Connection failed")
          });
        }
        
        await sleep(delayMs);
        continue;
      }
      
      throw lastError;
    }
  }
  
  throw lastError || new ProviderError("Max retries reached", "max_retries");
}

// Read OpenAI-compatible streaming response (SSE format)
async function readOpenAiStreamResponse(response, signal, onChunk = null, onToken = null) {
  if (!response.body) {
    throw new ProviderError("Response body is not available for streaming", "stream_error");
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let buffer = "";

  try {
    while (true) {
      // Check for abort before reading
      if (signal?.aborted) {
        await reader.cancel();
        throw new ProviderError("Request aborted by user", "aborted");
      }
      
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      
      // Process SSE lines (data: {...})
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        
        if (!trimmed || trimmed === "data: [DONE]") {
          continue;
        }
        
        if (trimmed.startsWith("data: ")) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data?.choices?.[0]?.delta?.content || "";
            if (delta) {
              content += delta;
              if (onChunk) onChunk();
              if (onToken) onToken(delta);
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
    
    return content.trim();
  } catch (error) {
    // Re-throw abort errors
    if (isAbortLike(error) || error?.type === "aborted") {
      throw error;
    }
    
    // Convert stream errors to NetworkError with partial content preserved
    throw new NetworkError(
      `Stream reading failed: ${error.message || "Unknown error"}`,
      { originalError: error.message, partialContent: content }
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors
    }
  }
}

async function generateAnthropicMessage({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  signal,
  retryConfig = {}
}) {
  if (!apiKey) {
    throw new ProviderError("Missing API key for Claude / Anthropic.", "configuration");
  }

  const { system, conversation } = toAnthropicPayload(messages);
  const url = buildUrl(baseUrl, "v1/messages");

  const response = await fetchWithTimeoutAndRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature,
        system,
        messages: conversation
      })
    },
    {
      timeoutMs: retryConfig.timeoutMs || EXTENDED_REQUEST_TIMEOUT_MS, // Anthropic/Claude can have very long thinking times
      maxRetries: retryConfig.maxRetries ?? MAX_RETRY_ATTEMPTS,
      signal: retryConfig.signal || signal,
      onRetry: retryConfig.onRetry
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new ServerError(`Provider request failed (${response.status}): ${body}`, response.status);
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
    throw new ProviderError("Anthropic response was missing text content.", "empty_response");
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
  signal,
  retryConfig = {},
  onToken = null
}) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // Use streaming to prevent connection timeouts on long responses
  const chatRequest = {
    model,
    stream: true,
    keep_alive: keepAlive,
    options: {
      temperature
    },
    messages
  };

  // Ollama runs locally - use very generous timeouts.
  // Model loading alone can take minutes, and slow hardware may produce 1 token per 10+ minutes.
  let lastError = null;
  const maxRetries = retryConfig.maxRetries ?? OLLAMA_MAX_RETRY_ATTEMPTS;
  const initialTimeoutMs = Math.max(retryConfig.timeoutMs || OLLAMA_INITIAL_TIMEOUT_MS, OLLAMA_INITIAL_TIMEOUT_MS);
  const chunkTimeoutMs = OLLAMA_STREAM_CHUNK_TIMEOUT_MS;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutController = new AbortController();
    const combinedSignal = combineSignals(retryConfig.signal || signal, timeoutController.signal);
    let requestTimer = setTimeout(() => timeoutController.abort(), initialTimeoutMs);

    try {
      const response = await ollamaFetch(buildUrl(baseUrl, "api/chat"), {
        method: "POST",
        headers,
        signal: combinedSignal,
        body: JSON.stringify(chatRequest)
      });

      if (!response.ok) {
        const body = await response.text();
        throw new ServerError(`Ollama request failed (${response.status}): ${body}`, response.status);
      }

      // Read streaming response with very generous rolling timeout for local models
      const content = await readOllamaStreamResponse(response, combinedSignal, () => {
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => timeoutController.abort(), chunkTimeoutMs);
      }, onToken);
      clearTimeout(requestTimer);
      
      if (content) {
        return content;
      }
      
      // Empty response - fall through to fallback
      break;
    } catch (error) {
      clearTimeout(requestTimer);

      // User abort - stop immediately
      if ((retryConfig.signal || signal)?.aborted) {
        throw new ProviderError("Request aborted by user", "aborted");
      }
      if (isAbortLike(error) || error?.type === "aborted") {
        // Timeout abort (not user abort) - classify as timeout
        if (timeoutController.signal.aborted) {
          lastError = new TimeoutError(
            `Ollama request timed out after ${Math.round(initialTimeoutMs / 60000)} minutes. The model may still be loading or processing.`,
            initialTimeoutMs,
            { url: buildUrl(baseUrl, "api/chat"), attempt }
          );
        } else {
          throw error;
        }
      } else {
        lastError = error;
      }
      
      // For Ollama, only retry on actual connection failures, not timeouts during streaming
      // (timeouts mean the model is working but slow - retrying would restart from scratch)
      const isConnectionError = 
        error.name === "TypeError" || 
        error.message?.includes("fetch failed") ||
        error.message?.includes("ECONNREFUSED") ||
        error.message?.includes("ECONNRESET") ||
        error.message?.includes("ETIMEDOUT") ||
        error.message?.includes("socket hang up") ||
        (error instanceof ServerError && error.statusCode >= 500);
      
      const isStreamTimeout = lastError instanceof TimeoutError;
      
      // Retry connection errors with short delays (Ollama might be restarting)
      // Retry timeouts with longer delays (model might need more time)
      if (attempt < maxRetries && (isConnectionError || isStreamTimeout)) {
        const delayMs = isConnectionError
          ? Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000, 15000)
          : 3000; // Short delay before retrying timeout (model is still loaded)
        
        if (retryConfig.onRetry) {
          retryConfig.onRetry({
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: lastError instanceof TimeoutError ? lastError : new NetworkError(error.message || "Connection failed"),
            isOllama: true
          });
        }
        
        await sleep(delayMs);
        continue;
      }
      
      // Not retryable or max retries reached - try fallback
      break;
    }
  }

  // Try fallback endpoint
  return generateOllamaFallbackMessage({
    apiKey,
    baseUrl,
    model,
    messages,
    temperature,
    keepAlive,
    signal,
    retryConfig,
    onToken
  });
}

// Read Ollama streaming response and accumulate content
async function readOllamaStreamResponse(response, signal, onChunk = null, onToken = null) {
  if (!response.body) {
    throw new ProviderError("Response body is not available for streaming", "stream_error");
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let buffer = "";

  try {
    while (true) {
      // Check for abort before reading
      if (signal?.aborted) {
        await reader.cancel();
        throw new ProviderError("Request aborted by user", "aborted");
      }
      
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      
      // Process complete JSON lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const data = JSON.parse(line);
          
          // Extract content from streaming chunk
          const chunk = data?.message?.content || data?.response || "";
          if (chunk) {
            content += chunk;
            if (onChunk) onChunk();
            if (onToken) onToken(chunk);
          }
          
          // Check if stream is done
          if (data?.done === true) {
            return content.trim();
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
    
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer);
        const chunk = data?.message?.content || data?.response || "";
        if (chunk) {
          content += chunk;
        }
      } catch {
        // Ignore parsing errors for final buffer
      }
    }
    
    return content.trim();
  } catch (error) {
    // Re-throw abort errors
    if (isAbortLike(error) || error?.type === "aborted") {
      throw error;
    }
    
    // Convert stream errors to NetworkError with partial content preserved
    throw new NetworkError(
      `Stream reading failed: ${error.message || "Unknown error"}`,
      { originalError: error.message, partialContent: content }
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors
    }
  }
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
  signal,
  retryConfig = {},
  onToken = null
}) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const requestBody = JSON.stringify({
    model,
    stream: true,
    keep_alive: keepAlive,
    options: {
      temperature
    },
    prompt: toOllamaGeneratePrompt(messages)
  });

  // Ollama fallback: same generous timeouts as the chat endpoint
  const maxRetries = retryConfig.maxRetries ?? OLLAMA_MAX_RETRY_ATTEMPTS;
  const initialTimeoutMs = Math.max(retryConfig.timeoutMs || OLLAMA_INITIAL_TIMEOUT_MS, OLLAMA_INITIAL_TIMEOUT_MS);
  const chunkTimeoutMs = OLLAMA_STREAM_CHUNK_TIMEOUT_MS;
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutController = new AbortController();
    const combinedSignal = combineSignals(retryConfig.signal || signal, timeoutController.signal);
    let requestTimer = setTimeout(() => timeoutController.abort(), initialTimeoutMs);

    try {
      const response = await ollamaFetch(buildUrl(baseUrl, "api/generate"), {
        method: "POST",
        headers,
        signal: combinedSignal,
        body: requestBody
      });

      if (!response.ok) {
        const body = await response.text();
        throw new ServerError(`Ollama request failed on generate endpoint (${response.status}): ${body}`, response.status);
      }

      // Read streaming response with generous rolling timeout
      const content = await readOllamaStreamResponse(response, combinedSignal, () => {
        clearTimeout(requestTimer);
        requestTimer = setTimeout(() => timeoutController.abort(), chunkTimeoutMs);
      }, onToken);
      clearTimeout(requestTimer);

      if (content) {
        return content;
      }
      
      break; // Empty response
    } catch (error) {
      clearTimeout(requestTimer);

      // User abort
      if ((retryConfig.signal || signal)?.aborted) {
        throw new ProviderError("Request aborted by user", "aborted");
      }
      if (isAbortLike(error) || error?.type === "aborted") {
        if (timeoutController.signal.aborted) {
          lastError = new TimeoutError(
            `Ollama fallback timed out after ${Math.round(initialTimeoutMs / 60000)} minutes.`,
            initialTimeoutMs,
            { url: buildUrl(baseUrl, "api/generate"), attempt }
          );
        } else {
          throw error;
        }
      } else {
        lastError = error;
      }
      
      // Same retry logic as main Ollama endpoint
      const isConnectionError = 
        error.name === "TypeError" || 
        error.message?.includes("fetch failed") ||
        error.message?.includes("ECONNREFUSED") ||
        error.message?.includes("ECONNRESET") ||
        error.message?.includes("ETIMEDOUT") ||
        error.message?.includes("socket hang up") ||
        (error instanceof ServerError && error.statusCode >= 500);
      
      const isStreamTimeout = lastError instanceof TimeoutError;
      
      if (attempt < maxRetries && (isConnectionError || isStreamTimeout)) {
        const delayMs = isConnectionError
          ? Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000, 15000)
          : 3000;
        
        if (retryConfig.onRetry) {
          retryConfig.onRetry({
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: lastError instanceof TimeoutError ? lastError : new NetworkError(error.message || "Connection failed"),
            isOllama: true
          });
        }
        
        await sleep(delayMs);
        continue;
      }
      
      // Max retries reached
      throw lastError;
    }
  }

  throw new ProviderError("Ollama response was missing usable text content on both chat and generate endpoints.", "empty_response");
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
