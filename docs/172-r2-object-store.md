# #172 R2 ObjectStore

## Design basis

The pipeline uses a portable S3 adapter with single-part conditional creation,
SHA-256 metadata on HEAD and byte verification on GET. The local store is the
default. HEAD followed by unconditional PUT permits concurrent overwrites.
Self-hosted MinIO adds responsibility for patching and storage durability.
Listing derives the digest claimed by a validated address, avoiding a HEAD
per object, and rejects keys that are outside the content-address format.

CI checks one request per basic operation, two for a duplicate PUT and its
HEAD, and one per LIST page. The opt-in contract uses synthetic bytes in the
dedicated test bucket with a ceiling of 50 Class A and 50 Class B requests.
Before R2 becomes the default store, remeasure #228's database address-lock
hold time with the remote HEAD inside the lock.
