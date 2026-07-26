import { useState } from "react";
import { useCardanoWallet } from "@harmoniclabs/use-cardano-wallet";

/** connect / disconnect UI; wallet state comes from the shared zustand store */
export function WalletBar() {
    const {
        isConnected, isConnecting, detectedWallets,
        connectedWallet, address, lovelaceBalance,
        connect, disconnect,
    } = useCardanoWallet({ autoConnect: true });
    const [open, setOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (isConnected && connectedWallet) {
        return (
            <div className="walletbar">
                <span className="wallet-pill" title={address ?? ""}>
                    {connectedWallet.icon && <img src={connectedWallet.icon} alt="" width={16} height={16} />}
                    {connectedWallet.displayName}
                    {address && <code>{address.slice(0, 14)}…{address.slice(-5)}</code>}
                    {lovelaceBalance != null && <b>{(lovelaceBalance / 1_000_000).toFixed(1)} ₳</b>}
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
