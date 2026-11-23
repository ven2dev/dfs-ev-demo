import { createParser } from "eventsource-parser";

const MAX_EVENT_CHARACTERS = 65_536;
const FEED_CHARACTERS = 8_192;
const AUTH_TIMEOUT_MS = 5_000;

export const retryAfterMs = (value: string | null): number | undefined =>
  value !== null && /^\d+$/.test(value.trim())
    ? Math.min(Number(value.trim()), 300) * 1_000 : undefined;

type FailureReason = "aborted" | "idle" | "http-temporary" | "invalid-response"
  | "parser-overflow" | "malformed-json" | "eof" | "network";
export type LiveStreamFailure = { reason: FailureReason; retry: boolean; after?: number };
export type LiveStreamAttempt = { close: () => void; done: Promise<void> };

class StreamFailure extends Error {
  constructor(readonly reason: FailureReason, readonly retry: boolean, readonly after?: number) {
    super(reason);
  }
}

/** One attempt only. The hook owns reconnection and stale-state timers. */
export const openLiveStream = (dependencies: {
  url: string;
  getHeaders: () => Promise<HeadersInit>;
  fetch: typeof fetch;
  isCurrent: () => boolean;
  onOpen: () => void;
  onData: (value: Record<string, unknown>) => void;
  onFailure: (failure: LiveStreamFailure) => void;
}): LiveStreamAttempt => {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | null = null;
  let cancelling: Promise<unknown> | undefined;
  const current = () => !controller.signal.aborted && dependencies.isCurrent();
  const cancelReader = () => {
    if (reader && !cancelling) cancelling = reader.cancel().catch(() => undefined);
  };
  const close = () => {
    controller.abort();
    cancelReader();
  };
  const headers = () => new Promise<HeadersInit>((resolve, reject) => {
    let finished = false;
    const abort = () => finish(undefined, new StreamFailure("aborted", false));
    const finish = (value?: HeadersInit, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const timer = setTimeout(() => {
      if (current()) console.warn("[live-stream] token-unavailable");
      finish({});
    }, AUTH_TIMEOUT_MS);
    controller.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(dependencies.getHeaders).then(value => finish(value), () => {
      if (finished) return;
      if (current()) console.warn("[live-stream] token-unavailable");
      finish({});
    });
  });

  const done = Promise.resolve().then(async () => {
    try {
      if (!current()) return;
      const auth = await headers();
      if (!current()) return;
      const requestHeaders = new Headers(auth);
      requestHeaders.set("Accept", "text/event-stream");
      const response = await dependencies.fetch(dependencies.url, {
        headers: requestHeaders, signal: controller.signal,
        cache: "no-store", credentials: "same-origin", redirect: "error",
      });
      body = response.body;
      if (!current()) return;
      if (response.status === 204) throw new StreamFailure("idle", false);
      if (response.status !== 200) {
        throw new StreamFailure("http-temporary", response.status === 429 || response.status >= 500,
          response.status === 429 || response.status === 503
            ? retryAfterMs(response.headers.get("retry-after")) : undefined);
      }
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream" || !body) {
        throw new StreamFailure("invalid-response", false);
      }
      const parser = createParser({
        maxBufferSize: MAX_EVENT_CHARACTERS,
        onEvent: event => {
          if (!current() || (event.event && event.event !== "message")) return;
          // The parser's pending-buffer bound alone does not bound a completed event.
          if (event.data.length > MAX_EVENT_CHARACTERS) throw new StreamFailure("parser-overflow", false);
          let value: unknown;
          try { value = JSON.parse(event.data); }
          catch { throw new StreamFailure("malformed-json", false); }
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new StreamFailure("malformed-json", false);
          }
          dependencies.onData(value as Record<string, unknown>);
        },
        onError: error => {
          // Unknown fields and invalid SSE retry hints remain ignorable SSE input.
          if (error.type === "max-buffer-size-exceeded") throw new StreamFailure("parser-overflow", false);
        },
      });
      const decoder = new TextDecoder();
      reader = body.getReader();
      dependencies.onOpen();
      while (current()) {
        const item = await reader.read();
        if (!current()) return;
        // Do not consume an incomplete event at EOF.
        if (item.done) throw new StreamFailure("eof", true);
        const text = decoder.decode(item.value, { stream: true });
        for (let offset = 0; offset < text.length && current(); offset += FEED_CHARACTERS) {
          parser.feed(text.slice(offset, offset + FEED_CHARACTERS));
        }
      }
    } catch (error) {
      if (current()) {
        const failure = error instanceof StreamFailure ? error : new StreamFailure("network", true);
        dependencies.onFailure({ reason: failure.reason, retry: failure.retry, after: failure.after });
      }
    } finally {
      if (reader) {
        cancelReader();
        await cancelling;
        reader.releaseLock();
      } else await body?.cancel().catch(() => undefined);
    }
  });
  return { close, done };
};
