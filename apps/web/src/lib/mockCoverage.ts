// Mocked alignment/coverage inputs, visibly labeled "sample data" in the UI:
// no affordable PFF/SIS-style coverage source exists (see #137 for free data).
// Lives in src/lib, not src/store, because the server stream route uses it and
// server code must not depend on the UI layer (enforced by dependency-cruiser).
export const mockCoverageFilters: Record<string, unknown> = {
  primaryDefender: "J. Smith",
  shadowCoverageRate: 0.35,
  avgSeparationYards: 2.3,
};
