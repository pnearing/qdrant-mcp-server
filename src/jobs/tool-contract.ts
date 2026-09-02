import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
  options: Record<string, unknown> = {}
): string {
  const normalized = Object.fromEntries(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return JSON.stringify({ operation, options: normalized });
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
        reason: "target_busy",
        job: publicJob(result.job),
      };
  const text = result.accepted
    ? result.deduplicated
      ? `Index job ${result.job.jobId} already exists (${result.job.state}).`
      : `Index job ${result.job.jobId} accepted and queued.`
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
