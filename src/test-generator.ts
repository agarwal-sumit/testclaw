import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { TestCase, AppAnalysis, TestType } from "./types.ts";
import { claudeQuery } from "./utils/claude-sdk.ts";
import { log } from "./utils/logger.ts";

export interface GenerateResult {
  testCaseId: string;
  type: TestType;
  filePath: string;
  success: boolean;
  error?: string;
}

export async function generateTests(
  qaDir: string,
  repoPath: string,
  testCases: TestCase[],
  analysis: AppAnalysis
): Promise<GenerateResult[]> {
  log.header("Generating Tests");
  const results: GenerateResult[] = [];

  for (const tc of testCases) {
    try {
      const testType = resolveTestType(tc, analysis);
      log.step(tc.id, `Generating ${testType} test`);

      const result = await generateSingleTest(qaDir, repoPath, tc, testType, analysis);
      results.push(result);

      if (result.success) {
        log.success(`Generated: ${result.filePath}`);
      } else {
        log.error(`Failed: ${result.error}`);
      }
    } catch (err: any) {
      results.push({
        testCaseId: tc.id,
        type: tc.type === "auto" ? "integration" : tc.type,
        filePath: "",
        success: false,
        error: err.message,
      });
    }
  }

  // Update fingerprints
  await updateFingerprints(qaDir, repoPath, testCases, analysis);

  return results;
}

function resolveTestType(tc: TestCase, analysis: AppAnalysis): TestType {
  if (tc.type !== "auto") return tc.type;

  // Heuristics for auto-type resolution
  const hasComplexInteractions = tc.steps.some(
    (s) => s.action === "swipe" || s.action === "longPress"
  );
  const hasAssertions = tc.steps.some((s) => s.action === "assert");
  const stepCount = tc.steps.length;

  // Agentic for complex flows that need visual verification
  if (tc.steps.some((s) => s.description?.toLowerCase().includes("oauth") ||
      s.description?.toLowerCase().includes("camera") ||
      s.description?.toLowerCase().includes("biometric"))) {
    return "agentic";
  }

  // Maestro for UI-heavy flows
  if (hasComplexInteractions || stepCount > 8) {
    return "maestro";
  }

  // Default to integration
  return "integration";
}

async function generateSingleTest(
  qaDir: string,
  repoPath: string,
  tc: TestCase,
  testType: TestType,
  analysis: AppAnalysis
): Promise<GenerateResult> {
  if (testType === "integration") {
    return generateIntegrationTest(qaDir, repoPath, tc, analysis);
  } else if (testType === "maestro") {
    return generateMaestroTest(qaDir, tc, analysis);
  } else {
    return generateAgenticInstructions(qaDir, repoPath, tc, analysis);
  }
}

async function generateIntegrationTest(
  qaDir: string,
  repoPath: string,
  tc: TestCase,
  analysis: AppAnalysis
): Promise<GenerateResult> {
  const systemPrompt = `You are a Flutter integration test generator. Generate a complete, runnable Dart integration test file.

The test MUST:
- Import 'package:flutter_test/flutter_test.dart' and 'package:integration_test/integration_test.dart'
- Import the app's main file
- Use IntegrationTestWidgetsFlutterBinding.ensureInitialized()
- Use proper widget finders (find.byKey, find.text, find.byType, etc.)
- Include proper waits with pumpAndSettle()
- Be a complete, compilable Dart file

Return ONLY the Dart code. No markdown, no explanation.`;

  const prompt = `Generate a Flutter integration test for this test case:

${JSON.stringify(tc, null, 2)}

App analysis (use for context about available widgets, routes, and identifiers):
${JSON.stringify(analysis, null, 2)}

Read relevant source files in ${repoPath}/lib/ if needed to understand widget structure and keys.
Return ONLY the complete Dart test file content.`;

  const { result } = await claudeQuery({
    prompt,
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
    cwd: repoPath,
    systemPrompt,
    maxTurns: 15,
  });

  const dartCode = extractCode(result, "dart");
  const fileName = tc.id.replace("/", "_") + "_test.dart";
  const filePath = join(qaDir, "tests", "integration", fileName);

  writeFileSync(filePath, dartCode, "utf-8");

  return {
    testCaseId: tc.id,
    type: "integration",
    filePath,
    success: true,
  };
}

async function generateMaestroTest(
  qaDir: string,
  tc: TestCase,
  analysis: AppAnalysis
): Promise<GenerateResult> {
  const systemPrompt = `You are a Maestro test flow generator. Generate a complete, runnable Maestro YAML flow file.

The flow MUST:
- Use valid Maestro YAML syntax
- Start with the appId config section, followed by "---"
- The FIRST command after "---" MUST be "- launchApp" to open the app on the simulator
- Use proper Maestro commands (launchApp, tapOn, inputText, assertVisible, scroll, swipe, back, waitForAnimationToEnd, extendedWaitUntil, etc.)
- Include appropriate wait times where needed

Example structure:
  appId: com.example.app
  ---
  - launchApp
  - assertVisible:
      text: "Welcome"

Return ONLY the YAML content. No markdown, no explanation.`;

  const prompt = `Generate a Maestro test flow for this test case:

${JSON.stringify(tc, null, 2)}

App analysis context:
${JSON.stringify(analysis, null, 2)}

Return ONLY the complete Maestro YAML flow content.`;

  const { result } = await claudeQuery({
    prompt,
    tools: ["Read", "Glob", "Grep", "Bash"],
    cwd: qaDir,
    systemPrompt,
    maxTurns: 15,
  });

  const yamlContent = ensureLaunchApp(extractCode(result, "yaml"));
  const fileName = tc.id.replace("/", "_") + ".yaml";
  const filePath = join(qaDir, "tests", "maestro", fileName);

  writeFileSync(filePath, yamlContent, "utf-8");

  return {
    testCaseId: tc.id,
    type: "maestro",
    filePath,
    success: true,
  };
}

async function generateAgenticInstructions(
  qaDir: string,
  repoPath: string,
  tc: TestCase,
  analysis: AppAnalysis
): Promise<GenerateResult> {
  const agenticDir = join(qaDir, "tests", "agentic");
  if (!existsSync(agenticDir)) mkdirSync(agenticDir, { recursive: true });

  // Build test data from step values + explicit testData
  const testData: Record<string, string> = { ...tc.testData };
  for (const step of tc.steps) {
    if (step.value && !testData[step.target]) {
      testData[step.target] = step.value;
    }
  }

  const instructions = {
    id: tc.id,
    name: tc.name,
    suite: tc.suite,
    priority: tc.priority,
    expectedResult: tc.expectedResult,
    preconditions: tc.preconditions,
    testData,
    steps: tc.steps.map((s, i) => ({
      step: i + 1,
      action: s.action,
      target: s.target,
      value: s.value,
      description: s.description,
    })),
    hints: {
      screens: analysis.screens
        .filter((s) =>
          tc.steps.some(
            (step) =>
              step.target.toLowerCase().includes(s.name.toLowerCase()) ||
              step.description.toLowerCase().includes(s.name.toLowerCase())
          )
        )
        .map((s) => ({ name: s.name, route: s.route, widgets: s.widgets })),
    },
  };

  const fileName = tc.id.replace("/", "_") + ".yaml";
  const filePath = join(agenticDir, fileName);
  writeFileSync(filePath, YAML.stringify(instructions), "utf-8");

  return {
    testCaseId: tc.id,
    type: "agentic",
    filePath,
    success: true,
  };
}

/** Ensure the Maestro flow starts with `- launchApp` after the `---` separator */
function ensureLaunchApp(yaml: string): string {
  // Check if launchApp is already present
  if (/^-\s*launchApp/m.test(yaml)) return yaml;

  // Insert launchApp right after the --- separator
  const separatorIndex = yaml.indexOf("---");
  if (separatorIndex !== -1) {
    const afterSeparator = separatorIndex + 3;
    return yaml.slice(0, afterSeparator) + "\n- launchApp\n" + yaml.slice(afterSeparator).replace(/^\n/, "");
  }

  // No separator — prepend launchApp as the first command
  return "- launchApp\n" + yaml;
}

function extractCode(result: string, lang: string): string {
  // Try to extract from markdown code block
  const blockRegex = new RegExp(`\`\`\`(?:${lang})?\\s*([\\s\\S]*?)\`\`\``, "i");
  const match = result.match(blockRegex);
  if (match) return match[1].trim();

  // If no code block, return the whole result (it might just be raw code)
  return result.trim();
}

async function updateFingerprints(
  qaDir: string,
  repoPath: string,
  testCases: TestCase[],
  analysis: AppAnalysis
): Promise<void> {
  const fingerprints: Record<string, any> = {};

  for (const tc of testCases) {
    for (const [label, mapping] of Object.entries(tc.elementMappings)) {
      fingerprints[label] = {
        ...mapping,
        testCaseIds: [
          ...(fingerprints[label]?.testCaseIds ?? []),
          tc.id,
        ],
      };
    }
  }

  // Add semantic identifiers from analysis
  for (const id of analysis.semanticIdentifiers) {
    if (!fingerprints[id]) {
      fingerprints[id] = { semanticsLabel: id, testCaseIds: [] };
    }
  }

  const fingerprintsPath = join(qaDir, "fingerprints", "elements.json");
  writeFileSync(fingerprintsPath, JSON.stringify(fingerprints, null, 2), "utf-8");
}
