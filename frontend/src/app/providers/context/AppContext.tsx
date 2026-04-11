import { createContext, type PropsWithChildren } from "react";
import { APP_NAME, APP_UPDATED_DATE, APP_VERSION } from "../../appMeta";

type AppContextValue = {
  appName: string;
  appVersion: string;
  appUpdatedDate: string;
};

const defaultAppContextValue: AppContextValue = {
  appName: APP_NAME,
  appVersion: APP_VERSION,
  appUpdatedDate: APP_UPDATED_DATE,
};

const AppContext = createContext<AppContextValue>(defaultAppContextValue);

function AppContextProvider({ children }: PropsWithChildren) {
  const values: AppContextValue = {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    appUpdatedDate: APP_UPDATED_DATE,
  };

  return <AppContext.Provider value={values}>{children}</AppContext.Provider>;
}

export { AppContext, AppContextProvider, type AppContextValue };
