import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import logger from "../logger.js";

const execFileAsync = promisify(execFile);

export function normalizeCodeRemoteUrl(url: string): string {
  if (!url) return "";
  return url
    .trim()
    .replace(/^[^@/:]+@([^:]+):/, "$1/")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@([^/]+)\//, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

export interface CodebaseIdentity {
  repositoryRemote?: string;
  branch?: string;
  commit?: string;
  codebasePath: string;
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

export async function resolveCodebaseIdentity(path: string): Promise<CodebaseIdentity> {
  const codebasePath = resolve(path);
  const identity: CodebaseIdentity = { codebasePath };
  const env = cleanGitEnvironment();

  try {
    const { stdout: rootOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: codebasePath,
      env,
    });
    if (resolve(rootOutput.trim()) !== codebasePath) return identity;

    const { stdout: commitOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: codebasePath,
      env,
    });
    identity.commit = commitOutput.trim();

    try {
      const { stdout: remoteOutput } = await execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd: codebasePath,
        env,
      });
      identity.repositoryRemote = normalizeCodeRemoteUrl(remoteOutput) || undefined;
    } catch {
      // Local repositories without an origin use their absolute path as repository identity.
    }

    try {
      const { stdout: branchOutput } = await execFileAsync(
        "git",
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        { cwd: codebasePath, env }
      );
      identity.branch = branchOutput.trim();
    } catch {
      identity.branch = `detached/${identity.commit.substring(0, 12)}`;
      logger.warn(
        { path: codebasePath, branch: identity.branch },
        "Detached HEAD detected; using deterministic commit-based branch identity"
      );
    }
  } catch {
    // Non-Git directories retain deterministic absolute-path identity.
  }

  return identity;
}

export function getCodeCollectionName(identity: CodebaseIdentity): string {
  const repositoryIdentity = identity.repositoryRemote || identity.codebasePath;
  const collectionIdentity = identity.branch
    ? `${repositoryIdentity}\0${identity.branch}`
    : repositoryIdentity;
  const hash = createHash("sha256").update(collectionIdentity).digest("hex");
  return `code_${hash.substring(0, 16)}`;
}
