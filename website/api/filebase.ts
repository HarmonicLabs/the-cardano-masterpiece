// ===========================================================================
//  Minimal Filebase (S3-compatible) IPFS pinning client — CAR import.
//
//  Filebase pins a CAR — preserving its root CID — when you PUT it via the S3
//  API with the `x-amz-meta-import: car` header; the resulting CID comes back
//  in the `x-amz-meta-cid` response header. Overwriting the same object key
//  replaces (and unpins) the previous root. Free tier: 5 GB.
//
//  Zero deps: SigV4 is signed by hand with node:crypto (no @aws-sdk bundle).
//
//  Env: FILEBASE_KEY / FILEBASE_SECRET (S3 access keys from the dashboard) and
//       FILEBASE_BUCKET (an IPFS bucket you created).
// ===========================================================================
import { createHash, createHmac } from "node:crypto";

const HOST = "s3.filebase.com";
const REGION = "us-east-1";   // Filebase signs against us-east-1
const SERVICE = "s3";

const sha256hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();
const EMPTY_HASH = sha256hex(new Uint8Array(0));

function creds(): { key: string; secret: string; bucket: string } {
    const key = process.env.FILEBASE_KEY, secret = process.env.FILEBASE_SECRET, bucket = process.env.FILEBASE_BUCKET;
    if (!key || !secret || !bucket)
        throw new Error("FILEBASE_KEY / FILEBASE_SECRET / FILEBASE_BUCKET env vars are not set");
    return { key, secret, bucket };
}

function signingKey(secret: string, date: string): Buffer {
    return hmac(hmac(hmac(hmac("AWS4" + secret, date), REGION), SERVICE), "aws4_request");
}

/** SigV4-sign an S3 request and perform it. `headers` keys must be lowercase. */
async function s3(
    method: string, path: string, payload: Uint8Array, extra: Record<string, string> = {},
): Promise<Response> {
    const { key, secret } = creds();
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
    const date = now.slice(0, 8);
    const payloadHash = payload.length ? sha256hex(payload) : EMPTY_HASH;

    const headers: Record<string, string> = {
        host: HOST, "x-amz-content-sha256": payloadHash, "x-amz-date": now, ...extra,
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join("");
    const signedHeaders = names.join(";");
    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", now, scope, sha256hex(canonicalRequest)].join("\n");
    const signature = hmac(signingKey(secret, date), stringToSign).toString("hex");
    headers["authorization"] =
        `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // `host` is signed but must NOT be passed to fetch (a forbidden header):
    // fetch sets the real Host from the URL, which matches what we signed.
    const { host: _host, ...sendHeaders } = headers;
    return fetch(`https://${HOST}${path}`, {
        method, headers: sendHeaders,
        body: method === "PUT" ? (payload as BodyInit) : undefined,
    });
}

const objectPath = (key: string): string => `/${creds().bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** import a CAR under `key`, preserving its root CID; returns the pinned CID */
export async function putCar(key: string, car: Uint8Array): Promise<string> {
    const res = await s3("PUT", objectPath(key), car, { "x-amz-meta-import": "car" });
    if (!res.ok) throw new Error(`Filebase PUT failed: ${res.status} ${await res.text().catch(() => "")}`);
    const cid = res.headers.get("x-amz-meta-cid");
    if (cid) return cid;
    // some responses omit the header on PUT — read it back with a HEAD
    const head = await headCid(key);
    if (!head) throw new Error("Filebase did not return a CID for the imported CAR");
    return head;
}

/** the pinned CID currently stored at `key`, or null if the object doesn't exist */
export async function headCid(key: string): Promise<string | null> {
    const res = await s3("HEAD", objectPath(key), new Uint8Array(0));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Filebase HEAD failed: ${res.status}`);
    return res.headers.get("x-amz-meta-cid");
}
