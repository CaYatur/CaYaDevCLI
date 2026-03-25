// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

const REASONING_LEVELS = {
  low: {
    name: "low",
    label: "Low",
    maxSteps: 4,
    selfReviewPasses: 0,
    askQuestionRecoveryAfter: 99,
    protocolRepairLimit: 2,
    promptHint: "Keep reasoning short and direct. Prefer the shortest correct path."
  },
  medium: {
    name: "medium",
    label: "Medium",
    maxSteps: 8,
    selfReviewPasses: 0,
    askQuestionRecoveryAfter: 2,
    protocolRepairLimit: 4,
    promptHint: "Use balanced reasoning depth. Think enough to be correct, but stay efficient."
  },
  high: {
    name: "high",
    label: "High",
    maxSteps: 12,
    selfReviewPasses: 1,
    askQuestionRecoveryAfter: 1,
    protocolRepairLimit: 5,
    promptHint: "Use deeper reasoning. Verify assumptions before acting."
  },
  extra_high: {
    name: "extra_high",
    label: "Extra High",
    maxSteps: 16,
    selfReviewPasses: 2,
    askQuestionRecoveryAfter: 0,
    protocolRepairLimit: 6,
    promptHint: "Use maximum reasoning depth. Run an extra self-review before finalizing tool choices or edits."
  }
};

export const REASONING_NAMES = Object.freeze(Object.keys(REASONING_LEVELS));

export function isReasoningName(value) {
  return Object.hasOwn(REASONING_LEVELS, value);
}

export function getReasoningConfig(name) {
  return REASONING_LEVELS[name] ?? REASONING_LEVELS.medium;
}
