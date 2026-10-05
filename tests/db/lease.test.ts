import { expect, it } from "vitest";
import { openTestClient } from "./harness";
import {
  backendPid, cacheState, expireLease, freshAfter, key, leaseMs,
  openContenders, payload, seedStaleRow, testStore, waitForBlocked,
} from "./leaseSupport";

it.each(["cold", "stale"] as const)(
  "25 independent clients acquire exactly one %s-row lease",
  async (state) => {
    const monitor = await openTestClient();
    if (state === "stale") await seedStaleRow(monitor);
    else expect(await cacheState(monitor)).toBeUndefined();
    const threshold = await freshAfter(monitor);
    const contenders = await openContenders();
    const start = Promise.withResolvers<void>();
    const finished = Promise.all(contenders.map(async ({ store, owner }) => {
      await start.promise;
      return store.tryAcquireRefresh(key, owner, threshold, leaseMs);
    }));
    start.resolve();
    const acquired = await finished;
    expect(acquired.filter(Boolean)).toHaveLength(1);
    const winner = contenders[acquired.indexOf(true)];
    expect(await cacheState(monitor)).toMatchObject({ refresh_owner: winner.owner, lease_active: true });
  }
);

it.each(["cold", "stale"] as const)(
  "observes all 24 contenders blocked behind a held %s-row acquisition transaction",
  async (state) => {
    const monitor = await openTestClient();
    if (state === "stale") await seedStaleRow(monitor);
    const threshold = await freshAfter(monitor);
    const [holder, ...followers] = await openContenders();
    let transactionOpen = false;
    let pending: Promise<PromiseSettledResult<boolean>[]> | undefined;
    try {
      await holder.client.query("BEGIN");
      transactionOpen = true;
      expect(await holder.store.tryAcquireRefresh(key, holder.owner, threshold, leaseMs)).toBe(true);
      pending = Promise.allSettled(followers.map(({ store, owner }) =>
        store.tryAcquireRefresh(key, owner, threshold, leaseMs)
      ));
      await waitForBlocked(monitor, followers.map((follower) => follower.pid), holder.pid);
      await holder.client.query("COMMIT");
      transactionOpen = false;
      expect(await pending).toEqual(followers.map(() => ({ status: "fulfilled", value: false })));
      expect(await cacheState(monitor)).toMatchObject({ refresh_owner: holder.owner, lease_active: true });
    } finally {
      if (transactionOpen) await holder.client.query("ROLLBACK");
      await pending;
    }
  }
);

it("renewing an expired lease extends it and prevents competing takeover", async () => {
  const [owner, competitor] = await openContenders(2);
  const threshold = await freshAfter(owner.client);
  expect(await owner.store.tryAcquireRefresh(key, owner.owner, threshold, leaseMs)).toBe(true);
  // Without renewal this expired, empty row is eligible for takeover.
  await expireLease(owner.client);
  const before = await cacheState(owner.client);
  expect(before).toMatchObject({ payload: null, fetched_at: null, refresh_owner: owner.owner, lease_active: false });
  expect(await owner.store.renew(key, owner.owner, leaseMs)).toBe(true);
  const renewed = await cacheState(owner.client);
  expect(renewed!.refresh_lease_until!.getTime() - before!.refresh_lease_until!.getTime()).toBeGreaterThan(leaseMs);
  expect(renewed).toMatchObject({ refresh_owner: owner.owner, lease_active: true });
  expect(await competitor.store.tryAcquireRefresh(key, competitor.owner, threshold, leaseMs)).toBe(false);
});

it("25 independent clients produce exactly one takeover of a forced expired lease", async () => {
  const monitor = await openTestClient();
  const oldStore = testStore(monitor);
  const threshold = await freshAfter(monitor);
  expect(await oldStore.tryAcquireRefresh(key, "expired-owner", threshold, leaseMs)).toBe(true);
  await expireLease(monitor);
  expect(await cacheState(monitor)).toMatchObject({ refresh_owner: "expired-owner", lease_active: false });
  const contenders = await openContenders();
  const start = Promise.withResolvers<void>();
  const finished = Promise.all(contenders.map(async ({ store, owner }) => {
    await start.promise;
    return store.tryAcquireRefresh(key, owner, threshold, leaseMs);
  }));
  start.resolve();
  const acquired = await finished;
  expect(acquired.filter(Boolean)).toHaveLength(1);
  expect(await cacheState(monitor)).toMatchObject({
    refresh_owner: contenders[acquired.indexOf(true)].owner, lease_active: true,
  });
});

it("characterization: an expired owner may renew before any takeover", async () => {
  const client = await openTestClient();
  const store = testStore(client);
  expect(await store.tryAcquireRefresh(key, "owner-A", await freshAfter(client), leaseMs)).toBe(true);
  await expireLease(client);
  expect(await cacheState(client)).toMatchObject({ lease_active: false });
  expect(await store.renew(key, "owner-A", leaseMs)).toBe(true);
  expect(await cacheState(client)).toMatchObject({ refresh_owner: "owner-A", lease_active: true });
});

it("characterization: an expired owner may publish before any takeover", async () => {
  const client = await openTestClient();
  const store = testStore(client);
  const threshold = await freshAfter(client);
  expect(await store.tryAcquireRefresh(key, "owner-A", threshold, leaseMs)).toBe(true);
  await expireLease(client);
  await store.write(key, "owner-A", payload);
  expect(await store.read(key)).toEqual({ payload, fetchedAtMs: expect.any(Number) });
  const published = await cacheState(client);
  expect(published).toMatchObject({ payload, refresh_owner: null, refresh_lease_until: null });
  expect(published!.fetched_at!.getTime()).toBeGreaterThan(threshold);
});

it("a replaced owner cannot renew, write, or release the new owner's lease", async () => {
  const [former, replacement] = await openContenders(2);
  const threshold = await freshAfter(former.client);
  expect(await former.store.tryAcquireRefresh(key, former.owner, threshold, leaseMs)).toBe(true);
  await expireLease(former.client);
  expect(await replacement.store.tryAcquireRefresh(key, replacement.owner, threshold, leaseMs)).toBe(true);
  const before = await cacheState(replacement.client);
  expect(await former.store.renew(key, former.owner, leaseMs)).toBe(false);
  await expect(former.store.write(key, former.owner, payload)).rejects.toThrow(
    "Live-prop refresh lease was lost before cache write"
  );
  await former.store.release(key, former.owner);
  expect(await cacheState(replacement.client)).toEqual(before);
  expect(await replacement.store.renew(key, replacement.owner, leaseMs)).toBe(true);
});

it("an expired owner's write committed first makes all blocked takeovers fail", async () => {
  const monitor = await openTestClient();
  const formerClient = await openTestClient();
  const former = testStore(formerClient);
  const threshold = await freshAfter(monitor);
  expect(await former.tryAcquireRefresh(key, "owner-A", threshold, leaseMs)).toBe(true);
  await expireLease(monitor);
  const competitors = await openContenders(5);
  const holderPid = await backendPid(formerClient);
  let transactionOpen = false;
  let takeovers: Promise<PromiseSettledResult<boolean>[]> | undefined;
  try {
    await formerClient.query("BEGIN");
    transactionOpen = true;
    await former.write(key, "owner-A", payload);
    takeovers = Promise.allSettled(competitors.map(({ store, owner }) =>
      store.tryAcquireRefresh(key, owner, threshold, leaseMs)
    ));
    await waitForBlocked(monitor, competitors.map(({ pid }) => pid), holderPid);
    await formerClient.query("COMMIT");
    transactionOpen = false;
    expect(await takeovers).toEqual(competitors.map(() => ({ status: "fulfilled", value: false })));
    expect(await cacheState(monitor)).toMatchObject({ payload, refresh_owner: null, refresh_lease_until: null });
    expect((await former.read(key))!.fetchedAtMs).toBeGreaterThan(threshold);
  } finally {
    if (transactionOpen) await formerClient.query("ROLLBACK");
    await takeovers;
  }
});

it("a takeover committed first makes the blocked former-owner write lose its lease", async () => {
  const monitor = await openTestClient();
  const formerClient = await openTestClient();
  const former = testStore(formerClient);
  const threshold = await freshAfter(monitor);
  expect(await former.tryAcquireRefresh(key, "owner-A", threshold, leaseMs)).toBe(true);
  await expireLease(monitor);
  const [winner, ...competitors] = await openContenders(6);
  const formerPid = await backendPid(formerClient);
  let transactionOpen = false;
  let pending: Promise<PromiseSettledResult<void | boolean>[]> | undefined;
  try {
    await winner.client.query("BEGIN");
    transactionOpen = true;
    expect(await winner.store.tryAcquireRefresh(key, winner.owner, threshold, leaseMs)).toBe(true);
    pending = Promise.allSettled([
      former.write(key, "owner-A", payload),
      ...competitors.map(({ store, owner }) => store.tryAcquireRefresh(key, owner, threshold, leaseMs)),
    ]);
    await waitForBlocked(monitor, [formerPid, ...competitors.map(({ pid }) => pid)], winner.pid);
    await winner.client.query("COMMIT");
    transactionOpen = false;
    const [write, ...takeovers] = await pending;
    expect(write.status).toBe("rejected");
    if (write.status === "rejected") {
      expect(write.reason).toBeInstanceOf(Error);
      expect(write.reason.message).toBe("Live-prop refresh lease was lost before cache write");
    }
    expect(takeovers).toEqual(competitors.map(() => ({ status: "fulfilled", value: false })));
    const beforeRelease = await cacheState(monitor);
    expect(beforeRelease).toMatchObject({ payload: null, fetched_at: null, refresh_owner: winner.owner, lease_active: true });
    await former.release(key, "owner-A");
    expect(await cacheState(monitor)).toEqual(beforeRelease);
  } finally {
    if (transactionOpen) await winner.client.query("ROLLBACK");
    await pending;
  }
});
