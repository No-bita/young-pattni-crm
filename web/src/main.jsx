import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import ScreenErrorBoundary from "./components/ScreenErrorBoundary.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ScreenErrorBoundary><App /></ScreenErrorBoundary>
  </StrictMode>,
);
