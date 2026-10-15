const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Opaque, prefixed identifiers: `msn_8fK2aQx1Lp`. */
export function newId(prefix: 'ws' | 'msn' | 'tsk' | 'att' | 'art' | 'apr' | 'chk' | 'evt' | 'fnd' | 'dep' | 'bss' | 'dsk' | 'trm' | 'wa'): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}

export const nowIso = () => new Date().toISOString();
