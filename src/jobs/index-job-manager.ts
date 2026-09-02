import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import logger from "../logger.js";

const log = logger.child({ component: "index-job-manager" });

export const INDEX_JOB_OPERATIONS = [
  "index_codebase",
  "reindex_changes",
  "index_git_history",
  "index_new_commits",
  "clear_index",
  "clear_git_index",
] as const;

export const INDEX_JOB_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "stale",
] as const;

export type IndexJobOperation = (typeof INDEX_JOB_OPERATIONS)[number];
export type IndexJobState = (typeof INDEX_JOB_STATES)[number];

export interface IndexJobProgress {
  phase: string;
  current: number;
  total: number;
  percentage: number;
  message: string;
}

export interface IndexJobError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface IndexJobRecord {
  jobId: string;
  operationId: string;
  operation: IndexJobOperation;
  path: string;
  target: string;
  requestFingerprint?: string;
  sourceRevision?: string;
  state: IndexJobState;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  completedAt: string | null;
  progress: IndexJobProgress | null;
  result: unknown | null;
  error: IndexJobError | null;
}

export interface SubmitIndexJobRequest {
  operationId: string;
  operation: IndexJobOperation;
  path: string;
  target: string;
  requestFingerprint?: string;
  sourceRevision?: string;
  run: (updateProgress: (progress: IndexJobProgress) => void) => Promise<unknown>;
  joinActiveOperation?: boolean;
}

export type SubmitIndexJobResult =
  | { accepted: true; deduplicated: boolean; job: IndexJobRecord }
  | {
      accepted: false;
      deduplicated: false;
      reason: "target_busy";
      job: IndexJobRecord;
    };

interface PersistedJobs {
  version: 1;
  jobs: IndexJobRecord[];
}

const TERMINAL_STATES = new Set<IndexJobState>(["completed", "failed", "cancelled", "stale"]);

export function defaultIndexJobStorePath(): string {
  return process.env.INDEX_JOB_STORE_PATH || "/data/jobs/index-jobs.json";
}

export class IndexJobManager {
  private readonly jobs = new Map<string, IndexJobRecord>();
  private readonly jobsByOperationId = new Map<string, string>();
  private readonly activeJobsByTarget = new Map<string, string>();
  private readonly waiters = new Map<string, Array<(job: IndexJobRecord) => void>>();
  private serialization: Promise<void> = Promise.resolve();

  constructor(
    private readonly storePath = defaultIndexJobStorePath(),
    private readonly heartbeatIntervalMs = 5_000
  ) {}

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      let persisted: PersistedJobs | null = null;
      try {
        persisted = JSON.parse(await fs.readFile(this.storePath, "utf-8")) as PersistedJobs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      let changed = false;
      for (const record of persisted?.jobs ?? []) {
        const job = this.clone(record);
        if (job.state === "queued" || job.state === "running") {
          const now = new Date().toISOString();
          job.state = "stale";
          job.completedAt = now;
          job.heartbeatAt = now;
          job.error = {
            name: "StaleIndexJobError",
            message: "Server restarted while the indexing job was active; execution state is unknown",
          };
          changed = true;
        }
        this.jobs.set(job.jobId, job);
        this.jobsByOperationId.set(job.operationId, job.jobId);
      }

      if (changed) await this.persist();
    });
  }

  async submit(request: SubmitIndexJobRequest): Promise<SubmitIndexJobResult> {
    const result = await this.serialized(async () => {
      const duplicateId = this.jobsByOperationId.get(request.operationId);
      if (duplicateId) {
        return {
          accepted: true as const,
          deduplicated: true,
          job: this.clone(this.jobs.get(duplicateId)!),
        };
      }

      const activeId = this.activeJobsByTarget.get(request.target);
      if (activeId) {
        const activeJob = this.jobs.get(activeId)!;
        if (
          request.joinActiveOperation &&
          activeJob.operation === request.operation &&
          request.requestFingerprint !== undefined &&
          activeJob.requestFingerprint === request.requestFingerprint
        ) {
          return { accepted: true as const, deduplicated: true, job: this.clone(activeJob) };
        }
        return {
          accepted: false as const,
          deduplicated: false as const,
          reason: "target_busy" as const,
          job: this.clone(activeJob),
        };
      }

      const createdAt = new Date().toISOString();
      const job: IndexJobRecord = {
        jobId: randomUUID(),
        operationId: request.operationId,
        operation: request.operation,
        path: request.path,
        target: request.target,
        ...(request.requestFingerprint && { requestFingerprint: request.requestFingerprint }),
        ...(request.sourceRevision && { sourceRevision: request.sourceRevision }),
        state: "queued",
        createdAt,
        completedAt: null,
        progress: null,
        result: null,
        error: null,
      };

      this.jobs.set(job.jobId, job);
      this.jobsByOperationId.set(job.operationId, job.jobId);
      this.activeJobsByTarget.set(job.target, job.jobId);
      await this.persist();
      return { accepted: true as const, deduplicated: false, job: this.clone(job) };
    });

    if (result.accepted && !result.deduplicated) {
      queueMicrotask(() => {
        void this.run(result.job.jobId, request.run).catch((error) => {
          log.fatal({ jobId: result.job.jobId, err: error }, "Unexpected job-runner failure");
        });
      });
    }
    return result;
  }

  async get(jobId: string): Promise<IndexJobRecord | null> {
    return this.serialized(async () => {
      const job = this.jobs.get(jobId);
      return job ? this.clone(job) : null;
    });
  }

  async getActiveForTarget(target: string): Promise<IndexJobRecord | null> {
    return this.serialized(async () => {
      const jobId = this.activeJobsByTarget.get(target);
      return jobId ? this.clone(this.jobs.get(jobId)!) : null;
    });
  }

  async getMostRecentForTarget(target: string): Promise<IndexJobRecord | null> {
    return this.serialized(async () => {
      const jobs = [...this.jobs.values()].filter((job) => job.target === target);
      const mostRecent = jobs.at(-1);
      return mostRecent ? this.clone(mostRecent) : null;
    });
  }

  async waitForTerminal(jobId: string): Promise<IndexJobRecord> {
    const current = await this.get(jobId);
    if (!current) throw new Error(`Index job not found: ${jobId}`);
    if (TERMINAL_STATES.has(current.state)) return current;
    return new Promise((resolve) => {
      const waiters = this.waiters.get(jobId) ?? [];
      waiters.push(resolve);
      this.waiters.set(jobId, waiters);
    });
  }

  private async run(
    jobId: string,
    executor: SubmitIndexJobRequest["run"]
  ): Promise<void> {
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await this.serialized(async () => {
        const job = this.jobs.get(jobId)!;
        const now = new Date().toISOString();
        job.state = "running";
        job.startedAt = now;
        job.heartbeatAt = now;
        await this.persist();
      });

      heartbeat = setInterval(() => {
        void this.updateHeartbeat(jobId).catch((error) => {
          log.error({ jobId, err: error }, "Failed to persist index-job heartbeat");
        });
      }, this.heartbeatIntervalMs);
      heartbeat.unref();

      const result = await executor((progress) => {
        void this.updateProgress(jobId, progress).catch((error) => {
          log.error({ jobId, err: error }, "Failed to persist index-job progress");
        });
      });

      await this.finish(jobId, "completed", result, null);
    } catch (error) {
      await this.finish(jobId, "failed", null, this.serializeError(error)).catch(
        (persistenceError) => {
          log.fatal(
            { jobId, err: persistenceError, jobError: error },
            "Failed to persist terminal index-job failure"
          );
        }
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  private async updateHeartbeat(jobId: string): Promise<void> {
    await this.serialized(async () => {
      const job = this.jobs.get(jobId);
      if (!job || job.state !== "running") return;
      job.heartbeatAt = new Date().toISOString();
      await this.persist();
    });
  }

  private async updateProgress(jobId: string, progress: IndexJobProgress): Promise<void> {
    await this.serialized(async () => {
      const job = this.jobs.get(jobId);
      if (!job || job.state !== "running") return;
      job.progress = { ...progress };
      job.heartbeatAt = new Date().toISOString();
      await this.persist();
    });
  }

  private async finish(
    jobId: string,
    state: "completed" | "failed",
    result: unknown | null,
    error: IndexJobError | null
  ): Promise<void> {
    let completed: IndexJobRecord | null = null;
    await this.serialized(async () => {
      const job = this.jobs.get(jobId);
      if (!job || TERMINAL_STATES.has(job.state)) return;
      const now = new Date().toISOString();
      job.state = state;
      job.completedAt = now;
      job.heartbeatAt = now;
      job.result = result ?? null;
      job.error = error;
      this.activeJobsByTarget.delete(job.target);
      await this.persist();
      completed = this.clone(job);
    });

    if (completed) {
      for (const resolve of this.waiters.get(jobId) ?? []) resolve(completed);
      this.waiters.delete(jobId);
    }
  }

  private serializeError(error: unknown): IndexJobError {
    if (!(error instanceof Error)) return { name: "Error", message: String(error) };
    const code = "code" in error && error.code !== undefined ? String(error.code) : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(code && { code }),
      ...(error.stack && { stack: error.stack }),
    };
  }

  private async persist(): Promise<void> {
    const payload: PersistedJobs = { version: 1, jobs: [...this.jobs.values()] };
    const tempPath = `${this.storePath}.tmp.${process.pid}.${randomUUID()}`;
    await fs.mkdir(dirname(this.storePath), { recursive: true });
    try {
      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
      await fs.rename(tempPath, this.storePath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serialization.then(operation, operation);
    this.serialization = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }
}
