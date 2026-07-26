// Structural comparison of Pebble vs Aiken compiled UPLC.
import { parseUPLC, UPLCDecoder, prettyUPLC, UPLCBuiltinTag } from "@harmoniclabs/uplc";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromHex } from "@harmoniclabs/uint8array-utils";
import { Cbor, CborBytes } from "@harmoniclabs/cbor";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function pebbleBody( name: string ): any {
    const flat = readFileSync( join( root, "out", name, "out.flat" ) );
    return parseUPLC( new Uint8Array( flat ) ).body;
}
function aikenBody( title: string ): any {
    const bp = JSON.parse( readFileSync( join( root, "aiken-port", "plutus.json" ), "utf8" ) );
    const v = bp.validators.find( (v: any) => v.title === title );
    // compiledCode is cbor-wrapped flat
    const inner = Cbor.parse( fromHex( v.compiledCode ) ) as CborBytes;
    return parseUPLC( inner.bytes ).body;
}

interface Stats {
    total: number;
    byKind: Record<string, number>;
    builtins: Record<string, number>;
    maxLamDepth: number;
    apps: number;
    forces: number;
    delays: number;
    lambdas: number;
    constrs: number;
    cases: number;
    consts: number;
    vars: number;
    errors: number;
}

function stats( t: any ): Stats {
    const s: Stats = { total: 0, byKind: {}, builtins: {}, maxLamDepth: 0,
        apps: 0, forces: 0, delays: 0, lambdas: 0, constrs: 0, cases: 0, consts: 0, vars: 0, errors: 0 };
    const walk = ( n: any, lamDepth: number ): void => {
        s.total++;
        const ctor = n.constructor?.name ?? "?";
        s.byKind[ctor] = (s.byKind[ctor] ?? 0) + 1;
        if( ctor === "Application" ) { s.apps++; walk( n.func, lamDepth ); walk( n.arg, lamDepth ); return; }
        if( ctor === "Lambda" ) { s.lambdas++; s.maxLamDepth = Math.max( s.maxLamDepth, lamDepth+1 ); walk( n.body, lamDepth+1 ); return; }
        if( ctor === "Force" ) { s.forces++; walk( n.forced, lamDepth ); return; }
        if( ctor === "Delay" ) { s.delays++; walk( n.delayedTerm, lamDepth ); return; }
        if( ctor === "Builtin" ) { const tag = n.builtinTag; s.builtins[ String(tag) ] = (s.builtins[String(tag)] ?? 0) + 1; return; }
        if( ctor === "Case" ) { s.cases++; walk( n.constrTerm, lamDepth ); for( const c of n.continuations ) walk( c, lamDepth ); return; }
        if( ctor === "Constr" ) { s.constrs++; for( const f of n.terms ) walk( f, lamDepth ); return; }
        if( ctor === "UPLCConst" ) { s.consts++; return; }
        if( ctor === "UPLCVar" ) { s.vars++; return; }
        if( ctor === "ErrorUPLC" ) { s.errors++; return; }
        // unknown node: try children
        for( const k of ["body","term","fn","arg"] ) if( n[k] ) walk( n[k], lamDepth );
    };
    walk( t, 0 );
    return s;
}

const builtinName = ( tag: string ): string => ( UPLCBuiltinTag as any )[ Number(tag) ] ?? tag;

const pairs: [string, string, string][] = [
    [ "marketplace", "marketplace", "marketplace.marketplace.spend" ],
    [ "ownership",   "ownership",   "ownership.ownership.mint" ],
    [ "masterpiece", "masterpiece", "masterpiece.masterpiece.mint" ],
];

for( const [ label, pname, atitle ] of pairs ) {
    const pb = pebbleBody( pname );
    const ak = aikenBody( atitle );
    const ps = stats( pb ), as_ = stats( ak );
    console.log( `\n===== ${label} =====` );
    const row = ( k: keyof Stats ) => console.log( String(k).padEnd(12), String(ps[k]).padStart(7), String(as_[k]).padStart(7), ( as_[k] && ps[k] ? ( (ps[k] as number) / (as_[k] as number) ).toFixed(2) + "x" : "" ).padStart(8) );
    console.log( "metric        pebble   aiken   pb/ak" );
    for( const k of ["total","apps","lambdas","vars","consts","forces","delays","cases","constrs","errors","maxLamDepth"] as (keyof Stats)[] ) row( k );
    // builtin histograms
    const allTags = new Set([ ...Object.keys(ps.builtins), ...Object.keys(as_.builtins) ]);
    const rows = [ ...allTags ].map( t => ({ name: builtinName(t), p: ps.builtins[t] ?? 0, a: as_.builtins[t] ?? 0 }) )
        .sort( (x,y) => (y.p+y.a) - (x.p+x.a) );
    console.log( "-- builtin occurrences (static) --" );
    for( const r of rows.slice(0, 18) ) console.log( r.name.padEnd(24), String(r.p).padStart(5), String(r.a).padStart(5) );
}

// also dump pretty text for the smallest pair for manual reading
writeFileSync( join(root, "out", "cmp-pebble-marketplace.uplc.txt"), prettyUPLC( pebbleBody("marketplace"), 2 ) );
writeFileSync( join(root, "out", "cmp-aiken-marketplace.uplc.txt"), prettyUPLC( aikenBody("marketplace.marketplace.spend"), 2 ) );
console.log("\npretty dumps written to out/cmp-*.uplc.txt");
