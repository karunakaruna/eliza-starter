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

  nodePlugin ??= createNodePlugin();

  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [
      bootstrapPlugin,
      nodePlugin,
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

  // --- Inspector server (read-only + tree generator) ---
  // Uses Postgres via psql; requires POSTGRES_URL formatted like postgres://localhost/eliza
  const pgUrl = process.env.POSTGRES_URL || "";
  const isPostgres = Boolean(pgUrl);
  const inspectorPort = parseInt(process.env.INSPECTOR_PORT || "3300");

  function runPsql(sql: string) {
    if (!isPostgres) throw new Error("POSTGRES_URL not set for inspector");
    // Assume database name is in URL; for local default use -d eliza
    // Use the Homebrew psql path commonly installed per earlier steps
    const psqlBin = "/usr/local/opt/postgresql@14/bin/psql";
    const dbName = "eliza"; // simple local default
    // Pipe SQL via stdin to avoid shell escaping issues and .psqlrc surprises
    const cmd = `${psqlBin} -d ${dbName} -v ON_ERROR_STOP=1 -At -X`;
    return execSync(cmd, { encoding: "utf8", input: sql });
  }

  // Single-quote and escape a string for SQL literals
  function sqlQuote(val: string) {
    return `'${String(val).replace(/'/g, "''")}'`;
  }

  // Global preferences (server + UI)
  // magic: enable OpenAI calls; when false, use local-only fallback logic
  // theme: 'dark' | 'light'
  // textSize: base font size in px
  let preferences: { magic: boolean; theme: 'dark' | 'light'; textSize: number } = {
    magic: true,
    theme: 'dark',
    textSize: 16,
  };

  function ensureTables() {
    if (!isPostgres) return;
    runPsql(`
      CREATE TABLE IF NOT EXISTS trees (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        height NUMERIC,
        properties JSONB,
        magic_number INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS command_logs (
        id BIGSERIAL PRIMARY KEY,
        command TEXT NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        meta JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS deku_nuts (
        id TEXT PRIMARY KEY,
        base INTEGER,
        properties JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  async function generateTreeViaOpenAI(seed: any) {
    const apiKey = process.env.OPENAI_API_KEY || settings.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || "o3";
    const fallback = () => {
      const s = seed && typeof seed === "object" ? JSON.stringify(seed) : String(seed ?? "");
      const base = s.replace(/[^a-z0-9]+/gi, " ").trim() || "mystic";
      const name = `${base.split(" ")[0] || "mystic"} tree`;
      const height = Math.max(3, Math.min(60, Math.round((base.length % 50) + 5)));
      return { name, height, properties: { seed: seed || null, source: "local-fallback" } };
    };
    // Respect preferences: if magic disabled, always use fallback
    if (!preferences.magic) {
      return fallback();
    }
    if (!apiKey) {
      return fallback();
    }
    const sys = "You create fantasy tree objects. Respond ONLY with strict JSON: {\"name\": string, \"height\": number, \"properties\": object}. No prose.";
    const user = `Generate a tree with creative name and realistic height (in meters). Include a properties object with 2-5 descriptive fields. Seed: ${JSON.stringify(seed || {})}`;
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
          temperature: 0.7,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || "{}";
      let obj: any;
      try { obj = JSON.parse(text); } catch { obj = {}; }
      if (typeof obj !== "object" || !obj) obj = {};
      return {
        name: String(obj.name || "Unnamed Tree"),
        height: Number(obj.height || 5),
        properties: typeof obj.properties === "object" && obj.properties ? obj.properties : {},
      };
    } catch (_e) {
      clearTimeout(to);
      return fallback();
    }
  }

  // (removed sha256Hex helper; not needed)

  async function insertTree(tree: { name: string; height: number; properties: any; }) {
    const now = new Date().toISOString();
    const rand = Math.random().toString(36).slice(2);
    const { default: crypto } = await import("crypto");
    const id = crypto.createHash("sha256").update(`${tree.name}:${now}:${rand}`).digest("hex");
    const magic = Math.floor(Math.random() * 1_000_000) + 1;
    const propsJson = JSON.stringify(tree.properties || {});
    runPsql(`INSERT INTO trees (id, name, height, properties, magic_number) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(tree.name)},
      ${Number.isFinite(tree.height as any) ? String(tree.height) : 'NULL'},
      ${sqlQuote(propsJson)}::jsonb,
      ${String(magic)}
    );`);
    return { id, name: tree.name, height: tree.height, properties: tree.properties || {}, magicNumber: magic, createdAt: now };
  }

  function listTrees(limit = 100) {
    const out = runPsql(`SELECT row_to_json(t) FROM (
      SELECT id, name, height, properties, magic_number AS "magicNumber", created_at AS "createdAt"
      FROM trees ORDER BY created_at DESC LIMIT ${limit}
    ) t;`);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  }

  function logCommand(command: string, payload: any) {
    try {
      // Suppress noisy heartbeat logs in CLI while preserving DB persistence
      if (command !== 'heartbeat') {
        console.log(`[heartbeat/log] ${command}`, payload);
      }
      runPsql(`INSERT INTO command_logs (command, payload) VALUES (
        ${sqlQuote(command)}, ${sqlQuote(JSON.stringify(payload || {}))}::jsonb
      );`);
    } catch {}
  }

  // World Tree library: 100 lines in 5 groups of 20
  const WORLD_TREE_LIBRARY: { type: string; text: string }[] = (() => {
    const byType: Record<string, string[]> = {
      'sounds': [
        'wind in pine needles, a soft ssshhh 🌲✨',
        'roots murmuring like distant rivers 🌊🌿',
        'a sparrow taps, tiny drum on bark 🐦🥁',
        'hollow log hum, bee-low and bright 🐝🎵',
        'dew clicks from leaf to leaf 💧🍃',
        'moss exhale, velvet hush 🌿😌',
        'acorns whisper logistics of falling 🌰🌀',
        'twig snaps, probability pivots 🌿🔀',
        'rain writes in dot-dash on leaves 🌧️•–•',
        'owl punctuation in night air 🦉…',
        'mycelium gossip underfoot 🍄📡',
        'sunbeams ring like glass in fog ☀️🔔',
        'rind creaks: the bark stretches 🪵🎻',
        'ants patter—ten thousand footnotes 🐜📚',
        'seedpods rattle maps of maybe 🌱🗺️',
        'far thunder kneads the hills ⛈️🫧',
        'leaf applause for a breeze 🍃👏',
        'cicadas tune time to summer ♨️🕰️',
        'snow hush, world on tiptoe ❄️🤫',
        'river braids a lullaby nearby 🏞️🎶',
      ],
      'worldbuilding': [
        'COMMAND: TREE.GROW_LEAVES {"density": "gentle", "tone": "emerald"}',
        'COMMAND: TREE.CALL_BIRDS {"species": "finch", "count": 3}',
        'COMMAND: GROVE.SPREAD_MOSS {"patches": 5, "shade": true}',
        'COMMAND: SOIL.ENRICH {"compost": "leafmold", "humus": 2}',
        'COMMAND: ROOTS.TWINE {"with": "mycelium", "intent": "cooperate"}',
        'COMMAND: RIVER.SING {"volume": "low", "tempo": "slow"}',
        'COMMAND: SEEDS.DRIFT {"direction": "east", "count": 8}',
        'COMMAND: BREEZE.NUDGE {"probability": 0.07}',
        'COMMAND: CANOPY.OPEN {"lightShafts": 4}',
        'COMMAND: SHADOW.COOL {"area": "resting_stones"}',
        'COMMAND: PATH.WEAVE {"visitors": "gentle", "width": "narrow"}',
        'COMMAND: TREE.GROW_RING {"year": "present", "thickness": "kind"}',
        'COMMAND: BIRDS.TRADE_SEEDS {"rate": "friendly"}',
        'COMMAND: FOG.LIFT {"window": 10}',
        'COMMAND: SPROUT.EMERGE {"species": "wildflower"}',
        'COMMAND: DAPPLE.PAINT {"palette": ["gold", "green"]}',
        'COMMAND: DEW.GATHER {"on": "clover"}',
        'COMMAND: STONES.WARM {"sun": true}',
        'COMMAND: LICHEN.SETTLE {"texture": "map"}',
        'COMMAND: NIGHT.LISTEN {"extent": "whole_grove"}',
      ],
      'weather': [
        'A hush-front wafts in: cooler by degrees of kindness.',
        'Pollen halo at noon; expect golden sneezes near clover.',
        'Thin rain soon—made for eavesdropping and tea.',
        'South breeze practices braille on tall grasses.',
        'Evening will rust with crickets; stars rehearse.',
        'Clouds braid a silver rumor; carry a patient hat.',
        'Mild thunder tutoring the hills—no tests today.',
        'Fog sketches soft edges; names lose their corners.',
        'Leafbarometer says: gratitude pressure rising.',
        'Small rainbow probability: check puddles for portals.',
        'Sun will speak in gentle paragraphs, not headlines.',
        'Drizzle likely to sign the stones with gloss.',
        'North wind flips the forest to its cool side.',
        'Dawn distills clarity; drink slowly.',
        'Evening pockets will be lined with firefly coins.',
        'Air tastes like green lemons; storms far away.',
        'A polite snow audition may occur after midnight.',
        'Barometric empathy steady; all roots reassured.',
        'Cumulus will gossip like sheep; harmless.',
        'Rivers will keep their promises today.',
      ],
      'wisdom': [
        'Health is the story relationships tell about themselves.',
        'Small, reversible acts accumulate into durable change.',
        'Tend the edges—life negotiates there.',
        'Patience is speed that kept its balance.',
        'Compost your certainties; sprout better questions.',
        'Strength without gentleness is just noise.',
        'Reciprocity is how time makes friends.',
        'The shortest path across a forest is a season.',
        'Care is a technology; iterate kindly.',
        'The map of maybe needs many cartographers.',
        'When you can’t push, garden probabilities.',
        'Listening is the oldest form of engineering.',
        'What scales isn’t always what matters; what matters often scales slowly.',
        'Repair begins with naming the broken gently.',
        'Your attention is rain; where will you water?',
        'Roots share first, then grow.',
        'Leave room for crows to invent games.',
        'Measure progress by reciprocity, not extraction.',
        'Let mystery keep its wild edges.',
        'Alignment tastes like clean water.',
      ],
      'calming': [
        'Unclench your jaw; let the wind hold it for a moment.',
        'Place a hand on your chest and count three slow leaves of breath.',
        'Sip water as if the river were teaching you how.',
        'Close your eyes; picture moss softening the edges of today.',
        'Let your shoulders fall like ripe fruit into rest.',
        'Light finds you; you do not have to chase it.',
        'Sit where the air is kind and let it edit your worries.',
        'Trade one hurry for one listen.',
        'Name five gentle things within reach and thank them.',
        'Tilt your face toward a quiet window of sky.',
        'Lay your thoughts in the shade; they will cool.',
        'Trust the small repair you can make now.',
        'Let silence stitch the torn places between moments.',
        'Breathe with a tree: in for roots, out for leaves.',
        'Put your feet on the floor; remember you have a ground.',
        'Speak to yourself like rainfall—soft, steady, enough.',
        'Release what is heavy; keep what is living.',
        'Lower the volume of the world by one kindness.',
        'Rest is not an absence; it is an ally.',
        'You are allowed to be a quiet place.',
      ],
    };
    const out: { type: string; text: string }[] = [];
    for (const [type, arr] of Object.entries(byType)) {
      for (const text of arr) out.push({ type, text });
    }
    return out; // 5 x 20 = 100
  })();

  // Shuffle once and cycle
  const shuffledWorldTree = [...WORLD_TREE_LIBRARY].sort(() => Math.random() - 0.5);
  let worldTreeIdx = 0;

  function startInspector() {
    if (!isPostgres) {
      elizaLogger.warn("Inspector disabled: POSTGRES_URL not set");
      return;
    }
    ensureTables();
    const sseClients = new Set<http.ServerResponse>();
    function broadcast(evt: string) {
      const payload = `data: ${JSON.stringify({ type: evt, ts: Date.now() })}\n\n`;
      for (const client of sseClients) {
        try { client.write(payload); } catch {}
      }
    }

    const server = http.createServer(async (req, res) => {
      try {
        // CORS and JSON defaults
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

        if (req.url === "/inspector" && req.method === "GET") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Inspector</title>
  <script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.161.0/build/three.module.js"}}</script>
  <style>
    :root{--gap:16px;--bg:#0b0c10;--fg:#e5e7eb;--muted:#9ca3af;--card:#111827;--border:#1f2937}
    /* Light theme overrides */
    :root.light{--bg:#f8fafc;--fg:#0b1220;--muted:#475569;--card:#ffffff;--border:#e2e8f0}
    *{box-sizing:border-box}
    body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial, Noto Sans, "Apple Color Emoji","Segoe UI Emoji";margin:0;background:var(--bg);color:var(--fg); font-size: var(--text-size,16px)}
    header{padding:20px;position:sticky;top:0;background:rgba(11,12,16,.9);backdrop-filter:saturate(120%) blur(8px);border-bottom:1px solid var(--border)}
    h1{margin:0;font-size:20px}
    main{padding:20px;display:grid;grid-template-columns:1fr;gap:var(--gap)}
    @media(min-width:900px){main{grid-template-columns:1fr 1fr}}
    @media(min-width:1400px){main{grid-template-columns:repeat(4,1fr)}}
    section{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
    section>header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#0f172a;border-bottom:1px solid var(--border)}
    section>header h2{margin:0;font-size:16px}
    /* Fold-down Preferences panel */
    .prefs-panel{max-height:0; overflow:hidden; padding:0 20px; border-bottom:1px solid transparent; background:var(--card); transition:max-height .3s ease, padding .3s ease, border-color .3s ease}
    body.prefs-open .prefs-panel{max-height:360px; padding:12px 20px; border-bottom-color:var(--border)}
    .prefs-grid{display:grid; grid-template-columns:1fr 1fr; gap:12px}
    .pref-item{display:flex; align-items:center; justify-content:space-between; gap:10px; background:var(--card); border:1px solid var(--border); padding:10px; border-radius:8px}
    .pref-item small{color:var(--muted); display:block}
    /* Toggle switch */
    .switch{position:relative; width:46px; height:26px; flex:0 0 auto}
    .switch input{position:absolute; opacity:0; width:0; height:0}
    .switch .track{position:absolute; inset:0; background:#374151; border-radius:999px; transition:background .2s ease}
    .switch .thumb{position:absolute; top:3px; left:3px; width:20px; height:20px; background:#fff; border-radius:50%; transition:transform .2s ease}
    .switch input:checked + .track{background:#10b981}
    .switch input:checked + .track + .thumb{transform:translateX(20px)}
    table{width:100%;border-collapse:collapse}
    td,th{border-top:1px solid var(--border);padding:4px 6px;vertical-align:top;word-break:break-word;line-height:1.15}
    pre{white-space:pre-wrap;word-break:break-word;margin:0;line-height:1.15}
    /* Single-line performance mode */
    body.single-line pre{white-space:nowrap}
    body.single-line td{max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
    body.single-line #liveStream .bubble div{white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    /* 3D Viewport */
    #viewport3d{position:relative; width:100%; height:clamp(260px, 42vh, 600px); background:#0b0c10}
  </style>
  </head>
  <body>
    <header>
      <div style="display:flex;align-items:center;gap:12px;justify-content:space-between">
        <div>
          <h1>Inspector</h1>
          <div class="muted" style="color:var(--muted)">Trees, Command Logs, Messages, and Deku Nuts</div>
        </div>
        <div class="actions">
          <button id="toggleLinesBtn" class="secondary" onclick="toggleLines()">Multi-line</button>
          <button id="prefsBtn" class="secondary" onclick="togglePrefs()">Preferences</button>
        </div>
      </div>
    </header>
  <div id="prefsPanel" class="prefs-panel">
    <div class="prefs-grid">
      <div class="pref-item" style="grid-column:1 / -1">
        <div>
          <div><b>Magic prompts</b></div>
          <small>Enable calling OpenAI; off = local/logic-only</small>
        </div>
        <label class="switch">
          <input type="checkbox" id="prefMagic" />
          <span class="track"></span>
          <span class="thumb"></span>
        </label>
      </div>
      <div class="pref-item">
        <span style="min-width:70px">Theme</span>
        <select id="prefTheme">
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <div class="pref-item">
        <span style="min-width:90px">Text size</span>
        <div style="display:flex; align-items:center; gap:10px">
          <input type="range" id="prefTextSize" min="12" max="22" step="1" />
          <span id="prefTextSizeVal" style="color:var(--muted)"></span>
        </div>
      </div>
    </div>
  </div>
  <main>
    <section style="grid-column:1/-1">
      <header><h2>3D Grove</h2><div class="actions"><button onclick="window.dispatchEvent(new Event('viz:rebuild'))">Rebuild</button></div></header>
      <div id="viewport3d">
        <button id="fsBtn" class="fs-btn" onclick="toggleViewportFullscreen()">Fullscreen</button>
        <div id="vizOverlay" class="viz-overlay">Loading 3D scene…</div>
      </div>
    </section>
    <!-- Four-up row: Trees | Live Chat | Messages | Command Logs -->
    <section>
      <header><h2>Trees</h2><div class="actions"><button onclick="refreshTrees()">Refresh</button></div></header>
      <div style="overflow:auto">
        <table id="trees"><thead><tr><th>id</th><th>name</th><th>height</th><th>magicNumber</th><th>createdAt</th><th>properties</th></tr></thead><tbody></tbody></table>
      </div>
    </section>
    <section>
      <header><h2>Live Chat</h2></header>
      <div id="liveBox">
        <div id="liveStream"></div>
        <div style="display:flex; gap:8px; padding:12px; border-top:1px solid var(--border)">
          <input id="chatInput" placeholder="Type a message (e.g., make a tree)" style="flex:1; padding:8px; background:#0f172a; color:var(--fg); border:1px solid var(--border); border-radius:6px" />
          <button id="chatSend">Send</button>
        </div>
      </div>
    </section>
    <section>
      <header><h2>Messages</h2><div class="actions"><button onclick="refreshMessages()">Refresh</button></div></header>
      <div style="overflow:auto">
        <table id="messages"><thead><tr><th>id</th><th>role</th><th>text</th><th>createdAt</th><th>meta</th></tr></thead><tbody></tbody></table>
      </div>
    </section>
    <section>
      <header><h2>Command Logs</h2><div class="actions"><button onclick="refreshLogs()">Refresh</button></div></header>
      <div style="overflow:auto">
        <table id="logs"><thead><tr><th>id</th><th>command</th><th>payload</th><th>createdAt</th></tr></thead><tbody></tbody></table>
      </div>
    </section>
    <!-- Secondary row -->
    <section>
      <header><h2>Commands</h2></header>
      <div style="overflow:auto">
        <table id="commands"><thead><tr><th>command</th><th>description</th><th>examples</th></tr></thead><tbody></tbody></table>
      </div>
    </section>
    <section>
      <header><h2>Schedulers</h2></header>
      <div style="overflow:auto">
        <table id="schedulers"><thead><tr><th>run</th><th>task</th><th>interval</th><th>next</th></tr></thead><tbody></tbody></table>
      </div>
    </section>
    
    <section>
      <header><h2>Deku Nuts</h2><div class="actions"><button onclick="refreshNuts()">Refresh</button></div></header>
      <div style="overflow:auto">
        <table id="nuts"><thead><tr><th>id</th><th>base</th><th>createdAt</th><th>properties</th></tr></thead><tbody></tbody></table>
      </div>
    </section>
  </main>
  <script>
  // default to single-line mode
  document.body.classList.add('single-line');
  try { const b = document.getElementById('toggleLinesBtn'); if (b) b.textContent = 'Multi-line'; } catch {}
  function toggleLines(){
    const btn = document.getElementById('toggleLinesBtn');
    const single = document.body.classList.toggle('single-line');
    // When single-line is active, button suggests switching to Multi-line
    btn.textContent = single ? 'Multi-line' : 'Single-line';
  }

  // Preferences fold-down
  function togglePrefs(){
    const open = document.body.classList.toggle('prefs-open');
    try { localStorage.setItem('prefs.open', open ? '1' : '0'); } catch {}
  }

  async function refreshTrees(){
    try{
      const r = await fetch('/api/trees');
      if (!r.ok) throw new Error('trees fetch failed: '+r.status);
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      const tbody = document.querySelector('#trees tbody');
      tbody.innerHTML='';
      list.forEach(row=>{
        const tr=document.createElement('tr');
        tr.innerHTML = '<td>'+row.id+'</td><td>'+row.name+'</td><td>'+row.height+'</td><td>'+row.magicNumber+'</td><td>'+row.createdAt+'</td><td><pre>'+JSON.stringify(row.properties,null,2)+'</pre></td>';
        tbody.appendChild(tr);
      });
    }catch(e){
      const tbody = document.querySelector('#trees tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="6"><em>Failed to load trees</em></td></tr>';
    }
  }
  async function refreshLogs(){
    try{
      const r = await fetch('/api/command-logs');
      if (!r.ok) throw new Error('logs fetch failed: '+r.status);
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      const tbody = document.querySelector('#logs tbody');
      tbody.innerHTML='';
      list.forEach(row=>{
        const tr=document.createElement('tr');
        tr.innerHTML = '<td>'+row.id+'</td><td>'+row.command+'</td><td><pre>'+JSON.stringify(row.payload,null,2)+'</pre></td><td>'+row.createdAt+'</td>';
        tbody.appendChild(tr);
      });
    }catch(e){
      const tbody = document.querySelector('#logs tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="4"><em>Failed to load logs</em></td></tr>';
    }
  }
  async function refreshMessages(){
    try{
      const r = await fetch('/api/messages');
      if (!r.ok) throw new Error('messages fetch failed: '+r.status);
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      const tbody = document.querySelector('#messages tbody');
      tbody.innerHTML='';
      list.forEach(row=>{
        const tr=document.createElement('tr');
        tr.innerHTML = '<td>'+row.id+'</td><td>'+row.role+'</td><td>'+row.text+'</td><td>'+row.createdAt+'</td><td><pre>'+JSON.stringify(row.meta,null,2)+'</pre></td>';
        tbody.appendChild(tr);
      });
    }catch(e){
      const tbody = document.querySelector('#messages tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5"><em>Failed to load messages</em></td></tr>';
    }
  }
  async function refreshNuts(){
    try{
      const r = await fetch('/api/deku-nuts');
      if (!r.ok) throw new Error('nuts fetch failed: '+r.status);
      const data = await r.json();
      const list = Array.isArray(data) ? data : [];
      const tbody = document.querySelector('#nuts tbody');
      tbody.innerHTML='';
      list.forEach(row=>{
        const tr=document.createElement('tr');
        tr.innerHTML = '<td>'+row.id+'</td><td>'+row.base+'</td><td>'+row.createdAt+'</td><td><pre>'+JSON.stringify(row.properties,null,2)+'</pre></td>';
        tbody.appendChild(tr);
      });
    }catch(e){
      const tbody = document.querySelector('#nuts tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="4"><em>Failed to load deku nuts</em></td></tr>';
    }
  }
  // Commands list renderer
  function renderCommands(){
    const rows = [
      { command: 'deku', description: 'Create a deku nut and persist it', examples: ['deku', 'make a deku', 'make a teku'] },
      { command: 'tree', description: 'Generate a mystic tree; accepts optional JSON seed', examples: ['tree', 'make a tree'] },
    ];
    const tbody = document.querySelector('#commands tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      const tdCmd = document.createElement('td');
      const tdDesc = document.createElement('td');
      const tdEx = document.createElement('td');
      const pre = document.createElement('pre');
      tdCmd.textContent = r.command;
      tdDesc.textContent = r.description;
      // IMPORTANT: use \\n so the server template literal doesn't turn it into a real newline
      pre.textContent = r.examples.join('\\n');
      tdEx.appendChild(pre);
      tr.appendChild(tdCmd);
      tr.appendChild(tdDesc);
      tr.appendChild(tdEx);
      tbody.appendChild(tr);
    }
  }
  refreshTrees();
  refreshLogs();
  refreshMessages();
  refreshNuts();
  renderCommands();

  // Preferences module (localStorage-first, then server)
  (function(){
    const clamp = (v)=> Math.max(12, Math.min(22, Number(v)||16));
    const state = {
      magic: true,
      theme: 'dark',
      textSize: 16,
    };
    function applyTheme(theme){
      const isLight = theme === 'light';
      document.documentElement.classList.toggle('light', isLight);
      try { localStorage.setItem('prefs.theme', isLight ? 'light' : 'dark'); } catch {}
    }
    function applyTextSize(px){
      const v = clamp(px);
      document.documentElement.style.setProperty('--text-size', v + 'px');
      try { localStorage.setItem('prefs.textSize', String(v)); } catch {}
    }
    async function saveServer(partial){
      try {
        await fetch('/api/prefs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(partial) });
      } catch {}
    }
    const saveServerDebounced = (fn=>{ let t; return (p)=>{ clearTimeout(t); t = setTimeout(()=>fn(p), 250); }; })(saveServer);

    function applyAll(){
      applyTheme(state.theme);
      applyTextSize(state.textSize);
      const elMagic = document.getElementById('prefMagic');
      const elTheme = document.getElementById('prefTheme');
      const elSize = document.getElementById('prefTextSize');
      const elSizeVal = document.getElementById('prefTextSizeVal');
      if (elMagic) elMagic.checked = !!state.magic;
      if (elTheme) elTheme.value = state.theme === 'light' ? 'light' : 'dark';
      if (elSize) elSize.value = String(clamp(state.textSize));
      if (elSizeVal) elSizeVal.textContent = clamp(state.textSize) + 'px';
    }

    function loadLocal(){
      try {
        const theme = localStorage.getItem('prefs.theme');
        const textSize = Number(localStorage.getItem('prefs.textSize'));
        if (theme === 'light' || theme === 'dark') state.theme = theme;
        if (Number.isFinite(textSize)) state.textSize = clamp(textSize);
      } catch {}
    }
    async function loadServer(){
      try {
        const r = await fetch('/api/prefs');
        if (r.ok) {
          const p = await r.json();
          if (typeof p.magic === 'boolean') state.magic = p.magic;
          if (p.theme === 'light' || p.theme === 'dark') state.theme = p.theme;
          if (Number.isFinite(p.textSize)) state.textSize = clamp(p.textSize);
          applyAll();
        }
      } catch {}
    }

    function bindUI(){
      const elMagic = document.getElementById('prefMagic');
      const elTheme = document.getElementById('prefTheme');
      const elSize = document.getElementById('prefTextSize');
      const elSizeVal = document.getElementById('prefTextSizeVal');
      if (elMagic) elMagic.addEventListener('change', ()=>{ state.magic = !!elMagic.checked; saveServer({ magic: state.magic }); });
      if (elTheme) elTheme.addEventListener('change', ()=>{ state.theme = elTheme.value === 'light' ? 'light' : 'dark'; applyTheme(state.theme); saveServer({ theme: state.theme }); });
      if (elSize) elSize.addEventListener('input', ()=>{ const v = clamp(elSize.value); state.textSize = v; if (elSizeVal) elSizeVal.textContent = v + 'px'; applyTextSize(v); saveServerDebounced({ textSize: v }); });
    }

    // Initialize
    try { if (localStorage.getItem('prefs.open') === '1') document.body.classList.add('prefs-open'); } catch {}
    loadLocal();
    applyAll(); // immediate UX
    bindUI();
    loadServer(); // reconcile with server
    // expose minimal API if needed later
    window.Prefs = {
      get: ()=>({ ...state }),
      set: (p)=>{ Object.assign(state, p); applyAll(); saveServer(p); }
    };
  })();

  // Reactive updates via SSE
  try {
    const es = new EventSource('/api/events');
    let lastSeenMessageId = null;
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data || '{}');
        switch (msg.type) {
          case 'trees:created':
            refreshTrees();
            break;
          case 'command_logs:created':
            refreshLogs();
            break;
          case 'messages:created':
            refreshMessages();
            // also append into live stream (latest agent message)
            appendLatestAgentMessage();
            break;
          case 'deku_nuts:created':
            refreshNuts();
            break;
        }
      } catch {}
    };

    async function appendLatestAgentMessage(){
      try{
        const r = await fetch('/api/messages');
        const list = await r.json();
        const latest = list.find(x => x.role === 'agent');
        if (!latest) return;
        if (lastSeenMessageId === latest.id) return;
        lastSeenMessageId = latest.id;
        const mk = () => {
          const div = document.createElement('div');
          div.className = 'bubble';
          div.innerHTML = '<small>'+latest.createdAt+'</small>' +
            '<div>'+escapeHtml(String(latest.text || ''))+'</div>';
          return div;
        };
        // Append to main chat stream
        const box = document.getElementById('liveStream');
        if (box) {
          const d1 = mk();
          box.appendChild(d1);
          box.scrollTop = box.scrollHeight;
        }
        // Append to floating chat stream if present
        const floatBox = document.getElementById('liveStreamFloat');
        if (floatBox) {
          const d2 = mk();
          floatBox.appendChild(d2);
          floatBox.scrollTop = floatBox.scrollHeight;
        }
        // Also trigger a temporary popup in the 3D view above the heartbeat
        try {
          const txt = String(latest.text || '');
          const dur = Math.max(800, Math.min(8000, txt.length * 100));
          window.dispatchEvent(new CustomEvent('viz:popup', { detail: { text: txt, durationMs: dur } }));
        } catch {}
      }catch{}
    }
    function escapeHtml(s){
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    // chat input handlers
    async function sendChat(){
      const inp = document.getElementById('chatInput');
      const text = String(inp.value || '').trim();
      if (!text) return;
      inp.value = '';
      try {
        // forward to agent and persist via server
        await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
        // also log for terminal visibility
        await fetch('/api/command-logs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ command:'user_chat', payload:{ text } }) });
      } catch (e) {
        console.error('chat send failed', e);
      }
    }
    try {
      document.getElementById('chatSend').addEventListener('click', sendChat);
      document.getElementById('chatInput').addEventListener('keydown', (e)=>{ if (e.key==='Enter') sendChat(); });
      // Wire up floating chat controls if present
      const sendFloat = document.getElementById('chatSendFloat');
      const inputFloat = document.getElementById('chatInputFloat');
      if (sendFloat && inputFloat) {
        const sendFloatHandler = async () => {
          const text = String(inputFloat.value || '').trim();
          if (!text) return;
          inputFloat.value = '';
          try {
            await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
            await fetch('/api/command-logs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ command:'user_chat', payload:{ text } }) });
          } catch (e) {
            console.error('chat send failed (float)', e);
          }
        };
        sendFloat.addEventListener('click', sendFloatHandler);
        inputFloat.addEventListener('keydown', (e)=>{ if (e.key==='Enter') sendFloatHandler(); });
      }
    } catch {}
  } catch {}
  </script>
  <script type="module">
    import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';
    import { OrbitControls } from 'https://unpkg.com/three@0.161.0/examples/jsm/controls/OrbitControls.js';

    const POS_KEY = 'viz.positions.v1';
    let positions = {};
    try { positions = JSON.parse(localStorage.getItem(POS_KEY) || '{}') || {}; } catch { positions = {}; }
    const savePositions = () => { try { localStorage.setItem(POS_KEY, JSON.stringify(positions)); } catch {} };
    const getPos = (id) => {
      if (!positions[id]) {
        positions[id] = { x: (Math.random()-0.5)*240, y: 0, z: (Math.random()-0.5)*240 };
        savePositions();
      }
      return positions[id];
    };

    const container = document.getElementById('viewport3d');
    const overlay = document.getElementById('vizOverlay');
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0c10);
    const camera = new THREE.PerspectiveCamera(60, 16/9, 0.1, 2000);
    camera.position.set(120, 120, 120);
    // Reuse a single renderer across rebuilds; let Three create its own canvas to avoid context-type conflicts
    const g = window;
    g.__grove = g.__grove || {};
    let renderer;
    let controls;
    // Remove any stray canvas elements that might hold a 2D context from older builds
    try {
      const stale = Array.from(container.querySelectorAll('canvas'));
      for (const c of stale) {
        if (!g.__grove.dom || c !== g.__grove.dom) c.remove();
      }
    } catch {}
    if (g.__grove.renderer && g.__grove.dom && g.__grove.renderer instanceof THREE.WebGLRenderer) {
      renderer = g.__grove.renderer;
      controls = g.__grove.controls;
      if (g.__grove.dom.parentElement !== container) container.appendChild(g.__grove.dom);
    } else {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const dom = renderer.domElement;
      dom.style.width = '100%';
      dom.style.height = '100%';
      container.appendChild(dom);
      controls = new OrbitControls(camera, dom);
      g.__grove.renderer = renderer;
      g.__grove.dom = dom;
      g.__grove.controls = controls;
    }
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;

    // Floating draggable chat overlay (in-viewport)
    try {
      const float = document.createElement('div');
      float.id = 'chatFloating';
      float.style.position = 'absolute';
      float.style.top = '12px';
      float.style.right = '12px';
      float.style.width = '360px';
      float.style.maxHeight = '50%';
      float.style.display = 'flex';
      float.style.flexDirection = 'column';
      float.style.background = 'rgba(2,6,23,0.88)';
      float.style.backdropFilter = 'blur(6px)';
      float.style.border = '1px solid var(--border)';
      float.style.borderRadius = '10px';
      float.style.overflow = 'hidden';
      float.style.zIndex = '20';
      float.innerHTML = [
        '<div id="chatDragHandle" style="padding:10px; font-weight:600; color:var(--fg); border-bottom:1px solid var(--border); cursor:move; user-select:none">Chat</div>',
        '<div id="liveStreamFloat" style="flex:1; overflow:auto; padding:10px"></div>',
        '<div style="display:flex; gap:8px; padding:10px; border-top:1px solid var(--border)">',
        '  <input id="chatInputFloat" placeholder="Type a message (e.g., make a tree)" style="flex:1; padding:8px; background:#0f172a; color:var(--fg); border:1px solid var(--border); border-radius:6px" />',
        '  <button id="chatSendFloat">Send</button>',
        '</div>'
      ].join('');
      container.appendChild(float);

      // Draggable behavior within container bounds
      const handle = float.querySelector('#chatDragHandle');
      let dragging = false; let startX=0, startY=0; let origLeft=0, origTop=0;
      function onMove(e){ if(!dragging) return; if(e.cancelable) e.preventDefault();
        const p = (e.touches? e.touches[0] : e);
        const dx = p.clientX - startX;
        const dy = p.clientY - startY;
        const rect = container.getBoundingClientRect();
        const fw = float.offsetWidth; const fh = float.offsetHeight;
        const maxLeft = rect.width - fw; const maxTop = rect.height - fh;
        const newLeft = Math.min(Math.max(0, origLeft + dx), Math.max(0, maxLeft));
        const newTop = Math.min(Math.max(0, origTop + dy), Math.max(0, maxTop));
        float.style.left = newLeft + 'px';
        float.style.top = newTop + 'px';
        float.style.right = 'auto';
      }
      function onUp(){ dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.removeEventListener('touchmove', onMove); document.removeEventListener('touchend', onUp); }
      handle.addEventListener('mousedown', (e)=>{ dragging = true; startX = e.clientX; startY = e.clientY; const rect = float.getBoundingClientRect(); const crect = container.getBoundingClientRect(); origLeft = rect.left - crect.left; origTop = rect.top - crect.top; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); });
      handle.addEventListener('touchstart', (e)=>{ dragging = true; startX = e.touches[0].clientX; startY = e.touches[0].clientY; const rect = float.getBoundingClientRect(); const crect = container.getBoundingClientRect(); origLeft = rect.left - crect.left; origTop = rect.top - crect.top; document.addEventListener('touchmove', onMove, {passive:false}); document.addEventListener('touchend', onUp); });

      // Wire floating chat handlers (module scope ensures they exist)
      const sendFloat = float.querySelector('#chatSendFloat');
      const inputFloat = float.querySelector('#chatInputFloat');
      if (sendFloat && inputFloat) {
        /** @type {HTMLInputElement} */
        const inputEl = inputFloat;
        /** @type {HTMLElement} */
        const sendEl = sendFloat;
        const sendFloatHandler = async () => {
          const text = String((inputEl && inputEl.value) || '').trim();
          if (!text) return;
          if (inputEl) inputEl.value = '';
          try {
            await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
            await fetch('/api/command-logs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ command:'user_chat', payload:{ text } }) });
          } catch {}
        };
        sendEl.addEventListener('click', sendFloatHandler);
        inputEl.addEventListener('keydown', (e)=>{ if (e.key==='Enter') sendFloatHandler(); });
      }
    } catch {}

    // Grid + Axes
    const grid = new THREE.GridHelper(500, 50, 0x1f2937, 0x111827);
    scene.add(grid);
    const axes = new THREE.AxesHelper(60);
    axes.material.depthTest = false;
    axes.renderOrder = 2;
    scene.add(axes);

    // Lighting (subtle)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.6);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(100, 200, 100);
    scene.add(dir);

    function resize(){
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, true);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
    }
    // Observe both the container and the document body to respond to layout changes
    try { new ResizeObserver(resize).observe(container); } catch {}
    try { new ResizeObserver(resize).observe(document.body); } catch {}
    window.addEventListener('resize', resize);
    resize();

    // Dynamic group for entities
    const group = new THREE.Group();
    scene.add(group);

    // Heartbeat sphere (center pulse)
    const hbGeo = new THREE.SphereGeometry(3, 16, 12);
    const hbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.4, metalness: 0, roughness: 0.6 });
    const hb = new THREE.Mesh(hbGeo, hbMat);
    hb.position.set(0, 3, 0);
    scene.add(hb);
    let hbPulse = { value: 0, target: 0 };

    // Popup element above heartbeat
    const popup = document.createElement('div');
    popup.style.position = 'absolute';
    popup.style.padding = '10px 12px';
    popup.style.border = '1px solid var(--border)';
    popup.style.background = 'rgba(2,6,23,0.95)';
    popup.style.backdropFilter = 'blur(6px)';
    popup.style.color = 'var(--fg)';
    popup.style.borderRadius = '8px';
    popup.style.fontSize = '16px';
    popup.style.lineHeight = '1.2';
    popup.style.maxWidth = '72%';
    popup.style.boxShadow = '0 8px 24px rgba(0,0,0,0.45)';
    popup.style.pointerEvents = 'none';
    popup.style.transform = 'translate(-50%, -100%)';
    popup.style.display = 'none';
    container.appendChild(popup);
    let popupUntil = 0;
    function showPopup(text, durationMs){
      popup.textContent = String(text || '');
      popupUntil = Date.now() + Math.max(100, Number(durationMs)||1000);
      popup.style.display = 'block';
    }
    window.addEventListener('viz:popup', (e)=>{
      try {
        const d = (e && e.detail) || {};
        showPopup(d.text, d.durationMs);
      } catch {}
    });

    function clearGroup(){
      while(group.children.length) {
        const c = group.children.pop();
        if ((c).geometry) (c).geometry.dispose?.();
        if ((c).material) (c).material.dispose?.();
      }
    }

    async function loadData(){
      try{
        const [treesR, nutsR] = await Promise.all([
          fetch('/api/trees'),
          fetch('/api/deku-nuts')
        ]);
        const [treesJ, nutsJ] = await Promise.all([
          treesR.ok ? treesR.json() : Promise.resolve([]),
          nutsR.ok ? nutsR.json() : Promise.resolve([])
        ]);
        const trees = Array.isArray(treesJ) ? treesJ : [];
        const nuts = Array.isArray(nutsJ) ? nutsJ : [];
        return { trees, nuts };
      }catch{ return { trees: [], nuts: [] }; }
    }

    function addTree(id, name, height){
      const h = Math.max(4, Math.min(40, Number(height) || 10));
      const r = Math.max(1, Math.min(8, h * 0.2));
      const geo = new THREE.ConeGeometry(r, h, 8, 1, true);
      const mat = new THREE.MeshBasicMaterial({ color: 0x22c55e, wireframe: true });
      const mesh = new THREE.Mesh(geo, mat);
      const pos = getPos(id);
      mesh.position.set(pos.x, h/2, pos.z);
      mesh.userData = { id, type: 'tree', name, baseHeight: h, height: h };
      group.add(mesh);
    }

    function addNut(id){
      const geo = new THREE.SphereGeometry(2.2, 8, 6);
      const mat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, wireframe: true });
      const mesh = new THREE.Mesh(geo, mat);
      const pos = getPos(id);
      mesh.position.set(pos.x, 2.2, pos.z);
      mesh.userData = { id, type: 'deku' };
      group.add(mesh);
    }

    async function rebuild(){
      try{
        overlay.textContent = 'Loading 3D scene…';
        const { trees, nuts } = await loadData();
        clearGroup();
        for (const t of trees) addTree(t.id, t.name, t.height);
        for (const n of nuts) addNut(n.id);
        overlay.innerHTML = '<b>Entities:</b> ' + (trees.length + nuts.length) + ' &middot; ' +
          '<code>' + trees.length + '</code> trees, <code>' + nuts.length + '</code> nuts' +
          '<span id="sceneDesc" class="desc"></span>';
      }catch{
        overlay.textContent = 'Failed to load scene';
      }
    }

    // Basic picking (for future dragging)
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    function onClick(ev){
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(group.children);
      if (intersects.length){
        const obj = intersects[0].object;
        const ud = obj.userData || {};
        overlay.textContent = (ud.type||'?') + ' ' + (ud.id||'') + ' – ' + (ud.name||'');
      }
    }
    renderer.domElement.addEventListener('click', onClick);

    // SSE for live updates
    try{
      const es = new EventSource('/api/events');
      es.onmessage = (e)=>{
        try{
          const msg = JSON.parse(e.data || '{}');
          if (msg.type === 'trees:created' || msg.type === 'deku_nuts:created') {
            rebuild();
          }
        }catch{}
      };
    }catch{}

    window.addEventListener('viz:rebuild', rebuild);
    rebuild();

    // Simple rain particle system
    const rain = { active: false, until: 0, points: null };
    function startRain(durationMs=10000){
      if (rain.active) return;
      rain.active = true;
      rain.until = Date.now() + durationMs;
      const count = 800;
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);
      for (let i=0;i<count;i++){
        positions[i*3+0] = (Math.random()-0.5)*400;
        positions[i*3+1] = Math.random()*200 + 50;
        positions[i*3+2] = (Math.random()-0.5)*400;
      }
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({ color: 0x60a5fa, size: 1.5 });
      const pts = new THREE.Points(geo, mat);
      pts.userData.vy = -1.2;
      rain.points = pts;
      scene.add(pts);
    }
    function stopRain(){
      if (!rain.active) return;
      rain.active = false;
      rain.until = 0;
      if (rain.points){
        scene.remove(rain.points);
        if (rain.points.geometry) rain.points.geometry.dispose?.();
        if (rain.points.material) rain.points.material.dispose?.();
        rain.points = null;
      }
    }

    // Animation loop (guard to avoid multiple RAFs)
    if (!g.__grove.rafActive) {
      g.__grove.rafActive = true;
      function animate(){
        g.__grove.rafId = requestAnimationFrame(animate);
        // heartbeat visual easing
        hbPulse.value += (hbPulse.target - hbPulse.value) * 0.2;
        if (Math.abs(hbPulse.target - hbPulse.value) < 0.001) hbPulse.target = 0;
        const s = 1 + hbPulse.value * 0.25;
        hb.scale.set(s, s, s);
        hb.material.emissiveIntensity = 0.4 + hbPulse.value * 0.8;
        // position popup above hb in screen space while active
        if (popup.style.display !== 'none'){
          if (Date.now() > popupUntil) {
            popup.style.display = 'none';
          } else {
            const v = hb.position.clone();
            v.project(camera);
            const rect = renderer.domElement.getBoundingClientRect();
            const x = (v.x * 0.5 + 0.5) * rect.width;
            const y = (-v.y * 0.5 + 0.5) * rect.height;
            popup.style.left = x + 'px';
            popup.style.top = y + 'px';
          }
        }
        // rain update
        if (rain.active && rain.points) {
          const pos = rain.points.geometry.getAttribute('position');
          for (let i=0;i<pos.count;i++){
            let y = pos.getY(i) + (rain.points.userData.vy || -1.2);
            if (y < 0) y = Math.random()*200 + 50;
            pos.setY(i, y);
          }
          pos.needsUpdate = true;
          if (Date.now() >= rain.until) stopRain();
        }
        controls.update();
        renderer.render(scene, camera);
      }
      animate();
    }

    // Scheduler system
    const tasks = [];
    function renderSchedulers(tasks){
      const tbody = document.querySelector('#schedulers tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      for (const t of tasks) {
        const tr = document.createElement('tr');
        const tdRun = document.createElement('td');
        const tdName = document.createElement('td');
        const tdInt = document.createElement('td');
        const tdNext = document.createElement('td');
        const dot = document.createElement('span');
        dot.className = 'dot' + (t.active ? ' active' : '');
        dot.id = 'sched-dot-' + t.id;
        tdRun.appendChild(dot);
        tdName.textContent = t.name;
        tdInt.textContent = (t.intervalMs/1000).toFixed(0) + 's';
        tdNext.id = 'sched-next-' + t.id;
        tdNext.textContent = new Date(t.next).toLocaleTimeString();
        tr.appendChild(tdRun); tr.appendChild(tdName); tr.appendChild(tdInt); tr.appendChild(tdNext);
        tbody.appendChild(tr);
      }
    }
    function addTask(t){ tasks.push(t); }
    function flashDot(id){
      const dot = document.getElementById('sched-dot-' + id);
      if (!dot) return;
      dot.classList.add('active','flash');
      setTimeout(()=>dot.classList.remove('flash'), 300);
    }
    function updateNext(id, next){
      const td = document.getElementById('sched-next-' + id);
      if (td) td.textContent = new Date(next).toLocaleTimeString();
    }
    // Minimal heartbeat state (no description)
    let beat = 0;
    addTask({ id:'pulse', name:'Heartbeat', intervalMs:3000, next: Date.now()+3000, active:true, run:()=>{
      beat += 1;
      const d = document.getElementById('sceneDesc');
      if (d) d.textContent = '';
      hbPulse.target = 1; // trigger visual pulse
      // minimal heartbeat log to server for CLI visibility
      try { fetch('/api/command-logs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ command:'heartbeat', payload:{ beat, ts: Date.now() } }) }); } catch {}
    }});
    addTask({ id:'growth', name:'Grow trees (+0.1)', intervalMs:6000, next: Date.now()+6000, active:true, run:()=>{
      const box = new THREE.Box3();
      const size = new THREE.Vector3();
      for (const obj of group.children){
        if (obj.userData && obj.userData.type === 'tree'){
          if (!obj.userData.baseHeight) {
            box.setFromObject(obj);
            box.getSize(size);
            obj.userData.baseHeight = size.y || 10;
            obj.userData.height = obj.userData.baseHeight;
          }
          obj.userData.height += 0.1;
          const factor = obj.userData.height / obj.userData.baseHeight;
          obj.scale.y = factor;
          obj.position.y = obj.userData.height / 2;
        }
      }
    }});
    addTask({ id:'weather', name:'Weather check (rain 10%)', intervalMs:3000, next: Date.now()+3000, active:true, run:()=>{
      if (!rain.active && Math.random() < 0.10) startRain(10000);
    }});

    renderSchedulers(tasks);
    // heartbeat tick
    if (!g.__grove.scheduler){
      g.__grove.scheduler = setInterval(()=>{
        const now = Date.now();
        for (const t of tasks){
          if (now >= t.next){
            try { t.run(); } catch {}
            t.next = now + t.intervalMs;
            flashDot(t.id);
            updateNext(t.id, t.next);
          }
        }
      }, 500);
    }
  </script>
  <script
    src="https://worldtree.online/apps/worldtree-widget.js"
    data-minimized="true"
    data-follow="true"
    data-server="wss://worldtree.online"
    data-doc-id="ocv-comments"
    data-allow-server-switch="true">
  </script>
  </body>
  </html>`);
          return;
        }
        if (req.url === "/favicon.ico" && req.method === "GET") {
          res.writeHead(204, { "Content-Type": "image/x-icon" });
          res.end();
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
          const ping = setInterval(() => {
            try { res.write(`: ping\n\n`); } catch {}
          }, 30000);
          req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
          return;
        }

        if (req.url === "/api/trees" && req.method === "GET") {
          try {
            const out = runPsql(`SELECT row_to_json(t) FROM (
              SELECT id, name, height, properties, magic_number AS "magicNumber", created_at AS "createdAt" FROM trees ORDER BY created_at DESC LIMIT 200
            ) t;`);
            const rows = out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(rows));
          } catch (e:any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e?.message || e || 'unknown') }));
          }
          return;
        }

        if (req.url === "/api/trees" && req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
            const seed = typeof body === 'object' && body ? body : {};
            const candidate = await generateTreeViaOpenAI(seed);
            const saved = await insertTree(candidate);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(saved));
            broadcast('trees:created');
          } catch (e:any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e?.message || e || 'unknown') }));
          }
          return;
        }

        if (req.url === "/api/command-logs" && req.method === "GET") {
          const out = runPsql(`SELECT row_to_json(t) FROM (
            SELECT id, command, payload, created_at AS "createdAt" FROM command_logs ORDER BY created_at DESC LIMIT 200
          ) t;`);
          const rows = out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(rows));
          return;
        }
        if (req.url === "/api/command-logs" && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          const cmd = typeof body.command === 'string' ? body.command : 'unknown';
          const payload = body.payload ?? {};
          logCommand(cmd, payload);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          broadcast('command_logs:created');
          return;
        }

        if (req.url === "/api/messages" && req.method === "GET") {
          const out = runPsql(`SELECT row_to_json(t) FROM (
            SELECT id, role, text, meta, created_at AS "createdAt" FROM messages ORDER BY created_at DESC LIMIT 200
          ) t;`);
          const rows = out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(rows));
          return;
        }

        if (req.url === "/api/messages" && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          const role = typeof body.role === 'string' ? body.role : 'unknown';
          const text = typeof body.text === 'string' ? body.text : '';
          const meta = JSON.stringify(body.meta ?? {});
          runPsql(`INSERT INTO messages (role, text, meta) VALUES (
            ${sqlQuote(role)}, ${sqlQuote(text)}, ${sqlQuote(meta)}::jsonb
          );`);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          broadcast('messages:created');
          return;
        }

        // Preferences API
        if (req.url === "/api/prefs" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(preferences));
          return;
        }
        if (req.url === "/api/prefs" && req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
            if (typeof body.magic === 'boolean') preferences.magic = body.magic;
            if (body.theme === 'light' || body.theme === 'dark') preferences.theme = body.theme;
            if (Number.isFinite(body.textSize)) {
              const v = Math.max(12, Math.min(22, Number(body.textSize)));
              preferences.textSize = v;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, preferences }));
          } catch (e:any) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e?.message || e || 'invalid JSON') }));
          }
          return;
        }

        // Forward chat to agent and persist messages like CLI does
        if (req.url === "/api/chat" && req.method === "POST") {
          try {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
            const text = typeof body.text === 'string' ? body.text : '';
            // store user message
            runPsql(`INSERT INTO messages (role, text, meta) VALUES (
              ${sqlQuote('user')}, ${sqlQuote(text)}, '{}'::jsonb
            );`);
            broadcast('messages:created');
            // log receive
            runPsql(`INSERT INTO command_logs (command, payload) VALUES (
              ${sqlQuote('chat_receive')}, ${sqlQuote(JSON.stringify({ text }))}::jsonb
            );`);
            // forward to agent HTTP endpoint
            const agentIdRaw = (Array.isArray(characters) && characters[0] && (characters[0].name || 'Agent')) || 'Agent';
            const agentId = encodeURIComponent(String(agentIdRaw));
            const resp = await fetch(`http://localhost:${serverPort}/${agentId}/message`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, userId: 'user', userName: 'User' })
            });
            const data = await resp.json();
            // store each agent message
            if (Array.isArray(data)) {
              for (const m of data) {
                const t = String(m?.text || '');
                runPsql(`INSERT INTO messages (role, text, meta) VALUES (
                  ${sqlQuote('agent')}, ${sqlQuote(t)}, '{}'::jsonb
                );`);
              }
              broadcast('messages:created');
              runPsql(`INSERT INTO command_logs (command, payload) VALUES (
                ${sqlQuote('chat_forward_ok')}, ${sqlQuote(JSON.stringify({ agentId: decodeURIComponent(agentId), count: data.length }))}::jsonb
              );`);
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch (e:any) {
            try {
              runPsql(`INSERT INTO command_logs (command, payload) VALUES (
                ${sqlQuote('chat_forward_error')}, ${sqlQuote(JSON.stringify({ error: String(e?.message || e || 'unknown') }))}::jsonb
              );`);
            } catch {}
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: String(e?.message || e || 'unknown') }));
          }
          return;
        }

        if (req.url === "/api/deku-nuts" && req.method === "GET") {
          const out = runPsql(`SELECT row_to_json(t) FROM (
            SELECT id, base, properties, created_at AS "createdAt" FROM deku_nuts ORDER BY created_at DESC LIMIT 200
          ) t;`);
          const rows = out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(rows));
          return;
        }

        if (req.url === "/api/deku-nuts" && req.method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          const id = typeof body.id === 'string' ? body.id : undefined;
          const base = Number.isFinite(body.base) ? Number(body.base) : null;
          const propsJson = JSON.stringify(body.properties ?? {});
          if (id) {
            runPsql(`INSERT INTO deku_nuts (id, base, properties) VALUES (
              ${sqlQuote(id)}, ${base === null ? 'NULL' : String(base)}, ${sqlQuote(propsJson)}::jsonb
            ) ON CONFLICT (id) DO NOTHING;`);
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          broadcast('deku_nuts:created');
          return;
        }

        res.statusCode = 404; res.end("Not found");
      } catch (e:any) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      }
    });
    server.listen(inspectorPort, () => {
      elizaLogger.log(`Inspector at http://localhost:${inspectorPort}/inspector`);
    });

    // Scheduled World Tree nudge every 10 seconds (library + exotic mode)
    try {
      let nudgeCount = 0;
      setInterval(async () => {
        try {
          nudgeCount += 1;
          const agentIdRaw = (Array.isArray(characters) && characters[0] && (characters[0].name || 'Agent')) || 'Agent';
          const agentId = encodeURIComponent(String(agentIdRaw));
          // pick next line
          const item = shuffledWorldTree[worldTreeIdx % shuffledWorldTree.length];
          worldTreeIdx++;
          const exotic = Math.random() < 1/20;
          const baseText = item.text;
          const text = exotic ? `${baseText}\n\nenhance this with magic` : baseText;
          const isCommand = /^COMMAND:\s*/.test(baseText) || item.type === 'worldbuilding';
          const shouldSend = isCommand || exotic;
          // persist synthetic user message
          runPsql(`INSERT INTO messages (role, text, meta) VALUES (
            ${sqlQuote('user')}, ${sqlQuote(text)}, ${sqlQuote(JSON.stringify({ source: 'scheduler', nudge: nudgeCount, type: item.type, exotic, sent: shouldSend }))}::jsonb
          );`);
          broadcast('messages:created');
          if (!shouldSend) {
            runPsql(`INSERT INTO command_logs (command, payload) VALUES (
              ${sqlQuote('nudge_skip')}, ${sqlQuote(JSON.stringify({ reason: 'non_command_non_exotic', nudge: nudgeCount, type: item.type }))}::jsonb
            );`);
            broadcast('command_logs:created');
          } else {
            runPsql(`INSERT INTO command_logs (command, payload) VALUES (
              ${sqlQuote('nudge_send')}, ${sqlQuote(JSON.stringify({ agentId: decodeURIComponent(agentId), nudge: nudgeCount, type: item.type, exotic }))}::jsonb
            );`);
            broadcast('command_logs:created');

            // forward to agent
            const resp = await fetch(`http://localhost:${serverPort}/${agentId}/message`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text, userId: 'scheduler', userName: 'Scheduler' })
            });
            const data = await resp.json();
            if (Array.isArray(data)) {
              for (const m of data) {
                const t = String(m?.text || '');
                runPsql(`INSERT INTO messages (role, text, meta) VALUES (
                  ${sqlQuote('agent')}, ${sqlQuote(t)}, ${sqlQuote(JSON.stringify({ source: 'scheduler', nudge: nudgeCount, type: item.type, exotic }))}::jsonb
                );`);
              }
              broadcast('messages:created');
              runPsql(`INSERT INTO command_logs (command, payload) VALUES (
                ${sqlQuote('nudge_reply')}, ${sqlQuote(JSON.stringify({ agentId: decodeURIComponent(agentId), count: data.length, nudge: nudgeCount, type: item.type, exotic }))}::jsonb
              );`);
              broadcast('command_logs:created');
            }
          }
        } catch (e:any) {
          try {
            runPsql(`INSERT INTO command_logs (command, payload) VALUES (
              ${sqlQuote('nudge_error')}, ${sqlQuote(JSON.stringify({ error: String(e?.message || e || 'unknown') }))}::jsonb
            );`);
            broadcast('command_logs:created');
          } catch {}
        }
      }, 10000);
    } catch {}
  }

  startInspector();

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
