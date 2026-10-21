// URLs only: loading these references opens no connection and reads no files.
export const databaseAssets = Object.freeze({
  migrations: new URL("../migrations/", import.meta.url),
  manifest: new URL("../migration-manifest.json", import.meta.url),
  schema: new URL("../schema.sql", import.meta.url),
  catalog: new URL("../catalog.sql", import.meta.url),
  contracts: new URL("../catalog-contracts/", import.meta.url),
  readinessPolicy: new URL("../readiness.json", import.meta.url),
  readinessManifest: new URL("./dbReadinessManifest.ts", import.meta.url),
});
