import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { verifyContractDirectory } from "../src/contracts.js";
import { MCP_PROTOCOL_VERSION, PRODUCT_TOOL_NAMES } from "../src/mcp.js";

interface McpBundle {
  advertised_revision: string;
  supported_revisions: Array<string>;
  product_tools: Array<{ name: string }>;
  fixtures: {
    modern: {
      tools_list: { response: { body: { result: { tools: Array<{ name: string }> } } } };
      tool_calls: Array<{ tool: string }>;
    };
  };
}

async function main(): Promise<void> {
  const repositoryRoot = new URL("../", import.meta.url);
  const verified = await verifyContractDirectory(repositoryRoot);
  const rootPath = fileURLToPath(repositoryRoot);
  const mcp = JSON.parse(await readFile(join(rootPath, "contracts/page/1.0.0/mcp.json"), "utf8")) as McpBundle;
  const expectedTools = [...PRODUCT_TOOL_NAMES];
  if (mcp.advertised_revision !== MCP_PROTOCOL_VERSION || !mcp.supported_revisions.includes(MCP_PROTOCOL_VERSION)) {
    throw new Error("The pinned bundle does not support the CLI modern MCP revision.");
  }
  if (JSON.stringify(mcp.product_tools.map((tool) => tool.name)) !== JSON.stringify(expectedTools)) {
    throw new Error("Unclassified MCP product-tool drift detected.");
  }
  if (JSON.stringify(mcp.fixtures.modern.tools_list.response.body.result.tools.map((tool) => tool.name)) !== JSON.stringify(expectedTools)) {
    throw new Error("Modern tools/list fixture drift detected.");
  }
  const expectedCalls = ["lookup_member", "get_community_stats", "verify_certificate"];
  if (JSON.stringify(mcp.fixtures.modern.tool_calls.map((call) => call.tool)) !== JSON.stringify(expectedCalls)) {
    throw new Error("Read-only MCP call fixture drift detected.");
  }
  if (mcp.fixtures.modern.tool_calls.some((call) => call.tool === "register_agent")) {
    throw new Error("The read-only CLI must not contain a register_agent call fixture.");
  }
  process.stdout.write(`Compatible PAGE bundle ${verified.bundleVersion} (${verified.manifestSha256}); exact product tools: ${expectedTools.join(", ")}.\n`);
}

await main();
