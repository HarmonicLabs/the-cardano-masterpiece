// typed client for the masterpiece API server
export interface Rect { x0: number; y0: number; x1: number; y1: number; }
export interface PixelEdit { x: number; y: number; v: number; }

export interface CanvasStateInfo {
    hatchedLeaves: number[];
    unhatched: number;
    committedImageUri: string | null;
    fetchedAt: string;
    network: string;
    masterpieceAddress: string;
    masterpiecePolicy: string;
    ownershipPolicy: string;
    pricePerPixelLovelace: string;
}

export interface FreeArea { rect: Rect; utxoRef: string; }
export interface Plot { rect: Rect; name: string; utxoRef: string; }

async function j<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let msg = `${res.status}`;
        try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep status */ }
        throw new Error(msg);
    }
    return res.json() as Promise<T>;
}

export const fetchState = (): Promise<CanvasStateInfo> =>
    fetch("/api/state").then((r) => j<CanvasStateInfo>(r));

export const fetchPixels = async (): Promise<Uint8Array> =>
    new Uint8Array(await (await fetch("/canvas.bin")).arrayBuffer());

export const fetchFree = (): Promise<FreeArea[]> =>
    fetch("/api/free").then((r) => j<FreeArea[]>(r));

export const fetchPlots = (address: string): Promise<Plot[]> =>
    fetch(`/api/plots?address=${encodeURIComponent(address)}`).then((r) => j<Plot[]>(r));

const post = <T,>(url: string, body: unknown): Promise<T> =>
    fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }).then((r) => j<T>(r));

/** one tx per unclaimed area the rect spans; sign+submit them IN ORDER */
export const buildClaimTxs = (address: string, rect: Rect): Promise<{ txs: string[] }> =>
    post("/api/tx/claim", { address, rect });

export const buildEditTx = (address: string, leafIdx: number, pixels: PixelEdit[]): Promise<{ tx: string }> =>
    post("/api/tx/edit", { address, leafIdx, pixels });

/** one chained tx per touched leaf; sign+submit IN ORDER (CIP-103 friendly) */
export const buildEditBatchTxs = (
    address: string, groups: { leafIdx: number; pixels: PixelEdit[] }[],
): Promise<{ txs: string[] }> =>
    post("/api/tx/edit-batch", { address, groups });

export const submitTx = (tx: string, witnesses: string): Promise<{ hash: string }> =>
    post("/api/tx/submit", { tx, witnesses });

/**
 * Pin the freshly-committed image to IPFS (best-effort). Call after a commit
 * has confirmed. Retries a few times because the new committed root may take a
 * moment to be indexed on-chain — the server's root-match guard refuses to pin
 * until it can reproduce the committed CID. NEVER throws: pinning is a
 * convenience layer; the on-chain image is the source of truth.
 */
export async function notifyPublish(attempts = 4, delayMs = 15_000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch("/api/publish", { method: "POST" });
            if (res.ok) return;                        // pinned (or already pinned)
        } catch { /* network hiccup — retry */ }
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
}

// ---- marketplace -----------------------------------------------------------

export interface MarketListing {
    rect: Rect; name: string; seller: string;
    pricePerPixel: string; priceTotal: string; utxoRef: string;
}
export interface MarketRequest {
    rect: Rect; name: string; requester: string; offerLovelace: string; utxoRef: string;
}
export interface MarketOrders { listings: MarketListing[]; requests: MarketRequest[]; }
export interface DeedInfo { rect: Rect; name: string; }

export const fetchMarket = (): Promise<MarketOrders> =>
    fetch("/api/market").then((r) => j<MarketOrders>(r));

export const fetchDeeds = (): Promise<DeedInfo[]> =>
    fetch("/api/deeds").then((r) => j<DeedInfo[]>(r));

export const buildMarketListTx = (address: string, name: string, pricePerPixelLovelace: string): Promise<{ tx: string }> =>
    post("/api/tx/market/list", { address, name, pricePerPixelLovelace });

export const buildMarketBuyTx = (address: string, utxoRef: string): Promise<{ tx: string }> =>
    post("/api/tx/market/buy", { address, utxoRef });

export const buildMarketPartialBuyTx = (address: string, utxoRef: string, bought: Rect): Promise<{ tx: string }> =>
    post("/api/tx/market/partialbuy", { address, utxoRef, bought });

export const buildMarketCancelTx = (address: string, utxoRef: string): Promise<{ tx: string }> =>
    post("/api/tx/market/cancel", { address, utxoRef });

export const buildMarketRequestTx = (address: string, rect: Rect, offerLovelace: string): Promise<{ tx: string }> =>
    post("/api/tx/market/request", { address, rect, offerLovelace });

export const buildMarketFillTx = (address: string, utxoRef: string): Promise<{ tx: string }> =>
    post("/api/tx/market/fill", { address, utxoRef });

export const lovelaceToAda = (l: bigint | string | number): string =>
    (Number(l) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
