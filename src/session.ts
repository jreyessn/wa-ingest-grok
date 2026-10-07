import type { WahaClient, WahaSession } from "./waha/client.js";

/** Return the live session. Create and start it only when it is missing or stopped. */
export async function activeSession(waha: WahaClient): Promise<WahaSession> {
  const current = await waha.getSession();
  if (!current || current.status === "STOPPED") return waha.ensureSession();
  return current;
}
