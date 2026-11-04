// electron.vite.config.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
var __electron_vite_injected_dirname = "/Users/jay/Project/Jshell";
var pkgVersion = JSON.parse(readFileSync(resolve(__electron_vite_injected_dirname, "package.json"), "utf8")).version;
var electron_vite_config_default = defineConfig(({ command }) => {
  const dev = command === "serve";
  const csp = [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    dev ? "connect-src 'self' ws:" : "connect-src 'self'"
  ].join("; ");
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        __JSHELL_VERSION__: JSON.stringify(pkgVersion)
      },
      resolve: {
        alias: {
          "@shared": resolve(__electron_vite_injected_dirname, "src/shared")
        }
      },
      build: {
        outDir: "out/main",
        rollupOptions: {
          input: { index: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          "@shared": resolve(__electron_vite_injected_dirname, "src/shared")
        }
      },
      build: {
        outDir: "out/preload",
        rollupOptions: {
          input: { index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
        }
      }
    },
    renderer: {
      root: resolve(__electron_vite_injected_dirname, "src/renderer"),
      plugins: [
        react(),
        {
          name: "jshell-csp",
          transformIndexHtml(html) {
            return html.replace("%CSP%", csp);
          }
        }
      ],
      resolve: {
        alias: {
          "@shared": resolve(__electron_vite_injected_dirname, "src/shared"),
          "@renderer": resolve(__electron_vite_injected_dirname, "src/renderer/src")
        }
      },
      build: {
        outDir: "out/renderer",
        emptyOutDir: true,
        rollupOptions: {
          input: { index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html") }
        }
      }
    }
  };
});
export {
  electron_vite_config_default as default
};
