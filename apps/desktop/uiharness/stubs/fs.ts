export function readFile(): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array([80, 75, 3, 4]));
}

// Vault batch ops / downloads / sync ledger (folder check-out harness view).
// Nothing here touches disk; each resolves like a successful call.
export const BaseDirectory = { AppData: 14 } as const;
export function stat(): Promise<{ mtime: Date }> {
  return Promise.resolve({ mtime: new Date(0) });
}
export function writeFile(): Promise<void> { return Promise.resolve(); }
export function mkdir(): Promise<void> { return Promise.resolve(); }
export function rename(): Promise<void> { return Promise.resolve(); }
export function remove(): Promise<void> { return Promise.resolve(); }
export function readTextFile(): Promise<string> { return Promise.resolve("{}"); }
export function writeTextFile(): Promise<void> { return Promise.resolve(); }
