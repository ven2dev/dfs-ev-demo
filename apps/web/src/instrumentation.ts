export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeOddsCache } = await import("./lib/oddsCacheStartup");
    // Isolate this dependency: auth/pages can become ready while odds requests
    // await the shared check or refuse until its retry succeeds.
    void initializeOddsCache().catch(() => {
      console.error("[odds-cache] capability check unavailable; odds requests remain gated until retry");
    });
  }
};
