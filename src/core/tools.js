// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";

import { listAllowedTools } from "./modes.js";
import { ensureDir, pathExists, resolveWorkspacePath, toRelativePath } from "./utils.js";

export function getToolDefinitions(mode) {
  const names = listAllowedTools(mode);
  return names.map((name) => TOOL_DEFINITIONS[name]);
}

export async function executeTool({
  toolCall,
  mode,
  cwd,
  askUser
}) {
  const allowedTools = new Set(listAllowedTools(mode));
  const toolName = toolCall?.tool;
  const args = toolCall?.args ?? {};

  if (!allowedTools.has(toolName)) {
    return {
      ok: false,
      tool: toolName,
      message: `Tool "${toolName}" is not available in ${mode.name} mode.`
    };
  }

  const handler = TOOL_HANDLERS[toolName];

  if (!handler) {
    return {
      ok: false,
      tool: toolName,
      message: `Tool "${toolName}" is not implemented.`
    };
  }

  try {
    return await handler({ args, cwd, askUser });
  } catch (error) {
    return {
      ok: false,
      tool: toolName,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

const TOOL_DEFINITIONS = {
  list_files: {
    name: "list_files",
    description: "List files and folders under a relative path."
  },
  search_files: {
    name: "search_files",
    description: "Search text in workspace files."
  },
  read_file: {
    name: "read_file",
    description: "Read a file from the workspace."
  },
  create_file: {
    name: "create_file",
    description: "Create a new file. Fails if the file already exists."
  },
  write_file: {
    name: "write_file",
    description: "Write full content to a file, replacing existing content."
  },
  edit_file_lines: {
    name: "edit_file_lines",
    description: "Replace a specific 1-based line range inside an existing file."
  },
  replace_in_file: {
    name: "replace_in_file",
    description: "Replace exact text inside an existing file."
  },
  delete_file: {
    name: "delete_file",
    description: "Delete a file after explicit user approval."
  },
  web_fetch: {
    name: "web_fetch",
    description: "Fetch a web page and return simplified text content."
  },
  ask_question: {
    name: "ask_question",
    description: "Ask the CLI user a direct clarifying question."
  }
};

const TOOL_HANDLERS = {
  async list_files({ args, cwd }) {
    const requestedPath = String(args.path ?? ".").trim();
    const target = resolveWorkspacePath(cwd, requestedPath);
    const entries = await fs.readdir(target, { withFileTypes: true });

    return {
      ok: true,
      tool: "list_files",
      path: requestedPath,
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file"
      }))
    };
  },

  async search_files({ args, cwd }) {
    const query = String(args.query ?? "").trim();
    const requestedPath = String(args.path ?? ".").trim() || ".";

    if (!query) {
      throw new Error("search_files requires a non-empty query.");
    }

    const target = resolveWorkspacePath(cwd, requestedPath);
    const files = [];
    await collectFiles(target, files);

    const matches = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf8").catch(() => null);

      if (!content || !content.includes(query)) {
        continue;
      }

      const lines = content.split(/\r?\n/);

      lines.forEach((line, index) => {
        if (line.includes(query)) {
          matches.push({
            path: toRelativePath(cwd, file),
            line: index + 1,
            content: line.trim()
          });
        }
      });
    }

    return {
      ok: true,
      tool: "search_files",
      query,
      matches: matches.slice(0, 200)
    };
  },

  async read_file({ args, cwd }) {
    const requestedPath = String(args.path ?? "").trim();
    const target = resolveWorkspacePath(cwd, requestedPath);
    const content = await fs.readFile(target, "utf8");
    const lines = content.replaceAll("\r\n", "\n").split("\n");
    const normalizedLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;

    return {
      ok: true,
      tool: "read_file",
      path: requestedPath,
      content,
      lineCount: normalizedLines.length,
      numberedContent: normalizedLines
        .map((line, index) => `${String(index + 1).padStart(4, " ")} | ${line}`)
        .join("\n")
    };
  },

  async create_file({ args, cwd }) {
    const requestedPath = String(args.path ?? "").trim();
    const content = normalizeFileWriteContent(requestedPath, String(args.content ?? ""));
    const target = resolveWorkspacePath(cwd, requestedPath);

    if (await pathExists(target)) {
      throw new Error(`File already exists: ${requestedPath}`);
    }

    await ensureDir(path.dirname(target));
    await fs.writeFile(target, content, "utf8");

    return {
      ok: true,
      tool: "create_file",
      path: requestedPath,
      bytesWritten: Buffer.byteLength(content, "utf8")
    };
  },

  async write_file({ args, cwd }) {
    const requestedPath = String(args.path ?? "").trim();
    const content = normalizeFileWriteContent(requestedPath, String(args.content ?? ""));
    const target = resolveWorkspacePath(cwd, requestedPath);
    const allowEmpty = args.allow_empty === true || args.allowEmpty === true;

    if (!allowEmpty && content.length === 0) {
      throw new Error("write_file refused to write empty content. Pass allow_empty: true only when the user explicitly wants an empty file.");
    }

    await ensureDir(path.dirname(target));
    await fs.writeFile(target, content, "utf8");

    return {
      ok: true,
      tool: "write_file",
      path: requestedPath,
      bytesWritten: Buffer.byteLength(content, "utf8")
    };
  },

  async edit_file_lines({ args, cwd }) {
    const requestedPath = String(args.path ?? "").trim();
    const target = resolveWorkspacePath(cwd, requestedPath);
    const startLine = Number(args.start_line ?? args.startLine);
    const endLineRaw = args.end_line ?? args.endLine;
    const endLine = endLineRaw === undefined ? startLine : Number(endLineRaw);
    const replacementContent = normalizeFileWriteContent(requestedPath, String(args.content ?? ""));

    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error("edit_file_lines requires a positive integer 'start_line'.");
    }

    if (!Number.isInteger(endLine) || endLine < startLine) {
      throw new Error("edit_file_lines requires an 'end_line' greater than or equal to 'start_line'.");
    }

    const original = await fs.readFile(target, "utf8");
    const hadTrailingNewline = original.replaceAll("\r\n", "\n").endsWith("\n");
    const lines = splitEditableLines(original);

    if (lines.length === 0 && !(startLine === 1 && endLine === 1)) {
      throw new Error(`Cannot edit lines ${startLine}-${endLine} in an empty file.`);
    }

    if (lines.length > 0 && endLine > lines.length) {
      throw new Error(`edit_file_lines range ${startLine}-${endLine} is outside ${requestedPath}, which has ${lines.length} lines.`);
    }

    const replacementLines = splitReplacementLines(replacementContent);
    const nextLines = [
      ...lines.slice(0, startLine - 1),
      ...replacementLines,
      ...lines.slice(lines.length === 0 ? 0 : endLine)
    ];

    let next = nextLines.join("\n");

    if (
      next.length > 0 &&
      (replacementContent.endsWith("\n") || (replacementLines.length === 0 && hadTrailingNewline) || (replacementLines.length > 0 && hadTrailingNewline))
    ) {
      next += "\n";
    }

    await fs.writeFile(target, next, "utf8");

    return {
      ok: true,
      tool: "edit_file_lines",
      path: requestedPath,
      startLine,
      endLine,
      bytesWritten: Buffer.byteLength(next, "utf8")
    };
  },

  async replace_in_file({ args, cwd }) {
    const requestedPath = String(args.path ?? "").trim();
    const findText = String(args.find ?? "");
    const replaceText = String(args.replace ?? "");
    const target = resolveWorkspacePath(cwd, requestedPath);

    if (!findText) {
      throw new Error("replace_in_file requires a non-empty 'find' value.");
    }

    const content = await fs.readFile(target, "utf8");

    if (!content.includes(findText)) {
      throw new Error(`Text not found in ${requestedPath}`);
    }

    const next = content.replace(findText, replaceText);
    await fs.writeFile(target, next, "utf8");

    return {
      ok: true,
      tool: "replace_in_file",
      path: requestedPath
    };
  },

  async delete_file({ args, cwd, askUser }) {
    const requestedPath = String(args.path ?? "").trim();
    const target = resolveWorkspacePath(cwd, requestedPath);
    const approved = await askUser(`Delete "${requestedPath}"? Type "yes" to approve: `);

    if (approved.trim().toLowerCase() !== "yes") {
      return {
        ok: false,
        tool: "delete_file",
        message: "Deletion was denied by the user."
      };
    }

    await fs.rm(target, { force: false });

    return {
      ok: true,
      tool: "delete_file",
      path: requestedPath
    };
  },

  async web_fetch({ args }) {
    const url = String(args.url ?? "").trim();

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("web_fetch requires an absolute http or https URL.");
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`web_fetch failed with status ${response.status}.`);
    }

    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      ok: true,
      tool: "web_fetch",
      url,
      content: text.slice(0, 12000)
    };
  },

  async ask_question({ args, askUser }) {
    const question = String(args.question ?? "").trim();
    const options = args.options;
    const relatedTo = String(args.related_to ?? args.relatedTo ?? "").trim();

    if (!question) {
      throw new Error("ask_question requires a question.");
    }

    const answer = await askUser({
      question,
      options,
      relatedTo
    });

    return {
      ok: true,
      tool: "ask_question",
      question,
      relatedTo,
      answer
    };
  }
};

async function collectFiles(target, files) {
  const entries = await fs.readdir(target, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".cayadev" || entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await collectFiles(fullPath, files);
      continue;
    }

    files.push(fullPath);
  }
}

function normalizeFileWriteContent(requestedPath, content) {
  const pathText = String(requestedPath ?? "").toLowerCase();
  const sourceLikeFile =
    pathText.endsWith(".py") ||
    pathText.endsWith(".js") ||
    pathText.endsWith(".jsx") ||
    pathText.endsWith(".ts") ||
    pathText.endsWith(".tsx") ||
    pathText.endsWith(".html") ||
    pathText.endsWith(".css") ||
    pathText.endsWith(".json") ||
    pathText.endsWith(".sh") ||
    pathText.endsWith(".java") ||
    pathText.endsWith(".c") ||
    pathText.endsWith(".cpp") ||
    pathText.endsWith(".cs") ||
    pathText.endsWith(".go") ||
    pathText.endsWith(".rs") ||
    pathText.endsWith(".php");

  if (!sourceLikeFile) {
    return content;
  }

  const normalized = String(content ?? "").replaceAll("\r\n", "\n");
  const fullFenceMatch = normalized.match(/^```[a-z0-9_-]*\n([\s\S]*?)\n```$/i);

  if (fullFenceMatch) {
    return fullFenceMatch[1];
  }

  const lines = normalized.split("\n");

  while (lines.length > 0 && /^```[a-z0-9_-]*\s*$/i.test(lines[0].trim())) {
    lines.shift();
  }

  while (lines.length > 0 && /^```\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }

  return lines.join("\n");
}

function splitEditableLines(content) {
  const normalized = String(content ?? "").replaceAll("\r\n", "\n");

  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function splitReplacementLines(content) {
  const normalized = String(content ?? "").replaceAll("\r\n", "\n");

  if (!normalized) {
    return [];
  }

  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
}
