import type { AppConfig } from "./config.js";
import { JsonCursorStore } from "./cursor/store.js";
import { errorMessage, log } from "./log.js";
import { extractAudio } from "./media/ffmpeg.js";
import { OpenAiWhisperTranscriber } from "./media/openai-whisper.js";
import type { Transcriber } from "./media/transcriber.js";
import { extractPdfText } from "./pdf/extract.js";
import { S3Storage } from "./storage/s3.js";
import { WahaClient } from "./waha/client.js";
import { activeSession } from "./session.js";
import { postWebhook } from "./webhook/client.js";
import { runCycle, type CycleDeps } from "./cycle.js";

export interface Runtime {
  config: AppConfig;
  waha: WahaClient;
  cycle: CycleDeps;
}

export function createRuntime(config: AppConfig): Runtime {
  const waha = new WahaClient(config.wahaUrl, config.wahaSession, config.wahaApiKey);
  const transcriber: Transcriber | null = config.openaiApiKey
    ? new OpenAiWhisperTranscriber(config.openaiApiKey)
    : null;
  const storage = config.storage ? new S3Storage(config.storage) : null;
  const cycle: CycleDeps = {
    config,
    listMessages: (chatId, since) => waha.listMessages(chatId, since),
    refetchMedia: (chatId, messageId) => waha.getMessageMedia(chatId, messageId),
    download: (url) => waha.download(url),
    cursor: JsonCursorStore.forDataDir(config.dataDir),
    transcriber,
    extractAudio,
    storage,
    extractPdfText,
    postWebhook: async (payload, header) => {
      if (!config.webhookUrl) throw new Error("Missing required environment variable GROKBOT_WEBHOOK_URL");
      await postWebhook({
        url: config.webhookUrl,
        payload,
        header,
        onRetry: (info) => log("warn", "webhook.retry", { batch_id: payload.batch_id, ...info }),
      });
    },
  };
  return { config, waha, cycle };
}

export async function runOnce(runtime: Runtime): Promise<void> {
  const session = await activeSession(runtime.waha);
  if (session.status !== "WORKING") {
    throw new Error(`WAHA session status is ${session.status}. Run npm run login and scan the QR code first.`);
  }
  const result = await runCycle(runtime.cycle);
  log("info", "cycle.done", { sent: result.sent, count: result.count, batch_id: result.batchId ?? null });
}

export function logFailure(msg: string, err: unknown): void {
  log("error", msg, { error: errorMessage(err) });
}
