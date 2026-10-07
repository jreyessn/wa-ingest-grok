import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Cursor } from "../parse/messages.js";

export interface CursorStore {
  load(): Promise<Cursor | null>;
  save(cursor: Cursor): Promise<void>;
}

function isCursor(value: unknown): value is Cursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Cursor;
  return (
    typeof cursor.lastTimestamp === "number" &&
    Number.isFinite(cursor.lastTimestamp) &&
    Array.isArray(cursor.seenIdsAtTimestamp) &&
    cursor.seenIdsAtTimestamp.every((id) => typeof id === "string")
  );
}

export class JsonCursorStore implements CursorStore {
  constructor(private readonly filePath: string) {}

  static forDataDir(dataDir: string): JsonCursorStore {
    return new JsonCursorStore(join(dataDir, "cursor.json"));
  }

  async load(): Promise<Cursor | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isCursor(parsed)) {
        throw new Error(`Cursor file ${this.filePath} is not a valid cursor`);
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(cursor: Cursor): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(cursor));
    await rename(tmp, this.filePath);
  }
}
