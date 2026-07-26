import type { WalletApi } from "@harmoniclabs/use-cardano-wallet";
import { submitTx } from "./api.js";

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

/** true if the wallet can sign a whole chain in one prompt (CIP-103 signTxs) —
 *  used to decide whether to append the extra (chained) merge txs */
export const hasBulkSigner = (api: WalletApi): boolean => bulkSigner(api) !== undefined;

// Some wallets (notably recent Eternl) only attach `signTxs` when the CIP-103
// extension is requested at enable() time. The wallet hook calls a bare
// `enable()`, so the cached `api` may lack it even though the wallet supports
// bulk signing. If the current api has no bulk signer, try re-enabling the named
// wallet WITH the extension and use that handle's signTxs. Re-enable on an
// already-connected wallet resolves without a fresh prompt; on any failure we
// fall back to the one-prompt-per-tx path (unchanged behaviour).
async function resolveBulkSigner(api: WalletApi, walletName?: string): Promise<SignTxsFn | undefined> {
    const direct = bulkSigner(api);
    if (direct) return direct;
    if (!walletName || typeof window === "undefined") return undefined;
    const provider = (window as unknown as {
        cardano?: Record<string, { enable?: (opts?: unknown) => Promise<WalletApi> }>;
    }).cardano?.[walletName];
    if (typeof provider?.enable !== "function") return undefined;
    try {
        const fresh = await provider.enable({ extensions: [{ cip: 103 }] });
        return bulkSigner(fresh);
    } catch {
        return undefined;   // extension unsupported / user declined — one-by-one it is
    }
}

/** poll the same-origin /bf proxy until the tx lands in a block (or time out) */
async function waitConfirmed(hash: string, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        try { if ((await fetch(`/bf/txs/${hash}`)).ok) return; } catch { /* transient — retry */ }
    }
    throw new Error(`timed out waiting for transaction ${hash.slice(0, 12)}… to confirm`);
}

// A wallet that can't yet see the previous (parent) tx's mempool output rejects
// signing its child with this message — it doesn't recognize the chained input
// as its own. It's a propagation race, not a real failure: retry once the parent
// is settled on-chain.
const isMissingInputKeyError = (e: unknown): boolean =>
    /secret key associated with any of the inputs/i.test(
        String((e as { info?: string; message?: string })?.info ?? (e as Error)?.message ?? e),
    );

// ---- progress reporting (drives the signing modal) -------------------------
export type SignPhase = "signing" | "submitting" | "confirming" | "done";
export interface SignProgress {
    total: number;      // number of transactions in the batch
    current: number;    // 1-based index being processed (0 = bulk sign, whole batch)
    phase: SignPhase;
    bulk: boolean;      // true = one wallet prompt (CIP-103), false = one prompt per tx
    hashes: string[];   // submitted so far, in order
}

/**
 * Sign + submit a BATCH of txs (chained — each tx spends the previous one's
 * outputs), reporting progress through `onProgress`.
 *
 *  • Wallet with CIP-103 `signTxs`  → ONE prompt for the whole chain, then
 *    submit in order (fast).
 *  • Wallet without it              → ONE prompt per tx, signed+submitted
 *    back-to-back in order WITHOUT waiting for confirmation: each tx spends the
 *    previous tx's mempool change, so the wallet signs the next against the
 *    pending output. Works with any CIP-30 wallet; the modal shows per-tx progress.
 */
export async function signAndSubmitAll(
    api: WalletApi,
    txs: string[],
    onProgress?: (p: SignProgress) => void,
    walletName?: string,
): Promise<string[]> {
    const total = txs.length;
    const hashes: string[] = [];
    const report = (current: number, phase: SignPhase, bulk: boolean) =>
        onProgress?.({ total, current, phase, bulk, hashes: [...hashes] });

    // single tx: a plain signTx (no chaining concerns)
    if (total === 1) {
        report(1, "signing", false);
        const w = await api.signTx(txs[0], true);
        report(1, "submitting", false);
        const { hash } = await submitTx(txs[0], w);
        hashes.push(hash);
        report(1, "done", false);
        return hashes;
    }

    const bulk = await resolveBulkSigner(api, walletName);
    if (bulk) {
        report(0, "signing", true);   // whole chain, one prompt
        const witnesses = await bulk(txs.map((cbor) => ({ cbor, partialSign: true })));
        if (!Array.isArray(witnesses) || witnesses.length !== total)
            throw new Error("wallet returned an unexpected signTxs result");
        for (let i = 0; i < total; i++) {
            report(i + 1, "submitting", true);
            const { hash } = await submitTx(txs[i], witnesses[i]);
            hashes.push(hash);
        }
        report(total, "done", true);
        return hashes;
    }

    // fallback: one prompt per tx, WITHOUT waiting for on-chain confirmation.
    // The txs are chained (each spends the previous tx's predicted change), so we
    // sign+submit back-to-back IN ORDER: tx[i+1] references tx[i]'s mempool output
    // and the wallet signs it against that pending change — no need to wait ~30s
    // per tx for a block. (NOT chaining would make tx[i+1] reference a wallet utxo
    // already spent by tx[i] in the mempool, and the wallet then reports "does not
    // have the secret key associated with any of the inputs and certificates".)
    for (let i = 0; i < total; i++) {
        report(i + 1, "signing", false);
        let witnesses: string;
        try {
            witnesses = await api.signTx(txs[i], true);
        } catch (e) {
            // wallet couldn't resolve the parent's not-yet-visible mempool change:
            // wait for the parent to settle on-chain, give it a few seconds to
            // reach the wallet, then retry the signature once.
            const parent = hashes[i - 1];
            if (!isMissingInputKeyError(e) || !parent) throw e;
            report(i + 1, "confirming", false);
            await waitConfirmed(parent);
            await new Promise((r) => setTimeout(r, 5000));
            report(i + 1, "signing", false);
            witnesses = await api.signTx(txs[i], true);
        }
        report(i + 1, "submitting", false);
        const { hash } = await submitTx(txs[i], witnesses);
        hashes.push(hash);
    }
    report(total, "done", false);
    return hashes;
}
