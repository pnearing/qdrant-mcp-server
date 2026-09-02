/**
 * Git history indexing tools registration
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHistoryIndexer } from "../git/indexer.js";
import type { IndexJobManager } from "../jobs/index-job-manager.js";
import { publicJob, runBlockingJob, startJobResult } from "../jobs/tool-contract.js";
import logger from "../logger.js";
import { withToolLogging } from "./logging.js";
import * as schemas from "./schemas.js";

const log = logger.child({ component: "tools" });

export interface GitHistoryToolDependencies {
  gitHistoryIndexer: GitHistoryIndexer;
  jobManager: IndexJobManager;
}

export function registerGitHistoryTools(server: McpServer, deps: GitHistoryToolDependencies): void {
  const { gitHistoryIndexer, jobManager } = deps;

  // index_git_history
  server.registerTool(
    "index_git_history",
    {
      title: "Index Git History",
      description:
        "Index a repository's git commit history for semantic search. Extracts commit messages, metadata, and optionally diffs to enable finding relevant past commits. Useful for finding similar fixes, understanding change patterns, or learning from past work.",
      inputSchema: schemas.IndexGitHistorySchema,
    },
    withToolLogging(
      "index_git_history",
      async ({ path, forceReindex, sinceDate, maxCommits }, extra) => {
        log.info({ tool: "index_git_history", path, forceReindex }, "Tool called");
        const progressToken = extra._meta?.progressToken;

        const target = await gitHistoryIndexer.getIndexTarget(path);
        const terminal = await runBlockingJob(jobManager, {
          operationId: `legacy:index_git_history:${randomUUID()}`,
          operation: "index_git_history",
          path,
          target,
          run: (updateProgress) =>
            gitHistoryIndexer.indexHistory(
              path,
              { forceReindex, sinceDate, maxCommits },
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
        const stats = terminal.result as Awaited<ReturnType<GitHistoryIndexer["indexHistory"]>>;

        let statusMessage = `Indexed ${stats.commitsIndexed}/${stats.commitsScanned} commits (${stats.chunksCreated} chunks) in ${(stats.durationMs / 1000).toFixed(1)}s`;

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
    "start_index_git_history",
    {
      title: "Start Git History Index Job",
      description: "Schedule Git-history indexing and return immediately with a durable job record.",
      inputSchema: schemas.StartIndexGitHistorySchema,
    },
    withToolLogging(
      "start_index_git_history",
      async ({ path, operationId, sourceRevision, forceReindex, sinceDate, maxCommits }) => {
        const target = await gitHistoryIndexer.getIndexTarget(path);
        return startJobResult(
          await jobManager.submit({
            operationId,
            operation: "index_git_history",
            path,
            target,
            sourceRevision,
            run: (progress) =>
              gitHistoryIndexer.indexHistory(path, { forceReindex, sinceDate, maxCommits }, progress),
          })
        );
      }
    )
  );

  // search_git_history
  server.registerTool(
    "search_git_history",
    {
      title: "Search Git History",
      description:
        "Search indexed git history using natural language queries. Returns semantically relevant commits with metadata. Useful for finding past fixes, similar changes, or understanding how problems were solved before.",
      inputSchema: schemas.SearchGitHistorySchema,
    },
    withToolLogging(
      "search_git_history",
      async ({ path, query, limit, commitTypes, authors, dateFrom, dateTo }) => {
        log.info(
          { tool: "search_git_history", path, query: query.substring(0, 80) },
          "Tool called"
        );
        const results = await gitHistoryIndexer.searchHistory(path, query, {
          limit,
          commitTypes,
          authors,
          dateFrom,
          dateTo,
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for query: "${query}"` }],
          };
        }

        // Format results
        const formattedResults = results
          .map(
            (r, idx) =>
              `\n--- Result ${idx + 1} (score: ${r.score.toFixed(3)}) ---\n` +
              `Commit: ${r.shortHash}\n` +
              `Type: ${r.commitType}\n` +
              `Author: ${r.author}\n` +
              `Date: ${r.date.split("T")[0]}\n` +
              `Subject: ${r.subject}\n` +
              `Files: ${r.files.slice(0, 5).join(", ")}${r.files.length > 5 ? ` (+${r.files.length - 5} more)` : ""}\n\n` +
              `${r.content.substring(0, 500)}${r.content.length > 500 ? "..." : ""}\n`
          )
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} result(s):\n${formattedResults}`,
            },
          ],
        };
      }
    )
  );

  // index_new_commits
  server.registerTool(
    "index_new_commits",
    {
      title: "Index New Commits",
      description:
        "Incrementally index only new commits since the last indexing. Much faster than full re-indexing when keeping the index up to date with recent changes.",
      inputSchema: schemas.IndexNewCommitsSchema,
    },
    withToolLogging("index_new_commits", async ({ path }, extra) => {
      log.info({ tool: "index_new_commits", path }, "Tool called");
      const progressToken = extra._meta?.progressToken;

      const target = await gitHistoryIndexer.getIndexTarget(path);
      const terminal = await runBlockingJob(jobManager, {
        operationId: `legacy:index_new_commits:${randomUUID()}`,
        operation: "index_new_commits",
        path,
        target,
        run: (updateProgress) =>
          gitHistoryIndexer.indexNewCommits(path, (progress) => {
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
      const stats = terminal.result as Awaited<ReturnType<GitHistoryIndexer["indexNewCommits"]>>;

      let message: string;
      if (stats.newCommits === 0) {
        message = "No new commits found. Git history index is up to date.";
      } else {
        message =
          `Indexed ${stats.newCommits} new commits (${stats.chunksAdded} chunks) ` +
          `in ${(stats.durationMs / 1000).toFixed(1)}s`;
      }

      return {
        content: [{ type: "text", text: message }],
      };
    })
  );

  server.registerTool(
    "start_index_new_commits",
    {
      title: "Start New-Commit Index Job",
      description: "Schedule incremental Git-history indexing and return immediately with a durable job record.",
      inputSchema: schemas.StartIndexNewCommitsSchema,
    },
    withToolLogging(
      "start_index_new_commits",
      async ({ path, operationId, sourceRevision }) => {
        const target = await gitHistoryIndexer.getIndexTarget(path);
        return startJobResult(
          await jobManager.submit({
            operationId,
            operation: "index_new_commits",
            path,
            target,
            sourceRevision,
            run: (progress) => gitHistoryIndexer.indexNewCommits(path, progress),
          })
        );
      }
    )
  );

  // get_git_index_status
  server.registerTool(
    "get_git_index_status",
    {
      title: "Get Git Index Status",
      description: "Get the indexing status and statistics for a repository's git history index.",
      inputSchema: schemas.GetGitIndexStatusSchema,
    },
    withToolLogging("get_git_index_status", async ({ path }) => {
      log.info({ tool: "get_git_index_status", path }, "Tool called");
      const status = await gitHistoryIndexer.getIndexStatus(path);
      const target = await gitHistoryIndexer.getIndexTarget(path);
      const job = await jobManager.getMostRecentForTarget(target);
      const effectiveStatus =
        job?.state === "queued" || job?.state === "running"
          ? "indexing"
          : job?.state === "failed" || job?.state === "stale"
            ? job.state
            : status.status;

      if (effectiveStatus === "not_indexed") {
        return {
          content: [
            {
              type: "text",
              text: `Git history at "${path}" is not indexed. Use index_git_history to index it first.`,
            },
          ],
          structuredContent: {
            ...status,
            status: effectiveStatus,
            activeOrRecentJob: job ? publicJob(job) : null,
          },
        };
      }

      if (effectiveStatus === "indexing") {
        return {
          content: [
            {
              type: "text",
              text: `Git history at "${path}" is currently being indexed. ${status.chunksCount || 0} chunks processed so far.`,
            },
          ],
          structuredContent: {
            ...status,
            status: effectiveStatus,
            activeOrRecentJob: job ? publicJob(job) : null,
          },
        };
      }

      // Format status information
      const statusInfo = {
        status: effectiveStatus,
        collectionName: status.collectionName,
        commitsIndexed: status.commitsCount,
        chunksCount: status.chunksCount,
        lastCommitHash: status.lastCommitHash,
        lastIndexedAt: status.lastIndexedAt?.toISOString(),
        activeOrRecentJob: job ? publicJob(job) : null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(statusInfo, null, 2) }],
        structuredContent: statusInfo,
      };
    })
  );

  // clear_git_index
  server.registerTool(
    "clear_git_index",
    {
      title: "Clear Git Index",
      description:
        "Delete all indexed git history data for a repository. This is irreversible and will remove the entire git history index.",
      inputSchema: schemas.ClearGitIndexSchema,
    },
    withToolLogging("clear_git_index", async ({ path }) => {
      log.info({ tool: "clear_git_index", path }, "Tool called");
      const target = await gitHistoryIndexer.getIndexTarget(path);
      const terminal = await runBlockingJob(jobManager, {
        operationId: `legacy:clear_git_index:${randomUUID()}`,
        operation: "clear_git_index",
        path,
        target,
        run: () => gitHistoryIndexer.clearIndex(path),
      });
      if (!("state" in terminal)) return terminal;
      return {
        content: [{ type: "text", text: `Git history index cleared for "${path}".` }],
      };
    })
  );
}
