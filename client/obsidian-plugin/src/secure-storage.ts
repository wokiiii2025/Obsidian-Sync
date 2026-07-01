type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Uint8Array): string;
};

type ElectronModule = {
  safeStorage?: SafeStorage;
  remote?: {
    safeStorage?: SafeStorage;
  };
};

type ModuleLoader = (id: string) => unknown;

type WindowWithRequire = Window & {
  require?: ModuleLoader;
};

function moduleLoaders(): ModuleLoader[] {
  const loaders: ModuleLoader[] = [];
  if (typeof require === "function") {
    loaders.push(require);
  }
  const windowRequire = (window as WindowWithRequire).require;
  if (typeof windowRequire === "function" && windowRequire !== require) {
    loaders.push(windowRequire);
  }
  return loaders;
}

function usableSafeStorage(storage: SafeStorage | undefined): SafeStorage | null {
  return storage?.isEncryptionAvailable() ? storage : null;
}

function safeStorageFromElectron(electron: ElectronModule): SafeStorage | null {
  return usableSafeStorage(electron.safeStorage) ?? usableSafeStorage(electron.remote?.safeStorage);
}

function safeStorage(): SafeStorage | null {
  for (const load of moduleLoaders()) {
    for (const moduleName of ["electron", "@electron/remote"]) {
      try {
        const storage = safeStorageFromElectron(load(moduleName) as ElectronModule);
        if (storage) {
          return storage;
        }
      } catch {
        // Try the next loader/module shape; Obsidian differs across desktop builds.
      }
    }
  }
  try {
    const electron = (globalThis as { electron?: ElectronModule }).electron;
    return electron ? safeStorageFromElectron(electron) : null;
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
