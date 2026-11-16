export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeOddsCache } = await import("./lib/oddsCacheStartup");
    await initializeOddsCache();
  }
}
