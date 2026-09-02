/**
 * Code indexing tools registration
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodeIndexer } from "../code/indexer.js";
import type { CodeSearchResult } from "../code/types.js";
import type { IndexJobManager } from "../jobs/index-job-manager.js";
import {
  indexJobRequestFingerprint,
  publicJob,
  runBlockingJob,
  startJobResult,
} from "../jobs/tool-contract.js";
import logger from "../logger.js";
import { withToolLogging } from "./logging.js";
import * as schemas from "./schemas.js";

const log = logger.child({ component: "tools" });

export interface CodeToolDependencies {
  codeIndexer: CodeIndexer;
  jobManager: IndexJobManager;
}

export function formatCodeSearchResults(results: CodeSearchResult[]): string {
  return results
    .map(
      (result, index) =>
        `\n--- Result ${index + 1} (score: ${result.score.toFixed(3)}) ---\n` +
        (result.repositoryRemote ? `Repository: ${result.repositoryRemote}\n` : "") +
        (result.branch ? `Branch: ${result.branch}\n` : "") +
        (result.commit ? `Commit: ${result.commit.substring(0, 12)}\n` : "") +
        `File: ${result.filePath}:${result.startLine}-${result.endLine}\n` +
        `Language: ${result.language}\n\n` +
        `${result.content}\n`
    )
    .join("\n");
}

export function registerCodeTools(server: McpServer, deps: CodeToolDependencies): void {
  const { codeIndexer, jobManager } = deps;

  // index_codebase
  server.registerTool(
    "index_codebase",
    {
      title: "Index Codebase",
      description:
        "Index a codebase for semantic code search. Automatically discovers files, chunks code intelligently using AST-aware parsing, and stores in vector database. Respects .gitignore and other ignore files.",
      inputSchema: schemas.IndexCodebaseSchema,
    },
    withToolLogging(
      "index_codebase",
      async ({ path, forceReindex, extensions, ignorePatterns }, extra) => {
        log.info({ tool: "index_codebase", path, forceReindex }, "Tool called");
        const progressToken = extra._meta?.progressToken;

        const target = await codeIndexer.getIndexTarget(path);
        const terminal = await runBlockingJob(jobManager, {
          operationId: `legacy:index_codebase:${randomUUID()}`,
          operation: "index_codebase",
          path,
          target,
          requestFingerprint: indexJobRequestFingerprint("index_codebase", {
            path,
            target,
            options: {
              forceReindex: forceReindex ?? false,
              extensions: extensions ?? null,
              ignorePatterns: ignorePatterns ?? null,
            },
          }),
          run: (updateProgress) =>
            codeIndexer.indexCodebase(
              path,
              { forceReindex, extensions, ignorePatterns },
              (progress) => {
                updateProgress(progress);
                log.debug(
                  { phase: progress.phase, percentage: progress.percentage },
                  progress.message
                );
                if (progressToken !== undefined) {
                  void extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: {
                        progressToken,
                        progress: progress.percentage,
                        total: 100,
                        message: `[${progress.phase}] ${progress.message}`,
                      },
                    })
                    .catch((error: unknown) => {
                      log.debug({ err: error }, "Progress recipient disconnected");
                    });
                }
              }
            ),
        });
        if (!("state" in terminal)) return terminal;
        const stats = terminal.result as Awaited<ReturnType<CodeIndexer["indexCodebase"]>>;

        let statusMessage = `Indexed ${stats.filesIndexed}/${stats.filesScanned} files (${stats.chunksCreated} chunks) in ${(stats.durationMs / 1000).toFixed(1)}s`;

        if (stats.status === "partial") {
          statusMessage += `\n\nWarnings:\n${stats.errors?.join("\n")}`;
        } else if (stats.status === "failed") {
          statusMessage = `Indexing failed:\n${stats.errors?.join("\n")}`;
        }

        return {
          content: [{ type: "text", text: statusMessage }],
          isError: stats.status === "failed",
        };
      }
    )
  );

  server.registerTool(
    "start_index_codebase",
    {
      title: "Start Codebase Index Job",
      description: "Schedule codebase indexing and return immediately with a durable job record.",
      inputSchema: schemas.StartIndexCodebaseSchema,
    },
    withToolLogging(
      "start_index_codebase",
      async ({ path, operationId, sourceRevision, forceReindex, extensions, ignorePatterns }) => {
        const target = await codeIndexer.getIndexTarget(path);
        const requestFingerprint = indexJobRequestFingerprint("index_codebase", {
          path,
          target,
          sourceRevision,
          options: {
            forceReindex: forceReindex ?? false,
            extensions: extensions ?? null,
            ignorePatterns: ignorePatterns ?? null,
          },
        });
        return startJobResult(
          await jobManager.submit({
            operationId,
            operation: "index_codebase",
            path,
            target,
            sourceRevision,
            requestFingerprint,
            run: (progress) =>
              codeIndexer.indexCodebase(path, { forceReindex, extensions, ignorePatterns }, progress),
          })
        );
      }
    )
  );

  // search_code
  server.registerTool(
    "search_code",
    {
      title: "Search Code",
      description:
        "Search indexed codebase using natural language queries. Returns semantically relevant code chunks with file paths and line numbers.",
      inputSchema: schemas.SearchCodeSchema,
    },
    withToolLogging("search_code", async ({ path, query, limit, fileTypes, pathPattern }) => {
      log.info({ tool: "search_code", path, query: query.substring(0, 80) }, "Tool called");
      const results = await codeIndexer.searchCode(path, query, {
        limit,
        fileTypes,
        pathPattern,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for query: "${query}"` }],
        };
      }

      // Format results with file references
      const formattedResults = formatCodeSearchResults(results);

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} result(s):\n${formattedResults}`,
          },
        ],
      };
    })
  );

  // reindex_changes
  server.registerTool(
    "reindex_changes",
    {
      title: "Reindex Changes",
      description:
        "Incrementally re-index only changed files. Detects added, modified, and deleted files since last index. Requires previous indexing with index_codebase.",
      inputSchema: schemas.ReindexChangesSchema,
    },
    withToolLogging("reindex_changes", async ({ path }, extra) => {
      log.info({ tool: "reindex_changes", path }, "Tool called");
      const progressToken = extra._meta?.progressToken;

      const target = await codeIndexer.getIndexTarget(path);
      const terminal = await runBlockingJob(jobManager, {
        operationId: `legacy:reindex_changes:${randomUUID()}`,
        operation: "reindex_changes",
        path,
        target,
        requestFingerprint: indexJobRequestFingerprint("reindex_changes", { path, target }),
        run: (updateProgress) =>
          codeIndexer.reindexChanges(path, (progress) => {
            updateProgress(progress);
            log.debug(
              { phase: progress.phase, percentage: progress.percentage },
              progress.message
            );
            if (progressToken !== undefined) {
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: progress.percentage,
                    total: 100,
                    message: `[${progress.phase}] ${progress.message}`,
                  },
                })
                .catch((error: unknown) => {
                  log.debug({ err: error }, "Progress recipient disconnected");
                });
            }
          }),
      });
      if (!("state" in terminal)) return terminal;
      const stats = terminal.result as Awaited<ReturnType<CodeIndexer["reindexChanges"]>>;

      let message = `Incremental re-index complete:\n`;
      message += `- Files added: ${stats.filesAdded}\n`;
      message += `- Files modified: ${stats.filesModified}\n`;
      message += `- Files deleted: ${stats.filesDeleted}\n`;
      message += `- Chunks added: ${stats.chunksAdded}\n`;
      message += `- Duration: ${(stats.durationMs / 1000).toFixed(1)}s`;

      if (stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0) {
        message = `No changes detected. Codebase is up to date.`;
      }

      return {
        content: [{ type: "text", text: message }],
      };
    })
  );

  server.registerTool(
    "start_reindex_changes",
    {
      title: "Start Incremental Code Index Job",
      description: "Schedule incremental code indexing and return immediately with a durable job record.",
      inputSchema: schemas.StartReindexChangesSchema,
    },
    withToolLogging(
      "start_reindex_changes",
      async ({ path, operationId, sourceRevision }) => {
        const target = await codeIndexer.getIndexTarget(path);
        const requestFingerprint = indexJobRequestFingerprint("reindex_changes", {
          path,
          target,
          sourceRevision,
        });
        return startJobResult(
          await jobManager.submit({
            operationId,
            operation: "reindex_changes",
            path,
            target,
            sourceRevision,
            requestFingerprint,
            run: (progress) => codeIndexer.reindexChanges(path, progress),
          })
        );
      }
    )
  );

  // get_index_status
  server.registerTool(
    "get_index_status",
    {
      title: "Get Index Status",
      description: "Get indexing status and statistics for a codebase.",
      inputSchema: schemas.GetIndexStatusSchema,
    },
    withToolLogging("get_index_status", async ({ path }) => {
      log.info({ tool: "get_index_status", path }, "Tool called");
      const status = await codeIndexer.getIndexStatus(path);
      const target = await codeIndexer.getIndexTarget(path);
      const job = await jobManager.getMostRecentForTarget(target);
      const effectiveStatus =
        job?.state === "queued" || job?.state === "running"
          ? "indexing"
          : job?.state === "failed" || job?.state === "stale"
            ? job.state
            : status.status;
      const structuredContent = {
        ...status,
        status: effectiveStatus,
        activeOrRecentJob: job ? publicJob(job) : null,
      };

      if (effectiveStatus === "not_indexed") {
        return {
          content: [
            {
              type: "text",
              text: `Codebase at "${path}" is not indexed. Use index_codebase to index it first.`,
            },
          ],
          structuredContent,
        };
      }

      if (effectiveStatus === "indexing") {
        return {
          content: [
            {
              type: "text",
              text: `Codebase at "${path}" is currently being indexed. ${status.chunksCount || 0} chunks processed so far.`,
            },
          ],
          structuredContent,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    })
  );

  // clear_index
  server.registerTool(
    "clear_index",
    {
      title: "Clear Index",
      description:
        "Delete all indexed data for a codebase. This is irreversible and will remove the entire collection.",
      inputSchema: schemas.ClearIndexSchema,
    },
    withToolLogging("clear_index", async ({ path }) => {
      log.info({ tool: "clear_index", path }, "Tool called");
      const target = await codeIndexer.getIndexTarget(path);
      const terminal = await runBlockingJob(jobManager, {
        operationId: `legacy:clear_index:${randomUUID()}`,
        operation: "clear_index",
        path,
        target,
        requestFingerprint: indexJobRequestFingerprint("clear_index", { path, target }),
        run: () => codeIndexer.clearIndex(path),
      });
      if (!("state" in terminal)) return terminal;
      return {
        content: [{ type: "text", text: `Index cleared for codebase at "${path}".` }],
      };
    })
  );
}
