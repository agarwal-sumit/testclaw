import { execa } from "execa";
import { log } from "./logger.ts";

export async function gitClone(url: string, dest: string): Promise<void> {
  log.info(`Cloning ${url} → ${dest}`);
  await execa("git", ["clone", "--depth", "1", url, dest]);
}

export async function gitInit(dir: string): Promise<void> {
  await execa("git", ["init"], { cwd: dir });
}

export async function gitAdd(dir: string, paths: string[]): Promise<void> {
  await execa("git", ["add", ...paths], { cwd: dir });
}

export async function gitCommit(dir: string, message: string): Promise<void> {
  try {
    await execa("git", ["add", ".qa/"], { cwd: dir });
    await execa("git", ["commit", "-m", message, "--no-verify"], { cwd: dir });
    log.success(`Committed: ${message}`);
  } catch (err: any) {
    if (err.stderr?.includes("nothing to commit")) {
      log.debug("Nothing to commit");
    } else {
      throw err;
    }
  }
}

export async function gitDiff(
  dir: string,
  fromRef?: string,
  paths?: string[]
): Promise<string> {
  const args = ["diff"];
  if (fromRef) args.push(fromRef);
  if (paths) args.push("--", ...paths);
  const { stdout } = await execa("git", args, { cwd: dir });
  return stdout;
}

export async function gitLog(
  dir: string,
  n: number = 10
): Promise<string> {
  const { stdout } = await execa("git", ["log", `--oneline`, `-n`, String(n)], {
    cwd: dir,
  });
  return stdout;
}

export async function getLastCommitHash(dir: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

export async function getChangedFiles(
  dir: string,
  sinceCommit: string
): Promise<string[]> {
  try {
    const { stdout } = await execa(
      "git",
      ["diff", "--name-only", sinceCommit, "HEAD"],
      { cwd: dir }
    );
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
