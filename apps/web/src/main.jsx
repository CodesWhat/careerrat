import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { App } from "./App.jsx";
import "./chat-first/app-foundation.css";

const routerBasename = import.meta.env.VITE_ROUTER_BASENAME || "/app";
const router = createBrowserRouter([{ path: "*", element: <App /> }], {
  basename: routerBasename,
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
