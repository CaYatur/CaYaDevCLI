// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  white: "\u001b[37m",
  gray: "\u001b[90m",
  bgRed: "\u001b[41m",
  bgBlue: "\u001b[44m",
  bgGray: "\u001b[100m"
};

export function color(text, ...styles) {
  return `${styles.join("")}${text}${ANSI.reset}`;
}

export function renderSectionTitle(title) {
  return color(` ${title} `, ANSI.bgGray, ANSI.white, ANSI.bold);
}

export function renderInfoLine(label, value, tone = "cyan") {
  const map = {
    cyan: ANSI.cyan,
    green: ANSI.green,
    yellow: ANSI.yellow,
    red: ANSI.red,
    gray: ANSI.gray
  };

  return `${color(label, ANSI.bold, map[tone] ?? ANSI.cyan)} ${value}`;
}

export function renderUserPrompt(modeName) {
  return `${color(`[${modeName}]`, ANSI.bold, ANSI.red)} ${color(">", ANSI.bold, ANSI.white)} `;
}

export function renderChatComposer(modeName, typedText = "", pastedText = "", commandSuggestions = []) {
  const lines = [];

  if (pastedText) {
    const normalized = String(pastedText).replaceAll("\r\n", "\n");
    const previewLines = normalized.split("\n");
    const characterCount = normalized.length;
    lines.push(
      `${renderSectionTitle("Pasted Text")} ${color(`${previewLines.length} lines | ${characterCount} chars attached | Ctrl+X removes`, ANSI.dim, ANSI.gray)}`
    );
  }

  if (Array.isArray(commandSuggestions) && commandSuggestions.length > 0) {
    lines.push(color(commandSuggestions.join("   "), ANSI.cyan));
  }

  lines.push(`${renderUserPrompt(modeName)}${typedText}`);
  return lines.join("\n");
}

export function renderToolEvent(toolName) {
  return `${color("tool", ANSI.bold, ANSI.yellow)} ${color(">", ANSI.gray)} ${toolName}`;
}

export function renderToolDetails(toolName, args = {}) {
  const entries = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${color(`- ${key}:`, ANSI.gray)} ${truncate(text, 120)}`;
    });

  if (entries.length === 0) {
    return `${color("details", ANSI.bold, ANSI.gray)} none`;
  }

  return [color(`details (${toolName})`, ANSI.bold, ANSI.gray), ...entries].join("\n");
}

export function renderAskQuestionPrompt(question, relatedTo, options = []) {
  const hasOptions = Array.isArray(options) && options.length > 0;

  return [
    color(" Assistant Needs Input ", ANSI.bgRed, ANSI.white, ANSI.bold),
    `${color("related-to", ANSI.bold, ANSI.yellow)} ${relatedTo}`,
    `${color("question", ANSI.bold, ANSI.cyan)} ${question}`,
    hasOptions
      ? `${color("answer", ANSI.bold, ANSI.white)} Use arrow keys and Enter, or choose Custom answer for manual input.`
      : `${color("answer", ANSI.bold, ANSI.white)} Type your answer below and press Enter.`
  ].join("\n");
}

export function renderCheckpointLine(checkpointId, elapsedMs) {
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${color("checkpoint", ANSI.bold, ANSI.green)} ${color(">", ANSI.gray)} ${checkpointId}  ${color(`(${seconds}s)`, ANSI.dim, ANSI.gray)}`;
}

export function renderFooter() {
  return [
    color("Quick Actions", ANSI.bold, ANSI.white),
    color("[/settings]", ANSI.cyan),
    color("[/menu]", ANSI.cyan),
    color("[/checkpoint]", ANSI.cyan),
    color("[/provider]", ANSI.cyan),
    color("[/model]", ANSI.cyan),
    color("[/tools]", ANSI.cyan)
  ].join("  ");
}

export function renderAssistantMessage(content) {
  const lines = renderMarkdown(content);
  const top = color(" Assistant ", ANSI.bgBlue, ANSI.white, ANSI.bold);
  return [top, ...lines].join("\n");
}

export function renderMarkdown(content) {
  const source = String(content ?? "").replaceAll("\r\n", "\n");
  const lines = source.split("\n");
  const output = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      output.push(color(line || "```", ANSI.gray));
      continue;
    }

    if (inCodeBlock) {
      output.push(color(`  ${line}`, ANSI.green));
      continue;
    }

    if (line.startsWith("# ")) {
      output.push(color(line.slice(2), ANSI.bold, ANSI.cyan));
      continue;
    }

    if (line.startsWith("## ")) {
      output.push(color(line.slice(3), ANSI.bold, ANSI.white));
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      output.push(`${color("*", ANSI.red, ANSI.bold)} ${highlightInlineMarkdown(line.slice(2))}`);
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const [prefix, ...rest] = line.split(/\s+/);
      output.push(`${color(prefix, ANSI.yellow, ANSI.bold)} ${highlightInlineMarkdown(rest.join(" "))}`);
      continue;
    }

    if (line.startsWith("> ")) {
      output.push(`${color("|", ANSI.blue)} ${highlightInlineMarkdown(line.slice(2))}`);
      continue;
    }

    output.push(highlightInlineMarkdown(line));
  }

  return output;
}

export function renderChangeSummary(changes) {
  if (!changes.files.length) {
    return `${renderSectionTitle("Changes")} ${color("No file changes in this turn.", ANSI.gray)}`;
  }

  const header = `${renderSectionTitle("Changes")} ${color(`Files ${changes.files.length} | +${changes.totalAdded} -${changes.totalRemoved}`, ANSI.white)}`;
  const body = changes.files.map((file) => {
    const added = color(`+${file.added}`, ANSI.green);
    const removed = color(`-${file.removed}`, ANSI.red);
    const status = file.status === "created"
      ? color("new", ANSI.blue)
      : file.status === "deleted"
        ? color("deleted", ANSI.magenta)
        : color("edited", ANSI.gray);
    return `${file.path}  ${added} ${removed}  ${status}`;
  });

  return [header, ...body].join("\n");
}

export function renderMenu(title, items, selectedIndex, windowStart, totalCount) {
  const lines = [
    renderSectionTitle(title),
    color("Use arrow keys and Enter. Esc cancels.", ANSI.dim, ANSI.gray),
    color(`Showing ${windowStart + 1}-${windowStart + items.length} of ${totalCount}`, ANSI.dim, ANSI.gray)
  ];

  items.forEach((item, index) => {
    const selected = index === selectedIndex;
    const line = selected
      ? color(`> ${item.label}`, ANSI.bgRed, ANSI.white, ANSI.bold)
      : color(`  ${item.label}`, ANSI.white);

    lines.push(line);

    if (item.description) {
      lines.push(selected ? color(`    ${item.description}`, ANSI.dim, ANSI.white) : color(`    ${item.description}`, ANSI.dim, ANSI.gray));
    }
  });

  return lines.join("\n");
}

function highlightInlineMarkdown(line) {
  let text = String(line ?? "");
  text = text.replace(/`([^`]+)`/g, (_, code) => color(code, ANSI.yellow));
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, bold) => color(bold, ANSI.bold, ANSI.white));
  return text;
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}
