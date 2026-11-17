import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const launcher = fileURLToPath(new URL("../../scripts/mcp-launch.mjs", import.meta.url));

describe("scripts/mcp-launch.mjs (stdio MCP handshake)", () => {
  it("starts the server, lists the 5 tools and answers a call", { timeout: 300_000 }, async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], stderr: "pipe" });
    const client = new Client({ name: "launcher-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 5);
      const res = await client.callTool({ name: "audit_token_security", arguments: { chain: "base", address: "0x" + "z".repeat(40) } });
      const body = JSON.parse((res.content as { text: string }[])[0]!.text);
      assert.equal(body.status, "UNVERIFIED");
    } finally {
      await client.close();
    }
  });
});
