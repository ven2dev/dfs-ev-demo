import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "./db-catalog.mjs";

function validateSnapshot(snapshot) {
  if (snapshot.formatVersion !== 1 || snapshot.schema !== "public" || !Number.isInteger(snapshot.postgresMajor) ||
      !Array.isArray(snapshot.objects)) throw new Error("invalid-catalog-format");
  const keys = new Set();
  for (const object of snapshot.objects) {
    const key = object.kind + ":" + object.name;
    if (typeof object.kind !== "string" || typeof object.name !== "string" || !object.definition ||
        typeof object.definition !== "object" || Array.isArray(object.definition) || keys.has(key)) throw new Error("invalid-catalog-object");
    keys.add(key);
  }
}

export function compareCatalogs(expected, actual) {
  validateSnapshot(expected);
  validateSnapshot(actual);
  const differences = [];
  if (expected.postgresMajor !== actual.postgresMajor) differences.push("PostgreSQL major differs; regenerate and review contracts before adoption.");
  const expectedObjects = new Map(expected.objects.map((object) => [object.kind + ":" + object.name, object]));
  const actualObjects = new Map(actual.objects.map((object) => [object.kind + ":" + object.name, object]));
  for (const key of [...new Set([...expectedObjects.keys(), ...actualObjects.keys()])].sort()) {
    const left = expectedObjects.get(key);
    const right = actualObjects.get(key);
    if (!left) { differences.push("Unexpected " + key); continue; }
    if (!right) { differences.push("Missing " + key); continue; }
    for (const field of [...new Set([...Object.keys(left.definition), ...Object.keys(right.definition)])].sort()) {
      const expectedValue = canonicalJson(left.definition[field]);
      const actualValue = canonicalJson(right.definition[field]);
      if (expectedValue !== actualValue) differences.push(
        "Changed " + key + " / " + field + ": expected " + (expectedValue ?? "<absent>") + "; actual " + (actualValue ?? "<absent>")
      );
    }
  }
  return differences;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { expected: { type: "string" }, actual: { type: "string" } } });
    if (!values.expected?.endsWith(".json") || !values.actual?.endsWith(".json")) throw new Error("json-inputs-required");
    const differences = compareCatalogs(
      JSON.parse(await readFile(values.expected, "utf8")), JSON.parse(await readFile(values.actual, "utf8"))
    );
    process.stdout.write(differences.length ? differences.join("\n") + "\n" : "No catalog differences.\n");
    process.exitCode = differences.length ? 1 : 0;
  } catch {
    process.stderr.write("db-catalog-diff: invalid-input\n");
    process.exitCode = 1;
  }
}
