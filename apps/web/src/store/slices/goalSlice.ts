import type { Goal } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface GoalSlice {
  goal: Goal | null;
  setGoal: (goal: Goal) => void;
}

export const createGoalSlice: StateCreator<
  AppState,
  [],
  [],
  GoalSlice
> = (set) => ({
  goal: null,
  setGoal: (goal) => set({ goal }),
});
