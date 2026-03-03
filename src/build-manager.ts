import { existsSync } from "fs";
import { join } from "path";
import { execa, type ResultPromise } from "execa";
import type { BuildResult, BuildOptions, Framework } from "./types.ts";
import { claudeQuery } from "./utils/claude-sdk.ts";
import { log } from "./utils/logger.ts";

export async function buildApp(
  repoPath: string,
  framework: Framework,
  buildOpts: BuildOptions = {},
  simulatorId: string
): Promise<BuildResult> {
  log.header("Building & Launching App");
  const start = Date.now();

  if (framework === "flutter") {
    return flutterRun(repoPath, buildOpts, simulatorId, start);
  }

  return {
    success: false,
    errors: [`Unsupported framework: ${framework}`],
    duration: Date.now() - start,
  };
}

function buildFlutterRunArgs(simulatorId: string, opts: BuildOptions): string[] {
  const args = ["run", "-d", simulatorId];

  // --release vs --debug (default: debug)
  args.push(opts.release ? "--release" : "--debug");

  if (opts.flavor) {
    args.push("--flavor", opts.flavor);
  }

  if (opts.target) {
    args.push("--target", opts.target);
  }

  if (opts.dartDefine) {
    for (const [key, value] of Object.entries(opts.dartDefine)) {
      args.push("--dart-define", `${key}=${value}`);
    }
  }

  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  return args;
}

/**
 * Use `flutter run` to build, install, and launch the app on the simulator.
 * Once the app is confirmed running, we kill the flutter process.
 * The app stays installed on the simulator — maestro's `launchApp` or
 * `xcrun simctl launch` can restart it as needed.
 */
async function flutterRun(
  repoPath: string,
  buildOpts: BuildOptions,
  simulatorId: string,
  start: number
): Promise<BuildResult> {
  try {
    // flutter pub get
    log.step("build", "Running flutter pub get...");
    await execa("flutter", ["pub", "get"], { cwd: repoPath });

    const args = buildFlutterRunArgs(simulatorId, buildOpts);
    log.step("build", `flutter ${args.join(" ")}`);

    // Spawn flutter run — it builds, installs, and launches
    const child = execa("flutter", args, { cwd: repoPath });

    let output = "";

    const collectOutput = (data: Buffer | string) => {
      const chunk = data.toString();
      output += chunk;
      // Stream build progress to the user
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("Another exception")) {
          log.debug(trimmed);
        }
      }
    };

    child.stdout?.on("data", collectOutput);
    child.stderr?.on("data", collectOutput);

    // Wait for the app to be running, then kill flutter process
    await waitForAppStarted(child, output, () => output);

    log.success(`App built and launched on ${simulatorId} (${((Date.now() - start) / 1000).toFixed(1)}s)`);

    // Kill flutter process — app stays installed and running on simulator
    child.kill("SIGTERM");

    return {
      success: true,
      errors: [],
      duration: Date.now() - start,
    };
  } catch (err: any) {
    const errorOutput = err.stderr || err.stdout || err.message;
    log.error("Build/launch failed");

    // Try AI-assisted diagnosis
    const diagnosis = await diagnoseBuildError(repoPath, errorOutput);
    log.info(`Diagnosis: ${diagnosis}`);

    return {
      success: false,
      errors: [errorOutput, `AI Diagnosis: ${diagnosis}`],
      duration: Date.now() - start,
    };
  }
}

/**
 * Watch flutter run output for signals that the app has started.
 * Resolves once the app is running. Rejects on build failure or timeout.
 */
function waitForAppStarted(
  child: ResultPromise,
  _initialOutput: string,
  getOutput: () => string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Patterns that indicate the app is running
    const startedPatterns = [
      "Flutter run key commands",      // Interactive mode prompt
      "Syncing files to device",       // Files synced = app running
      "An Observatory debugger",       // Debug connection established
      "A Dart VM Service",             // VM service available
      "is now running",                // Explicit running message
    ];

    const failurePatterns = [
      "BUILD FAILED",
      "Gradle build failed",
      "Could not build the application",
      "Error launching application",
      "ProcessException:",
    ];

    let resolved = false;

    const checkOutput = () => {
      if (resolved) return;
      const out = getOutput();

      for (const pattern of startedPatterns) {
        if (out.includes(pattern)) {
          resolved = true;
          resolve();
          return;
        }
      }

      for (const pattern of failurePatterns) {
        if (out.includes(pattern)) {
          resolved = true;
          reject(new Error(out.slice(-3000)));
          return;
        }
      }
    };

    // Check output as it streams in
    child.stdout?.on("data", () => checkOutput());
    child.stderr?.on("data", () => checkOutput());

    child.on("exit", (code) => {
      if (resolved) return;
      resolved = true;
      if (code !== 0 && code !== null) {
        reject(new Error(`flutter run exited with code ${code}\n${getOutput().slice(-3000)}`));
      } else {
        // Process exited cleanly but we didn't see "started" — might still be OK
        resolve();
      }
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      reject(err);
    });

    // Timeout: 5 minutes for build + launch
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGTERM");
      reject(new Error(`flutter run timed out after 5 minutes.\n${getOutput().slice(-2000)}`));
    }, 300_000);
  });
}

async function diagnoseBuildError(repoPath: string, errorOutput: string): Promise<string> {
  try {
    const { result } = await claudeQuery({
      prompt: `Diagnose this Flutter build error and suggest a fix:

Error output:
${errorOutput.slice(0, 3000)}

Look at the project files if needed to understand the issue.`,
      tools: ["Read", "Grep", "Glob"],
      cwd: repoPath,
      systemPrompt: "You are a Flutter build expert. Diagnose build errors concisely. Respond with a 1-2 sentence diagnosis and suggested fix.",
      maxTurns: 10,
    });
    return result;
  } catch {
    return "Could not diagnose build error automatically.";
  }
}

export function getBundleId(repoPath: string): string | null {
  // Try to extract from Flutter project
  const infoPath = join(repoPath, "ios", "Runner", "Info.plist");
  if (existsSync(infoPath)) {
    try {
      const { readFileSync } = require("fs");
      const content = readFileSync(infoPath, "utf-8");
      const match = content.match(
        /<key>CFBundleIdentifier<\/key>\s*<string>\$\(PRODUCT_BUNDLE_IDENTIFIER\)<\/string>/
      );
      if (match) {
        // Fall back to project.pbxproj
        const pbxPath = join(repoPath, "ios", "Runner.xcodeproj", "project.pbxproj");
        if (existsSync(pbxPath)) {
          const pbxContent = readFileSync(pbxPath, "utf-8");
          const bundleMatch = pbxContent.match(
            /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+)/
          );
          if (bundleMatch) return bundleMatch[1].trim();
        }
      }
      // Direct bundle ID
      const directMatch = content.match(
        /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/
      );
      if (directMatch) return directMatch[1];
    } catch {
      // ignore
    }
  }

  return null;
}
