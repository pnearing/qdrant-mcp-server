import { describe, expect, it, vi } from "vitest";
import { SnapshotSaveError } from "../code/sync/snapshot.js";
import { formatCodeSearchResults, registerCodeTools } from "./code.js";

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

describe("registerCodeTools", () => {
  it("propagates snapshot persistence failures through the MCP tool handler", async () => {
    const snapshotPath = "/data/.qdrant-mcp/snapshots/code_test.json";
    const permissionError = Object.assign(
      new Error("EACCES: permission denied, mkdir '/data/.qdrant-mcp'"),
      { code: "EACCES", path: snapshotPath }
    );
    const snapshotError = new SnapshotSaveError(snapshotPath, permissionError);
    const mockServer = { registerTool: vi.fn() };
    const codeIndexer = {
      getIndexTarget: vi.fn().mockResolvedValue("code:test"),
      indexCodebase: vi.fn().mockRejectedValue(snapshotError),
    };
    let terminalJob: any;
    const jobManager = {
      submit: vi.fn(async (request) => {
        try {
          await request.run(vi.fn());
        } catch (error) {
          terminalJob = {
            jobId: "job-1",
            operationId: request.operationId,
            operation: request.operation,
            path: request.path,
            target: request.target,
            state: "failed",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            progress: null,
            result: null,
            error: { name: "SnapshotSaveError", message: (error as Error).message, code: "EACCES" },
          };
        }
        return { accepted: true, deduplicated: false, job: terminalJob };
      }),
      waitForTerminal: vi.fn(async () => terminalJob),
    };

    registerCodeTools(mockServer as any, {
      codeIndexer: codeIndexer as any,
      jobManager: jobManager as any,
    });
    const registration = mockServer.registerTool.mock.calls.find(
      ([name]) => name === "index_codebase"
    );
    expect(registration).toBeDefined();

    const handler = registration?.[2];
    const result = await handler(
        { path: "/sources/repository", forceReindex: false },
        { _meta: {}, sendNotification: vi.fn() }
      );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        job: { state: "failed", error: { code: "EACCES" } },
      },
    });
  });
});
