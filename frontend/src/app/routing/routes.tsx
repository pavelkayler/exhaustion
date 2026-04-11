import { Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { Spinner } from "react-bootstrap";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "./futureFlags";

function lazyPage<TModule, TKey extends keyof TModule>(
  loader: () => Promise<TModule>,
  exportName: TKey,
) {
  return lazy(async () => {
    const module = await loader();
    return { default: module[exportName] as ComponentType };
  });
}

function RouteFallback() {
  return (
    <div className="d-flex justify-content-center align-items-center py-5">
      <Spinner animation="border" role="status" />
    </div>
  );
}

function withSuspense(element: ReactNode) {
  return <Suspense fallback={<RouteFallback />}>{element}</Suspense>;
}

const dashboardPageLoader = () => import("../../pages/dashboard/DashboardPage");
const shortExecutionPageLoader = () => import("../../pages/shortExecution/ShortExecutionPage");
const shortSignalsPageLoader = () => import("../../pages/shortSignals/ShortSignalsPage");

const DashboardPage = lazyPage(dashboardPageLoader, "DashboardPage");
const ShortExecutionPage = lazyPage(shortExecutionPageLoader, "ShortExecutionPage");
const ShortSignalsPage = lazyPage(shortSignalsPageLoader, "ShortSignalsPage");

const routeModuleLoaders = new Map<string, () => Promise<unknown>>([
  ["/", dashboardPageLoader],
  ["/signals", shortSignalsPageLoader],
  ["/execution", shortExecutionPageLoader],
]);

const preloadedRoutes = new Set<string>();

export function preloadRoute(path: string): Promise<void> {
  const loader = routeModuleLoaders.get(path);
  if (!loader || preloadedRoutes.has(path)) return Promise.resolve();
  return loader().then(() => {
    preloadedRoutes.add(path);
  });
}

export function preloadPrimaryRoutes(): Promise<void> {
  const primaryPaths = ["/signals", "/execution"];
  return Promise.all(primaryPaths.map((path) => preloadRoute(path))).then(() => undefined);
}

export const routes = createBrowserRouter(
  [
    { path: "/", element: withSuspense(<DashboardPage />) },
    { path: "/signals", element: withSuspense(<ShortSignalsPage />) },
    { path: "/execution", element: withSuspense(<ShortExecutionPage />) },
    { path: "*", element: <Navigate to="/" replace /> }
  ],
  {
    future: ROUTER_FUTURE_FLAGS
  }
);
