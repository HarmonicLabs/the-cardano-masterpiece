import { parseUPLC } from "@harmoniclabs/uplc";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const flat = readFileSync(join(__dirname, "..", "out", "masterpiece", "out.flat"));
const body: any = parseUPLC(new Uint8Array(flat)).body;

// count binding forms and single-use lambda params
let apps = 0, lams = 0, caseConstrBind = 0, directBind = 0, singleUseBind = 0, trivialArgBind = 0;
function countUses( t: any, dbn: number ): number {
    // count occurrences of var with deBruijn == dbn at current depth offset
    let n = 0;
    const walk = ( x: any, depth: number ): void => {
        const c = x.constructor.name;
        if( c === "UPLCVar" ) { if( Number(x.deBruijn) === depth ) n++; return; }
        if( c === "Lambda" ) return walk( x.body, depth + 1 );
        if( c === "Application" ) { walk( x.func, depth ); walk( x.arg, depth ); return; }
        if( c === "Force" ) return walk( x.forced, depth );
        if( c === "Delay" ) return walk( x.delayedTerm, depth );
        if( c === "Case" ) { walk( x.constrTerm, depth ); for( const b of x.continuations ) walk( b, depth ); return; }
        if( c === "Constr" ) { for( const f of x.terms ) walk( f, depth ); return; }
    };
    walk( t, dbn );
    return n;
}
const isTrivial = ( a: any ): boolean => {
    const c = a.constructor.name;
    return c === "UPLCVar" || c === "UPLCConst" || c === "Builtin" || ( c === "Force" && a.forced?.constructor?.name === "Builtin" );
};
function walk( t: any ): void {
    const c = t.constructor.name;
    if( c === "Application" ) {
        apps++;
        if( t.func?.constructor?.name === "Lambda" ) {
            directBind++;
            const uses = countUses( t.func.body, 0 );
            if( uses <= 1 ) { singleUseBind++; if( isTrivial( t.arg ) ) trivialArgBind++; }
        }
        walk( t.func ); walk( t.arg ); return;
    }
    if( c === "Lambda" ) { lams++; walk( t.body ); return; }
    if( c === "Force" ) return walk( t.forced );
    if( c === "Delay" ) return walk( t.delayedTerm );
    if( c === "Case" ) {
        if( t.constrTerm?.constructor?.name === "Constr" && t.continuations.length === 1 && t.continuations[0]?.constructor?.name === "Lambda" )
            caseConstrBind++;
        walk( t.constrTerm ); for( const b of t.continuations ) walk( b ); return;
    }
    if( c === "Constr" ) { for( const f of t.terms ) walk( f ); return; }
}
walk( body );
console.log({ apps, lams, directBind, singleUseBind, trivialArgBind, caseConstrBind });
