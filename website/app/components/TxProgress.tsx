import { useEffect, useRef } from "react";
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
 *
 * `onClose` (if given) renders an × button and auto-dismisses shortly after the
 * batch is done the caller keeps doing background work (confirm/publish) after
 * the modal is gone.
 */
export function TxProgress({ p, onClose }: { p: SignProgress | null; onClose?: () => void }) {
    // latest onClose without retriggering the auto-dismiss timer on every render
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    const done = p?.phase === "done";
    useEffect(() => {
        if (!done) return;
        const t = setTimeout(() => closeRef.current?.(), 1600);
        return () => clearTimeout(t);
    }, [done]);

    if (!p) return null;
    const { total, current, phase, bulk, hashes } = p;
    const pct = phase === "done" ? 100 : Math.round((hashes.length / total) * 100);

    return (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Signing transactions">
            <div className="modal-card txprog">
                {onClose && (
                    <button className="modal-close" aria-label="close" onClick={onClose}>×</button>
                )}
                <h3>{phase === "done" ? "Done" : "Signing transactions"}</h3>

                {bulk && current === 0 ? (
                    <p className="muted">Approve <b>{total}</b> transactions in your wallet.</p>
                ) : (
                    <p className="muted">
                        Transaction <b>{Math.max(1, current)}</b> of <b>{total}</b> — {PHASE[phase]}
                    </p>
                )}

                {!bulk && total > 1 && phase !== "done" && (
                    <p className="muted small">
                        Your wallet signs one transaction at a time, so each must confirm on-chain before the next.
                        This can take a bit. A wallet with CIP-103 support (e.g. Eternl) does it in one prompt.
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
