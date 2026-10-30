// Open the player's default browser at our own localhost URL (and nothing else).
import { spawn } from "node:child_process";

export function openBrowser(url, { platform = process.platform, run = spawn } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(url)) throw new Error("refusing to open a non-local URL");
  const [cmd, args] =
    platform === "win32" ? ["cmd", ["/c", "start", "", url]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = run(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on?.("error", () => {});
  child.unref?.();
  return [cmd, ...args];
}
