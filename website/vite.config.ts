import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// absolute paths (root is "app", but the API lives one level up in "api/")
const websiteDir = fileURLToPath(new URL(".", import.meta.url));
const handlerPath = fileURLToPath(new URL("./api/devHandler.ts", import.meta.url));

// Absolute site origin for social-preview (Open Graph / Twitter) tags. On
// Vercel, VERCEL_PROJECT_PRODUCTION_URL is the stable production domain at
// build time; VITE_SITE_ORIGIN overrides it. Empty locally -> relative URL.
const SITE_ORIGIN =
    process.env.VITE_SITE_ORIGIN?.replace(/\/+$/, "")
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
const OG_IMAGE = `${SITE_ORIGIN}/og.png`;   // live collective canvas (api/og.ts)
const OG_TITLE = "The Cardano Masterpiece";
const OG_DESC = "A collaborative on-chain pixel canvas on Cardano — claim your plot and paint the masterpiece together.";

// Inject social-preview meta into index.html at build/serve time. Crawlers
// (X/Twitter, etc.) don't run JS, so these must be in the static HTML.
function ogMeta() {
    return {
        name: "og-meta",
        transformIndexHtml() {
            const m = (attrs: Record<string, string>) =>
                ({ tag: "meta", attrs, injectTo: "head" as const });
            return [
                m({ property: "og:type", content: "website" }),
                m({ property: "og:title", content: OG_TITLE }),
                m({ property: "og:description", content: OG_DESC }),
                ...(SITE_ORIGIN ? [m({ property: "og:url", content: SITE_ORIGIN })] : []),
                m({ property: "og:image", content: OG_IMAGE }),
                m({ property: "og:image:type", content: "image/png" }),
                m({ property: "og:image:width", content: "1926" }),
                m({ property: "og:image:height", content: "1008" }),
                m({ property: "og:image:alt", content: "The current state of the collective Cardano Masterpiece canvas" }),
                m({ name: "twitter:card", content: "summary_large_image" }),
                m({ name: "twitter:title", content: OG_TITLE }),
                m({ name: "twitter:description", content: OG_DESC }),
                m({ name: "twitter:image", content: OG_IMAGE }),
            ];
        },
    };
}

// Serve /canvas.bin, /api/*, /bf/* from the SAME vite process, so `npm run dev`
// on :5173 runs the whole app — no separate API server to start (or leave
// running stale). Loaded via vite's SSR pipeline so buildooor + config.json
// resolve at runtime and the LATEST config.json is always used.
function masterpieceApi() {
    return {
        name: "masterpiece-api",
        async configureServer(server: ViteDevServer) {
            const { apiHandler } = await server.ssrLoadModule(handlerPath) as {
                apiHandler: (req: unknown, res: unknown) => Promise<boolean>;
            };
            server.middlewares.use((req, res, next) => {
                apiHandler(req, res).then((handled) => { if (!handled) next(); }).catch(next);
            });
        },
    };
}

export default defineConfig({
    root: "app",
    plugins: [react(), ogMeta(), masterpieceApi()],
    build: { outDir: "../dist", emptyOutDir: true },
    server: {
        port: 5173,
        // allow SSR-loading api/ + _core, which live above the "app" root
        fs: { allow: [websiteDir] },
    },
});
