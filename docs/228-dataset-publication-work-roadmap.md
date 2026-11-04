# #228 dataset publication work budget

The owner approved deterministic work budgets in place of the proposed
150/105 ms timing gate. On the historical fixture, SQL dominates the address
lock window and the hashing change is small compared with timing variation.
Counting work directly tests whether larger payloads add hashing or file reads
under the lock.

## Design basis

- Pattern. Prepare the immutable file identity and manifest bind values,
  including serialized member IDs, before BEGIN. Reuse the digest for the
  content address, HEAD comparison, manifest and return value. Keep the
  upload before BEGIN and verify metadata under the existing address lock.
- Alternatives. Hashing once in the transaction would still scale with file
  size. Moving HEAD outside the transaction would let the cleaner remove
  the object between verification and publication.
- Targets. From BEGIN dispatch through COMMIT or ROLLBACK completion, zero
  digest operations and zero payload reads. One upload completes before
  BEGIN. One metadata-only HEAD runs after the lock response. Successful
  publication uses eight SQL statements, five in the transaction, with no
  per-member calls. Refusals retain their existing SQL and cleanup sequence.
- Requirement reasons. The work budget prevents file-size work under the
  shared lock. Metadata verification under that lock preserves cleaner
  coordination. Existing snapshot checks, pins and database clocks preserve
  authorization and publication semantics.
- Assumptions. Guarded local PostgreSQL and the local ObjectStore exercise
  the real publisher. CI observes work through the adapter and its file
  operations. SHA-256 timing is an informational calculation outside CI.

## Iteration

1. Add the deterministic work oracle and prove that the unchanged publisher
   fails it with two transaction hashes.
2. Move identity and bind preparation before BEGIN. Check success,
   cleaner-wins missing bytes, mismatched metadata and manifest rollback
   against the actual local store and database.
3. Run the feature-store suite and static gates. Save a new source-hashed
   receipt with the baseline failure and computed hashing cost. Report for
   owner review before committing.

The original detached intake draft is superseded by this roadmap. Protected
#231 and #167 paths remain outside this issue.
