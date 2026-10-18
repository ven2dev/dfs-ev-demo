import { expect, it, vi } from "vitest";

it("throwaway #140 boundary probe", async () => {
  const store = await vi.importActual("../../src/store/index");
  expect(store).toBeDefined();
});
