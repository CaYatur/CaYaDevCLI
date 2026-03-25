import assert from "node:assert/strict";

import { extractClarificationPrompt, parseAssistantEnvelope } from "../src/core/parser.js";

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("parses a tool call envelope", () => {
  const result = parseAssistantEnvelope(
    '<tool_call>{"tool":"read_file","args":{"path":"README.md"}}</tool_call>'
  );

  assert.equal(result.type, "tool");
  assert.equal(result.payload.tool, "read_file");
  assert.equal(result.payload.args.path, "README.md");
});

run("parses a final envelope", () => {
  const result = parseAssistantEnvelope("<final>Hello</final>");

  assert.equal(result.type, "final");
  assert.equal(result.content, "Hello");
});

run("parses a raw JSON tool call without XML wrapper", () => {
  const result = parseAssistantEnvelope(
    '{"tool":"ask_question","args":{"question":"What style should I use?","options":["A","B"],"related_to":"website design"}}'
  );

  assert.equal(result.type, "tool");
  assert.equal(result.payload.tool, "ask_question");
  assert.equal(result.payload.args.question, "What style should I use?");
});

run("parses a trailing JSON tool call after short prose", () => {
  const result = parseAssistantEnvelope(
    'What style should I use?\n{"tool":"ask_question","args":{"question":"What style should I use?","options":["A","B"],"related_to":"website design"}}'
  );

  assert.equal(result.type, "tool");
  assert.equal(result.payload.tool, "ask_question");
  assert.equal(result.payload.args.related_to, "website design");
});

run("treats plain text as final content", () => {
  const result = parseAssistantEnvelope("Plain text");

  assert.equal(result.type, "final");
  assert.equal(result.content, "Plain text");
});

run("parses a write_file tool call followed by a FILE_CONTENT block", () => {
  const result = parseAssistantEnvelope(
    '{"tool":"write_file","args":{"path":"index.html"}}\n<<<FILE_CONTENT\n<!DOCTYPE html>\n<html><body>Hello</body></html>\nFILE_CONTENT'
  );

  assert.equal(result.type, "tool");
  assert.equal(result.payload.tool, "write_file");
  assert.equal(result.payload.args.path, "index.html");
  assert.equal(result.payload.args.content, "<!DOCTYPE html>\n<html><body>Hello</body></html>");
});

run("recovers a malformed write_file payload with raw content", () => {
  const result = parseAssistantEnvelope(
    '{"tool":"write_file","args":{"path":"index.html","content:"<!DOCTYPE html>\n<html lang="en"></html>"}}'
  );

  assert.equal(result.type, "tool");
  assert.equal(result.payload.tool, "write_file");
  assert.equal(result.payload.args.path, "index.html");
  assert.match(result.payload.args.content, /<!DOCTYPE html>/);
  assert.match(result.payload.args.content, /<html lang="en"><\/html>/);
});

run("recovers a malformed edit_file_lines payload with raw content", () => {
  const result = parseAssistantEnvelope(
    '{"tool":"edit_file_lines","args":{"path":"snake_game.py","start_line":24,"end_line":37,"content":"line a\nline b"}}'
  );

  assert.equal(result.type, "tool");
  assert.equal(result.payload.tool, "edit_file_lines");
  assert.equal(result.payload.args.path, "snake_game.py");
  assert.equal(result.payload.args.start_line, 24);
  assert.equal(result.payload.args.end_line, 37);
  assert.match(result.payload.args.content, /line a/);
  assert.match(result.payload.args.content, /line b/);
});

run("parses an edit_file_lines tool call followed by a FILE_CONTENT block", () => {
  const result = parseAssistantEnvelope(
    '{"tool":"edit_file_lines","args":{"path":"snake_game.py","start_line":10,"end_line":12}}\n<<<FILE_CONTENT\nprint(1)\nprint(2)\nFILE_CONTENT'
  );

  assert.equal(result.type, "tool");
  assert.equal(result.payload.tool, "edit_file_lines");
  assert.equal(result.payload.args.path, "snake_game.py");
  assert.equal(result.payload.args.start_line, 10);
  assert.equal(result.payload.args.end_line, 12);
  assert.equal(result.payload.args.content, "print(1)\nprint(2)");
});

run("extracts a clarification prompt from numbered plain text", () => {
  const result = extractClarificationPrompt(
    "What type of website would you like?\n1. Blog\n2. Portfolio\n3. Landing page\nPlease choose one option.",
    "website design"
  );

  assert.equal(result.question, "What type of website would you like?");
  assert.deepEqual(result.options, ["Blog", "Portfolio", "Landing page"]);
  assert.equal(result.relatedTo, "website design");
});

run("returns null when no clarification content exists", () => {
  const result = extractClarificationPrompt("", "website design");

  assert.equal(result, null);
});

run("does not recover non-question plain prose without options", () => {
  const result = extractClarificationPrompt(
    "Once I know your preference, I can guide you through creating the website.",
    "website design"
  );

  assert.equal(result, null);
});

run("sanitizes noisy clarification question text", () => {
  const result = extractClarificationPrompt(
    "Understood! What type of website would you like to create? Here are some options:\n1. Blog\n2. Portfolio\n3. Landing page",
    "website design"
  );

  assert.equal(result.question, "What type of website would you like to create?");
  assert.deepEqual(result.options, ["Blog", "Portfolio", "Landing page"]);
});
