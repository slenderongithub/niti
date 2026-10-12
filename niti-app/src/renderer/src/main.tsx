import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { App } from "./App";

// Load both faces up front: the first transcript or diff would otherwise stall a frame while the
// monospace face loads and shapes.
// Every weight the UI uses, with the symbols it draws, so the first visit to a page doesn't stall
// on a face, a subset, or a fallback lookup for a glyph the face lacks.
const SAMPLE = "Aa1 ·→←↳★⇄─▸●◐○✖☑◼☐…";
void Promise.all([
  ...[400, 600].map((w) => document.fonts.load(`${w} 12px "JetBrains Mono Variable"`, SAMPLE)),
  ...[400, 500, 600, 700].map((w) => document.fonts.load(`${w} 13px "Hanken Grotesk Variable"`, SAMPLE)),
]).catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
