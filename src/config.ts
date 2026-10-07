export interface RepoAlias {
  alias: string;
  repo: string;
}

export interface StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
  expiresSeconds: number;
}

export interface AppConfig {
  wahaUrl: string;
  wahaApiKey?: string;
  wahaSession: string;
  wahaGroupId?: string;
  intervalMinutes: number;
  openaiApiKey?: string;
  webhookUrl?: string;
  webhookKey: string;
  webhookHeader: string;
  repoAliases: RepoAlias[];
  dataDir: string;
  storage?: StorageConfig;
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

function booleanEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function loadStorage(env: NodeJS.ProcessEnv): StorageConfig | undefined {
  const bucket = optional(env, "STORAGE_BUCKET");
  const accessKeyId = optional(env, "STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = optional(env, "STORAGE_SECRET_ACCESS_KEY");
  if (!bucket && !accessKeyId && !secretAccessKey && !optional(env, "STORAGE_ENDPOINT")) {
    return undefined;
  }
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, and STORAGE_SECRET_ACCESS_KEY must all be set to upload files",
    );
  }
  const endpoint = optional(env, "STORAGE_ENDPOINT");
  let prefix = optional(env, "STORAGE_PREFIX") ?? "wa-ingest/";
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return {
    endpoint,
    region: optional(env, "STORAGE_REGION") ?? "auto",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: booleanEnv(env, "STORAGE_FORCE_PATH_STYLE", Boolean(endpoint)),
    prefix,
    expiresSeconds: positiveNumber(env, "STORAGE_URL_EXPIRES_SECONDS", 60 * 60 * 24 * 7),
  };
}

export function loadConfig(mode: ConfigMode, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    wahaUrl: (optional(env, "WAHA_URL") ?? "http://localhost:3000").replace(/\/+$/, ""),
    wahaApiKey: optional(env, "WAHA_API_KEY"),
    wahaSession: optional(env, "WAHA_SESSION") ?? "default",
    wahaGroupId: optional(env, "WAHA_GROUP_ID"),
    intervalMinutes: positiveNumber(env, "INTERVAL_MINUTES", 5),
    openaiApiKey: optional(env, "OPENAI_API_KEY"),
    webhookUrl: optional(env, "GROKBOT_WEBHOOK_URL"),
    webhookKey: optional(env, "GROKBOT_WEBHOOK_KEY") ?? "",
    webhookHeader: optional(env, "GROKBOT_WEBHOOK_HEADER") ?? DEFAULT_WEBHOOK_HEADER,
    repoAliases: parseRepoAliases(optional(env, "REPO_ALIASES")),
    dataDir: optional(env, "DATA_DIR") ?? "/data",
    storage: loadStorage(env),
  };
  if (mode === "worker") {
    if (!config.wahaGroupId) throw new Error("Missing required environment variable WAHA_GROUP_ID");
    if (!config.webhookUrl) throw new Error("Missing required environment variable GROKBOT_WEBHOOK_URL");
  }
  return config;
}
