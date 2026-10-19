import { describe, expect, it } from "vitest";
import { isAuthorizedCronHeader } from "./cronAuth";

describe("isAuthorizedCronHeader", () => {
  it("accepts only the exact bearer credential", () => {
    expect(isAuthorizedCronHeader("Bearer secret-value", "secret-value")).toBe(true);
    expect(isAuthorizedCronHeader("Bearer wrong-value", "secret-value")).toBe(false);
    expect(isAuthorizedCronHeader("Basic secret-value", "secret-value")).toBe(false);
  });

  it("fails closed for missing credentials without comparing unequal buffers", () => {
    expect(isAuthorizedCronHeader(null, "secret-value")).toBe(false);
    expect(isAuthorizedCronHeader("Bearer secret-value", undefined)).toBe(false);
    expect(isAuthorizedCronHeader("Bearer short", "a-much-longer-secret")).toBe(false);
  });
});
