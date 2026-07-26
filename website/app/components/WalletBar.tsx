import { useEffect, useState } from "react";
import { useCardanoWallet } from "@harmoniclabs/use-cardano-wallet";

// CIP-30 getBalance() returns CBOR of a `Value`:
//   pure ADA (no native tokens) -> a bare CBOR uint (the coin)
//   ADA + native tokens         -> an array [coin, multiasset]
// use-cardano-wallet@0.0.3's parseBalance only handles the array form and
// returns 0 for the bare-uint case, so freshly-funded (token-less) wallets
// show "0 ₳". This reads the coin from BOTH encodings.
function lovelaceFromBalanceCbor(hex: string): bigint {
    const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    let pos = 0;
    const major = bytes[pos] >> 5;
    if (major === 4) pos += 1;          // array header (e.g. 0x82) -> coin is the next item
    else if (major !== 0) throw new Error("unexpected balance CBOR");
    const ai = bytes[pos] & 0x1f; pos += 1;
    if (ai < 24) return BigInt(ai);
    const len = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : 0;
    if (len === 0) throw new Error("bad coin uint");
    let n = 0n;
    for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(bytes[pos + i]);
    return n;
}

/** connect / disconnect UI; wallet state comes from the shared zustand store */
export function WalletBar() {
    const {
        isConnected, isConnecting, detectedWallets,
        connectedWallet, address, lovelaceBalance, api,
        connect, disconnect,
    } = useCardanoWallet({ autoConnect: true });
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // our own balance read (works around the library's pure-ADA bug)
    const [lovelace, setLovelace] = useState<bigint | null>(null);

    useEffect(() => {
        let live = true;
        if (!isConnected || !api) { setLovelace(null); return; }
        api.getBalance()
            .then((cbor) => { if (live) setLovelace(lovelaceFromBalanceCbor(cbor)); })
            .catch(() => { if (live) setLovelace(null); });   // fall back to lovelaceBalance
        return () => { live = false; };
    }, [isConnected, api, address]);

    // prefer our read; fall back to the hook's value if ours failed
    const shownLovelace = lovelace ?? (lovelaceBalance != null ? BigInt(lovelaceBalance) : null);

    if (isConnected && connectedWallet) {
        return (
            <div className="walletbar">
                <span className="wallet-pill" title={address ?? ""}>
                    {connectedWallet.icon && <img src={connectedWallet.icon} alt="" width={16} height={16} />}
                    {connectedWallet.displayName}
                    {address && <code>{address.slice(0, 14)}…{address.slice(-5)}</code>}
                    {shownLovelace != null && <b>{(Number(shownLovelace) / 1_000_000).toFixed(1)} ₳</b>}
                </span>
                <button onClick={() => disconnect()}>disconnect</button>
            </div>
        );
    }

    return (
        <div className="walletbar">
            {open && detectedWallets.length > 0 && detectedWallets.map((w) => (
                <button
                    key={w.name}
                    disabled={isConnecting}
                    onClick={() => {
                        setError(null);
                        connect(w.name).catch((e) => setError(String(e?.message ?? e)));
                    }}
                >
                    {w.icon && <img src={w.icon} alt="" width={16} height={16} />} {w.displayName}
                </button>
            ))}
            {open && detectedWallets.length === 0 &&
                <span className="muted">no CIP-30 wallet extensions detected</span>}
            <button className="primary" disabled={isConnecting} onClick={() => setOpen(!open)}>
                {isConnecting ? "connecting…" : open ? "cancel" : "connect wallet"}
            </button>
            {error && <span className="err">{error}</span>}
        </div>
    );
}
