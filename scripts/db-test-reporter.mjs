import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Consume Node's documented events, never parse the human-readable reporter.
// A truncated stream lacks the final summary and cannot pass the report gate.
export default async function* report(source) {
  const assertions = [];
  let summary;
  for await (const { type, data } of source) {
    if (type === "test:pass" || type === "test:fail") assertions.push({
      file: data.file ? relative(root, data.file).split(sep).join("/") : null,
      name: data.name, nesting: data.nesting,
      status: type === "test:fail" ? "failed" : data.skip !== undefined && data.skip !== false ? "skipped" :
        data.todo !== undefined && data.todo !== false ? "todo" : "passed",
    });
    if (type === "test:summary" && data.file === undefined) summary = { counts: data.counts, success: data.success };
  }
  yield JSON.stringify({ formatVersion: 1, assertions, summary }) + "\n";
}
