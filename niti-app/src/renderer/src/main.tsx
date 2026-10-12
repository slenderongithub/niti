import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { App } from "./App";

// Load both faces up front: the first transcript or diff would otherwise stall a frame while the
// monospace face loads and shapes.
void Promise.all([
  document.fonts.load('400 12px "JetBrains Mono Variable"'),
  document.fonts.load('600 12px "JetBrains Mono Variable"'),
  document.fonts.load('400 13px "Inter Variable"'),
  document.fonts.load('600 13px "Inter Variable"'),
]).catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
