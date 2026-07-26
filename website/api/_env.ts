// ===========================================================================
//  Load .env.local (then .env) into process.env for LOCAL dev, so you don't
//  have to export BLOCKFROST_* / FILEBASE_* on every `npm run dev` / `npm start`.
//
//  SERVER-ONLY (imported first by _core.ts) — the browser never sees this.
//  On Vercel the files are simply absent (env comes from project settings), so
//  this is a no-op there. A variable already present in the real environment is
//  NEVER overwritten, so the shell / Vercel always wins.
// ===========================================================================
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnvFile(file: string): void {
    if (!existsSync(file)) return;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
            val = val.slice(1, -1);
        if (key && process.env[key] === undefined) process.env[key] = val;
    }
}

// `npm run dev` / `npm start` run with cwd = the website package dir
try {
    loadEnvFile(join(process.cwd(), ".env.local"));
    loadEnvFile(join(process.cwd(), ".env"));
} catch { /* fs unavailable / read error — ignore, use the real env */ }
