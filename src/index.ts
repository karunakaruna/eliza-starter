import { DirectClient } from "@elizaos/client-direct";
import {
  AgentRuntime,
  elizaLogger,
  settings,
  stringToUuid,
  type Character,
} from "@elizaos/core";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { createNodePlugin } from "@elizaos/plugin-node";
import { solanaPlugin } from "@elizaos/plugin-solana";
import fs from "fs";
import net from "net";
import path from "path";
import http from "http";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { initializeDbCache } from "./cache/index.ts";
import { character } from "./character.ts";
import { startChat } from "./chat/index.ts";
import { initializeClients } from "./clients/index.ts";
import {
  getTokenForProvider,
  loadCharacters,
  parseArguments,
} from "./config/index.ts";
import { initializeDatabase } from "./database/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
  const waitTime =
    Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

let nodePlugin: any | undefined;

export function createAgent(
  character: Character,
  db: any,
  cache: any,
  token: string
) {
  elizaLogger.success(
    elizaLogger.successesTitle,
    "Creating runtime for character",
    character.name,
  );

  // Make the Node plugin opt-in to avoid accidental tool calls on local models
  // Set ENABLE_NODE_PLUGIN=true in .env to enable
  const enableNodePlugin = process.env.ENABLE_NODE_PLUGIN === "true";
  if (enableNodePlugin) {
    nodePlugin ??= createNodePlugin();
  } else {
    nodePlugin = undefined;
  }

  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [
      bootstrapPlugin,
      enableNodePlugin ? nodePlugin : null,
      character.settings?.secrets?.WALLET_PUBLIC_KEY ? solanaPlugin : null,
    ].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });
}

async function startAgent(character: Character, directClient: DirectClient) {
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;

    const token = getTokenForProvider(character.modelProvider, character);
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase(dataDir);

    await db.init();

    const cache = initializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);

    await runtime.initialize();

    runtime.clients = await initializeClients(character, runtime);

    directClient.registerAgent(runtime);

    // report to console
    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

    return runtime;
  } catch (error) {
    elizaLogger.error(
      `Error starting agent for character ${character.name}:`,
      error,
    );
    console.error(error);
    throw error;
  }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
};

const startAgents = async () => {
  const directClient = new DirectClient();
  let serverPort = parseInt(settings.SERVER_PORT || "3000");
  const args = parseArguments();

  let charactersArg = args.characters || args.character;
  let characters = [character];

  console.log("charactersArg", charactersArg);
  if (charactersArg) {
    characters = await loadCharacters(charactersArg);
  }
  console.log("characters", characters);
  try {
    for (const character of characters) {
      await startAgent(character, directClient as DirectClient);
    }
  } catch (error) {
    elizaLogger.error("Error starting agents:", error);
  }

  while (!(await checkPortAvailable(serverPort))) {
    elizaLogger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
    serverPort++;
  }

  // upload some agent functionality into directClient
  directClient.startAgent = async (character: Character) => {
    // wrap it so we don't have to inject directClient later
    return startAgent(character, directClient);
  };

  directClient.start(serverPort);

  if (serverPort !== parseInt(settings.SERVER_PORT || "3000")) {
    elizaLogger.log(`Server started on alternate port ${serverPort}`);
  }

  // --- Minimal Inspector server: /inspector, /api/events, /api/chat ---
  const inspectorPort = parseInt(process.env.INSPECTOR_PORT || "3300");
  try {
    const sseClients = new Set<http.ServerResponse>();
    function broadcast(evt: string) {
      const payload = `data: ${JSON.stringify({ type: evt, ts: Date.now() })}\n\n`;
      for (const client of sseClients) {
        try { client.write(payload); } catch {}
      }
    }

    const server = http.createServer(async (req, res) => {
      try {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

        if (req.url === "/inspector" && req.method === "GET") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Inspector</title>
<style>body{font-family:system-ui;margin:0;background:#0b0c10;color:#e5e7eb}header{padding:16px;border-bottom:1px solid #1f2937}main{padding:16px;display:grid;gap:16px}section{background:#111827;border:1px solid #1f2937;border-radius:8px;overflow:hidden}section>header{padding:10px 12px;border-bottom:1px solid #1f2937;background:#0f172a;display:flex;justify-content:space-between;align-items:center}</style>
</head><body>
<header><h1 style="margin:0;font-size:18px">Inspector</h1><div style="color:#9ca3af">Lightweight dashboard</div></header>
<main>
  <section>
    <header><h2 style="margin:0;font-size:16px">Live Chat</h2></header>
    <div id="live" style="padding:10px;max-height:45vh;overflow:auto"></div>
    <div style="display:flex;gap:8px;padding:10px;border-top:1px solid #1f2937">
      <input id="inp" style="flex:1;padding:8px;background:#0f172a;color:#e5e7eb;border:1px solid #1f2937;border-radius:6px" placeholder="Type a message"/>
      <button id="send">Send</button>
    </div>
  </section>
  <section>
    <header><h2 style="margin:0;font-size:16px">Events</h2><button onclick="location.reload()">Reload</button></header>
    <div id="ev" style="padding:10px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;white-space:pre-wrap"></div>
  </section>
</main>
<script>
const evBox = document.getElementById('ev');
try{ const es = new EventSource('/api/events'); es.onmessage = (e)=>{ const t = new Date().toLocaleTimeString(); evBox.textContent += '['+t+'] '+ e.data + '\n'; evBox.scrollTop = evBox.scrollHeight; }; }catch{}
const live = document.getElementById('live');
function append(text){ const d=document.createElement('div'); d.textContent=text; d.style.padding='6px 10px'; live.appendChild(d); live.scrollTop = live.scrollHeight; }
async function send(){ const i=document.getElementById('inp'); const v=String(i.value||'').trim(); if(!v) return; i.value=''; append('You: '+v); try{ const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v})}); const arr = await r.json(); if(Array.isArray(arr)){ for(const m of arr){ append('Agent: '+(m.text||'')); } } }catch(e){ append('Error: '+e); } }
document.getElementById('send').addEventListener('click', send);
document.getElementById('inp').addEventListener('keydown', (e)=>{ if(e.key==='Enter') send(); });
</script>
</body></html>`);
          return;
        }

        if (req.url === "/api/events" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
          sseClients.add(res);
          const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 30000);
          req.on('close', ()=>{ clearInterval(ping); sseClients.delete(res); });
          return;
        }

        if (req.url === "/api/chat" && req.method === "POST") {
          const chunks = [] as Buffer[];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          const text = typeof body.text === 'string' ? body.text : '';
          const agentIdRaw = (Array.isArray(characters) && characters[0] && (characters[0].name || 'Agent')) || 'Agent';
          const agentId = encodeURIComponent(String(agentIdRaw));
          const resp = await fetch(`http://localhost:${serverPort}/${agentId}/message`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, userId: 'user', userName: 'User' })
          });
          const data = await resp.json();
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify(data));
          broadcast('chat:sent');
          return;
        }

        res.statusCode = 404; res.end('Not found');
      } catch (e:any) {
        res.statusCode = 500;
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({ error: String(e?.message || e || 'unknown') }));
      }
    });
    server.listen(inspectorPort, () => {
      elizaLogger.log(`Inspector at http://localhost:${inspectorPort}/inspector`);
    });
  } catch {}

  const isDaemonProcess = process.env.DAEMON_PROCESS === "true";
  if(!isDaemonProcess) {
    elizaLogger.log("Chat started. Type 'exit' to quit.");
    const chat = startChat(characters);
    chat();
  }
};

startAgents().catch((error) => {
  elizaLogger.error("Unhandled error in startAgents:", error);
  process.exit(1);
});
