// Shared glue for both cards: App connection, view extraction, small DOM helpers.
import { App } from "@modelcontextprotocol/ext-apps";
export { h, reducedMotion } from "./dom.js";

export const VIEW_KEY = "dnd-tabletop/view";

/** The card payload travels in _meta (never in model context). */
export function viewOf(result) {
  return result?._meta?.[VIEW_KEY] ?? null;
}

export function createApp(name, displayModes = ["inline"]) {
  return new App({ name, version: "0.1.0" }, { availableDisplayModes: displayModes }, { autoResize: true });
}

/** Put the player's words into the chat. Resolves true if the host took it. */
export async function say(app, text) {
  try {
    const res = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    return !res?.isError;
  } catch {
    return false;
  }
}

/**
 * Older cards stay in the transcript. Each card announces the server time of its data (`at`);
 * a card that hears a newer one goes inert so a stale click can't send a stale intent, and a
 * newer card answers an older one (e.g. re-mounted after scrolling). No-op where unsupported.
 */
export function watchSupersede(channel, at, onOlder) {
  if (typeof at !== "number") return;
  try {
    const bc = new BroadcastChannel(channel);
    bc.onmessage = (e) => {
      const other = e.data?.at;
      if (typeof other !== "number") return;
      if (other > at) onOlder();
      else if (other < at) bc.postMessage({ at });
    };
    bc.postMessage({ at });
  } catch {
    /* sandbox without BroadcastChannel */
  }
}
