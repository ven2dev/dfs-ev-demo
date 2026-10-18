-- #163 query 2: earlier-game outcomes already materialized as lagged features.
-- This does not query outcome_labels, normalized data or raw objects.
SELECT history FROM fs138.feature_values WHERE feature_id=$1::uuid;
