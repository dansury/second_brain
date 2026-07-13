import readline from "node:readline";
import { tools } from "./tools/index.mjs";

// Минимальная реализация транспорта MCP (Model Context Protocol) поверх
// stdio: newline-delimited JSON-RPC 2.0 сообщения на stdin/stdout, логи —
// в stderr (см. https://modelcontextprotocol.io — раздел stdio transport).
// Реализован только необходимый набор методов (initialize/tools.*) — этого
// достаточно для инструментов M1 (см. ТЗ §12). Нулевые внешние зависимости —
// см. README.md.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "secondbrain";
const SERVER_VERSION = "0.1.0";

function log(...args) {
  console.error(`[secondbrain]`, ...args);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  if (id === undefined) return; // уведомление — ответ не нужен
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolsListPayload() {
  return {
    tools: Object.entries(tools).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  };
}

async function callTool(name, args, ctx) {
  const def = tools[name];
  if (!def) {
    throw new Error(`Неизвестный инструмент: ${name}`);
  }
  return def.handler(args || {}, ctx);
}

/**
 * Запустить MCP-сервер на stdio. `ctx` пробрасывается во все обработчики
 * инструментов (сейчас — только vaultRoot, см. cli.mjs).
 */
export function serve(ctx) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log("Некорректный JSON во входящем сообщении:", e.message);
      return;
    }

    const { id, method, params } = msg;
    try {
      switch (method) {
        case "initialize":
          sendResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
          break;

        case "notifications/initialized":
        case "initialized":
          // уведомление клиента — ответа не требует
          break;

        case "ping":
          sendResult(id, {});
          break;

        case "tools/list":
          sendResult(id, toolsListPayload());
          break;

        case "tools/call": {
          const { name, arguments: toolArgs } = params || {};
          try {
            const result = await callTool(name, toolArgs, ctx);
            sendResult(id, {
              content: [{ type: "text", text: JSON.stringify(result) }],
              isError: false,
            });
          } catch (err) {
            sendResult(id, {
              content: [{ type: "text", text: String(err?.message || err) }],
              isError: true,
            });
          }
          break;
        }

        default:
          sendError(id, -32601, `Метод не поддерживается: ${method}`);
      }
    } catch (err) {
      log("Ошибка обработки сообщения:", err);
      sendError(id, -32603, String(err?.message || err));
    }
  });

  log(`Запущен, vault: ${ctx.vaultRoot}`);

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
