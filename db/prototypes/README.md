# Predictive scratch prototypes

These files are not ordered migrations, catalog contracts or a frozen prefix.
The dedicated tests apply them only after the released migrations in registered
disposable scratch databases. Do not apply them to a hosted or persistent app
database. Promotion requires the complete implementation, coordinated migration
number, generated artifacts and integration checks.

`0021_original_context.sql` is #106's provisional original-context recorder.
It enables sealed publication/replay of complete original schedule/identifier
claims and atomic schedule/game-bridge associations in a new capture. It does
not qualify membership, coverage, features or labels. Unsealed native canonical
associations remain blocked, and consumer hydration explicitly refuses
`context-consumer-replay-not-installed`. The public store methods return
`context-recording-not-installed` against frozen prefix 0020.
The raw ingest seal is not authority: replay must parse the original exact
CSV bytes and compare every claim. Original-byte consumer replay and integration
checks must pass before 0021 can be frozen for #118's 0022–0024 work.
