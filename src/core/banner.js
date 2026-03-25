// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import { color } from "./render.js";

const styles = {
  red: "\u001b[31m",
  white: "\u001b[37m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
  bold: "\u001b[1m"
};

export function renderBanner(mode, model, providerLabel, reasoningLabel) {
  const wordmark = [
    `${color("  ██████  █████  ██    ██  █████  ", styles.bold, styles.red)}${color("██████  ███████ ██    ██", styles.bold, styles.white)}`,
    `${color(" ██      ██   ██  ██  ██  ██   ██ ", styles.bold, styles.red)}${color("██   ██ ██      ██    ██", styles.bold, styles.white)}`,
    `${color(" ██      ███████   ████   ███████ ", styles.bold, styles.red)}${color("██   ██ █████   ██    ██", styles.bold, styles.white)}`,
    `${color(" ██      ██   ██    ██    ██   ██ ", styles.bold, styles.red)}${color("██   ██ ██       ██  ██ ", styles.bold, styles.white)}`,
    `${color("  ██████ ██   ██    ██    ██   ██ ", styles.bold, styles.red)}${color("██████  ███████   ████  ", styles.bold, styles.white)}`
  ].join("\n");

  const subtitle = `${color("CaYaDev CLI", styles.bold, styles.cyan)} ${color(`| ${mode.label} mode | thinking: ${reasoningLabel} | provider: ${providerLabel} | model: ${model}`, styles.gray)}`;
  return `${wordmark}\n${subtitle}`;
}
