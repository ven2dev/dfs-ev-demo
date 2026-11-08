import assert from "node:assert/strict";
import type { Client } from "pg";

export type VisibilityPlanNode = { "Node Type": string; Plans?: VisibilityPlanNode[]; [key: string]: unknown };
export const visibilityPlanNodes = (root: VisibilityPlanNode): VisibilityPlanNode[] => [root, ...(root.Plans ?? []).flatMap(visibilityPlanNodes)];
// Owner-approved ceilings: ceil(measured hits * 1.20). These inclusive counters
// are checked independently, never summed across ancestor/descendant nodes.
export const DATASET_VISIBILITY_CEILINGS = { root: 10_349, current_f: 3_190, current_l: 825 } as const;
// Fresh standard-container calibration, maximum across both modes and active
// corrections: 2,080 / 607 / 145 hits. ceil(measured * 1.20), not full-graph slack.
export const DATASET_SLICE_BUDGET = {
  contentSha256: "d0bb28c7205f9047dd85f7bf6894b16031c94803c9cd46ee02b443fa10b8436e",
  naturalKeys: 1_948, measured: { root: 2_080, current_f: 607, current_l: 145 },
  ceilings: { root: 2_496, current_f: 729, current_l: 174 },
} as const;
export type JobRelationPages = { relation: string; kind: "r" | "i"; bytes: number; pages: number; analyzedPages: number };
export type JobPageBudget = { blockSize: number; heap: JobRelationPages; indexes: JobRelationPages[]; ceiling: number };
const currentJobsNode = (nodes: VisibilityPlanNode[]) => {
  const found = nodes.filter(n => n["Subplan Name"] === "CTE current_jobs");
  assert.equal(found.length, 1, "exactly one current_jobs materialization"); return found[0];
};
// Read catalog/physical sizes after ANALYZE in the EXPLAIN transaction. Only
// indexes actually used by this subtree count; an unused index adds no slack.
export const jobPageBudget = async (client: Pick<Client, "query">, plan: { Plan: VisibilityPlanNode }): Promise<JobPageBudget> => {
  const subtree = visibilityPlanNodes(currentJobsNode(visibilityPlanNodes(plan.Plan)));
  const used = [...new Set(subtree.filter(n => typeof n["Index Name"] === "string").map(n => n["Index Name"] as string))].sort();
  const relations = (await client.query<JobRelationPages & { blockSize: number }>(`SELECT c.relname AS relation,c.relkind AS kind,
    pg_relation_size(c.oid)::float8 AS bytes,ceil(pg_relation_size(c.oid)::numeric/current_setting('block_size')::integer)::integer AS pages,
    c.relpages AS "analyzedPages",current_setting('block_size')::integer AS "blockSize"
    FROM pg_class c WHERE c.oid='fs138.job_runs'::regclass OR c.oid IN (
      SELECT indexrelid FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
      WHERE i.indrelid='fs138.job_runs'::regclass AND idx.relname=ANY($1::text[])) ORDER BY c.relname`, [used])).rows;
  const heap = relations.find(r => r.kind === "r"); assert(heap);
  const indexes = relations.filter(r => r.kind === "i");
  assert.deepEqual(indexes.map(r => r.relation).sort(), used, "current_jobs uses only job-table indexes");
  for (const relation of relations) {
    assert.equal(relation.bytes, relation.pages * relation.blockSize, "whole relation pages");
    assert.equal(relation.analyzedPages, relation.pages, "ANALYZE and physical page count agree");
  }
  return { blockSize: heap.blockSize, heap, indexes, ceiling: heap.pages + indexes.reduce((sum, r) => sum + r.pages, 0) };
};
export const assertDatasetVisibilityPlan = (plan: { Plan: VisibilityPlanNode }, jobs: JobPageBudget, naturalKeys = 9381) => {
  assert([9381, DATASET_SLICE_BUDGET.naturalKeys].includes(naturalKeys), "unrecognized work fixture");
  const ceilings = naturalKeys === DATASET_SLICE_BUDGET.naturalKeys ? DATASET_SLICE_BUDGET.ceilings : DATASET_VISIBILITY_CEILINGS;
  const nodes = visibilityPlanNodes(plan.Plan);
  assert(!nodes.some(n => n["Node Type"] === "Function Scan" && n["Function Name"] === "completed_jobs_at"), "completion helper must inline");
  assert(!nodes.some(n => n["Node Type"] === "LockRows"), "reader coordination lock");
  const observations = [];
  const jobsNode = currentJobsNode(nodes);
  assert.equal(jobsNode["Actual Loops"], 1, "current_jobs must execute once");
  assert((jobsNode["Actual Rows"] as number) > 0, "current_jobs must actually run");
  for (const [name, ceiling] of Object.entries({ ...ceilings, current_jobs: jobs.ceiling })) {
    const matches = name === "root" ? [plan.Plan] : nodes.filter(n => n["Subplan Name"] === "CTE " + name);
    assert.equal(matches.length, 1, "exactly one materialization: " + name);
    const node = matches[0], hits = node["Shared Hit Blocks"] as number, reads = node["Shared Read Blocks"] as number;
    assert(Number.isSafeInteger(hits) && hits >= 0 && Number.isSafeInteger(reads) && reads >= 0);
    assert(hits <= ceiling, `${name}: buffer hits ${hits} exceed ${ceiling}`);
    assert(hits + reads <= ceiling, `${name}: buffer hits+reads ${hits + reads} exceed ${ceiling}`);
    if (name !== "root") {
      assert.equal(node["Actual Loops"], 1, name + " must execute once");
      assert((node["Actual Rows"] as number) > 0, name + " must actually run");
      if (name !== "current_jobs") assert.equal(node["Actual Rows"], naturalKeys, name + " natural-key graph");
    }
    observations.push({ name, hits, reads, ceiling, loops: node["Actual Loops"], rows: node["Actual Rows"],
      ...(name === "current_jobs" ? { pageBudget: jobs } : {}) });
  }
  return { observations, helperFunctionScans: 0, explicitRowLocks: 0 };
};
