import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { parseBearerToken } from "./parseBearerToken.ts";

const fakeRequest = (headers: Record<string, string>): NextRequest =>
  ({
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  }) as unknown as NextRequest;

test("parseBearerToken: no Authorization header returns null", () => {
  assert.equal(parseBearerToken(fakeRequest({})), null);
});

test("parseBearerToken: Authorization header without Bearer prefix returns null", () => {
  assert.equal(parseBearerToken(fakeRequest({ authorization: "Basic abc123" })), null);
});

test("parseBearerToken: extracts the token from a well-formed Bearer header", () => {
  assert.equal(
    parseBearerToken(fakeRequest({ authorization: "Bearer my-real-token" })),
    "my-real-token"
  );
});
