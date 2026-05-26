#!/usr/bin/env node
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { AuthStore } from "./runtime/auth-store.js";
import { PiSquaredAgentRuntime, DEFAULT_SYSTEM_PROMPT } from "./runtime/pi-agent.js";
import { normalizeThinkingLevel, resolveModel } from "./runtime/model-resolver.js";
import { runInteractive } from "./tui/interactive.js";

const VERSION = "0.1.0";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

interface CliOptions {
  systemPrompt?: string;
  thinking: ThinkingLevel;
  help: boolean;
  version: boolean;
  initialMessage?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.version) {
    console.log(VERSION);
    return;
  }

  const authStore = new AuthStore();
  await authStore.load();

  const resolved = resolveModel({ authStore });
  const thinkingLevel = normalizeThinkingLevel(resolved.model, options.thinking);
  const runtimeOptions: ConstructorParameters<typeof PiSquaredAgentRuntime>[0] = {
    model: resolved.model,
    thinkingLevel,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    authStore,
  };

  const runtime = new PiSquaredAgentRuntime(runtimeOptions);
  const interactiveOptions: Parameters<typeof runInteractive>[0] = { runtime };
  if (options.initialMessage) interactiveOptions.initialMessage = options.initialMessage;

  await runInteractive(interactiveOptions);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    thinking: "off",
    help: false,
    version: false,
  };
  const messageParts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--") {
      messageParts.push(...argv.slice(i + 1));
      break;
    }

    if (!arg.startsWith("-")) {
      messageParts.push(arg);
      continue;
    }

    const [flag, inlineValue] = splitFlag(arg);
    switch (flag) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--system-prompt":
        options.systemPrompt = inlineValue ?? takeValue(argv, ++i, flag);
        break;
      case "--thinking":
        options.thinking = parseThinkingLevel(inlineValue ?? takeValue(argv, ++i, flag));
        break;
      default:
        throw new Error(`Unknown option '${flag}'. Run 'pi2 --help' for usage.`);
    }
  }

  const initialMessage = messageParts.join(" ").trim();
  if (initialMessage.length > 0) options.initialMessage = initialMessage;
  return options;
}

function splitFlag(arg: string): [string, string | undefined] {
  const equals = arg.indexOf("=");
  if (equals === -1) return [arg, undefined];
  return [arg.slice(0, equals), arg.slice(equals + 1)];
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseThinkingLevel(value: string): ThinkingLevel {
  if ((THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level '${value}'. Expected one of: ${THINKING_LEVELS.join(", ")}`);
}

function printHelp(): void {
  console.log(`pi2 ${VERSION}

Usage:
  pi2 [options] [initial message]

Options:
      --thinking <level>           off|minimal|low|medium|high|xhigh (default: off)
      --system-prompt <text>       Override the default system prompt.
  -h, --help                       Show this help.
  -v, --version                    Show version.

The provider and model are selected automatically from available credentials:
  - OAuth credentials stored in ~/.pi-squared/auth.json (override: PI_SQUARED_AUTH_FILE)
  - Environment API keys, e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY

Inside the TUI, type / to open the command menu. Useful commands:
  /model, /thinking, /login, /logout, /help, /quit
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
