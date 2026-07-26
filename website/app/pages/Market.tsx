import { useEffect, useMemo, useState } from "react";
import { useCardanoWallet } from "@harmoniclabs/use-cardano-wallet";
import { CanvasBoard, type Overlay } from "../components/CanvasBoard.tsx";
import { TxProgress } from "../components/TxProgress.tsx";
import {
    fetchDeeds, fetchMarket, fetchPixels, fetchPlots, lovelaceToAda,
    type DeedInfo, type MarketListing, type MarketOrders, type Plot, type Rect,
} from "../lib/api.ts";
import {
    buildMarketBuyTx, buildMarketBuyTxs, buildMarketCancelTx, buildMarketCancelTxs,
    buildMarketFillTx, buildMarketListTx, buildMarketRequestTx,
} from "../lib/txbuild.ts";
import { signAndSubmit, signAndSubmitAll, type SignProgress } from "../lib/sign.ts";

const area = (r: Rect): number => (r.x1 - r.x0) * (r.y1 - r.y0);
const rectStr = (r: Rect): string => `${r.x0},${r.y0} → ${r.x1},${r.y1}`;
const shortAddr = (a: string): string => `${a.slice(0, 12)}…${a.slice(-5)}`;

export function Market() {
    const { isConnected, address, api, connectedWallet } = useCardanoWallet();
    const [pixels, setPixels] = useState<Uint8Array | null>(null);
    const [market, setMarket] = useState<MarketOrders | null>(null);
    const [deeds, setDeeds] = useState<DeedInfo[]>([]);
    const [plots, setPlots] = useState<Plot[]>([]);
    const [selected, setSelected] = useState<DeedInfo[]>([]);
    const [priceAda, setPriceAda] = useState("1");
    const [offerAda, setOfferAda] = useState("10");
    const [busy, setBusy] = useState<string | null>(null);
    const [signProg, setSignProg] = useState<SignProgress | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = async () => {
        const [p, m, d] = await Promise.all([fetchPixels(), fetchMarket(), fetchDeeds()]);
        setPixels(p); setMarket(m); setDeeds(d);
        if (address) setPlots(await fetchPlots(address));
    };
    useEffect(() => { refresh().catch((e) => setError(String(e.message ?? e))); }, [address]);

    const overlays: Overlay[] = useMemo(() => {
        const base: Overlay[] = market ? [
            ...market.listings.map((l) => ({ rect: l.rect, color: "rgba(201, 168, 106, .35)" })),
            ...market.requests.map((r) => ({ rect: r.rect, color: "rgba(96, 140, 220, .30)" })),
        ] : [];
        return [...base, ...selected.map((d) => ({ rect: d.rect, color: "rgba(255, 255, 255, .30)" }))];
    }, [market, selected]);

    // clicking the canvas toggles the deed containing the point in/out of the selection
    const pick = (r: Rect) => {
        const d = deeds.find((x) =>
            x.rect.x0 <= r.x0 && r.x0 < x.rect.x1 && x.rect.y0 <= r.y0 && r.y0 < x.rect.y1);
        if (!d) { setError("that pixel is unclaimed — buy it on the Claim page"); return; }
        setError(null);
        setSelected((prev) => prev.some((p) => p.name === d.name)
            ? prev.filter((p) => p.name !== d.name)
            : [...prev, d]);
    };

    const mine = (steward: string) => address != null && steward === address;
    const listingOf = (name: string) => market?.listings.find((l) => l.name === name);

    // single-selection derived state (list / request / one-off buy/cancel)
    const single = selected.length === 1 ? selected[0] : null;
    const singleListing = single ? listingOf(single.name) : undefined;
    const singleIsMine = single != null && plots.some((p) => p.name === single.name);

    // multi-selection: partition into batch-buyable listings and my own listings
    const selListings = selected.map((d) => listingOf(d.name)).filter((l): l is MarketListing => l != null);
    const buyable = selListings.filter((l) => !mine(l.seller));
    const myListed = selListings.filter((l) => mine(l.seller));
    const buyableTotal = buyable.reduce((s, l) => s + BigInt(l.priceTotal), 0n);
    const notListed = selected.length - selListings.length;

    async function run(what: string, build: () => Promise<string>) {
        if (!api) { setError("connect a wallet first"); return; }
        setError(null); setResult(null);
        try {
            setBusy(`${what}: building transaction…`);
            const tx = await build();
            setBusy(`${what}: waiting for wallet signature…`);
            const hash = await signAndSubmit(api, tx);
            setResult(`${what} submitted: ${hash}`);
            setBusy(`${what}: waiting for confirmation…`);
            await new Promise((r) => setTimeout(r, 30_000));
            setSelected([]);
            await refresh();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    }

    async function runBatch(what: string, build: () => Promise<string[]>) {
        if (!api) { setError("connect a wallet first"); return; }
        setError(null); setResult(null);
        try {
            setBusy(`${what}: building transactions…`);
            const txs = await build();
            const hashes = await signAndSubmitAll(api, txs, setSignProg, connectedWallet?.name);
            setResult(`${what}: ${hashes.length} transaction${hashes.length > 1 ? "s" : ""} submitted`);
            setBusy(`${what}: waiting for confirmation…`);
            await new Promise((r) => setTimeout(r, 30_000));
            setSelected([]);
            await refresh();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null); setSignProg(null);
        }
    }

    return (
        <section>
            <div className="pagehead">
                <h2>Market</h2>
                <p className="tagline">
                    Gold areas are listed for sale, blue areas have open purchase requests.
                    Click claimed plots to select them (click again to deselect) — buy several
                    listed plots at once, or trade a single plot below. Partial buys happen on the Claim page.
                </p>
            </div>

            <div className="frame">
                <CanvasBoard pixels={pixels} overlays={overlays} selection={single?.rect ?? null} onSelect={pick} />
            </div>

            {/* ---- multi-select batch bar ---- */}
            {selected.length > 1 && (
                <div className="actionbar order-panel">
                    <span><b>{selected.length}</b> plots selected</span>
                    {buyable.length > 0 && (
                        <button className="primary" disabled={busy != null || !isConnected}
                            onClick={() => void runBatch("buy", () => buildMarketBuyTxs(api!, address!, buyable))}>
                            buy {buyable.length} — total {lovelaceToAda(buyableTotal.toString())} ₳
                        </button>
                    )}
                    {myListed.length > 0 && (
                        <button disabled={busy != null}
                            onClick={() => void runBatch("cancel", () => buildMarketCancelTxs(api!, address!, myListed.map((l) => l.utxoRef)))}>
                            cancel {myListed.length} listing{myListed.length > 1 ? "s" : ""}
                        </button>
                    )}
                    <button onClick={() => setSelected([])}>clear</button>
                    {notListed > 0 && (
                        <span className="muted small">
                            {notListed} selected plot{notListed > 1 ? "s aren't" : " isn't"} listed — only listed
                            plots can be batch-bought; list or request them individually below.
                        </span>
                    )}
                </div>
            )}

            {/* ---- single-plot panel ---- */}
            {single && (
                <div className="actionbar order-panel">
                    <span><code>{single.name}</code> ({area(single.rect)} px)</span>
                    {singleListing ? (
                        mine(singleListing.seller) ? (
                            <>
                                <span>your listing at <b>{lovelaceToAda(singleListing.pricePerPixel)} ₳/px</b></span>
                                <button disabled={busy != null}
                                    onClick={() => void run("cancel", () => buildMarketCancelTx(api!, address!, singleListing.utxoRef))}>
                                    cancel listing
                                </button>
                            </>
                        ) : (
                            <>
                                <span>listed at <b>{lovelaceToAda(singleListing.pricePerPixel)} ₳/px</b> —
                                    total <b>{lovelaceToAda(singleListing.priceTotal)} ₳</b></span>
                                <button className="primary" disabled={busy != null || !isConnected}
                                    onClick={() => void run("buy", () => buildMarketBuyTx(api!, address!, singleListing))}>
                                    buy whole plot
                                </button>
                            </>
                        )
                    ) : singleIsMine ? (
                        <>
                            <label>
                                price ₳/px <input type="number" min="0.1" step="0.1" value={priceAda}
                                    style={{ width: "5rem" }}
                                    onChange={(e) => setPriceAda(e.target.value)} />
                            </label>
                            <button className="primary" disabled={busy != null || !isConnected}
                                onClick={() => void run("list", () => buildMarketListTx(
                                    api!, address!, single.name, BigInt(Math.round(Number(priceAda) * 1_000_000))))}>
                                list for sale
                            </button>
                        </>
                    ) : (
                        <>
                            <label>
                                offer ₳ <input type="number" min="2" step="1" value={offerAda}
                                    style={{ width: "5rem" }}
                                    onChange={(e) => setOfferAda(e.target.value)} />
                            </label>
                            <button className="primary" disabled={busy != null || !isConnected}
                                onClick={() => void run("request", () => buildMarketRequestTx(
                                    api!, address!, single.rect, BigInt(Math.round(Number(offerAda) * 1_000_000)),
                                    deeds.map((d) => d.name)))}>
                                post purchase request
                            </button>
                        </>
                    )}
                </div>
            )}

            {busy && <p className="muted">{busy}</p>}
            {result && <p className="ok">{result}</p>}
            {error && <p className="err">{error}</p>}

            <div className="market-cols">
                <div className="market-col">
                    <h3>Listings <small>{market?.listings.length ?? 0}</small></h3>
                    {market?.listings.length === 0 && <p className="muted">nothing listed yet</p>}
                    {market?.listings.map((l) => (
                        <div key={l.utxoRef} className="order-card">
                            <code>{l.name}</code>
                            <span>{area(l.rect)} px · {rectStr(l.rect)}</span>
                            <span>{lovelaceToAda(l.pricePerPixel)} ₳/px — <b>{lovelaceToAda(l.priceTotal)} ₳</b></span>
                            <span className="muted" title={l.seller}>seller {shortAddr(l.seller)}</span>
                            <div className="order-actions">
                                {mine(l.seller) ? (
                                    <button disabled={busy != null}
                                        onClick={() => void run("cancel", () => buildMarketCancelTx(api!, address!, l.utxoRef))}>cancel</button>
                                ) : (
                                    <button className="primary" disabled={busy != null || !isConnected}
                                        onClick={() => void run("buy", () => buildMarketBuyTx(api!, address!, l))}>buy</button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="market-col">
                    <h3>Requests <small>{market?.requests.length ?? 0}</small></h3>
                    {market?.requests.length === 0 && <p className="muted">no open requests</p>}
                    {market?.requests.map((r) => (
                        <div key={r.utxoRef} className="order-card">
                            <code>{r.name}</code>
                            <span>{area(r.rect)} px · {rectStr(r.rect)}</span>
                            <span>offers <b>{lovelaceToAda(r.offerLovelace)} ₳</b></span>
                            <span className="muted" title={r.requester}>by {shortAddr(r.requester)}</span>
                            <div className="order-actions">
                                {plots.some((p) => p.name === r.name) && (
                                    <button className="primary" disabled={busy != null}
                                        onClick={() => void run("fill", () => buildMarketFillTx(api!, address!, r))}>
                                        sell to this offer
                                    </button>
                                )}
                                {mine(r.requester) && (
                                    <button disabled={busy != null}
                                        onClick={() => void run("cancel", () => buildMarketCancelTx(api!, address!, r.utxoRef))}>cancel</button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <TxProgress p={signProg} onClose={() => setSignProg(null)} />
        </section>
    );
}
