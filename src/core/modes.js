// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

const MODES = {
  advanced: {
    name: "advanced",
    label: "Advanced",
    description: "Full tool access with clarification-first behavior for high quality outputs.",
    allowAskQuestion: true,
    allowWebFetch: true,
    assumptionPolicy: "clarify_when_it_matters",
    implementationStyle: "complete_and_polished",
    temperature: 0.2
  },
  medium: {
    name: "medium",
    label: "Medium",
    description: "Balanced mode that makes sensible assumptions instead of asking follow-up questions.",
    allowAskQuestion: false,
    allowWebFetch: true,
    assumptionPolicy: "assume_then_build",
    implementationStyle: "practical_and_editable",
    temperature: 0.15
  },
  normal: {
    name: "normal",
    label: "Normal",
    description: "Local-first default mode with direct implementation and minimal dependencies.",
    allowAskQuestion: false,
    allowWebFetch: false,
    assumptionPolicy: "assume_then_build",
    implementationStyle: "direct_and_local",
    temperature: 0.1
  },
  low: {
    name: "low",
    label: "Low",
    description: "Simplified deterministic mode for smaller or weaker models.",
    allowAskQuestion: false,
    allowWebFetch: false,
    assumptionPolicy: "single_path_defaults",
    implementationStyle: "simple_single_file_bias",
    temperature: 0
  }
};

export const MODE_NAMES = Object.freeze(Object.keys(MODES));

export function isModeName(value) {
  return Object.hasOwn(MODES, value);
}

export function getModeConfig(name) {
  return MODES[name] ?? MODES.normal;
}

export function listAllowedTools(mode) {
  const tools = [
    "list_files",
    "search_files",
    "read_file",
    "create_file",
    "write_file",
    "edit_file_lines",
    "replace_in_file",
    "delete_file"
  ];

  if (mode.allowWebFetch) {
    tools.push("web_fetch");
  }

  if (mode.allowAskQuestion) {
    tools.push("ask_question");
  }

  return tools;
}
