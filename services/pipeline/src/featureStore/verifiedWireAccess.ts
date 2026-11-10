import type { VerifiedWire } from "./objectStore.ts";

const allocations = new WeakMap<VerifiedWire, ArrayBuffer>();

export const rememberVerifiedWire = (wire: VerifiedWire, allocation: ArrayBuffer): void => {
  if (allocations.has(wire)) throw new Error("object-verification-already-registered");
  allocations.set(wire, allocation);
};

export const readVerifiedWire = (wire: VerifiedWire): Buffer => {
  const allocation = allocations.get(wire);
  if (!allocation || allocation.detached) throw new Error("object-verification-required");
  return Buffer.from(allocation);
};
