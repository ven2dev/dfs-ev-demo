import { describe, expect, it } from "vitest";
import { requireLiveOddsDataSource, resolveOddsDataSource } from "./oddsDataSource";

describe("resolveOddsDataSource", () => {
  it("preserves live Production behavior during rollout and requires its credential", () => {
    expect(
      resolveOddsDataSource({
        VERCEL_ENV: "production",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: "production-key",
      })
    ).toBe("live");

    expect(() =>
      resolveOddsDataSource({
        VERCEL_ENV: "production",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: undefined,
      })
    ).toThrow("requires ODDS_API_KEY");
  });

  it("refuses fixture mode in Production", () => {
    expect(() =>
      resolveOddsDataSource({
        VERCEL_ENV: "production",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: "fixture",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Production refuses");
  });

  it("defaults Preview to fixtures and refuses live Preview access", () => {
    expect(
      resolveOddsDataSource({
        VERCEL_ENV: "preview",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: undefined,
      })
    ).toBe("fixture");

    expect(() =>
      resolveOddsDataSource({
        VERCEL_ENV: "preview",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: "live",
        ODDS_API_KEY: "should-not-matter",
      })
    ).toThrow("Preview refuses");
  });

  it("defaults local development and tests to fixtures but permits explicit live use", () => {
    expect(
      resolveOddsDataSource({
        VERCEL_ENV: undefined,
        NODE_ENV: "development",
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: undefined,
      })
    ).toBe("fixture");
    expect(
      resolveOddsDataSource({
        VERCEL_ENV: undefined,
        NODE_ENV: "development",
        ODDS_DATA_SOURCE: "live",
        ODDS_API_KEY: "local-key",
      })
    ).toBe("live");
  });

  it("does not read ODDS_API_KEY in fixture mode", () => {
    const reads: PropertyKey[] = [];
    const env = new Proxy(
      {
        VERCEL_ENV: "preview",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: "fixture",
      } as NodeJS.ProcessEnv,
      {
        get(target, property, receiver) {
          reads.push(property);
          if (property === "ODDS_API_KEY") throw new Error("fixture read the provider key");
          return Reflect.get(target, property, receiver);
        },
      }
    );

    expect(resolveOddsDataSource(env)).toBe("fixture");
    expect(reads).not.toContain("ODDS_API_KEY");
  });

  it("fails closed for unknown source and deployment values", () => {
    expect(() =>
      resolveOddsDataSource({
        VERCEL_ENV: "preview",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: "mock",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Unknown ODDS_DATA_SOURCE");
    expect(() =>
      resolveOddsDataSource({
        VERCEL_ENV: "staging",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: "fixture",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Unknown VERCEL_ENV");
  });
});

describe("requireLiveOddsDataSource", () => {
  it("rejects collector-style operations in fixture mode", () => {
    expect(() =>
      requireLiveOddsDataSource({
        VERCEL_ENV: "preview",
        NODE_ENV: "production",
        ODDS_DATA_SOURCE: "fixture",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("disabled unless ODDS_DATA_SOURCE=live");
  });
});
