import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  assertFails,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rules = await readFile(join(root, "firestore.rules"), "utf8");
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulatorHost) {
  throw new Error("Run this test through Firebase emulators:exec");
}
const [host, rawPort] = emulatorHost.split(":");
const port = Number(rawPort);
if (!host || !Number.isInteger(port)) {
  throw new Error("FIRESTORE_EMULATOR_HOST is invalid");
}

const environment = await initializeTestEnvironment({
  projectId: "demo-dfs-ev-preview-rules",
  firestore: { host, port, rules },
});

try {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "isolation", "production-only"), {
      environment: "production",
    });
  });

  const contexts = [
    environment.unauthenticatedContext(),
    environment.authenticatedContext("preview-user", { email: "preview@example.test" }),
  ];

  for (const context of contexts) {
    const database = context.firestore();
    await assertFails(getDoc(doc(database, "isolation", "production-only")));
    await assertFails(
      setDoc(doc(database, "watchlists", "preview-user"), {
        eventId: "fixture-event",
      })
    );
  }

  console.log("Firestore rules deny browser reads and writes for signed-out and signed-in users.");
} finally {
  await environment.cleanup();
}
