import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INDEX_JOB_MAX_TERMINAL_RECORDS,
  DEFAULT_INDEX_JOB_TERMINAL_RETENTION_MS,
  defaultIndexJobStorePath,
  IndexJobManager,
  indexJobRetentionOptionsFromEnv,
  type IndexJobRecord,
} from "./index-job-manager.js";

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

  function terminalJob(
    jobId: string,
    completedAt: string,
    state: IndexJobRecord["state"] = "completed"
  ): IndexJobRecord {
    return {
      jobId,
      operationId: `operation-${jobId}`,
      operation: "index_codebase",
      path: `/repo/${jobId}`,
      target: `code:${jobId}`,
      state,
      createdAt: completedAt,
      heartbeatAt: completedAt,
      completedAt,
      progress: null,
      result: null,
      error: null,
    };
  }

  async function writeJobs(jobs: IndexJobRecord[]): Promise<void> {
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2));
  }

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

  it("uses bounded retention defaults and rejects invalid environment configuration", () => {
    const originalAge = process.env.INDEX_JOB_TERMINAL_RETENTION_MS;
    const originalMaximum = process.env.INDEX_JOB_MAX_TERMINAL_RECORDS;
    try {
      delete process.env.INDEX_JOB_TERMINAL_RETENTION_MS;
      delete process.env.INDEX_JOB_MAX_TERMINAL_RECORDS;
      expect(indexJobRetentionOptionsFromEnv()).toEqual({
        terminalRetentionMs: DEFAULT_INDEX_JOB_TERMINAL_RETENTION_MS,
        maxTerminalRecords: DEFAULT_INDEX_JOB_MAX_TERMINAL_RECORDS,
      });

      process.env.INDEX_JOB_TERMINAL_RETENTION_MS = "not-a-number";
      expect(() => new IndexJobManager(storePath)).toThrow(
        "INDEX_JOB_TERMINAL_RETENTION_MS must be a positive integer"
      );
      process.env.INDEX_JOB_TERMINAL_RETENTION_MS = "1000";
      process.env.INDEX_JOB_MAX_TERMINAL_RECORDS = "0";
      expect(() => new IndexJobManager(storePath)).toThrow(
        "INDEX_JOB_MAX_TERMINAL_RECORDS must be a positive integer"
      );
    } finally {
      if (originalAge === undefined) delete process.env.INDEX_JOB_TERMINAL_RETENTION_MS;
      else process.env.INDEX_JOB_TERMINAL_RETENTION_MS = originalAge;
      if (originalMaximum === undefined) delete process.env.INDEX_JOB_MAX_TERMINAL_RECORDS;
      else process.env.INDEX_JOB_MAX_TERMINAL_RECORDS = originalMaximum;
    }
  });

  it("prunes expired terminal jobs and cleans operation-id lookup across restarts", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    await writeJobs([
      terminalJob("expired", "2026-08-01T00:00:00.000Z"),
      terminalJob("recent", "2026-09-02T11:00:00.000Z", "failed"),
    ]);
    const manager = new IndexJobManager(storePath, 5_000, {
      terminalRetentionMs: 24 * 60 * 60 * 1_000,
      maxTerminalRecords: 10,
      now: () => now,
    });
    await manager.initialize();

    expect(await manager.get("expired")).toBeNull();
    expect(await manager.get("recent")).toMatchObject({ state: "failed" });
    const replacement = await manager.submit({
      operationId: "operation-expired",
      operation: "index_codebase",
      path: "/repo/replacement",
      target: "code:replacement",
      run: async () => ({ indexed: true }),
    });
    expect(replacement).toMatchObject({ accepted: true, deduplicated: false });
    await manager.waitForTerminal(replacement.job.jobId);

    const restarted = new IndexJobManager(storePath, 5_000, {
      terminalRetentionMs: 24 * 60 * 60 * 1_000,
      maxTerminalRecords: 10,
      now: () => now,
    });
    await restarted.initialize();
    expect(await restarted.get("expired")).toBeNull();
    expect(await restarted.get("recent")).not.toBeNull();
  });

  it("prunes the oldest terminal records first when the maximum is exceeded", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    await writeJobs([
      terminalJob("oldest", "2026-09-02T08:00:00.000Z", "cancelled"),
      terminalJob("middle", "2026-09-02T09:00:00.000Z", "stale"),
      terminalJob("newest", "2026-09-02T10:00:00.000Z"),
    ]);
    const manager = new IndexJobManager(storePath, 5_000, {
      terminalRetentionMs: 24 * 60 * 60 * 1_000,
      maxTerminalRecords: 2,
      now: () => now,
    });
    await manager.initialize();

    expect(await manager.get("oldest")).toBeNull();
    expect(await manager.get("middle")).not.toBeNull();
    expect(await manager.get("newest")).not.toBeNull();
  });

  it("never prunes active jobs or terminal jobs with registered waiters", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    await writeJobs([terminalJob("waiting", "2026-08-01T00:00:00.000Z")]);
    const manager = new IndexJobManager(storePath, 5_000, {
      terminalRetentionMs: 24 * 60 * 60 * 1_000,
      maxTerminalRecords: 1,
      now: () => now,
    });
    const waiters = (manager as unknown as {
      waiters: Map<string, Array<(job: IndexJobRecord) => void>>;
    }).waiters;
    waiters.set("waiting", [vi.fn()]);
    await manager.initialize();

    let release!: () => void;
    const active = await manager.submit({
      operationId: "active",
      operation: "index_codebase",
      path: "/repo/active",
      target: "code:active",
      run: () => new Promise<void>((resolve) => (release = resolve)),
    });
    expect(await manager.get("waiting")).not.toBeNull();
    await vi.waitFor(async () => {
      expect(await manager.get(active.job.jobId)).toMatchObject({ state: "running" });
    });

    await manager.submit({
      operationId: "other",
      operation: "index_codebase",
      path: "/repo/other",
      target: "code:other",
      run: async () => ({ indexed: true }),
    });
    expect(await manager.get(active.job.jobId)).toMatchObject({ state: "running" });
    expect(await manager.get("waiting")).not.toBeNull();
    const terminal = manager.waitForTerminal(active.job.jobId);
    release();
    await terminal;
    await manager.get("waiting");
  });

  it("leaves the previous valid store intact when pruning persistence fails", async () => {
    const originalJobs = [terminalJob("expired", "2026-08-01T00:00:00.000Z")];
    await writeJobs(originalJobs);
    const previousStore = await fs.readFile(storePath, "utf-8");
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("Disk failure"), { code: "EIO" }));
    const manager = new IndexJobManager(storePath, 5_000, {
      terminalRetentionMs: 24 * 60 * 60 * 1_000,
      maxTerminalRecords: 10,
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });

    await expect(manager.initialize()).rejects.toMatchObject({ code: "EIO" });
    expect(await fs.readFile(storePath, "utf-8")).toBe(previousStore);
    expect(await manager.get("expired")).not.toBeNull();
    rename.mockRestore();
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

  it("rejects reuse of an operation id for a different request fingerprint", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await manager.submit({
      operationId: "immutable-request",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      sourceRevision: "abc123",
      requestFingerprint: "fingerprint-a",
      run: async () => blocked,
    });
    const conflict = await manager.submit({
      operationId: "immutable-request",
      operation: "index_codebase",
      path: "/repo/b",
      target: "code:b",
      sourceRevision: "def456",
      requestFingerprint: "fingerprint-b",
      run: async () => undefined,
    });

    expect(conflict).toMatchObject({
      accepted: false,
      deduplicated: false,
      reason: "operation_id_conflict",
      job: { jobId: first.job.jobId, operationId: "immutable-request" },
    });
    release();
    await manager.waitForTerminal(first.job.jobId);
  });

  it("joins only active legacy requests with the same request fingerprint", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => blocked);

    const first = await manager.submit({
      operationId: "first",
      operation: "index_git_history",
      path: "/repo/a",
      target: "git:a",
      requestFingerprint: "maxCommits=25",
      joinActiveOperation: true,
      run,
    });
    const matching = await manager.submit({
      operationId: "matching",
      operation: "index_git_history",
      path: "/repo/a",
      target: "git:a",
      requestFingerprint: "maxCommits=25",
      joinActiveOperation: true,
      run,
    });
    const different = await manager.submit({
      operationId: "different",
      operation: "index_git_history",
      path: "/repo/a",
      target: "git:a",
      requestFingerprint: "maxCommits=50",
      joinActiveOperation: true,
      run,
    });

    expect(matching).toMatchObject({
      accepted: true,
      deduplicated: true,
      job: { jobId: first.job.jobId },
    });
    expect(different).toMatchObject({ accepted: false, reason: "target_busy" });
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

  it("does not lose completion triggered during terminal-waiter registration", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registrationHook = vi.fn(() => release());
    class RegistrationRaceManager extends IndexJobManager {
      protected override beforeTerminalWaiterRegistered(): void {
        registrationHook();
      }
    }
    const manager = new RegistrationRaceManager(storePath);
    await manager.initialize();
    const submitted = await manager.submit({
      operationId: "registration-race",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run: async () => {
        await blocked;
        return { indexed: true };
      },
    });
    await vi.waitFor(async () => {
      expect(await manager.get(submitted.job.jobId)).toMatchObject({ state: "running" });
    });

    await expect(manager.waitForTerminal(submitted.job.jobId)).resolves.toMatchObject({
      state: "completed",
      result: { indexed: true },
    });
    expect(registrationHook).toHaveBeenCalledOnce();
    expect(
      (manager as unknown as { waiters: Map<string, unknown> }).waiters.has(submitted.job.jobId)
    ).toBe(false);
  });

  it("resolves every concurrent terminal waiter exactly once and cleans them up", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitted = await manager.submit({
      operationId: "multiple-waiters",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run: async () => blocked,
    });
    const waiterOne = vi.fn();
    const waiterTwo = vi.fn();
    const first = manager.waitForTerminal(submitted.job.jobId).then(waiterOne);
    const second = manager.waitForTerminal(submitted.job.jobId).then(waiterTwo);
    release();
    await Promise.all([first, second]);

    expect(waiterOne).toHaveBeenCalledOnce();
    expect(waiterTwo).toHaveBeenCalledOnce();
    expect(
      (manager as unknown as { waiters: Map<string, unknown> }).waiters.has(submitted.job.jobId)
    ).toBe(false);
  });

  it("rejects terminal waits for unknown job ids", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    await expect(manager.waitForTerminal("missing")).rejects.toThrow(
      "Index job not found: missing"
    );
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

  it("rolls back registration when queued-job persistence fails", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    const persist = vi
      .spyOn(manager as unknown as { persist: () => Promise<void> }, "persist")
      .mockRejectedValueOnce(Object.assign(new Error("Disk unavailable"), { code: "EIO" }));
    const run = vi.fn(async () => ({ indexed: true }));

    await expect(
      manager.submit({
        operationId: "retryable-registration",
        operation: "index_codebase",
        path: "/repo/a",
        target: "code:a",
        run,
      })
    ).rejects.toMatchObject({ message: "Disk unavailable", code: "EIO" });
    expect(run).not.toHaveBeenCalled();
    expect(await manager.getActiveForTarget("code:a")).toBeNull();

    persist.mockRestore();
    const retry = await manager.submit({
      operationId: "retryable-registration",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run,
    });
    expect(retry).toMatchObject({ accepted: true, deduplicated: false });
    await expect(manager.waitForTerminal(retry.job.jobId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails and resolves waiters when terminal persistence remains unavailable", async () => {
    const manager = new IndexJobManager(storePath);
    await manager.initialize();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitted = await manager.submit({
      operationId: "terminal-persistence",
      operation: "index_codebase",
      path: "/repo/a",
      target: "code:a",
      run: async () => {
        await blocked;
        return { indexed: true };
      },
    });
    await vi.waitFor(async () => {
      expect(await manager.get(submitted.job.jobId)).toMatchObject({ state: "running" });
    });

    const persist = vi
      .spyOn(manager as unknown as { persist: () => Promise<void> }, "persist")
      .mockRejectedValue(Object.assign(new Error("No space left on device"), { code: "ENOSPC" }));
    const terminal = manager.waitForTerminal(submitted.job.jobId);
    release();

    await expect(terminal).resolves.toMatchObject({
      state: "failed",
      result: null,
      error: {
        name: "IndexJobPersistenceError",
        code: "ENOSPC",
        message: expect.stringContaining("No space left on device"),
      },
    });
    expect(await manager.getActiveForTarget("code:a")).toBeNull();
    expect(persist).toHaveBeenCalledTimes(2);
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
