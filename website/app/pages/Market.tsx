import { useEffect, useMemo, useState } from "react";
import { useCardanoWallet } from "@harmoniclabs/use-cardano-wallet";
import { CanvasBoard, type Overlay } from "../components/CanvasBoard.tsx";
import {
    fetchDeeds, fetchMarket, fetchPixels, fetchPlots, lovelaceToAda,
    type DeedInfo, type MarketOrders, type Plot, type Rect,
} from "../lib/api.ts";
import {
    buildMarketBuyTx, buildMarketCancelTx, buildMarketFillTx, buildMarketListTx,
    buildMarketRequestTx,
} from "../lib/txbuild.ts";
import { signAndSubmit } from "../lib/sign.ts";

const area = (r: Rect): number => (r.x1 - r.x0) * (r.y1 - r.y0);
const rectStr = (r: Rect): string => `${r.x0},${r.y0} → ${r.x1},${r.y1}`;
const shortAddr = (a: string): string => `${a.slice(0, 12)}…${a.slice(-5)}`;

export function Market() {
    const { isConnected, address, api } = useCardanoWallet();
    const [pixels, setPixels] = useState<Uint8Array | null>(null);
    const [market, setMarket] = useState<MarketOrders | null>(null);
    const [deeds, setDeeds] = useState<DeedInfo[]>([]);
    const [plots, setPlots] = useState<Plot[]>([]);
    const [picked, setPicked] = useState<DeedInfo | null>(null);
    const [priceAda, setPriceAda] = useState("1");
    const [offerAda, setOfferAda] = useState("10");
    const [busy, setBusy] = useState<string | null>(null);
    const [result, setResult] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = async () => {
        const [p, m, d] = await Promise.all([fetchPixels(), fetchMarket(), fetchDeeds()]);
        setPixels(p); setMarket(m); setDeeds(d);
        if (address) setPlots(await fetchPlots(address));
    };
    useEffect(() => { refresh().catch((e) => setError(String(e.message ?? e))); }, [address]);

    const overlays: Overlay[] = useMemo(() => {
        if (!market) return [];
        return [
            ...market.listings.map((l) => ({ rect: l.rect, color: "rgba(201, 168, 106, .35)" })),
            ...market.requests.map((r) => ({ rect: r.rect, color: "rgba(96, 140, 220, .30)" })),
        ];
    }, [market]);

    // clicking the canvas snaps to the deed containing the point
    const pick = (r: Rect) => {
        const d = deeds.find((x) =>
            x.rect.x0 <= r.x0 && r.x0 < x.rect.x1 && x.rect.y0 <= r.y0 && r.y0 < x.rect.y1);
        setPicked(d ?? null);
        setError(d ? null : "that pixel is unclaimed — buy it on the Claim page");
    };

    const pickedListing = picked && market?.listings.find((l) => l.name === picked.name);
    const pickedIsMine = picked != null && plots.some((p) => p.name === picked.name);

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
            await refresh();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    }

    const mine = (owner: string) => address != null && owner === address;

    return (
        <section>
            <div className="pagehead">
                <h2>Market</h2>
                <p className="tagline">
                    Gold areas are listed for sale, blue areas have open purchase requests.
                    Click any claimed plot to trade it: buy it if listed, list it if yours,
                    or post an offer for it. Partial buys of listed plots happen on the Claim page.
                </p>
            </div>

            <div className="frame">
                <CanvasBoard pixels={pixels} overlays={overlays} selection={picked?.rect ?? null} onSelect={pick} />
            </div>

            {picked && (
                <div className="actionbar order-panel">
                    <span><code>{picked.name}</code> ({area(picked.rect)} px)</span>
                    {pickedListing && (
                        <>
                            <span>listed at <b>{lovelaceToAda(pickedListing.pricePerPixel)} ₳/px</b> —
                                total <b>{lovelaceToAda(pickedListing.priceTotal)} ₳</b></span>
                            <button className="primary" disabled={busy != null || !isConnected}
                                onClick={() => void run("buy", () => buildMarketBuyTx(api!, address!, pickedListing))}>
                                buy whole plot
                            </button>
                            {mine(pickedListing.seller) && (
                                <button disabled={busy != null}
                                    onClick={() => void run("cancel", () => buildMarketCancelTx(api!, address!, pickedListing.utxoRef))}>
                                    cancel listing
                                </button>
                            )}
                        </>
                    )}
                    {!pickedListing && pickedIsMine && (
                        <>
                            <label>
                                price ₳/px <input type="number" min="0.1" step="0.1" value={priceAda}
                                    style={{ width: "5rem" }}
                                    onChange={(e) => setPriceAda(e.target.value)} />
                            </label>
                            <button className="primary" disabled={busy != null || !isConnected}
                                onClick={() => void run("list", () => buildMarketListTx(
                                    api!, address!, picked.name, BigInt(Math.round(Number(priceAda) * 1_000_000))))}>
                                list for sale
                            </button>
                        </>
                    )}
                    {!pickedListing && !pickedIsMine && (
                        <>
                            <label>
                                offer ₳ <input type="number" min="2" step="1" value={offerAda}
                                    style={{ width: "5rem" }}
                                    onChange={(e) => setOfferAda(e.target.value)} />
                            </label>
                            <button className="primary" disabled={busy != null || !isConnected}
                                onClick={() => void run("request", () => buildMarketRequestTx(
                                    api!, address!, picked.rect, BigInt(Math.round(Number(offerAda) * 1_000_000)),
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
                                <button className="primary" disabled={busy != null || !isConnected}
                                    onClick={() => void run("buy", () => buildMarketBuyTx(api!, address!, l))}>buy</button>
                                {mine(l.seller) && (
                                    <button disabled={busy != null}
                                        onClick={() => void run("cancel", () => buildMarketCancelTx(api!, address!, l.utxoRef))}>cancel</button>
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
        </section>
    );
}
