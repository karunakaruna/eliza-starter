import { settings } from "@elizaos/core";
import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.on("SIGINT", () => {
  rl.close();
  process.exit(0);
});

async function handleUserInput(input, agentId) {
  if (input.toLowerCase() === "exit") {
    rl.close();
    process.exit(0);
  }

  const serverPort = parseInt(settings.SERVER_PORT || "3000");
  const url = `http://localhost:${serverPort}/${agentId}/message`;
  const payload = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: input, userId: "user", userName: "User" }),
  } as const;

  // Allow slow local models: 5 minute headers timeout
  async function tryOnce() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      const response = await fetch(url, { ...payload, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      data.forEach((message) => console.log(`${"Agent"}: ${message.text}`));
      return true;
    } catch (e: any) {
      clearTimeout(timer);
      const msg = String(e?.message || e || "unknown error");
      if (/aborted|timeout|Headers Timeout/i.test(msg)) {
        return false; // signal we can retry once
      }
      console.error("Error fetching response:", e);
      return true; // do not retry for non-timeout errors
    }
  }

  // First attempt
  const ok = await tryOnce();
  if (!ok) {
    console.log("(Slow model detected; retrying request once…)");
    await tryOnce();
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
