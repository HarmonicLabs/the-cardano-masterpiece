import { useEffect, useState } from "react";
import { CanvasBoard } from "../components/CanvasBoard.tsx";
import { fetchPixels, fetchState, type CanvasStateInfo } from "../lib/api.ts";

// CIP-68 (222) user token for the root "masterpiece" NFT.
const ROOT_USER_ASSET_NAME = "000de1406d61737465727069656365";
// pool.pm (mainnet) renders the CIP-68 image inline — it resolves the (222) user
// token's (100) reference metadata and shows the actual masterpiece. Its canonical
// deep-link form is `<policyId>.<assetNameHex>`.
const poolPmAsset = (policy: string, nameHex: string) =>
    `https://pool.pm/${policy}.${nameHex}`;
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
                        <a href={poolPmAsset(state.masterpiecePolicy, ROOT_USER_ASSET_NAME)}
                           target="_blank" rel="noreferrer">
                            view the NFT on pool.pm ↗
                        </a>
                    </p>
                </>
            )}
        </section>
    );
}
