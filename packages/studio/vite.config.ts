import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const vendorChunkRules: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  [
    "vendor-react",
    [
      "/node_modules/react/",
      "/node_modules/react-dom/",
      "/node_modules/scheduler/",
    ],
  ],
  [
    "vendor-ui",
    [
      "/node_modules/@base-ui/",
      "/node_modules/@radix-ui/",
      "/node_modules/class-variance-authority/",
      "/node_modules/clsx/",
      "/node_modules/cmdk/",
      "/node_modules/lucide-react/",
      "/node_modules/motion/",
      "/node_modules/tailwind-merge/",
      "/node_modules/zustand/",
    ],
  ],
  [
    "vendor-ai",
    [
      "/node_modules/@ai-sdk/",
      "/node_modules/ai/",
    ],
  ],
];

function manualChunks(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, "/");
  if (!normalizedId.includes("/node_modules/")) return undefined;

  for (const [chunkName, packagePathFragments] of vendorChunkRules) {
    if (packagePathFragments.some((fragment) => normalizedId.includes(fragment))) {
      return chunkName;
    }
  }

  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 4567,
    proxy: {
      "/api/v1/events": {
        target: `http://localhost:${process.env.INKOS_STUDIO_PORT ?? "4569"}`,
        changeOrigin: true,
        // SSE needs unbuffered streaming — bypass http-proxy response handling
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
          });
        },
      },
      "/api": {
        target: `http://localhost:${process.env.INKOS_STUDIO_PORT ?? "4569"}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "chrome61",
    cssTarget: "chrome61",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});
