import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// KaTeX ships its own fonts; Vite inlines/bundles them from this import.
import "katex/dist/katex.min.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
