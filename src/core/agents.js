// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

/**
 * Agent system - Each agent is a specialized persona with distinct capabilities,
 * tool restrictions, and system prompt extensions. Agents compose on top of modes.
 */

const AGENTS = {
  coder: {
    id: "coder",
    label: "Coder",
    description: "Full-stack coding agent. Creates, edits, and debugs code across all languages.",
    icon: "⌨",
    systemPromptExtension: [
      "You are a senior full-stack developer.",
      "Write production-quality code with proper error handling.",
      "Follow language idioms and project conventions.",
      "When fixing bugs, read the file first, then apply minimal targeted edits.",
      "Prefer edit_file_lines or replace_in_file over rewriting entire files for fixes.",
      "CRITICAL: When the user asks you to create or build something, you MUST use tool calls (create_file, write_file) to actually create the files.",
      "NEVER output source code as plain text in your response. Plain text responses do NOT create files.",
      "If you need to create a file with content, use the FILE_CONTENT block format. The closing marker must be exactly FILE_CONTENT, not FILE_END or anything else.",
      "Always complete the full implementation in one turn. Do not stop after showing code."
    ].join("\n"),
    toolOverrides: null, // uses mode defaults
    temperatureOffset: 0,
    maxStepsMultiplier: 1,
    autoTools: ["read_file", "search_files"], // tools agent can use proactively
    supportedModes: ["advanced", "medium", "normal", "low"]
  },
  architect: {
    id: "architect",
    label: "Architect",
    description: "System design agent. Plans project structure, creates scaffolding, and manages dependencies.",
    icon: "🏗",
    systemPromptExtension: [
      "You are a software architect specializing in system design.",
      "Before building, analyze the project structure to understand existing conventions.",
      "Create well-organized directory structures with clear separation of concerns.",
      "When scaffolding, create all necessary files including configs, entry points, and README.",
      "Prefer modern, widely-adopted patterns over custom abstractions.",
      "Always list_files first to survey the workspace before making structural changes."
    ].join("\n"),
    toolOverrides: null,
    temperatureOffset: 0.05,
    maxStepsMultiplier: 1.5,
    autoTools: ["list_files", "read_file", "search_files"],
    supportedModes: ["advanced", "medium", "normal"]
  },
  reviewer: {
    id: "reviewer",
    label: "Reviewer",
    description: "Code review agent. Analyzes code quality, finds bugs, and suggests improvements.",
    icon: "🔍",
    systemPromptExtension: [
      "You are an expert code reviewer.",
      "Read files thoroughly before providing feedback.",
      "Focus on: correctness, security vulnerabilities, performance issues, and maintainability.",
      "Categorize issues by severity: critical, warning, suggestion.",
      "For each issue found, provide the exact file path and line number.",
      "After reviewing, optionally fix critical issues with targeted edits if the user requests it.",
      "Do not rewrite entire files during review - use replace_in_file for fixes."
    ].join("\n"),
    toolOverrides: {
      disallow: ["create_file", "delete_file"],
      forceAllow: ["read_file", "search_files", "list_files"]
    },
    temperatureOffset: -0.05,
    maxStepsMultiplier: 1.5,
    autoTools: ["list_files", "read_file", "search_files"],
    supportedModes: ["advanced", "medium", "normal"]
  },
  debugger: {
    id: "debugger",
    label: "Debugger",
    description: "Debugging agent. Traces errors, reads stack traces, and applies fixes.",
    icon: "🐛",
    systemPromptExtension: [
      "You are an expert debugger.",
      "When the user pastes an error or stack trace, immediately read the referenced file(s).",
      "Trace the error back to its root cause through the call chain.",
      "Apply minimal, precise fixes using edit_file_lines or replace_in_file.",
      "After fixing, verify the fix makes sense by re-reading the modified lines.",
      "Explain the root cause and fix briefly after applying it."
    ].join("\n"),
    toolOverrides: null,
    temperatureOffset: -0.05,
    maxStepsMultiplier: 1.25,
    autoTools: ["read_file", "search_files"],
    supportedModes: ["advanced", "medium", "normal", "low"]
  },
  writer: {
    id: "writer",
    label: "Writer",
    description: "Documentation and content agent. Writes README, docs, comments, and technical content.",
    icon: "📝",
    systemPromptExtension: [
      "You are a technical writer.",
      "Write clear, concise documentation following the project's existing style.",
      "For README files, include: overview, installation, usage, and API sections.",
      "For code comments, be brief and explain why, not what.",
      "When documenting an existing project, read key files first to understand the API surface.",
      "Use markdown formatting properly."
    ].join("\n"),
    toolOverrides: null,
    temperatureOffset: 0.05,
    maxStepsMultiplier: 1,
    autoTools: ["read_file", "list_files", "search_files"],
    supportedModes: ["advanced", "medium", "normal"]
  },
  researcher: {
    id: "researcher",
    label: "Researcher",
    description: "Research agent. Searches codebases, reads files, and gathers information without modifying anything.",
    icon: "📚",
    systemPromptExtension: [
      "You are a codebase research assistant.",
      "Your primary role is to find, read, and explain code - not to modify it.",
      "Search thoroughly using search_files and list_files before answering.",
      "Read multiple related files to build complete understanding.",
      "Provide file paths and line numbers in your answers.",
      "Do not create or modify files unless explicitly asked."
    ].join("\n"),
    toolOverrides: {
      disallow: ["create_file", "write_file", "edit_file_lines", "replace_in_file", "delete_file"],
      forceAllow: ["read_file", "search_files", "list_files"]
    },
    temperatureOffset: 0,
    maxStepsMultiplier: 2,
    autoTools: ["list_files", "read_file", "search_files"],
    supportedModes: ["advanced", "medium", "normal", "low"]
  },
  refactor: {
    id: "refactor",
    label: "Refactor",
    description: "Refactoring agent. Restructures code for clarity, performance, and maintainability.",
    icon: "♻",
    systemPromptExtension: [
      "You are a refactoring specialist.",
      "Before refactoring, read all affected files to understand the full picture.",
      "Apply one refactoring step at a time. Verify each step is correct before moving on.",
      "Preserve existing behavior - refactoring must not change functionality.",
      "Prefer small, safe renames and extractions over large rewrites.",
      "Use search_files to find all usages before renaming anything.",
      "After refactoring, list the changes made and confirm no behavior was altered."
    ].join("\n"),
    toolOverrides: null,
    temperatureOffset: -0.05,
    maxStepsMultiplier: 2,
    autoTools: ["read_file", "search_files", "list_files"],
    supportedModes: ["advanced", "medium", "normal"]
  }
};

export const AGENT_IDS = Object.freeze(Object.keys(AGENTS));

export function isAgentId(value) {
  return Object.hasOwn(AGENTS, value);
}

export function getAgentConfig(agentId) {
  return AGENTS[agentId] ?? AGENTS.coder;
}

export function listAgents() {
  return AGENT_IDS.map((id) => getAgentConfig(id));
}

/**
 * Resolve tool list considering agent overrides on top of mode tools.
 */
export function resolveAgentTools(modeTools, agent) {
  if (!agent?.toolOverrides) return modeTools;

  let tools = [...modeTools];

  // Remove disallowed tools
  if (agent.toolOverrides.disallow) {
    const disallowed = new Set(agent.toolOverrides.disallow);
    tools = tools.filter((t) => !disallowed.has(t));
  }

  // Add force-allowed tools (even if mode doesn't include them)
  if (agent.toolOverrides.forceAllow) {
    for (const tool of agent.toolOverrides.forceAllow) {
      if (!tools.includes(tool)) {
        tools.push(tool);
      }
    }
  }

  return tools;
}

/**
 * Compute effective temperature from mode base + agent offset.
 */
export function resolveAgentTemperature(modeTemperature, agent) {
  if (!agent?.temperatureOffset) return modeTemperature;
  return Math.max(0, Math.min(1, modeTemperature + agent.temperatureOffset));
}

/**
 * Compute effective max steps from reasoning config + agent multiplier.
 */
export function resolveAgentMaxSteps(reasoningMaxSteps, agent) {
  if (!agent?.maxStepsMultiplier || agent.maxStepsMultiplier === 1) return reasoningMaxSteps;
  return Math.ceil(reasoningMaxSteps * agent.maxStepsMultiplier);
}

/**
 * Build agent-specific system prompt extension.
 */
export function getAgentSystemPromptExtension(agent) {
  if (!agent?.systemPromptExtension) return "";
  return `\nAgent role (${agent.label}):\n${agent.systemPromptExtension}`;
}
