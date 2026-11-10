import { expect, it, vi } from "vitest";
import { hashNormalizedRows } from "../../scripts/feature-store/replay-normalized.ts";
import { normalizeSource, normalizeVerifiedSource } from "../../src/featureStore/normalize.ts";
import * as objectStore from "../../src/featureStore/objectStore.ts";
import { sourceFixture } from "./fixtures.ts";

it("shares normalization with ordinary ingest and refuses a released wire", async () => {
  const { bytes, asset } = sourceFixture();
  const key = objectStore.objectKey("raw", bytes);
  const owned = Buffer.from(new ArrayBuffer(bytes.byteLength));
  bytes.copy(owned);
  const wire = objectStore.VerifiedWire.verify(key, owned);
  const digest = vi.spyOn(objectStore, "sha256");
  const countWireHashes = () => digest.mock.calls.filter(([input]) => bytes.equals(input)).length;
  try {
    expect(owned.byteLength).toBe(0);
    const verified = await normalizeVerifiedSource(wire, asset, AbortSignal.timeout(5_000));
    expect(countWireHashes()).toBe(0);
    const raw = await normalizeSource(bytes, asset, AbortSignal.timeout(5_000));
    expect(countWireHashes()).toBe(1);
    expect(verified).toEqual(raw);
  } finally { digest.mockRestore(); wire.release(); }
  await expect(normalizeVerifiedSource(wire, asset, AbortSignal.timeout(5_000)))
    .rejects.toThrow("object-verification-required");
  await expect(normalizeVerifiedSource({ wireSha256: asset.sha256 } as objectStore.VerifiedWire, asset, AbortSignal.timeout(5_000)))
    .rejects.toThrow("object-verification-required");
});

it("compares normalized natural keys and values independently of ordering and owner metadata", () => {
  const first = { game_id: "a", kickoff: "2025-01-01T01:01:02.000001Z", reasons: ["x", "y"], state: "refused" };
  const second = { game_id: "b", kickoff: "2025-01-01T01:01:02Z", reasons: [], state: "usable" };
  const actual = hashNormalizedRows("schedules", [first, second]);
  expect(actual).toEqual(hashNormalizedRows("schedules", [
    { ...second, job_id: "new", snapshot_id: "new" },
    { ...first, kickoff: "2024-12-31T20:01:02.000001-05:00", normalizer_version: "v1" },
  ]));
  expect(hashNormalizedRows("schedules", [{ ...first, kickoff: "2025-01-01T01:01:02.000002Z" }, second]).valueSha256)
    .not.toBe(actual.valueSha256);
  expect(hashNormalizedRows("schedules", [{ ...first, reasons: ["y", "x"] }, second]).valueSha256)
    .not.toBe(actual.valueSha256);
  expect(() => hashNormalizedRows("schedules", [first, { ...first, state: "usable" }]))
    .toThrow("replay-normalized-duplicate-key");
});

it("refuses to replace a registered verified wire allocation", async () => {
  // Vitest reaches the private registration function for this runtime test.
  const access = await vi.importActual<{
    rememberVerifiedWire: (wire: objectStore.VerifiedWire, allocation: ArrayBuffer) => void;
  }>("../../src/featureStore/verifiedWireAccess.ts");
  const { bytes, asset } = sourceFixture();
  const input = Buffer.from(new ArrayBuffer(bytes.length));
  bytes.copy(input);
  const wire = objectStore.VerifiedWire.verify(objectStore.objectKey("raw", bytes), input);
  try {
    expect(() => access.rememberVerifiedWire(wire, new ArrayBuffer(bytes.length)))
      .toThrow("object-verification-already-registered");
    await expect(normalizeVerifiedSource(wire, asset, AbortSignal.timeout(5_000))).resolves.toMatchObject({ rowCount: 1 });
  } finally { wire.release(); }
});
