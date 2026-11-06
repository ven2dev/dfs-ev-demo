import assert from "node:assert/strict";
import { test } from "vitest";
import { r2TestConfig } from "../../src/featureStore/r2TestConfig.ts";

const values = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET: "edgetrace-fs-test",
  R2_ACCESS_KEY_ID: "example-id",
  R2_SECRET_ACCESS_KEY: "example-secret",
};

test("R2 test config pins the account endpoint and SDK request behavior", () => {
  const config = r2TestConfig(values);
  assert.equal(config.endpoint, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(config.region, "auto");
  assert.equal(config.requestChecksumCalculation, "WHEN_REQUIRED");
  assert.equal(config.responseChecksumValidation, "WHEN_REQUIRED");
  assert.equal(config.maxAttempts, 1);
  assert.equal(config.forcePathStyle, true);
});

test("R2 test config refuses any bucket other than the exact test bucket", () => {
  for (const bucket of [undefined, "edgetrace-fs-prod", "edgetrace-fs-test-copy"]) {
    assert.throws(() => r2TestConfig({ ...values, R2_BUCKET: bucket }), /R2_BUCKET must be/);
  }
});

test("R2 test config rejects invalid account IDs and missing credentials", () => {
  assert.throws(() => r2TestConfig({ ...values, R2_ACCOUNT_ID: "bad.example" }), /R2_ACCOUNT_ID/);
  assert.throws(() => r2TestConfig({ ...values, R2_SECRET_ACCESS_KEY: "" }), /credentials are missing/);
});
