// ===========================================================================
//  Edit prebuilder WORKER. Builds the chained edit txs off the main thread so
//  the UI stays responsive while ~1 tx per leaf (each running the validator
//  locally over a 14 KB chunk) is assembled. Driven by editWorkerClient.ts.
// ===========================================================================
/// <reference lib="webworker" />
import { buildEditBatchTxsFromCbor } from "./editBuild.ts";
import type { PixelEdit } from "./api.ts";

interface Req {
    nonce: number;
    utxosCbor: string[];
    address: string;
    groups: { leafIdx: number; pixels: PixelEdit[] }[];
}

self.onmessage = async (e: MessageEvent<Req>) => {
    const { nonce, utxosCbor, address, groups } = e.data;
    try {
        const txs = await buildEditBatchTxsFromCbor(utxosCbor, address, groups);
        (self as unknown as Worker).postMessage({ nonce, txs });
    } catch (err) {
        (self as unknown as Worker).postMessage({ nonce, error: String((err as Error)?.message ?? err) });
    }
};
