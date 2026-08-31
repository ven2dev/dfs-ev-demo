import assert from "node:assert/strict";
import { test } from "node:test";
import { devigTwoWay } from "./devig.ts";

test("devigTwoWay: a fair (no-vig) 50/50 market stays 50/50", () => {
  const { impliedProbOver, impliedProbUnder } = devigTwoWay(2.0, 2.0);
  assert.ok(Math.abs(impliedProbOver - 0.5) < 1e-9);
  assert.ok(Math.abs(impliedProbUnder - 0.5) < 1e-9);
});

test("devigTwoWay: removes the bookmaker's margin so probabilities sum to 1", () => {
  // Realistic vig'd two-way prices (raw implied probs sum to > 1)
  const { impliedProbOver, impliedProbUnder } = devigTwoWay(1.91, 1.91);
  assert.ok(Math.abs(impliedProbOver + impliedProbUnder - 1) < 1e-9);
});

test("devigTwoWay: a shorter price implies a higher devigged probability", () => {
  const { impliedProbOver, impliedProbUnder } = devigTwoWay(1.5, 3.0);
  assert.ok(impliedProbOver > impliedProbUnder);
});
