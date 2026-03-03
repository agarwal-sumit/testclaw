import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { QAConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { log } from "./utils/logger.ts";

const CONFIG_FILE = "config.yaml";

export function loadConfig(qaDir: string): QAConfig {
  const configPath = join(qaDir, CONFIG_FILE);
  if (!existsSync(configPath)) {
    log.debug("No config found, using defaults");
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as Partial<QAConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    log.warn(`Failed to parse config: ${err}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(qaDir: string, config: QAConfig): void {
  const configPath = join(qaDir, CONFIG_FILE);
  const content = YAML.stringify(config);
  writeFileSync(configPath, content, "utf-8");
  log.debug(`Config saved to ${configPath}`);
}

export function findQADir(startDir: string): string | null {
  const qaDir = join(startDir, ".qa");
  if (existsSync(qaDir)) return qaDir;
  return null;
}

export function getQADir(repoPath: string): string {
  return join(repoPath, ".qa");
}
