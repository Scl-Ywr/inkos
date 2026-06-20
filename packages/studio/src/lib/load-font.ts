/**
 * Lazy-load decorative @fontsource fonts on demand.
 * The CSS @import in index.css was removed to reduce initial bundle size.
 * Call loadDecorativeFont() before applying a decorative font family.
 */

const FONT_LOAD_MAP: Record<string, () => Promise<unknown>> = {
  "ZCOOL KuaiLe":               () => import("@fontsource/zcool-kuaile"),
  "ZCOOL QingKe HuangYou":      () => import("@fontsource/zcool-qingke-huangyou"),
  "ZCOOL XiaoWei":              () => import("@fontsource/zcool-xiaowei"),
  "Ma Shan Zheng":              () => import("@fontsource/ma-shan-zheng"),
};

const loaded = new Set<string>();

/**
 * Load a decorative font by its CSS font-family name.
 * Safe to call multiple times — only fetches once per font.
 */
export async function loadDecorativeFont(family: string): Promise<void> {
  const loader = FONT_LOAD_MAP[family];
  if (!loader || loaded.has(family)) return;
  loaded.add(family);
  try {
    await loader();
  } catch {
    loaded.delete(family);
  }
}

/**
 * Extract the first font-family name from a CSS value like
 * '"ZCOOL KuaiLe", sans-serif' → 'ZCOOL KuaiLe'
 */
export function extractFontFamily(cssValue: string | null): string | null {
  if (!cssValue) return null;
  const match = cssValue.match(/^"([^"]+)"/);
  return match ? match[1] : cssValue.split(",")[0].trim();
}
