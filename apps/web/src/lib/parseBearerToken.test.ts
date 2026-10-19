import { describe, it, expect } from "vitest";
import type { NextRequest } from "next/server";
import { parseBearerToken } from "./parseBearerToken.ts";

const fakeRequest = (headers: Record<string, string>): NextRequest =>
  ({
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  }) as unknown as NextRequest;

describe("parseBearerToken", () => {
  it("no Authorization header returns null", () => {
    expect(parseBearerToken(fakeRequest({}))).toBe(null);
  });

  it("Authorization header without Bearer prefix returns null", () => {
    expect(parseBearerToken(fakeRequest({ authorization: "Basic abc123" }))).toBe(null);
  });

  it("extracts the token from a well-formed Bearer header", () => {
    expect(parseBearerToken(fakeRequest({ authorization: "Bearer my-real-token" }))).toBe(
      "my-real-token"
    );
  });
});
