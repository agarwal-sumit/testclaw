import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

let currentLevel: LogLevel = "info";

const levelOrder: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return levelOrder[level] >= levelOrder[currentLevel];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  debug(msg: string, ...args: unknown[]) {
    if (shouldLog("debug")) {
      console.log(chalk.gray(`[${timestamp()}] DEBUG: ${msg}`), ...args);
    }
  },

  info(msg: string, ...args: unknown[]) {
    if (shouldLog("info")) {
      console.log(chalk.blue(`[${timestamp()}] INFO: ${msg}`), ...args);
    }
  },

  success(msg: string, ...args: unknown[]) {
    if (shouldLog("info")) {
      console.log(chalk.green(`[${timestamp()}] ✓ ${msg}`), ...args);
    }
  },

  warn(msg: string, ...args: unknown[]) {
    if (shouldLog("warn")) {
      console.log(chalk.yellow(`[${timestamp()}] WARN: ${msg}`), ...args);
    }
  },

  error(msg: string, ...args: unknown[]) {
    if (shouldLog("error")) {
      console.error(chalk.red(`[${timestamp()}] ERROR: ${msg}`), ...args);
    }
  },

  step(step: string, msg: string) {
    if (shouldLog("info")) {
      console.log(chalk.cyan(`  → [${step}] `) + msg);
    }
  },

  header(msg: string) {
    if (shouldLog("info")) {
      console.log();
      console.log(chalk.bold.underline(msg));
      console.log();
    }
  },
};
