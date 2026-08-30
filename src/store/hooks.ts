import { useAppStore } from "./index";

export const useConnectionStatus = () =>
  useAppStore((state) => state.connectionStatus);
export const useSetConnectionStatus = () =>
  useAppStore((state) => state.setConnectionStatus);

export const useMatchupConfig = () =>
  useAppStore((state) => state.matchupConfig);
export const useSetMatchupConfig = () =>
  useAppStore((state) => state.setMatchupConfig);

export const useCurrentMatchup = () =>
  useAppStore((state) => state.currentMatchup);
export const useSetCurrentMatchup = () =>
  useAppStore((state) => state.setCurrentMatchup);

export const useGoal = () => useAppStore((state) => state.goal);
export const useSetGoal = () => useAppStore((state) => state.setGoal);

export const useWatchlist = () => useAppStore((state) => state.watchlist);
export const useSetWatchlist = () =>
  useAppStore((state) => state.setWatchlist);
