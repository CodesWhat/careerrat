import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.jsx";
import { RolesterClerkProvider } from "./auth/clerkControls.jsx";
import { PasswordGate } from "./preview/PasswordGate.jsx";
import "./styles/tokens.css";
import "./styles/app.css";
import "./design/design.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const routerBasename = import.meta.env.VITE_ROUTER_BASENAME || "/app";
const app = (
  <BrowserRouter basename={routerBasename}>
    <App />
  </BrowserRouter>
);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RolesterClerkProvider publishableKey={clerkPublishableKey}>
      <PasswordGate>{app}</PasswordGate>
    </RolesterClerkProvider>
  </StrictMode>
);
