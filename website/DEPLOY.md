# Deploying the website to Vercel

The app is split so it runs on Vercel with no code changes at deploy time:

- **Static SPA** — `vite build` outputs `dist/`, served from Vercel's CDN.
- **Serverless functions** — everything in `api/`:
  - `api/state|free|market|deeds|plots.ts` — chain reads (`/api/*`)
  - `api/canvas.ts` — the 1 MB canvas, served at `/canvas.bin` (rewrite)
  - `api/og.ts` — the live collective canvas as a PNG social-preview image,
    served at `/og.png` (rewrite). Referenced by the Open Graph / Twitter
    meta tags injected into `index.html` (see below).
  - `api/tx/submit.ts` — posts a witnessed tx to Blockfrost (`/api/tx/submit`)
  - `api/bf/[...path].ts` — same-origin Blockfrost proxy, served at `/bf/*`
    (rewrite). Transactions are built **in the browser**, which queries the
    chain through this proxy.
  - `api/_core.ts`, `api/_http.ts` — shared logic (underscore = not a route).

`server.ts` is the equivalent **local dev** server (`npm start`, port 8787);
it imports the same `api/_core.ts`. Both stay in sync automatically.

## One-time Vercel setup

1. Import the git repo in Vercel.
2. **Root Directory** → `packages/plutus/the-cardano-masterpiece/website`
   (this is a monorepo; the website is a sub-folder).
3. Framework preset: **Other** (`vercel.json` already sets build + output).
4. Environment variables — all **optional**, all **server-side only** (never
   bundled into the SPA; the browser reaches the chain through the same-origin
   `/bf` proxy, so it needs no Blockfrost credentials):

That's it — `git push` deploys.

## Environment variables (server-side only)

Set these in Vercel → Project → Settings → Environment Variables. For **local
dev**, copy `.env.example` → **`.env.local`** (git-ignored) and fill it in —
`api/_env.ts` loads it into `process.env` for `npm run dev` and `npm start`
(a real shell env var always wins over the file). None are required — with none
set, the app uses the public preprod Blockfrost proxy and skips pinning.

| var | purpose |
|-----|---------|
| `BLOCKFROST_URL` | Blockfrost base URL for the server + `/bf` proxy. Default: the public preprod proxy. Set this to use your own endpoint. |
| `BLOCKFROST_PROJECT_ID` | A real [blockfrost.io](https://blockfrost.io) project id (key). When set, the server talks to `https://cardano-<network>.blockfrost.io/api/v0` and sends the `project` auth header on every request (overridable with `BLOCKFROST_URL`). |
| `FILEBASE_KEY` / `FILEBASE_SECRET` | Filebase S3 access keys — enable `/api/publish` IPFS pinning (see below). |
| `FILEBASE_BUCKET` | The Filebase **IPFS** bucket to store the committed image in. |

None of these appear in `config.json` or the client bundle — `config.json`
carries only public on-chain data (policies, addresses, ref scripts).

## Pinning committed images to IPFS (Filebase) — optional

`POST /api/publish` reconstructs the CURRENT committed image from the on-chain
leaves, builds a CAR with the exact block layout the contract commits to, and
pins it to [Filebase](https://filebase.com) — but **only if the reconstructed
dag-pb root CID matches the on-chain CIP-68 `image`** (`imageCar.ts`'s root-match
guard). So it can never pin content that doesn't reproduce the committed CID; if
leaves are edited but not yet committed, it refuses.

The CAR is imported under a single fixed object key (`committed-image.car`) via
the S3 `x-amz-meta-import: car` header, which **preserves the root CID** and
returns it in `x-amz-meta-cid` (double-checked against the committed CID). Each
publish overwrites that key, so the previous root is replaced and unpinned — one
pin, always current. Filebase's free tier (5 GB) easily covers the ~1 MB image.

The website calls it automatically after every commit confirms (the Claim and
Studio pages fire `notifyPublish()`, best-effort with retries). You can also
`POST /api/publish` manually or from the "catch-up" button at any time — it's
idempotent (the root-match guard only ever pins the current committed image).

**One-time setup** (no CLI needed):
1. Sign up at [filebase.com](https://filebase.com) (free plan).
2. Create a bucket with **storage network = IPFS**.
3. Access Keys → copy the **Key** and **Secret**.

Set three env vars on Vercel (Project → Settings → Environment Variables):
- `FILEBASE_KEY`    — S3 access key
- `FILEBASE_SECRET` — S3 secret key
- `FILEBASE_BUCKET` — the IPFS bucket name

Without them, `/api/publish` returns a clear error and nothing else is affected.

## Social-preview image (Open Graph / Twitter card)

Sharing the site link on X/Twitter, Discord, Facebook, etc. shows the **current
collective canvas** as the preview. `vite.config.ts` injects the `og:*` /
`twitter:*` meta tags into `index.html` at build time (crawlers don't run JS, so
they must be static), pointing at `/og.png` (→ `api/og.ts`), which renders the
live canvas as a letterboxed ~1.91:1 PNG.

The image URL must be **absolute**. It's resolved at build time from, in order:
1. `VITE_SITE_ORIGIN` (optional explicit override, e.g. a custom domain), else
2. `VERCEL_PROJECT_PRODUCTION_URL` (Vercel sets this automatically), else
3. a relative URL (local dev only).

So on Vercel it just works; set `VITE_SITE_ORIGIN=https://your-domain` only if
you serve the site from a custom domain you want in the tags. Note X/Twitter
**caches** the card by URL — a shared preview reflects a recent snapshot; use the
[Card Validator](https://cards-dev.twitter.com/validator) to force a refresh.

## Notes

- **Caching:** read endpoints send `Cache-Control: s-maxage`, so Vercel's CDN
  caches them (the serverless replacement for the local in-memory cache).
  `/canvas.bin`, `/api/state`, `/api/free` cache 15 s; `/api/market` 10 s;
  `/api/deeds` 30 s; `/api/plots` is per-address and uncached.
- **Function limits:** `/canvas.bin` reconstructs the image from 73 leaf
  UTxOs, so `api/canvas.ts` is given `maxDuration: 60` + `memory: 1024`
  in `vercel.json`. CDN caching means readers rarely trigger a cold rebuild.
- **Config:** `config.json` is bundled into both the SPA and the functions at
  build time. After a re-deploy of the contracts, update it and push.
- The `/api/tx/*` **builder** endpoints from the local server are intentionally
  NOT shipped as Vercel functions — the browser builds transactions itself
  (`app/lib/txbuild.ts`), so only `submit` and the `bf` proxy are needed. They
  remain in `server.ts` for the local `itest.ts`.
