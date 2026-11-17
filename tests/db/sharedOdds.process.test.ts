import http from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { withTestClient } from "@dfs-ev/db-tooling/test-support/clients";
import { startTestProcess } from "../../services/pipeline/tests/support/runTestProcess";

const root = fileURLToPath(new URL("../../", import.meta.url));
const worker = fileURLToPath(new URL("./fixtures/cache221-worker.mts", import.meta.url));
beforeAll(async () => {
  const proposal = await readFile(new URL("../../packages/db/proposals/221_shared_odds_cache.sql", import.meta.url), "utf8");
  await withTestClient(client => client.query(proposal));
});
beforeEach(() => withTestClient(client => client.query("TRUNCATE public.event_market_odds_cache")));
afterAll(() => withTestClient(client => client.query(`
 DROP FUNCTION public.claim_shared_odds_batch(text,text[],text,integer,integer);
 DROP FUNCTION public.renew_shared_odds_batch(text,text[],text,integer);
 DROP FUNCTION public.publish_shared_odds_batch(text,text[],text,jsonb);
 DROP FUNCTION public.release_shared_odds_batch(text,text[],text);
 ALTER TABLE public.event_market_odds_cache DROP COLUMN refresh_owner,
 DROP COLUMN refresh_lease_until, DROP COLUMN refresh_claimed_at;
`)));

const launch = (url: string, keys: string[], pauseAfterClaim = false) => {
  const process = startTestProcess(globalThis.process.execPath, [worker, JSON.stringify({ event: "event", keys, url, pauseAfterClaim })], {
    cwd: root, env: { ...globalThis.process.env }, timeoutMs: 10_000,
  });
  // Consume the rejection even when a deliberately killed worker is stopped.
  void process.result.catch(() => undefined);
  const messages: { phase: string; pid: number }[] = [];
  const listeners: { phase: string; resolve: () => void; reject: (error: Error) => void }[] = [];
  let buffer = "";
  process.child.stdout!.on("data", chunk => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      messages.push(message);
      listeners.filter(listener => listener.phase === message.phase).forEach(listener => listener.resolve());
    }
  });
  process.child.once("close", () => listeners.forEach(listener => {
    if (!messages.some(message => message.phase === listener.phase)) listener.reject(new Error("Worker closed before expected phase"));
  }));
  return { ...process, messages, phase: (phase: string) => messages.some(message => message.phase === phase)
    ? Promise.resolve() : new Promise<void>((resolve, reject) => listeners.push({ phase, resolve, reject })) };
};

const mockProvider = async () => {
  const requests: { event: string; keys: string[] }[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), disconnected = Promise.withResolvers<void>();
  const active = new Set<string>(); let overlaps = 0;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const job = JSON.parse(body); requests.push(job);
    for (const key of job.keys) { if (active.has(key)) overlaps++; active.add(key); }
    const clear = () => { job.keys.forEach((key: string) => active.delete(key)); disconnected.resolve(); };
    res.once("close", clear);
    entered.resolve();
    await release.promise;
    clear();
    if (!res.destroyed) res.end(JSON.stringify(Object.fromEntries(job.keys.map((key: string) => [key, { bookmakers: [] }]))));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/odds`, requests, entered, release, disconnected,
    overlaps: () => overlaps,
    close: async () => {
      release.resolve(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
};

it.each([false, true])("separate workers serialize identical/overlapping raw batches; partial=%s", async partial => {
  const provider = await mockProvider();
  const first = launch(provider.url, ["a", "b"]);
  let second: ReturnType<typeof launch> | undefined;
  try {
    await Promise.race([provider.entered.promise, first.result.then(result => { throw new Error(`Owner exited before send: ${result.stderr}`); })]);
    second = launch(provider.url, partial ? ["b", "c"] : ["b", "a"]);
    await second.phase("follower");
    expect(provider.requests).toHaveLength(1);
    provider.release.resolve();
    const results = await Promise.all([first.result, second.result]);
    expect(results.map(result => result.status)).toEqual([0, 0]);
    expect(first.child.pid).not.toBe(second.child.pid);
    expect(provider.requests.map(request => request.keys)).toEqual(partial ? [["a", "b"], ["c"]] : [["a", "b"]]);
    expect(provider.overlaps()).toBe(0);
  } finally { await Promise.all([first.stop(), second?.stop()]); await provider.close(); }
});

it.each([false, true])("killed owner before/after send retains the cooldown; afterSend=%s", async afterSend => {
  const provider = await mockProvider();
  const owner = launch(provider.url, ["a"], !afterSend);
  let follower: ReturnType<typeof launch> | undefined;
  let recovered: ReturnType<typeof launch> | undefined;
  try {
    if (afterSend) await Promise.race([provider.entered.promise, owner.result.then(result => { throw new Error(`Owner exited before send: ${result.stderr}`); })]);
    else await owner.phase("claimed");
    await owner.stop();
    if (afterSend) await provider.disconnected.promise;
    const before = provider.requests.length;
    // Simulate lease expiry without reducing either production timeout.
    await withTestClient(client => client.query(`UPDATE public.event_market_odds_cache
      SET refresh_lease_until=clock_timestamp()-interval '1 second',
          refresh_claimed_at=clock_timestamp()-interval '19 seconds'`));
    follower = launch(provider.url, ["a"]);
    const result = await follower.result;
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(output.result.a.state).toBe("unavailable");
    expect(provider.requests).toHaveLength(before);
    expect(before).toBe(afterSend ? 1 : 0);
    await withTestClient(client => client.query(`UPDATE public.event_market_odds_cache
      SET refresh_claimed_at=clock_timestamp()-interval '21 seconds'`));
    provider.release.resolve();
    recovered = launch(provider.url, ["a"]);
    expect((await recovered.result).status).toBe(0);
    expect(provider.requests).toHaveLength(before + 1);
    expect(provider.overlaps()).toBe(0);
    let probeCode: string | undefined;
    try { globalThis.process.kill(owner.child.pid!, 0); }
    catch (error) { probeCode = (error as NodeJS.ErrnoException).code; }
    expect(probeCode).toBe("ESRCH");
  } finally { await Promise.all([owner.stop(), follower?.stop(), recovered?.stop()]); await provider.close(); }
});
