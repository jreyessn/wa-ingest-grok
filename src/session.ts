import { log } from "./log.js";
import type { WahaClient, WahaSession } from "./waha/client.js";

/** Return the live session. Create and start it only when it is missing or stopped. */
export async function activeSession(waha: WahaClient): Promise<WahaSession> {
  const current = await waha.getSession();
  if (!current || current.status === "STOPPED") return waha.ensureSession();
  return current;
}

/**
 * Login recovery. A FAILED session (WEBJS auth timeout) stays failed until it is
 * stopped and started again; STOPPED needs the same pair so the QR can appear.
 */
export async function sessionForLogin(waha: WahaClient): Promise<WahaSession> {
  const current = await waha.getSession();
  if (!current) return waha.ensureSession();
  if (current.status === "FAILED" || current.status === "STOPPED") {
    log("info", "waha.session.restart", { name: current.name, status: current.status });
    return waha.restartSession();
  }
  return current;
}
