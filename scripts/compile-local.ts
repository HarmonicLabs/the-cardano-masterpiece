// Compile the contracts with the LOCAL pebble compiler build
// (../pebble/packages/pebble/dist) instead of the published pebble-cli.
//
// Usage:
//   npm run compile:local                      # compiles both entries
//   npm run compile:local -- src/stewardship.pebble
//
// The local compiler must be built first:
//   cd ../pebble/packages/pebble && npm run build
//
// Override the dist location with PEBBLE_LOCAL_DIST if your layout differs.

import path from "node:path";
import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const distPath = process.env.PEBBLE_LOCAL_DIST
    ?? path.resolve(repoRoot, "../pebble/packages/pebble/dist/index.js");

if (!existsSync(distPath)) {
    console.error(
        `local pebble build not found at ${distPath}\n` +
        `build it first: cd ../pebble/packages/pebble && npm run build`
    );
    process.exit(1);
}

const { Compiler, defaultOptions, COMPILER_VERSION } = await import(pathToFileURL(distPath).href);

console.log(`using local pebble compiler ${COMPILER_VERSION} from ${path.dirname(distPath)}`);

function resolvePath(filename: string, baseDir: string): string {
    if (!filename) return baseDir;
    if (path.isAbsolute(filename)) return filename;
    return path.resolve(baseDir, filename.replace(/^\/+/, ""));
}

interface Diagnostic { toString(): string; }

// fs-backed CompilerIoApi (mirrors pebble-cli's createFsIo)
function createFsIo(root: string) {
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        async readFile(filename: string, baseDir?: string): Promise<string | undefined> {
            const full = resolvePath(filename, typeof baseDir === "string" ? baseDir : root);
            try { return (await fsp.readFile(full)).toString("utf8"); }
            catch { return undefined; }
        },
        async writeFile(filename: string, contents: string | Uint8Array, baseDir?: string): Promise<void> {
            const full = resolvePath(filename, baseDir ?? root);
            await fsp.mkdir(path.dirname(full), { recursive: true });
            if (typeof contents === "string") await fsp.writeFile(full, contents, "utf8");
            else await fsp.writeFile(full, Buffer.from(contents));
        },
        exsistSync(filename: string): boolean {
            return existsSync(resolvePath(filename, root));
        },
        async listFiles(dirname: string, baseDir?: string): Promise<string[] | undefined> {
            const full = resolvePath(dirname, baseDir ?? root);
            try {
                const entries = await fsp.readdir(full, { withFileTypes: true });
                return entries.map((e) => e.name);
            } catch { return undefined; }
        },
        reportDiagnostic(d: Diagnostic): void {
            process.stderr.write(String(d) + "\n");
        },
    };
}

const projectConfig: { outDir?: string; removeTraces?: boolean } = JSON.parse(
    await fsp.readFile(path.resolve(repoRoot, "pebble.config.json"), "utf8")
);

const entries = process.argv.slice(2);
if (entries.length === 0) entries.push("./src/masterpiece.pebble", "./src/stewardship.pebble", "./src/marketplace.pebble", "./src/lock.pebble");

let failed = false;
for (const entry of entries) {
    const name = path.basename(entry, ".pebble");
    const outDir = path.join(projectConfig.outDir ?? "./out", name);
    console.log(`\ncompiling ${entry} -> ${outDir}/`);

    const diagnostics: Diagnostic[] = [];
    const compiler = new Compiler(
        createFsIo(repoRoot),
        {
            ...defaultOptions,
            removeTraces: projectConfig.removeTraces ?? defaultOptions.removeTraces,
            // the local build IS the compiler; ignore the version pin meant for the published cli
            compilerVersion: COMPILER_VERSION,
        },
        diagnostics
    );

    try {
        await compiler.compile({ root: repoRoot, entry, outDir });
        console.log(`ok: ${name}`);
    } catch (e) {
        failed = true;
        console.error(`FAILED: ${name}: ${(e as Error)?.message ?? e}`);
        for (const d of diagnostics) console.error("  " + String(d));
    }
}

// NOT process.exit(): the compiler does not await its output writeFile,
// so a hard exit here can drop the last out.flat write.
process.exitCode = failed ? 1 : 0;
