import ReactDOM from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
import { AppProviders } from "./app/providers/AppProviders";
import App from "./app/App";
import "./app/styles/globals.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

ReactDOM.createRoot(rootElement).render(
  <AppProviders>
    <App />
  </AppProviders>
);
