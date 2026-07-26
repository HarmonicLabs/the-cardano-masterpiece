// ===========================================================================
//  Edit prebuilder — builds the chained edit txs in a WebWorker AHEAD of the
//  submit click, and follows the edits as they change (rebuilds the chain when
//  the pixels change). By the time the user clicks "submit", the txs for the
//  current edit-set are usually already built and ready to sign.
//
//  `buildEditBatchTxsFromCbor` (the worker's job) is identical to what the main
//  thread would run, so the main thread is the fallback if a worker is
//  unavailable or errors.
// ===========================================================================
import type { WalletApi } from "@harmoniclabs/use-cardano-wallet";
import type { PixelEdit } from "./api.ts";
import { buildEditBatchTxs } from "./txbuild.ts";

export type EditGroup = { leafIdx: number; pixels: PixelEdit[] };

/** canonical, order-independent key for an edit-set — same pixels ⇒ same key */
export function groupsKey(groups: EditGroup[]): string {
    return groups
        .map((g) => `${g.leafIdx}:${g.pixels.map((p) => `${p.x},${p.y},${p.v}`).sort().join("|")}`)
        .sort()
        .join(";");
}

interface Pending { resolve(txs: string[]): void; reject(e: Error): void; }

/**
 * One worker per editing session. `request(key, ...)` returns the (possibly
 * cached / in-flight) build for an edit-set; `prefetch` warms it in the
 * background. Falls back to the main thread if the worker can't be created.
 */
export class EditPrebuilder {
    private worker: Worker | null = null;
    private seq = 0;
    private readonly pending = new Map<number, Pending>();
    private cache: { key: string; promise: Promise<string[]> } | null = null;
    private lastReadyKey: string | null = null;
    private onReady?: (key: string) => void;

    constructor(onReady?: (key: string) => void) {
        this.onReady = onReady;
        try {
            this.worker = new Worker(new URL("./editWorker.ts", import.meta.url), { type: "module" });
            this.worker.onmessage = (e: MessageEvent<{ nonce: number; txs?: string[]; error?: string }>) => {
                const { nonce, txs, error } = e.data;
                const p = this.pending.get(nonce);
                if (!p) return;
                this.pending.delete(nonce);
                if (error || !txs) p.reject(new Error(error ?? "empty build result"));
                else p.resolve(txs);
            };
            this.worker.onerror = () => { this.worker = null; };   // fall back to main thread
        } catch {
            this.worker = null;
        }
    }

    private build(api: WalletApi, address: string, groups: EditGroup[]): Promise<string[]> {
        if (!this.worker) return buildEditBatchTxs(api, address, groups);   // main-thread fallback
        return api.getUtxos().then((utxosCbor) => new Promise<string[]>((resolve, reject) => {
            const nonce = ++this.seq;
            this.pending.set(nonce, { resolve, reject });
            this.worker!.postMessage({ nonce, utxosCbor: utxosCbor ?? [], address, groups });
        }));
    }

    /** kick off a background build for this edit-set (no-op if already current) */
    prefetch(api: WalletApi, address: string, groups: EditGroup[]): void {
        if (groups.length === 0) return;
        const key = groupsKey(groups);
        if (this.cache?.key === key) return;
        const promise = this.build(api, address, groups);
        this.cache = { key, promise };
        promise.then(() => { this.lastReadyKey = key; this.onReady?.(key); }).catch(() => { /* surfaced on submit */ });
    }

    /** the txs for this exact edit-set: the prebuilt ones if ready, else build now */
    request(api: WalletApi, address: string, groups: EditGroup[]): Promise<string[]> {
        const key = groupsKey(groups);
        if (this.cache?.key === key) {
            return this.cache.promise.catch(() => {
                const retry = this.build(api, address, groups);   // stale failure → rebuild
                this.cache = { key, promise: retry };
                return retry;
            });
        }
        const promise = this.build(api, address, groups);
        this.cache = { key, promise };
        return promise;
    }

    /** true if the prebuilt chain for exactly this edit-set is ready to sign */
    isReady(groups: EditGroup[]): boolean {
        return groups.length > 0 && this.lastReadyKey === groupsKey(groups);
    }

    dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.pending.clear();
    }
}
