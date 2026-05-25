export interface DerivedKeys {
  encryptionKey: CryptoKey;
  authKey: Uint8Array;
  salt: Uint8Array;
}

export interface EncryptedBlob {
  ciphertext: string;
  nonce: string;
  salt: string;
  timestamp: number;
}

export interface VaultEntry {
  id: string;
  site: string;
  username: string;
  password: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

export async function deriveKeys(
  masterPassword: string,
  salt?: Uint8Array
): Promise<DerivedKeys> {
  const saltToUse = salt || crypto.getRandomValues(new Uint8Array(16));
  const passwordBytes = encoder.encode(masterPassword);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    asBufferSource(passwordBytes),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: asBufferSource(saltToUse),
      iterations: 600000,
      hash: 'SHA-256',
    },
    keyMaterial,
    512
  );

  const derivedKey = new Uint8Array(derivedBits);
  const encryptionKeyBytes = derivedKey.slice(0, 32);
  const authKey = derivedKey.slice(32, 64);

  const encryptionKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(encryptionKeyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return {
    encryptionKey,
    authKey,
    salt: saltToUse,
  };
}

export async function encryptAES256GCM(
  plaintext: string,
  encryptionKey: CryptoKey
): Promise<EncryptedBlob> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = encoder.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce) },
    encryptionKey,
    asBufferSource(plaintextBytes)
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(nonce),
    salt: '',
    timestamp: Date.now(),
  };
}

export async function decryptAES256GCM(
  blob: EncryptedBlob,
  encryptionKey: CryptoKey
): Promise<string> {
  const ciphertext = base64ToBytes(blob.ciphertext);
  const nonce = base64ToBytes(blob.nonce);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asBufferSource(nonce) },
    encryptionKey,
    asBufferSource(ciphertext)
  );

  return decoder.decode(plaintext);
}

export async function computeHMACSHA256(
  data: string,
  key: Uint8Array
): Promise<string> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    asBufferSource(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    asBufferSource(encoder.encode(data))
  );

  return bytesToBase64(new Uint8Array(signature));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function generateRandomId(): string {
  return crypto.getRandomValues(new Uint8Array(16)).reduce(
    (acc, byte) => acc + ('0' + byte.toString(16)).slice(-2),
    ''
  );
}
