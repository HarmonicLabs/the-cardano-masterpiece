import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { WalletBar } from "./components/WalletBar.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Claim } from "./pages/Claim.tsx";
import { Edit } from "./pages/Edit.tsx";
import { Market } from "./pages/Market.tsx";

export function App() {
    return (
        <HashRouter>
            <header>
                <div className="brand">
                    <h1>The Cardano <span className="amp">Masterpiece</span></h1>
                    <small>an on-chain collaborative artwork</small>
                </div>
                <nav>
                    <NavLink to="/" end>Gallery</NavLink>
                    <NavLink to="/claim">Claim</NavLink>
                    <NavLink to="/market">Market</NavLink>
                    <NavLink to="/edit">Studio</NavLink>
                </nav>
                <WalletBar />
            </header>
            <main>
                <Routes>
                    <Route path="/" element={<Landing />} />
                    <Route path="/claim" element={<Claim />} />
                    <Route path="/market" element={<Market />} />
                    <Route path="/edit" element={<Edit />} />
                </Routes>
            </main>
            <footer>
                <span>The image is stored fully onchain and replicated on IPFS</span>
                <a href="https://github.com/HarmonicLabs/the-cardano-masterpiece"
                   target="_blank" rel="noreferrer">source on GitHub ↗</a>
            </footer>
        </HashRouter>
    );
}
