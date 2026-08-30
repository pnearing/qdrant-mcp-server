/**
 * Code indexing tools registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodeIndexer } from "../code/indexer.js";
import type { CodeSearchResult } from "../code/types.js";
import logger from "../logger.js";
import { withToolLogging } from "./logging.js";
import * as schemas from "./schemas.js";

const log = logger.child({ component: "tools" });

export interface CodeToolDependencies {
  codeIndexer: CodeIndexer;
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
  const { codeIndexer } = deps;

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

        const stats = await codeIndexer.indexCodebase(
          path,
          { forceReindex, extensions, ignorePatterns },
          (progress) => {
            log.debug({ phase: progress.phase, percentage: progress.percentage }, progress.message);
            if (progressToken !== undefined) {
              extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: progress.percentage,
                  total: 100,
                  message: `[${progress.phase}] ${progress.message}`,
                },
              });
            }
          }
        );

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

      const stats = await codeIndexer.reindexChanges(path, (progress) => {
        log.debug({ phase: progress.phase, percentage: progress.percentage }, progress.message);
        if (progressToken !== undefined) {
          extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: progress.percentage,
              total: 100,
              message: `[${progress.phase}] ${progress.message}`,
            },
          });
        }
      });

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

      if (status.status === "not_indexed") {
        return {
          content: [
            {
              type: "text",
              text: `Codebase at "${path}" is not indexed. Use index_codebase to index it first.`,
            },
          ],
        };
      }

      if (status.status === "indexing") {
        return {
          content: [
            {
              type: "text",
              text: `Codebase at "${path}" is currently being indexed. ${status.chunksCount || 0} chunks processed so far.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
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
      await codeIndexer.clearIndex(path);
      return {
        content: [{ type: "text", text: `Index cleared for codebase at "${path}".` }],
      };
    })
  );
}
