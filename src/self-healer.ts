import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  RunResult,
  HealingResult,
  FailureClassification,
  HealLogEntry,
  TestCase,
  AppAnalysis,
} from "./types.ts";
import { claudeQuery } from "./utils/claude-sdk.ts";
import { gitDiff, getChangedFiles, getLastCommitHash } from "./utils/git.ts";
import { log } from "./utils/logger.ts";

export async function healFailures(
  qaDir: string,
  repoPath: string,
  failures: RunResult[],
  testCases: TestCase[],
  analysis: AppAnalysis | null,
  confidenceThreshold: number = 0.8,
  dryRun: boolean = false
): Promise<HealingResult[]> {
  log.header("Self-Healing Tests");
  const results: HealingResult[] = [];

  for (const failure of failures) {
    if (failure.status !== "failed") continue;

    log.step(failure.testCaseId, "Analyzing failure...");

    // Step 1: Gather context
    const context = await gatherHealingContext(qaDir, repoPath, failure);

    // Step 2: Classify the failure
    const classification = await classifyFailure(
      qaDir,
      repoPath,
      failure,
      context
    );

    log.info(
      `Classification: ${classification.classification} (confidence: ${classification.confidence})`
    );

    // Step 3: Heal if appropriate
    if (
      classification.classification === "implementation_change" &&
      classification.confidence >= confidenceThreshold &&
      !dryRun
    ) {
      const healResult = await repairTest(
        qaDir,
        repoPath,
        failure,
        classification,
        context
      );
      results.push(healResult);
    } else {
      results.push(classification);
    }
  }

  // Log healing results
  await logHealingResults(qaDir, results);

  return results;
}

interface HealingContext {
  fingerprints: Record<string, any>;
  gitChanges: string;
  changedFiles: string[];
  testCase: TestCase | null;
  testFileContent: string | null;
}

async function gatherHealingContext(
  qaDir: string,
  repoPath: string,
  failure: RunResult
): Promise<HealingContext> {
  // Load fingerprints
  let fingerprints: Record<string, any> = {};
  const fpPath = join(qaDir, "fingerprints", "elements.json");
  if (existsSync(fpPath)) {
    try {
      fingerprints = JSON.parse(readFileSync(fpPath, "utf-8"));
    } catch {
      // ignore
    }
  }

  // Get git diff
  let gitChanges = "";
  let changedFiles: string[] = [];
  try {
    gitChanges = await gitDiff(repoPath);
    const lastCommit = await getLastCommitHash(repoPath);
    changedFiles = await getChangedFiles(repoPath, `${lastCommit}~5`);
  } catch {
    // Not a git repo or no commits
  }

  // Load test case
  let testCase: TestCase | null = null;
  const tcPath = join(
    qaDir,
    "testcases",
    ...failure.testCaseId.split("/")
  );
  const tcFile = tcPath + ".yaml";
  if (existsSync(tcFile)) {
    try {
      const YAML = require("yaml");
      testCase = YAML.parse(readFileSync(tcFile, "utf-8"));
    } catch {
      // ignore
    }
  }

  // Load test file content
  let testFileContent: string | null = null;
  const testFileName = failure.testCaseId.replace("/", "_");
  const integrationPath = join(qaDir, "tests", "integration", `${testFileName}_test.dart`);
  const maestroPath = join(qaDir, "tests", "maestro", `${testFileName}.yaml`);

  if (existsSync(integrationPath)) {
    testFileContent = readFileSync(integrationPath, "utf-8");
  } else if (existsSync(maestroPath)) {
    testFileContent = readFileSync(maestroPath, "utf-8");
  }

  return { fingerprints, gitChanges, changedFiles, testCase, testFileContent };
}

async function classifyFailure(
  qaDir: string,
  repoPath: string,
  failure: RunResult,
  context: HealingContext
): Promise<HealingResult> {
  const systemPrompt = `You are a test failure analyst. Classify test failures into one of three categories:

1. "real_bug" — The app has a genuine bug. The test correctly found it.
2. "implementation_change" — The app's UI or behavior changed intentionally, breaking the test. The test needs updating.
3. "flaky" — The test is unreliable (timing issues, race conditions, etc.)

Respond with ONLY valid JSON:
{
  "classification": "real_bug" | "implementation_change" | "flaky",
  "confidence": 0.0-1.0,
  "description": "Brief explanation"
}`;

  const prompt = `Classify this test failure:

Test Case ID: ${failure.testCaseId}
Error: ${failure.errorMessage ?? "Unknown"}
Error Details: ${(failure.errorDetails ?? "").slice(0, 2000)}

Test file content:
${(context.testFileContent ?? "Not available").slice(0, 3000)}

Recent git changes in the repo:
${context.gitChanges.slice(0, 2000)}

Changed files: ${context.changedFiles.join(", ")}

Element fingerprints: ${JSON.stringify(context.fingerprints).slice(0, 1000)}

Analyze the source code if needed to determine root cause.`;

  const { result } = await claudeQuery({
    prompt,
    tools: ["Read", "Grep", "Glob"],
    cwd: repoPath,
    systemPrompt,
    maxTurns: 10,
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        testCaseId: failure.testCaseId,
        classification: parsed.classification as FailureClassification,
        confidence: parsed.confidence ?? 0.5,
        description: parsed.description ?? "No description",
      };
    }
  } catch {
    // Parse failed
  }

  return {
    testCaseId: failure.testCaseId,
    classification: "real_bug",
    confidence: 0.3,
    description: "Could not classify failure automatically",
  };
}

async function repairTest(
  qaDir: string,
  repoPath: string,
  failure: RunResult,
  classification: HealingResult,
  context: HealingContext
): Promise<HealingResult> {
  log.step(failure.testCaseId, "Attempting auto-repair...");

  const testFileName = failure.testCaseId.replace("/", "_");
  const integrationPath = join(qaDir, "tests", "integration", `${testFileName}_test.dart`);
  const maestroPath = join(qaDir, "tests", "maestro", `${testFileName}.yaml`);

  let testFilePath = "";
  if (existsSync(integrationPath)) testFilePath = integrationPath;
  else if (existsSync(maestroPath)) testFilePath = maestroPath;

  if (!testFilePath) {
    return {
      ...classification,
      changesApplied: [],
      rerunPassed: false,
    };
  }

  const systemPrompt = `You are a test repair specialist. Your job is to fix broken tests by updating selectors, assertions, and test flow to match the current state of the app.

Guidelines:
- Only change what's necessary to fix the test
- Preserve the test's intent and coverage
- Update element selectors/finders if the app's UI changed
- Update expected values if the app's behavior changed intentionally
- Add waits/delays if the issue is timing-related

Use the Edit tool to make precise changes to the test file.`;

  const prompt = `Repair this broken test file:

File: ${testFilePath}
Error: ${failure.errorMessage}
Error Details: ${(failure.errorDetails ?? "").slice(0, 2000)}

Classification: ${classification.classification}
Description: ${classification.description}

Current test file content has been provided. Read the app source code to understand the current state, then use Edit to fix the test.`;

  try {
    const { result } = await claudeQuery({
      prompt,
      tools: ["Read", "Write", "Edit", "Glob", "Grep"],
      cwd: repoPath,
      systemPrompt,
      maxTurns: 20,
    });

    log.success(`Repair applied to ${testFilePath}`);

    return {
      ...classification,
      changesApplied: [testFilePath],
      rerunPassed: undefined, // Caller should re-run to verify
    };
  } catch (err: any) {
    log.error(`Repair failed: ${err.message}`);
    return {
      ...classification,
      changesApplied: [],
      rerunPassed: false,
    };
  }
}

async function logHealingResults(
  qaDir: string,
  results: HealingResult[]
): Promise<void> {
  const logPath = join(qaDir, "history", "heal-log.json");
  let existingLog: HealLogEntry[] = [];

  if (existsSync(logPath)) {
    try {
      existingLog = JSON.parse(readFileSync(logPath, "utf-8"));
    } catch {
      existingLog = [];
    }
  }

  const newEntries: HealLogEntry[] = results.map((r) => ({
    timestamp: new Date().toISOString(),
    testCaseId: r.testCaseId,
    classification: r.classification,
    confidence: r.confidence,
    healedSuccessfully: r.rerunPassed ?? false,
    changes: r.changesApplied ?? [],
  }));

  existingLog.push(...newEntries);
  writeFileSync(logPath, JSON.stringify(existingLog, null, 2), "utf-8");
}
