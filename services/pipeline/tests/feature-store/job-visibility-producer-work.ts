import assert from "node:assert/strict";
import { visibilityPlanNodes, type VisibilityPlanNode } from "./job-visibility-work.ts";

// ceil(1,454,495 measured candidate hits * 1.20), owner-approved. No timing
// assertions: the live relational graph and logical work qualify in CI.
const ceiling = 1_745_394;
const once = ["snapshots", "discovery_schedule", "population", "targets", "requests", "schedules", "stats", "identities", "participation"];
export const assertProducerContext = (plan: { Plan: VisibilityPlanNode }) => {
  const nodes = visibilityPlanNodes(plan.Plan), hits = plan.Plan["Shared Hit Blocks"] as number, reads = plan.Plan["Shared Read Blocks"] as number;
  assert(Number.isSafeInteger(hits) && hits >= 0 && Number.isSafeInteger(reads) && reads >= 0);
  assert(hits + reads <= ceiling, `producer context hits+reads ${hits + reads} exceed ${ceiling}`);
  assert(!nodes.some(n => n["Node Type"] === "Function Scan" && ["completed_jobs_at", "qb_job_snapshot_ids", "qb_job_context"].includes(String(n["Function Name"]))), "shared producer relations must inline");
  assert(!nodes.some(n => n["Node Type"] === "LockRows"), "no context coordination locks");
  const ctes = once.map(name => {
    const found = nodes.filter(n => n["Subplan Name"] === "CTE " + name); assert.equal(found.length, 1, name);
    assert.equal(found[0]["Actual Loops"], 1, name + " once"); assert((found[0]["Actual Rows"] as number) > 0, name + " executes");
    return { name, loops: found[0]["Actual Loops"], rows: found[0]["Actual Rows"] };
  });
  assert.equal(ctes.find(c => c.name === "snapshots")!.rows, 16);
  assert.equal(ctes.find(c => c.name === "targets")!.rows, 1948);
  assert.equal(ctes.find(c => c.name === "requests")!.rows, 119515);
  return { hits, reads, ceiling, ctes, helperFunctionScans: 0, explicitLocks: 0 };
};
