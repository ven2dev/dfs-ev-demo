import { useAppStore } from "./index";

export const useUid = () => useAppStore((state) => state.uid);
export const useDisplayName = () => useAppStore((state) => state.displayName);
export const useAuthStatus = () => useAppStore((state) => state.authStatus);
export const useSetUser = () => useAppStore((state) => state.setUser);
export const useAuthError = () => useAppStore((state) => state.authError);
export const useSetAuthError = () => useAppStore((state) => state.setAuthError);
export const useDataVerified = () => useAppStore((state) => state.dataVerified);

export const useConnectionStatus = () =>
  useAppStore((state) => state.connectionStatus);
export const useSetConnectionStatus = () =>
  useAppStore((state) => state.setConnectionStatus);

export const useMatchupConfig = () =>
  useAppStore((state) => state.matchupConfig);
export const useSetMatchupConfig = () =>
  useAppStore((state) => state.setMatchupConfig);

export const useSlate = () => useAppStore((state) => state.slate);
export const useSelectedMatchupId = () =>
  useAppStore((state) => state.selectedMatchupId);
export const useSetSelectedMatchupId = () =>
  useAppStore((state) => state.setSelectedMatchupId);
export const useCurrentMatchup = () =>
  useAppStore((state) =>
    state.slate.find((matchup) => matchup.id === state.selectedMatchupId)
  );

export const useGoal = () => useAppStore((state) => state.goal);
export const useSetGoal = () => useAppStore((state) => state.setGoal);

export const useWatchlist = () => useAppStore((state) => state.watchlist);
export const useSetWatchlist = () =>
  useAppStore((state) => state.setWatchlist);
