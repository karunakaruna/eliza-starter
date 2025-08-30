import { settings } from "@elizaos/core";
import readline from "readline";
import crypto from "crypto";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

function makeDekuNut(baseValue?: number) {
  const now = new Date().toISOString();
  const rand = crypto.randomBytes(16).toString("hex");
  const id = crypto
    .createHash("sha256")
    .update(`${now}:${rand}`)
    .digest("hex");
  return {
    name: "deku nut",
    id,
    base: typeof baseValue === "number" && !Number.isNaN(baseValue) ? baseValue : 1,
    createdAt: now,
  };
}

async function postJson(url: string, body: any) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    // best-effort only for inspector logging/persistence
  }
}

function parseTreeSeedFromText(text: string): any | undefined {
  // Try to extract a JSON object if present in the message
  const m = text.match(/\{[\s\S]*\}$/);
  if (!m) return undefined;
  try { return JSON.parse(m[0]); } catch { return undefined; }
}

// Extract a requested count for trees, e.g., "make 3 trees", "plant 2 saplings"
function countTrees(text: string): number {
  const t = text.toLowerCase();
  const m = t.match(/(?:make|create|generate|produce|spawn|plant|grow|seed|sprout|raise)\s+(\d{1,3})\s+(trees|saplings)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > 0 && n <= 100) return n; // simple guardrail
  }
  return 1;
}

// Expand a grove/forest plan into discrete tree seed payloads
function expandGrovePlan(plan: any): any[] {
  if (!plan || typeof plan !== 'object') return [];
  const types: string[] = Array.isArray(plan.tree_types) ? plan.tree_types : (plan.species ? [String(plan.species)] : []);
  const total: number = Number(plan.count ?? plan.total ?? 0);
  const perType: number = Number(plan.per_type ?? 0);
  const companion = plan.companions;
  const location = plan.location ?? plan.placement;

  const seeds: any[] = [];
  const typesSafe = types.length ? types : ['mystic'];
  if (perType && perType > 0) {
    for (const t of typesSafe) {
      for (let i = 0; i < perType; i++) {
        seeds.push({ seed: { species: t, placement: location, companions: companion } });
      }
    }
    return seeds;
  }
  if (total && total > 0) {
    // Distribute roughly evenly across types
    for (let i = 0; i < total; i++) {
      const t = typesSafe[i % typesSafe.length];
      seeds.push({ seed: { species: t, placement: location, companions: companion } });
    }
    return seeds;
  }
  // Default: one per listed type (or one mystic tree)
  for (const t of typesSafe) {
    seeds.push({ seed: { species: t, placement: location, companions: companion } });
  }
  if (!types.length) return seeds.slice(0, 1);
  return seeds;
}

type ExplicitCmd = { kind: 'tree' | 'deku'; action?: string; payload?: any };
// Find explicit COMMAND lines (supports multiple per message)
function findExplicitCommands(text: string): ExplicitCmd[] {
  const cmds: ExplicitCmd[] = [];
  const lines = String(text || '').split(/\n+/);
  for (const line of lines) {
    const l = line.trim();
    // Accept COMMAND: TREE, COMMAND: TREE.SOMETHING, COMMAND: DEKU, COMMAND: DEKU.SOMETHING
    const m = l.match(/^command\s*:\s*(tree(?:\.[A-Z_]+)?|deku(?:\.[A-Z_]+)?)\b\s*(\{[\s\S]*\})?$/i);
    if (m) {
      const raw = m[1].toLowerCase();
      const kind = raw.startsWith('tree') ? 'tree' : 'deku';
      const action = raw.includes('.') ? raw.split('.')[1] : undefined; // e.g., grow_grove
      let payload: any | undefined;
      if (m[2]) {
        try { payload = JSON.parse(m[2]); } catch {}
      }
      cmds.push({ kind, action, payload });
    }
  }
  return cmds;
}

// Extract a requested count for deku nuts, e.g., "make 3 deku nuts"
function countDeku(text: string): number {
  const t = text.toLowerCase();
  const m = t.match(/(?:make|create|generate|produce|spawn)\s+(\d{1,3})\s+deku\s+nuts?\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > 0 && n <= 100) return n;
  }
  return 1;
}

function wantsDeku(text: string): boolean {
  const t = text.toLowerCase();
  // Avoid triggering on negations like "don't make a deku"
  const negation = /(don't|do not|never|no)\s+(make|create|generate|produce|spawn)\b/;
  if (negation.test(t)) return false;
  return /(make|create|generate|produce|spawn)\s+(a\s+)?(deku|teku)\b/.test(t) || /\bdeku\b/.test(t);
}

function wantsTree(text: string): boolean {
  const t = text.toLowerCase();
  // Avoid triggering on negations like "don't make a tree"
  const negation = /(don't|do not|never|no)\s+(make|create|generate|produce|spawn)\b/;
  if (negation.test(t)) return false;
  const verbs = /(make|create|generate|produce|spawn|plant|grow|seed|sprout|raise)\s+(a\s+)?(tree|sapling)\b/;
  return verbs.test(t) || /^tree\b/.test(t) || /\bplant\s+(a\s+)?sapling\b/.test(t);
}

async function handleUserInput(input, agentId) {
  if (input.toLowerCase() === "exit") {
    rl.close();
    process.exit(0);
  }

  try {
    // Natural language hooks: allow phrases like "make a tree" / "make a deku"
    // to directly execute without requiring the exact local command syntax.
    const lower = String(input || '').toLowerCase();
    const explicit = findExplicitCommands(input);
    if (explicit.length) {
      for (const cmd of explicit) {
        if (cmd.kind === 'tree') {
          // If it's a grove/forest template, expand into multiple trees
          const action = (cmd.action || '').toUpperCase();
          if (action === 'GROW_GROVE' || action === 'GROW_FOREST') {
            const seeds = expandGrovePlan(cmd.payload || {});
            let i = 0;
            for (const seed of seeds) {
              i++;
              postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'user-nl', seed, index: i, total: seeds.length, action } });
              try {
                const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
                const tree = await res.json();
                console.log('Agent:', JSON.stringify(tree, null, 2));
                postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id}) [${i}/${seeds.length}]`, meta: { id: tree.id, index: i, total: seeds.length } });
              } catch (e) { console.error('Error generating grove trees from user explicit intent:', e); }
            }
          } else {
            const seed = (cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : (parseTreeSeedFromText(input) || {});
            postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'user-nl', seed } });
            try {
              const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
              const tree = await res.json();
              console.log('Agent:', JSON.stringify(tree, null, 2));
              postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id})`, meta: { id: tree.id } });
            } catch (e) { console.error('Error generating tree from user NL explicit intent:', e); }
          }
        } else if (cmd.kind === 'deku') {
          const dekuNut = makeDekuNut(undefined);
          console.log("Agent:", JSON.stringify(dekuNut, null, 2));
          postJson('http://localhost:3300/api/deku-nuts', { id: dekuNut.id, base: dekuNut.base, properties: { name: dekuNut.name, createdAt: dekuNut.createdAt, source: 'user-nl' } });
          postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: { from: 'user-nl' } });
          postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Deku nut created ${dekuNut.id}`, meta: { base: dekuNut.base } });
        }
      }
      return; // handled explicitly
    }
    // Chain detection first: run both kinds in textual order if both present
    if (wantsTree(lower) && wantsDeku(lower)) {
      const idxTree = lower.search(/tree|sapling/);
      const idxDeku = lower.search(/\bdeku\b/);
      const order: ('tree'|'deku')[] = idxTree < idxDeku ? ['tree','deku'] : ['deku','tree'];
      for (const kind of order) {
        if (kind === 'tree') {
          const n = countTrees(lower);
          for (let i = 0; i < n; i++) {
            const seed = parseTreeSeedFromText(input) || {};
            postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'user-nl', seed, index: i + 1, total: n } });
            try {
              const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
              const tree = await res.json();
              console.log('Agent:', JSON.stringify(tree, null, 2));
              postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id})${n>1?` [${i+1}/${n}]`:''}`, meta: { id: tree.id, index: i + 1, total: n } });
            } catch (e) { console.error('Error generating tree(s) from user NL chain:', e); }
          }
        } else {
          const nD = countDeku(lower);
          for (let i = 0; i < nD; i++) {
            const dekuNut = makeDekuNut(undefined);
            console.log("Agent:", JSON.stringify(dekuNut, null, 2));
            postJson('http://localhost:3300/api/deku-nuts', { id: dekuNut.id, base: dekuNut.base, properties: { name: dekuNut.name, createdAt: dekuNut.createdAt, source: 'user-nl', index: i + 1, total: nD } });
            postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: { from: 'user-nl', index: i + 1, total: nD } });
            postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Deku nut created ${dekuNut.id}${nD>1?` [${i+1}/${nD}]`:''}`, meta: { base: dekuNut.base, index: i + 1, total: nD } });
          }
        }
      }
      return;
    }
    // Counted trees: "make 3 trees"
    if (wantsTree(lower)) {
      const n = countTrees(lower);
      for (let i = 0; i < n; i++) {
        const seed = parseTreeSeedFromText(input) || {};
        postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'user-nl', seed, index: i + 1, total: n } });
        try {
          const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
          const tree = await res.json();
          console.log('Agent:', JSON.stringify(tree, null, 2));
          postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id}) [${i + 1}/${n}]`, meta: { id: tree.id, index: i + 1, total: n } });
        } catch (e) { console.error('Error generating tree(s) from user NL intent:', e); }
      }
      return; // Do not forward to LLM
    }
    if (wantsDeku(lower)) {
      const nD = countDeku(lower);
      for (let i = 0; i < nD; i++) {
        const dekuNut = makeDekuNut(undefined);
        console.log("Agent:", JSON.stringify(dekuNut, null, 2));
        postJson('http://localhost:3300/api/deku-nuts', { id: dekuNut.id, base: dekuNut.base, properties: { name: dekuNut.name, createdAt: dekuNut.createdAt, source: 'user-nl', index: i + 1, total: nD } });
        postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: { from: 'user-nl', index: i + 1, total: nD } });
        postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Deku nut created ${dekuNut.id}${nD>1?` [${i+1}/${nD}]`:''}`, meta: { base: dekuNut.base, index: i + 1, total: nD } });
      }
      return;
    }
    // Simple chain: if both appear, do them in order of appearance
    if (wantsTree(lower) || wantsDeku(lower)) {
      const idxTree = lower.search(/tree|sapling/);
      const idxDeku = lower.search(/\bdeku\b/);
      const order: ('tree'|'deku')[] = [];
      if (idxTree >= 0 && idxDeku >= 0) order.push(idxTree < idxDeku ? 'tree' : 'deku', idxTree < idxDeku ? 'deku' : 'tree');
      else if (idxTree >= 0) order.push('tree');
      else if (idxDeku >= 0) order.push('deku');
      for (const kind of order) {
        if (kind === 'tree') {
          const seed = parseTreeSeedFromText(input) || {};
          postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'user-nl', seed } });
          try {
            const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
            const tree = await res.json();
            console.log('Agent:', JSON.stringify(tree, null, 2));
            postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id})`, meta: { id: tree.id } });
          } catch (e) { console.error('Error generating tree from user NL chain:', e); }
        } else {
          const dekuNut = makeDekuNut(undefined);
          console.log("Agent:", JSON.stringify(dekuNut, null, 2));
          postJson('http://localhost:3300/api/deku-nuts', { id: dekuNut.id, base: dekuNut.base, properties: { name: dekuNut.name, createdAt: dekuNut.createdAt, source: 'user-nl' } });
          postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: { from: 'user-nl' } });
          postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Deku nut created ${dekuNut.id}`, meta: { base: dekuNut.base } });
        }
      }
      if (order.length) return;
    }

    // Local command hook: "tree" optionally with a JSON payload
    // Usage examples:
    //  - tree
    //  - tree {"seed":"oak","heightHint":10}
    const treeMatch = input.trim().match(/^tree(?:\s+(\{[\s\S]*\}))?$/i);
    if (treeMatch) {
      let payload: any = {};
      if (treeMatch[1]) {
        try { payload = JSON.parse(treeMatch[1]); } catch { payload = {}; }
      }
      // log command best-effort
      postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload });
      try {
        const res = await fetch('http://localhost:3300/api/trees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        console.log('Agent:', JSON.stringify(data, null, 2));
      } catch (e) {
        console.error('Error calling tree generator:', e);
      }
      return; // Do not forward to LLM
    }

    // Local command hook: "deku" or "deku <number>"
    const dekuMatch = input.trim().match(/^deku(?:\s+(\d+(?:\.\d+)?))?$/i);
    if (dekuMatch) {
      const baseArg = dekuMatch[1] ? Number(dekuMatch[1]) : undefined;
      const dekuNut = makeDekuNut(baseArg);
      console.log("Agent:", JSON.stringify(dekuNut, null, 2));
      // persist deku nut and log command best-effort
      postJson('http://localhost:3300/api/deku-nuts', {
        id: dekuNut.id,
        base: dekuNut.base,
        properties: { name: dekuNut.name, createdAt: dekuNut.createdAt }
      });
      postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: dekuNut });
      return; // Do not forward to LLM
    }

    const serverPort = parseInt(settings.SERVER_PORT || "3000");

    // record user message best-effort
    postJson('http://localhost:3300/api/messages', { role: 'user', text: String(input), meta: { agentId } });

    const response = await fetch(
      `http://localhost:${serverPort}/${agentId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: input,
          userId: "user",
          userName: "User",
        }),
      }
    );

    const data = await response.json();
    for (const message of data) {
      console.log(`${"Agent"}: ${message.text}`);
      // record agent message best-effort
      postJson('http://localhost:3300/api/messages', { role: 'agent', text: String(message?.text ?? ''), meta: { agentId } });
      // Agent intent detection: allow agent to "use commands"
      const txt = String(message?.text ?? '');
      // Support explicit command notations from the agent
      const explicitTree = /\bcommand\s*:\s*tree\b/i.test(txt) || /\btree\s*:/i.test(txt);
      const explicitDeku = /\bcommand\s*:\s*deku\b/i.test(txt) || /\bdeku\s*:/i.test(txt);

      // First, handle multiple explicit COMMAND lines in order (if present)
      const explicitCmds = findExplicitCommands(txt);
      if (explicitCmds.length) {
        for (const cmd of explicitCmds) {
          if (cmd.kind === 'deku') {
            const dekuNut = makeDekuNut(undefined);
            console.log("Agent:", JSON.stringify(dekuNut, null, 2));
            postJson('http://localhost:3300/api/deku-nuts', { id: dekuNut.id, base: dekuNut.base, properties: { name: dekuNut.name, createdAt: dekuNut.createdAt, source: 'agent-intent' } });
            postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: { from: 'agent-intent' } });
            postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Deku nut created ${dekuNut.id}`, meta: { base: dekuNut.base } });
          } else if (cmd.kind === 'tree') {
            const action = (cmd.action || '').toUpperCase();
            if (action === 'GROW_GROVE' || action === 'GROW_FOREST') {
              const seeds = expandGrovePlan(cmd.payload || {});
              let i = 0;
              for (const seed of seeds) {
                i++;
                postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'agent-intent', seed, index: i, total: seeds.length, action } });
                try {
                  const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
                  const tree = await res.json();
                  console.log('Agent:', JSON.stringify(tree, null, 2));
                  postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id}) [${i}/${seeds.length}]`, meta: { id: tree.id, index: i, total: seeds.length } });
                } catch (e) { console.error('Error generating grove trees from agent explicit intent:', e); }
              }
            } else {
              const seed = (cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : (parseTreeSeedFromText(txt) || {});
              postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'agent-intent', seed } });
              try {
                const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
                const tree = await res.json();
                console.log('Agent:', JSON.stringify(tree, null, 2));
                postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id})`, meta: { id: tree.id } });
              } catch (e) { console.error('Error generating tree from agent explicit intent:', e); }
            }
          }
        }
        continue; // proceed to next message
      }
      // Then handle chained natural-language intents in order if both appear
      if (wantsTree(txt) && wantsDeku(txt)) {
        const idxTree = txt.toLowerCase().search(/tree|sapling/);
        const idxDeku = txt.toLowerCase().search(/\bdeku\b/);
        const order: ('tree'|'deku')[] = idxTree < idxDeku ? ['tree','deku'] : ['deku','tree'];
        for (const kind of order) {
          if (kind === 'deku') {
            const nD = countDeku(txt);
            for (let i = 0; i < nD; i++) {
              const dekuNut = makeDekuNut(undefined);
              console.log("Agent:", JSON.stringify(dekuNut, null, 2));
              postJson('http://localhost:3300/api/deku-nuts', { id: dekuNut.id, base: dekuNut.base, properties: { name: dekuNut.name, createdAt: dekuNut.createdAt, source: 'agent-intent', index: i + 1, total: nD } });
              postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: { from: 'agent-intent', index: i + 1, total: nD } });
              postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Deku nut created ${dekuNut.id}${nD>1?` [${i+1}/${nD}]`:''}`, meta: { base: dekuNut.base, index: i + 1, total: nD } });
            }
          } else {
            const n = countTrees(txt);
            for (let i = 0; i < n; i++) {
              const seed = parseTreeSeedFromText(txt) || {};
              postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'agent-intent', seed, index: i + 1, total: n } });
              try {
                const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
                const tree = await res.json();
                console.log('Agent:', JSON.stringify(tree, null, 2));
                postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id})${n>1?` [${i+1}/${n}]`:''}`, meta: { id: tree.id, index: i + 1, total: n } });
              } catch (e) { console.error('Error generating tree(s) from agent chain:', e); }
            }
          }
        }
        continue;
      }

      if (explicitDeku || wantsDeku(txt)) {
        const dekuNut = makeDekuNut(undefined);
        console.log("Agent:", JSON.stringify(dekuNut, null, 2));
        postJson('http://localhost:3300/api/deku-nuts', {
          id: dekuNut.id,
          base: dekuNut.base,
          properties: { name: dekuNut.name, createdAt: dekuNut.createdAt, source: 'agent-intent' }
        });
        postJson('http://localhost:3300/api/command-logs', { command: 'deku', payload: { from: 'agent-intent' } });
        postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Deku nut created ${dekuNut.id}`, meta: { base: dekuNut.base } });
      } else if (explicitTree || wantsTree(txt)) {
        // Support quantity: "make 3 trees"
        const n = countTrees(txt);
        if (n > 1) {
          for (let i = 0; i < n; i++) {
            const seed = parseTreeSeedFromText(txt) || {};
            postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'agent-intent', seed, index: i + 1, total: n } });
            try {
              const res = await fetch('http://localhost:3300/api/trees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });
              const tree = await res.json();
              console.log('Agent:', JSON.stringify(tree, null, 2));
              postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id}) [${i + 1}/${n}]`, meta: { id: tree.id, index: i + 1, total: n } });
            } catch (e) { console.error('Error generating multiple trees from agent intent:', e); }
          }
        } else {
        const seed = parseTreeSeedFromText(txt) || {};
        postJson('http://localhost:3300/api/command-logs', { command: 'tree', payload: { from: 'agent-intent', seed } });
        try {
          const res = await fetch('http://localhost:3300/api/trees', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed)
          });
          const tree = await res.json();
          console.log('Agent:', JSON.stringify(tree, null, 2));
          postJson('http://localhost:3300/api/messages', { role: 'agent', text: `Created tree ${tree.name} (id ${tree.id})`, meta: { id: tree.id } });
        } catch (e) {
          console.error('Error generating tree from agent intent:', e);
        }
        }
      }
    }
  } catch (error) {
    console.error("Error fetching response:", error);
  }
}

export function startChat(characters) {
  function chat() {
    const agentId = characters[0].name ?? "Agent";
    rl.question("You: ", async (input) => {
      await handleUserInput(input, agentId);
      if (input.toLowerCase() !== "exit") {
        chat(); // Loop back to ask another question
      }
    });
  }

  return chat;
}
