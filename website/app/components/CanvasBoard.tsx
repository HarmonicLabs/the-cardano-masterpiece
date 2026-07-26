import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import type { Rect } from "../lib/api.ts";
import { spriteToCanvas, type PlacedSprite } from "../lib/pixelify.ts";
import { indicesToImageData } from "../lib/palette.ts";

export interface Overlay { rect: Rect; color: string; }

interface Props {
    pixels: Uint8Array | null;      // 1008*1008 palette indices
    overlays?: Overlay[];           // translucent rectangles on top
    selection?: Rect | null;        // highlighted selection
    /** drag-selection callback (enables selection interaction) */
    onSelect?: (r: Rect) => void;
    /** imported-image preview; when present, dragging MOVES the sprite */
    sprite?: PlacedSprite | null;
    spriteValid?: boolean;
    onSpriteMove?: (x: number, y: number) => void;
}

const W = 1008;   // canvas width
const H = 1008;   // canvas height (84 leaves x 12 rows)
const MIN_SCALE = 1;
const MAX_SCALE = 32;

interface View { scale: number; ox: number; oy: number; }

const clampView = (v: View): View => {
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale));
    return {
        scale,
        ox: Math.max(W - W * scale, Math.min(0, v.ox)),
        oy: Math.max(H - H * scale, Math.min(0, v.oy)),
    };
};

/**
 * The full canvas: chain pixels + overlays + selection/sprite interactions.
 * Always zoomable: wheel (anchored at the cursor) or the +/- controls;
 * drag pans when no tool is active (or with the hand toggle / middle button).
 */
export function CanvasBoard({
    pixels, overlays = [], selection, onSelect,
    sprite, spriteValid = true, onSpriteMove,
}: Props) {
    const cvRef = useRef<HTMLCanvasElement>(null);
    const dragRef = useRef<{ x: number; y: number } | null>(null);
    const grabRef = useRef<{ dx: number; dy: number } | null>(null);
    const panRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

    const [view, setView] = useState<View>({ scale: 1, ox: 0, oy: 0 });
    const [handTool, setHandTool] = useState(false);

    const hasTool = Boolean(onSelect || (sprite && onSpriteMove));
    const panning = handTool || !hasTool;

    // chain pixels on an offscreen canvas so the visible one can transform
    const baseCv = useMemo(() => {
        const cv = document.createElement("canvas");
        cv.width = W; cv.height = H;
        return cv;
    }, []);
    useEffect(() => {
        const ctx = baseCv.getContext("2d")!;
        if (pixels) {
            const img = ctx.createImageData(W, H);
            indicesToImageData(img.data, pixels);
            ctx.putImageData(img, 0, 0);
        } else {
            ctx.fillStyle = "#ddd";
            ctx.fillRect(0, 0, W, H);
        }
    }, [pixels, baseCv]);

    const spriteCv = useMemo(
        () => (sprite ? spriteToCanvas(sprite) : null),
        // re-render only when the sprite CONTENT changes, not its position
        [sprite?.pixels, sprite?.opaque, sprite?.w, sprite?.h]
    );

    // draw with the current view transform
    useEffect(() => {
        const cv = cvRef.current;
        if (!cv) return;
        const ctx = cv.getContext("2d")!;
        const { scale, ox, oy } = view;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.setTransform(scale, 0, 0, scale, ox, oy);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(baseCv, 0, 0);
        for (const ov of overlays) {
            const { x0, y0, x1, y1 } = ov.rect;
            ctx.fillStyle = ov.color;
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
        const lw = 2 / scale; // constant on-screen line width
        if (sprite && spriteCv) {
            ctx.globalAlpha = 0.9;
            ctx.drawImage(spriteCv, sprite.x, sprite.y);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = spriteValid ? "rgb(50, 190, 100)" : "rgb(230, 70, 70)";
            ctx.lineWidth = lw;
            ctx.strokeRect(sprite.x + lw / 2, sprite.y + lw / 2, sprite.w - lw, sprite.h - lw);
        }
        if (selection && !sprite) {
            const { x0, y0, x1, y1 } = selection;
            ctx.fillStyle = "rgba(80, 160, 255, .35)";
            ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
            ctx.strokeStyle = "rgb(50, 120, 230)";
            ctx.lineWidth = lw;
            ctx.strokeRect(x0 + lw / 2, y0 + lw / 2, x1 - x0 - lw, y1 - y0 - lw);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }, [baseCv, overlays, selection, sprite, spriteCv, spriteValid, view]);

    // pointer position in backing-canvas coordinates (before the view transform)
    const toCanvas = useCallback((e: { clientX: number; clientY: number }) => {
        const cv = cvRef.current!;
        const r = cv.getBoundingClientRect();
        return {
            cx: ((e.clientX - r.left) / r.width) * W,
            cy: ((e.clientY - r.top) / r.height) * H,
        };
    }, []);
    // ...and in world (image pixel) coordinates
    const toPixel = useCallback((e: { clientX: number; clientY: number }) => {
        const { cx, cy } = toCanvas(e);
        const x = Math.floor((cx - view.ox) / view.scale);
        const y = Math.floor((cy - view.oy) / view.scale);
        return { x: Math.max(0, Math.min(W - 1, x)), y: Math.max(0, Math.min(H - 1, y)) };
    }, [toCanvas, view]);

    const zoomAt = useCallback((factor: number, anchor?: { cx: number; cy: number }) => {
        setView((v) => {
            const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
            if (scale === v.scale) return v;
            const a = anchor ?? { cx: W / 2, cy: H / 2 };
            // keep the world point under the anchor fixed
            const wx = (a.cx - v.ox) / v.scale;
            const wy = (a.cy - v.oy) / v.scale;
            return clampView({ scale, ox: a.cx - wx * scale, oy: a.cy - wy * scale });
        });
    }, []);

    const emitSelect = useCallback((a: { x: number; y: number }, b: { x: number; y: number }) => {
        onSelect?.({
            x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
            x1: Math.max(a.x, b.x) + 1, y1: Math.max(a.y, b.y) + 1,
        });
    }, [onSelect]);

    const moveSpriteTo = useCallback((p: { x: number; y: number }) => {
        if (!sprite || !onSpriteMove) return;
        const grab = grabRef.current ?? { dx: Math.floor(sprite.w / 2), dy: Math.floor(sprite.h / 2) };
        const x = Math.max(0, Math.min(W - sprite.w, p.x - grab.dx));
        const y = Math.max(0, Math.min(H - sprite.h, p.y - grab.dy));
        onSpriteMove(x, y);
    }, [sprite, onSpriteMove]);

    // non-passive wheel listener (React's onWheel can't preventDefault)
    useEffect(() => {
        const cv = cvRef.current;
        if (!cv) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            zoomAt(Math.exp(-e.deltaY * 0.0015), toCanvas(e));
        };
        cv.addEventListener("wheel", onWheel, { passive: false });
        return () => cv.removeEventListener("wheel", onWheel);
    }, [zoomAt, toCanvas]);

    const zoomPct = Math.round(view.scale * 100);

    return (
        <div className="boardwrap">
            <div className="zoombar">
                {hasTool && (
                    <button
                        className={handTool ? "active" : ""}
                        title="pan tool (drag to move around)"
                        onClick={() => setHandTool(!handTool)}
                    >✋</button>
                )}
                <button title="zoom in" onClick={() => zoomAt(1.5)}>+</button>
                <span className="zoomlvl">{zoomPct}%</span>
                <button title="zoom out" onClick={() => zoomAt(1 / 1.5)}>−</button>
                <button title="reset view" disabled={view.scale === 1}
                    onClick={() => setView({ scale: 1, ox: 0, oy: 0 })}>⤢</button>
            </div>
            <canvas
                ref={cvRef}
                width={W}
                height={H}
                className="board"
                style={{
                    cursor: panning ? "grab"
                        : sprite && onSpriteMove ? "grab"
                        : onSelect ? "crosshair" : "default",
                    touchAction: "none",
                }}
                onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const pan = panning || e.button === 1;
                    if (pan) {
                        panRef.current = { px: e.clientX, py: e.clientY, ox: view.ox, oy: view.oy };
                        return;
                    }
                    const p = toPixel(e);
                    if (sprite && onSpriteMove) {
                        const inside = p.x >= sprite.x && p.x < sprite.x + sprite.w
                            && p.y >= sprite.y && p.y < sprite.y + sprite.h;
                        grabRef.current = inside
                            ? { dx: p.x - sprite.x, dy: p.y - sprite.y }
                            : { dx: Math.floor(sprite.w / 2), dy: Math.floor(sprite.h / 2) };
                        dragRef.current = p;
                        moveSpriteTo(p);
                    } else if (onSelect) {
                        dragRef.current = p;
                        emitSelect(p, p);
                    }
                }}
                onPointerMove={(e) => {
                    if (panRef.current) {
                        const cv = cvRef.current!;
                        const r = cv.getBoundingClientRect();
                        const kx = W / r.width, ky = H / r.height; // css px -> canvas px
                        setView(clampView({
                            scale: view.scale,
                            ox: panRef.current.ox + (e.clientX - panRef.current.px) * kx,
                            oy: panRef.current.oy + (e.clientY - panRef.current.py) * ky,
                        }));
                        return;
                    }
                    if (!dragRef.current) return;
                    const p = toPixel(e);
                    if (sprite && onSpriteMove) moveSpriteTo(p);
                    else if (onSelect) emitSelect(dragRef.current, p);
                }}
                onPointerUp={() => { dragRef.current = null; grabRef.current = null; panRef.current = null; }}
            />
        </div>
    );
}
