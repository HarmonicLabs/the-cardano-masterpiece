import { useEffect, useMemo, useRef, useState } from "react";
import { useCardanoWallet } from "@harmoniclabs/use-cardano-wallet";
import {
    fetchPixels, fetchPlots, notifyPublish,
    type PixelEdit, type Plot, type Rect,
} from "../lib/api.ts";
import { CanvasBoard, type Overlay } from "../components/CanvasBoard.tsx";
import { NumField } from "../components/NumField.tsx";
import {
    loadImage, pixelify, spriteToCanvas, loadSavedSprite, clearSavedSprite,
    saveSprites, loadSavedSprites, clearSprites, type PlacedSprite,
} from "../lib/pixelify.ts";
import { EditPrebuilder, groupsKey, type EditGroup } from "../lib/editPrebuild.ts";
import { buildCarveTx, buildCatchupCommitTxs } from "../lib/txbuild.ts";
import { staleLeaves } from "../lib/masterpieceRoot.ts";
import { signAndSubmit, signAndSubmitAll, type SignProgress } from "../lib/sign.ts";
import { TxProgress } from "../components/TxProgress.tsx";

const LINE = 1008;
const ROWS_PER_LEAF = 12;   // 84 leaves x 12 rows (matches deployed geometry)
const W = 1008, H = 1008;

const area = (r: Rect): number => (r.x1 - r.x0) * (r.y1 - r.y0);
const contains = (o: Rect, i: Rect): boolean =>
    o.x0 <= i.x0 && i.x1 <= o.x1 && o.y0 <= i.y0 && i.y1 <= o.y1;

export function Edit() {
    const { isConnected, address, api, connectedWallet } = useCardanoWallet();
    const [pixels, setPixels] = useState<Uint8Array | null>(null);
    const [plots, setPlots] = useState<Plot[]>([]);
    const [mode, setMode] = useState<"paint" | "carve">("paint");
    // paint mode: one or more placed, resizable images (no hand-drawing)
    const [sprites, setSprites] = useState<PlacedSprite[]>([]);
    const [activeId, setActiveId] = useState<number | null>(null);
    const idRef = useRef(0);                                          // next sprite id
    const srcRef = useRef<Map<number, HTMLImageElement | HTMLCanvasElement>>(new Map());  // per-sprite source, for resize
    const active = sprites.find((s) => s.id === activeId) ?? null;
    // carve mode: a sub-rect selection inside one owned deed
    const [sel, setSel] = useState<Rect | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [results, setResults] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [stale, setStale] = useState(0);   // leaves ahead of the committed root
    const [resumed, setResumed] = useState(false);   // restored a pending edit
    const [signProg, setSignProg] = useState<SignProgress | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    // Resume a pending (offchain-only) edit after a refresh or a partial batch:
    // the placed image is persisted locally and restored here. It's cleared only
    // once the whole edit+commit batch has gone through (or the user discards).
    useEffect(() => {
        let arr = loadSavedSprites();
        if (arr.length === 0) {   // seed from a single image handed over by the Claim page
            const one = loadSavedSprite();
            if (one) { arr = [one]; clearSavedSprite(); }
        }
        if (arr.length === 0) return;
        const withIds = arr.map((s) => ({ ...s, id: s.id ?? idRef.current++ }));
        idRef.current = withIds.reduce((m, s) => Math.max(m, (s.id ?? 0) + 1), idRef.current);
        setSprites(withIds);
        // rebuild a resize source from each restored bitmap (the original image
        // isn't persisted), so resumed images stay resizable
        for (const s of withIds) if (s.id != null) srcRef.current.set(s.id, spriteToCanvas(s));
        setActiveId(withIds[withIds.length - 1].id ?? null);
        setResumed(true);
    }, []);
    useEffect(() => {   // debounced so dragging doesn't re-serialize every frame
        if (sprites.length === 0) return;
        const t = setTimeout(() => saveSprites(sprites), 400);
        return () => clearTimeout(t);
    }, [sprites]);

    const refresh = async () => {
        setPixels(await fetchPixels());
        if (address) setPlots(await fetchPlots(address));
        staleLeaves().then((s) => setStale(s.length)).catch(() => setStale(0));
    };
    useEffect(() => { refresh().catch((e) => setError(String(e.message ?? e))); }, [address]);

    // sync any leaves whose art is ahead of the on-chain committed image
    async function catchUp() {
        if (!api || !address) return;
        setError(null); setResults([]);
        try {
            setBusy("building commit transactions…");
            const txs = await buildCatchupCommitTxs(api, address);
            const hashes = await signAndSubmitAll(api, txs, setSignProg, connectedWallet?.name);
            setResults(hashes);
            setBusy("waiting for confirmation…");
            await new Promise((r) => setTimeout(r, 30_000));
            await refresh();
            void notifyPublish();   // pin the freshly-committed image (best-effort)
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null); setSignProg(null);
        }
    }

    const inPlot = (x: number, y: number): boolean =>
        plots.some((p) => p.rect.x0 <= x && x < p.rect.x1 && p.rect.y0 <= y && y < p.rect.y1);

    // pixel edits derived from the placed image, CLIPPED to owned plots and to
    // the NOT-YET-ONCHAIN delta: only opaque pixels that land inside a plot AND
    // differ from the current on-chain canvas become edits. So on resume, pixels
    // already painted on-chain drop out and only the pending work is rebuilt.
    const { edits, clipped } = useMemo(() => {
        const m = new Map<number, number>();
        let clip = 0;
        for (const sprite of sprites) {   // draw order: later images paint over earlier
            for (let sy = 0; sy < sprite.h; sy++) {
                for (let sx = 0; sx < sprite.w; sx++) {
                    const i = sy * sprite.w + sx;
                    if (!sprite.opaque[i]) continue;
                    const x = sprite.x + sx, y = sprite.y + sy;
                    if (!inPlot(x, y)) { clip++; continue; }
                    const off = y * LINE + x;
                    const v = sprite.pixels[i];
                    // already on-chain: no edit here (and drop any earlier sprite's edit it covers)
                    if (pixels && pixels[off] === v) { m.delete(off); continue; }
                    m.set(off, v);
                }
            }
        }
        return { edits: m, clipped: clip };
    }, [sprites, plots, pixels]);

    // group edits by leaf (one tx per leaf)
    const leafGroups = useMemo(() => {
        const g = new Map<number, PixelEdit[]>();
        for (const [off, v] of edits) {
            const x = off % LINE, y = Math.floor(off / LINE);
            const leaf = Math.floor(y / ROWS_PER_LEAF);
            if (!g.has(leaf)) g.set(leaf, []);
            g.get(leaf)!.push({ x, y, v });
        }
        return g;
    }, [edits]);
    const groups: EditGroup[] = useMemo(
        () => [...leafGroups].map(([leafIdx, pixels]) => ({ leafIdx, pixels })), [leafGroups]);

    // prebuild the edit txs in a worker as the image is moved/resized
    const prebuilderRef = useRef<EditPrebuilder | null>(null);
    const [readyKey, setReadyKey] = useState<string | null>(null);
    useEffect(() => {
        const pb = new EditPrebuilder((key) => setReadyKey(key));
        prebuilderRef.current = pb;
        return () => { pb.dispose(); prebuilderRef.current = null; };
    }, []);
    useEffect(() => {
        if (!api || !address || groups.length === 0) return;
        const t = setTimeout(() => prebuilderRef.current?.prefetch(api, address, groups), 500);
        return () => clearTimeout(t);
    }, [groups, api, address]);
    const prebuilt = groups.length > 0 && readyKey === groupsKey(groups);

    // carve target: the selection must sit inside exactly one owned deed and be
    // a proper sub-rect of it
    const carvePlot = useMemo(
        () => (sel ? plots.find((p) => contains(p.rect, sel)) : undefined), [sel, plots]);
    const carveValid = Boolean(sel && carvePlot && area(sel) > 0 && area(sel) < area(carvePlot!.rect));

    // manual coordinate entry for the carve selection: edit one corner at a
    // time, seeding from the first plot when there is no selection yet
    function setSelField(field: "x0" | "y0" | "x1" | "y1", raw: string) {
        const v = Math.round(Number(raw));
        if (!Number.isFinite(v)) return;
        setSel((cur) => {
            const b = cur ?? { x0: plots[0].rect.x0, y0: plots[0].rect.y0, x1: plots[0].rect.x0 + 2, y1: plots[0].rect.y0 + 2 };
            const lim = field[0] === "x" ? W : H;
            return { ...b, [field]: Math.max(0, Math.min(lim, v)) };
        });
    }

    const overlays: Overlay[] = useMemo(
        () => plots.map((p) => ({
            rect: p.rect,
            color: mode === "carve" && carvePlot?.name === p.name
                ? "rgba(201, 168, 106, .35)" : "rgba(60, 130, 240, .20)",
        })), [plots, mode, carvePlot]);

    function onFile(f: File | undefined) {
        if (!f) return;
        setError(null); setResumed(false);
        loadImage(f).then((img) => {
            const id = idRef.current++;
            srcRef.current.set(id, img);
            const s = pixelify(img, 64);
            setSprites((arr) => {   // stagger placement so stacked imports don't perfectly overlap
                const off = (arr.length % 6) * 12;
                const x = Math.max(0, Math.min(W - s.w, Math.floor((W - s.w) / 2) + off));
                const y = Math.max(0, Math.min(H - s.h, Math.floor((H - s.h) / 2) + off));
                return [...arr, { ...s, x, y, id }];
            });
            setActiveId(id);
        }).catch((e) => setError(String((e as Error).message ?? e)));
        if (fileRef.current) fileRef.current.value = "";   // allow re-importing the same file
    }
    function moveActive(x: number, y: number) {
        setSprites((arr) => arr.map((s) => (s.id === activeId ? { ...s, x, y } : s)));
    }
    function resizeActive(w: number) {
        if (activeId == null) return;
        let src = srcRef.current.get(activeId);
        if (!src) {   // rebuild a resize source from the current bitmap (resumed image)
            const sp = sprites.find((s) => s.id === activeId);
            if (!sp) return;
            src = spriteToCanvas(sp);
            srcRef.current.set(activeId, src);
        }
        const s = pixelify(src, Math.max(2, Math.min(1008, Math.round(w))));
        setSprites((arr) => arr.map((sp) => (sp.id === activeId
            ? { ...s, id: activeId, x: Math.max(0, Math.min(W - s.w, sp.x)), y: Math.max(0, Math.min(H - s.h, sp.y)) }
            : sp)));
    }
    function removeSprite(id: number) {
        srcRef.current.delete(id);
        const next = sprites.filter((s) => s.id !== id);
        setSprites(next);
        if (activeId === id) setActiveId(next.length ? next[next.length - 1].id ?? null : null);
        if (next.length === 0) { clearSprites(); setResumed(false); }
    }
    function clearAll() {
        setSprites([]); setActiveId(null); setResumed(false);
        srcRef.current.clear(); clearSprites(); clearSavedSprite();
        if (fileRef.current) fileRef.current.value = "";
    }

    async function commit() {
        if (!api || !address || !prebuilderRef.current || groups.length === 0) return;
        setError(null); setResults([]);
        try {
            // reuse the worker-prebuilt chain when ready; else build it now
            setBusy(prebuilt ? "finalizing transactions…" : "building transaction(s)…");
            const txs = await prebuilderRef.current.request(api, address, groups);
            // one chained batch: single CIP-103 prompt when supported
            const hashes = await signAndSubmitAll(api, txs, setSignProg, connectedWallet?.name);
            setResults(hashes);
            clearAll();
            setBusy("refreshing canvas…");
            await new Promise((r) => setTimeout(r, 30_000));
            await refresh();
            void notifyPublish();   // pin the freshly-committed image (best-effort)
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null); setSignProg(null);
        }
    }

    async function carve() {
        if (!api || !address || !sel || !carvePlot || !carveValid) return;
        setError(null); setResults([]);
        try {
            setBusy("building transaction…");
            const tx = await buildCarveTx(api, address, carvePlot.name, sel);
            setBusy("waiting for wallet signature…");
            const hash = await signAndSubmit(api, tx);
            setResults([hash]);
            setSel(null);
            setBusy("waiting for confirmation…");
            await new Promise((r) => setTimeout(r, 30_000));
            await refresh();
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null); setSignProg(null);
        }
    }

    if (!isConnected) return (
        <section>
            <div className="pagehead">
                <h2>Studio</h2>
                <p className="tagline">Connect a wallet to edit the plots you own.</p>
            </div>
        </section>
    );
    if (plots.length === 0) return (
        <section>
            <div className="pagehead">
                <h2>Studio</h2>
                <p className="tagline">
                    This wallet owns no plots yet — claim one first on the “Claim” page.
                </p>
            </div>
        </section>
    );

    return (
        <section>
            <TxProgress p={signProg} onClose={() => setSignProg(null)} />
            <div className="pagehead">
                <h2>Studio</h2>
                <p className="tagline">
                    Your plots are outlined in blue. <b>Paint</b>: import one or more images, size and
                    drag each onto your plots (click an image to select it) — pixels outside them are ignored.
                    <b> Carve</b>: select a region of one plot to split its stewardship NFT into
                    separate deeds you can sell or transfer.
                </p>
            </div>

            {stale > 0 && (
                <div className="actionbar">
                    <span className="muted">
                        {stale} leaf{stale === 1 ? "" : "s"} edited but not yet published to the on-chain image
                    </span>
                    <button className="primary" disabled={busy != null} onClick={() => void catchUp()}>
                        {busy ?? `catch up (${stale} commit${stale === 1 ? "" : "s"})`}
                    </button>
                </div>
            )}

            <div className="actionbar">
                <div className="modeswitch">
                    <button className={mode === "paint" ? "primary" : ""}
                        onClick={() => { setMode("paint"); setSel(null); }}>paint</button>
                    <button className={mode === "carve" ? "primary" : ""}
                        onClick={() => { setMode("carve"); clearAll(); }}>carve</button>
                </div>

                {mode === "paint" && <>
                    <label className="filebtn">
                        <input ref={fileRef} type="file" accept="image/*"
                            onChange={(e) => { onFile(e.target.files?.[0]); }} />
                        add image…
                    </label>
                    {sprites.length > 0 && <>
                        <div className="spritechips">
                            {sprites.map((s, i) => (
                                <span key={s.id} className={`spritechip${s.id === activeId ? " active" : ""}`}>
                                    <button title="select this image" onClick={() => setActiveId(s.id ?? null)}>img {i + 1}</button>
                                    <button className="x" title="remove this image" onClick={() => removeSprite(s.id!)}>×</button>
                                </span>
                            ))}
                        </div>
                        {active && <>
                            <label>
                                size <input type="range" min={2} max={1008} step={1} value={active.w}
                                    onChange={(e) => resizeActive(Number(e.target.value))} />
                                <NumField value={active.w} min={2} max={1008} width="4.6rem"
                                    commit={(raw) => { const v = Math.round(Number(raw)); if (Number.isFinite(v)) resizeActive(Math.max(2, Math.min(1008, v))); }} />
                                <code>×{active.h}</code>
                            </label>
                            <label className="coords">
                                at
                                <NumField value={active.x} min={0} max={W} width="4.4rem"
                                    commit={(raw) => { const v = Math.round(Number(raw)); if (Number.isFinite(v)) moveActive(Math.max(0, Math.min(W - active.w, v)), active.y); }} />
                                <NumField value={active.y} min={0} max={H} width="4.4rem"
                                    commit={(raw) => { const v = Math.round(Number(raw)); if (Number.isFinite(v)) moveActive(active.x, Math.max(0, Math.min(H - active.h, v))); }} />
                            </label>
                        </>}
                        <span>
                            {edits.size} pixel{edits.size === 1 ? "" : "s"}{edits.size > 0 ? " left" : ""}
                            {sprites.length > 1 && ` · ${sprites.length} images`}
                            {resumed && <span className="ok" title="restored from a refresh / partial batch"> · resumed</span>}
                            {leafGroups.size > 1 && ` · ${leafGroups.size} txs`}
                            {clipped > 0 && <span className="muted"> ({clipped} outside your plots ignored)</span>}
                        </span>
                        {edits.size > 0 && (
                            <span className={prebuilt ? "ok" : "muted"} title="txs are pre-built in the background as you edit">
                                {prebuilt ? `✓ ${groups.length} tx${groups.length === 1 ? "" : "s"} ready` : "preparing txs…"}
                            </span>
                        )}
                        <button onClick={clearAll} disabled={busy != null}>clear all</button>
                        <button className="primary" disabled={edits.size === 0 || busy != null}
                            onClick={() => void commit()}>
                            {busy ?? "paint"}
                        </button>
                    </>}
                </>}

                {mode === "carve" && <>
                    <label className="coords">
                        <NumField value={sel?.x0 ?? ""} placeholder="x0" min={0} max={W} width="3.8rem" commit={(r) => setSelField("x0", r)} />
                        <NumField value={sel?.y0 ?? ""} placeholder="y0" min={0} max={H} width="3.8rem" commit={(r) => setSelField("y0", r)} />
                        →
                        <NumField value={sel?.x1 ?? ""} placeholder="x1" min={0} max={W} width="3.8rem" commit={(r) => setSelField("x1", r)} />
                        <NumField value={sel?.y1 ?? ""} placeholder="y1" min={0} max={H} width="3.8rem" commit={(r) => setSelField("y1", r)} />
                    </label>
                    {sel
                        ? <span>
                            ({area(sel)} px)
                            {(sel.x1 <= sel.x0 || sel.y1 <= sel.y0) && <span className="err"> — invalid rectangle</span>}
                            {sel.x1 > sel.x0 && sel.y1 > sel.y0 && !carvePlot && <span className="err"> — not inside a single deed you own</span>}
                            {carvePlot && !carveValid && <span className="err"> — that is the whole deed</span>}
                        </span>
                        : <span className="muted">drag on the canvas, or type coordinates, inside one of your plots</span>}
                    {sel && <button onClick={() => setSel(null)} disabled={busy != null}>clear</button>}
                    <button className="primary" disabled={!carveValid || busy != null}
                        onClick={() => void carve()}>
                        {busy ?? "carve"}
                    </button>
                </>}
            </div>

            <div className="frame">
                <CanvasBoard
                    pixels={pixels}
                    overlays={overlays}
                    selection={mode === "carve" ? sel : null}
                    onSelect={mode === "carve" ? (r) => setSel(r) : undefined}
                    sprite={mode === "paint" ? active : null}
                    bgSprites={mode === "paint" ? sprites.filter((s) => s.id !== activeId) : []}
                    onSpriteSelect={mode === "paint" ? (id) => setActiveId(id) : undefined}
                    spriteValid={clipped === 0}
                    onSpriteMove={mode === "paint" && active ? (x, y) => moveActive(x, y) : undefined}
                    onSpriteResize={mode === "paint" && active ? (w) => resizeActive(w) : undefined}
                />
            </div>

            <div className="stats">
                {plots.map((p) => <span key={p.name}><code>{p.name}</code></span>)}
            </div>
            {results.map((h) => <p key={h} className="ok">submitted <code>{h}</code></p>)}
            {error && <p className="err">{error}</p>}
        </section>
    );
}
