import { useState } from "react";

/**
 * A number input that only commits on blur / Enter — so you can type a value
 * freely (including intermediate/empty states) without it snapping on each
 * keystroke. Shared by the Claim and Studio pages for exact coordinate entry.
 */
export function NumField(props: {
    value: number | string; commit: (raw: string) => void;
    min?: number; max?: number; step?: number; placeholder?: string; width?: string;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <input
            type="number"
            min={props.min} max={props.max} step={props.step ?? 1}
            placeholder={props.placeholder}
            style={props.width ? { width: props.width } : undefined}
            value={draft ?? String(props.value)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (draft !== null) { props.commit(draft); setDraft(null); } }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
    );
}
