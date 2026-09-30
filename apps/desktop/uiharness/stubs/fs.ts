export function readFile(): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array([80, 75, 3, 4]));
}
