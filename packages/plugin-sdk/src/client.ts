// The client runtime that runs INSIDE the plugin sandbox. It wraps the host
// broker as typed async calls over `postMessage`. Authors don't use this class
// directly — they use the friendly named exports in index.ts, which lazily own
// a single client instance.
//
// IMPORTANT: nothing here touches `window` at module load — only inside the
// constructor/methods — so the host (Node/jsdom) can import the contract types
// from this package without side effects.

import {
  PROTOCOL_VERSION,
  type HostToPluginMessage,
  type PluginContext,
  type RpcResponse,
} from "./protocol";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class HeliosPluginClient {
  #seq = 0;
  #pending = new Map<string, Pending>();
  #context: PluginContext | null = null;
  readonly #ready: Promise<PluginContext>;
  readonly #target: Window;

  /** @param target the embedding host window (defaults to `window.parent`). */
  constructor(target?: Window) {
    this.#target = target ?? window.parent;
    this.#ready = new Promise<PluginContext>((resolve) => {
      window.addEventListener("message", (ev: MessageEvent) => {
        // Only trust messages from our host (the window that embedded us).
        if (ev.source !== this.#target) return;
        const msg = ev.data as HostToPluginMessage;
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "helios:init") {
          this.#context = msg.context;
          resolve(msg.context);
        } else if (msg.kind === "helios:rpc-result") {
          this.#settle(msg);
        }
      });
    });
    // Announce readiness so the host sends us our init/context.
    this.#post({ kind: "helios:ready", protocol: PROTOCOL_VERSION });
  }

  get context(): PluginContext | null {
    return this.#context;
  }

  /** Resolves with the plugin context once the host has completed the handshake. */
  ready(): Promise<PluginContext> {
    return this.#ready;
  }

  /** Issue one brokered capability call. Rejects with an Error carrying a `.code`
   *  (one of {@link import("./protocol").RpcErrorCode}) on failure. */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `${++this.#seq}`;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#post({ kind: "helios:rpc", id, method, params });
    });
  }

  #settle(msg: Extract<RpcResponse, { kind: "helios:rpc-result" }>): void {
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    }
  }

  #post(msg: unknown): void {
    // targetOrigin "*" is acceptable: the payload is non-sensitive (a call the
    // host will re-check), and the host authenticates US by `event.source`.
    this.#target.postMessage(msg, "*");
  }
}
