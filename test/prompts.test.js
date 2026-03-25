import assert from "node:assert/strict";

import { getModeConfig } from "../src/core/modes.js";
import { getReasoningConfig } from "../src/core/reasoning.js";
import { buildSystemPrompt } from "../src/core/prompts.js";

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("advanced prompt uses task-specific placeholders instead of stock website options", () => {
  const prompt = buildSystemPrompt(
    getModeConfig("advanced"),
    process.cwd(),
    getReasoningConfig("extra_high")
  );

  assert.match(prompt, /<task-specific option 1>/);
  assert.doesNotMatch(prompt, /Modern dark landing page/i);
  assert.doesNotMatch(prompt, /Portfolio/i);
  assert.doesNotMatch(prompt, /SaaS Landing Page/i);
  assert.doesNotMatch(prompt, /Agency Site/i);
});

run("low prompt tells weaker models to build with defaults instead of asking", () => {
  const prompt = buildSystemPrompt(
    getModeConfig("low"),
    process.cwd(),
    getReasoningConfig("low")
  );

  assert.match(prompt, /single-file solution/i);
  assert.match(prompt, /create one working index\.html/i);
});

run("medium prompt explicitly avoids follow-up questions", () => {
  const prompt = buildSystemPrompt(
    getModeConfig("medium"),
    process.cwd(),
    getReasoningConfig("medium")
  );

  assert.match(prompt, /do not stall waiting for preferences/i);
  assert.match(prompt, /infer sensible defaults and build a complete first version/i);
  assert.doesNotMatch(prompt, /Clarification must use ask_question/i);
});

run("prompt treats short follow-up replies as continuation answers", () => {
  const prompt = buildSystemPrompt(
    getModeConfig("advanced"),
    process.cwd(),
    getReasoningConfig("extra_high"),
    "json"
  );

  assert.match(prompt, /short follow-up replies like html, python, react, 1, 2/i);
  assert.match(prompt, /not brand new tasks/i);
});

run("ollama-style prompt uses raw JSON protocol instead of XML", () => {
  const prompt = buildSystemPrompt(
    getModeConfig("advanced"),
    process.cwd(),
    getReasoningConfig("extra_high"),
    "json"
  );

  assert.doesNotMatch(prompt, /<tool_call>/i);
  assert.doesNotMatch(prompt, /<final>/i);
  assert.match(prompt, /\{"tool":"read_file","args":\{"path":"README\.md"\}\}/);
  assert.match(prompt, /FILE_CONTENT/);
});

run("prompt mentions line editing and empty write guardrails", () => {
  const prompt = buildSystemPrompt(
    getModeConfig("advanced"),
    process.cwd(),
    getReasoningConfig("extra_high"),
    "json"
  );

  assert.match(prompt, /edit_file_lines/i);
  assert.match(prompt, /never call write_file with empty content/i);
  assert.match(prompt, /read_file returns content plus numberedContent/i);
  assert.match(prompt, /if you are rewriting most of a file .* use write_file instead of edit_file_lines/i);
});
