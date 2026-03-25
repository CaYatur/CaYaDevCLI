import assert from "node:assert/strict";

import { generateAssistantMessage } from "../src/core/provider.js";

async function run(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await run("ollama falls back to generate when chat content is missing", async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));

    if (String(url).endsWith("/api/chat")) {
      return {
        ok: true,
        async json() {
          return {
            message: {
              role: "assistant"
            }
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          response: "Hello from generate fallback."
        };
      }
    };
  };

  try {
    const result = await generateAssistantMessage({
      providerProtocol: "ollama",
      apiKey: "",
      baseUrl: "http://localhost:11434",
      model: "glm-4.7-flash:latest",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      signal: undefined
    });

    assert.equal(result, "Hello from generate fallback.");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /\/api\/chat$/);
    assert.match(calls[1], /\/api\/generate$/);
  } finally {
    global.fetch = originalFetch;
  }
});

await run("ollama uses chat response directly when content exists", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;

  global.fetch = async () => {
    callCount += 1;
    return {
      ok: true,
      async json() {
        return {
          message: {
            role: "assistant",
            content: "Hello from chat."
          }
        };
      }
    };
  };

  try {
    const result = await generateAssistantMessage({
      providerProtocol: "ollama",
      apiKey: "",
      baseUrl: "http://localhost:11434",
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      signal: undefined
    });

    assert.equal(result, "Hello from chat.");
    assert.equal(callCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
