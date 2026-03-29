// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { renderBanner } from "./banner.js";
import { ensureInitialCheckpoint, getCheckpointWorkspaceDir, listCheckpoints, saveCheckpoint } from "./checkpoints.js";
import {
  buildRuntimeConfig,
  createStoredConfigFromState,
  loadAppConfig,
  saveAppConfig
} from "./config.js";
import { getModeConfig, listAllowedTools, MODE_NAMES } from "./modes.js";
import { extractClarificationPrompt, parseAssistantEnvelope } from "./parser.js";
import { buildSystemPrompt } from "./prompts.js";
import { listAvailableModels, generateAssistantMessage, shutdownProviderModels } from "./provider.js";
import { getProviderDefinition, isProviderId, listProviders } from "./providers.js";
import { getReasoningConfig, isReasoningName, REASONING_NAMES } from "./reasoning.js";
import {
  renderAssistantMessage,
  renderAskQuestionPrompt,
  renderChatComposer,
  renderChangeSummary,
  renderCheckpointLine,
  renderFooter,
  renderInfoLine,
  renderMenu,
  renderSectionTitle,
  renderToolDetails,
  renderToolEvent,
  renderUserPrompt
} from "./render.js";
import { executeTool, getToolDefinitions } from "./tools.js";
import { ensureDir, pathExists } from "./utils.js";
import { captureWorkspaceState, restoreWorkspaceFromSnapshot, summarizeWorkspaceChanges } from "./workspace.js";

const COMMANDS = [
  "/help",
  "/mode",
  "/provider",
  "/provider current",
  "/model",
  "/thinking",
  "/keep-alive",
  "/settings",
  "/checkpoint",
  "/checkpoints",
  "/menu",
  "/tools",
  "/session",
  "/session list",
  "/session load",
  "/load-session",
  "/config",
  "/exit"
];

const TERMINAL_INPUT_ENHANCEMENTS = {
  csiUEnable: "\u001b[>1u",
  csiUDisable: "\u001b[<u",
  modifyOtherKeysEnable: "\u001b[>4;2m",
  modifyOtherKeysDisable: "\u001b[>4;0m",
  bracketedPasteEnable: "\u001b[?2004h",
  bracketedPasteDisable: "\u001b[?2004l"
};

export async function startCli() {
  const cwd = process.cwd();
  const appConfig = await loadAppConfig(cwd);
  const config = buildRuntimeConfig(process.argv.slice(2), cwd, appConfig.values);

  await ensureDir(config.sessionDir);
  const sessionState = await loadSessionState(config.sessionDir);

  const state = {
    ...config,
    appConfigPath: appConfig.configPath,
    history: sessionState.history,
    composerRecallHistory: [],
    checkpointIndex: sessionState.checkpointIndex,
    readline: null,
    activeInputCleanup: null,
    activeTurnController: null,
    isProcessingTurn: false,
    turnInterrupted: false,
    exitRequested: false,
    lastSigintAt: 0,
    lastSigintContext: "idle",
    lastHandledSigintEventAt: 0
  };

  const rl = readlinePromises.createInterface({
    input,
    output,
    completer: createCommandCompleter()
  });
  state.readline = rl;
  const sigintHandler = () => handleSigint(state);
  rl.on("SIGINT", sigintHandler);

  try {
    process.on("SIGINT", sigintHandler);
    const approvedWorkspace = await confirmWorkspaceApproval(state, rl);

    if (!approvedWorkspace) {
      return;
    }

    await ensureProviderReady(state, rl);
    await ensureInitialCheckpoint({
      sessionDir: state.sessionDir,
      cwd: state.cwd,
      modeName: state.modeName,
      providerId: state.providerId,
      model: state.model
    });
    printHome(state);

    while (true) {
      let line = "";

      try {
        line = await promptForChatInput(state, rl);
      } catch (error) {
        if (state.exitRequested) {
          break;
        }

        throw error;
      }

      if (line === null) {
        if (state.exitRequested) {
          break;
        }

        console.log(renderFooter());
        continue;
      }

      const inputText = line.trim();

      if (!inputText) {
        console.log(renderFooter());
        continue;
      }

      rememberSubmittedComposerEntry(state, line);

      if (inputText.startsWith("/")) {
        const shouldExit = await handleCommand(inputText, state, rl);

        if (shouldExit || state.exitRequested) {
          break;
        }

        console.log(renderFooter());
        continue;
      }

      await handleTurn(inputText, state, rl);

      if (state.exitRequested) {
        break;
      }

      console.log(renderFooter());
    }
  } finally {
    process.off("SIGINT", sigintHandler);
    rl.off("SIGINT", sigintHandler);

    await releaseProviderResources(state);

    try {
      input.pause();
    } catch {
      // Ignore stdin teardown errors while exiting.
    }
    rl.close();
  }
}

async function releaseProviderResources(state) {
  try {
    const summary = await shutdownProviderModels({
      providerProtocol: state.providerProtocol,
      apiKey: state.apiKey,
      baseUrl: state.baseUrl,
      model: state.model
    });

    if (!summary || summary.attemptedCount === 0) {
      return;
    }

    if (summary.failedCount === 0) {
      console.log(renderInfoLine("provider", `Stopped ${summary.stoppedCount}/${summary.attemptedCount} Ollama model(s) on exit.`, "gray"));
      return;
    }

    console.log(
      renderInfoLine(
        "warning",
        `Stopped ${summary.stoppedCount}/${summary.attemptedCount} Ollama model(s). Failed: ${summary.failedCount}.`,
        "yellow"
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(renderInfoLine("warning", `Failed to release provider resources: ${message}`, "yellow"));
  }
}

async function handleTurn(userMessage, state, rl) {
  const turnStartedAt = Date.now();
  const beforeState = await captureWorkspaceState(state.cwd);
  const responseProtocol = getResponseProtocol(state);
  const activeTaskContext = deriveActiveTaskContext(state.history, userMessage);
  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(state.mode, state.cwd, state.reasoning, responseProtocol)
    },
    ...normalizeHistoryForProtocol(state.history, responseProtocol),
    ...(activeTaskContext
      ? [{
          role: "user",
          content: `Context note: treat the user's next short reply as a continuation of this active task, not as a new unrelated request.\nActive task: ${activeTaskContext.activeRequest}\nLatest short reply: ${userMessage}`
        }]
      : []),
    {
      role: "user",
      content: userMessage
    }
  ];

  const toolsUsed = [];
  let assistantMessage = "";
  let interrupted = false;
  let selfReviewCount = 0;
  let askQuestionProtocolCount = 0;

  state.isProcessingTurn = true;
  state.turnInterrupted = false;
  state.lastSigintContext = "running";

  try {
    for (let step = 0; step < state.maxSteps; step += 1) {
      if (state.turnInterrupted) {
        interrupted = true;
        break;
      }

      const spinner = startSpinner("thinking");
      let raw = "";

      try {
        state.activeTurnController = new AbortController();
        raw = await generateAssistantMessage({
          providerProtocol: state.providerProtocol,
          apiKey: state.apiKey,
          baseUrl: state.baseUrl,
          model: state.model,
          messages,
          temperature: state.mode.temperature,
          keepAlive: state.keepAlive,
          signal: state.activeTurnController.signal
        });
      } catch (error) {
        if (isAbortError(error) || state.turnInterrupted) {
          interrupted = true;
          break;
        }

        throw error;
      } finally {
        state.activeTurnController = null;
        spinner.stop();
        const seconds = ((Date.now() - spinner.startedAt) / 1000).toFixed(1);
        console.log(renderInfoLine("thinking", `done in ${seconds}s`, "cyan"));
      }

      const parsed = parseAssistantEnvelope(raw);

      if (parsed.type === "tool") {
        const normalizedToolCall = normalizeToolCallForExecution(parsed.payload);
        const toolName = normalizedToolCall?.tool ?? "unknown";

        if (normalizedToolCall?.promotedFrom) {
          console.log(renderInfoLine("tool", `promoted ${normalizedToolCall.promotedFrom} to ${toolName} because the payload looked like a whole-file rewrite`, "gray"));
        }

        console.log(renderToolEvent(toolName));
        console.log(renderToolDetails(toolName, normalizedToolCall?.args ?? {}));

        const askUser = async (prompt) => {
          if (toolName !== "ask_question") {
            const plainPrompt = typeof prompt === "string" ? prompt : String(prompt?.question ?? "");
            return rl.question(plainPrompt);
          }

          const question = typeof prompt === "string" ? prompt : String(prompt?.question ?? "");
          const relatedTo = typeof prompt === "string"
            ? userMessage
            : String(prompt?.relatedTo ?? prompt?.related_to ?? userMessage);
          const options = typeof prompt === "string" ? [] : normalizeAskQuestionOptions(prompt?.options);
          return promptForAssistantQuestion(state, rl, {
            question,
            relatedTo: relatedTo || userMessage,
            options
          });
        };

        const result = await executeTool({
          toolCall: normalizedToolCall,
          mode: state.mode,
          cwd: state.cwd,
          askUser
        });

        toolsUsed.push({
          tool: toolName,
          ok: result.ok
        });

        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: `Tool result:\n${JSON.stringify(result, null, 2)}`
        });

        if (
          toolName === "create_file" &&
          result.ok &&
          shouldForceFileContentFollowUp(userMessage, result.path, result.bytesWritten)
        ) {
          messages.push({
            role: "user",
            content: Number(result.bytesWritten ?? 0) === 0
              ? "You created an empty file, but the requested task is not complete yet. Continue immediately with more tool calls and write the real file contents before the final answer."
              : "The file exists now. Continue immediately in this same turn with write_file, edit_file_lines, or replace_in_file until the requested implementation is actually complete. Do not stop right after create_file."
          });
        }

        console.log(renderInfoLine("tool-result", result.ok ? "success" : result.message, result.ok ? "green" : "red"));
        const resultDetails = getToolResultDetails(result);

        if (resultDetails) {
          console.log(resultDetails);
        }

        const toolFailureInstruction = buildToolFailureRepairInstruction(toolName, normalizedToolCall?.args ?? {}, result);

        if (toolFailureInstruction) {
          messages.push({
            role: "user",
            content: toolFailureInstruction
          });
          console.log(renderInfoLine("protocol", "retrying after an invalid tool call", "red"));
        }

        continue;
      }

      if (parsed.type === "invalid") {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: buildProtocolRepairMessage(responseProtocol, parsed.error)
        });
        console.log(renderInfoLine("protocol", parsed.error, "red"));
        continue;
      }

      if (isSelfReviewAcknowledgement(parsed.content)) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: "Do not say that you will self-review. Perform the self-review silently and immediately output the corrected next response in the required protocol."
        });
        console.log(renderInfoLine("reasoning", "self-review acknowledgement was rejected", "red"));
        continue;
      }

      if (shouldUseSelfReview(state, userMessage, parsed.content, toolsUsed, selfReviewCount)) {
        selfReviewCount += 1;
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: "Self-review this turn before answering. Re-check whether the request requires clarification, ask_question, or file tools. If clarification is needed and ask_question is available, output only the required ask_question tool call. If implementation is needed, continue with tools instead of stopping at prose. Do not tell the user that you are self-reviewing."
        });
        console.log(renderInfoLine("reasoning", "running an extra self-review pass", "gray"));
        continue;
      }

      if (shouldForceAskQuestionTool(state, userMessage, parsed.content, toolsUsed)) {
        askQuestionProtocolCount += 1;

        if (askQuestionProtocolCount > (state.reasoning.protocolRepairLimit ?? 4)) {
          assistantMessage = "The model repeatedly failed to produce a valid ask_question tool call. Provide the missing preference directly or switch to a stronger model.";
          console.log(renderInfoLine("protocol", "ask_question repair limit reached", "red"));
          break;
        }

        const recoveryPrompt = askQuestionProtocolCount > (state.reasoning.askQuestionRecoveryAfter ?? 1)
          ? extractClarificationPrompt(parsed.content, userMessage)
          : null;

        if (recoveryPrompt) {
          console.log(renderInfoLine("protocol", "recovering ask_question UI from plain-text clarification", "yellow"));
          console.log(renderToolEvent("ask_question"));
          console.log(renderToolDetails("ask_question", {
            question: recoveryPrompt.question,
            options: recoveryPrompt.options,
            related_to: recoveryPrompt.relatedTo
          }));

          const answer = await promptForAssistantQuestion(state, rl, recoveryPrompt);
          const result = {
            ok: true,
            tool: "ask_question",
            question: recoveryPrompt.question,
            relatedTo: recoveryPrompt.relatedTo,
            answer,
            recovered: true
          };

          toolsUsed.push({
            tool: "ask_question",
            ok: true
          });

          messages.push({ role: "assistant", content: raw });
          messages.push({
            role: "user",
            content: `Tool result:\n${JSON.stringify(result, null, 2)}`
          });

          console.log(renderInfoLine("tool-result", "recovered from plain-text clarification", "green"));
          const resultDetails = getToolResultDetails(result);

          if (resultDetails) {
            console.log(resultDetails);
          }

          continue;
        }

        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: buildAskQuestionRepairMessage(responseProtocol)
        });
        console.log(renderInfoLine("protocol", "clarification must use ask_question tool", "red"));
        continue;
      }

      if (shouldForceAssumeAndBuild(state, userMessage, parsed.content, toolsUsed)) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: buildAssumeAndBuildInstruction(state)
        });
        console.log(renderInfoLine("protocol", "this mode must assume sensible defaults and continue implementation", "red"));
        continue;
      }

      if (shouldForceImplementationTools(userMessage, parsed.content, toolsUsed, activeTaskContext)) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: "The task requires actual file creation or editing. Do not stop with explanation, example code, or a permission question. Continue using file tools until the requested files are actually created and written."
        });
        console.log(renderInfoLine("protocol", "implementation must continue with file tools", "red"));
        continue;
      }

      if (shouldForceRepairTools(userMessage, parsed.content, toolsUsed, activeTaskContext)) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: "The user already gave you enough context to repair the existing implementation. Do not ask for more details and do not paste replacement code in prose. Read the affected file, fix it with edit_file_lines, replace_in_file, or write_file, and then give a short final answer."
        });
        console.log(renderInfoLine("protocol", "repair must continue with file tools", "red"));
        continue;
      }

      assistantMessage = parsed.content;
      break;
    }
  } catch (error) {
    if (!interrupted) {
      console.log(renderInfoLine("provider", error instanceof Error ? error.message : String(error), "red"));
    }
    return;
  } finally {
    state.activeTurnController = null;
    state.isProcessingTurn = false;
    state.turnInterrupted = false;
    state.lastSigintContext = "idle";
  }

  if (interrupted) {
    console.log(renderInfoLine("interrupt", "Response stopped by user.", "yellow"));
    return;
  }

  if (!assistantMessage) {
    assistantMessage = "I reached the step limit before completing the task.";
  }

  const afterState = await captureWorkspaceState(state.cwd);
  const changes = summarizeWorkspaceChanges(beforeState, afterState);

  console.log("");
  console.log(renderAssistantMessage(assistantMessage));
  console.log("");
  console.log(renderChangeSummary(changes));
  console.log("");

  state.history.push({ role: "user", content: userMessage });
  state.history.push({
    role: "assistant",
    content: formatAssistantHistoryContent(assistantMessage, responseProtocol)
  });

  state.checkpointIndex += 1;

  const manifest = await saveCheckpoint({
    sessionDir: state.sessionDir,
    checkpointIndex: state.checkpointIndex,
    cwd: state.cwd,
    turn: {
      modeName: state.modeName,
      userMessage,
      assistantMessage,
      toolsUsed,
      changes
    }
  });

  await fs.writeFile(
    path.join(state.sessionDir, "session.json"),
    JSON.stringify(
      {
        sessionId: state.sessionId,
        modeName: state.modeName,
        providerId: state.providerId,
        providerProtocol: state.providerProtocol,
        model: state.model,
        baseUrl: state.baseUrl,
        checkpointIndex: state.checkpointIndex,
        history: state.history
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(renderCheckpointLine(manifest.id, Date.now() - turnStartedAt));
}

async function handleCommand(inputText, state, rl) {
  const [command, ...rest] = inputText.slice(1).split(/\s+/);

  switch (command) {
    case "help":
      printHelp();
      return false;
    case "mode":
      await handleModeCommand(rest, state);
      return false;
    case "model":
      await handleModelCommand(rest, state, rl);
      return false;
    case "thinking":
    case "reasoning":
      await handleThinkingCommand(rest, state);
      return false;
    case "keep-alive":
    case "keepalive":
      await handleKeepAliveCommand(rest, state);
      return false;
    case "settings":
      await openSettingsMenu(state, rl);
      return false;
    case "provider":
      await handleProviderCommand(rest, state, rl);
      return false;
    case "tools":
      printTools(state);
      return false;
    case "checkpoints":
      await printCheckpoints(state);
      return false;
    case "checkpoint":
    case "restore":
      await handleCheckpointCommand(rest, state, rl);
      return false;
    case "menu":
      await openQuickMenu(state, rl);
      return false;
    case "session":
    case "season":
      await handleSessionCommand(rest, state, rl);
      return false;
    case "load-session":
    case "load-season":
      await handleSessionCommand(["load", ...rest], state, rl);
      return false;
    case "load":
      if ((rest[0] === "session" || rest[0] === "season") && rest[1]) {
        await handleSessionCommand(["load", ...rest.slice(1)], state, rl);
        return false;
      }
      console.log(renderInfoLine("error", "Usage: /load session <id>", "red"));
      return false;
    case "config":
      console.log(renderSectionTitle("Config"));
      console.log(
        JSON.stringify(
          {
            mode: state.modeName,
            provider: state.providerId,
            thinking: state.reasoningName,
            protocol: state.providerProtocol,
            model: state.model,
            baseUrl: state.baseUrl,
            keepAlive: state.keepAlive || "24h",
            sessionId: state.sessionId,
            sessionDir: state.sessionDir,
            maxSteps: state.maxSteps
          },
          null,
          2
        )
      );
      return false;
    case "exit":
    case "quit":
      return true;
    default:
      console.log(renderInfoLine("error", `Unknown command: /${command}`, "red"));
      return false;
  }
}

async function handleModeCommand(args, state) {
  const nextMode = args[0];

  if (!nextMode) {
    console.log(renderInfoLine("mode", state.modeName));
    console.log(renderInfoLine("available", MODE_NAMES.join(", "), "gray"));
    return;
  }

  if (!MODE_NAMES.includes(nextMode)) {
    console.log(renderInfoLine("error", `Invalid mode. Available modes: ${MODE_NAMES.join(", ")}`, "red"));
    return;
  }

  state.modeName = nextMode;
  state.mode = getModeConfig(nextMode);
  await persistAppConfig(state);
  console.log(renderInfoLine("mode", `changed to ${state.mode.label}`, "green"));
}

async function handleModelCommand(args, state, rl) {
  if (args[0]) {
    state.model = args.join(" ");
    await persistAppConfig(state);
    console.log(renderInfoLine("model", `changed to ${state.model}`, "green"));
    return;
  }

  const selectedModel = await promptForModel(state, rl, state.model);

  if (!selectedModel) {
    console.log(renderInfoLine("model", `unchanged: ${state.model}`, "gray"));
    return;
  }

  state.model = selectedModel;
  await persistAppConfig(state);
  console.log(renderInfoLine("model", `changed to ${state.model}`, "green"));
}

async function handleThinkingCommand(args, state) {
  const nextThinking = String(args[0] ?? "").toLowerCase();

  if (!nextThinking) {
    console.log(renderInfoLine("thinking", `${state.reasoning.label} (${state.reasoningName})`, "cyan"));
    console.log(renderInfoLine("available", REASONING_NAMES.join(", "), "gray"));
    return;
  }

  if (!isReasoningName(nextThinking)) {
    console.log(renderInfoLine("error", `Invalid thinking level. Available: ${REASONING_NAMES.join(", ")}`, "red"));
    return;
  }

  state.reasoningName = nextThinking;
  state.reasoning = getReasoningConfig(nextThinking);
  state.maxSteps = state.reasoning.maxSteps;
  await persistAppConfig(state);
  console.log(renderInfoLine("thinking", `changed to ${state.reasoning.label}`, "green"));
}

async function handleKeepAliveCommand(args, state) {
  const nextKeepAlive = String(args[0] ?? "").trim();

  if (!nextKeepAlive) {
    console.log(renderInfoLine("keep-alive", state.keepAlive, "cyan"));
    console.log(renderInfoLine("examples", "10m, 1h, 6h, 24h, 48h", "gray"));
    console.log(renderInfoLine("note", "Prevents model timeouts during slow/long responses", "gray"));
    return;
  }

  state.keepAlive = nextKeepAlive;
  await persistAppConfig(state);
  console.log(renderInfoLine("keep-alive", `changed to ${nextKeepAlive}`, "green"));
}

async function handleSessionCommand(args, state, _rl) {
  const action = String(args[0] ?? "").toLowerCase();

  if (!action || action === "current") {
    console.log(renderInfoLine("session", state.sessionId));
    console.log(renderInfoLine("directory", state.sessionDir, "gray"));
    const sessions = await listSavedSessions(state.cwd);
    console.log(renderInfoLine("saved", String(sessions.length), "gray"));
    await printSavedSessions(state, sessions);
    return;
  }

  if (action === "list" || action === "ls") {
    await printSavedSessions(state);
    return;
  }

  if (action === "load" || action === "open") {
    const requestedId = String(args.slice(1).join(" ")).trim();

    if (requestedId) {
      await loadSavedSessionById(requestedId, state);
      return;
    }

    const sessions = await listSavedSessions(state.cwd);

    if (sessions.length === 0) {
      console.log(renderInfoLine("sessions", "No saved sessions found.", "gray"));
      return;
    }

    const items = sessions.map((entry) => ({
      id: entry.id,
      label: entry.id,
      description: `${entry.modeName || "unknown"} | ${entry.providerId || "unknown"} | ${truncate(entry.model || "(not set)", 28)} | turns ${entry.userTurns}`
    }));
    const selected = await chooseFromMenu("Load Session", items, state, {
      intro: "Select a saved session to continue."
    });

    if (!selected?.id) {
      console.log(renderInfoLine("session", "load cancelled", "gray"));
      return;
    }

    await loadSavedSessionById(selected.id, state);
    return;
  }

  console.log(renderInfoLine("error", "Usage: /session [list|load <id>]", "red"));
}

async function listSavedSessions(cwd) {
  const sessionsRoot = path.join(cwd, ".cayadev", "sessions");

  if (!(await pathExists(sessionsRoot))) {
    return [];
  }

  let entries = [];

  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = entries.filter((entry) => entry.isDirectory());
  const sessions = await Promise.all(
    directories.map(async (entry) => {
      const sessionDir = path.join(sessionsRoot, entry.name);
      const sessionFile = path.join(sessionDir, "session.json");

      if (!(await pathExists(sessionFile))) {
        return null;
      }

      try {
        const content = await fs.readFile(sessionFile, "utf8");
        const parsed = JSON.parse(content);
        const stats = await fs.stat(sessionFile).catch(() => null);
        const history = Array.isArray(parsed.history) ? parsed.history : [];
        const userTurns = history.filter((record) => record?.role === "user").length;

        return {
          id: String(parsed.sessionId ?? entry.name),
          sessionDir,
          modeName: String(parsed.modeName ?? ""),
          providerId: String(parsed.providerId ?? ""),
          providerProtocol: String(parsed.providerProtocol ?? ""),
          model: String(parsed.model ?? ""),
          baseUrl: String(parsed.baseUrl ?? ""),
          checkpointIndex: Number.isFinite(parsed.checkpointIndex) ? parsed.checkpointIndex : 0,
          userTurns,
          updatedAtMs: Number(stats?.mtimeMs ?? 0)
        };
      } catch {
        return null;
      }
    })
  );

  return sessions
    .filter(Boolean)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

async function printSavedSessions(state, providedSessions = null) {
  const sessions = Array.isArray(providedSessions)
    ? providedSessions
    : await listSavedSessions(state.cwd);

  if (sessions.length === 0) {
    console.log(renderInfoLine("sessions", "No saved sessions found.", "gray"));
    return;
  }

  console.log(renderSectionTitle("Saved Sessions"));
  sessions.forEach((entry, index) => {
    const marker = entry.id === state.sessionId ? "*" : " ";
    const updatedAt = entry.updatedAtMs > 0 ? new Date(entry.updatedAtMs).toISOString() : "unknown";

    console.log(`${marker} ${index + 1}. ${entry.id}`);
    console.log(`   ${entry.modeName || "unknown"} | ${entry.providerId || "unknown"} | ${truncate(entry.model || "(not set)", 28)} | turns ${entry.userTurns} | checkpoints ${entry.checkpointIndex} | ${updatedAt}`);
  });
  console.log(renderInfoLine("hint", "Use /session load <session-id> to continue a previous chat.", "gray"));
}

async function loadSavedSessionById(sessionId, state) {
  const requestedId = String(sessionId ?? "").trim();

  if (!requestedId) {
    console.log(renderInfoLine("error", "Session id is required. Usage: /session load <id>", "red"));
    return;
  }

  const sessions = await listSavedSessions(state.cwd);
  const selected = sessions.find((entry) => entry.id === requestedId);

  if (!selected) {
    console.log(renderInfoLine("error", `Session not found: ${requestedId}`, "red"));
    await printSavedSessions(state, sessions);
    return;
  }

  const loaded = await loadSessionState(selected.sessionDir);
  state.sessionId = selected.id;
  state.sessionDir = selected.sessionDir;
  state.history = loaded.history;
  state.checkpointIndex = loaded.checkpointIndex;

  if (selected.modeName && MODE_NAMES.includes(selected.modeName)) {
    state.modeName = selected.modeName;
    state.mode = getModeConfig(selected.modeName);
  }

  if (selected.providerId && isProviderId(selected.providerId)) {
    const provider = getProviderDefinition(selected.providerId);
    state.providerId = selected.providerId;
    state.providerLabel = provider.label;
  }

  if (selected.providerProtocol) {
    state.providerProtocol = selected.providerProtocol;
  }

  if (selected.baseUrl) {
    state.baseUrl = selected.baseUrl;
  }

  if (selected.model) {
    state.model = selected.model;
  }

  state.composerRecallHistory = [];
  await persistAppConfig(state);

  const turnCount = state.history.filter((entry) => entry?.role === "user").length;
  console.log(renderInfoLine("session", `loaded ${state.sessionId}`, "green"));
  console.log(renderInfoLine("turns", String(turnCount), "gray"));
  console.log(renderInfoLine("mode", state.modeName, "gray"));
  console.log(renderInfoLine("model", state.model || "(not set)", "gray"));
}

async function handleProviderCommand(args, state, rl) {
  if (args[0] === "current") {
    console.log(renderInfoLine("provider", state.providerLabel));
    console.log(renderInfoLine("protocol", state.providerProtocol, "gray"));
    console.log(renderInfoLine("base-url", state.baseUrl, "gray"));
    return;
  }

  const preferredProviderId = args[0] && isProviderId(args[0]) ? args[0] : "";
  await runProviderWizard(state, rl, preferredProviderId);
  printHome(state);
}

async function handleCheckpointCommand(args, state, rl) {
  if (args[0]) {
    await restoreCheckpointById(args[0], state, rl);
    return;
  }

  const manifests = await listCheckpoints(state.sessionDir);

  if (manifests.length === 0) {
    console.log(renderInfoLine("checkpoints", "No checkpoints yet.", "gray"));
    return;
  }

  const selected = await chooseCheckpointFromMenu(manifests, state);

  if (!selected) {
    console.log(renderInfoLine("checkpoint", "restore cancelled", "gray"));
    return;
  }

  await restoreCheckpointById(selected.id, state, rl);
}

async function printCheckpoints(state) {
  const manifests = await listCheckpoints(state.sessionDir);

  if (manifests.length === 0) {
    console.log(renderInfoLine("checkpoints", "No checkpoints yet.", "gray"));
    return;
  }

  console.log(renderSectionTitle("Checkpoints"));
  manifests.forEach((manifest) => {
    const counts = manifest.changes
      ? `+${manifest.changes.totalAdded} -${manifest.changes.totalRemoved}`
      : "+0 -0";
    console.log(`${manifest.id} | ${manifest.createdAt} | ${manifest.mode} | ${counts}`);
    console.log(`  ${truncate(manifest.userMessage, 80)}`);
  });
}

function printTools(state) {
  const definitions = getToolDefinitions(state.mode);
  const names = listAllowedTools(state.mode);

  console.log(renderSectionTitle("Tools"));
  console.log(renderInfoLine("allowed", names.join(", "), "gray"));
  definitions.forEach((tool) => {
    console.log(`- ${tool.name}: ${tool.description}`);
  });
}

function printHelp() {
  const preferredNewlineShortcut = getPreferredNewlineShortcutLabel();

  console.log(renderSectionTitle("Commands"));
  console.log("Enter               Send the composed message");
  console.log(`New line            ${preferredNewlineShortcut}`);
  console.log("Ctrl+L              Add a new line fallback (works in all terminals)");
  console.log("Windows tip         If Shift+Enter fails, map it to ESC[13;2u in terminal settings");
  console.log("/help               Show this help");
  console.log("/mode               Show current mode");
  console.log("/mode <name>        Switch to advanced, medium, normal, or low");
  console.log("/provider           Open the provider setup wizard");
  console.log("/provider current   Show the current provider");
  console.log("/model              Open the model selector for the current provider");
  console.log("/model <name>       Switch model directly");
  console.log("/thinking           Show current thinking level");
  console.log("/thinking <level>   Set low, medium, high, or extra_high");
  console.log("/keep-alive         Show current model keep-alive duration");
  console.log("/keep-alive <time>  Set keep-alive (e.g., 10m, 1h, 24h, 48h)");
  console.log("/settings           Open the runtime settings menu");
  console.log("/checkpoint         Open checkpoint restore menu");
  console.log("/checkpoint <id>    Restore a specific checkpoint");
  console.log("/checkpoints        List current session checkpoints");
  console.log("/menu               Open quick action menu");
  console.log("/tools              Show tools allowed in the current mode");
  console.log("/session            Show current session and saved session list");
  console.log("/session list       List saved sessions");
  console.log("/session load <id>  Load a saved session and continue from it");
  console.log("/load-session <id>  Alias for /session load <id>");
  console.log("/config             Show active runtime configuration");
  console.log("/exit               Exit the CLI");
  console.log("Ctrl+C              Clear draft (or stop current response)");
  console.log("Ctrl+C twice        Exit the application");
}

async function loadSessionState(sessionDir) {
  const sessionFile = path.join(sessionDir, "session.json");

  if (!(await pathExists(sessionFile))) {
    return {
      history: [],
      checkpointIndex: 0
    };
  }

  const content = await fs.readFile(sessionFile, "utf8");
  const parsed = JSON.parse(content);

  return {
    history: Array.isArray(parsed.history) ? parsed.history : [],
    checkpointIndex: Number.isFinite(parsed.checkpointIndex) ? parsed.checkpointIndex : 0
  };
}

async function ensureProviderReady(state, rl) {
  const provider = getProviderDefinition(state.providerId || "custom");
  const providerMissing =
    !state.providerId ||
    !state.model ||
    !state.baseUrl ||
    (provider.requiresApiKey && !state.apiKey);

  if (!providerMissing) {
    return;
  }

  console.log(renderInfoLine("setup", "Provider setup is required before the first chat turn.", "yellow"));
  console.log("");
  await runProviderWizard(state, rl, state.providerId);
}

async function confirmWorkspaceApproval(state, rl) {
  console.log(renderSectionTitle("Workspace Approval"));
  console.log(renderInfoLine("workspace", state.cwd, "yellow"));
  console.log(renderInfoLine("warning", "This directory will be used as the trusted workspace root for file operations and checkpoints.", "red"));

  while (true) {
    const answer = (await rl.question('Approve this workspace? Type "yes" to continue or "no" to exit: ')).trim().toLowerCase();

    if (answer === "yes" || answer === "y") {
      console.log(renderInfoLine("workspace", "approved", "green"));
      console.log("");
      return true;
    }

    if (answer === "no" || answer === "n") {
      console.log(renderInfoLine("workspace", "approval denied, exiting.", "yellow"));
      return false;
    }

    console.log(renderInfoLine("error", 'Please answer with "yes" or "no".', "red"));
  }
}

async function runProviderWizard(state, rl, preferredProviderId = "") {
  const providerId = await promptForProvider(rl, preferredProviderId || state.providerId || "ollama");
  const provider = getProviderDefinition(providerId);
  const protocol =
    providerId === "custom"
      ? await promptForProtocol(rl, state.providerProtocol || provider.protocol)
      : provider.protocol;
  const baseUrl = await promptForBaseUrl(
    rl,
    state.providerId === providerId ? state.baseUrl : provider.defaultBaseUrl,
    providerId
  );
  const apiKey = await promptForApiKey(
    rl,
    provider,
    state.providerId === providerId ? state.apiKey : ""
  );

  const nextState = {
    ...state,
    providerId,
    providerLabel: provider.label,
    providerProtocol: protocol,
    baseUrl,
    apiKey
  };
  const model = await promptForModel(
    nextState,
    rl,
    state.providerId === providerId ? state.model : provider.defaultModel
  );

  state.providerId = providerId;
  state.providerLabel = provider.label;
  state.providerProtocol = protocol;
  state.baseUrl = baseUrl;
  state.apiKey = apiKey;
  state.model = model;

  await persistAppConfig(state);
  console.log(renderInfoLine("provider", `changed to ${state.providerLabel}`, "green"));
  console.log(renderInfoLine("model", state.model, "green"));
}

async function promptForProvider(rl, currentProviderId) {
  const providers = listProviders();

  console.log(renderSectionTitle("Providers"));
  providers.forEach((provider, index) => {
    console.log(`${index + 1}. ${provider.label} (${provider.id})`);
  });

  while (true) {
    const answer = (await rl.question(`Provider [${currentProviderId || "ollama"}]: `)).trim();

    if (!answer) {
      return currentProviderId || "ollama";
    }

    const byIndex = Number.parseInt(answer, 10);

    if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= providers.length) {
      return providers[byIndex - 1].id;
    }

    if (isProviderId(answer.toLowerCase())) {
      return answer.toLowerCase();
    }

    console.log(renderInfoLine("error", "Invalid provider. Enter a number or provider id.", "red"));
  }
}

async function promptForProtocol(rl, currentProtocol) {
  while (true) {
    const answer = (await rl.question(`Protocol [${currentProtocol || "openai"}] (openai/anthropic/ollama): `)).trim().toLowerCase();

    if (!answer) {
      return currentProtocol || "openai";
    }

    if (answer === "openai" || answer === "anthropic" || answer === "ollama") {
      return answer;
    }

    console.log(renderInfoLine("error", "Invalid protocol. Use openai, anthropic, or ollama.", "red"));
  }
}

async function promptForBaseUrl(rl, currentBaseUrl, providerId) {
  const label = providerId === "custom" ? "Custom base URL" : "Base URL";

  while (true) {
    const value = await promptWithDefault(rl, label, currentBaseUrl);

    if (value) {
      return value;
    }

    console.log(renderInfoLine("error", "A base URL is required.", "red"));
  }
}

async function promptForApiKey(rl, provider, currentApiKey) {
  if (!provider.requiresApiKey && provider.id !== "custom") {
    return promptWithDefault(rl, "API key (optional, press Enter to skip)", currentApiKey);
  }

  if (provider.id === "custom") {
    return promptWithDefault(rl, "API key (optional, press Enter to skip)", currentApiKey);
  }

  while (true) {
    const value = await promptWithDefault(rl, "API key", currentApiKey);

    if (value) {
      return value;
    }

    console.log(renderInfoLine("error", "This provider requires an API key.", "red"));
  }
}

async function promptForModel(state, rl, currentModel) {
  const models = await listAvailableModels({
    providerProtocol: state.providerProtocol,
    apiKey: state.apiKey,
    baseUrl: state.baseUrl
  });

  if (models.length > 0) {
    console.log(renderSectionTitle(`Models: ${state.providerLabel}`));
    models.slice(0, 12).forEach((model, index) => {
      console.log(`${index + 1}. ${model}`);
    });
    console.log("Enter a number from the list or type a custom model id.");
  } else {
    console.log(renderInfoLine("models", `No list available for ${state.providerLabel}. Enter the model name manually.`, "yellow"));
  }

  while (true) {
    const answer = (await rl.question(`Model${currentModel ? ` [${currentModel}]` : ""}: `)).trim();

    if (!answer) {
      if (currentModel) {
        return currentModel;
      }

      console.log(renderInfoLine("error", "A model name is required.", "red"));
      continue;
    }

    const byIndex = Number.parseInt(answer, 10);

    if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= Math.min(models.length, 12)) {
      return models[byIndex - 1];
    }

    return answer;
  }
}

async function promptWithDefault(rl, label, currentValue) {
  const answer = await rl.question(`${label}${currentValue ? ` [${currentValue}]` : ""}: `);
  return answer.trim() || currentValue || "";
}

async function persistAppConfig(state) {
  await saveAppConfig(state.appConfigPath, createStoredConfigFromState(state));
}

async function openQuickMenu(state, rl) {
  const items = [
    { label: "Settings", description: "Open runtime settings for mode, thinking, provider, and model.", action: async () => openSettingsMenu(state, rl) },
    { label: "Restore checkpoint", description: "Open checkpoint history and restore a snapshot.", action: async () => handleCheckpointCommand([], state, rl) },
    { label: "Change provider", description: "Switch provider and update base URL or API key.", action: async () => handleProviderCommand([], state, rl) },
    { label: "Change model", description: "Select or type a different model for the current provider.", action: async () => handleModelCommand([], state, rl) },
    { label: "Show tools", description: "Display the tools available in the active mode.", action: async () => printTools(state) },
    { label: "Show config", description: "Print the active runtime configuration.", action: async () => handleCommand("/config", state, rl) }
  ];

  const selected = await chooseFromMenu("Quick Menu", items, state);

  if (!selected) {
    printHome(state);
    return;
  }

  printHome(state);
  await selected.action();
}

async function openSettingsMenu(state, rl) {
  const items = [
    {
      label: `Mode: ${state.mode.label}`,
      description: "Switch between advanced, medium, normal, or low.",
      action: async () => {
        const selected = await chooseModeFromMenu(state);

        if (!selected) {
          console.log(renderInfoLine("mode", "unchanged", "gray"));
          return;
        }

        await handleModeCommand([selected.id], state);
      }
    },
    {
      label: `Thinking: ${state.reasoning.label}`,
      description: "Change the reasoning depth for future turns.",
      action: async () => {
        const selected = await chooseThinkingFromMenu(state);

        if (!selected) {
          console.log(renderInfoLine("thinking", "unchanged", "gray"));
          return;
        }

        await handleThinkingCommand([selected.id], state);
      }
    },
    {
      label: `Provider: ${state.providerLabel}`,
      description: "Change provider, base URL, and API key.",
      action: async () => handleProviderCommand([], state, rl)
    },
    {
      label: `Model: ${truncate(state.model || "(not set)", 36)}`,
      description: "Select or type a different model for the current provider.",
      action: async () => handleModelCommand([], state, rl)
    },
    {
      label: `Keep-alive: ${state.keepAlive}`,
      description: "Set model keep-alive duration (prevents timeout on slow responses).",
      action: async () => await handleKeepAliveCommand([], state)
    },
    {
      label: "Show config",
      description: "Print the active runtime configuration.",
      action: async () => handleCommand("/config", state, rl)
    }
  ];

  const selected = await chooseFromMenu("Settings", items, state);

  if (!selected) {
    printHome(state);
    return;
  }

  printHome(state);
  await selected.action();
}

async function chooseModeFromMenu(state) {
  const items = MODE_NAMES.map((modeName) => {
    const mode = getModeConfig(modeName);
    return {
      id: modeName,
      label: mode.label,
      description: mode.description
    };
  });

  return chooseFromMenu("Select Mode", items, state);
}

async function chooseThinkingFromMenu(state) {
  const items = REASONING_NAMES.map((reasoningName) => {
    const reasoning = getReasoningConfig(reasoningName);
    return {
      id: reasoningName,
      label: reasoning.label,
      description: reasoning.promptHint
    };
  });

  return chooseFromMenu("Select Thinking", items, state);
}

async function chooseCheckpointFromMenu(manifests, state) {
  const items = manifests
    .slice()
    .reverse()
    .map((manifest) => ({
      ...manifest,
      label: `${manifest.id}  ${manifest.userMessage.slice(0, 44)}`,
      description: `${manifest.mode} | +${manifest.changes?.totalAdded ?? 0} -${manifest.changes?.totalRemoved ?? 0} | ${manifest.createdAt}`
    }));

  return chooseFromMenu("Restore Checkpoint", items, state);
}

async function chooseFromMenu(title, items, state = null, options = {}) {
  if (!input.isTTY) {
    return items[0] ?? null;
  }

  readline.emitKeypressEvents(input);
  const previousRawMode = input.isRaw;

  if (input.isTTY) {
    input.setRawMode(true);
  }

  output.write("\u001b[?25l");

  let selectedIndex = 0;

  const render = () => {
    const rows = Math.max((output.rows ?? 20) - 8, 5);
    const windowStart = Math.min(
      Math.max(selectedIndex - Math.floor(rows / 2), 0),
      Math.max(items.length - rows, 0)
    );
    const visibleItems = items.slice(windowStart, windowStart + rows);

    output.write("\u001b[2J\u001b[H");
    if (state) {
      output.write(`${renderBanner(state.mode, state.model, state.providerLabel, state.reasoning?.label ?? "Medium")}\n\n`);
    }
    if (options.intro) {
      output.write(`${options.intro}\n\n`);
    }
    output.write(`${renderMenu(title, visibleItems, selectedIndex - windowStart, windowStart, items.length)}\n`);
  };

  render();

  return new Promise((resolve) => {
    const onKeypress = (_, key) => {
      if (!key) {
        return;
      }

      if (key.name === "up" || key.name === "left") {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        render();
        return;
      }

      if (key.name === "down" || key.name === "right") {
        selectedIndex = (selectedIndex + 1) % items.length;
        render();
        return;
      }

      if (key.name === "return") {
        cleanup(items[selectedIndex]);
        return;
      }

      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup(null);
      }
    };

    const cleanup = (value) => {
      input.off("keypress", onKeypress);
      if (input.isTTY) {
        input.setRawMode(previousRawMode);
      }
      output.write("\u001b[?25h\u001b[2J\u001b[H");
      resolve(value);
    };

    input.on("keypress", onKeypress);
  });
}

async function restoreCheckpointById(checkpointId, state, rl) {
  const manifests = await listCheckpoints(state.sessionDir);
  const manifest = manifests.find((entry) => entry.id === checkpointId);

  if (!manifest) {
    console.log(renderInfoLine("error", `Checkpoint not found: ${checkpointId}`, "red"));
    return;
  }

  const approved = await rl.question(`Restore checkpoint ${checkpointId}? Type "yes" to confirm: `);

  if (approved.trim().toLowerCase() !== "yes") {
    console.log(renderInfoLine("checkpoint", "restore cancelled", "gray"));
    return;
  }

  const snapshotDir = getCheckpointWorkspaceDir(state.sessionDir, checkpointId);
  await restoreWorkspaceFromSnapshot(snapshotDir, state.cwd);
  console.log(renderInfoLine("checkpoint", `restored ${checkpointId}`, "green"));
  console.log(renderChangeSummary(manifest.changes ?? { totalAdded: 0, totalRemoved: 0, files: [] }));
}

function printHome(state) {
  const preferredNewlineShortcut = getPreferredNewlineShortcutLabel();

  console.log(renderBanner(state.mode, state.model, state.providerLabel, state.reasoning.label));
  console.log(
    renderInfoLine(
      "hint",
      `Type /help for commands. Enter sends, ${preferredNewlineShortcut}. Ctrl+C clears draft (or stops a response).`,
      "gray"
    )
  );
  console.log(renderFooter());
}

function getPreferredNewlineShortcutLabel() {
  if (process.platform !== "win32") {
    return "Shift+Enter adds a new line";
  }

  if (process.env.TERM_PROGRAM === "vscode" || process.env.WT_SESSION) {
    return "Shift+Enter adds a new line (fallback: Ctrl+L)";
  }

  return "Ctrl+L adds a new line (Shift+Enter terminal-dependent)";
}

function truncate(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function startSpinner(label) {
  const frames = ["|", "/", "-", "\\"];
  const startedAt = Date.now();
  let frameIndex = 0;
  output.write(`${label} ${frames[0]} 0.0s`);

  const timer = setInterval(() => {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    frameIndex = (frameIndex + 1) % frames.length;
    output.write(`\r${label} ${frames[frameIndex]} ${seconds}s`);
  }, 120);

  return {
    startedAt,
    stop() {
      clearInterval(timer);
      output.write("\r");
      output.write(" ".repeat(32));
      output.write("\r");
    }
  };
}

function handleSigint(state) {
  const now = Date.now();

  if (now - state.lastHandledSigintEventAt < 100) {
    return;
  }

  state.lastHandledSigintEventAt = now;
  const isDoublePress =
    state.lastSigintContext === "idle" &&
    now - state.lastSigintAt <= 700;

  output.write("\n");

  if (!state.isProcessingTurn && isDoublePress) {
    state.exitRequested = true;

    if (state.activeTurnController) {
      state.turnInterrupted = true;
      state.activeTurnController.abort();
    }

    if (typeof state.activeInputCleanup === "function") {
      state.activeInputCleanup(null);
    } else {
      state.readline?.close();
    }

    console.log(renderInfoLine("exit", "Closing application...", "yellow"));
    return;
  }

  if (state.isProcessingTurn) {
    state.turnInterrupted = true;

    if (state.activeTurnController) {
      state.activeTurnController.abort();
    }

    state.lastSigintAt = 0;
    state.lastSigintContext = "running";
    console.log(renderInfoLine("interrupt", "Response stop requested.", "yellow"));
    return;
  }

  state.lastSigintAt = now;
  state.lastSigintContext = "idle";
  console.log(renderInfoLine("interrupt", "Press Ctrl+C again quickly to exit.", "yellow"));
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function shouldForceFileContentFollowUp(userMessage, createdPath = "", bytesWritten = 0) {
  const text = String(userMessage ?? "").toLowerCase();
  const wantsCreation = text.includes("create");
  const wantsContent =
    text.includes("write") ||
    text.includes("put") ||
    text.includes("add") ||
    text.includes("with ") ||
    text.includes("contain") ||
    text.includes("inside") ||
    text.includes("website") ||
    text.includes("web site") ||
    text.includes("landing page") ||
    text.includes("page") ||
    text.includes("ui");
  const pathText = String(createdPath ?? "").toLowerCase();
  const contentFile =
    pathText.endsWith(".html") ||
    pathText.endsWith(".css") ||
    pathText.endsWith(".js") ||
    pathText.endsWith(".ts") ||
    pathText.endsWith(".tsx") ||
    pathText.endsWith(".jsx") ||
    pathText.endsWith(".md");
  const smallInitialWrite = Number(bytesWritten ?? 0) < 120;

  return Number(bytesWritten ?? 0) === 0 || ((wantsCreation && wantsContent) || contentFile) && smallInitialWrite;
}

function normalizeToolCallForExecution(toolCall) {
  const payload = toolCall && typeof toolCall === "object" ? { ...toolCall, args: { ...(toolCall.args ?? {}) } } : toolCall;

  if (!payload || payload.tool !== "edit_file_lines") {
    return payload;
  }

  const startLine = Number(payload.args?.start_line ?? payload.args?.startLine);
  const endLine = Number(payload.args?.end_line ?? payload.args?.endLine);

  if (Number.isInteger(startLine) && startLine > 0 && Number.isInteger(endLine) && endLine >= startLine) {
    return payload;
  }

  const content = String(payload.args?.content ?? "");

  if (!looksLikeWholeFileRewrite(content)) {
    return payload;
  }

  return {
    tool: "write_file",
    args: {
      path: payload.args?.path,
      content
    },
    promotedFrom: "edit_file_lines"
  };
}

function looksLikeWholeFileRewrite(content) {
  const text = String(content ?? "").replaceAll("\r\n", "\n").trim();

  if (!text) {
    return false;
  }

  const lines = text.split("\n");
  const firstNonEmptyLine = lines.find((line) => line.trim())?.trim() ?? "";
  const longMultilineContent = lines.length >= 8 || text.length >= 280;
  const wholeFileStart =
    /^(<!DOCTYPE html>|<html\b|import\s+\w|from\s+\w|const\s+\w|let\s+\w|var\s+\w|function\s+\w|class\s+\w|def\s+\w|public\s+class\s+\w|using\s+\w|package\s+\w|#include\s+[<"])/i.test(firstNonEmptyLine);

  return longMultilineContent && wholeFileStart;
}

function buildToolFailureRepairInstruction(toolName, args, result) {
  if (result?.ok) {
    return "";
  }

  const message = String(result?.message ?? "").toLowerCase();
  const content = String(args?.content ?? "");

  if (toolName === "edit_file_lines" && (message.includes("start_line") || message.includes("end_line"))) {
    if (looksLikeWholeFileRewrite(content)) {
      return "Your last edit_file_lines call was invalid because it did not include a numeric start_line/end_line, and the payload looked like a whole-file rewrite. Retry immediately with write_file for the full corrected file content. Do not ask the user for more input.";
    }

    return "Your last edit_file_lines call was invalid because it did not include a valid numeric start_line/end_line. Read the file result's numberedContent, then retry with exact 1-based line numbers. If you intend to replace most of the file, use write_file instead. Do not ask the user for more input.";
  }

  if (toolName === "replace_in_file" && message.includes("text not found")) {
    return "Your replace_in_file call did not match the current file content. Re-read the file if needed, then retry with exact text from the file or use edit_file_lines with exact numbered lines. Do not ask the user for more input.";
  }

  if (toolName === "write_file" && message.includes("refused to write empty content")) {
    return "Your write_file call tried to clear the file with empty content. Retry with actual file content. For small targeted fixes, prefer edit_file_lines or replace_in_file. Do not ask the user for more input.";
  }

  return "";
}

function shouldForceAskQuestionTool(state, userMessage, assistantContent, toolsUsed = []) {
  if (!state.mode.allowAskQuestion) {
    return false;
  }

  const request = String(userMessage ?? "").toLowerCase();
  const response = String(assistantContent ?? "").toLowerCase();
  const alreadyUsedTools = toolsUsed.some((item) => item.ok);
  const likelyCreativeTask =
    request.includes("website") ||
    request.includes("web site") ||
    request.includes("landing page") ||
    request.includes("homepage") ||
    request.includes("ui") ||
    request.includes("design");
  const asksQuestion =
    response.includes("?") ||
    response.includes("please choose") ||
    response.includes("please provide your choice") ||
    response.includes("please specify your choice") ||
    response.includes("please specify") ||
    response.includes("which") ||
    response.includes("what kind") ||
    response.includes("what type") ||
    response.includes("what style") ||
    response.includes("what would you like") ||
    response.includes("here are some options") ||
    response.includes("here are a few options") ||
    response.includes("choose one of the following") ||
    response.includes("provide additional details") ||
    response.includes("could you please provide") ||
    response.includes("i need more details") ||
    response.includes("once i know your preference") ||
    response.includes("once i know your preferences") ||
    response.includes("let's clarify") ||
    response.includes("clarify the type") ||
    response.includes("clarify what kind") ||
    response.includes("clarify what type") ||
    response.includes("clarification") ||
    response.includes("to proceed") ||
    response.includes("preference") ||
    response.includes("preferences");

  return likelyCreativeTask && !alreadyUsedTools && asksQuestion;
}

function shouldForceAssumeAndBuild(state, userMessage, assistantContent, toolsUsed = []) {
  if (state.mode.allowAskQuestion) {
    return false;
  }

  const request = String(userMessage ?? "").toLowerCase();
  const response = String(assistantContent ?? "").toLowerCase();
  const alreadyUsedTools = toolsUsed.some((item) => item.ok);
  const likelyCreativeBuild =
    request.includes("website") ||
    request.includes("web site") ||
    request.includes("landing page") ||
    request.includes("homepage") ||
    request.includes("ui") ||
    request.includes("design") ||
    request.includes("component");
  const asksForMoreInput =
    response.includes("?") ||
    response.includes("what kind") ||
    response.includes("what type") ||
    response.includes("what style") ||
    response.includes("please provide") ||
    response.includes("please specify") ||
    response.includes("i need more details") ||
    response.includes("once i know") ||
    response.includes("let's clarify") ||
    response.includes("clarification") ||
    response.includes("preference") ||
    response.includes("preferences");

  return likelyCreativeBuild && !alreadyUsedTools && asksForMoreInput;
}

function shouldForceImplementationTools(userMessage, assistantContent, toolsUsed, activeTaskContext = null) {
  const effectiveRequest = String(activeTaskContext?.activeRequest ?? userMessage ?? "").toLowerCase();
  const response = String(assistantContent ?? "").toLowerCase();
  const creationTask =
    effectiveRequest.includes("create") ||
    effectiveRequest.includes("build") ||
    effectiveRequest.includes("make") ||
    effectiveRequest.includes("implement");
  const fileLikeTask =
    effectiveRequest.includes("website") ||
    effectiveRequest.includes("web site") ||
    effectiveRequest.includes("html") ||
    effectiveRequest.includes("file") ||
    effectiveRequest.includes("page") ||
    effectiveRequest.includes("game") ||
    effectiveRequest.includes("app") ||
    effectiveRequest.includes("script") ||
    effectiveRequest.includes("python") ||
    effectiveRequest.includes("javascript") ||
    effectiveRequest.includes("typescript") ||
    effectiveRequest.includes("react") ||
    effectiveRequest.includes("component");
  const alreadyEditedFiles = toolsUsed.some((item) =>
    item.tool === "create_file" || item.tool === "write_file" || item.tool === "edit_file_lines" || item.tool === "replace_in_file"
  );
  const responseIsJustExplanation =
    response.includes("would you like me to create") ||
    response.includes("here is the content") ||
    response.includes("here is the code") ||
    response.includes("let's create") ||
    response.includes("creating the file") ||
    response.includes("how we can proceed") ||
    response.includes("how we should proceed") ||
    response.includes("great choice") ||
    response.includes("got it!") ||
    response.includes("once i have this information") ||
    response.includes("i can create");

  return creationTask && fileLikeTask && !alreadyEditedFiles && responseIsJustExplanation;
}

function shouldForceRepairTools(userMessage, assistantContent, toolsUsed, activeTaskContext = null) {
  const request = String(userMessage ?? "").toLowerCase();
  const response = String(assistantContent ?? "").toLowerCase();
  const activeRequest = String(activeTaskContext?.activeRequest ?? "").toLowerCase();
  const alreadyEditedFiles = toolsUsed.some((item) =>
    item.tool === "read_file" || item.tool === "write_file" || item.tool === "edit_file_lines" || item.tool === "replace_in_file"
  );
  const issueReported =
    request.includes("syntaxerror") ||
    request.includes("traceback") ||
    request.includes("invalid syntax") ||
    request.includes("exception") ||
    request.includes("error") ||
    request.includes("fix") ||
    request.includes("edit") ||
    request.includes("broken") ||
    request.includes("doesn't work") ||
    request.includes("does not work");
  const hasActiveImplementation =
    Boolean(activeRequest) && looksLikeImplementationRequest(activeRequest);
  const responseIsDeflecting =
    response.includes("please provide more details") ||
    response.includes("could you please provide more details") ||
    response.includes("this will help me assist you better") ||
    response.includes("what specific enhancements") ||
    response.includes("please let me know which feature") ||
    response.includes("would you like to run this code") ||
    response.includes("would you like to run this game") ||
    response.includes("would you like to make any changes") ||
    response.includes("here is the corrected version") ||
    response.includes("let's try") ||
    response.includes("we'll start by writing") ||
    response.includes("here is a simple implementation");

  return issueReported && hasActiveImplementation && !alreadyEditedFiles && responseIsDeflecting;
}

function shouldUseSelfReview(state, userMessage, assistantContent, toolsUsed, selfReviewCount) {
  if ((state.reasoning?.selfReviewPasses ?? 0) <= selfReviewCount) {
    return false;
  }

  const request = String(userMessage ?? "").toLowerCase();
  const response = String(assistantContent ?? "").toLowerCase();
  const complexBuildTask =
    request.includes("create") ||
    request.includes("build") ||
    request.includes("make") ||
    request.includes("implement");
  const fileOrUiTask =
    request.includes("website") ||
    request.includes("web site") ||
    request.includes("landing page") ||
    request.includes("ui") ||
    request.includes("component") ||
    request.includes("html") ||
    request.includes("file");
  const noToolWorkYet = toolsUsed.length === 0;
  const weakReply =
    response.length < 220 ||
    response.includes("what style") ||
    response.includes("what type") ||
    response.includes("what kind") ||
    response.includes("once i know") ||
    response.includes("i can guide") ||
    response.includes("would you like me") ||
    response.includes("please provide");

  return complexBuildTask && fileOrUiTask && noToolWorkYet && weakReply;
}

function getResponseProtocol(state) {
  return state.providerProtocol === "ollama" ? "json" : "xml";
}

function normalizeHistoryForProtocol(history, responseProtocol) {
  return history.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }

    const parsed = parseAssistantEnvelope(message.content);

    if (responseProtocol === "json") {
      if (parsed.type === "tool") {
        return {
          ...message,
          content: JSON.stringify(parsed.payload)
        };
      }

      return {
        ...message,
        content: parsed.type === "final" ? parsed.content : String(message.content ?? "")
      };
    }

    return message;
  });
}

function formatAssistantHistoryContent(content, responseProtocol) {
  if (responseProtocol === "json") {
    return String(content ?? "");
  }

  return `<final>${content}</final>`;
}

function buildProtocolRepairMessage(responseProtocol, errorText) {
  if (responseProtocol === "json") {
    return `Protocol error: ${errorText}. Repeat the response using either one raw JSON tool object like {"tool":"read_file","args":{"path":"README.md"}} or one plain English final answer only.`;
  }

  return `Protocol error: ${errorText}. Repeat the response using a valid <tool_call> or <final> block only.`;
}

function buildAskQuestionRepairMessage(responseProtocol) {
  if (responseProtocol === "json") {
    return 'You asked the user a clarifying question in plain text. Your previous reply was ignored. Repeat this turn using only a raw JSON ask_question tool call and no extra prose. Generate 3 or 4 fresh task-specific options plus a custom answer path. Example shape only: {"tool":"ask_question","args":{"question":"<short question>","options":["<task-specific option 1>","<task-specific option 2>","<task-specific option 3>"],"related_to":"<short task summary>"}}';
  }

  return 'You asked the user a clarifying question in plain text. Your previous reply was ignored. Repeat this turn using the ask_question tool only and output no prose outside the tool call. Generate 3 or 4 fresh task-specific options plus a custom answer path. Example shape only: <tool_call>{"tool":"ask_question","args":{"question":"<short question>","options":["<task-specific option 1>","<task-specific option 2>","<task-specific option 3>"],"related_to":"<short task summary>"}}</tool_call>';
}

function isSelfReviewAcknowledgement(content) {
  const text = String(content ?? "").toLowerCase();
  return (
    text.includes("i will self-review") ||
    text.includes("i will self review") ||
    text.includes("self-review this turn") ||
    text.includes("self review this turn") ||
    text.includes("before answering")
  );
}

function buildAssumeAndBuildInstruction(state) {
  if (state.mode.name === "low") {
    return "Do not ask for clarification in this mode. Assume simple defaults and continue implementation now. Prefer one working index.html with inline CSS and clear sections. Use file tools, not prose.";
  }

  if (state.mode.name === "normal") {
    return "Do not ask for clarification in this mode. Assume sensible defaults and continue implementation now. Create a clean responsive version with local files and minimal dependencies. Use file tools, not prose.";
  }

  return "Do not ask for clarification in this mode. Assume practical modern defaults and continue implementation now. Build an editable first version with file tools instead of prose.";
}

function deriveActiveTaskContext(history, userMessage) {
  const reply = String(userMessage ?? "").trim();

  if (!isShortContinuationReply(reply)) {
    return null;
  }

  let activeRequest = "";

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];

    if (entry.role !== "user") {
      continue;
    }

    const content = String(entry.content ?? "").trim();

    if (looksLikeImplementationRequest(content)) {
      activeRequest = content;
      break;
    }
  }

  if (!activeRequest) {
    return null;
  }

  return {
    activeRequest
  };
}

function isShortContinuationReply(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    return false;
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return (
    text.length <= 32 &&
    wordCount <= 4
  );
}

function looksLikeImplementationRequest(value) {
  const text = String(value ?? "").toLowerCase();

  return (
    text.includes("create") ||
    text.includes("build") ||
    text.includes("make") ||
    text.includes("implement") ||
    text.includes("fix") ||
    text.includes("update")
  ) && (
    text.includes("website") ||
    text.includes("web site") ||
    text.includes("page") ||
    text.includes("html") ||
    text.includes("game") ||
    text.includes("app") ||
    text.includes("script") ||
    text.includes("component") ||
    text.includes("ui") ||
    text.includes("python") ||
    text.includes("javascript") ||
    text.includes("typescript") ||
    text.includes("react")
  );
}

async function promptForChatInput(state, rl) {
  if (!input.isTTY) {
    return rl.question(renderUserPrompt(state.modeName));
  }

  rl.pause();
  readline.emitKeypressEvents(input);
  input.resume();

  const previousRawMode = input.isRaw;
  let enhancedInputEnabled = false;

  if (input.isTTY) {
    input.setRawMode(true);
    enhancedInputEnabled = enableTerminalInputEnhancements();
  }

  let typedText = "";
  let pastedText = "";
  let commandSuggestions = [];
  let renderedLineCount = 0;
  let cursorIndex = 0;
  const historyEntries = getComposerHistoryEntries(state.history, state.composerRecallHistory);
  let historyIndex = historyEntries.length;
  let draftEntry = null;
  let rapidInputBuffer = "";
  let rapidInputEventCount = 0;
  let rapidInputLastAt = 0;
  let rapidInputTimer = null;
  let lastEscapeAt = 0;

  const render = () => {
    clearRenderedComposer(renderedLineCount);
    const block = renderChatComposer(state.modeName, typedText, pastedText, commandSuggestions);
    output.write(block);
    renderedLineCount = countRenderedLines(block);
    positionComposerCursor(state.modeName, typedText, cursorIndex);
  };

  const setComposerValue = (entry) => {
    typedText = String(entry?.typedText ?? "");
    pastedText = String(entry?.pastedText ?? "");
    cursorIndex = typedText.length;
    commandSuggestions = [];
  };

  const snapshotDraft = () => ({
    typedText,
    pastedText
  });

  const leaveHistoryNavigation = () => {
    if (historyIndex < historyEntries.length) {
      historyIndex = historyEntries.length;
      draftEntry = snapshotDraft();
    } else {
      draftEntry = snapshotDraft();
    }
  };

  const resetRapidInput = () => {
    rapidInputBuffer = "";
    rapidInputEventCount = 0;
    rapidInputLastAt = 0;

    if (rapidInputTimer) {
      clearTimeout(rapidInputTimer);
      rapidInputTimer = null;
    }
  };

  const flushRapidInput = (options = {}) => {
    const { forceTyped = false } = options;

    if (!rapidInputBuffer) {
      return;
    }

    const bufferedText = rapidInputBuffer;
    const eventCount = rapidInputEventCount;
    resetRapidInput();

    if (shouldTreatBufferedInputAsPaste(bufferedText, eventCount) && !forceTyped) {
      pastedText = appendPastedText(pastedText, normalizePastedText(bufferedText));
    } else {
      typedText = typedText.slice(0, cursorIndex) + bufferedText + typedText.slice(cursorIndex);
      cursorIndex += bufferedText.length;
    }

    commandSuggestions = [];
    render();
  };

  const scheduleRapidFlush = () => {
    if (rapidInputTimer) {
      clearTimeout(rapidInputTimer);
    }

    rapidInputTimer = setTimeout(() => {
      flushRapidInput();
    }, 24);
  };

  render();

  return new Promise((resolve) => {
    let cleanedUp = false;

    const onKeypress = (str, key) => {
      if (!key) {
        return;
      }

      const sequence = typeof str === "string" ? str : String(key.sequence ?? "");

      if (key.name === "escape" && sequence === "\u001b") {
        lastEscapeAt = Date.now();
        return;
      }

      if (key.ctrl && key.name === "c") {
        flushRapidInput({ forceTyped: true });

        const draft = snapshotDraft();

        if (hasComposerDraftContent(draft)) {
          rememberComposerRecallEntry(state, historyEntries, draft);
          typedText = "";
          pastedText = "";
          cursorIndex = 0;
          historyIndex = historyEntries.length;
          draftEntry = null;
          commandSuggestions = [];
          render();
          return;
        }

        handleSigint(state);

        if (state.exitRequested) {
          cleanup(null);
          return;
        }

        commandSuggestions = [];
        render();
        return;
      }

      if (isComposerIgnoredShortcut(key, sequence)) {
        flushRapidInput({ forceTyped: true });
        commandSuggestions = [];
        render();
        return;
      }

      if (key.name === "linefeed") {
        flushRapidInput({ forceTyped: true });

        // Only consume silently if it's Ctrl+J (Ctrl+Linefeed) but not with Shift
        if ((key.ctrl && !key.shift) || (key.meta && !key.shift)) {
          commandSuggestions = [];
          render();
          return;
        }

        leaveHistoryNavigation();
        typedText = typedText.slice(0, cursorIndex) + "\n" + typedText.slice(cursorIndex);
        cursorIndex += 1;
        commandSuggestions = [];
        render();
        return;
      }

      if (isComposerNewLineShortcut(key, sequence, lastEscapeAt)) {
        flushRapidInput({ forceTyped: true });
        leaveHistoryNavigation();
        typedText = typedText.slice(0, cursorIndex) + "\n" + typedText.slice(cursorIndex);
        cursorIndex += 1;
        commandSuggestions = [];
        render();
        return;
      }

      // Ctrl+L for newline (Windows PowerShell workaround for Shift+Enter)
      if (key.ctrl && key.name === "l") {
        flushRapidInput({ forceTyped: true });
        leaveHistoryNavigation();
        typedText = typedText.slice(0, cursorIndex) + "\n" + typedText.slice(cursorIndex);
        cursorIndex += 1;
        commandSuggestions = [];
        render();
        return;
      }

      if (isComposerSendShortcut(key, sequence, lastEscapeAt)) {
        const now = Date.now();

        if (rapidInputBuffer && now - rapidInputLastAt <= 40) {
          rapidInputBuffer += "\n";
          rapidInputEventCount += 1;
          rapidInputLastAt = now;
          scheduleRapidFlush();
          return;
        }

        flushRapidInput({ forceTyped: true });
        cleanup(buildComposedUserMessage(typedText, pastedText));
        return;
      }

      if (key.name === "up") {
        flushRapidInput({ forceTyped: true });

        if (historyEntries.length === 0) {
          return;
        }

        if (historyIndex === historyEntries.length) {
          draftEntry = snapshotDraft();
        }

        if (historyIndex > 0) {
          historyIndex -= 1;
          setComposerValue(historyEntries[historyIndex]);
          render();
        }
        return;
      }

      if (key.name === "down") {
        flushRapidInput({ forceTyped: true });

        if (historyIndex === historyEntries.length) {
          return;
        }

        if (historyIndex < historyEntries.length - 1) {
          historyIndex += 1;
          setComposerValue(historyEntries[historyIndex]);
        } else {
          historyIndex = historyEntries.length;
          setComposerValue(draftEntry ?? { typedText: "", pastedText: "" });
        }

        render();
        return;
      }

      if (key.name === "backspace") {
        flushRapidInput({ forceTyped: true });

        if (cursorIndex > 0) {
          leaveHistoryNavigation();
          typedText = typedText.slice(0, cursorIndex - 1) + typedText.slice(cursorIndex);
          cursorIndex -= 1;
          commandSuggestions = [];
          render();
        }
        return;
      }

      if (key.name === "delete") {
        flushRapidInput({ forceTyped: true });

        if (cursorIndex < typedText.length) {
          leaveHistoryNavigation();
          typedText = typedText.slice(0, cursorIndex) + typedText.slice(cursorIndex + 1);
          commandSuggestions = [];
          render();
        }
        return;
      }

      if (key.name === "left") {
        flushRapidInput({ forceTyped: true });

        if (cursorIndex > 0) {
          cursorIndex -= 1;
          render();
        }
        return;
      }

      if (key.name === "right") {
        flushRapidInput({ forceTyped: true });

        if (cursorIndex < typedText.length) {
          cursorIndex += 1;
          render();
        }
        return;
      }

      if (key.name === "home") {
        flushRapidInput({ forceTyped: true });
        cursorIndex = 0;
        render();
        return;
      }

      if (key.name === "end") {
        flushRapidInput({ forceTyped: true });
        cursorIndex = typedText.length;
        render();
        return;
      }

      if (key.ctrl && key.name === "x") {
        flushRapidInput({ forceTyped: true });

        if (pastedText) {
          leaveHistoryNavigation();
          pastedText = "";
          commandSuggestions = [];
          render();
        }
        return;
      }

      if (key.name === "tab") {
        flushRapidInput({ forceTyped: true });
        const matches = getCommandMatches(typedText);

        if (matches.length === 1) {
          typedText = matches[0];
          cursorIndex = typedText.length;
          commandSuggestions = [];
        } else {
          commandSuggestions = matches.slice(0, 8);
        }

        render();
        return;
      }

      if (isLikelyPasteSequence(sequence, key)) {
        flushRapidInput({ forceTyped: true });
        leaveHistoryNavigation();
        pastedText = appendPastedText(pastedText, normalizePastedText(sequence));
        commandSuggestions = [];
        render();
        return;
      }

      if (key.ctrl || key.meta) {
        return;
      }

      if (isPrintableSequence(sequence)) {
        const now = Date.now();
        const shouldBuffer = shouldBufferRapidInput(sequence, now, rapidInputLastAt, rapidInputBuffer);

        if (shouldBuffer) {
          leaveHistoryNavigation();
          rapidInputBuffer += sequence;
          rapidInputEventCount += 1;
          rapidInputLastAt = now;
          scheduleRapidFlush();
          return;
        }

        flushRapidInput({ forceTyped: true });
        leaveHistoryNavigation();
        typedText = typedText.slice(0, cursorIndex) + sequence + typedText.slice(cursorIndex);
        cursorIndex += sequence.length;
        commandSuggestions = [];
        render();
      }
    };

    const cleanup = (value) => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      if (state.activeInputCleanup === cleanup) {
        state.activeInputCleanup = null;
      }

      if (enhancedInputEnabled) {
        disableTerminalInputEnhancements();
        enhancedInputEnabled = false;
      }

      resetRapidInput();
      input.off("keypress", onKeypress);

      if (input.isTTY) {
        try {
          input.setRawMode(previousRawMode);
        } catch {
          // Ignore teardown errors while the terminal is closing.
        }
      }

      try {
        input.pause();
      } catch {
        // Ignore stdin teardown errors while leaving composer mode.
      }

      if (!state.exitRequested) {
        try {
          rl.resume();
        } catch {
          // Ignore use-after-close when readline was already shut down.
        }
      }

      if (!state.exitRequested) {
        output.write("\n");
      }

      resolve(value);
    };

    state.activeInputCleanup = cleanup;
    input.on("keypress", onKeypress);
  });
}

function clearRenderedComposer(lineCount) {
  if (!lineCount) {
    return;
  }

  for (let index = 0; index < lineCount; index += 1) {
    readline.cursorTo(output, 0);
    readline.clearLine(output, 0);

    if (index < lineCount - 1) {
      readline.moveCursor(output, 0, -1);
    }
  }

  readline.cursorTo(output, 0);
}

function countRenderedLines(text) {
  const width = getComposerWidth();
  return String(text ?? "")
    .split("\n")
    .reduce((total, line) => total + countWrappedVisualLines(stripAnsi(line), width), 0);
}

function positionComposerCursor(modeName, typedText, cursorIndex) {
  const width = getComposerWidth();
  const promptText = stripAnsi(renderUserPrompt(modeName));
  const value = String(typedText ?? "");
  const clampedCursorIndex = Math.max(0, Math.min(cursorIndex, value.length));
  const fullMetrics = measureVisualCursor(`${promptText}${value}`, width);
  const cursorMetrics = measureVisualCursor(`${promptText}${value.slice(0, clampedCursorIndex)}`, width);
  const moveUp = Math.max(0, fullMetrics.row - cursorMetrics.row);

  if (moveUp > 0) {
    readline.moveCursor(output, 0, -moveUp);
  }

  readline.cursorTo(output, cursorMetrics.column);
}

function buildComposedUserMessage(typedText, pastedText) {
  const messageText = String(typedText ?? "").replaceAll("\r\n", "\n").trimEnd();
  const pasted = String(pastedText ?? "").replaceAll("\r\n", "\n").trimEnd();

  if (!pasted) {
    return messageText;
  }

  return messageText ? `${messageText}\n${pasted}` : pasted;
}

function getCommandMatches(value) {
  const line = String(value ?? "");

  if (!line.startsWith("/")) {
    return [];
  }

  return COMMANDS.filter((command) => command.startsWith(line));
}

function isLikelyPasteSequence(sequence, key) {
  if (!sequence) {
    return false;
  }

  if (key.name === "return" || key.name === "tab" || key.name === "backspace") {
    return false;
  }

  if ((sequence === "\n" || sequence === "\r") && sequence.length === 1) {
    return false;
  }

  if (sequence.includes("\u001b[200~") || sequence.includes("\u001b[201~")) {
    return true;
  }

  return sequence.includes("\n") || sequence.includes("\r") || sequence.length > 4;
}

function normalizePastedText(sequence) {
  return String(sequence ?? "")
    .replaceAll("\u001b[200~", "")
    .replaceAll("\u001b[201~", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function appendPastedText(existingText, nextText) {
  const current = String(existingText ?? "");
  const incoming = String(nextText ?? "");

  if (!incoming) {
    return current;
  }

  if (!current) {
    return incoming;
  }

  if (current.endsWith("\n") || incoming.startsWith("\n")) {
    return `${current}${incoming}`;
  }

  return `${current}\n${incoming}`;
}

function shouldBufferRapidInput(sequence, now, previousEventAt, existingBuffer) {
  const text = String(sequence ?? "");

  if (!text) {
    return false;
  }

  if (existingBuffer) {
    return true;
  }

  if (text.length > 1) {
    return true;
  }

  return previousEventAt > 0 && now - previousEventAt <= 14;
}

function shouldTreatBufferedInputAsPaste(text, eventCount) {
  const value = String(text ?? "");

  if (!value) {
    return false;
  }

  return (
    value.includes("\n") ||
    value.includes("\r") ||
    value.length >= 24 ||
    eventCount >= 4
  );
}

function isComposerIgnoredShortcut(key, sequence) {
  if (key?.ctrl && (key.name === "s" || key.name === "j" || key.name === "linefeed")) {
    return true;
  }

  const value = String(sequence ?? "");

  return process.platform === "win32" && key?.ctrl && value === "\n";
}

function isComposerNewLineShortcut(key, sequence, lastEscapeAt = 0) {
  if ((key?.name === "return" || key?.name === "enter") && (key.shift || key.meta)) {
    return true;
  }

  const value = String(sequence ?? "");

  if (isShiftEnterEscapeSequence(value)) {
    return true;
  }

  if ((key?.name === "return" || key?.name === "enter") && Date.now() - Number(lastEscapeAt ?? 0) <= 120) {
    return true;
  }

  return false;
}

function isComposerSendShortcut(key, sequence, lastEscapeAt = 0) {
  if (key?.name !== "return" && key?.name !== "enter") {
    return false;
  }

  if (key.ctrl || key.shift || key.meta) {
    return false;
  }

  const value = String(sequence ?? "");

  if (Date.now() - Number(lastEscapeAt ?? 0) <= 120) {
    return false;
  }

  if (isShiftEnterEscapeSequence(value)) {
    return false;
  }

  if (process.platform === "win32" && value === "\n") {
    return false;
  }

  return value === "" || value === "\r" || value === "\n";
}

function isShiftEnterEscapeSequence(sequence) {
  const value = String(sequence ?? "");

  if (!value) {
    return false;
  }

  if (value === "\u001b\r" || value === "\u001b\n") {
    return true;
  }

  if (value === "\u001b[13;2u" || value === "\u001b[27;2;13~") {
    return true;
  }

  return (
    value.startsWith("\u001b[") &&
    value.includes("13") &&
    value.includes(";2") &&
    (value.endsWith("u") || value.endsWith("~"))
  );
}

function isPrintableSequence(sequence) {
  if (!sequence) {
    return false;
  }

  return !/[\u0000-\u001f\u007f]/.test(sequence);
}

function getComposerHistoryEntries(history, recallHistory = []) {
  const sentEntries = history
    .filter((entry) => entry?.role === "user")
    .map((entry) => splitComposedUserMessage(entry.content));
  const recalledEntries = Array.isArray(recallHistory)
    ? recallHistory.map((entry) => ({
        typedText: String(entry?.typedText ?? ""),
        pastedText: String(entry?.pastedText ?? "")
      }))
    : [];

  return dedupeComposerEntries([...sentEntries, ...recalledEntries]);
}

function dedupeComposerEntries(entries) {
  const deduped = [];

  for (const entry of entries) {
    const normalized = {
      typedText: String(entry?.typedText ?? ""),
      pastedText: String(entry?.pastedText ?? "")
    };

    if (!hasComposerDraftContent(normalized)) {
      continue;
    }

    const last = deduped[deduped.length - 1];

    if (last && last.typedText === normalized.typedText && last.pastedText === normalized.pastedText) {
      continue;
    }

    deduped.push(normalized);
  }

  return deduped;
}

function hasComposerDraftContent(entry) {
  const typedText = String(entry?.typedText ?? "").trim();
  const pastedText = String(entry?.pastedText ?? "").trim();
  return Boolean(typedText || pastedText);
}

function rememberComposerRecallEntry(state, historyEntries, entry) {
  const normalized = {
    typedText: String(entry?.typedText ?? ""),
    pastedText: String(entry?.pastedText ?? "")
  };

  if (!hasComposerDraftContent(normalized)) {
    return;
  }

  if (!Array.isArray(state.composerRecallHistory)) {
    state.composerRecallHistory = [];
  }

  const recall = state.composerRecallHistory;
  const lastSaved = recall[recall.length - 1];

  if (lastSaved && lastSaved.typedText === normalized.typedText && lastSaved.pastedText === normalized.pastedText) {
    if (historyEntries.length === 0) {
      historyEntries.push(normalized);
      return;
    }

    const lastHistory = historyEntries[historyEntries.length - 1];

    if (lastHistory.typedText !== normalized.typedText || lastHistory.pastedText !== normalized.pastedText) {
      historyEntries.push(normalized);
    }

    return;
  }

  recall.push(normalized);

  if (recall.length > 80) {
    recall.shift();
  }

  historyEntries.push(normalized);
}

function rememberSubmittedComposerEntry(state, submittedText) {
  const normalizedText = String(submittedText ?? "")
    .replaceAll("\r\n", "\n")
    .trimEnd();
  const entry = splitComposedUserMessage(normalizedText);

  if (!hasComposerDraftContent(entry)) {
    return;
  }

  if (!Array.isArray(state.composerRecallHistory)) {
    state.composerRecallHistory = [];
  }

  const normalizedEntry = {
    typedText: String(entry.typedText ?? ""),
    pastedText: String(entry.pastedText ?? "")
  };
  const lastEntry = state.composerRecallHistory[state.composerRecallHistory.length - 1];

  if (lastEntry && lastEntry.typedText === normalizedEntry.typedText && lastEntry.pastedText === normalizedEntry.pastedText) {
    return;
  }

  state.composerRecallHistory.push(normalizedEntry);

  if (state.composerRecallHistory.length > 160) {
    state.composerRecallHistory.shift();
  }
}

function splitComposedUserMessage(content) {
  const normalized = String(content ?? "").replaceAll("\r\n", "\n");
  const match = normalized.match(/^(?<typed>[\s\S]*?)(?:\n\n)?Pasted text:\n```text\n(?<pasted>[\s\S]*?)\n```$/);

  if (!match?.groups) {
    return {
      typedText: normalized,
      pastedText: ""
    };
  }

  return {
    typedText: String(match.groups.typed ?? ""),
    pastedText: String(match.groups.pasted ?? "")
  };
}

function enableTerminalInputEnhancements() {
  if (!output.isTTY) {
    return false;
  }

  try {
    output.write(TERMINAL_INPUT_ENHANCEMENTS.csiUEnable);
    output.write(TERMINAL_INPUT_ENHANCEMENTS.modifyOtherKeysEnable);
    output.write(TERMINAL_INPUT_ENHANCEMENTS.bracketedPasteEnable);
    return true;
  } catch {
    return false;
  }
}

function disableTerminalInputEnhancements() {
  if (!output.isTTY) {
    return;
  }

  try {
    output.write(TERMINAL_INPUT_ENHANCEMENTS.bracketedPasteDisable);
    output.write(TERMINAL_INPUT_ENHANCEMENTS.modifyOtherKeysDisable);
    output.write(TERMINAL_INPUT_ENHANCEMENTS.csiUDisable);
  } catch {
    // Ignore terminal teardown errors while the session is ending.
  }
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

function getComposerWidth() {
  const width = Number(output.columns ?? 80);
  return Number.isFinite(width) && width > 0 ? width : 80;
}

function countWrappedVisualLines(text, width) {
  const length = String(text ?? "").length;
  return Math.max(1, Math.ceil(Math.max(length, 1) / width));
}

function measureVisualCursor(text, width) {
  const normalizedWidth = Math.max(1, Number(width ?? 80) || 80);
  const value = String(text ?? "").replaceAll("\r\n", "\n");
  let row = 1;
  let column = 0;

  for (const character of value) {
    if (character === "\n") {
      row += 1;
      column = 0;
      continue;
    }

    column += 1;

    if (column >= normalizedWidth) {
      row += 1;
      column = 0;
    }
  }

  return { row, column };
}

function createCommandCompleter() {
  return (line) => {
    if (!line.startsWith("/")) {
      return [[], line];
    }

    const matches = COMMANDS.filter((command) => command.startsWith(line));
    return [matches.length > 0 ? matches : COMMANDS, line];
  };
}

function getToolResultDetails(result) {
  const safeResult = { ...result };
  delete safeResult.content;
  delete safeResult.entries;
  delete safeResult.matches;
  delete safeResult.answer;

  const keys = Object.keys(safeResult).filter((key) => {
    const value = safeResult[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });

  if (keys.length <= 2) {
    return "";
  }

  return renderToolDetails(`${result.tool}-result`, safeResult);
}

async function promptForAssistantQuestion(state, rl, prompt) {
  const question = String(prompt?.question ?? "").trim();
  const relatedTo = String(prompt?.relatedTo ?? "").trim() || "current task";
  const options = normalizeAskQuestionOptions(prompt?.options).slice(0, 6);

  if (options.length > 0 && input.isTTY) {
    const items = [
      ...options.map((option) => ({
        label: option,
        description: "Press Enter to select this option."
      })),
      {
        label: "Custom answer",
        description: "Write your own answer instead of using a preset option."
      }
    ];

    const selected = await chooseFromMenu("Assistant Question", items, state, {
      intro: renderAskQuestionPrompt(question, relatedTo, options)
    });

    if (!selected) {
      return "";
    }

    if (selected.label === "Custom answer") {
      console.log(renderAskQuestionPrompt(question, relatedTo, options));
      return rl.question(renderInfoLine("answer", "", "yellow"));
    }

      return selected.label;
  }

  console.log("");
  console.log(renderAskQuestionPrompt(question, relatedTo, options));
  return rl.question(renderInfoLine("answer", "", "yellow"));
}

function normalizeAskQuestionOptions(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
  }

  if (typeof value !== "string") {
    return [];
  }

  const text = value.trim();

  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean);
    }
  } catch {
    // Fall through to delimiter-based parsing.
  }

  if (text.includes("|")) {
    return text
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (text.includes(",")) {
    return text
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [text];
}
