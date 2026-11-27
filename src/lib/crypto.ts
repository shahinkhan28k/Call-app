/**
 * End-to-End Encryption (ECDH P-256 + AES-GCM 256-bit) using WebCrypto API.
 * Private keys stay strictly in browser IndexedDB on the user's device.
 */

const DB_NAME = 'claro_e2ee_keystore';
const STORE_NAME = 'keys';

function openKeyStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openKeyStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openKeyStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

interface StoredKeyPair {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export async function ensureDeviceKeyPair(uid: string): Promise<{
  publicKeyJwkString: string;
  privateKey: CryptoKey;
}> {
  const cacheKey = `ecdh_${uid}`;
  const existing = await idbGet<StoredKeyPair>(cacheKey);

  if (existing) {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      existing.privateKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey']
    );
    return {
      publicKeyJwkString: JSON.stringify(existing.publicKeyJwk),
      privateKey,
    };
  }

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await idbSet(cacheKey, { publicKeyJwk, privateKeyJwk });

  const nonExtractablePrivate = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  );

  return {
    publicKeyJwkString: JSON.stringify(publicKeyJwk),
    privateKey: nonExtractablePrivate,
  };
}

async function deriveConversationKey(
  myPrivateKey: CryptoKey,
  peerPublicKeyJwkString: string
): Promise<CryptoKey> {
  const peerJwk = JSON.parse(peerPublicKeyJwkString) as JsonWebKey;
  const peerPublicKey = await crypto.subtle.importKey(
    'jwk',
    peerJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    myPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptMessageText(
  plaintext: string,
  myPrivateKey: CryptoKey,
  peerPublicKeyJwkString: string
): Promise<{ ciphertext: string; iv: string }> {
  const aesKey = await deriveConversationKey(myPrivateKey, peerPublicKeyJwkString);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptMessageText(
  ciphertext: string,
  ivBase64: string,
  myPrivateKey: CryptoKey,
  peerPublicKeyJwkString: string
): Promise<string> {
  const aesKey = await deriveConversationKey(myPrivateKey, peerPublicKeyJwkString);
  const iv = base64ToBytes(ivBase64);
  const cipherBytes = base64ToBytes(ciphertext);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    aesKey,
    new Uint8Array(cipherBytes)
  );
  return new TextDecoder().decode(decrypted);
}
