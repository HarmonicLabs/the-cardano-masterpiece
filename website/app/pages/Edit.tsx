import { useEffect, useMemo, useRef, useState } from "react";
import { useCardanoWallet } from "@harmoniclabs/use-cardano-wallet";
import {
    fetchPixels, fetchPlots, notifyPublish,
    type PixelEdit, type Plot, type Rect,
} from "../lib/api.ts";
import { CanvasBoard, type Overlay } from "../components/CanvasBoard.tsx";
import { NumField } from "../components/NumField.tsx";
import { loadImage, pixelify, saveSprite, loadSavedSprite, clearSavedSprite, type PlacedSprite } from "../lib/pixelify.ts";
import { EditPrebuilder, groupsKey, type EditGroup } from "../lib/editPrebuild.ts";
import { buildCarveTx, buildCatchupCommitTxs } from "../lib/txbuild.ts";
import { staleLeaves } from "../lib/masterpieceRoot.ts";
import { signAndSubmit, signAndSubmitAll } from "../lib/sign.ts";

const LINE = 1008;
const ROWS_PER_LEAF = 12;   // 84 leaves x 12 rows (matches deployed geometry)
const W = 1008, H = 1008;

const area = (r: Rect): number => (r.x1 - r.x0) * (r.y1 - r.y0);
const contains = (o: Rect, i: Rect): boolean =>
    o.x0 <= i.x0 && i.x1 <= o.x1 && o.y0 <= i.y0 && i.y1 <= o.y1;

export function Edit() {
    const { isConnected, address, api } = useCardanoWallet();
    const [pixels, setPixels] = useState<Uint8Array | null>(null);
    const [plots, setPlots] = useState<Plot[]>([]);
    const [mode, setMode] = useState<"paint" | "carve">("paint");
    // paint mode: a placed, resizable image (no hand-drawing)
    const [srcImage, setSrcImage] = useState<HTMLImageElement | null>(null);
    const [spriteW, setSpriteW] = useState(64);
    const [sprite, setSprite] = useState<PlacedSprite | null>(null);
    // carve mode: a sub-rect selection inside one owned deed
    const [sel, setSel] = useState<Rect | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [results, setResults] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [stale, setStale] = useState(0);   // leaves ahead of the committed root
    const [resumed, setResumed] = useState(false);   // restored a pending edit
    const fileRef = useRef<HTMLInputElement>(null);

    // Resume a pending (offchain-only) edit after a refresh or a partial batch:
    // the placed image is persisted locally and restored here. It's cleared only
    // once the whole edit+commit batch has gone through (or the user discards).
    useEffect(() => {
        const saved = loadSavedSprite();
        if (saved) { setSprite(saved); setResumed(true); }
    }, []);
    useEffect(() => {   // debounced so dragging a large image doesn't re-serialize every frame
        if (!sprite) return;
        const t = setTimeout(() => saveSprite(sprite), 400);
        return () => clearTimeout(t);
    }, [sprite]);

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
            const hashes = await signAndSubmitAll(api, txs, setBusy);
            setResults(hashes);
            setBusy("waiting for confirmation…");
            await new Promise((r) => setTimeout(r, 30_000));
            await refresh();
            void notifyPublish();   // pin the freshly-committed image (best-effort)
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    }

    // (re)pixelify the imported image when its source or target size changes
    useEffect(() => {
        if (!srcImage) return;
        const s = pixelify(srcImage, spriteW);
        setSprite((prev) => ({
            ...s,
            x: Math.min(prev?.x ?? Math.floor((W - s.w) / 2), W - s.w),
            y: Math.min(prev?.y ?? Math.floor((H - s.h) / 2), H - s.h),
        }));
    }, [srcImage, spriteW]);

    const inPlot = (x: number, y: number): boolean =>
        plots.some((p) => p.rect.x0 <= x && x < p.rect.x1 && p.rect.y0 <= y && y < p.rect.y1);

    // pixel edits derived from the placed image, CLIPPED to owned plots and to
    // the NOT-YET-ONCHAIN delta: only opaque pixels that land inside a plot AND
    // differ from the current on-chain canvas become edits. So on resume, pixels
    // already painted on-chain drop out and only the pending work is rebuilt.
    const { edits, clipped } = useMemo(() => {
        const m = new Map<number, number>();
        let clip = 0;
        if (sprite) {
            for (let sy = 0; sy < sprite.h; sy++) {
                for (let sx = 0; sx < sprite.w; sx++) {
                    const i = sy * sprite.w + sx;
                    if (!sprite.opaque[i]) continue;
                    const x = sprite.x + sx, y = sprite.y + sy;
                    if (!inPlot(x, y)) { clip++; continue; }
                    const v = sprite.pixels[i];
                    if (pixels && pixels[y * LINE + x] === v) continue;   // already on-chain
                    m.set(y * LINE + x, v);
                }
            }
        }
        return { edits: m, clipped: clip };
    }, [sprite, plots, pixels]);

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
        loadImage(f).then(setSrcImage).catch((e) => setError(String((e as Error).message ?? e)));
    }
    function dropImage() {
        setSrcImage(null); setSprite(null); setResumed(false); clearSavedSprite();
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
            const hashes = await signAndSubmitAll(api, txs, setBusy);
            setResults(hashes);
            dropImage();
            setBusy("refreshing canvas…");
            await new Promise((r) => setTimeout(r, 30_000));
            await refresh();
            void notifyPublish();   // pin the freshly-committed image (best-effort)
        } catch (e) {
            setError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
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
            setBusy(null);
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
            <div className="pagehead">
                <h2>Studio</h2>
                <p className="tagline">
                    Your plots are outlined in blue. <b>Paint</b>: import an image, size it, and
                    drag it onto your plots — pixels outside them are ignored.
                    <b> Carve</b>: select a region of one plot to split its ownership NFT into
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
                        onClick={() => { setMode("carve"); dropImage(); }}>carve</button>
                </div>

                {mode === "paint" && <>
                    <label className="filebtn">
                        <input ref={fileRef} type="file" accept="image/*"
                            onChange={(e) => { onFile(e.target.files?.[0]); }} />
                        {srcImage ? "replace image" : "import image…"}
                    </label>
                    {sprite && <>
                        <label>
                            size <input type="range" min={2} max={1008} step={1} value={spriteW}
                                onChange={(e) => setSpriteW(Number(e.target.value))} />
                            <input type="number" min={2} max={1008} value={spriteW} style={{ width: "4.6rem" }}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isFinite(v)) setSpriteW(Math.max(2, Math.min(1008, Math.round(v))));
                                }} />
                            <code>{sprite.w}×{sprite.h}</code>
                        </label>
                        <label className="coords">
                            at
                            <NumField value={sprite.x} min={0} max={W} width="4.4rem"
                                commit={(raw) => { const v = Math.round(Number(raw)); if (Number.isFinite(v)) setSprite((s) => s ? { ...s, x: Math.max(0, Math.min(W - s.w, v)) } : s); }} />
                            <NumField value={sprite.y} min={0} max={H} width="4.4rem"
                                commit={(raw) => { const v = Math.round(Number(raw)); if (Number.isFinite(v)) setSprite((s) => s ? { ...s, y: Math.max(0, Math.min(H - s.h, v)) } : s); }} />
                        </label>
                        <span>
                            {edits.size} pixel{edits.size === 1 ? "" : "s"}{edits.size > 0 ? " left" : ""}
                            {resumed && <span className="ok" title="restored from a refresh / partial batch"> · resumed</span>}
                            {leafGroups.size > 1 && ` · ${leafGroups.size} txs`}
                            {clipped > 0 && <span className="muted"> ({clipped} outside your plots ignored)</span>}
                        </span>
                        {edits.size > 0 && (
                            <span className={prebuilt ? "ok" : "muted"} title="txs are pre-built in the background as you edit">
                                {prebuilt ? `✓ ${groups.length} tx${groups.length === 1 ? "" : "s"} ready` : "preparing txs…"}
                            </span>
                        )}
                        <button onClick={dropImage} disabled={busy != null}>remove image</button>
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
                    sprite={mode === "paint" ? sprite : null}
                    spriteValid={clipped === 0}
                    onSpriteMove={mode === "paint" && sprite
                        ? (x, y) => setSprite((s) => (s ? { ...s, x, y } : s)) : undefined}
                    onSpriteResize={mode === "paint" && sprite ? (w) => setSpriteW(w) : undefined}
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
