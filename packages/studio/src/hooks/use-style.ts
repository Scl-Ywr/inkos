import { useState, useEffect, useCallback } from "react";
import { DEFAULT_HUE, DEFAULT_SATURATION } from "../lib/style-presets";
import { loadDecorativeFont, extractFontFamily } from "../lib/load-font";

const STORAGE_KEY = "inkos:studio:custom-style";

export interface CustomStyle {
  readonly fontFamily: string | null;
  readonly accentHue: number;
  readonly accentSaturation: number;
}

const DEFAULT_STYLE: CustomStyle = {
  fontFamily: null,
  accentHue: DEFAULT_HUE,
  accentSaturation: DEFAULT_SATURATION,
};

function readStyle(): CustomStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STYLE;
    const parsed = JSON.parse(raw);
    return {
      fontFamily: typeof parsed.fontFamily === "string" ? parsed.fontFamily : null,
      accentHue: typeof parsed.accentHue === "number" ? parsed.accentHue : DEFAULT_HUE,
      accentSaturation: typeof parsed.accentSaturation === "number" ? parsed.accentSaturation : DEFAULT_SATURATION,
    };
  } catch {
    return DEFAULT_STYLE;
  }
}

function writeStyle(style: CustomStyle): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    // ignore storage errors
  }
}

function applyStyleToDom(style: CustomStyle): void {
  const root = document.documentElement;

  // Font override
  if (style.fontFamily) {
    root.style.setProperty("--font-sans", style.fontFamily);
    root.style.setProperty("--font-serif", style.fontFamily);
  } else {
    root.style.removeProperty("--font-sans");
    root.style.removeProperty("--font-serif");
  }

  // Color override
  const h = style.accentHue;
  const s = style.accentSaturation / 100;
  const isDark = root.classList.contains("dark");

  if (h === DEFAULT_HUE && s === DEFAULT_SATURATION / 100) {
    // Default colors — remove overrides to use CSS file values
    root.style.removeProperty("--primary");
    root.style.removeProperty("--primary-foreground");
    root.style.removeProperty("--accent");
    root.style.removeProperty("--ring");
    return;
  }

  if (isDark) {
    root.style.setProperty("--primary", `oklch(0.820 ${s} ${h})`);
    root.style.setProperty("--primary-foreground", `oklch(0.165 0.014 285)`);
    root.style.setProperty("--accent", `oklch(0.780 ${s * 1.05} ${(h + 65) % 360})`);
    root.style.setProperty("--ring", `oklch(0.820 ${s} ${h})`);
  } else {
    root.style.setProperty("--primary", `oklch(0.725 ${s} ${h})`);
    root.style.setProperty("--primary-foreground", `oklch(0.995 0.006 58)`);
    root.style.setProperty("--accent", `oklch(0.865 ${s * 0.98} ${(h + 66) % 360})`);
    root.style.setProperty("--ring", `oklch(0.725 ${s} ${h})`);
  }
}

export function useStyle() {
  const [customStyle, setCustomStyle] = useState<CustomStyle>(readStyle);

  useEffect(() => {
    applyStyleToDom(customStyle);
  }, [customStyle]);

  // Re-apply when dark mode toggles
  useEffect(() => {
    const observer = new MutationObserver(() => applyStyleToDom(customStyle));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [customStyle]);

  const setFontFamily = useCallback((fontFamily: string | null) => {
    const family = extractFontFamily(fontFamily);
    if (family && family !== "Noto Sans SC Variable" && family !== "Noto Serif SC Variable") {
      void loadDecorativeFont(family).then(() => {
        setCustomStyle((prev) => {
          const next = { ...prev, fontFamily };
          writeStyle(next);
          return next;
        });
      });
    } else {
      setCustomStyle((prev) => {
        const next = { ...prev, fontFamily };
        writeStyle(next);
        return next;
      });
    }
  }, []);

  const setAccentColor = useCallback((accentHue: number, accentSaturation?: number) => {
    setCustomStyle((prev) => {
      const next = { ...prev, accentHue, accentSaturation: accentSaturation ?? prev.accentSaturation };
      writeStyle(next);
      return next;
    });
  }, []);

  const resetStyle = useCallback(() => {
    setCustomStyle(DEFAULT_STYLE);
    writeStyle(DEFAULT_STYLE);
  }, []);

  return { customStyle, setFontFamily, setAccentColor, resetStyle };
}
