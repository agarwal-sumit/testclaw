import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import YAML from "yaml";
import { z } from "zod";
import type { TestCase, TestStep, ElementMapping, AppAnalysis } from "./types.ts";
import { claudeQuery } from "./utils/claude-sdk.ts";
import { log } from "./utils/logger.ts";

// ── Zod Schemas ──

const TestStepSchema = z.object({
  action: z.enum(["tap", "input", "scroll", "assert", "wait", "swipe", "longPress", "back"]),
  target: z.string(),
  value: z.string().optional(),
  description: z.string(),
});

const ElementMappingSchema = z.object({
  key: z.string().optional(),
  text: z.string().optional(),
  type: z.string().optional(),
  semanticsLabel: z.string().optional(),
  testId: z.string().optional(),
});

const TestCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  suite: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]),
  type: z.enum(["integration", "maestro", "agentic", "auto"]),
  preconditions: z.array(z.string()),
  steps: z.array(TestStepSchema),
  expectedResult: z.string(),
  elementMappings: z.record(z.string(), ElementMappingSchema).default({}),
  version: z.number().default(1),
});

export { TestCaseSchema };

// ── CRUD Operations ──

export function listTestCases(qaDir: string, suite?: string): TestCase[] {
  const testcasesDir = join(qaDir, "testcases");
  if (!existsSync(testcasesDir)) return [];

  const cases: TestCase[] = [];

  if (suite) {
    const suiteDir = join(testcasesDir, suite);
    if (existsSync(suiteDir)) {
      cases.push(...loadSuiteTestCases(suiteDir, suite));
    }
  } else {
    // Load all suites
    const entries = readdirSync(testcasesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        cases.push(...loadSuiteTestCases(join(testcasesDir, entry.name), entry.name));
      }
    }
  }

  return cases;
}

function loadSuiteTestCases(suiteDir: string, suite: string): TestCase[] {
  const cases: TestCase[] = [];
  const files = readdirSync(suiteDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

  for (const file of files) {
    try {
      const raw = readFileSync(join(suiteDir, file), "utf-8");
      const parsed = YAML.parse(raw);
      const validated = TestCaseSchema.parse(parsed);
      cases.push(validated as TestCase);
    } catch (err) {
      log.warn(`Invalid test case ${suite}/${file}: ${err}`);
    }
  }

  return cases;
}

export function getTestCase(qaDir: string, id: string): TestCase | null {
  const [suite, name] = id.split("/");
  if (!suite || !name) return null;

  const filePath = join(qaDir, "testcases", suite, `${name}.yaml`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(raw);
    return TestCaseSchema.parse(parsed) as TestCase;
  } catch {
    return null;
  }
}

export function saveTestCase(qaDir: string, testCase: TestCase): void {
  const [suite] = testCase.id.split("/");
  const suiteDir = join(qaDir, "testcases", suite);

  if (!existsSync(suiteDir)) {
    mkdirSync(suiteDir, { recursive: true });
  }

  const fileName = testCase.id.replace(`${suite}/`, "") + ".yaml";
  const filePath = join(suiteDir, fileName);
  const content = YAML.stringify(testCase);

  writeFileSync(filePath, content, "utf-8");
  log.success(`Saved test case: ${testCase.id}`);
}

export function deleteTestCase(qaDir: string, id: string): boolean {
  const [suite, name] = id.split("/");
  if (!suite || !name) return false;

  const filePath = join(qaDir, "testcases", suite, `${name}.yaml`);
  if (!existsSync(filePath)) return false;

  const { unlinkSync } = require("fs");
  unlinkSync(filePath);
  log.info(`Deleted test case: ${id}`);
  return true;
}

export function createTestCaseFromSuggestion(
  suite: string,
  name: string,
  description: string,
  steps: TestStep[]
): TestCase {
  const id = `${suite}/${name}`;
  return {
    id,
    name: description,
    suite,
    priority: "medium",
    type: "auto",
    preconditions: [],
    steps,
    expectedResult: description,
    elementMappings: {},
    version: 1,
  };
}

export function validateTestCase(data: unknown): { valid: boolean; errors?: string[] } {
  const result = TestCaseSchema.safeParse(data);
  if (result.success) {
    return { valid: true };
  }
  return {
    valid: false,
    errors: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
  };
}

// ── AI-Powered Test Case Generation ──

const GENERATE_TC_SYSTEM_PROMPT = `You are an expert QA engineer. Given a plain-English test description and app analysis context, generate a structured test case as JSON.

You MUST respond with ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "id": "suite/kebab-case-name",
  "name": "Human readable test name",
  "suite": "suite-name",
  "priority": "critical" | "high" | "medium" | "low",
  "type": "auto",
  "preconditions": ["string"],
  "steps": [
    {
      "action": "tap" | "input" | "scroll" | "assert" | "wait" | "swipe" | "longPress" | "back",
      "target": "Human readable element description",
      "value": "optional value for input/assert",
      "description": "What this step does"
    }
  ],
  "expectedResult": "What should happen when the test passes",
  "elementMappings": {
    "Element description": {
      "key": "Key('widgetKey')",
      "text": "visible text",
      "type": "WidgetType",
      "semanticsLabel": "semantic label",
      "testId": "test-id"
    }
  },
  "version": 1
}

Guidelines:
- Derive the suite name from the test description (e.g. "auth", "kyc", "portfolio", "onboarding")
- Create a kebab-case ID like "auth/login-happy-path-001"
- Break the description into concrete, atomic steps
- Include assert steps to verify outcomes
- Add wait steps where network calls or animations are expected
- Include preconditions (e.g. "User is logged out", "App is on home screen")
- Fill elementMappings with any identifiers you can infer from the app analysis
- Set priority based on the flow's criticality (auth/payment = critical, settings = low)`;

export async function generateTestCaseFromDescription(
  description: string,
  repoPath: string,
  analysis: AppAnalysis | null
): Promise<TestCase> {
  log.step("ai", `Generating test case from: "${description.slice(0, 80)}..."`);

  const prompt = `Generate a structured test case from this description:

"${description}"

${analysis ? `App analysis context:\n${JSON.stringify(analysis, null, 2)}` : "No app analysis available."}

Read the app source code if you need to understand specific widgets, routes, or identifiers.
Return ONLY the JSON test case.`;

  const { result } = await claudeQuery({
    prompt,
    tools: ["Read", "Glob", "Grep"],
    cwd: repoPath,
    systemPrompt: GENERATE_TC_SYSTEM_PROMPT,
    maxTurns: 10,
  });

  return parseTestCaseResult(result);
}

export async function generateTestCasesFromSuggestions(
  suggestions: string[],
  repoPath: string,
  analysis: AppAnalysis | null
): Promise<TestCase[]> {
  log.header("Generating Test Cases from Suggestions");
  const testCases: TestCase[] = [];

  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];
    log.info(`[${i + 1}/${suggestions.length}] ${suggestion.slice(0, 80)}...`);

    try {
      const tc = await generateTestCaseFromDescription(suggestion, repoPath, analysis);
      testCases.push(tc);
      log.success(`Created: ${tc.id} (${tc.steps.length} steps)`);
    } catch (err: any) {
      log.warn(`Skipped: ${err.message}`);
    }
  }

  return testCases;
}

function parseTestCaseResult(result: string): TestCase {
  let jsonStr = result;

  // Strip markdown code fences
  const fenceMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Find the JSON object
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) {
    jsonStr = objMatch[0];
  }

  const parsed = JSON.parse(jsonStr);
  const validated = TestCaseSchema.parse(parsed);
  return validated as TestCase;
}
