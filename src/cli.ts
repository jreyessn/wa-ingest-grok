import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { printQr } from "./qr.js";
import { createRuntime, logFailure, runOnce } from "./runtime.js";
import { activeSession } from "./session.js";

const command = process.argv[2];

try {
  if (command === "login") await login();
  else if (command === "groups") await groups();
  else if (command === "once") await once();
  else {
    console.error("Usage: node dist/cli.js <login|groups|once>");
    process.exitCode = 1;
  }
} catch (err) {
  logFailure("cli.failed", err);
  process.exitCode = 1;
}

async function login(): Promise<void> {
  const runtime = createRuntime(loadConfig("login"));
  let lastQr: string | null = null;
  for (;;) {
    const session = await activeSession(runtime.waha);
    log("info", "waha.session", { name: session.name, status: session.status });
    if (session.status === "WORKING") {
      log("info", "login.ready", { session: session.name });
      return;
    }
    if (session.status === "FAILED") {
      throw new Error("WAHA session status is FAILED");
    }
    if (session.status === "SCAN_QR_CODE") {
      lastQr = await printQr(runtime.waha, lastQr);
    }
    await delay(3000);
  }
}

async function groups(): Promise<void> {
  const runtime = createRuntime(loadConfig("groups"));
  const session = await activeSession(runtime.waha);
  if (session.status !== "WORKING") {
    throw new Error(`WAHA session status is ${session.status}. Run npm run login and scan the QR code first.`);
  }
  const list = await runtime.waha.listGroups();
  if (list.length === 0) {
    log("info", "groups.empty");
    return;
  }
  for (const group of list) {
    console.log(`${group.id}\t${group.name}`);
  }
  log("info", "groups.listed", { count: list.length });
}

async function once(): Promise<void> {
  const runtime = createRuntime(loadConfig("worker"));
  await runOnce(runtime);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
