// Signatures for team entries (ADR 0021). A member is an installation's Ed25519 key, the same key that signs evidence
// exports. An entry's id is the SHA-256 of its canonical content, and the signature covers that id.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import type { TeamEntry } from '@atlas/contracts';

/** Signs a hex digest with the installation key (ExportKeys satisfies this). */
export interface Signer {
  readonly keyId: string;
  /** Base64 DER (SPKI) public key. */
  readonly publicKey: string;
  sign(digestHex: string): { keyId: string; publicKey: string; signature: string };
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Short, stable identity of a public key: SHA-256 of its DER (SPKI) form, first 16 bytes in hex. */
export const keyIdOf = (publicKeyDerB64: string) => sha256(Buffer.from(publicKeyDerB64, 'base64')).slice(0, 32);

export function verifyEd25519(message: string, publicKeyDerB64: string, signatureB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(publicKeyDerB64, 'base64'), format: 'der', type: 'spki' });
    if (pub.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(message, 'utf8'), pub, Buffer.from(signatureB64, 'base64'));
  } catch { return false; }
}

/** JSON with sorted keys and no whitespace: the same bytes on every machine. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** The entry id: what is signed, and the file name in the ref. */
export function entryId(e: Omit<TeamEntry, 'sig'>): string {
  return sha256(`atlas-team-entry-v1\n${canonical({ v: e.v, space: e.space, kind: e.kind, at: e.at, author: e.author, publicKey: e.publicKey, body: e.body })}`);
}

// ---- Invitations ----
// The invite code is a secret shared out of band (chat, in person). The invite entry publishes only a public key
// derived from it, so anyone can check a join's proof and nobody can make one without the code.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 120 random bits as ATLAS-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export function newInviteCode(): string {
  const b = randomBytes(15);
  let bits = 0, acc = 0, s = '';
  for (const x of b) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { s += CROCKFORD[(acc >> (bits - 5)) & 31]; bits -= 5; } }
  return `ATLAS-${s.match(/.{4}/g)!.join('-')}`;
}

/** Case, spaces and dashes do not matter when a person types a code; O/I/L read as 0/1/1. */
export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/^ATLAS/, '').replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
function inviteKey(code: string) {
  const seed = createHash('sha256').update(`atlas-team-invite-v1\n${normalizeInviteCode(code)}`).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  return { priv, publicKey: (createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64') };
}

export const invitePublicKey = (code: string) => inviteKey(code).publicKey;

const joinMessage = (space: string, inviteId: string, keyId: string) => `atlas-team-join-v1\n${space}\n${inviteId}\n${keyId}`;

/** Proof that the joining key holds the invite code; bound to that key, the space and the invite. */
export function inviteProof(code: string, space: string, inviteId: string, keyId: string): string {
  return sign(null, Buffer.from(joinMessage(space, inviteId, keyId), 'utf8'), inviteKey(code).priv).toString('base64');
}

export function inviteProofValid(invitePublicKeyB64: string, space: string, inviteId: string, keyId: string, signatureB64: string): boolean {
  return verifyEd25519(joinMessage(space, inviteId, keyId), invitePublicKeyB64, signatureB64);
}
