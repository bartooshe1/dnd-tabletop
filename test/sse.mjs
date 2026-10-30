// Tiny SSE client for tests: plays the browser page against the game server.
export async function connectSse(url, { headers = {} } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const events = [];
  const waiters = [];
  const out = { status: res.status, events, close: () => ctrl.abort() };
  if (res.status !== 200) return out;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (!type || !data) continue;
          const ev = { type, data: JSON.parse(data) };
          events.push(ev);
          for (const w of [...waiters]) if (w.match(ev)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(ev);
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  /** Resolve with the first event (already seen after `from`, or future) matching type/predicate. */
  out.next = (type, pred = () => true, { from = 0, timeout = 5000 } = {}) => {
    const match = (ev) => ev.type === type && pred(ev.data);
    const seen = events.slice(from).find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i !== -1) {
          waiters.splice(i, 1);
          reject(new Error(`timed out waiting for ${type}`));
        }
      }, timeout);
    });
  };
  return out;
}

export function post(origin, p, body, { token, originHeader = origin, contentType = "application/json" } = {}) {
  return fetch(new URL(p, origin), {
    method: "POST",
    headers: { "content-type": contentType, ...(token ? { "x-dnd-token": token } : {}), ...(originHeader ? { origin: originHeader } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}
