import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HitRateSummary } from "./HitRateSummary";

describe("HitRateSummary", () => {
  it.each([3, 5, 7])("labels a %i-game sample without implying calibration", (sampleSize) => {
    render(<HitRateSummary rate={0.6} adjustedRate={0.565} sampleSize={sampleSize} />);
    expect(screen.getByText(`Recent hit rate · n = ${sampleSize} games`)).toBeInTheDocument();
    expect(screen.getByText("60.0%")).toBeInTheDocument();
    expect(screen.getByText(/Small sample/)).toHaveTextContent("not a calibrated prediction");
    expect(screen.queryByText(/Low confidence/)).not.toBeInTheDocument();
  });

  it.each([0, 1])("marks extreme raw hit rate %s as low confidence", (rate) => {
    render(<HitRateSummary rate={rate} adjustedRate={0.5} sampleSize={3} />);
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
  });

  it.each([0, 1, 0.9997])("also flags a displayed adjusted extreme %s", (adjustedRate) => {
    render(<HitRateSummary rate={0.6} adjustedRate={adjustedRate} sampleSize={5} />);
    expect(screen.getByText(/Low confidence/)).toBeInTheDocument();
  });

  it("does not invent a sample count for a legacy snapshot", () => {
    render(<HitRateSummary rate={0.6} adjustedRate={0.565} />);
    expect(screen.getByText(/Sample size unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/n =/)).not.toBeInTheDocument();
  });
});
