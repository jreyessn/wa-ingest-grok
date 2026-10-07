import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createRuntime, logFailure } from "./runtime.js";
import { runCycle } from "./cycle.js";
import { printQr } from "./qr.js";
import { activeSession } from "./session.js";

// Login must work before a group is chosen, so the loop stays up without WAHA_GROUP_ID.
const config = loadConfig("login");
const runtime = createRuntime(config);
let stopped = false;
let lastQr: string | null = null;

process.on("SIGTERM", () => {
  stopped = true;
  log("info", "worker.shutdown");
});
process.on("SIGINT", () => {
  stopped = true;
  log("info", "worker.shutdown");
});

log("info", "worker.start", {
  wahaUrl: config.wahaUrl,
  session: config.wahaSession,
  group: config.wahaGroupId,
  intervalMinutes: config.intervalMinutes,
  transcriber: runtime.cycle.transcriber?.name ?? null,
  storage: Boolean(config.storage),
});

while (!stopped) {
  try {
    const session = await activeSession(runtime.waha);
    log("info", "waha.session", { name: session.name, status: session.status });
    if (session.status === "SCAN_QR_CODE") {
      lastQr = await printQr(runtime.waha, lastQr);
      log("warn", "waha.needs_login", { hint: "npm run login" });
    } else if (session.status !== "WORKING") {
      log("warn", "waha.not_ready", { status: session.status });
    } else if (!config.wahaGroupId || !config.webhookUrl) {
      log("warn", "worker.waiting_for_config", {
        hasGroup: Boolean(config.wahaGroupId),
        hasWebhook: Boolean(config.webhookUrl),
      });
    } else {
      await runCycle(runtime.cycle);
    }
  } catch (err) {
    logFailure("cycle.failed", err);
  }
  if (stopped) break;
  await sleep(config.intervalMinutes * 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (stopped || Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}
