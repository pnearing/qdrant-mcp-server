import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IndexJobManager } from "../jobs/index-job-manager.js";
import { statusJobResult } from "../jobs/tool-contract.js";
import { withToolLogging } from "./logging.js";
import { GetIndexJobStatusSchema } from "./schemas.js";

export function registerIndexJobTools(server: McpServer, jobManager: IndexJobManager): void {
  server.registerTool(
    "get_index_job_status",
    {
      title: "Get Index Job Status",
      description:
        "Return durable state, progress, heartbeat, result, and error details for a background indexing job.",
      inputSchema: GetIndexJobStatusSchema,
    },
    withToolLogging("get_index_job_status", async ({ jobId }) => {
      const job = await jobManager.get(jobId);
      if (!job) {
        return {
          content: [{ type: "text", text: `Index job not found: ${jobId}` }],
          structuredContent: { found: false, jobId },
          isError: true,
        };
      }
      return statusJobResult(job);
    })
  );
}
