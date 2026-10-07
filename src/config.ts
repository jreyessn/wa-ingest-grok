export interface RepoAlias {
  alias: string;
  repo: string;
}

export type TranscribeProvider = "speaches" | "openai";

export const DEFAULT_WHISPER_MODEL = "Systran/faster-whisper-base";
export const DEFAULT_WHISPER_BASE_URL = "http://localhost:8000/v1";

export interface AppConfig {
  wahaUrl: string;
  wahaApiKey?: string;
  wahaSession: string;
  wahaGroupId?: string;
  intervalMinutes: number;
  transcribeProvider: TranscribeProvider;
  whisperBaseUrl: string;
  whisperModel: string;
  whisperApiKey?: string;
  openaiApiKey?: string;
  maxInlineFileMb: number;
  webhookUrl?: string;
  webhookKey: string;
  webhookHeader: string;
  repoAliases: RepoAlias[];
  dataDir: string;
}

export const DEFAULT_WEBHOOK_HEADER = "Authorization: Bearer ${GROKBOT_WEBHOOK_KEY}";

export type ConfigMode = "worker" | "login" | "groups";

export function parseRepoAliases(raw: string | undefined): RepoAlias[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((entry) => {
      const idx = entry.indexOf("=");
      if (idx <= 0 || idx === entry.length - 1) {
        throw new Error(`Invalid REPO_ALIASES entry "${entry}". Expected alias=owner/repo.`);
      }
      const alias = entry.slice(0, idx).trim();
      const repo = entry.slice(idx + 1).trim();
      if (!alias || !repo) {
        throw new Error(`Invalid REPO_ALIASES entry "${entry}". Expected alias=owner/repo.`);
      }
      return { alias, repo };
    });
}

export function buildWebhookHeader(
  template: string | undefined,
  key: string,
): { name: string; value: string } {
  const raw = template?.trim() ? template.trim() : DEFAULT_WEBHOOK_HEADER;
  const substituted = raw.replaceAll("${GROKBOT_WEBHOOK_KEY}", key);
  const colon = substituted.indexOf(":");
  if (colon === -1) {
    const name = substituted.trim();
    if (!name) throw new Error("GROKBOT_WEBHOOK_HEADER is empty");
    return { name, value: key };
  }
  const name = substituted.slice(0, colon).trim();
  const value = substituted.slice(colon + 1).trim();
  if (!name) throw new Error("GROKBOT_WEBHOOK_HEADER is missing a header name");
  return { name, value };
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function transcribeProvider(env: NodeJS.ProcessEnv): TranscribeProvider {
  const raw = optional(env, "TRANSCRIBE_PROVIDER") ?? "speaches";
  if (raw === "speaches" || raw === "openai") return raw;
  throw new Error("TRANSCRIBE_PROVIDER must be speaches or openai");
}

export function loadConfig(mode: ConfigMode, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    wahaUrl: (optional(env, "WAHA_URL") ?? "http://localhost:3000").replace(/\/+$/, ""),
    wahaApiKey: optional(env, "WAHA_API_KEY"),
    wahaSession: optional(env, "WAHA_SESSION") ?? "default",
    wahaGroupId: optional(env, "WAHA_GROUP_ID"),
    intervalMinutes: positiveNumber(env, "INTERVAL_MINUTES", 5),
    transcribeProvider: transcribeProvider(env),
    whisperBaseUrl: (optional(env, "WHISPER_BASE_URL") ?? DEFAULT_WHISPER_BASE_URL).replace(/\/+$/, ""),
    whisperModel: optional(env, "WHISPER_MODEL") ?? DEFAULT_WHISPER_MODEL,
    whisperApiKey: optional(env, "WHISPER_API_KEY"),
    openaiApiKey: optional(env, "OPENAI_API_KEY"),
    maxInlineFileMb: positiveNumber(env, "MAX_INLINE_FILE_MB", 5),
    webhookUrl: optional(env, "GROKBOT_WEBHOOK_URL"),
    webhookKey: optional(env, "GROKBOT_WEBHOOK_KEY") ?? "",
    webhookHeader: optional(env, "GROKBOT_WEBHOOK_HEADER") ?? DEFAULT_WEBHOOK_HEADER,
    repoAliases: parseRepoAliases(optional(env, "REPO_ALIASES")),
    dataDir: optional(env, "DATA_DIR") ?? "/data",
  };
  if (mode === "worker") {
    if (!config.wahaGroupId) throw new Error("Missing required environment variable WAHA_GROUP_ID");
    if (!config.webhookUrl) throw new Error("Missing required environment variable GROKBOT_WEBHOOK_URL");
  }
  return config;
}
