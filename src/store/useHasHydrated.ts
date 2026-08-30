import { useEffect, useState } from "react";
import { useAppStore } from "./index";

export function useHasHydrated() {
  // useAppStore.persist is absent during SSR (no `window`/localStorage
  // there causes zustand's persist middleware to skip attaching it) —
  // treat "not present" the same as "not yet hydrated".
  const [hasHydrated, setHasHydrated] = useState(
    () => useAppStore.persist?.hasHydrated() ?? false
  );

  useEffect(() => {
    const unsubscribe = useAppStore.persist?.onFinishHydration(() =>
      setHasHydrated(true)
    );
    return unsubscribe;
  }, []);

  return hasHydrated;
}
