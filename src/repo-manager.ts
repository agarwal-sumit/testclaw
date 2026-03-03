import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Framework, QAConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { gitClone } from "./utils/git.ts";
import { saveConfig } from "./config.ts";
import { log } from "./utils/logger.ts";
import YAML from "yaml";

const QA_DIRS = [
  "analysis",
  "testcases",
  "tests/integration",
  "tests/maestro",
  "tests/agentic",
  "results/runs",
  "results/baselines",
  "fingerprints",
  "history",
];

export async function cloneRepo(url: string, destDir: string): Promise<string> {
  const repoName = url.split("/").pop()?.replace(".git", "") ?? "repo";
  const repoPath = resolve(destDir, repoName);

  if (existsSync(repoPath)) {
    log.warn(`Directory ${repoPath} already exists, using it`);
    return repoPath;
  }

  await gitClone(url, repoPath);
  return repoPath;
}

export function detectFramework(repoPath: string): Framework {
  // Check for Flutter
  if (existsSync(join(repoPath, "pubspec.yaml"))) {
    log.info("Detected Flutter project");
    return "flutter";
  }

  // Check for React Native
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.dependencies?.["react-native"] || pkg.dependencies?.["expo"]) {
        log.info("Detected React Native project");
        return "react-native";
      }
    } catch {
      // ignore parse errors
    }
  }

  log.warn("Could not detect framework");
  return "unknown";
}

export function scaffoldQADir(repoPath: string, framework: Framework): string {
  const qaDir = join(repoPath, ".qa");

  if (!existsSync(qaDir)) {
    mkdirSync(qaDir, { recursive: true });
  }

  for (const dir of QA_DIRS) {
    const fullPath = join(qaDir, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // Generate config
  const config: QAConfig = {
    ...DEFAULT_CONFIG,
    framework,
    repoPath,
  };
  saveConfig(qaDir, config);

  // Generate CLAUDE.md for the target repo
  generateClaudeMd(qaDir, repoPath, framework);

  // Initialize empty data files
  initializeDataFiles(qaDir);

  log.success(`Scaffolded .qa/ directory at ${qaDir}`);
  return qaDir;
}

function generateClaudeMd(qaDir: string, repoPath: string, framework: Framework): void {
  const claudeMdPath = join(qaDir, "CLAUDE.md");

  let content = `# TestClaw Context for this project\n\n`;
  content += `## Framework\n${framework}\n\n`;

  if (framework === "flutter") {
    const pubspecPath = join(repoPath, "pubspec.yaml");
    if (existsSync(pubspecPath)) {
      try {
        const pubspec = YAML.parse(readFileSync(pubspecPath, "utf-8"));
        content += `## Project: ${pubspec.name ?? "unknown"}\n`;
        content += `Description: ${pubspec.description ?? "N/A"}\n\n`;

        if (pubspec.dependencies) {
          content += `## Key Dependencies\n`;
          for (const [dep, ver] of Object.entries(pubspec.dependencies)) {
            if (typeof ver === "string") {
              content += `- ${dep}: ${ver}\n`;
            } else {
              content += `- ${dep}\n`;
            }
          }
          content += "\n";
        }
      } catch {
        // ignore
      }
    }
  }

  content += `## QA Directory Structure\n`;
  content += `- testcases/ — YAML test case definitions\n`;
  content += `- tests/integration/ — Generated Flutter integration tests\n`;
  content += `- tests/maestro/ — Generated Maestro flow YAML files\n`;
  content += `- results/ — Test run results and baselines\n`;
  content += `- analysis/ — Codebase analysis output\n`;

  writeFileSync(claudeMdPath, content, "utf-8");
}

function initializeDataFiles(qaDir: string): void {
  const fingerprintsPath = join(qaDir, "fingerprints", "elements.json");
  if (!existsSync(fingerprintsPath)) {
    writeFileSync(fingerprintsPath, "{}", "utf-8");
  }

  const healLogPath = join(qaDir, "history", "heal-log.json");
  if (!existsSync(healLogPath)) {
    writeFileSync(healLogPath, "[]", "utf-8");
  }
}

export function validateRepoPath(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  return resolved;
}
