// PostgreSQL and socket failures leave transaction outcome unknown. All callers
// withhold their result and replace the connection instead of attempting reuse.
export const connectionInterrupted = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return Boolean(code && (/^08/.test(code) || ["57P01", "57P02", "57P03", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"].includes(code)))
    || /Query read timeout|Connection terminated|Connection closed|ECONNRESET|EPIPE/.test(error.message);
};
