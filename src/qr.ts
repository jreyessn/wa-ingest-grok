import qrcode from "qrcode-terminal";
import { log } from "./log.js";
import type { WahaClient } from "./waha/client.js";

export async function printQr(waha: WahaClient, previous: string | null): Promise<string | null> {
  try {
    const value = await waha.getQrValue();
    if (value === previous) return previous;
    log("info", "qr.updated", { hint: "scan with WhatsApp → Linked devices" });
    console.log("\nScan this QR code with WhatsApp (Linked devices):\n");
    qrcode.generate(value, { small: true });
    console.log("");
    return value;
  } catch (err) {
    log("warn", "qr.unavailable", { error: err instanceof Error ? err.message : String(err) });
    return previous;
  }
}
