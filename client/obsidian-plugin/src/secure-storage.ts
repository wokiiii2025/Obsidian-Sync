type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
};

type ElectronModule = {
  safeStorage?: SafeStorage;
};

function safeStorage(): SafeStorage | null {
  if (typeof require !== "function") {
    return null;
  }
  try {
    const electron = require("electron") as ElectronModule;
    if (!electron.safeStorage?.isEncryptionAvailable()) {
      return null;
    }
    return electron.safeStorage;
  } catch {
    return null;
  }
}

export function canUseSecureStorage(): boolean {
  return safeStorage() !== null;
}

export function protectText(value: string): string | null {
  const storage = safeStorage();
  if (!storage) {
    return null;
  }
  return Buffer.from(storage.encryptString(value)).toString("base64");
}

export function unprotectText(value: string): string | null {
  const storage = safeStorage();
  if (!storage) {
    return null;
  }
  try {
    return storage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
}
