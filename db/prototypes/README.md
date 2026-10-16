# Predictive scratch prototypes

These files are not ordered migrations, catalog contracts or a frozen prefix.
The dedicated tests apply them only after the released migrations in registered
disposable scratch databases. Do not apply them to a hosted or persistent app
database. Promotion requires the complete implementation, coordinated migration
number, generated artifacts and integration checks.

`0021_original_context.sql` is #106's provisional original-context recorder.
It enables sealed publication/replay of complete original schedule/identifier
claims and atomic schedule/game-bridge associations in a new capture. It does
not qualify real membership, coverage, features or labels. Unsealed native
canonical associations remain blocked. Guarded consumer hydration now reparses
the original CSV and checks the complete association set before delivery.
The public store methods return
`context-recording-not-installed` against frozen prefix 0020.
The raw ingest seal is not authority: replay must parse the original exact
CSV bytes and compare every claim. Ordered migration/catalog promotion, upgrade
and integrated checks remain before 0021 can be frozen. As of 2026-10-16 the
owner released the old 0022–0024 reservations; the revised #129/#132 design also
needs #106 review before assuming the previous promotion sequence still applies.
