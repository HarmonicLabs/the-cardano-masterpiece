import { useEffect, useState } from "react";
import { CanvasBoard } from "../components/CanvasBoard.tsx";
import { fetchPixels, fetchState, type CanvasStateInfo } from "../lib/api.ts";

export function Landing() {
    const [pixels, setPixels] = useState<Uint8Array | null>(null);
    const [state, setState] = useState<CanvasStateInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        const refresh = () =>
            Promise.all([fetchPixels(), fetchState()])
                .then(([p, s]) => { if (live) { setPixels(p); setState(s); setError(null); } })
                .catch((e) => live && setError(String(e.message ?? e)));
        refresh();
        const t = setInterval(refresh, 30_000);
        return () => { live = false; clearInterval(t); };
    }, []);

    return (
        <section>
            <div className="pagehead">
                <h2>The Canvas</h2>
                <p className="tagline">
                    1008 × 1008 collaborative pixels, reconstructed live from the
                    on-chain leaf UTxOs — no IPFS involved.
                </p>
            </div>
            <div className="frame"><CanvasBoard pixels={pixels} /></div>
            {error && <p className="err">failed to load chain state: {error}</p>}
            {state && (
                <>
                    <div className="stats">
                        <span><b>{state.hatchedLeaves.length}</b>/128 leaves on-chain</span>
                        <span><b>{state.unhatched}</b> unhatched (shown white)</span>
                        <span>network <b>{state.network}</b></span>
                        <span>updated <b>{new Date(state.fetchedAt).toLocaleTimeString()}</b></span>
                    </div>
                    {state.committedImageUri &&
                        <p className="uri">last committed CIP-68 image: {state.committedImageUri}</p>}
                </>
            )}
        </section>
    );
}
