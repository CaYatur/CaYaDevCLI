// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

const TOOL_TAG_PATTERN = /<tool_call>([\s\S]*?)<\/tool_call>/i;
const FINAL_TAG_PATTERN = /<final>([\s\S]*?)<\/final>/i;

export function parseAssistantEnvelope(content) {
  const normalized = String(content ?? "").trim();
  const specialToolPayload = extractSpecialToolPayload(normalized);

  if (specialToolPayload) {
    return {
      type: "tool",
      payload: specialToolPayload
    };
  }

  const toolMatch = normalized.match(TOOL_TAG_PATTERN);

  if (toolMatch) {
    try {
      const payload = JSON.parse(toolMatch[1]);
      return {
        type: "tool",
        payload
      };
    } catch (error) {
      return {
        type: "invalid",
        error: `Invalid tool_call JSON: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  const looseToolPayload = extractLooseToolPayload(normalized);

  if (looseToolPayload) {
    return {
      type: "tool",
      payload: looseToolPayload
    };
  }

  const finalMatch = normalized.match(FINAL_TAG_PATTERN);

  if (finalMatch) {
    return {
      type: "final",
      content: finalMatch[1].trim()
    };
  }

  if (normalized.startsWith("<final>")) {
    return {
      type: "final",
      content: normalized.replace(/^<final>/i, "").replace(/<\/final>$/i, "").trim()
    };
  }

  return {
    type: "final",
    content: normalized
  };
}

export function extractClarificationPrompt(content, relatedTo = "") {
  const normalized = String(content ?? "").trim();

  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const optionLines = lines
    .map(extractOptionLabel)
    .filter(Boolean);

  const questionLine =
    lines.find((line) => line.includes("?")) ??
    lines.find((line) => !extractOptionLabel(line) && !looksLikeInstruction(line)) ??
    "";

  const question = sanitizeClarificationLine(questionLine);
  const options = optionLines
    .map((line) => sanitizeClarificationLine(line))
    .filter(Boolean)
    .slice(0, 6);

  if (!question.includes("?") && options.length < 2) {
    return null;
  }

  if (!question && options.length === 0) {
    return null;
  }

  return {
    question: question || "Please provide the missing clarification.",
    relatedTo: String(relatedTo ?? "").trim() || "current task",
    options
  };
}

function extractLooseToolPayload(content) {
  const directPayload = parseToolPayload(content);

  if (directPayload) {
    return directPayload;
  }

  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith("{")) {
      continue;
    }

    const candidate = lines.slice(index).join("\n").trim();
    const payload = parseToolPayload(candidate);

    if (payload) {
      return payload;
    }
  }

  return null;
}

function extractSpecialToolPayload(content) {
  return (
    extractToolPayloadWithBlocks(content) ||
    extractMalformedContentToolPayload(content)
  );
}

function extractToolPayloadWithBlocks(content) {
  const fileContent = extractNamedBlock(content, "FILE_CONTENT");
  const findText = extractNamedBlock(content, "FIND_TEXT");
  const replaceText = extractNamedBlock(content, "REPLACE_TEXT");

  if (fileContent === null && (findText === null || replaceText === null)) {
    return null;
  }

  const jsonSource = extractToolJsonSource(content);

  if (!jsonSource) {
    return null;
  }

  const payload = parseToolPayload(jsonSource);

  if (!payload) {
    return null;
  }

  if ((payload.tool === "write_file" || payload.tool === "create_file") && fileContent !== null) {
    return {
      ...payload,
      args: {
        ...payload.args,
        content: fileContent
      }
    };
  }

  if (payload.tool === "edit_file_lines" && fileContent !== null) {
    return {
      ...payload,
      args: {
        ...payload.args,
        content: fileContent
      }
    };
  }

  if (payload.tool === "replace_in_file" && findText !== null && replaceText !== null) {
    return {
      ...payload,
      args: {
        ...payload.args,
        find: findText,
        replace: replaceText
      }
    };
  }

  return null;
}

function extractMalformedContentToolPayload(content) {
  const toolMatch = content.match(/"tool"\s*:\s*"(write_file|create_file|edit_file_lines)"/i);
  const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/i);

  if (!toolMatch || !pathMatch) {
    return null;
  }

  const contentKeyMatch = /"content:?"\s*:?\s*/i.exec(content);

  if (!contentKeyMatch || contentKeyMatch.index < 0) {
    return null;
  }

  let startIndex = contentKeyMatch.index + contentKeyMatch[0].length;

  if (content[startIndex] === '"') {
    startIndex += 1;
  }

  const trailingQuoteMatch =
    /"\s*}\s*}\s*$/.exec(content) ||
    /"\s*}\s*$/.exec(content);

  if (!trailingQuoteMatch || trailingQuoteMatch.index <= startIndex) {
    return null;
  }

  const rawContent = content.slice(startIndex, trailingQuoteMatch.index).trim();

  if (!rawContent) {
    return null;
  }

  return {
    tool: toolMatch[1],
    args: {
      path: pathMatch[1],
      ...(extractMalformedEditLineArgs(content)),
      content: rawContent
    }
  };
}

function extractMalformedEditLineArgs(content) {
  const startLineMatch = content.match(/"start_line"\s*:\s*(\d+)/i) || content.match(/"startLine"\s*:\s*(\d+)/i);
  const endLineMatch = content.match(/"end_line"\s*:\s*(\d+)/i) || content.match(/"endLine"\s*:\s*(\d+)/i);
  const args = {};

  if (startLineMatch) {
    args.start_line = Number(startLineMatch[1]);
  }

  if (endLineMatch) {
    args.end_line = Number(endLineMatch[1]);
  }

  return args;
}

function parseToolPayload(value) {
  try {
    const parsed = JSON.parse(value);

    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.tool === "string" &&
      parsed.tool.trim() &&
      parsed.args &&
      typeof parsed.args === "object" &&
      !Array.isArray(parsed.args)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function extractToolJsonSource(content) {
  const toolMatch = content.match(TOOL_TAG_PATTERN);

  if (toolMatch) {
    return toolMatch[1].trim();
  }

  const objectStart = content.indexOf("{");

  if (objectStart < 0) {
    return "";
  }

  return extractBalancedObject(content, objectStart);
}

function extractBalancedObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}

function extractNamedBlock(content, blockName) {
  const pattern = new RegExp(`<<<${blockName}\\s*\\r?\\n([\\s\\S]*?)\\r?\\n${blockName}`, "i");
  const match = content.match(pattern);
  return match ? match[1] : null;
}

function extractOptionLabel(line) {
  const numbered = line.match(/^\s*(?:\d+[\.\)]|[a-z][\.\)])\s+(.+?)\s*$/i);

  if (numbered) {
    return numbered[1];
  }

  const bulleted = line.match(/^\s*[-*]\s+(.+?)\s*$/);

  if (bulleted) {
    return bulleted[1];
  }

  return "";
}

function looksLikeInstruction(line) {
  const lowered = String(line ?? "").toLowerCase();
  return (
    lowered.startsWith("please ") ||
    lowered.startsWith("choose ") ||
    lowered.startsWith("select ") ||
    lowered.startsWith("provide ") ||
    lowered.startsWith("respond ")
  );
}

function sanitizeClarificationLine(line) {
  return String(line ?? "")
    .replace(/\*\*/g, "")
    .replace(/^(understood|sure|okay|ok|got it|great|alright|all right)[!,.:\s-]*/i, "")
    .replace(/\s*here are some options:?$/i, "")
    .replace(/\s*here are a few options:?$/i, "")
    .replace(/\s*choose one of the following:?$/i, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
}
