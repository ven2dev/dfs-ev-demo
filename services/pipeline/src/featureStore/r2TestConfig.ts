import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

const testBucket = "edgetrace-fs-test";
const credentialFile = new URL("../../.env.r2.local", import.meta.url);

export const r2TestConfig = (values: Record<string, string | undefined>): S3ClientConfig => {
  if (values.R2_BUCKET !== testBucket) {
    throw new Error("R2_BUCKET must be edgetrace-fs-test");
  }
  if (!/^[0-9a-f]{32}$/i.test(values.R2_ACCOUNT_ID ?? "")) {
    throw new Error("R2_ACCOUNT_ID must be a 32-character hexadecimal account ID");
  }
  if (!values.R2_ACCESS_KEY_ID?.trim() || !values.R2_SECRET_ACCESS_KEY?.trim()) {
    throw new Error("R2 test credentials are missing");
  }

  return {
    endpoint: `https://${values.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: "auto",
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 1,
    credentials: {
      accessKeyId: values.R2_ACCESS_KEY_ID,
      secretAccessKey: values.R2_SECRET_ACCESS_KEY,
    },
  };
};

export const loadR2TestClient = () => {
  let values;
  try {
    values = parseEnv(readFileSync(credentialFile, "utf8"));
  } catch {
    throw new Error("Could not read services/pipeline/.env.r2.local");
  }
  return { bucket: testBucket, client: new S3Client(r2TestConfig(values)) };
};
