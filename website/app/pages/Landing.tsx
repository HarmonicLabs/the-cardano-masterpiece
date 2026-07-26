import { useEffect, useState } from "react";
import { CanvasBoard } from "../components/CanvasBoard.tsx";
import { fetchPixels, fetchState, type CanvasStateInfo } from "../lib/api.ts";

// pool.pm (mainnet) renders the CIP-68 image inline — it resolves the (222) user
// token's (100) reference metadata and shows the actual masterpiece. Link by the
// CIP-14 asset fingerprint (its `<policy>.<name>` form 404s). The root NFT is a
// fixed, immutable asset, so this fingerprint never changes.
const ROOT_NFT_URL = "https://pool.pm/asset1n2r84er8pra9apczkznh0ftjwrtr4kaejk4qr8";
// Resolve ipfs:// to an HTTP gateway (not all browsers speak ipfs:// natively).
// Link TEXT stays `ipfs://<cid>`; only the href points at the gateway.
const ipfsGateway = (uri: string) =>
    `https://most-brass-sun.quicknode-ipfs.com/ipfs/${uri.replace(/^ipfs:\/\//, "")}`;

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
                    on-chain UTxOs
                </p>
            </div>
            <div className="frame"><CanvasBoard pixels={pixels} /></div>
            {error && <p className="err">failed to load chain state: {error}</p>}
            {state && (
                <>
                    {state.committedImageUri &&
                        <p className="uri">last committed CIP-68 image:{" "}
                            <a href={ipfsGateway(state.committedImageUri)} target="_blank" rel="noreferrer">
                                {state.committedImageUri}
                            </a>
                        </p>}
                    <p className="uri">
                        <a href={ROOT_NFT_URL} target="_blank" rel="noreferrer">
                            view the NFT on pool.pm ↗
                        </a>
                    </p>
                </>
            )}
        </section>
    );
}
