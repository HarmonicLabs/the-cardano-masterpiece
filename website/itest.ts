// ===========================================================================
//  Integration test for the website tx-builder API against PREPROD.
//  Simulates the browser wallet flow with the deployer key:
//    build tx via API -> sign locally (stand-in for CIP-30 signTx)
//    -> submit via API -> verify on-chain effects through the API.
//
//  Costs real preprod tADA (claim pays 5₳/pixel to the protocol owner, which
//  is the same wallet here, so only fees are burned).
// ===========================================================================
import { Tx, PrivateKey, Address, Credential } from "@harmoniclabs/buildooor";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = "http://localhost:8787";

// ---- stand-in wallet (offchain/keys) --------------------------------------
const skeyEnv = JSON.parse(readFileSync(join(__dirname, "..", "offchain", "keys", "preprod.skey"), "utf8"));
const prv = new PrivateKey(new Uint8Array(Buffer.from((skeyEnv.cborHex as string).slice(4), "hex")));
const address = Address.testnet(Credential.keyHash(prv.derivePublicKey().hash)).toString();
console.log("wallet:", address);

async function api<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(API + path, body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const j = await res.json() as T & { error?: string };
    if (!res.ok) throw new Error(`${path}: ${j.error ?? res.status}`);
    return j;
}

// what a CIP-30 wallet does inside signTx: produce the witness set
function walletSign(txHex: string): string {
    const tx = Tx.fromCbor(txHex);
    tx.signWith(prv);
    return Buffer.from(tx.witnesses.toCborBytes()).toString("hex");
}

async function submitAndAwait(txHex: string, what: string): Promise<string> {
    const { hash } = await api<{ hash: string }>("/api/tx/submit", {
        tx: txHex, witnesses: walletSign(txHex),
    });
    console.log(`  ${what} submitted: ${hash}`);
    // wait until the API sees the effect (poll plots/free/canvas via caller)
    return hash;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc: string, cond: () => Promise<boolean>, tries = 60): Promise<void> {
    for (let i = 0; i < tries; i++) {
        if (await cond()) { console.log(`  ${desc} ✓`); return; }
        await sleep(10_000);
    }
    throw new Error(`timeout waiting: ${desc}`);
}

interface Rect { x0: number; y0: number; x1: number; y1: number; }
interface Plot { rect: Rect; name: string; utxoRef: string; }

// ---------------------------------------------------------------------------
console.log("\n== claim via API ==");
const rect: Rect = { x0: 4, y0: 0, x1: 6, y1: 2 }; // 2x2 in the top free strip
const expectedName = `masterpiece-${rect.x0}-${rect.y0}-${rect.x1}-${rect.y1}`;

const already = (await api<Plot[]>(`/api/plots?address=${address}`)).some((p) => p.name === expectedName);
if (already) {
    console.log(`  deed ${expectedName} already owned — skipping claim`);
} else {
    const { txs: claimTxs } = await api<{ txs: string[] }>("/api/tx/claim", { address, rect });
    console.log(`  built ${claimTxs.length} claim tx(s)`);
    // chained batch: submit strictly in order
    for (const [i, t] of claimTxs.entries()) await submitAndAwait(t, `claim ${i + 1}/${claimTxs.length}`);
    await waitFor(`deed ${expectedName} in wallet`, async () => {
        const plots = await api<Plot[]>(`/api/plots?address=${address}`);
        return plots.some((p) => p.name === expectedName);
    });
}

// ---------------------------------------------------------------------------
console.log("\n== multi-area claim via API ==");
// spans two free nodes (the gap between the first two plots + the area below
// them) -> the API must return one chained tx per node, two deeds total
const rect2: Rect = { x0: 2, y0: 0, x1: 4, y1: 4 };
const names2 = ["masterpiece-2-0-4-2", "masterpiece-2-2-4-4"];

const owned2 = await api<Plot[]>(`/api/plots?address=${address}`);
if (names2.every((n) => owned2.some((p) => p.name === n))) {
    console.log(`  deeds ${names2.join(", ")} already owned — skipping claim`);
} else {
    const { txs } = await api<{ txs: string[] }>("/api/tx/claim", { address, rect: rect2 });
    assert.equal(txs.length, 2, "selection spanning 2 free nodes builds 2 txs");
    console.log(`  built ${txs.length} chained claim txs (${txs.map((t) => t.length / 2).join(", ")} bytes)`);
    for (const [i, t] of txs.entries()) await submitAndAwait(t, `claim ${i + 1}/${txs.length}`);
    await waitFor(`deeds ${names2.join(" + ")} in wallet`, async () => {
        const plots = await api<Plot[]>(`/api/plots?address=${address}`);
        return names2.every((n) => plots.some((p) => p.name === n));
    });
}

// ---------------------------------------------------------------------------
console.log("\n== edit via API ==");
// paint the new plot mid-gray (leaf 0: rows 0..2)
const pixels: { x: number; y: number; v: number }[] = [];
for (let y = rect.y0; y < rect.y1; y++)
    for (let x = rect.x0; x < rect.x1; x++)
        pixels.push({ x, y, v: 128 });

const { tx: editTx } = await api<{ tx: string }>("/api/tx/edit", { address, leafIdx: 0, pixels });
console.log(`  built edit tx (${editTx.length / 2} bytes)`);
await submitAndAwait(editTx, "edit");
await waitFor("canvas shows the painted pixels", async () => {
    const bin = new Uint8Array(await (await fetch(API + "/canvas.bin")).arrayBuffer());
    return pixels.every((p) => bin[p.y * 1024 + p.x] === 128);
});

// ---------------------------------------------------------------------------
const bin = new Uint8Array(await (await fetch(API + "/canvas.bin")).arrayBuffer());
let black = 0, gray = 0;
for (const v of bin) { if (v === 0) black++; else if (v === 128) gray++; }
assert.equal(black, 4, "original 2x2 black square intact");
assert.equal(gray, 4, "new 2x2 gray square painted");
console.log("\nWEBSITE API INTEGRATION PASSED ✓ (4 black + 4 gray pixels on-chain)");
