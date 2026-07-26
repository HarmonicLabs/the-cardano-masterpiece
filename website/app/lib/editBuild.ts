// ===========================================================================
//  Edit-tx building CORE — deliberately free of any DOM / CIP-30 dependency so
//  it runs BOTH on the main thread and inside the edit prebuilder WebWorker.
//  It takes the wallet's utxos as data (never the wallet `api`), and everything
//  else (leaves, ref scripts, protocol params) it fetches through the same
//  same-origin /bf proxy the worker can reach.
// ===========================================================================
import { Address, Value, UTxO, TxOutRef, type Tx } from "@harmoniclabs/buildooor";
import type { PixelEdit, Rect } from "./api.js";
import {
    config, CANVAS, ROWS_PER_LEAF, N_LEAFS,
    txBuilder, refScripts, leafAt, pickFunding,
    tokens, lovelacesOf, bytesToHex, leafDatum, cidV1Raw, mpEdit,
} from "./chain.js";
import { rootDatum, mpCommit, sortedRefIndex, fetchRoot } from "./masterpieceRoot.js";

export const EMPTY_NAME = new Uint8Array(0);
export const NAME_RE = /^masterpiece-(\d+)-(\d+)-(\d+)-(\d+)$/;
export const toHex = (tx: Tx): string => bytesToHex(tx.toCborBytes());

export interface Plot { rect: Rect; name: string; utxo: UTxO; }

// change-output chaining: the LAST output of a built tx is the change at the
// user's address; the next tx in a batch spends it
export function chainChange(tx: Tx, userAddr: Address): UTxO {
    const changeIdx = tx.body.outputs.length - 1;
    const change = tx.body.outputs[changeIdx];
    if (change.address.toString() !== userAddr.toString())
        throw new Error("unexpected tx shape: change output not at user address");
    return new UTxO({
        utxoRef: new TxOutRef({ id: tx.hash.toString(), index: changeIdx }),
        resolved: change,
    });
}

/** the deeds (stewardship plots) among a known set of wallet utxos */
export function walletPlotsFrom(utxos: UTxO[]): Plot[] {
    const plots: Plot[] = [];
    for (const u of utxos) {
        const j = u.resolved.value.toJson() as Record<string, Record<string, unknown>>;
        const assets = j[config.stewardshipPolicy];
        if (!assets) continue;
        for (const nameHex of Object.keys(assets)) {
            const name = new TextDecoder().decode(
                Uint8Array.from(nameHex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []));
            const m = NAME_RE.exec(name);
            if (m) plots.push({ rect: { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] }, name, utxo: u });
        }
    }
    return plots;
}

export async function buildOneEdit(
    userAddr: Address, plots: Plot[], leafIdx: number, edits: PixelEdit[], f: UTxO[],
): Promise<{ tx: Tx; newCid: Uint8Array } | null> {
    if (!Number.isInteger(leafIdx) || leafIdx < 0 || leafIdx >= N_LEAFS) throw new Error("bad leafIdx");
    if (edits.length === 0) throw new Error("no pixel edits");
    const leaf = await leafAt(leafIdx);

    const y0 = leafIdx * ROWS_PER_LEAF, y1 = y0 + ROWS_PER_LEAF;
    const newChunk = new Uint8Array(leaf.chunk);
    const touched = new Set<string>();
    let changed = false;
    for (const e of edits) {
        if (!Number.isInteger(e.x) || !Number.isInteger(e.y) || !Number.isInteger(e.v)
            || e.x < 0 || e.x >= CANVAS || e.y < y0 || e.y >= y1 || e.v < 0 || e.v > 255)
            throw new Error(`pixel out of range: ${JSON.stringify(e)}`);
        const plot = plots.find((p) =>
            p.rect.x0 <= e.x && e.x < p.rect.x1 && p.rect.y0 <= e.y && e.y < p.rect.y1);
        if (!plot) throw new Error(`pixel (${e.x},${e.y}) is not inside any of your plots`);
        touched.add(plot.name);
        const idx = (e.y - y0) * CANVAS + e.x;
        if (newChunk[idx] !== e.v) { newChunk[idx] = e.v; changed = true; }
    }
    // no NET change (e.g. resuming a batch where this leaf was already painted):
    // skip — an edit tx that re-locks the identical chunk just wastes fees
    if (!changed) return null;

    const stewardRects = plots
        .filter((p) => touched.has(p.name))
        .map((p) => p.rect)
        .sort((a, b) => a.x0 - b.x0);
    const deedUtxos = [...new Map(
        plots.filter((p) => touched.has(p.name)).map((p) => [p.utxo.utxoRef.toString(), p.utxo]),
    ).values()];

    const { refM } = await refScripts();
    const newCid = cidV1Raw(newChunk);
    const tx = await (await txBuilder()).build({
        inputs: [
            { utxo: leaf.utxo, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpEdit(stewardRects) } },
            ...f,
        ],
        readonlyRefInputs: deedUtxos,
        requiredSigners: [userAddr.paymentCreds.hash],
        outputs: [{
            address: Address.fromString(config.masterpieceAddress),
            value: Value.add(
                Value.lovelaces(lovelacesOf(leaf.utxo)),
                tokens(config.masterpiecePolicy, [[EMPTY_NAME, 1n]]),
            ),
            datum: leafDatum(leafIdx, newChunk, newCid),
        }],
        changeAddress: userAddr,
    });
    return { tx, newCid };
}

interface EditedLeaf { leafIdx: number; newCid: Uint8Array; leafUtxo: UTxO; }

// the leaf UTxO an edit tx just produced (always its first output)
function leafOutputOf(tx: Tx): UTxO {
    return new UTxO({ utxoRef: new TxOutRef({ id: tx.hash.toString(), index: 0 }), resolved: tx.body.outputs[0] });
}

/**
 * Append ONE `RootNft.commit` tx that syncs EVERY edited leaf into the root in a
 * single tx (multi-leaf commit): it spends the root, references all the freshly
 * edited (mempool) leaf UTxOs, and rewrites the root's leaf-CID list + whole-image
 * CID / image URI. Permissionless — no extra signature. Returns the tx + threaded
 * funding. (The whole 84-leaf image fits in one commit — see offchain/commit-batch.ts.)
 */
async function buildCommitTxs(edited: EditedLeaf[], f: UTxO[], userAddr: Address): Promise<{ txs: Tx[]; f: UTxO[] }> {
    if (edited.length === 0) return { txs: [], f };
    const { refM } = await refScripts();
    const { utxo: root0, leafCids } = await fetchRoot();
    const cids = [...leafCids];
    // committed leaves in ASCENDING leaf-idx order (the contract walks positions
    // 0..N and consumes the ref list in that order)
    const committed = [...edited].sort((a, b) => a.leafIdx - b.leafIdx);
    for (const e of committed) cids[e.leafIdx] = e.newCid;
    const rd = rootDatum(cids);
    const allRefs = [refM.utxoRef, ...committed.map((e) => e.leafUtxo.utxoRef)];
    const refIdxs = committed.map((e) => sortedRefIndex(allRefs, e.leafUtxo.utxoRef));
    const tx = await (await txBuilder()).build({
        inputs: [
            { utxo: root0, referenceScript: { refUtxo: refM, datum: "inline", redeemer: mpCommit(refIdxs) } },
            ...f,
        ],
        readonlyRefInputs: committed.map((e) => e.leafUtxo),
        outputs: [{ address: Address.fromString(config.masterpieceAddress), value: root0.resolved.value, datum: rd.data }],
        changeAddress: userAddr,
    });
    return { txs: [tx], f: [chainChange(tx, userAddr)] };
}

/** one chained tx per touched leaf, built from a known wallet-utxo set */
export async function buildEditBatchCore(
    utxos: UTxO[], address: string, groups: { leafIdx: number; pixels: PixelEdit[] }[],
): Promise<Tx[]> {
    if (groups.length === 0) throw new Error("no edits");
    const userAddr = Address.fromString(address);
    const plots = walletPlotsFrom(utxos);
    if (plots.length === 0) throw new Error("this wallet owns no plots");
    const deedRefs = plots.map((p) => p.utxo.utxoRef.toString());
    // fees for N edits + ONE multi-leaf commit (each re-locks its own ada; only
    // fees are net cost). Over-provisioned: N×1.5₳ covers N+1 tx fees.
    let f = pickFunding(utxos, deedRefs, BigInt(groups.length + 1) * 1_500_000n);
    const txs: Tx[] = [];
    const edited: EditedLeaf[] = [];
    for (const g of groups) {
        const res = await buildOneEdit(userAddr, plots, g.leafIdx, g.pixels, f);
        if (!res) continue;   // this leaf's pixels already match the canvas — no tx
        txs.push(res.tx);
        edited.push({ leafIdx: g.leafIdx, newCid: res.newCid, leafUtxo: leafOutputOf(res.tx) });
        f = [chainChange(res.tx, userAddr)];   // thread change into the next edit, then the commit
    }
    if (edited.length === 0) throw new Error("nothing to change — those pixels already match the canvas");
    // sync every edited leaf into the root's CIP-68 whole-image CID (one commit)
    const { txs: commitTxs } = await buildCommitTxs(edited, f, userAddr);
    return [...txs, ...commitTxs];
}

// exported for the claim→paint chain (txbuild.ts), which builds edits inline
export { buildCommitTxs, leafOutputOf, type EditedLeaf };

/** worker-facing entry: raw CIP-30 utxo cbor in, tx cbor hex out */
export async function buildEditBatchTxsFromCbor(
    utxosCbor: string[], address: string, groups: { leafIdx: number; pixels: PixelEdit[] }[],
): Promise<string[]> {
    const utxos = utxosCbor.map((cbor) => UTxO.fromCbor(cbor));
    return (await buildEditBatchCore(utxos, address, groups)).map(toHex);
}
