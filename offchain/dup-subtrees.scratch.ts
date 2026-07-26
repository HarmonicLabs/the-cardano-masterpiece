// duplicate-subtree analysis: hash every UPLC subtree, count repeats.
import { parseUPLC, prettyUPLC } from "@harmoniclabs/uplc";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { Cbor, CborBytes } from "@harmoniclabs/cbor";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function pebbleBody( name: string ): any {
    return parseUPLC(new Uint8Array(readFileSync(join(root, "out", name, "out.flat")))).body;
}
function aikenBody( title: string ): any {
    const bp = JSON.parse(readFileSync(join(root, "aiken-port", "plutus.json"), "utf8"));
    const v = bp.validators.find((v: any) => v.title === title);
    return parseUPLC((Cbor.parse(fromHex(v.compiledCode)) as CborBytes).bytes).body;
}

interface Info { count: number; size: number; sample: any; }
function analyze( body: any, label: string ): void {
    const seen = new Map<string, Info>();
    // returns [hashHex, nodeCount]
    const walk = ( t: any ): [string, number] => {
        const c = t.constructor.name;
        let child: [string, number][] = [];
        if( c === "Application" ) child = [ walk(t.func), walk(t.arg) ];
        else if( c === "Lambda" ) child = [ walk(t.body) ];
        else if( c === "Force" ) child = [ walk(t.forced) ];
        else if( c === "Delay" ) child = [ walk(t.delayedTerm) ];
        else if( c === "Case" ) child = [ walk(t.constrTerm), ...t.continuations.map(walk) ];
        else if( c === "Constr" ) child = t.terms.map(walk);
        let idpart = "";
        if( c === "UPLCVar" ) idpart = String(t.deBruijn);
        if( c === "UPLCConst" ) idpart = String(t.value) + ":" + String(t.type);
        if( c === "Builtin" ) idpart = String(t.builtinTag);
        if( c === "Constr" ) idpart = String(t.index);
        const h = createHash("sha1");
        h.update(c + "|" + idpart);
        for( const [ch] of child ) h.update("|" + ch);
        const hex = h.digest("hex");
        const size = 1 + child.reduce((s, [,n]) => s + n, 0);
        const e = seen.get(hex);
        if( e ) e.count++;
        else seen.set(hex, { count: 1, size, sample: t });
        return [hex, size];
    };
    walk(body);
    // wasted nodes = (count-1) * size for maximal repeated subtrees.
    // to avoid double-counting nested repeats, report top by wasted, size>=8
    const rows = [...seen.values()].filter(e => e.count > 1 && e.size >= 8)
        .map(e => ({ ...e, wasted: (e.count - 1) * e.size }))
        .sort((a, b) => b.wasted - a.wasted);
    const totalNodes = [...seen.values()].reduce((s, e) => s + e.count * 0, 0);
    console.log(`\n===== ${label}`);
    let shown = 0;
    for( const r of rows ) {
        if( shown++ >= 8 ) break;
        const pretty = prettyUPLC(r.sample, 1).replace(/\s+/g, " ").slice(0, 110);
        console.log(`  x${String(r.count).padStart(3)} size ${String(r.size).padStart(4)} wasted ${String(r.wasted).padStart(5)} | ${pretty}`);
    }
    const totWasted = rows.reduce((s, r) => s + r.wasted, 0);
    console.log(`  (top-level estimate: ${rows.length} repeated shapes, ~${totWasted} wasted nodes incl. nesting overlap)`);
}

analyze(pebbleBody("masterpiece"), "masterpiece [pebble]");
analyze(aikenBody("masterpiece.masterpiece.mint"), "masterpiece [aiken]");
