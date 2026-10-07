import type { WebhookPayload } from "../payload/format.js";

const DEFAULT_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;

export class PermanentWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentWebhookError";
  }
}

export async function postWebhook(input: {
  url: string;
  payload: WebhookPayload;
  header: { name: string; value: string };
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  onRetry?: (info: { attempt: number; status?: number; error?: string; delayMs: number }) => void;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = input.maxAttempts ?? DEFAULT_ATTEMPTS;
  let lastError = "webhook request failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(input.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.payload.batch_id,
          [input.header.name]: input.header.value,
        },
        body: JSON.stringify(input.payload),
      });
      if (response.ok) return;
      const body = redact(await response.text(), input.header.value);
      lastError = `webhook responded ${response.status}: ${truncate(body)}`;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw new PermanentWebhookError(lastError);
      if (attempt === maxAttempts) break;
      const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      input.onRetry?.({ attempt, status: response.status, delayMs });
      await sleep(delayMs);
    } catch (err) {
      if (err instanceof PermanentWebhookError) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === maxAttempts) break;
      const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      input.onRetry?.({ attempt, error: lastError, delayMs });
      await sleep(delayMs);
    }
  }
  throw new Error(`webhook failed after ${maxAttempts} attempts: ${lastError}`);
}

function redact(body: string, secret: string): string {
  if (!secret) return body;
  return body.split(secret).join("[redacted]");
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}
