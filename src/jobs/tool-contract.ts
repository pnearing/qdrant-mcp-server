import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  IndexJobError,
  IndexJobProgress,
  IndexJobRecord,
  SubmitIndexJobResult,
} from "./index-job-manager.js";
import type { IndexJobManager, SubmitIndexJobRequest } from "./index-job-manager.js";

export interface PublicIndexJobRecord {
  jobId: string;
  operationId: string;
  operation: string;
  path: string;
  sourceRevision?: string;
  state: string;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  completedAt: string | null;
  progress: IndexJobProgress | null;
  result: unknown | null;
  error: IndexJobError | null;
}

export function publicJob(job: IndexJobRecord): PublicIndexJobRecord {
  const { target: _target, requestFingerprint: _requestFingerprint, ...record } = job;
  return record;
}

export function indexJobRequestFingerprint(
  operation: string,
  request: {
    path: string;
    target: string;
    sourceRevision?: string;
    options?: Record<string, unknown>;
  }
): string {
  const canonical = canonicalize({
    operation,
    path: resolve(request.path),
    target: request.target,
    sourceRevision: request.sourceRevision ?? null,
    options: request.options ?? {},
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function startJobResult(result: SubmitIndexJobResult): CallToolResult {
  const structuredContent = result.accepted
    ? {
        accepted: true,
        deduplicated: result.deduplicated,
        job: publicJob(result.job),
      }
    : {
        accepted: false,
        deduplicated: false,
        reason: result.reason,
        job: publicJob(result.job),
      };
  const text = result.accepted
    ? result.deduplicated
      ? `Index job ${result.job.jobId} already exists (${result.job.state}).`
      : `Index job ${result.job.jobId} accepted and queued.`
    : result.reason === "operation_id_conflict"
      ? `Operation ID ${result.job.operationId} is already bound to a different indexing request.`
      : `Index target is busy with job ${result.job.jobId} (${result.job.state}).`;
  return { content: [{ type: "text", text }], structuredContent };
}

export function statusJobResult(job: IndexJobRecord): CallToolResult {
  const structuredContent = publicJob(job);
  return {
    content: [
      {
        type: "text",
        text: `Index job ${job.jobId}: ${job.state}${job.progress ? ` — ${job.progress.message}` : ""}`,
      },
    ],
    structuredContent: { ...structuredContent },
  };
}

export async function runBlockingJob(
  manager: IndexJobManager,
  request: SubmitIndexJobRequest & { requestFingerprint: string }
): Promise<IndexJobRecord | CallToolResult> {
  const submitted = await manager.submit({ ...request, joinActiveOperation: true });
  if (!submitted.accepted) return startJobResult(submitted);
  const terminal = await manager.waitForTerminal(submitted.job.jobId);
  if (terminal.state === "failed" || terminal.state === "stale" || terminal.state === "cancelled") {
    return {
      content: [
        {
          type: "text",
          text: `Index job ${terminal.jobId} ${terminal.state}: ${terminal.error?.message ?? "No error details available"}`,
        },
      ],
      structuredContent: { job: publicJob(terminal) },
      isError: true,
    };
  }
  return terminal;
}
