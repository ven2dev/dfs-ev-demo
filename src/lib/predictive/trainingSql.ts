import { normalizeFittingRunRequest, TRAINING_BOUNDS, type FittingRunRequest } from "./training.ts";
import { refuse } from "./validation.ts";

// Metadata selection only: this statement does not authorize access, verify
// source bytes, pin dependencies or return a training-ready dataset. The guarded
// database adapter must check/replay the selected IDs before exposing payloads.
// All slots are retained by LEFT JOIN LATERAL; no LIMIT samples the inventory.
export const TRAINING_SELECTION_SQL = `WITH requested AS (
  SELECT (ordinality-1)::integer AS ordinal,value AS slot
  FROM jsonb_array_elements($1::jsonb->'slots') WITH ORDINALITY
), policy AS (SELECT $1::jsonb->'selection' AS selection)
SELECT r.ordinal,
  feature.id AS "featureId",label.id AS "labelId",
  EXISTS(SELECT 1 FROM public.predictive_source_consumers n
    WHERE n.predecessor_id=label.id AND n.recorded_at<=(r.slot->>'labelsAsOf')::timestamptz) AS "labelSupersededAsOf",
  EXISTS(SELECT 1 FROM public.predictive_source_consumers n
    WHERE n.predecessor_id=label.id AND n.recorded_at<=$2::timestamptz) AS "labelSupersededAtSnapshot"
FROM requested r CROSS JOIN policy p
LEFT JOIN LATERAL (
  -- Exact references are checked by the verifier, including wrong scope or
  -- future recording times. Do not turn an existing wrong ID into missingness.
  SELECT c.id FROM public.predictive_source_consumers c
  WHERE c.id=r.slot->>'featureRef' AND r.slot->>'featureRef' IS NOT NULL
  UNION ALL
  (SELECT c.id FROM public.predictive_source_consumers c
    WHERE r.slot->>'featureRef' IS NULL AND c.kind='feature'
      AND c.player_id=r.slot->>'playerId' AND c.game_id=(r.slot->>'gameId')::uuid
      AND c.cutoff=(r.slot->>'featureCutoff')::timestamptz AND c.recorded_at<=$2::timestamptz
      AND c.body->'bundle'->'request'->>'candidate'=p.selection->>'candidate'
      AND c.body->'bundle'->>'featureVersion'=p.selection->>'featureVersion'
      AND c.body->'manifest'->'profileIds'=p.selection->'profileIds'
    ORDER BY c.recorded_at DESC,c.id COLLATE "C" DESC LIMIT 1)
) feature ON true
LEFT JOIN LATERAL (
  SELECT c.id FROM public.predictive_source_consumers c
    WHERE c.id=r.slot->>'labelRef' AND r.slot->>'labelRef' IS NOT NULL
  UNION ALL
  (SELECT c.id FROM public.predictive_source_consumers c
    WHERE r.slot->>'labelRef' IS NULL AND c.kind='label'
      AND c.player_id=r.slot->>'playerId' AND c.game_id=(r.slot->>'gameId')::uuid
      AND c.recorded_at<=(r.slot->>'labelsAsOf')::timestamptz
      AND NOT EXISTS(SELECT 1 FROM public.predictive_source_consumers n
        WHERE n.predecessor_id=c.id AND n.recorded_at<=(r.slot->>'labelsAsOf')::timestamptz)
    -- Select the lineage head before checking its profile/version. Filtering
    -- these here would revive an older label when its successor changed scope.
    ORDER BY c.recorded_at DESC,c.id COLLATE "C" DESC LIMIT 2)
) label ON true
ORDER BY r.ordinal`;

export type TrainingMetadataSelection = {
  ordinal: number; featureId: string | null; labelId: string | null;
  labelSupersededAsOf: boolean; labelSupersededAtSnapshot: boolean;
};

export const trainingSelectionParameters = (request: FittingRunRequest, snapshotAt: string) =>
  [JSON.stringify(normalizeFittingRunRequest(request, snapshotAt)), snapshotAt] as const;

// Multiple heads duplicate an ordinal instead of hiding ambiguity with LIMIT 1.
// Call this before looking up any selected record's protected body/files.
export const checkTrainingMetadataSelection = (rows: TrainingMetadataSelection[], expectedSlots: number) => {
  if (!Number.isInteger(expectedSlots) || expectedSlots < 1 || expectedSlots > TRAINING_BOUNDS.slotsPerRun ||
      rows.length !== expectedSlots || rows.some((row, index) => row.ordinal !== index)) refuse("training-selection-inventory-mismatch");
  return rows;
};
