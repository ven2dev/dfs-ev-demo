import type { ConnectionStatus } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface ConnectionSlice {
  connectionStatus: ConnectionStatus;
  setConnectionStatus: (status: ConnectionStatus) => void;
}

export const createConnectionSlice: StateCreator<
  AppState,
  [],
  [],
  ConnectionSlice
> = (set) => ({
  connectionStatus: "disconnected",
  setConnectionStatus: (status) => set({ connectionStatus: status }),
});
