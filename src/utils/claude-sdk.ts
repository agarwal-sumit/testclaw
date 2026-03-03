import {
  query,
  tool,
  createSdkMcpServer,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./logger.ts";

// When running as a compiled binary, the bundled cli.js can't be spawned as
// a subprocess because it's embedded in the binary's virtual filesystem.
// Detect this and fall back to the system-installed `claude` CLI.
function getClaudeExecutablePath(): string | undefined {
  // Explicit override
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  if (process.env.QA_USE_SYSTEM_CLAUDE === "1") return "claude";

  // Auto-detect: in a bun-compiled binary, process.execPath won't point to
  // a bun/node/deno runtime — it points to the binary itself.
  const execPath = (process.execPath || "").toLowerCase();
  const isRuntime = execPath.includes("bun") || execPath.includes("node") || execPath.includes("deno");
  if (!isRuntime) {
    log.debug("Compiled binary detected — using system 'claude' CLI");
    return "claude";
  }

  return undefined;
}

export interface ClaudeQueryOptions {
  prompt: string;
  tools?: string[];
  cwd: string;
  systemPrompt?: string;
  maxTurns?: number;
  mcpServers?: Record<string, any>;
  abortController?: AbortController;
}

export interface ClaudeResult {
  result: string;
  sessionId: string;
  cost: number;
  duration: number;
}

// Build a clean env that strips the CLAUDECODE marker so the SDK subprocess
// doesn't think it's nested inside another Claude Code session.
function getCleanEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

function buildQueryOptions(opts: ClaudeQueryOptions) {
  return {
    allowedTools: opts.tools,
    cwd: opts.cwd,
    systemPrompt: opts.systemPrompt,
    maxTurns: opts.maxTurns ?? 15,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable: getClaudeExecutablePath(),
    env: getCleanEnv(),
    mcpServers: opts.mcpServers,
    abortController: opts.abortController,
    stderr: (data: string) => {
      log.debug(`[claude stderr] ${data.trim()}`);
    },
  };
}

export async function claudeQuery(opts: ClaudeQueryOptions): Promise<ClaudeResult> {
  log.debug(`Claude query (maxTurns=${opts.maxTurns ?? 15}): ${opts.prompt.slice(0, 100)}...`);

  let result = "";
  let sessionId = "";
  let cost = 0;
  let duration = 0;

  try {
    for await (const message of query({
      prompt: opts.prompt,
      options: buildQueryOptions(opts),
    })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        log.debug(`Claude session started: ${sessionId}`);
      }
      if (message.type === "assistant" && message.error) {
        log.error(`Claude API error: ${message.error}`);
      }
      if (message.type === "result") {
        const resultMsg = message as SDKResultMessage;
        if (resultMsg.subtype === "success") {
          result = resultMsg.result;
        } else {
          const errors = (resultMsg as any).errors?.join("\n") ?? "Unknown error";
          log.error(`Claude query finished with error: ${resultMsg.subtype} — ${errors}`);
          result = errors;
        }
        cost = resultMsg.total_cost_usd;
        duration = resultMsg.duration_ms;
      }
    }
  } catch (err: any) {
    log.error(`Claude query threw: ${err.message}`);
    throw new Error(`Claude SDK error: ${err.message}`);
  }

  log.debug(`Claude query complete: ${duration}ms, $${cost.toFixed(4)}`);
  return { result, sessionId, cost, duration };
}

export async function claudeStream(
  opts: ClaudeQueryOptions,
  onMessage?: (msg: SDKMessage) => void
): Promise<ClaudeResult> {
  let result = "";
  let sessionId = "";
  let cost = 0;
  let duration = 0;

  try {
    for await (const message of query({
      prompt: opts.prompt,
      options: buildQueryOptions(opts),
    })) {
      onMessage?.(message);

      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      }
      if (message.type === "assistant" && message.error) {
        log.error(`Claude API error: ${message.error}`);
      }
      if (message.type === "result") {
        const resultMsg = message as SDKResultMessage;
        if (resultMsg.subtype === "success") {
          result = resultMsg.result;
        } else {
          const errors = (resultMsg as any).errors?.join("\n") ?? "Unknown error";
          result = errors;
        }
        cost = resultMsg.total_cost_usd;
        duration = resultMsg.duration_ms;
      }
    }
  } catch (err: any) {
    log.error(`Claude stream threw: ${err.message}`);
    throw new Error(`Claude SDK error: ${err.message}`);
  }

  return { result, sessionId, cost, duration };
}

export { tool, createSdkMcpServer, z };
