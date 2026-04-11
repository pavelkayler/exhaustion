import type { PropsWithChildren } from "react";
import { AppContextProvider } from "./context/AppContext";

/**
 * Global app providers (placeholders).
 * Keep this component even if currently empty: later we can add QueryClient, Theme, etc.
 */
export function AppProviders({ children }: PropsWithChildren) {
  return <AppContextProvider>{children}</AppContextProvider>;
}
