# Creator corpus persistence contract

Decision date: 2026-10-11. This contract implements the first step of #90 and
is normative for the corpus migration, importer and readiness report that
follow. The owner's private files remain authoritative. Postgres is a
rebuildable projection, not another place to edit creator decisions or capture
history.

## Authority and lifecycle classes

| Class | Authority | Database behavior | Retention |
| --- | --- | --- | --- |
| Owner event | Private capture or decision log | Append only. `UPDATE` and `DELETE` are refused. A later event changes active state without changing history. | Permanent unless the owner applies a future legal or policy deletion procedure. |
| Registered gate | Committed `readiness-gate.json`, verified with its private record | Immutable. Import time is recorded separately from registration time. | Permanent. A changed gate is a new registration, never an edit. |
| API evidence | Current valid discovery file | A complete creator snapshot is validated and atomically replaced. Rows carry their own fetch time. | Refresh or physically delete by 30 calendar days; owner events survive. |
| Derived projection | Deterministic rule applied to one validated input snapshot | Rebuilt with its source. It may not outlive API evidence from which it was derived. | Same as the source with the shortest lifecycle. |
| Import audit | Importer | Append only; contains fingerprints, versions, counts and times, but no reconstructable API or transcript content. | Permanent. |

“Owner” means a value explicitly written by the owner-run tool. “API” means a
value returned by the official YouTube Data API. “Derived” means the result of
a named, versioned deterministic rule. Local ingestion time is operational
metadata and never substitutes for event time or API fetch time.

## Stored-field inventory

The SQL names below are the contract for migration Step 2. Keys and positions
identify events; a transcript hash is evidence about text and is never event
identity. Nullable means that the source event legitimately has no value, not
that the importer may silently discard one.

### `corpus_capture_events`

| Stored value | Origin | Lifecycle and meaning |
| --- | --- | --- |
| `creator_key` | Owner | Permanent opaque key from the capture log. No creator name is stored. |
| `log_position` | Derived | Permanent one-based line position in that creator's validated append-only history; part of event identity. |
| `event_fingerprint` | Derived | SHA-256 of the canonical whole source event. Detects alteration; not derived from transcript text alone. |
| `video_id` | Owner | Permanent YouTube video identifier attached to the event. |
| `event_kind` | Owner | `captured`, `replaced`, or `unavailable`; permanent event fact. |
| `published_date` | Owner | Calendar date the owner confirmed on the video page. It is not an instant. |
| `published_date_precision` | Contract constant | Always `day`. Permanent and explicit so downstream code cannot invent a time. |
| `published_date_provenance` | Contract constant | Always `owner-confirmed-video-page-pacific-date`. Permanent accepted internal-POC provenance. |
| `transcript_source` | Owner/tool constant | Currently only `manual-owner-paste`; permanent and constrained, with extension owned by #91. |
| `usage_status` | Owner/tool constant | Currently only `internal-research-only`; permanent and constrained, with extension owned by #91. |
| `caption_kind` | Owner | `unknown`, `auto-generated`, or `uploaded` for captured/replaced events; null for unavailable. |
| `transcript_sha256` | Derived from owner text | SHA-256 only; null for unavailable. Permanent integrity evidence, never event identity. |
| `transcript_characters` | Derived from owner text | Character count only; null for unavailable. Transcript text is never stored. |
| `captured_at` | Owner-run tool | Instant at which the owner event was recorded. Permanent. |
| `first_import_id` | Importer | Audit link to the first successful import that appended this event. Permanent. |

Capture `reason`, `note` and transcript `text` remain only in the authoritative
private capture log. The database keeps the whole-event fingerprint so changed
history is refused, but it does not copy those free-text fields.

### `corpus_decision_events`

| Stored value | Origin | Lifecycle and meaning |
| --- | --- | --- |
| `creator_key` | Owner | Permanent opaque key from the decision file. |
| `file_position` | Derived | Permanent one-based position within that creator's decision array; breaks equal-time ties and is part of event identity. |
| `event_fingerprint` | Derived | SHA-256 of the canonical whole decision event; detects alteration. |
| `video_id` | Owner | Permanent video identifier. |
| `decision_kind` | Owner | `include`, `exclude`, or `clear`; active state is derived without changing this event. |
| `reason` | Owner | Required nonempty explanation, permanent. |
| `rule_version` | Owner-run tool | Inclusion rule version under which the decision was made, permanent. |
| `decided_at` | Owner-run tool | Event time. Events are applied by this instant, with `file_position` breaking ties. |
| `first_import_id` | Importer | Audit link to the first successful import that appended this event. Permanent. |

### `corpus_api_videos`

| Stored value | Origin | Lifecycle and meaning |
| --- | --- | --- |
| `creator_key` | Owner/API bridge | Opaque confirmed creator key for the complete replacement snapshot. Deleted with expired API evidence. |
| `video_id` | API | Video identifier in the current discovery snapshot. Deleted with expired API evidence. |
| `published_at` | API | Precise API publication instant. It remains distinct from the owner-confirmed date and is deleted by the API lifecycle. |
| `duration_seconds` | API | Duration, nullable when the API did not provide it. Deleted with expired API evidence. |
| `live_broadcast_content` | API | `none`, `upcoming`, or `live`. Deleted with expired API evidence. |
| `api_fetched_at` | API-fetch operation | Per-row fetch instant used for the 30-day deadline. It cannot be replaced by an import-level marker. |
| `season` / `week` | Derived | NFL regular-season placement from `published_at`; nullable when outside the registered calendar. Deleted with its API source. |
| `season_week_provenance` | Derived constant | Names the API publication instant and calendar/rule version used for placement. Deleted with its API source. |
| `classification_status` | Derived | Rule result: `candidate`, `needs-review`, or `excluded`. This is not capture availability. |
| `classification_reasons` | Derived | Ordered rule reason codes, not title or description text. Deleted with its API source. |
| `classification_rule_version` | Derived | Rule version used for classification. Deleted with its API source. |
| `review_status` | Derived from classification plus owner decisions | `present`, `needs-review`, or `excluded`. It is independent of capture status and deleted when its API video disappears. |
| `snapshot_import_id` | Importer | The successful complete replacement that published this current API row. Deleted with the row; the import audit remains. |

`missing` is a **slot** status derived by comparing the registered creator/week
grid with current video rows. It is not a video value. `captured`, `replaced`
and `unavailable` are capture-event values. Neither family may be collapsed
into `review_status`.

### `corpus_imports`

| Stored value | Origin | Lifecycle and meaning |
| --- | --- | --- |
| `import_id` | Database | Permanent monotonic audit identity. |
| `imported_at` | Importer | Local publication instant for this validated snapshot. Not source event time. |
| `importer_version` | Importer | Version of deterministic import behavior. |
| `rule_version` | Registration | Inclusion/classification version used by the snapshot. |
| `registration_fingerprint` | Derived | SHA-256 of the committed collection registration input. |
| `gate_fingerprint` | Derived | SHA-256 of the committed public readiness gate. It is not the private creator commitment itself. |
| `capture_input_fingerprint` | Derived | SHA-256 of the exact validated capture-log bytes. No text is retained in the database. |
| `decision_input_fingerprint` | Derived | SHA-256 of the exact validated decision-file bytes. |
| `discovery_input_fingerprint` | Derived | SHA-256 of the exact validated discovery-file bytes. It cannot reconstruct deleted API data. |
| `capture_event_count` | Derived | Count used to audit append/no-op planning. |
| `decision_event_count` | Derived | Count used to audit append/no-op planning. |
| `api_video_count` | Derived | Aggregate count only; remains after API rows expire without preserving their content. |

### `corpus_gate_registrations`

| Stored value | Origin | Lifecycle and meaning |
| --- | --- | --- |
| `commitment_algorithm` | Public gate | Always `sha256` for version 1. Immutable. |
| `commitment_version` | Public gate | Versioned byte contract for local verification. Immutable. |
| `commitment_digest` | Derived outside Postgres | Commitment to the private salt and canonical eligible-key manifest. It reveals neither. Immutable. |
| `eligible_creator_count` | Public gate | Count only; immutable. |
| `minimum_reviewed_gradable_picks_overall` | Public gate | 500. Meeting it permits evaluation; it does not establish model validity. |
| `minimum_reviewed_gradable_picks_per_creator` | Public gate | 100 for every committed eligible creator. |
| `maximum_feature_count` | Public gate | 10 non-intercept fitted parameters. Each encoded column, transformation and interaction counts separately. |
| `start_season` / `start_week` | Public gate | 2024 Week 1, regular season. Immutable collection-window start. |
| `end_season` / `end_week` | Public gate | 2026 Week 4, regular season. Immutable collection-window end. |
| `rule_version` | Public gate | Inclusion rule fixed with the collection window. Immutable. |
| `registered_at` | Public gate | Owner registration instant, before holdout evaluation. Immutable. |
| `imported_at` | Importer | Separate local database import instant; never substitutes for `registered_at`. |

## Private eligible-creator commitment

Run registration only in the owner's terminal. The private record is outside
the repository and contains the sorted opaque eligible creator keys plus one
random 32-byte salt. Version 1 canonicalizes the manifest as compact UTF-8 JSON
with exactly this property order:

```text
{"formatVersion":1,"eligibleCreatorKeys":["sorted-key",...]}
```

The digest is the hexadecimal SHA-256 of these bytes, concatenated without a
delimiter ambiguity because the domain is fixed and the salt is exactly 32
bytes:

```text
UTF8("dfs-ev-demo:creator-readiness-gate:v1\0")
|| raw_32_byte_salt
|| UTF8(canonical_manifest)
```

`maximumFeatureCount` counts fitted non-intercept parameters, not friendly
feature labels. One-hot columns, transformed columns and interactions each
count. A model that needs more than 10 requires a new registration before any
holdout is inspected. Reaching the pick thresholds only opens the next
evaluation step; picks from the same video or game remain correlated.

The committed public gate contains only the algorithm/version, digest, creator
count, thresholds, registered window/rule and registration time. The raw
creator file, private gate record and salt never enter Git, Postgres, CI, an
agent session, an issue or a pull request.

## Prohibited storage and execution boundary

No corpus table may contain transcript text, title, description, audio, channel
name, creator name, thumbnail, URL, raw API payload or private salt. Step 2 must
prove this at schema level and in tests, not rely on importer convention.

The shared migration creates empty tables in every environment. Supported
hosted application roles receive no mutation privilege and no importer-function
execution. The owner importer accepts only an approved loopback or Unix-socket
database target and rejects a target before reading any private input. A
database owner can bypass application tooling with direct SQL; the guarantee
covers the supported importer and application roles. Any hosted creator data
requires the explicit #91 policy and role change.
