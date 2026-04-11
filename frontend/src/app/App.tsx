import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { preloadPrimaryRoutes, routes } from "./routing/routes";
import { ROUTER_PROVIDER_FUTURE_FLAGS } from "./routing/futureFlags";

export default function App() {
  useEffect(() => {
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let timeoutId: number | null = null;
    let idleId: number | null = null;
    const startPreload = () => {
      void preloadPrimaryRoutes();
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleId = idleWindow.requestIdleCallback(startPreload);
    } else {
      timeoutId = window.setTimeout(startPreload, 250);
    }
    return () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (idleId != null && typeof idleWindow.cancelIdleCallback === "function") {
        idleWindow.cancelIdleCallback(idleId);
      }
    };
  }, []);

  return (
    <div style={{ maxWidth: "100vw", overflowX: "hidden" }}>
      <RouterProvider router={routes} future={ROUTER_PROVIDER_FUTURE_FLAGS} />
    </div>
  );
}
