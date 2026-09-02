import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultIndexJobStorePath, IndexJobManager } from "./index-job-manager.js";

describe("IndexJobManager", () => {
  let directory: string;
  let storePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "qdrant-index-jobs-"));
    storePath = join(directory, "jobs.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("defaults to the persistent MCP state volume and permits an explicit override", () => {
    const original = process.env.INDEX_JOB_STORE_PATH;
    try {
      delete process.env.INDEX_JOB_STORE_PATH;
      expect(defaultIndexJobStorePath()).toBe("/data/jobs/index-jobs.json");

      process.env.INDEX_JOB_STORE_PATH = "/custom/jobs.json";
      expect(defaultIndexJobStorePath()).toBe("/custom/jobs.json");
    } finally {
      if (original === undefined) delete process.env.INDEX_JOB_STORE_PATH;
      else process.env.INDEX_JOB_STORE_PATH = original;
    }
  });

  it("creates the jobs directory before persisting the first job", async () => {
    const nestedStorePath = join(directory, "data", "jobs", "index-jobs.json");
    const manager = new IndexJobManager(nestedStorePath);
    await manager.initialize();

    const submitted = await manager.submit({
      operationId: "directory-creation",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run: async () => ({ indexed: true }),
    });
    await manager.waitForTerminal(submitted.job.jobId);

    expect((await fs.stat(join(directory, "data", "jobs"))).isDirectory()).toBe(true);
    const persisted = JSON.parse(await fs.readFile(nestedStorePath, "utf-8"));
    expect(persisted.jobs[0]).toMatchObject({
      operationId: "directory-creation",
      state: "completed",
    });
  });

  it("returns immediately and records progress before completing", async () => {
    const manager = new IndexJobManager(storePath, 10);
    await manager.initialize();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const submitted = await manager.submit({
      operationId: "operation-1",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run: async (progress) => {
        progress({
          phase: "embedding",
          current: 2,
          total: 10,
          percentage: 20,
          message: "Generating embeddings 2/10",
        });
        await blocked;
        return { indexed: true };
      },
    });

    expect(submitted).toMatchObject({ accepted: true, deduplicated: false });
    await vi.waitFor(async () => {
      expect(await manager.get(submitted.job.jobId)).toMatchObject({
        state: "running",
        progress: { phase: "embedding", current: 2 },
      });
    });

    release();
    await expect(manager.waitForTerminal(submitted.job.jobId)).resolves.toMatchObject({
      state: "completed",
      result: { indexed: true },
    });
  });

  it("deduplicates operation ids and serializes the same target", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => blocked);

    const first = await manager.submit({
      operationId: "same-id",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run,
    });
    const duplicate = await manager.submit({
      operationId: "same-id",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run,
    });
    const busy = await manager.submit({
      operationId: "different-id",
      operation: "reindex_changes",
      path: "/repo/a",
      target: "code:a",
      run,
    });

    expect(duplicate).toMatchObject({ accepted: true, deduplicated: true });
    expect(duplicate.job.jobId).toBe(first.job.jobId);
    expect(busy).toMatchObject({ accepted: false, reason: "target_busy" });
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await manager.waitForTerminal(first.job.jobId);
  });

  it("runs different targets independently", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async () => {
      active++;
      peak = Math.max(peak, active);
      await blocked;
      active--;
    };

    const first = await manager.submit({
      operationId: "one",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run,
    });
    const second = await manager.submit({
      operationId: "two",
      operation: "index_codebase",
      path: "/repo/b",
      target: "code:b",
      run,
    });
    await vi.waitFor(() => expect(peak).toBe(2));
    release();
    await Promise.all([
      manager.waitForTerminal(first.job.jobId),
      manager.waitForTerminal(second.job.jobId),
    ]);
  });

  it("records failures without producing an unhandled rejection", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      const submitted = await manager.submit({
        operationId: "failure",
        operation: "index_git_history",
        path: "/repo/a",
        target: "git:a",
        run: async () => {
          throw Object.assign(new Error("Qdrant write failed"), { code: "ECONNRESET" });
        },
      });

      await expect(manager.waitForTerminal(submitted.job.jobId)).resolves.toMatchObject({
        state: "failed",
        error: { message: "Qdrant write failed", code: "ECONNRESET" },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("marks queued and running records stale after restart", async () => {
    const createdAt = new Date().toISOString();
    await fs.writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            jobId: "interrupted",
            operationId: "restart-id",
            operation: "index_codebase",
            path: "/repo/a",
            target: "code:a",
            state: "running",
            createdAt,
            startedAt: createdAt,
            heartbeatAt: createdAt,
            completedAt: null,
            progress: null,
            result: null,
            error: null,
          },
        ],
      })
    );

    const restarted = new IndexJobManager(storePath);
    await restarted.initialize();

    expect(await restarted.get("interrupted")).toMatchObject({
      state: "stale",
      error: { name: "StaleIndexJobError" },
    });
    const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
    expect(persisted.jobs[0].state).toBe("stale");
  });
});
