import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "fs";
import { join } from "path";
import type { RunResult, RunSummary } from "./types.ts";
import { gitCommit } from "./utils/git.ts";
import { log } from "./utils/logger.ts";

export function saveRunResults(
  qaDir: string,
  results: RunResult[],
  autoCommit: boolean = true,
  repoPath?: string
): RunSummary {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(qaDir, "results", "runs", timestamp);
  mkdirSync(runDir, { recursive: true });

  const summary: RunSummary = {
    timestamp: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    healed: results.filter((r) => r.status === "healed").length,
    duration: results.reduce((sum, r) => sum + r.duration, 0),
    results,
  };

  // Save summary
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );

  // Copy screenshots into run directory
  for (const result of results) {
    for (const screenshot of result.screenshots) {
      if (existsSync(screenshot)) {
        const dest = join(runDir, screenshot.split("/").pop()!);
        try {
          copyFileSync(screenshot, dest);
        } catch {
          // ignore copy errors
        }
      }
    }
  }

  // Save individual logs
  for (const result of results) {
    if (result.logs.length > 0) {
      const logFile = join(runDir, `${result.testCaseId.replace("/", "_")}.log`);
      writeFileSync(logFile, result.logs.join("\n"), "utf-8");
    }
  }

  log.success(
    `Results saved: ${summary.passed}/${summary.total} passed, ${summary.failed} failed`
  );

  // Auto-commit if enabled
  if (autoCommit && repoPath) {
    gitCommit(
      repoPath,
      `testclaw: run results — ${summary.passed} passed, ${summary.failed} failed`
    ).catch((err) => {
      log.debug(`Auto-commit failed: ${err.message}`);
    });
  }

  return summary;
}

export function getLastRunSummary(qaDir: string): RunSummary | null {
  const runsDir = join(qaDir, "results", "runs");
  if (!existsSync(runsDir)) return null;

  const { readdirSync, statSync } = require("fs");
  const runs = (readdirSync(runsDir) as string[])
    .filter((d: string) => {
      if (d.startsWith(".")) return false;
      // Only consider actual directories that contain a summary.json
      try {
        return statSync(join(runsDir, d)).isDirectory() &&
          existsSync(join(runsDir, d, "summary.json"));
      } catch { return false; }
    })
    .sort()
    .reverse();

  if (runs.length === 0) return null;

  const summaryPath = join(runsDir, runs[0], "summary.json");
  if (!existsSync(summaryPath)) return null;

  try {
    return JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;
  } catch {
    return null;
  }
}

export function saveBaseline(
  qaDir: string,
  testCaseId: string,
  screenshotPath: string
): void {
  const baselinesDir = join(qaDir, "results", "baselines");
  if (!existsSync(baselinesDir)) {
    mkdirSync(baselinesDir, { recursive: true });
  }

  const dest = join(baselinesDir, `${testCaseId.replace("/", "_")}.png`);
  copyFileSync(screenshotPath, dest);
  log.debug(`Baseline saved: ${dest}`);
}

export function getBaseline(qaDir: string, testCaseId: string): string | null {
  const path = join(
    qaDir,
    "results",
    "baselines",
    `${testCaseId.replace("/", "_")}.png`
  );
  return existsSync(path) ? path : null;
}

export function formatRunSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`Run: ${summary.timestamp}`);
  lines.push(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Skipped: ${summary.skipped} | Healed: ${summary.healed}`);
  lines.push(`Duration: ${(summary.duration / 1000).toFixed(1)}s`);
  lines.push("");

  for (const result of summary.results) {
    const icon =
      result.status === "passed"
        ? "✓"
        : result.status === "failed"
        ? "✗"
        : result.status === "healed"
        ? "⚕"
        : "○";
    let line = `  ${icon} ${result.testCaseId} (${result.testType}) — ${result.duration}ms`;
    if (result.errorMessage) {
      line += `\n    Error: ${result.errorMessage}`;
    }
    if (result.agenticAnalysis) {
      // Show a concise version of the analysis (first 300 chars)
      const shortAnalysis = result.agenticAnalysis.replace(/\n/g, " ").slice(0, 300);
      line += `\n    Analysis: ${shortAnalysis}`;
    }
    lines.push(line);
  }

  return lines.join("\n");
}
