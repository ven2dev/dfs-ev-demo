import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketConsensusSummary } from "./MarketConsensusSummary";

describe("MarketConsensusSummary", () => {
  it("shows probability, direction, contributor count, method version, and guardrail", () => {
    render(
      <MarketConsensusSummary
        probability={0.518}
        direction="over"
        line={214.5}
        consensus={{
          method: "exact-line-median",
          version: 1,
          contributingBookCount: 4,
        }}
      />
    );

    expect(screen.getByText("Market probability (over)")).toBeInTheDocument();
    expect(screen.getByText("51.8% · 4 books")).toBeInTheDocument();
    expect(screen.getByText(/Exact-line median v1/)).toHaveTextContent("line 214.5");
    expect(screen.getByText(/Book count reports market coverage/)).toHaveTextContent(
      "not confidence"
    );
  });

  it("labels a one-book fallback honestly", () => {
    render(
      <MarketConsensusSummary
        probability={0.5}
        direction="under"
        line={45.5}
        consensus={{
          method: "exact-line-median",
          version: 1,
          contributingBookCount: 1,
        }}
      />
    );

    expect(screen.getByText("50.0% · 1 book")).toBeInTheDocument();
  });
});
