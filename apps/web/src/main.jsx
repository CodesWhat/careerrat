import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.jsx";
import "./chat-first/app-foundation.css";

const routerBasename = import.meta.env.VITE_ROUTER_BASENAME || "/app";
const app = (
  <BrowserRouter basename={routerBasename}>
    <App />
  </BrowserRouter>
);

createRoot(document.getElementById("root")).render(<StrictMode>{app}</StrictMode>);
