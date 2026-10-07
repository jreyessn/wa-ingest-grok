import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFMPEG_TIMEOUT_MS = 60_000;

/** Extract the audio track from a video buffer. Frames are not decoded for analysis. */
export async function extractAudio(video: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "wa-ingest-"));
  const input = join(dir, "input");
  const output = join(dir, "audio.mp3");
  try {
    await writeFile(input, video);
    await runFfmpeg([
      "-y",
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "mp3",
      output,
    ]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
}
