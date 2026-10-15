// Signed evidence exports. Each installation has an Ed25519 key in its data directory; an export's trailer is
// signed, so another installation can tell who produced it. Hashes alone only prove the file was not edited after
// hashing; anyone can recompute them (final audit finding). A signature from a key the importer trusts is the
// authenticity claim, and the only one ATLAS makes.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Signature { alg: 'ed25519'; keyId: string; publicKey: string; signature: string }

/** Short, stable identity of a public key: SHA-256 of its DER (SPKI) form, first 16 bytes in hex. */
export function keyIdOf(publicKeyDerB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyDerB64, 'base64')).digest('hex').slice(0, 32);
}

export class ExportKeys {
  private cache: { priv: KeyObject; pub: string; keyId: string } | null = null;
  constructor(private readonly dir: string) {}

  /** The installation key, created on first use (private key readable by the user only). */
  private key() {
    if (this.cache) return this.cache;
    const file = path.join(this.dir, 'export-ed25519.pem');
    if (!existsSync(file)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      try { chmodSync(file, 0o600); } catch { /* Windows: ACLs of the user profile apply */ }
    }
    const priv = createPrivateKey(readFileSync(file));
    const pub = (createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    return (this.cache = { priv, pub, keyId: keyIdOf(pub) });
  }

  get keyId(): string { return this.key().keyId; }
  get publicKey(): string { return this.key().pub; }

  sign(digestHex: string): Signature {
    const k = this.key();
    return { alg: 'ed25519', keyId: k.keyId, publicKey: k.pub, signature: sign(null, Buffer.from(digestHex, 'utf8'), k.priv).toString('base64') };
  }
}

/** Verify a trailer signature. Returns false for anything malformed. */
export function verifySignature(digestHex: string, s: Partial<Signature>): boolean {
  try {
    if (s.alg !== 'ed25519' || !s.publicKey || !s.signature || s.keyId !== keyIdOf(s.publicKey)) return false;
    const pub = createPublicKey({ key: Buffer.from(s.publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(digestHex, 'utf8'), pub, Buffer.from(s.signature, 'base64'));
  } catch { return false; }
}
