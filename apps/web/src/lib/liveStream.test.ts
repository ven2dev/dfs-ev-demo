import { describe, it, expect, vi, afterEach } from 'vitest';
import { openLiveStream, retryAfterMs, type LiveStreamFailure } from './liveStream';
const encoded = (text: string) => new TextEncoder().encode(text);
const response = (chunks: Uint8Array[], headers: Record<string, string> = {}) => new Response(
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }),
  { headers: { 'content-type': 'text/event-stream', ...headers } },
);
const run = async (chunks: Uint8Array[]) => {
  const data: Record<string, unknown>[] = [], failures: LiveStreamFailure[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response(chunks));
  const stream = openLiveStream({ url: '/api/stream?eventId=fixture', getHeaders: async () => ({ Authorization: 'Bearer synthetic' }), fetch, isCurrent: () => true, onOpen: () => { }, onData: v => data.push(v), onFailure: f => failures.push(f) });
  await stream.done;
  return { data, failures, fetch };
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('223-live-auth-stream parser and attempt work', () => {
  it('every byte split preserves UTF-8, BOM, CRLF and a complete event exactly once', async () => {
      const message = { type: 'tick', name: 'Jalapeño 🏈' };
      const bytes = encoded('\ufeff:comment\r\nunknown: ignored\r\ndata: ' + JSON.stringify(message) + '\r\n\r\n');
      for (let i = 0; i <= bytes.length; i++) {
          const r = await run([bytes.slice(0, i), bytes.slice(i)]);
          expect(r.data).toEqual([message]);
          expect(r.failures.map(f => f.reason)).toEqual(['eof']);
      }
      console.info('Q0_PARSER_WORK', JSON.stringify({ byteSplitCases: bytes.length + 1, eventsPerCase: 1 }));
  });
  it('the canonical 2KiB tick survives every encoded frame split without loss or duplication', async () => {
      const payload = { type: 'tick', propId: 'fixture:player_pass_yds:Fixture:over:book', sampleWindow: 5, timestamp: 100, line: 10,
          quote: { bookmakerKey: 'book', price: 2 }, evScore: { edge: .1, impliedProb: .5 }, stages: { baseRate: .5 }, player: 'Fixture ñ 🏈', padding: '' };
      payload.padding = 'x'.repeat(2048 - encoded(JSON.stringify(payload)).length);
      expect(encoded(JSON.stringify(payload)).length).toBe(2048);
      const bytes = encoded('data: ' + JSON.stringify(payload) + '\n\n');
      for (let i = 0; i <= bytes.length; i++) {
          const r = await run([bytes.slice(0, i), bytes.slice(i)]);
          expect(r.data).toEqual([payload]);
      }
      console.info('Q0_REPRESENTATIVE_FRAME', JSON.stringify({ payloadBytes: 2048, byteSplitCases: bytes.length + 1, eventsPerCase: 1 }));
  });
  it('one-byte chunks, multiline JSON, LF/lone CR, named events and incomplete EOF', async () => {
      const text = 'event: other\ndata: {"wrong":true}\n\n' + 'data: {"type":\rdata: "tick"}\r\r' + 'data: {"unfinished":true}';
      const r = await run([...encoded(text)].map(n => new Uint8Array([n])));
      expect(r.data).toEqual([{ type: 'tick' }]);
  });
  it('bad JSON/oversized events terminate once; no automatic provider/network retry in reader', async () => {
      for (const [text, reason] of [['data: not-json\n\n', 'malformed-json'], ['data: null\n\n', 'malformed-json'], ['data: []\n\n', 'malformed-json'], ['data: ' + 'x'.repeat(65537) + '\n\n', 'parser-overflow'], ['data: ' + 'x'.repeat(65537), 'parser-overflow']]) {
          const r = await run([encoded(text)]);
          expect(r.data).toEqual([]);
          expect(r.failures.map(f => f.reason)).toEqual([reason]);
          expect(r.fetch).toHaveBeenCalledTimes(1);
      }
  });
  it('exact parser limit accepts 65536 JSON data characters, rejects 65537', async () => {
      for (const n of [65536, 65537]) {
          const r = await run([encoded('data: ' + JSON.stringify({ x: 'x'.repeat(n - 8) }) + '\n\n')]);
          expect(r.data.length).toBe(n === 65536 ? 1 : 0);
      }
  });
  it.each([[null, undefined], ['0', 0], ['45', 45000], ['300', 300000], ['301', 300000], ['999999999999999999999', 300000], [' 12 ', 12000], ['1.5', undefined], ['-1', undefined], ['1e2', undefined], ['Mon, 23 Nov 2026 12:00:00 GMT', undefined], ['bad', undefined]])('Retry-After %s => %s', (value, want) => expect(retryAfterMs(value)).toBe(want));
  it.each([[204, 'idle', false], [400, 'http-temporary', false], [429, 'http-temporary', true], [503, 'http-temporary', true]])('HTTP %s classifies without an opened reader', async (status, reason, retry) => {
      const onFailure = vi.fn(), onOpen = vi.fn();
      const stream = openLiveStream({ url: '/api/stream', getHeaders: async () => ({}), fetch: vi.fn(async () => new Response(null, { status, headers: { 'Retry-After': '600' } })) as typeof globalThis.fetch, isCurrent: () => true, onOpen, onData: vi.fn(), onFailure });
      await stream.done;
      expect(onOpen).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason, retry }));
      if (status === 429 || status === 503)
          expect(onFailure.mock.calls[0][0].after).toBe(300000);
  });
  it('wrong media type is terminal, including an SSE-prefix impostor', async () => {
      for (const type of ['application/json', 'text/event-streaming']) {
          const onFailure = vi.fn();
          const s = openLiveStream({ url: '/api/stream', getHeaders: async () => ({}), fetch: vi.fn(async () => new Response('{}', { headers: { 'Content-Type': type } })) as typeof globalThis.fetch, isCurrent: () => true, onOpen: vi.fn(), onData: vi.fn(), onFailure });
          await s.done;
          expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'invalid-response', retry: false }));
      }
  });
  it('delayed auth cancelled before settlement makes zero fetches or late deliveries', async () => {
      let finish!: (headers: HeadersInit) => void;
      const getHeaders = vi.fn(() => new Promise<HeadersInit>(r => { finish = r; })), fetch = vi.fn(), onData = vi.fn(), onFailure = vi.fn();
      const s = openLiveStream({ url: '/api/stream', getHeaders, fetch, isCurrent: () => true, onOpen: vi.fn(), onData, onFailure });
      await Promise.resolve();
      await Promise.resolve();
      s.close();
      await s.done;
      finish({ Authorization: 'Bearer late-synthetic' });
      await Promise.resolve();
      expect(fetch).not.toHaveBeenCalled();
      expect(onData).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
  });
  it('auth rejection or 5s timeout yields one anonymous attempt and reason-only warning', async () => {
      for (const timeout of [false, true]) {
          vi.useFakeTimers();
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
          let late: ((headers: HeadersInit) => void) | undefined;
          const headers = vi.fn(timeout ? () => new Promise<HeadersInit>(r => { late = r; }) : async () => { throw Error('private SDK details'); });
          const fetch = vi.fn<typeof globalThis.fetch>(async () => response([]));
          const s = openLiveStream({ url: '/api/stream', getHeaders: headers, fetch, isCurrent: () => true, onOpen: vi.fn(), onData: vi.fn(), onFailure: vi.fn() });
          await vi.advanceTimersByTimeAsync(5000);
          await s.done;
          expect(headers).toHaveBeenCalledTimes(1);
          expect(fetch).toHaveBeenCalledTimes(1);
          expect(new Headers(fetch.mock.calls[0][1]?.headers).has('Authorization')).toBe(false);
          expect(warn.mock.calls).toEqual([['[live-stream] token-unavailable']]);
          late?.({ Authorization: 'Bearer ignored-synthetic' });
          await Promise.resolve();
          expect(fetch).toHaveBeenCalledTimes(1);
          warn.mockRestore();
          vi.useRealTimers();
      }
  });
  it('one header lookup and fetch for 20 frames, credentials only in headers', async () => {
      const getHeaders = vi.fn(async () => ({ Authorization: 'Bearer synthetic' })), onData = vi.fn();
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response([encoded(Array.from({ length: 20 }, (_, i) => 'data: ' + JSON.stringify({ type: 'tick', i }) + '\n\n').join(''))]));
      const s = openLiveStream({ url: '/api/stream?eventId=fixture', getHeaders, fetch, isCurrent: () => true, onOpen: vi.fn(), onData, onFailure: vi.fn() });
      await s.done;
      expect(getHeaders).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(onData).toHaveBeenCalledTimes(20);
      expect(fetch.mock.calls[0][0]).not.toContain('synthetic');
      expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer synthetic');
      console.info('Q0_TRANSPORT_WORK', JSON.stringify({ frames: onData.mock.calls.length, lookups: getHeaders.mock.calls.length, fetches: fetch.mock.calls.length }));
  });
});
