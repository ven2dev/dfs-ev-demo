import { describe, expect, it } from "vitest";
import { createServerConfig, type ServerInputName } from "./config.server";

const configuration = (env: Partial<Record<ServerInputName, string | undefined>>) => createServerConfig(name => env[name]);
const resolve = (env: Partial<Record<ServerInputName, string | undefined>>) => configuration(env).odds().source;
const requireLive = (env: Partial<Record<ServerInputName, string | undefined>>) => configuration(env).liveOdds().source;

describe("resolveOddsDataSource", () => {
  it("preserves live Production behavior during rollout and requires its credential", () => {
    expect(
      resolve({
        VERCEL_ENV: "production",
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: "production-key",
      })
    ).toBe("live");

    expect(() =>
      resolve({
        VERCEL_ENV: "production",
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Application configuration unavailable");
  });

  it("refuses fixture mode in Production", () => {
    expect(() =>
      resolve({
        VERCEL_ENV: "production",
        ODDS_DATA_SOURCE: "fixture",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Application configuration unavailable");
  });

  it("defaults Preview to fixtures and refuses live Preview access", () => {
    expect(
      resolve({
        VERCEL_ENV: "preview",
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: undefined,
      })
    ).toBe("fixture");

    expect(() =>
      resolve({
        VERCEL_ENV: "preview",
        ODDS_DATA_SOURCE: "live",
        ODDS_API_KEY: "should-not-matter",
      })
    ).toThrow("Application configuration unavailable");
  });

  it("defaults local development and tests to fixtures but permits explicit live use", () => {
    expect(
      resolve({
        VERCEL_ENV: undefined,
        ODDS_DATA_SOURCE: undefined,
        ODDS_API_KEY: undefined,
      })
    ).toBe("fixture");
    expect(
      resolve({
        VERCEL_ENV: undefined,
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
        ODDS_DATA_SOURCE: "fixture",
      },
      {
        get(target, property, receiver) {
          reads.push(property);
          if (property === "ODDS_API_KEY") throw new Error("fixture read the provider key");
          return Reflect.get(target, property, receiver);
        },
      }
    );

    expect(resolve(env)).toBe("fixture");
    expect(reads).not.toContain("ODDS_API_KEY");
  });

  it("fails closed for unknown source and deployment values", () => {
    expect(() =>
      resolve({
        VERCEL_ENV: "preview",
        ODDS_DATA_SOURCE: "mock",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Application configuration unavailable");
    expect(() =>
      resolve({
        VERCEL_ENV: "staging",
        ODDS_DATA_SOURCE: "fixture",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Application configuration unavailable");
  });
});

describe("requireLiveOddsDataSource", () => {
  it("rejects collector-style operations in fixture mode", () => {
    expect(() =>
      requireLive({
        VERCEL_ENV: "preview",
        ODDS_DATA_SOURCE: "fixture",
        ODDS_API_KEY: undefined,
      })
    ).toThrow("Application configuration unavailable");
  });
});
