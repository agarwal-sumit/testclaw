import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AppAnalysis, Framework } from "./types.ts";
import { claudeQuery } from "./utils/claude-sdk.ts";
import { log } from "./utils/logger.ts";

const ANALYSIS_FILE = "app-structure.json";

export async function analyzeCodebase(
  repoPath: string,
  qaDir: string,
  framework: Framework
): Promise<AppAnalysis> {
  log.header("Analyzing Codebase");

  const systemPrompt = buildSystemPrompt(framework);
  const prompt = buildAnalysisPrompt(repoPath, framework);

  const { result } = await claudeQuery({
    prompt,
    tools: ["Read", "Glob", "Grep", "Bash"],
    cwd: repoPath,
    systemPrompt,
    maxTurns: 30,
  });

  const analysis = parseAnalysisResult(result, framework);

  // Cache result
  const analysisDir = join(qaDir, "analysis");
  writeFileSync(
    join(analysisDir, ANALYSIS_FILE),
    JSON.stringify(analysis, null, 2),
    "utf-8"
  );

  log.success(`Analysis complete: ${analysis.screens.length} screens, ${analysis.navigationRoutes ? Object.keys(analysis.navigationRoutes).length : 0} routes`);
  return analysis;
}

export function loadCachedAnalysis(qaDir: string): AppAnalysis | null {
  const analysisPath = join(qaDir, "analysis", ANALYSIS_FILE);
  if (!existsSync(analysisPath)) return null;

  try {
    return JSON.parse(readFileSync(analysisPath, "utf-8")) as AppAnalysis;
  } catch {
    return null;
  }
}

function buildSystemPrompt(framework: Framework): string {
  return `You are an expert mobile app analyzer. Your job is to understand the structure of a ${framework} app and produce a comprehensive analysis as JSON.

You MUST respond with ONLY valid JSON matching this structure (no markdown, no explanation):
{
  "framework": "${framework}",
  "screens": [{ "name": "string", "filePath": "string", "route": "string?", "widgets": ["string"], "actions": ["string"] }],
  "navigationRoutes": { "routeName": "filePath" },
  "dataModels": ["string"],
  "apiEndpoints": ["string"],
  "semanticIdentifiers": ["string"],
  "existingTests": ["string"],
  "suggestedTestCases": ["string"]
}

Be thorough but concise. Focus on:
- Every screen/page/view in the app
- Navigation routes and how screens connect
- Key widgets with semantic labels or test keys
- Data models and API endpoints
- Any existing test files
- Suggested test cases based on the app's functionality`;
}

function buildAnalysisPrompt(repoPath: string, framework: Framework): string {
  if (framework === "flutter") {
    return `Analyze this Flutter app's codebase thoroughly.

1. Use Glob to find all Dart files in lib/
2. Read the main entry point (lib/main.dart)
3. Find all screen/page widgets by searching for StatefulWidget, StatelessWidget classes
4. Look for route definitions (MaterialPageRoute, GoRouter, auto_route, etc.)
5. Find semantic identifiers (Key(), semanticsLabel, testId patterns)
6. Check for data model classes
7. Look for HTTP/API calls (http, dio, retrofit)
8. Check for existing tests in test/ and integration_test/
9. Based on all findings, suggest 5-10 high-value test cases

Return ONLY the JSON analysis. No other text.`;
  }

  return `Analyze this mobile app's codebase thoroughly and return a JSON analysis.

1. Find all source files
2. Identify screens/views/pages
3. Find navigation patterns
4. Look for test identifiers
5. Check for data models and API calls
6. Look for existing tests
7. Suggest 5-10 test cases

Return ONLY the JSON analysis. No other text.`;
}

function parseAnalysisResult(result: string, framework: Framework): AppAnalysis {
  // Try to extract JSON from the result
  let jsonStr = result;

  // Handle markdown code blocks
  const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Try to find JSON object in the text
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) {
    jsonStr = objMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      framework: parsed.framework ?? framework,
      screens: parsed.screens ?? [],
      navigationRoutes: parsed.navigationRoutes ?? {},
      dataModels: parsed.dataModels ?? [],
      apiEndpoints: parsed.apiEndpoints ?? [],
      semanticIdentifiers: parsed.semanticIdentifiers ?? [],
      existingTests: parsed.existingTests ?? [],
      suggestedTestCases: parsed.suggestedTestCases ?? [],
    };
  } catch (err) {
    log.warn(`Failed to parse analysis JSON, creating minimal analysis`);
    return {
      framework,
      screens: [],
      navigationRoutes: {},
      dataModels: [],
      apiEndpoints: [],
      semanticIdentifiers: [],
      existingTests: [],
      suggestedTestCases: [],
    };
  }
}
