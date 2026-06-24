import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { argon2id } from "@noble/hashes/argon2";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToBase64, bytesToText, concatBytes, base64ToBytes, textToBytes } from "./encoding";

const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;
const KDF_SALT = textToBytes("obsidian-zero-knowledge-sync-v1");

export interface EncryptedNote {
  pathHash: string;
  encryptedPath: string;
  encryptedContent: string;
  encryptedDek: string;
}

export class CryptoService {
  private kek: Uint8Array | null = null;

  async unlock(password: string): Promise<void> {
    this.kek = argon2id(password, KDF_SALT, {
      t: 3,
      m: 65536,
      p: 4,
      dkLen: KEY_LENGTH
    });
  }

  isUnlocked(): boolean {
    return this.kek !== null;
  }

  lock(): void {
    this.kek = null;
  }

  pathHash(path: string): string {
    return bytesToBase64(sha256(textToBytes(path)));
  }

  async encryptNote(path: string, content: string): Promise<EncryptedNote> {
    return this.encryptFile(path, textToBytes(content));
  }

  async encryptFile(path: string, content: Uint8Array): Promise<EncryptedNote> {
    const kek = this.requireKek();
    const dek = randomBytes(KEY_LENGTH);
    const pathHash = this.pathHash(path);
    const aad = textToBytes(pathHash);

    return {
      pathHash,
      encryptedPath: bytesToBase64(encryptBytes(dek, textToBytes(path), aad)),
      encryptedContent: bytesToBase64(encryptBytes(dek, content, aad)),
      encryptedDek: bytesToBase64(encryptBytes(kek, dek))
    };
  }

  async decryptRemote(pathHash: string, encryptedPath: string, encryptedContent: string, encryptedDek: string): Promise<{ path: string; content: string }> {
    const kek = this.requireKek();
    const dek = decryptBytes(kek, base64ToBytes(encryptedDek));
    const aad = textToBytes(pathHash);
    return {
      path: bytesToText(decryptBytes(dek, base64ToBytes(encryptedPath), aad)),
      content: bytesToText(decryptBytes(dek, base64ToBytes(encryptedContent), aad))
    };
  }

  async decryptRemoteFile(pathHash: string, encryptedPath: string, encryptedContent: string, encryptedDek: string): Promise<{ path: string; content: Uint8Array }> {
    const kek = this.requireKek();
    const dek = decryptBytes(kek, base64ToBytes(encryptedDek));
    const aad = textToBytes(pathHash);
    return {
      path: bytesToText(decryptBytes(dek, base64ToBytes(encryptedPath), aad)),
      content: decryptBytes(dek, base64ToBytes(encryptedContent), aad)
    };
  }

  private requireKek(): Uint8Array {
    if (!this.kek) {
      throw new Error("Vault password is not unlocked");
    }
    return this.kek;
  }
}

function encryptBytes(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = gcm(key, nonce, aad);
  return concatBytes(nonce, cipher.encrypt(plaintext));
}

function decryptBytes(key: Uint8Array, payload: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = payload.slice(0, NONCE_LENGTH);
  const ciphertext = payload.slice(NONCE_LENGTH);
  const cipher = gcm(key, nonce, aad);
  return cipher.decrypt(ciphertext);
}
