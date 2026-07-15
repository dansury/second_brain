// Ad-hoc smoke check (not part of `bun test`): spawns the server over stdio,
// performs an MCP initialize handshake, then lists tools. Prints tool names
// or throws. Run: `bun run scripts/smoke-list-tools.mjs`.
import { spawn } from "node:child_process";

const child = spawn("bun", ["run", "src/index.js"], {
  env: { ...process.env, VAULT_PATH: "/tmp/sb-smoke-list" },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
});
if (init.error) throw new Error(JSON.stringify(init.error));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await rpc("tools/list");
if (list.error) throw new Error(JSON.stringify(list.error));

console.log(
  "tools:",
  list.result.tools.map((t) => t.name).join(", ")
);

child.stdin.end();
child.kill();
