import { createHash } from "node:crypto";
import type { RepoAlias } from "../config.js";
import type { MessageType } from "../parse/messages.js";

export const TOO_LARGE_NOTE = "too_large";

export interface OutboundMessage {
  id: string;
  author: string;
  timestamp: string;
  type: MessageType;
  text: string | null;
  transcript: string | null;
  mime_type: string | null;
  file_name: string | null;
  data_base64: string | null;
  note: typeof TOO_LARGE_NOTE | null;
  reply_to: string | null;
}

export interface WebhookPayload {
  source: "whatsapp";
  group: string;
  repo?: string;
  batch_id: string;
  messages: OutboundMessage[];
}

export function batchIdFor(group: string, messageIds: string[]): string {
  const hash = createHash("sha256");
  hash.update(group);
  hash.update("\n");
  for (const id of [...messageIds].sort()) {
    hash.update(id);
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** First configured alias that appears as a literal substring of a message's text. */
export function detectRepo(messages: Array<{ text: string | null }>, aliases: RepoAlias[]): string | undefined {
  for (const message of messages) {
    if (!message.text) continue;
    for (const alias of aliases) {
      if (message.text.includes(alias.alias)) return alias.repo;
    }
  }
  return undefined;
}

export function buildPayload(input: {
  group: string;
  messages: OutboundMessage[];
  aliases: RepoAlias[];
}): WebhookPayload | null {
  if (input.messages.length === 0) return null;
  const repo = detectRepo(input.messages, input.aliases);
  const payload: WebhookPayload = {
    source: "whatsapp",
    group: input.group,
    batch_id: batchIdFor(
      input.group,
      input.messages.map((message) => message.id),
    ),
    messages: input.messages,
  };
  if (repo) payload.repo = repo;
  return payload;
}
