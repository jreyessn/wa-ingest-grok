import type { AppConfig } from "./config.js";
import { JsonCursorStore } from "./cursor/store.js";
import { errorMessage, log } from "./log.js";
import { extractAudio } from "./media/ffmpeg.js";
import { OpenAiCompatibleTranscriber } from "./media/openai-compatible.js";
import { SpeachesModels } from "./media/speaches-model.js";
import type { Transcriber } from "./media/transcriber.js";
import { extractPdfText } from "./pdf/extract.js";
import { WahaClient } from "./waha/client.js";
import { activeSession } from "./session.js";
import { postWebhook } from "./webhook/client.js";
import { runCycle, type CycleDeps } from "./cycle.js";

export interface Runtime {
  config: AppConfig;
  waha: WahaClient;
  cycle: CycleDeps;
  /** No-op unless TRANSCRIBE_PROVIDER=speaches. Does not throw when Whisper is down. */
  ensureWhisperModel: () => Promise<void>;
}

export function createTranscriber(config: AppConfig): Transcriber | null {
  return createTranscriberWithModels(config).transcriber;
}

function createTranscriberWithModels(config: AppConfig): { transcriber: Transcriber | null; models: SpeachesModels | null } {
  if (config.transcribeProvider === "openai") {
    if (!config.openaiApiKey) {
      log("warn", "transcriber.openai_key_missing");
      return { transcriber: null, models: null };
    }
    return {
      transcriber: new OpenAiCompatibleTranscriber({
        name: "openai-whisper",
        baseUrl: "https://api.openai.com/v1",
        model: "whisper-1",
        apiKey: config.openaiApiKey,
      }),
      models: null,
    };
  }
  const models = new SpeachesModels({
    baseUrl: config.whisperBaseUrl,
    model: config.whisperModel,
    apiKey: config.whisperApiKey,
  });
  return {
    transcriber: new OpenAiCompatibleTranscriber({
      name: "speaches",
      baseUrl: config.whisperBaseUrl,
      model: config.whisperModel,
      apiKey: config.whisperApiKey,
      prepareModel: () => models.ensureInstalled(),
      reinstallModel: () => models.reinstall(),
    }),
    models,
  };
}

export function createRuntime(config: AppConfig): Runtime {
  const waha = new WahaClient(config.wahaUrl, config.wahaSession, config.wahaApiKey);
  const { transcriber, models } = createTranscriberWithModels(config);
  const cycle: CycleDeps = {
    config,
    listMessages: (chatId, since) => waha.listMessages(chatId, since),
    refetchMedia: (chatId, messageId) => waha.getMessageMedia(chatId, messageId),
    download: (url, maxBytes) => waha.download(url, maxBytes),
    cursor: JsonCursorStore.forDataDir(config.dataDir),
    transcriber,
    extractAudio,
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
  return {
    config,
    waha,
    cycle,
    ensureWhisperModel: async () => {
      if (!models) return;
      try {
        await models.ensureInstalled();
      } catch (err) {
        log("warn", "whisper.model_check_failed", {
          model: config.whisperModel,
          error: errorMessage(err),
          note: "will retry before the next transcription",
        });
      }
    },
  };
}

export async function runOnce(runtime: Runtime): Promise<void> {
  await runtime.ensureWhisperModel();
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
