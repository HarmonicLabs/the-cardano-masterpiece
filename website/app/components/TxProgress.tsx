import type { SignProgress } from "../lib/sign.js";

const PHASE: Record<string, string> = {
    signing: "waiting for your signature…",
    submitting: "submitting to the chain…",
    confirming: "confirming on-chain (~30s)…",
    done: "all transactions submitted ✓",
};

/**
 * Batch-signing progress modal. Shown while `signAndSubmitAll` runs:
 *  • bulk (CIP-103) wallets: one prompt, then quick submits;
 *  • one-prompt-per-tx wallets: a per-tx checklist, since each tx must confirm
 *    before the next can be signed.
 */
export function TxProgress({ p }: { p: SignProgress | null }) {
    if (!p) return null;
    const { total, current, phase, bulk, hashes } = p;
    const pct = phase === "done" ? 100 : Math.round((hashes.length / total) * 100);

    return (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Signing transactions">
            <div className="modal-card txprog">
                <h3>{phase === "done" ? "Done" : "Signing transactions"}</h3>

                {bulk && current === 0 ? (
                    <p className="muted">Approve <b>{total}</b> transactions in your wallet — a single prompt.</p>
                ) : (
                    <p className="muted">
                        Transaction <b>{Math.max(1, current)}</b> of <b>{total}</b> — {PHASE[phase]}
                    </p>
                )}

                {!bulk && total > 1 && phase !== "done" && (
                    <p className="muted small">
                        Your wallet signs one transaction at a time, so each must confirm on-chain before the next —
                        this takes a bit. A wallet with batch signing (e.g. Eternl) does it in one prompt.
                    </p>
                )}

                <div className="txdots">
                    {Array.from({ length: total }, (_, i) => {
                        const n = i + 1;
                        const state = phase === "done" || n < current ? "done" : n === current ? "active" : "pending";
                        return (
                            <span key={i} className={`txdot ${state}`} title={`transaction ${n}`}>
                                {state === "done" ? "✓" : n}
                            </span>
                        );
                    })}
                </div>

                <div className="txbar"><div className="txbar-fill" style={{ width: `${pct}%` }} /></div>
            </div>
        </div>
    );
}
