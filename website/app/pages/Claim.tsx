import { useEffect, useMemo, useRef, useState } from "react";
import { useCardanoWallet } from "@harmoniclabs/use-cardano-wallet";
import { CanvasBoard, type Overlay } from "../components/CanvasBoard.tsx";
import { NumField } from "../components/NumField.tsx";
import {
    fetchFree, fetchMarket, fetchPixels, fetchState, lovelaceToAda, notifyPublish,
    type CanvasStateInfo, type FreeArea, type MarketListing, type Rect,
} from "../lib/api.ts";
import { buildAcquireTxs, buildSetPriceTx } from "../lib/txbuild.ts";
import { CANVAS_W as W, CANVAS_H as H, isProtocolSteward, MIN_LOVELACE_PER_PIXEL } from "../lib/chain.ts";
import { signAndSubmit, signAndSubmitAll, hasBulkSigner, type SignProgress } from "../lib/sign.ts";
import { TxProgress } from "../components/TxProgress.tsx";
import {
    loadImage, pixelify, saveSprite, loadSavedSprite, clearSavedSprite,
    type PlacedSprite,
} from "../lib/pixelify.ts";

/**
 * A number input that does NOT fight manual typing: while focused it shows
 * your raw draft untouched; the value is committed (and only then clamped /
 * normalized by the parent) on blur or Enter.
 */
const area = (r: Rect): number => (r.x1 - r.x0) * (r.y1 - r.y0);
const intersectArea = (a: Rect, b: Rect): number => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return w > 0 && h > 0 ? w * h : 0;
};
const contains = (o: Rect, i: Rect): boolean =>
    o.x0 <= i.x0 && i.x1 <= o.x1 && o.y0 <= i.y0 && i.y1 <= o.y1;

export function Claim() {
    const { isConnected, address, api, connectedWallet } = useCardanoWallet();
    const [pixels, setPixels] = useState<Uint8Array | null>(null);
    const [free, setFree] = useState<FreeArea[]>([]);
    const [listings, setListings] = useState<MarketListing[]>([]);
    const [state, setState] = useState<CanvasStateInfo | null>(null);
    const [sel, setSel] = useState<Rect | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [newPriceAda, setNewPriceAda] = useState("");
    const [signProg, setSignProg] = useState<SignProgress | null>(null);

    const isSteward = address != null && isProtocolSteward(address);
    async function setPrice() {
        if (!api || !address) return;
        const ada = Number(newPriceAda);
        const minAda = Number(MIN_LOVELACE_PER_PIXEL) / 1_000_000;
        if (!Number.isFinite(ada) || ada < minAda) { setError(`price must be at least ${minAda} ₳ per pixel`); return; }
        setError(null); setResult(null);
        try {
            setBusy("updating price…");
            const tx = await buildSetPriceTx(api, address, BigInt(Math.round(ada * 1_000_000)));
            const hash = await signAndSubmit(api, tx);
            setResult(hash); setNewPriceAda("");
            setBusy("waiting for confirmation…");
            await new Promise((r) => setTimeout(r, 30_000));
            await refresh();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally { setBusy(null); setSignProg(null); }
    }

    // imported-image preview
    const [srcImage, setSrcImage] = useState<HTMLImageElement | null>(null);
    const [spriteW, setSpriteW] = useState(32);
    const [sprite, setSprite] = useState<PlacedSprite | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const refresh = () =>
        Promise.all([fetchPixels(), fetchFree(), fetchState(), fetchMarket()])
            .then(([p, f, s, m]) => { setPixels(p); setFree(f); setState(s); setListings(m.listings); })
            .catch((e) => setError(String(e.message ?? e)));
    useEffect(() => { void refresh(); }, []);

    // Persist the placed image locally and restore it after a refresh or a
    // partial batch, so a claim+paint that only half went through isn't lost.
    // Cleared once the batch fully goes through (or the user discards).
    const [resumed, setResumed] = useState(false);
    useEffect(() => {
        const saved = loadSavedSprite();
        if (saved) { setSprite(saved); setResumed(true); }
    }, []);
    useEffect(() => {   // debounced so dragging a large image doesn't re-serialize every frame
        if (!sprite) return;
        const t = setTimeout(() => saveSprite(sprite), 400);
        return () => clearTimeout(t);
    }, [sprite]);

    // (re)pixelify when the source image or the target size changes
    useEffect(() => {
        if (!srcImage) return;
        const s = pixelify(srcImage, spriteW);
        setSprite((prev) => ({
            ...s,
            x: Math.min(prev?.x ?? Math.floor((W - s.w) / 2), W - s.w),
            y: Math.min(prev?.y ?? Math.floor((H - s.h) / 2), H - s.h),
        }));
    }, [srcImage, spriteW]);

    async function onFile(f: File | undefined) {
        if (!f) return;
        setError(null); setResumed(false);
        try { setSrcImage(await loadImage(f)); }
        catch (e) { setError(String((e as Error).message ?? e)); }
    }

    function dropImage() {
        setSrcImage(null); setSprite(null); clearSavedSprite();
        if (fileRef.current) fileRef.current.value = "";
    }

    const overlays: Overlay[] = useMemo(
        () => [
            ...free.map((f) => ({ rect: f.rect, color: "rgba(90, 200, 120, .25)" })),
            ...listings.map((l) => ({ rect: l.rect, color: "rgba(201, 168, 106, .35)" })),
        ],
        [free, listings]
    );

    // exact-coordinate entry: edits the selection, or moves the sprite.
    // The edited value also snaps flush when it lands within SNAP pixels of a
    // claimed-area boundary or the canvas border (only the axis being edited
    // — the other axis is left exactly where it was)
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
    function setCoord(field: "x0" | "y0" | "x1" | "y1", raw: string) {
        const v = Number(raw);
        if (!Number.isFinite(v)) return;
        const { xs, ys } = snapEdges();
        if (sprite) {
            // the sprite has a fixed size: x0/y0 move it (x1/y1 are derived)
            if (field === "x0" || field === "x1") {
                const x = clamp(field === "x0" ? v : v - sprite.w, 0, W - sprite.w);
                const sx = Math.max(0, Math.min(W - sprite.w, snapAxis(x, sprite.w, xs)));
                setSprite((s) => (s ? { ...s, x: sx } : s));
            } else {
                const y = clamp(field === "y0" ? v : v - sprite.h, 0, H - sprite.h);
                const sy = Math.max(0, Math.min(H - sprite.h, snapAxis(y, sprite.h, ys)));
                setSprite((s) => (s ? { ...s, y: sy } : s));
            }
            return;
        }
        const base: Rect = sel ?? { x0: 0, y0: 0, x1: 16, y1: 16 };
        const edges = field === "x0" || field === "x1" ? xs : ys;
        const lim = field === "x0" || field === "x1" ? W : H;
        const r: Rect = { ...base, [field]: snapEdge(clamp(v, 0, lim), edges) };
        // keep the rect non-empty by pushing the opposite bound if needed
        if (r.x1 <= r.x0) { if (field === "x0") r.x1 = Math.min(W, r.x0 + 1); else r.x0 = Math.max(0, r.x1 - 1); }
        if (r.y1 <= r.y0) { if (field === "y0") r.y1 = Math.min(H, r.y0 + 1); else r.y0 = Math.max(0, r.y1 - 1); }
        setSel(r);
    }
    // center of the image/selection: shown next to the bounds, and editable —
    // typing a center moves the rect (size unchanged) so it sits there
    function setCenter(axis: "x" | "y", raw: string) {
        const v = Number(raw);
        if (!Number.isFinite(v) || !claimRect) return;
        const { xs, ys } = snapEdges();
        if (sprite) {
            if (axis === "x") {
                const x = clamp(v - sprite.w / 2, 0, W - sprite.w);
                const sx = Math.max(0, Math.min(W - sprite.w, snapAxis(x, sprite.w, xs)));
                setSprite((s) => (s ? { ...s, x: sx } : s));
            } else {
                const y = clamp(v - sprite.h / 2, 0, H - sprite.h);
                const sy = Math.max(0, Math.min(H - sprite.h, snapAxis(y, sprite.h, ys)));
                setSprite((s) => (s ? { ...s, y: sy } : s));
            }
            return;
        }
        const w = claimRect.x1 - claimRect.x0, h = claimRect.y1 - claimRect.y0;
        if (axis === "x") {
            const x0 = Math.max(0, Math.min(W - w, snapAxis(clamp(v - w / 2, 0, W - w), w, xs)));
            setSel({ ...claimRect, x0, x1: x0 + w });
        } else {
            const y0 = Math.max(0, Math.min(H - h, snapAxis(clamp(v - h / 2, 0, H - h), h, ys)));
            setSel({ ...claimRect, y0, y1: y0 + h });
        }
    }

    // magnetic snapping: when a dragged image edge comes within SNAP pixels
    // of a claimed-area boundary (= free/listing tiling edges) or the canvas
    // border, clip flush against it — no slivers of wasted space between
    const SNAP = 10;
    const snapAxis = (pos: number, size: number, edges: number[]): number => {
        let best = pos, bestD = SNAP + 1;
        for (const e of edges) {
            const dNear = Math.abs(pos - e);            // leading edge -> e
            if (dNear < bestD) { bestD = dNear; best = e; }
            const dFar = Math.abs(pos + size - e);      // trailing edge -> e
            if (dFar < bestD) { bestD = dFar; best = e - size; }
        }
        return bestD <= SNAP ? best : pos;
    };
    const snapEdges = (): { xs: number[]; ys: number[] } => {
        const xs: number[] = [0, W], ys: number[] = [0, H];
        for (const f of free) { xs.push(f.rect.x0, f.rect.x1); ys.push(f.rect.y0, f.rect.y1); }
        for (const l of listings) { xs.push(l.rect.x0, l.rect.x1); ys.push(l.rect.y0, l.rect.y1); }
        return { xs, ys };
    };
    const snapSprite = (x: number, y: number, w: number, h: number): { x: number; y: number } => {
        const { xs, ys } = snapEdges();
        return {
            x: Math.max(0, Math.min(W - w, snapAxis(x, w, xs))),
            y: Math.max(0, Math.min(H - h, snapAxis(y, h, ys))),
        };
    };
    // a plain drag-selection resizes instead: each edge snaps independently
    const snapEdge = (v: number, edges: number[]): number => {
        let best = v, bestD = SNAP + 1;
        for (const e of edges) { const d = Math.abs(v - e); if (d < bestD) { bestD = d; best = e; } }
        return bestD <= SNAP ? best : v;
    };
    const snapRect = (r: Rect): Rect => {
        const { xs, ys } = snapEdges();
        let x0 = snapEdge(r.x0, xs), x1 = snapEdge(r.x1, xs);
        let y0 = snapEdge(r.y0, ys), y1 = snapEdge(r.y1, ys);
        if (x1 <= x0) { x0 = r.x0; x1 = r.x1; }   // a tiny selection must not collapse
        if (y1 <= y0) { y0 = r.y0; y1 = r.y1; }
        return { x0, y0, x1, y1 };
    };

    // the sprite's bounding box IS the claim rect when an image is loaded
    const claimRect: Rect | null = sprite
        ? { x0: sprite.x, y0: sprite.y, x1: sprite.x + sprite.w, y1: sprite.y + sprite.h }
        : sel;
    // The selection may span FREE areas (claimed from free space) AND LISTED
    // areas (bought from the marketplace) — both are acquired in one batch.
    // Free areas tile disjointly and never overlap listings, so the whole rect
    // is available iff (free ∩ sel) + (listed ∩ sel) covers it exactly.
    const freeCover = claimRect ? free.reduce((s, f) => s + intersectArea(f.rect, claimRect), 0) : 0;
    const listedCover = claimRect ? listings.reduce((s, l) => s + intersectArea(l.rect, claimRect), 0) : 0;
    const buyable = claimRect != null && freeCover + listedCover === area(claimRect);
    const fullyFree = claimRect != null && listedCover === 0 && freeCover === area(claimRect);
    // the protocol steward claims free space at no cost; buying LISTED plots still
    // costs the seller's price (even for the steward)
    const stewardFree = fullyFree && isSteward;
    const price = !buyable || claimRect == null ? null : (() => {
        const stewardPP = state != null ? BigInt(state.pricePerPixelLovelace) : 0n;
        let total = isSteward ? 0n : BigInt(freeCover) * stewardPP;         // the free portion
        for (const l of listings) {                                     // the listed portions
            const ia = intersectArea(l.rect, claimRect);
            if (ia > 0) total += BigInt(ia) * BigInt(l.pricePerPixel);
        }
        return total;
    })();
    const hasListed = listedCover > 0;
    const freePartCount = claimRect ? free.filter((f) => intersectArea(f.rect, claimRect) > 0).length : 0;
    const listedPartCount = claimRect ? listings.filter((l) => intersectArea(l.rect, claimRect) > 0).length : 0;
    const pieceCount = freePartCount + listedPartCount;
    const canMerge = api != null && hasBulkSigner(api);

    async function claim() {
        if (!claimRect || !api || !address || !buyable) return;
        const willCommit = !!sprite;
        setError(null); setResult(null);
        try {
            setBusy("building transaction(s)…");
            // claim the free parts + buy the listed parts, then (if the wallet
            // can bulk-sign) merge everything into one deed, then paint + commit
            const txs = await buildAcquireTxs(api, address, claimRect, listings, sprite ?? undefined, hasBulkSigner(api));
            const hashes = await signAndSubmitAll(api, txs, setSignProg, connectedWallet?.name);
            setResult(hashes[hashes.length - 1]);
            if (sprite) { clearSavedSprite(); setResumed(false); }
            setSel(null);
            setBusy("waiting for confirmation…");
            await new Promise((r) => setTimeout(r, 30_000));
            await refresh();
            if (willCommit) void notifyPublish();   // pin the freshly-committed image (best-effort)
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null); setSignProg(null);
        }
    }

    return (
        <section>
            <TxProgress p={signProg} onClose={() => setSignProg(null)} />
            <div className="pagehead">
                <h2>Claim</h2>
                <p className="tagline">
                    Green areas are unclaimed
                    ({state ? lovelaceToAda(state.pricePerPixelLovelace) : "…"} ₳ per pixel);
                    gold areas are owned but listed for sale at the seller's price — you can
                    buy all of a listed plot or just a piece of it. Drag to select, or import
                    an image, choose its pixel size, and drag it where you want it.
                </p>
            </div>

            {isSteward && (
                <div className="actionbar">
                    <span className="muted">protocol steward — price is
                        &nbsp;<b>{state ? lovelaceToAda(state.pricePerPixelLovelace) : "…"} ₳</b>/px</span>
                    <label>
                        set ₳/px
                        <input type="number" min={1} step={1} value={newPriceAda} style={{ width: "6rem" }}
                            placeholder="new" onChange={(e) => setNewPriceAda(e.target.value)} />
                    </label>
                    <button className="primary" disabled={newPriceAda === "" || busy != null}
                        onClick={() => void setPrice()}>{busy ?? "update price"}</button>
                </div>
            )}

            <div className="actionbar">
                <label className="filebtn">
                    <input ref={fileRef} type="file" accept="image/*"
                        onChange={(e) => void onFile(e.target.files?.[0])} />
                    {srcImage ? "replace image" : "import image…"}
                </label>
                {sprite && (
                    <>
                        <label>
                            size <input type="range" min={2} max={1008} step={1} value={spriteW}
                                onChange={(e) => setSpriteW(Number(e.target.value))} />
                            <NumField min={2} max={1008} step={1} value={spriteW} width="4.6rem"
                                commit={(raw) => {
                                    const v = Number(raw);
                                    if (Number.isFinite(v)) setSpriteW(Math.max(2, Math.min(1008, Math.round(v))));
                                }} />
                            <code>{sprite.w}×{sprite.h}</code>
                        </label>
                        {resumed && <span className="ok" title="restored from a refresh / partial batch">resumed pending edit</span>}
                        <button onClick={dropImage}>remove image</button>
                    </>
                )}
                <label className="coords">
                    coordinates
                    <NumField min={0} max={1023} placeholder="x0"
                        value={claimRect?.x0 ?? ""} commit={(raw) => setCoord("x0", raw)} />
                    <NumField min={0} max={1023} placeholder="y0"
                        value={claimRect?.y0 ?? ""} commit={(raw) => setCoord("y0", raw)} />
                    →
                    <NumField min={1} max={W} placeholder="x1"
                        value={claimRect?.x1 ?? ""} commit={(raw) => setCoord("x1", raw)} />
                    <NumField min={1} max={H} placeholder="y1"
                        value={claimRect?.y1 ?? ""} commit={(raw) => setCoord("y1", raw)} />
                </label>
                <label className="coords">
                    center
                    <NumField min={0} max={W} step={0.5} placeholder="cx"
                        value={claimRect ? (claimRect.x0 + claimRect.x1) / 2 : ""}
                        commit={(raw) => setCenter("x", raw)} />
                    <NumField min={0} max={H} step={0.5} placeholder="cy"
                        value={claimRect ? (claimRect.y0 + claimRect.y1) / 2 : ""}
                        commit={(raw) => setCenter("y", raw)} />
                </label>
            </div>

            <div className="frame">
                <CanvasBoard
                    pixels={pixels}
                    overlays={overlays}
                    selection={sel}
                    onSelect={sprite ? undefined : (r) => setSel(snapRect(r))}
                    sprite={sprite}
                    spriteValid={buyable}
                    onSpriteMove={(x, y) => setSprite((s) => (s ? { ...s, ...snapSprite(x, y, s.w, s.h) } : s))}
                    onSpriteResize={(w) => setSpriteW(w)}
                />
            </div>

            <div className="actionbar">
                {claimRect && (
                    <span>
                        {sprite ? "image placed at" : "selection"}{" "}
                        <code>{claimRect.x0},{claimRect.y0} → {claimRect.x1},{claimRect.y1}</code>
                        &nbsp;({area(claimRect)} px{price != null && <> — <b>{stewardFree ? "free (steward)" : `${lovelaceToAda(price)} ₳`}</b></>})
                    </span>
                )}
                {claimRect && !buyable && (
                    <span className="err">
                        part of this selection is owned and not for sale — trim it to the green (free) and gold (listed) areas
                    </span>
                )}
                {claimRect && buyable && hasListed && (
                    <span className="muted">
                        {freePartCount > 0 && `${freePartCount} free part${freePartCount === 1 ? "" : "s"} claimed + `}
                        {listedPartCount} listed part{listedPartCount === 1 ? "" : "s"} bought from the marketplace
                    </span>
                )}
                {claimRect && buyable && pieceCount > 1 && (
                    <span className="muted">
                        {pieceCount} pieces — {canMerge
                            ? "your wallet can merge them into a single NFT"
                            : "kept as separate deeds (a wallet with batch signing merges them into one)"}
                    </span>
                )}
                {!isConnected && claimRect && buyable && <span className="muted">connect a wallet to acquire</span>}
                <button
                    className="primary"
                    disabled={!claimRect || !buyable || !isConnected || busy != null}
                    onClick={() => void claim()}
                >
                    {busy ?? (hasListed ? "acquire this area" : stewardFree ? "claim this area (free)" : "claim this area")}
                </button>
            </div>
            {result && (
                <p className="ok">
                    {hasListed ? "acquired!" : "claimed!"} tx <code>{result}</code>
                    {sprite && " — your image is being painted in the same batch; it appears once the chain confirms"}
                </p>
            )}
            {error && <p className="err">{error}</p>}
        </section>
    );
}
