export type ArtifactGovernanceCode =
  | "model-publication-invalidated"
  | "model-object-deleted"
  | "model-current-rights-refused"
  | "model-read-request-refused"
  | "model-read-missing"
  | "model-read-status-refused"
  | "model-read-session-refused"
  | "model-artifact-unavailable";

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
    : sqlstate === "P1663" ? "model-read-request-refused"
    : sqlstate === "P1664" ? "model-read-missing"
    : sqlstate === "P1665" ? "model-current-rights-refused"
    : sqlstate === "P1666" ? "model-read-status-refused"
    : sqlstate === "P1667" ? "model-read-session-refused" : undefined;
  return code ? new ArtifactGovernanceError(code, error) : error;
};
