import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexJobManager } from "../jobs/index-job-manager.js";
import { registerCodeTools } from "./code.js";
import { registerGitHistoryTools } from "./git-history.js";
import { registerIndexJobTools } from "./index-jobs.js";

describe("durable index-job MCP tools", () => {
  let directory: string;
  let manager: IndexJobManager;
  let server: McpServer;
  let client: Client;
  let codeIndexer: any;
  let gitHistoryIndexer: any;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "qdrant-job-tools-"));
    manager = new IndexJobManager(join(directory, "jobs.json"), 10);
    await manager.initialize();
    codeIndexer = {
      getIndexTarget: vi.fn(async (path: string) => `code:${path}`),
      indexCodebase: vi.fn(async () => ({
        filesScanned: 1,
        filesIndexed: 1,
        chunksCreated: 1,
        durationMs: 1,
        status: "completed",
      })),
      reindexChanges: vi.fn(async () => ({
        filesAdded: 0,
        filesModified: 0,
        filesDeleted: 0,
        chunksAdded: 0,
        chunksDeleted: 0,
        durationMs: 1,
      })),
      getIndexStatus: vi.fn(async () => ({ isIndexed: false, status: "not_indexed" })),
      clearIndex: vi.fn(async () => undefined),
      searchCode: vi.fn(),
    };
    gitHistoryIndexer = {
      getIndexTarget: vi.fn(async (path: string) => `git:${path}`),
      indexHistory: vi.fn(async () => ({
        commitsScanned: 1,
        commitsIndexed: 1,
        chunksCreated: 1,
        durationMs: 1,
        status: "completed",
      })),
      indexNewCommits: vi.fn(async () => ({ newCommits: 0, chunksAdded: 0, durationMs: 1 })),
      getIndexStatus: vi.fn(async () => ({ isIndexed: false, status: "not_indexed" })),
      clearIndex: vi.fn(async () => undefined),
      searchHistory: vi.fn(),
    };

    server = new McpServer({ name: "job-test", version: "1.0.0" });
    registerCodeTools(server, { codeIndexer, jobManager: manager });
    registerGitHistoryTools(server, { gitHistoryIndexer, jobManager: manager });
    registerIndexJobTools(server, manager);
    client = new Client({ name: "job-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("continues after the initiating MCP transport closes", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    codeIndexer.indexCodebase.mockImplementation(async (_path: string, _options: unknown, progress: any) => {
      progress({
        phase: "embedding",
        current: 5,
        total: 10,
        percentage: 50,
        message: "Generating embeddings 5/10",
      });
      await blocked;
      return { status: "completed" };
    });

    const response = await client.callTool({
      name: "start_index_codebase",
      arguments: { path: "/repo/a", operationId: "disconnect-test" },
    });
    const job = (response.structuredContent as any).job;
    expect(response.structuredContent).toMatchObject({ accepted: true, deduplicated: false });

    await vi.waitFor(async () => {
      expect(await manager.get(job.jobId)).toMatchObject({ state: "running" });
    });
    await client.close();
    await server.close();
    release();

    await expect(manager.waitForTerminal(job.jobId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(codeIndexer.indexCodebase).toHaveBeenCalledTimes(1);
  });

  it("deduplicates operation ids and returns target_busy for another operation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    codeIndexer.indexCodebase.mockImplementation(async () => {
      await blocked;
      return { status: "completed" };
    });

    const first = await client.callTool({
      name: "start_index_codebase",
      arguments: { path: "/repo/a", operationId: "same-operation" },
    });
    const duplicate = await client.callTool({
      name: "start_index_codebase",
      arguments: { path: "/repo/a", operationId: "same-operation" },
    });
    const busy = await client.callTool({
      name: "start_reindex_changes",
      arguments: { path: "/repo/a", operationId: "different-operation" },
    });

    expect(duplicate.structuredContent).toMatchObject({
      accepted: true,
      deduplicated: true,
      job: { jobId: (first.structuredContent as any).job.jobId },
    });
    expect(busy.structuredContent).toMatchObject({
      accepted: false,
      deduplicated: false,
      reason: "target_busy",
    });
    expect(codeIndexer.indexCodebase).toHaveBeenCalledTimes(1);
    release();
    await manager.waitForTerminal((first.structuredContent as any).job.jobId);
  });

  it("returns operation_id_conflict when an async operation id is reused for new options", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    codeIndexer.indexCodebase.mockImplementation(async () => {
      await blocked;
      return {
        filesScanned: 1,
        filesIndexed: 1,
        chunksCreated: 1,
        durationMs: 1,
        status: "completed",
      };
    });

    const first = await client.callTool({
      name: "start_index_codebase",
      arguments: {
        path: "/repo/a",
        operationId: "immutable-async-id",
        sourceRevision: "abc123",
        extensions: [".ts", ".js"],
      },
    });
    const conflict = await client.callTool({
      name: "start_index_codebase",
      arguments: {
        path: "/repo/a",
        operationId: "immutable-async-id",
        sourceRevision: "def456",
        extensions: [".py"],
      },
    });

    expect(conflict.structuredContent).toMatchObject({
      accepted: false,
      deduplicated: false,
      reason: "operation_id_conflict",
      job: {
        jobId: (first.structuredContent as any).job.jobId,
        operationId: "immutable-async-id",
      },
    });
    expect(codeIndexer.indexCodebase).toHaveBeenCalledTimes(1);
    release();
    await manager.waitForTerminal((first.structuredContent as any).job.jobId);
  });

  it("exposes progress and explicit structured status", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    codeIndexer.indexCodebase.mockImplementation(async (_path: string, _options: unknown, progress: any) => {
      progress({
        phase: "storing",
        current: 9,
        total: 10,
        percentage: 90,
        message: "Storing chunks 9/10",
      });
      await blocked;
      return { status: "completed" };
    });
    const started = await client.callTool({
      name: "start_index_codebase",
      arguments: { path: "/repo/a", operationId: "status-test", sourceRevision: "abc123" },
    });
    const jobId = (started.structuredContent as any).job.jobId;

    await vi.waitFor(async () => {
      const response = await client.callTool({
        name: "get_index_job_status",
        arguments: { jobId },
      });
      expect(response.structuredContent).toMatchObject({
        state: "running",
        sourceRevision: "abc123",
        heartbeatAt: expect.any(String),
        progress: { phase: "storing", percentage: 90 },
      });
    });

    const indexStatus = await client.callTool({
      name: "get_index_status",
      arguments: { path: "/repo/a" },
    });
    expect(indexStatus.structuredContent).toMatchObject({
      status: "indexing",
      activeOrRecentJob: { jobId, state: "running" },
    });
    release();
    await manager.waitForTerminal(jobId);
  });

  it("reports failed jobs as an explicit structured index state", async () => {
    codeIndexer.indexCodebase.mockRejectedValue(new Error("Embedding service unavailable"));
    const started = await client.callTool({
      name: "start_index_codebase",
      arguments: { path: "/repo/a", operationId: "failed-status" },
    });
    const jobId = (started.structuredContent as any).job.jobId;
    await manager.waitForTerminal(jobId);

    const status = await client.callTool({
      name: "get_index_status",
      arguments: { path: "/repo/a" },
    });
    expect(status.structuredContent).toMatchObject({
      status: "failed",
      activeOrRecentJob: {
        jobId,
        state: "failed",
        error: { message: "Embedding service unavailable" },
      },
    });
  });

  it("prevents legacy retries and clear operations from racing an active job", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    codeIndexer.indexCodebase.mockImplementation(async () => {
      await blocked;
      return {
        filesScanned: 1,
        filesIndexed: 1,
        chunksCreated: 1,
        durationMs: 1,
        status: "completed",
      };
    });

    const first = client.callTool({
      name: "index_codebase",
      arguments: { path: "/repo/a" },
    });
    await vi.waitFor(() => expect(codeIndexer.indexCodebase).toHaveBeenCalledTimes(1));
    const retry = client.callTool({
      name: "index_codebase",
      arguments: { path: "/repo/a" },
    });
    const clear = await client.callTool({ name: "clear_index", arguments: { path: "/repo/a" } });

    expect(clear.structuredContent).toMatchObject({ accepted: false, reason: "target_busy" });
    expect(codeIndexer.clearIndex).not.toHaveBeenCalled();
    expect(codeIndexer.indexCodebase).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, retry]);
    expect(codeIndexer.indexCodebase).toHaveBeenCalledTimes(1);
  });

  it("returns target_busy when legacy Git indexing options differ", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    gitHistoryIndexer.indexHistory.mockImplementation(async () => {
      await blocked;
      return {
        commitsScanned: 1,
        commitsIndexed: 1,
        chunksCreated: 1,
        durationMs: 1,
        status: "completed",
      };
    });

    const first = client.callTool({
      name: "index_git_history",
      arguments: { path: "/repo/a", maxCommits: 25 },
    });
    await vi.waitFor(() => expect(gitHistoryIndexer.indexHistory).toHaveBeenCalledTimes(1));
    const different = await client.callTool({
      name: "index_git_history",
      arguments: { path: "/repo/a", maxCommits: 50 },
    });

    expect(different.structuredContent).toMatchObject({
      accepted: false,
      deduplicated: false,
      reason: "target_busy",
    });
    expect(gitHistoryIndexer.indexHistory).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("registers both asynchronous Git-history operations", async () => {
    const full = await client.callTool({
      name: "start_index_git_history",
      arguments: { path: "/repo/a", operationId: "git-full", maxCommits: 25 },
    });
    await manager.waitForTerminal((full.structuredContent as any).job.jobId);
    const incremental = await client.callTool({
      name: "start_index_new_commits",
      arguments: { path: "/repo/a", operationId: "git-incremental" },
    });
    await manager.waitForTerminal((incremental.structuredContent as any).job.jobId);

    expect(gitHistoryIndexer.indexHistory).toHaveBeenCalledWith(
      "/repo/a",
      expect.objectContaining({ maxCommits: 25 }),
      expect.any(Function)
    );
    expect(gitHistoryIndexer.indexNewCommits).toHaveBeenCalledTimes(1);
  });
});
