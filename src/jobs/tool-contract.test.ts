import { describe, expect, it } from "vitest";
import { indexJobRequestFingerprint } from "./tool-contract.js";

describe("indexJobRequestFingerprint", () => {
  const base = {
    path: "/repo/a",
    target: "code:a",
    sourceRevision: "abc123",
    options: {
      forceReindex: false,
      extensions: [".ts", ".js"],
      ignorePatterns: ["dist/**", "node_modules/**"],
    },
  };

  it.each([
    ["path", "index_codebase", { ...base, path: "/repo/b" }],
    ["target", "index_codebase", { ...base, target: "code:b" }],
    ["operation", "reindex_changes", base],
    ["source revision", "index_codebase", { ...base, sourceRevision: "def456" }],
    [
      "code-indexing options",
      "index_codebase",
      { ...base, options: { ...base.options, forceReindex: true } },
    ],
    [
      "Git-history options",
      "index_git_history",
      {
        ...base,
        target: "git:a",
        options: { forceReindex: false, sinceDate: "2026-01-01", maxCommits: 25 },
      },
    ],
  ])("changes when the %s changes", (_label, operation, request) => {
    const comparisonBase =
      operation === "index_git_history"
        ? indexJobRequestFingerprint("index_git_history", {
            ...base,
            target: "git:a",
            options: { forceReindex: false, sinceDate: "2025-01-01", maxCommits: 50 },
          })
        : indexJobRequestFingerprint("index_codebase", base);
    expect(indexJobRequestFingerprint(operation, request)).not.toBe(comparisonBase);
  });

  it("deduplicates reordered but otherwise identical options", () => {
    const reordered = indexJobRequestFingerprint("index_codebase", {
      ...base,
      options: {
        ignorePatterns: ["node_modules/**", "dist/**"],
        extensions: [".js", ".ts"],
        forceReindex: false,
      },
    });
    expect(reordered).toBe(indexJobRequestFingerprint("index_codebase", base));
  });
});
