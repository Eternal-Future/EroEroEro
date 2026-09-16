// Media URLs handed to the browser are signed, so /img only ever proxies a
// path this server itself produced from a source adapter. That replaces a
// domain allowlist (upstream CDNs rotate domains: jm alone ships several, and
// new ones appear without notice) with a check that does not care about the
// host at all.
//
// The signature has no expiry on purpose: the same (source, kind, path) must
// always produce the same URL, otherwise browser and CDN image caches would
// fragment on every render. It authorises exactly one upstream media path,
// which is public content anyway.

import CryptoJS from "crypto-js";

const SIGNATURE_CHARS = 32; // 128 bit of the HMAC

let keyCache: string | null = null;

function readEnv(name: string): string {
  const g = globalThis as any;
  const v = g.process?.env?.[name] ?? g[name];
  return typeof v === "string" ? v : "";
}

function randomHex(bytes: number): string {
  const cryptoObj = (globalThis as any).crypto;
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    cryptoObj.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let out = "";
  while (out.length < bytes * 2) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * MEDIA_SIGN_KEY pins the key (needed when several instances/regions serve the
 * same app). ERO_PASSWORD is a fine substitute. Without either, a per-process
 * key is used: still unforgeable, but URLs change on restart.
 */
function mediaSignKey(): string {
  if (keyCache) return keyCache;
  const explicit = readEnv("MEDIA_SIGN_KEY") || readEnv("ERO_PASSWORD");
  if (explicit) {
    keyCache = `ero3-media:${explicit}`;
    return keyCache;
  }
  keyCache = `ero3-media-ephemeral:${randomHex(24)}`;
  console.warn(
    "[mediasign] MEDIA_SIGN_KEY/ERO_PASSWORD unset: media URLs are signed with a per-process key and change on restart",
  );
  return keyCache;
}

export function mediaSignature(source: string, kind: string, path: string): string {
  const message = `${source}\n${kind}\n${path}`;
  return CryptoJS.HmacSHA256(message, mediaSignKey())
    .toString(CryptoJS.enc.Hex)
    .slice(0, SIGNATURE_CHARS);
}

export function verifyMediaSignature(
  source: string,
  kind: string,
  path: string,
  signature: string | undefined,
): boolean {
  if (!signature || signature.length !== SIGNATURE_CHARS) return false;
  const expected = mediaSignature(source, kind, path);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}