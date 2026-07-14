/**
 * Utility for encrypting and decrypting strings using the browser's native Web Crypto API.
 * Uses PBKDF2 for key derivation and AES-GCM for symmetric encryption.
 */

// Helper to convert array buffer to base64
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper to convert base64 to array buffer
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Derive a cryptographic key from a passphrase and a salt using PBKDF2
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passphraseKey = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts plain text using a passphrase.
 * Returns a single string containing "saltBase64:ivBase64:ciphertextBase64".
 */
export async function encryptText(text: string, passphrase: string): Promise<string> {
  const encoder = new TextEncoder();
  const rawData = encoder.encode(text);

  // Generate a random 16-byte salt and 12-byte IV
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  // Derive key from passphrase and salt
  const key = await deriveKey(passphrase, salt);

  // Encrypt the raw text
  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    key,
    rawData
  );

  // Convert all components to base64 and join them
  const saltBase64 = bufferToBase64(salt.buffer);
  const ivBase64 = bufferToBase64(iv.buffer);
  const ciphertextBase64 = bufferToBase64(ciphertextBuffer);

  return `${saltBase64}:${ivBase64}:${ciphertextBase64}`;
}

/**
 * Decrypts an encrypted payload using a passphrase.
 * Expects format: "saltBase64:ivBase64:ciphertextBase64".
 * Throws an error if decryption fails (e.g. wrong passphrase).
 */
export async function decryptText(encryptedPayload: string, passphrase: string): Promise<string> {
  const parts = encryptedPayload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format");
  }

  const [saltBase64, ivBase64, ciphertextBase64] = parts;
  const salt = new Uint8Array(base64ToBuffer(saltBase64));
  const iv = new Uint8Array(base64ToBuffer(ivBase64));
  const ciphertext = base64ToBuffer(ciphertextBase64);

  // Derive key from passphrase and salt
  const key = await deriveKey(passphrase, salt);

  try {
    // Decrypt the raw ciphertext buffer
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
  } catch (err) {
    throw new Error("Decryption failed. Please check your passphrase.");
  }
}
