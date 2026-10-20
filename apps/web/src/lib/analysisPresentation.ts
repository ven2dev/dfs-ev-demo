export const formatEdgePoints = (edge: number) => {
  const rounded = (edge * 100).toFixed(1);
  return `${rounded === "-0.0" ? "0.0" : edge > 0 && rounded !== "0.0" ? `+${rounded}` : rounded} pts`;
};
