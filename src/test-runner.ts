import { existsSync } from "fs";
import { join, basename } from "path";
import { execa } from "execa";
import type { TestCase, RunResult, TestType } from "./types.ts";
import { takeScreenshot } from "./simulator-manager.ts";
import { analyzeFailure } from "./agentic-tester.ts";
import { log } from "./utils/logger.ts";

/** Build an env that includes maestro and Java on PATH */
function getMaestroEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...process.env, ...extra };
  const home = env.HOME ?? process.env.HOME ?? "";
  const additions: string[] = [];

  // Maestro CLI
  const maestroBin = join(home, ".maestro", "bin");
  if (existsSync(maestroBin)) additions.push(maestroBin);

  // Java (Homebrew openjdk@17)
  const javaHome = env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17";
  if (existsSync(join(javaHome, "bin"))) {
    additions.push(join(javaHome, "bin"));
    env.JAVA_HOME = javaHome;
  }

  if (additions.length > 0) {
    env.PATH = [...additions, env.PATH].join(":");
  }
  return env;
}

export async function runTests(
  qaDir: string,
  repoPath: string,
  testCases: TestCase[],
  simulatorId: string,
  typeFilter?: TestType
): Promise<RunResult[]> {
  log.header("Running Tests");
  const results: RunResult[] = [];

  for (const tc of testCases) {
    const testType = typeFilter ?? tc.type;
    if (typeFilter && tc.type !== "auto" && tc.type !== typeFilter) continue;

    try {
      log.step(tc.id, `Running ${testType} test`);
      const result = await runSingleTest(qaDir, repoPath, tc, testType, simulatorId);

      // Agentic failure analysis — when any test fails, Claude screenshots
      // the simulator and explains exactly what went wrong
      if (result.status === "failed" && result.errorMessage) {
        log.step(tc.id, "Analyzing failure with Claude...");
        const screenshotDir = join(qaDir, "results", "runs", ".tmp-analysis");
        result.agenticAnalysis = await analyzeFailure(
          simulatorId, tc, result.errorMessage, result.errorDetails, screenshotDir
        );
        // Add analysis screenshot to the result's screenshots so saveRunResults copies it
        const analysisScreenshot = join(screenshotDir, `${tc.id.replace("/", "_")}_failure_analysis.png`);
        if (existsSync(analysisScreenshot)) {
          result.screenshots.push(analysisScreenshot);
        }
      }

      results.push(result);

      if (result.status === "passed") {
        log.success(`${tc.id}: PASSED (${result.duration}ms)`);
      } else {
        log.error(`${tc.id}: FAILED — ${result.errorMessage}`);
        if (result.agenticAnalysis) {
          log.info(`Analysis: ${result.agenticAnalysis.slice(0, 300)}`);
        }
      }
    } catch (err: any) {
      results.push({
        testCaseId: tc.id,
        testType: testType === "auto" ? "integration" : testType,
        status: "failed",
        duration: 0,
        errorMessage: err.message,
        screenshots: [],
        logs: [],
      });
    }
  }

  return results;
}

function resolveTestType(qaDir: string, tc: TestCase, requestedType: TestType): TestType {
  // If a specific type was requested (not auto), use it
  if (requestedType !== "auto") return requestedType;

  // For "auto", check which generated test file actually exists
  const baseName = tc.id.replace("/", "_");
  const integrationPath = join(qaDir, "tests", "integration", `${baseName}_test.dart`);
  const maestroPath = join(qaDir, "tests", "maestro", `${baseName}.yaml`);

  const hasIntegration = existsSync(integrationPath);
  const hasMaestro = existsSync(maestroPath);

  // Prefer whichever exists; if both exist, prefer integration
  if (hasIntegration) return "integration";
  if (hasMaestro) return "maestro";

  // Neither exists — fall back to integration so the error message is clear
  return "integration";
}

async function runSingleTest(
  qaDir: string,
  repoPath: string,
  tc: TestCase,
  testType: TestType,
  simulatorId: string
): Promise<RunResult> {
  const resolvedType = resolveTestType(qaDir, tc, testType);

  switch (resolvedType) {
    case "integration":
      return runIntegrationTest(qaDir, repoPath, tc, simulatorId);
    case "maestro":
      return runMaestroTest(qaDir, tc, simulatorId);
    case "agentic":
      // Agentic tests are handled by agentic-tester.ts, not here
      return {
        testCaseId: tc.id,
        testType: "agentic",
        status: "skipped",
        duration: 0,
        errorMessage: "Agentic tests must be run via the agentic tester",
        screenshots: [],
        logs: [],
      };
    default:
      throw new Error(`Unknown test type: ${resolvedType}`);
  }
}

async function runIntegrationTest(
  qaDir: string,
  repoPath: string,
  tc: TestCase,
  simulatorId: string
): Promise<RunResult> {
  const fileName = tc.id.replace("/", "_") + "_test.dart";
  const testFilePath = join(qaDir, "tests", "integration", fileName);

  if (!existsSync(testFilePath)) {
    return {
      testCaseId: tc.id,
      testType: "integration",
      status: "failed",
      duration: 0,
      errorMessage: `Test file not found: ${testFilePath}`,
      screenshots: [],
      logs: [],
    };
  }

  const start = Date.now();
  const screenshots: string[] = [];
  const logs: string[] = [];

  try {
    const { stdout, stderr } = await execa(
      "flutter",
      ["test", testFilePath, "-d", simulatorId],
      {
        cwd: repoPath,
        timeout: 120_000, // 2 minute timeout per test
      }
    );

    logs.push(stdout, stderr);

    return {
      testCaseId: tc.id,
      testType: "integration",
      status: "passed",
      duration: Date.now() - start,
      screenshots,
      logs,
    };
  } catch (err: any) {
    // Take failure screenshot
    try {
      const screenshotPath = join(
        qaDir,
        "results",
        "runs",
        `${tc.id.replace("/", "_")}_failure.png`
      );
      await takeScreenshot(simulatorId, screenshotPath);
      screenshots.push(screenshotPath);
    } catch {
      // Screenshot failed, continue
    }

    const errorOutput = err.stderr || err.stdout || err.message;
    logs.push(errorOutput);

    return {
      testCaseId: tc.id,
      testType: "integration",
      status: "failed",
      duration: Date.now() - start,
      errorMessage: extractErrorMessage(errorOutput),
      errorDetails: errorOutput,
      screenshots,
      logs,
    };
  }
}

async function runMaestroTest(
  qaDir: string,
  tc: TestCase,
  simulatorId: string
): Promise<RunResult> {
  const fileName = tc.id.replace("/", "_") + ".yaml";
  const flowPath = join(qaDir, "tests", "maestro", fileName);

  if (!existsSync(flowPath)) {
    return {
      testCaseId: tc.id,
      testType: "maestro",
      status: "failed",
      duration: 0,
      errorMessage: `Maestro flow not found: ${flowPath}`,
      screenshots: [],
      logs: [],
    };
  }

  const start = Date.now();
  const screenshots: string[] = [];
  const logs: string[] = [];

  try {
    const { stdout, stderr } = await execa("maestro", ["test", flowPath], {
      timeout: 180_000, // 3 minute timeout
      env: getMaestroEnv({ MAESTRO_DEVICE_ID: simulatorId }),
    });

    logs.push(stdout, stderr);

    return {
      testCaseId: tc.id,
      testType: "maestro",
      status: "passed",
      duration: Date.now() - start,
      screenshots,
      logs,
    };
  } catch (err: any) {
    const errorOutput = err.stderr || err.stdout || err.message;
    logs.push(errorOutput);

    return {
      testCaseId: tc.id,
      testType: "maestro",
      status: "failed",
      duration: Date.now() - start,
      errorMessage: extractErrorMessage(errorOutput),
      errorDetails: errorOutput,
      screenshots,
      logs,
    };
  }
}

function extractErrorMessage(output: string): string {
  // Try to find the most relevant error line
  const lines = output.split("\n");

  // Look for common error patterns
  const errorLine = lines.find(
    (l) =>
      l.includes("Error:") ||
      l.includes("FAILED") ||
      l.includes("Exception") ||
      l.includes("assertion")
  );

  if (errorLine) return errorLine.trim().slice(0, 200);
  return output.slice(0, 200);
}
