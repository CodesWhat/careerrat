import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.jsx";
import { RolesterClerkProvider } from "./auth/clerkControls.jsx";
import "./styles/tokens.css";
import "./styles/app.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const app = (
  <BrowserRouter basename="/app">
    <App />
  </BrowserRouter>
);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RolesterClerkProvider publishableKey={clerkPublishableKey}>{app}</RolesterClerkProvider>
  </StrictMode>
);
