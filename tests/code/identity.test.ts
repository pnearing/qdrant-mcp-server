import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCodeCollectionName,
  normalizeCodeRemoteUrl,
  resolveCodebaseIdentity,
  type CodebaseIdentity,
} from "../../src/code/identity.js";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

async function makeRepository(branch = "main"): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), "qdrant-code-identity-"));
  temporaryPaths.push(path);
  await execFileAsync("git", ["init", "-b", branch], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "tests@example.com"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "Tests"], { cwd: path });
  await fs.writeFile(join(path, "source.ts"), "export const value = 1;\n");
  await execFileAsync("git", ["add", "source.ts"], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: path });
  await execFileAsync("git", ["remote", "add", "origin", "git@forgejo.example:team/project.git"], {
    cwd: path,
  });
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => fs.rm(path, { recursive: true })));
});

describe("codebase identity", () => {
  it("normalizes common remote forms without dropping the host", () => {
    expect(normalizeCodeRemoteUrl("git@forgejo.example:team/project.git")).toBe(
      "forgejo.example/team/project"
    );
    expect(normalizeCodeRemoteUrl("https://forgejo.example/team/project.git")).toBe(
      "forgejo.example/team/project"
    );
    expect(normalizeCodeRemoteUrl("ssh://git@forgejo.example/team/project.git")).toBe(
      "forgejo.example/team/project"
    );
  });

  it("uses the same remote and branch independent of physical path", () => {
    const first: CodebaseIdentity = {
      repositoryRemote: "forgejo.example/team/project",
      branch: "main",
      codebasePath: "/first/worktree",
    };
    const second = { ...first, codebasePath: "/second/worktree" };
    expect(getCodeCollectionName(first)).toBe(getCodeCollectionName(second));
  });

  it("isolates different branches of the same remote", () => {
    const main: CodebaseIdentity = {
      repositoryRemote: "forgejo.example/team/project",
      branch: "main",
      codebasePath: "/worktree/main",
    };
    expect(getCodeCollectionName(main)).not.toBe(
      getCodeCollectionName({ ...main, branch: "feature/test" })
    );
  });

  it("isolates different remotes on the same branch", () => {
    const first: CodebaseIdentity = {
      repositoryRemote: "forgejo.example/team/first",
      branch: "main",
      codebasePath: "/worktree",
    };
    expect(getCodeCollectionName(first)).not.toBe(
      getCodeCollectionName({
        ...first,
        repositoryRemote: "forgejo.example/team/second",
      })
    );
  });

  it("uses deterministic SHA-256 path identity for non-Git directories", async () => {
    const path = await fs.mkdtemp(join(tmpdir(), "qdrant-non-git-"));
    temporaryPaths.push(path);
    const identity = await resolveCodebaseIdentity(path);
    expect(identity).toEqual({ codebasePath: path });
    expect(getCodeCollectionName(identity)).toMatch(/^code_[0-9a-f]{16}$/);
    expect(getCodeCollectionName(identity)).toBe(getCodeCollectionName(identity));
  });

  it("detects normalized remote, branch, and commit", async () => {
    const path = await makeRepository("feature/test");
    const identity = await resolveCodebaseIdentity(path);
    expect(identity.repositoryRemote).toBe("forgejo.example/team/project");
    expect(identity.branch).toBe("feature/test");
    expect(identity.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("uses a deterministic detached identity", async () => {
    const path = await makeRepository();
    await execFileAsync("git", ["checkout", "--detach"], { cwd: path });
    const identity = await resolveCodebaseIdentity(path);
    expect(identity.branch).toBe(`detached/${identity.commit?.substring(0, 12)}`);
    expect(getCodeCollectionName(identity)).toBe(getCodeCollectionName(identity));
  });
});
