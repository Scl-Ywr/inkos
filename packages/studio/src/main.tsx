import "./index.css";
import "./legacy-webview.css";
import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

if (Capacitor.isNativePlatform()) {
  void StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
  void StatusBar.setStyle({ style: Style.Default }).catch(() => undefined);
}

const supportsCss = globalThis.CSS?.supports?.bind(globalThis.CSS);

const supportsOklch = !!supportsCss?.("color", "oklch(0.5 0 0)");
const supportsBackdropFilter =
  !!supportsCss?.("backdrop-filter", "blur(2px)") ||
  !!supportsCss?.("-webkit-backdrop-filter", "blur(2px)");

let supportsHasSelector = false;
try {
  supportsHasSelector = !!supportsCss?.("selector(:has(*))");
} catch {
  supportsHasSelector = false;
}

if (!supportsOklch || !supportsBackdropFilter || !supportsHasSelector) {
  document.documentElement.classList.add("legacy-webview");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
