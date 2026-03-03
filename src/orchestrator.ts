import { existsSync } from "fs";
import { resolve } from "path";
import type {
  SessionContext,
  TestCase,
  RunResult,
  RunSummary,
  HealingResult,
  TestType,
  BuildOptions,
  QAConfig,
} from "./types.ts";
import { loadConfig, getQADir } from "./config.ts";
import {
  cloneRepo,
  detectFramework,
  scaffoldQADir,
  validateRepoPath,
} from "./repo-manager.ts";
import { analyzeCodebase, loadCachedAnalysis } from "./code-analyzer.ts";
import { buildApp, getBundleId } from "./build-manager.ts";
import { findBestDevice, bootDevice } from "./simulator-manager.ts";
import {
  listTestCases,
  saveTestCase,
  generateTestCaseFromDescription,
  generateTestCasesFromSuggestions,
} from "./testcase-manager.ts";
import { generateTests } from "./test-generator.ts";
import { runTests } from "./test-runner.ts";
import { runAgenticTest } from "./agentic-tester.ts";
import { healFailures } from "./self-healer.ts";
import {
  saveRunResults,
  getLastRunSummary,
  formatRunSummary,
} from "./results-store.ts";
import { log } from "./utils/logger.ts";

export class Orchestrator {
  private ctx: SessionContext | null = null;
  private config: QAConfig | null = null;

  async init(repoUrl: string, destDir?: string): Promise<SessionContext> {
    log.header("Initializing QA");

    // Clone repo
    const repoPath = await cloneRepo(repoUrl, destDir ?? process.cwd());
    return this.initLocal(repoPath);
  }

  async initLocal(repoPath: string): Promise<SessionContext> {
    log.header("Initializing QA (local)");

    const resolvedPath = validateRepoPath(repoPath);

    // Detect framework
    const framework = detectFramework(resolvedPath);

    // Scaffold .qa/ directory
    const qaDir = scaffoldQADir(resolvedPath, framework);

    // Load config
    this.config = loadConfig(qaDir);

    // Analyze codebase
    const analysis = await analyzeCodebase(resolvedPath, qaDir, framework);

    // Create session context
    this.ctx = {
      repoPath: resolvedPath,
      qaDir,
      framework,
      analysis,
      testCases: [],
    };

    // Print suggestions for the user
    if (analysis.suggestedTestCases.length > 0) {
      log.info(`Found ${analysis.suggestedTestCases.length} suggested test cases.`);
      log.info(`Run 'testclaw suggest' to auto-generate structured test cases from them.`);
    }

    log.success("QA initialized successfully");
    return this.ctx;
  }

  async suggest(): Promise<number> {
    const ctx = this.requireContext();
    const analysis = ctx.analysis ?? loadCachedAnalysis(ctx.qaDir);
    if (!analysis) {
      throw new Error("No analysis available. Run 'testclaw analyze' first.");
    }
    if (analysis.suggestedTestCases.length === 0) {
      log.info("No suggestions found in analysis. Run 'testclaw analyze' to refresh.");
      return 0;
    }

    const testCases = await generateTestCasesFromSuggestions(
      analysis.suggestedTestCases,
      ctx.repoPath,
      analysis
    );

    for (const tc of testCases) {
      saveTestCase(ctx.qaDir, tc);
    }

    ctx.testCases = [...ctx.testCases, ...testCases];
    return testCases.length;
  }

  async addTestAI(description: string): Promise<void> {
    const ctx = this.requireContext();
    const analysis = ctx.analysis ?? loadCachedAnalysis(ctx.qaDir);

    const tc = await generateTestCaseFromDescription(
      description,
      ctx.repoPath,
      analysis
    );

    saveTestCase(ctx.qaDir, tc);
    ctx.testCases.push(tc);
  }

  async analyze(): Promise<void> {
    const ctx = this.requireContext();
    ctx.analysis = await analyzeCodebase(ctx.repoPath, ctx.qaDir, ctx.framework);
  }

  async generate(suite?: string): Promise<void> {
    const ctx = this.requireContext();
    const analysis = ctx.analysis ?? loadCachedAnalysis(ctx.qaDir);
    if (!analysis) {
      throw new Error("No analysis available. Run 'testclaw analyze' first.");
    }

    const testCases = listTestCases(ctx.qaDir, suite);
    if (testCases.length === 0) {
      throw new Error(
        "No test cases found. Run 'testclaw add-test' to create test cases."
      );
    }

    await generateTests(ctx.qaDir, ctx.repoPath, testCases, analysis);
  }

  async build(deviceId?: string, cliBuildOpts: BuildOptions = {}): Promise<void> {
    const ctx = this.requireContext();

    // Find/boot simulator
    if (!ctx.simulatorId) {
      const device = deviceId
        ? { udid: deviceId, name: deviceId, state: "Shutdown", runtime: "" }
        : await findBestDevice();
      await bootDevice(device.udid);
      ctx.simulatorId = device.udid;
    }

    // Merge config build options with CLI overrides (CLI wins)
    const configBuild = this.config?.build ?? {};
    const mergedBuild: BuildOptions = {
      ...configBuild,
      ...cliBuildOpts,
      // Deep-merge dart-define: config values as defaults, CLI overrides on top
      dartDefine: { ...configBuild.dartDefine, ...cliBuildOpts.dartDefine },
      // Concatenate extra args from both sources
      extraArgs: [...(configBuild.extraArgs ?? []), ...(cliBuildOpts.extraArgs ?? [])],
    };

    // Build, install, and launch via flutter run
    const buildResult = await buildApp(ctx.repoPath, ctx.framework, mergedBuild, ctx.simulatorId);
    if (!buildResult.success) {
      throw new Error(`Build failed:\n${buildResult.errors.join("\n")}`);
    }
  }

  async run(suite?: string, type?: TestType): Promise<RunSummary> {
    const ctx = this.requireContext();

    if (!ctx.simulatorId) {
      const device = await findBestDevice();
      await bootDevice(device.udid);
      ctx.simulatorId = device.udid;
    }

    const testCases = listTestCases(ctx.qaDir, suite);
    if (testCases.length === 0) {
      throw new Error("No test cases found.");
    }

    const results: RunResult[] = [];

    // Run non-agentic tests
    const nonAgentic = testCases.filter(
      (tc) => tc.type !== "agentic" && type !== "agentic"
    );
    if (nonAgentic.length > 0) {
      const standardResults = await runTests(
        ctx.qaDir,
        ctx.repoPath,
        nonAgentic,
        ctx.simulatorId,
        type
      );
      results.push(...standardResults);
    }

    // Run agentic tests
    const agenticCases = testCases.filter(
      (tc) => tc.type === "agentic" || type === "agentic"
    );
    if (agenticCases.length > 0) {
      const bundleId = getBundleId(ctx.repoPath) ?? "com.example.app";
      const maxTurns = this.config?.maxAgenticTurns ?? 50;

      for (const tc of agenticCases) {
        const result = await runAgenticTest(
          ctx.qaDir,
          ctx.repoPath,
          tc,
          ctx.simulatorId,
          bundleId,
          maxTurns
        );
        results.push(result);
      }
    }

    // Save results
    const summary = saveRunResults(
      ctx.qaDir,
      results,
      this.config?.autoCommitResults,
      ctx.repoPath
    );
    ctx.lastRun = summary;

    console.log("\n" + formatRunSummary(summary));
    return summary;
  }

  async heal(dryRun: boolean = false): Promise<HealingResult[]> {
    const ctx = this.requireContext();
    const lastRun = ctx.lastRun ?? getLastRunSummary(ctx.qaDir);
    if (!lastRun) {
      throw new Error("No test run results found. Run tests first.");
    }

    const failures = lastRun.results.filter((r) => r.status === "failed");
    if (failures.length === 0) {
      log.success("No failures to heal!");
      return [];
    }

    const testCases = listTestCases(ctx.qaDir);
    const analysis = ctx.analysis ?? loadCachedAnalysis(ctx.qaDir);
    const threshold = this.config?.healingConfidenceThreshold ?? 0.8;

    return healFailures(
      ctx.qaDir,
      ctx.repoPath,
      failures,
      testCases,
      analysis,
      threshold,
      dryRun
    );
  }

  status(): void {
    const ctx = this.requireContext();
    const testCases = listTestCases(ctx.qaDir);
    const lastRun = ctx.lastRun ?? getLastRunSummary(ctx.qaDir);

    log.header("QA Status");
    console.log(`  Repo: ${ctx.repoPath}`);
    console.log(`  Framework: ${ctx.framework}`);
    console.log(`  Simulator: ${ctx.simulatorId ?? "Not set"}`);
    console.log(`  Test cases: ${testCases.length}`);

    if (lastRun) {
      console.log("\n  Last Run:");
      console.log("  " + formatRunSummary(lastRun).replace(/\n/g, "\n  "));
    } else {
      console.log("\n  No test runs yet.");
    }
  }

  // ── Context Management ──

  loadFromPath(repoPath: string): void {
    const resolved = resolve(repoPath);
    const qaDir = getQADir(resolved);
    if (!existsSync(qaDir)) {
      throw new Error(
        `No .qa/ directory found at ${resolved}. Run 'testclaw init' first.`
      );
    }

    this.config = loadConfig(qaDir);
    const framework = this.config.framework;
    const analysis = loadCachedAnalysis(qaDir);

    this.ctx = {
      repoPath: resolved,
      qaDir,
      framework,
      analysis: analysis ?? undefined,
      testCases: listTestCases(qaDir),
    };
  }

  private requireContext(): SessionContext {
    if (!this.ctx) {
      // Try to load from current directory
      try {
        this.loadFromPath(process.cwd());
      } catch {
        throw new Error("No TestClaw context. Run 'testclaw init' first or cd to a TestClaw-enabled repo.");
      }
    }
    return this.ctx!;
  }
}
