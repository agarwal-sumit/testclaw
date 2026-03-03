import { join } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { execa } from "execa";
import type { TestCase, RunResult } from "./types.ts";
import {
  claudeQuery,
  claudeStream,
  tool,
  createSdkMcpServer,
  z,
} from "./utils/claude-sdk.ts";
import { takeScreenshot } from "./simulator-manager.ts";
import { log } from "./utils/logger.ts";

/** Build an env that includes maestro and Java on PATH */
function getMaestroEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...process.env, ...extra };
  const home = env.HOME ?? process.env.HOME ?? "";
  const additions: string[] = [];

  const maestroBin = join(home, ".maestro", "bin");
  if (existsSync(maestroBin)) additions.push(maestroBin);

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

export async function runAgenticTest(
  qaDir: string,
  repoPath: string,
  testCase: TestCase,
  simulatorId: string,
  bundleId: string,
  maxTurns: number = 50
): Promise<RunResult> {
  log.step(testCase.id, "Running agentic test (screenshot→act loop)");

  const start = Date.now();
  const screenshots: string[] = [];
  const logs: string[] = [];
  const runDir = join(qaDir, "results", "runs", `agentic_${Date.now()}`);
  mkdirSync(runDir, { recursive: true });

  let screenshotCounter = 0;

  // Define custom MCP tools for the agentic tester
  const takeScreenshotTool = tool(
    "take_screenshot",
    "Take a screenshot of the current simulator screen. Returns the file path to the screenshot image.",
    {},
    async () => {
      screenshotCounter++;
      const path = join(runDir, `screenshot_${screenshotCounter}.png`);
      await takeScreenshot(simulatorId, path);
      screenshots.push(path);
      return {
        content: [{ type: "text" as const, text: `Screenshot saved: ${path}` }],
      };
    },
    { annotations: { readOnly: true } }
  );

  const maestroExecuteTool = tool(
    "maestro_execute",
    "Execute a Maestro command on the running app. Pass the YAML content of a single Maestro command or a sequence of commands.",
    { yaml_content: z.string().describe("Maestro YAML command(s) to execute") },
    async (args) => {
      const tempFlow = join(runDir, `step_${Date.now()}.yaml`);
      const flowContent = `appId: ${bundleId}\n---\n${args.yaml_content}`;
      writeFileSync(tempFlow, flowContent, "utf-8");

      try {
        const { stdout, stderr } = await execa("maestro", ["test", tempFlow], {
          timeout: 30_000,
          env: getMaestroEnv({ MAESTRO_DEVICE_ID: simulatorId }),
        });
        logs.push(`Maestro: ${stdout}`);
        return {
          content: [{ type: "text" as const, text: `Command executed successfully.\n${stdout}` }],
        };
      } catch (err: any) {
        const errorMsg = err.stderr || err.stdout || err.message;
        logs.push(`Maestro error: ${errorMsg}`);
        return {
          content: [{ type: "text" as const, text: `Command failed: ${errorMsg}` }],
          isError: true,
        };
      }
    }
  );

  const getAppLogsTool = tool(
    "get_app_logs",
    "Get the most recent app logs from the simulator.",
    { lines: z.number().optional().describe("Number of log lines to return (default 50)") },
    async (args) => {
      try {
        const { stdout } = await execa("xcrun", [
          "simctl",
          "spawn",
          simulatorId,
          "log",
          "show",
          "--predicate",
          `subsystem contains "${bundleId}"`,
          "--last",
          `${args.lines ?? 50}`,
          "--style",
          "compact",
        ]);
        return {
          content: [{ type: "text" as const, text: stdout || "No logs found." }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Could not fetch logs: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnly: true } }
  );

  // Create in-process MCP server
  const mcpServer = createSdkMcpServer({
    name: "testclaw-agentic-tester",
    version: "1.0.0",
    tools: [takeScreenshotTool, maestroExecuteTool, getAppLogsTool],
  });

  const systemPrompt = `You are a mobile app tester controlling an iOS simulator. You test by taking screenshots, analyzing what's on screen, and executing Maestro commands.

WORKFLOW:
1. Take a screenshot to see the current state
2. Analyze the screenshot to understand what's on screen
3. Execute the appropriate Maestro command for the next test step
4. Take another screenshot to verify the result
5. Repeat until all steps are complete or a failure is detected

MAESTRO COMMAND SYNTAX:
- tapOn: "Button Text" or id: "elementId"
- inputText: "text to type"
- assertVisible: "Expected Text"
- scroll
- swipeLeft / swipeRight
- back
- waitForAnimationToEnd

IMPORTANT:
- Always take a screenshot before and after each action
- If an element is not found, try scrolling or waiting
- Report clearly whether the test PASSED or FAILED
- End your final message with exactly "TEST_PASSED" or "TEST_FAILED: <reason>"`;

  const prompt = buildAgenticPrompt(testCase, qaDir);

  try {
    const { result } = await claudeStream(
      {
        prompt,
        tools: ["Read", "Bash"],
        cwd: repoPath,
        systemPrompt,
        maxTurns,
        mcpServers: {
          "testclaw-agentic-tester": mcpServer,
        },
      },
      (msg) => {
        // Log progress
        if (msg.type === "assistant") {
          const text = msg.message?.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (text) {
            log.debug(`Agentic: ${text.slice(0, 100)}`);
          }
        }
      }
    );

    const passed = result.includes("TEST_PASSED");
    const failReason = result.match(/TEST_FAILED:\s*(.*)/)?.[1];

    return {
      testCaseId: testCase.id,
      testType: "agentic",
      status: passed ? "passed" : "failed",
      duration: Date.now() - start,
      errorMessage: failReason,
      screenshots,
      logs,
    };
  } catch (err: any) {
    return {
      testCaseId: testCase.id,
      testType: "agentic",
      status: "failed",
      duration: Date.now() - start,
      errorMessage: err.message,
      screenshots,
      logs,
    };
  }
}

/**
 * Analyze a test failure by taking a screenshot and having Claude explain
 * what's on screen and why the test likely failed.
 * Called automatically for ANY test type (integration, maestro, agentic) on failure.
 */
export async function analyzeFailure(
  simulatorId: string,
  testCase: TestCase,
  errorMessage: string,
  errorDetails: string | undefined,
  screenshotDir: string,
): Promise<string> {
  try {
    // Take a screenshot of current simulator state
    if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = join(screenshotDir, `${testCase.id.replace("/", "_")}_failure_analysis.png`);
    await takeScreenshot(simulatorId, screenshotPath);

    const { result } = await claudeQuery({
      prompt: `A mobile app test just failed. Analyze the failure.

TEST CASE:
- Name: ${testCase.name}
- ID: ${testCase.id}
- Expected result: ${testCase.expectedResult}
- Steps: ${testCase.steps.map((s, i) => `${i + 1}. ${s.action}: ${s.target}${s.value ? ` = "${s.value}"` : ""} — ${s.description}`).join("\n")}

ERROR MESSAGE:
${errorMessage}

${errorDetails ? `ERROR DETAILS:\n${errorDetails.slice(0, 2000)}` : ""}

INSTRUCTIONS:
1. Read the screenshot at: ${screenshotPath}
2. Describe what you see on the simulator screen
3. Explain WHY the test failed based on what's visible vs what was expected
4. Identify the specific step that failed and what the app is showing instead
5. Suggest whether this is likely a real bug, a test issue, or a timing problem

Be concise but specific. Focus on the visual evidence.`,
      tools: ["Read"],
      cwd: screenshotDir,
      systemPrompt: "You are a mobile app test analyst. You analyze screenshots from failed tests to explain exactly what went wrong. Read the screenshot image file to see what's on screen. Be specific and actionable.",
      maxTurns: 5,
    });

    return result;
  } catch (err: any) {
    log.debug(`Failure analysis failed: ${err.message}`);
    return `Could not analyze failure: ${err.message}`;
  }
}

function buildAgenticPrompt(tc: TestCase, qaDir?: string): string {
  let prompt = `Execute this test case on the running app:\n\n`;
  prompt += `Test: ${tc.name}\n`;
  prompt += `Expected result: ${tc.expectedResult}\n\n`;

  // Include test data prominently so Claude knows what values to use
  const testData = tc.testData ?? {};
  // Also extract values from steps
  for (const step of tc.steps) {
    if (step.value && !testData[step.target]) {
      testData[step.target] = step.value;
    }
  }

  if (Object.keys(testData).length > 0) {
    prompt += `TEST DATA (use these exact values):\n`;
    for (const [key, value] of Object.entries(testData)) {
      prompt += `  ${key}: "${value}"\n`;
    }
    prompt += "\n";
  }

  if (tc.preconditions.length > 0) {
    prompt += `Preconditions:\n`;
    for (const pre of tc.preconditions) {
      prompt += `- ${pre}\n`;
    }
    prompt += "\n";
  }

  prompt += `Steps:\n`;
  for (let i = 0; i < tc.steps.length; i++) {
    const step = tc.steps[i];
    prompt += `${i + 1}. ${step.action}: ${step.target}`;
    if (step.value) prompt += ` = "${step.value}"`;
    prompt += ` — ${step.description}\n`;
  }

  // Check for instruction file with additional hints
  if (qaDir) {
    const instructionFile = join(qaDir, "tests", "agentic", `${tc.id.replace("/", "_")}.yaml`);
    if (existsSync(instructionFile)) {
      prompt += `\nAdditional instructions are available at: ${instructionFile}\nRead this file for screen hints and element mappings.\n`;
    }
  }

  prompt += `\nStart by taking a screenshot to see the current app state, then proceed step by step.`;
  return prompt;
}
