import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAppStore } from "@/store";
import { ConnectionIndicator } from "./ConnectionIndicator";

const initialState = useAppStore.getState();
afterEach(() => useAppStore.setState(initialState, true));

it("keeps connection changes visible while account data is loading or failed", () => {
  useAppStore.setState({ dataVerified: false, connectionStatus: "connecting" });
  render(<ConnectionIndicator />);
  expect(screen.getByRole("status", { name: "Odds connection" })).toHaveTextContent("connecting");
  act(() => useAppStore.setState({ dataLoadError: "Unable to load account", connectionStatus: "disconnected" }));
  expect(screen.getByRole("status", { name: "Odds connection" })).toHaveTextContent("disconnected");
  act(() => useAppStore.setState({ connectionStatus: "stale" }));
  expect(screen.getByRole("status", { name: "Odds connection" })).toHaveTextContent("stale");
});
