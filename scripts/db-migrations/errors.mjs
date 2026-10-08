export class MigrationError extends Error {}
export function refuse(code) { throw new MigrationError(code); }
