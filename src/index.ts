#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { Orchestrator } from "./orchestrator.ts";
import { saveTestCase, createTestCaseFromSuggestion } from "./testcase-manager.ts";
import { setLogLevel } from "./utils/logger.ts";
import type { TestType, TestStep, BuildOptions } from "./types.ts";

const program = new Command();
const orchestrator = new Orchestrator();

program
  .name("testclaw")
  .description("AI-powered mobile app testing CLI")
  .version("0.1.0")
  .option("--verbose", "Enable debug logging")
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().verbose) {
      setLogLevel("debug");
    }
  });

// ── testclaw init ──
program
  .command("init")
  .description("Initialize QA for a mobile app repo")
  .argument("[repo-url]", "Git URL to clone")
  .option("--local <path>", "Use an existing local repo")
  .option("--dest <dir>", "Destination directory for clone")
  .action(async (repoUrl, opts) => {
    const spinner = ora("Initializing QA...").start();
    try {
      if (opts.local) {
        await orchestrator.initLocal(opts.local);
      } else if (repoUrl) {
        await orchestrator.init(repoUrl, opts.dest);
      } else {
        // Use current directory
        await orchestrator.initLocal(process.cwd());
      }
      spinner.succeed("QA initialized successfully");
    } catch (err: any) {
      spinner.fail(`Initialization failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw analyze ──
program
  .command("analyze")
  .description("Re-analyze codebase with Claude")
  .action(async () => {
    const spinner = ora("Analyzing codebase...").start();
    try {
      orchestrator.loadFromPath(process.cwd());
      await orchestrator.analyze();
      spinner.succeed("Analysis complete");
    } catch (err: any) {
      spinner.fail(`Analysis failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw suggest ──
program
  .command("suggest")
  .description(
    "Generate structured test cases from the suggestions found during analysis"
  )
  .action(async () => {
    const spinner = ora("Generating test cases from suggestions...").start();
    try {
      orchestrator.loadFromPath(process.cwd());
      spinner.stop();
      const count = await orchestrator.suggest();
      if (count > 0) {
        console.log(chalk.green(`\n✓ Created ${count} test cases`));
      } else {
        console.log(chalk.yellow("No suggestions found. Run 'testclaw analyze' first."));
      }
    } catch (err: any) {
      spinner.fail(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw add-test ──
program
  .command("add-test")
  .description("Create a new test case")
  .requiredOption("--suite <name>", "Test suite name")
  .requiredOption("--name <name>", "Test case name (used as ID)")
  .requiredOption("--description <desc>", "What the test verifies")
  .option("--priority <level>", "Priority: critical|high|medium|low", "medium")
  .option("--type <type>", "Test type: integration|maestro|agentic|auto", "auto")
  .option(
    "--steps <json>",
    'Test steps as JSON array, e.g. \'[{"action":"tap","target":"Login button","description":"Tap login"}]\''
  )
  .action(async (opts) => {
    try {
      orchestrator.loadFromPath(process.cwd());

      let steps: TestStep[] = [];
      if (opts.steps) {
        steps = JSON.parse(opts.steps);
      }

      const tc = createTestCaseFromSuggestion(
        opts.suite,
        opts.name,
        opts.description,
        steps
      );
      tc.priority = opts.priority;
      tc.type = opts.type;

      const qaDir = process.cwd() + "/.qa";
      saveTestCase(qaDir, tc);
      console.log(chalk.green(`✓ Test case created: ${tc.id}`));
    } catch (err: any) {
      console.error(chalk.red(`Failed: ${err.message}`));
      process.exit(1);
    }
  });

// ── testclaw add-test-ai ──
program
  .command("add-test-ai")
  .description(
    "Create a test case from a plain-English description (Claude generates the steps)"
  )
  .argument("<description>", "What to test, in plain English")
  .action(async (description) => {
    const spinner = ora("Generating test case...").start();
    try {
      orchestrator.loadFromPath(process.cwd());
      spinner.stop();
      await orchestrator.addTestAI(description);
      console.log(chalk.green("✓ Test case created"));
    } catch (err: any) {
      spinner.fail(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw generate ──
program
  .command("generate")
  .description("Generate automated tests from English test cases")
  .option("--suite <name>", "Only generate for a specific suite")
  .action(async (opts) => {
    const spinner = ora("Generating tests...").start();
    try {
      orchestrator.loadFromPath(process.cwd());
      await orchestrator.generate(opts.suite);
      spinner.succeed("Test generation complete");
    } catch (err: any) {
      spinner.fail(`Generation failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw build ──
program
  .command("build")
  .description("Build app and install on simulator")
  .option("--device <id>", "Simulator device ID")
  .option("--flavor <name>", "Build flavor (e.g. dev, staging, prod)")
  .option("--release", "Build in release mode instead of debug")
  .option("--target <path>", "Main entry point file (e.g. lib/main_dev.dart)")
  .option(
    "--dart-define <key=value>",
    "Pass a --dart-define flag (repeatable)",
    (val: string, acc: string[]) => [...acc, val],
    [] as string[]
  )
  .option(
    "--extra-args <args>",
    "Additional flags passed to flutter build, comma-separated"
  )
  .action(async (opts) => {
    const spinner = ora("Building app...").start();
    try {
      orchestrator.loadFromPath(process.cwd());

      // Parse CLI build options
      const buildOpts: BuildOptions = {};
      if (opts.flavor) buildOpts.flavor = opts.flavor;
      if (opts.release) buildOpts.release = true;
      if (opts.target) buildOpts.target = opts.target;
      if (opts.dartDefine?.length) {
        buildOpts.dartDefine = {};
        for (const entry of opts.dartDefine as string[]) {
          const [key, ...rest] = entry.split("=");
          buildOpts.dartDefine[key] = rest.join("=");
        }
      }
      if (opts.extraArgs) {
        buildOpts.extraArgs = (opts.extraArgs as string).split(",").map((s: string) => s.trim());
      }

      spinner.stop();
      await orchestrator.build(opts.device, buildOpts);
      console.log(chalk.green("✓ Build complete"));
    } catch (err: any) {
      spinner.fail(`Build failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw run ──
program
  .command("run")
  .description("Run tests")
  .option("--suite <name>", "Run only a specific suite")
  .option(
    "--type <type>",
    "Run only a specific test type: integration|maestro|agentic|all"
  )
  .action(async (opts) => {
    const spinner = ora("Running tests...").start();
    try {
      orchestrator.loadFromPath(process.cwd());
      const type = opts.type === "all" ? undefined : (opts.type as TestType);
      spinner.stop();
      const summary = await orchestrator.run(opts.suite, type);

      if (summary.failed > 0) {
        console.log(
          chalk.yellow(
            `\n${summary.failed} test(s) failed. Run 'testclaw heal' to attempt auto-repair.`
          )
        );
      }
    } catch (err: any) {
      spinner.fail(`Test run failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw heal ──
program
  .command("heal")
  .description("Self-heal broken tests")
  .option("--dry-run", "Classify failures without applying fixes")
  .action(async (opts) => {
    const spinner = ora("Analyzing failures...").start();
    try {
      orchestrator.loadFromPath(process.cwd());
      spinner.stop();
      const results = await orchestrator.heal(opts.dryRun);

      console.log(chalk.bold("\nHealing Results:"));
      for (const r of results) {
        const icon =
          r.classification === "real_bug"
            ? chalk.red("🐛")
            : r.classification === "implementation_change"
            ? chalk.yellow("🔄")
            : chalk.gray("⚡");
        console.log(
          `  ${icon} ${r.testCaseId}: ${r.classification} (${(r.confidence * 100).toFixed(0)}%) — ${r.description}`
        );
        if (r.changesApplied?.length) {
          console.log(
            chalk.green(`    Applied changes: ${r.changesApplied.join(", ")}`)
          );
        }
      }
    } catch (err: any) {
      spinner.fail(`Healing failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── testclaw status ──
program
  .command("status")
  .description("Show test suite status and last run results")
  .action(() => {
    try {
      orchestrator.loadFromPath(process.cwd());
      orchestrator.status();
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

program.parse();
