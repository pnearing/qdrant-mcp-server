import { describe, expect, it } from "vitest";
import { formatCodeSearchResults } from "./code.js";

describe("formatCodeSearchResults", () => {
  it("identifies repository, branch, and abbreviated indexing commit", () => {
    const output = formatCodeSearchResults([
      {
        content: "export const value = 1;",
        filePath: "src/value.ts",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        score: 0.98765,
        fileExtension: ".ts",
        repositoryRemote: "forgejo.example/team/project",
        branch: "feature/test",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
    ]);

    expect(output).toContain("Repository: forgejo.example/team/project");
    expect(output).toContain("Branch: feature/test");
    expect(output).toContain("Commit: 0123456789ab");
    expect(output).toContain("File: src/value.ts:1-1");
  });

  it("keeps legacy non-Git results readable", () => {
    const output = formatCodeSearchResults([
      {
        content: "plain text",
        filePath: "file.txt",
        startLine: 1,
        endLine: 1,
        language: "unknown",
        score: 0.5,
        fileExtension: ".txt",
      },
    ]);

    expect(output).not.toContain("Repository:");
    expect(output).not.toContain("Branch:");
    expect(output).not.toContain("Commit:");
    expect(output).toContain("File: file.txt:1-1");
  });
});
