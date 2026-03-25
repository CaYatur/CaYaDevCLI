import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { getModeConfig } from "../src/core/modes.js";
import { executeTool } from "../src/core/tools.js";

async function run(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await run("ask_question forwards options and related_to to the CLI prompt", async () => {
  let receivedPrompt = null;

  const result = await executeTool({
    toolCall: {
      tool: "ask_question",
      args: {
        question: "What style should I use?",
        options: ["Modern dark landing page", "Clean light corporate site"],
        related_to: "website design"
      }
    },
    mode: getModeConfig("advanced"),
    cwd: process.cwd(),
    askUser: async (prompt) => {
      receivedPrompt = prompt;
      return "Modern dark landing page";
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.tool, "ask_question");
  assert.equal(result.answer, "Modern dark landing page");
  assert.equal(receivedPrompt.question, "What style should I use?");
  assert.deepEqual(receivedPrompt.options, ["Modern dark landing page", "Clean light corporate site"]);
  assert.equal(receivedPrompt.relatedTo, "website design");
});

await run("create_file strips markdown fences from source-like file content", async () => {
  const testDir = path.join(process.cwd(), ".cayadev-test-output");
  const relativePath = ".cayadev-test-output/fenced_example.py";
  const absolutePath = path.join(testDir, "fenced_example.py");

  await fs.rm(testDir, { recursive: true, force: true });

  const result = await executeTool({
    toolCall: {
      tool: "create_file",
      args: {
        path: relativePath,
        content: "```python\nprint('hello')\n```"
      }
    },
    mode: getModeConfig("advanced"),
    cwd: process.cwd(),
    askUser: async () => ""
  });

  const written = await fs.readFile(absolutePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(written, "print('hello')");

  await fs.rm(testDir, { recursive: true, force: true });
});

await run("read_file returns numberedContent for precise line edits", async () => {
  const testDir = path.join(process.cwd(), ".cayadev-test-output");
  const relativePath = ".cayadev-test-output/numbered_example.py";
  const absolutePath = path.join(testDir, "numbered_example.py");

  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(absolutePath, "first line\nsecond line\nthird line\n", "utf8");

  const result = await executeTool({
    toolCall: {
      tool: "read_file",
      args: {
        path: relativePath
      }
    },
    mode: getModeConfig("advanced"),
    cwd: process.cwd(),
    askUser: async () => ""
  });

  assert.equal(result.ok, true);
  assert.equal(result.lineCount, 3);
  assert.match(result.numberedContent, /1 \| first line/);
  assert.match(result.numberedContent, /2 \| second line/);
  assert.match(result.numberedContent, /3 \| third line/);

  await fs.rm(testDir, { recursive: true, force: true });
});

await run("edit_file_lines replaces a specific line range", async () => {
  const testDir = path.join(process.cwd(), ".cayadev-test-output");
  const relativePath = ".cayadev-test-output/edit_lines_example.py";
  const absolutePath = path.join(testDir, "edit_lines_example.py");

  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(absolutePath, "line one\nline two\nline three\n", "utf8");

  const result = await executeTool({
    toolCall: {
      tool: "edit_file_lines",
      args: {
        path: relativePath,
        start_line: 2,
        end_line: 2,
        content: "updated middle line"
      }
    },
    mode: getModeConfig("advanced"),
    cwd: process.cwd(),
    askUser: async () => ""
  });

  const written = await fs.readFile(absolutePath, "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.tool, "edit_file_lines");
  assert.equal(written, "line one\nupdated middle line\nline three\n");

  await fs.rm(testDir, { recursive: true, force: true });
});

await run("write_file rejects accidental empty overwrite", async () => {
  const testDir = path.join(process.cwd(), ".cayadev-test-output");
  const relativePath = ".cayadev-test-output/non_empty.py";
  const absolutePath = path.join(testDir, "non_empty.py");

  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(absolutePath, "print('hello')\n", "utf8");

  const result = await executeTool({
    toolCall: {
      tool: "write_file",
      args: {
        path: relativePath,
        content: ""
      }
    },
    mode: getModeConfig("advanced"),
    cwd: process.cwd(),
    askUser: async () => ""
  });

  const written = await fs.readFile(absolutePath, "utf8");

  assert.equal(result.ok, false);
  assert.match(result.message, /refused to write empty content/i);
  assert.equal(written, "print('hello')\n");

  await fs.rm(testDir, { recursive: true, force: true });
});
