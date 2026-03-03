// ── Framework Detection ──
export type Framework = "flutter" | "react-native" | "unknown";

// ── Test Case Types ──
export type TestPriority = "critical" | "high" | "medium" | "low";
export type TestType = "integration" | "maestro" | "agentic" | "auto";
export type TestStatus = "pending" | "passed" | "failed" | "skipped" | "healed";

export interface TestStep {
  action: "tap" | "input" | "scroll" | "assert" | "wait" | "swipe" | "longPress" | "back";
  target: string;
  value?: string;
  description: string;
}

export interface ElementMapping {
  key?: string;
  text?: string;
  type?: string;
  semanticsLabel?: string;
  testId?: string;
}

export interface TestCase {
  id: string;
  name: string;
  suite: string;
  priority: TestPriority;
  type: TestType;
  preconditions: string[];
  steps: TestStep[];
  expectedResult: string;
  elementMappings: Record<string, ElementMapping>;
  testData?: Record<string, string>;
  version: number;
}

// ── App Analysis ──
export interface ScreenInfo {
  name: string;
  filePath: string;
  route?: string;
  widgets: string[];
  actions: string[];
}

export interface AppAnalysis {
  framework: Framework;
  screens: ScreenInfo[];
  navigationRoutes: Record<string, string>;
  dataModels: string[];
  apiEndpoints: string[];
  semanticIdentifiers: string[];
  existingTests: string[];
  suggestedTestCases: string[];
}

// ── Build ──
export interface BuildResult {
  success: boolean;
  appBundlePath?: string;
  errors: string[];
  duration: number;
}

// ── Simulator ──
export interface SimulatorDevice {
  udid: string;
  name: string;
  state: "Booted" | "Shutdown" | string;
  runtime: string;
}

// ── Test Run ──
export interface RunResult {
  testCaseId: string;
  testType: TestType;
  status: TestStatus;
  duration: number;
  errorMessage?: string;
  errorDetails?: string;
  agenticAnalysis?: string;
  screenshots: string[];
  logs: string[];
}

export interface RunSummary {
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  healed: number;
  duration: number;
  results: RunResult[];
}

// ── Self-Healing ──
export type FailureClassification = "real_bug" | "implementation_change" | "flaky";

export interface HealingResult {
  testCaseId: string;
  classification: FailureClassification;
  confidence: number;
  description: string;
  changesApplied?: string[];
  rerunPassed?: boolean;
}

export interface HealLogEntry {
  timestamp: string;
  testCaseId: string;
  classification: FailureClassification;
  confidence: number;
  healedSuccessfully: boolean;
  changes: string[];
}

// ── Session Context ──
export interface SessionContext {
  repoPath: string;
  qaDir: string;
  framework: Framework;
  simulatorId?: string;
  analysis?: AppAnalysis;
  testCases: TestCase[];
  lastRun?: RunSummary;
}

// ── Build Options ──
export interface BuildOptions {
  flavor?: string;
  dartDefine?: Record<string, string>;
  release?: boolean;
  target?: string;
  extraArgs?: string[];
}

// ── Config ──
export interface QAConfig {
  framework: Framework;
  repoPath: string;
  defaultSimulator?: string;
  defaultTestType: TestType;
  build: BuildOptions;
  healingConfidenceThreshold: number;
  maxAgenticTurns: number;
  screenshotOnFailure: boolean;
  autoCommitResults: boolean;
}

export const DEFAULT_CONFIG: QAConfig = {
  framework: "flutter",
  repoPath: ".",
  defaultTestType: "auto",
  build: {},
  healingConfidenceThreshold: 0.8,
  maxAgenticTurns: 50,
  screenshotOnFailure: true,
  autoCommitResults: true,
};
