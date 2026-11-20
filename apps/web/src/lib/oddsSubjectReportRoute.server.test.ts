import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ report: vi.fn(), secret: vi.fn(() => "synthetic-health-secret") }));
vi.mock("./config.server", () => ({ serverConfig: { oddsHealthSecret: m.secret } }));
vi.mock("./oddsSubjectReport", () => ({ getOddsSubjectReport: m.report }));
vi.mock("./paidOddsBoundary", () => ({ paidOddsHealth: () => ({ mode: "log-only", scope: "this-instance", recentError: null }) }));
import { GET } from "../app/api/health/odds-subjects/route";
const counts = { admitted: 0, denied: 0, wouldDeny: 0, floorDenied: 0, anonymous: 0, signedIn: 0 };
const windows = ["1h", "24h"].map(window => ({ window, totals: counts, topAdmitted: [], topDenied: [], topWouldDeny: [] }));
const request = (authorization = "Bearer synthetic-health-secret") => new NextRequest("http://localhost/api/health/odds-subjects", { headers: { authorization } });
afterEach(() => { vi.clearAllMocks();vi.restoreAllMocks(); });
describe("authenticated subject report", () => {
  it("unauthorized requests do zero report SQL", async () => {
    const r = await GET(request("Bearer wrong"));expect(r.status).toBe(401);expect(m.report).not.toHaveBeenCalled();
  });
  it("returns bounded windows with inactive policy proposals and no-store", async () => {
    m.report.mockResolvedValue(windows);const r = await GET(request());
    expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ windows, thresholdsActive: false, health: { status: "policy-pending" }, limiter: { mode: "log-only" } });
    expect(m.report).toHaveBeenCalledTimes(1);
  });
  it("missing capability and report errors stay unavailable, without invented zero counts", async () => {
    m.report.mockResolvedValue(null);expect(await (await GET(request())).json()).toMatchObject({ status: "unavailable", reason: "not-installed" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    m.report.mockRejectedValue(new Error("private SQL/target"));const r = await GET(request());
    expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain("private");
    expect(warn.mock.calls).toEqual([["[odds-subject-report] report-unavailable"]]);
  });
  it("missing receiver configuration refuses before report work", async () => {
    m.secret.mockImplementationOnce(() => { throw new Error("private"); });
    expect((await GET(request())).status).toBe(503);expect(m.report).not.toHaveBeenCalled();
  });
});
