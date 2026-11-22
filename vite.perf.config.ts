import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import {
  PERF_FIXTURE_DIR,
  resolveGeneratedFixturePath,
} from "./scripts/generate-perf-fixtures.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL_PREFIX = "/tests/perf/generated/";

/**
 * Serves only basename-addressed Markdown fixtures for the production perf
 * preview. Traversal, encoded separators, other suffixes and missing files
 * never fall through to the SPA shell, and every fixture response is
 * explicitly uncached so a measurement never reuses a previous build's bytes.
 */
const fixturePreviewMiddleware: Plugin = {
  name: "opus:perf-fixture-preview",
  configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url) {
        next();
        return;
      }
      let pathname: string;
      try {
        pathname = new URL(request.url, "http://127.0.0.1").pathname;
      } catch {
        response.statusCode = 400;
        response.setHeader("Cache-Control", "no-store");
        response.end("bad request");
        return;
      }
      if (!pathname.startsWith(FIXTURE_URL_PREFIX)) {
        next();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        response.setHeader("Allow", "GET, HEAD");
        response.setHeader("Cache-Control", "no-store");
        response.end("method not allowed");
        return;
      }
      let name: string;
      try {
        name = decodeURIComponent(pathname.slice(FIXTURE_URL_PREFIX.length));
      } catch {
        response.statusCode = 400;
        response.setHeader("Cache-Control", "no-store");
        response.end("bad fixture name");
        return;
      }
      const basenameOnly =
        name === path.basename(name) &&
        !name.includes("\\") &&
        !name.includes("\0") &&
        name.endsWith(".md");
      if (!basenameOnly) {
        response.statusCode = 404;
        response.setHeader("Cache-Control", "no-store");
        response.end("fixture not found");
        return;
      }
      void resolveGeneratedFixturePath(PERF_FIXTURE_DIR, name)
        .then(async (file) => {
          if (!file) {
            response.statusCode = 404;
            response.setHeader("Cache-Control", "no-store");
            response.end("fixture not found");
            return;
          }
          const data = await readFile(file);
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/markdown; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Length", data.byteLength);
          if (request.method === "HEAD") response.end();
          else response.end(data);
        })
        .catch(next);
    });
  },
};

/**
 * The perf bundle is measured as production React, never as a development
 * build. `mode` is forced to "perf" so the editor-ready mark is enabled while
 * Vite keeps NODE_ENV=production; the resolved-config guard rejects any
 * invocation that cannot satisfy both conditions.
 */
const productionPerfGuard: Plugin = {
  name: "opus:perf-production-guard",
  configResolved(config) {
    if (config.mode !== "perf") {
      throw new Error(
        `vite.perf.config.ts requires mode "perf" (resolved "${config.mode}")`,
      );
    }
    if (!config.isProduction) {
      throw new Error(
        "vite.perf.config.ts requires a production build (NODE_ENV=production)",
      );
    }
  },
};

export default defineConfig({
  root: ROOT,
  mode: "perf",
  plugins: [react(), productionPerfGuard, fixturePreviewMiddleware],
  build: {
    outDir: "dist-perf",
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(ROOT, "perf.html"),
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 1422,
    strictPort: true,
  },
});
