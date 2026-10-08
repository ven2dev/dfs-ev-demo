# Historical schema fixtures

These immutable fixtures were copied directly from the listed Git objects.
They are independent of the candidate migration files and generated reference;
tests never generate or rewrite them and do not require Git history at runtime.

| Fixture | Source object | SHA-256 |
| --- | --- | --- |
| `pre-41.schema.sql` | `68c65f6e918730b0d8b22a761a482a79225347b6:db/schema.sql` | `a01c8ab5d91939d731c71571ede83bfc4e6123ef1f61b8a0918f4f951f306c98` |
| `current-before-60.schema.sql` | `a3a5dd970f1bc7b6d72f5697ddc9a8cd8014d71e:db/schema.sql` | `95c349dc4fb79a604ce3c38abe2d064673bd6d6a86e3cbed8a086744102a85c2` |

The first fixture contains eight tables; the second contains those eight plus
the nine #41 tables. SHA-256 anchors and candidate byte comparisons run in the
migration unit suite. Real-Postgres suites apply the fixtures independently of
the runner, preserving a non-circular catalog comparison in shallow checkouts.
`.gitattributes` pins fixture line endings to LF.

Future migrations append new files and contracts. Preserve these two historical
fixtures and their anchors; changes to them require a provenance correction
with explicit source-object evidence, not regeneration from the migrations.
