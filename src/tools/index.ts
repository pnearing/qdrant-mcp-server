/**
 * Tool registration orchestrator
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodeIndexer } from "../code/indexer.js";
import type { EmbeddingProvider } from "../embeddings/base.js";
import type { GitHistoryIndexer } from "../git/indexer.js";
import type { IndexJobManager } from "../jobs/index-job-manager.js";
import type { QdrantManager } from "../qdrant/client.js";
import { registerCodeTools } from "./code.js";
import { registerCollectionTools } from "./collection.js";
import { registerDocumentTools } from "./document.js";
import { registerFederatedTools } from "./federated.js";
import { registerGitHistoryTools } from "./git-history.js";
import { registerIndexJobTools } from "./index-jobs.js";
import { registerSearchTools } from "./search.js";

export interface ToolDependencies {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  codeIndexer: CodeIndexer;
  gitHistoryIndexer: GitHistoryIndexer;
  jobManager: IndexJobManager;
}

/**
 * Register all MCP tools on the server
 */
export function registerAllTools(server: McpServer, deps: ToolDependencies): void {
  registerCollectionTools(server, {
    qdrant: deps.qdrant,
    embeddings: deps.embeddings,
  });

  registerDocumentTools(server, {
    qdrant: deps.qdrant,
    embeddings: deps.embeddings,
  });

  registerSearchTools(server, {
    qdrant: deps.qdrant,
    embeddings: deps.embeddings,
  });

  registerCodeTools(server, {
    codeIndexer: deps.codeIndexer,
    jobManager: deps.jobManager,
  });

  registerGitHistoryTools(server, {
    gitHistoryIndexer: deps.gitHistoryIndexer,
    jobManager: deps.jobManager,
  });

  registerIndexJobTools(server, deps.jobManager);

  registerFederatedTools(server, {
    codeIndexer: deps.codeIndexer,
    gitHistoryIndexer: deps.gitHistoryIndexer,
  });
}

// Re-export schemas for external use
export * from "./schemas.js";
