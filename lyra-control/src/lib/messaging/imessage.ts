/**
 * iMessage channel — sends messages via the `imsg` CLI binary.
 * imsg is installed at /opt/homebrew/bin/imsg and communicates with Messages.app.
 *
 * NOTE: `imsg send` blocks waiting for a delivery receipt from Messages.app.
 * We spawn it detached and kill after 5s — if no error by then, the message
 * was handed off to Messages.app successfully.
 */

import { spawn } from "child_process";

const IMSG_PATH = "/opt/homebrew/bin/imsg";

/**
 * Normalize phone number — ensure it has + prefix and country code.
 */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.startsWith("+")) return phone;
  // Assume US if 10 digits without country code
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export async function sendIMessage(
  phoneNumber: string,
  message: string
): Promise<void> {
  const normalized = normalizePhone(phoneNumber);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(IMSG_PATH, ["send", "--to", normalized, "--text", message], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (e) => {
      reject(new Error(`iMessage send failed: ${e.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0 && stderr) {
        reject(new Error(`iMessage send failed: ${stderr.trim()}`));
      } else {
        resolve();
      }
    });

    // If still running after 5s, message was handed off to Messages.app — success
    setTimeout(() => {
      child.kill();
      resolve();
    }, 5_000);
  });
}
