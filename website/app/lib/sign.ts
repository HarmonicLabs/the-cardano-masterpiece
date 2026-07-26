import type { WalletApi } from "@harmoniclabs/use-cardano-wallet";
import { submitTx } from "./api.ts";

/** sign an unsigned tx (cbor hex) with the CIP-30 wallet and submit via the API */
export async function signAndSubmit(api: WalletApi, txHex: string): Promise<string> {
    // partialSign: the tx also carries script witnesses assembled server-side
    const witnesses = await api.signTx(txHex, true);
    const { hash } = await submitTx(txHex, witnesses);
    return hash;
}

// CIP-103 bulk transaction signing. Feature-detect it at runtime across the
// places wallets put it: Eternl exposes it under `experimental.signTxs`, some
// under a `cip103` namespace, some directly on the api. Request shape is the
// CIP-103 `{ cbor, partialSign }[]`; it returns one witness set per tx.
type SignTxsFn = (reqs: { cbor: string; partialSign?: boolean }[]) => Promise<string[]>;
function bulkSigner(api: WalletApi): SignTxsFn | undefined {
    const a = api as unknown as {
        experimental?: { signTxs?: SignTxsFn };
        cip103?: { signTxs?: SignTxsFn };
        signTxs?: SignTxsFn;
    };
    if (typeof a.experimental?.signTxs === "function") return a.experimental.signTxs.bind(a.experimental);
    if (typeof a.cip103?.signTxs === "function") return a.cip103.signTxs.bind(a.cip103);
    if (typeof a.signTxs === "function") return a.signTxs.bind(a);
    return undefined;
}

/**
 * Sign and submit a BATCH of txs (parallel or chained — chained batches rely
 * on the in-order submission below). One wallet prompt via CIP-103 `signTxs`
 * when the wallet supports it, otherwise one `signTx` prompt per tx.
 * Reports progress through `onProgress`; returns the tx hashes in order.
 */
export async function signAndSubmitAll(
    api: WalletApi,
    txs: string[],
    onProgress?: (msg: string) => void,
): Promise<string[]> {
    if (txs.length === 1) {
        onProgress?.("waiting for wallet signature…");
        return [await signAndSubmit(api, txs[0])];
    }
    // These batches are CHAINED — each tx spends the previous one's (not-yet-
    // on-chain) outputs. A per-tx `signTx` can't resolve those inputs, so bulk
    // signing (CIP-103 signTxs) is REQUIRED: the wallet signs the whole chain in
    // one pass with the batch's outputs in scope.
    const bulk = bulkSigner(api);
    if (!bulk) throw new Error(
        `This action needs ${txs.length} chained transactions signed together, but this wallet does ` +
        `not expose CIP-103 bulk signing (signTxs). Use a wallet that supports it (e.g. Eternl).`);

    onProgress?.(`waiting for wallet signature… (${txs.length} transactions, single prompt)`);
    const witnesses = await bulk(txs.map((cbor) => ({ cbor, partialSign: true })));
    if (!Array.isArray(witnesses) || witnesses.length !== txs.length)
        throw new Error("wallet returned an unexpected signTxs result");
    const hashes: string[] = [];
    for (let i = 0; i < txs.length; i++) {
        onProgress?.(`submitting transaction ${i + 1}/${txs.length}…`);
        const { hash } = await submitTx(txs[i], witnesses[i]);
        hashes.push(hash);
    }
    return hashes;
}
