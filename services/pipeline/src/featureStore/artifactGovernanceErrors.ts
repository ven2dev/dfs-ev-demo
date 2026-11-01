export type ArtifactGovernanceCode =
  | "model-publication-invalidated"
  | "model-object-deleted"
  | "model-current-rights-refused";

export class ArtifactGovernanceError extends Error {
  readonly code: ArtifactGovernanceCode;

  constructor(code: ArtifactGovernanceCode, cause?: unknown) {
    super(code, { cause });
    this.name = "ArtifactGovernanceError";
    this.code = code;
  }
}

// SQLSTATE is the contract. Provider messages and unrelated database/connection
// failures are preserved rather than classified with brittle message matching.
export const artifactGovernanceError = (error: unknown): unknown => {
  const sqlstate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = sqlstate === "P1661" ? "model-publication-invalidated"
    : sqlstate === "P1662" ? "model-object-deleted"
    : sqlstate === "P1665" ? "model-current-rights-refused" : undefined;
  return code ? new ArtifactGovernanceError(code, error) : error;
};
