/**
 * A server-sent events reader over a fetch body (the stream needs the
 * Authorization header, which EventSource can't send). Follows the
 * text/event-stream format: `event:`, `data:` (lines joined), `id:`,
 * `retry:`, comments (`: hb`) ignored, a blank line ends a message.
 */

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export interface SseHandlers {
  onMessage: (m: SseMessage) => void;
  /** the server's `retry:` in milliseconds */
  onRetry?: (ms: number) => void;
  /** any bytes arrived (a heartbeat comment counts): the stream is alive */
  onActivity?: () => void;
}

/** Read until the stream ends (resolves) or breaks (rejects). */
export async function readSse(body: ReadableStream<Uint8Array>, h: SseHandlers, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel);
  let buf = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  const line = (raw: string): void => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === "") {
      if (data.length > 0) h.onMessage({ event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
      event = "";
      data = [];
      id = undefined;
      return;
    }
    if (l.startsWith(":")) return;
    const c = l.indexOf(":");
    const field = c < 0 ? l : l.slice(0, c);
    const value = c < 0 ? "" : l.slice(c + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    else if (field === "retry" && /^\d+$/.test(value)) h.onRetry?.(Number(value));
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      h.onActivity?.();
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
