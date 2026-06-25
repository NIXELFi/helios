// The host broker — the bouncer between an untrusted plugin and Helios.
//
// Every effect a plugin can have flows through `handle()`. It enforces the
// DEFAULT-DENY permission model: a method that requires a permission is rejected
// unless the plugin's manifest declared that permission, BEFORE any host handler
// runs. This is pure logic (no DOM/Tauri), so it is unit-tested directly and is
// the single chokepoint the review pipeline (Sub-project D) observes.

import {
  isKnownMethod,
  permissionForMethod,
  type PluginManifest,
  type RpcErrorCode,
  type RpcRequest,
  type RpcResponse,
} from "@helios/plugin-sdk";

export type CapabilityHandler = (params: unknown) => Promise<unknown> | unknown;

/** An observation of one brokered call. Because every plugin effect passes
 *  through the broker, recording these is what makes the "in-app sandbox test"
 *  possible — a monitored run can assert a plugin never even *attempts* a
 *  capability its manifest didn't declare. */
export interface CallObservation {
  method: string;
  outcome: "ok" | "rejected" | "error";
  code?: RpcErrorCode;
}

export interface BrokerOptions {
  manifest: PluginManifest;
  handlers: Record<string, CapabilityHandler>;
  onCall?: (obs: CallObservation) => void;
}

export class PluginBroker {
  constructor(private readonly opts: BrokerOptions) {}

  /** Handle one RPC request and return the response to post back. NEVER throws —
   *  every failure path maps to a typed error response. */
  async handle(req: RpcRequest): Promise<RpcResponse> {
    const { id, method, params } = req;

    const reject = (code: RpcErrorCode, message: string): RpcResponse => {
      this.opts.onCall?.({ method, outcome: "rejected", code });
      return { kind: "helios:rpc-result", id, ok: false, error: { code, message } };
    };

    if (typeof method !== "string" || !isKnownMethod(method)) {
      return reject("UnknownMethod", `unknown method '${String(method)}'`);
    }

    // DEFAULT-DENY: reject any permissioned method the manifest didn't declare,
    // before touching a handler.
    const required = permissionForMethod(method);
    if (required !== null && !this.opts.manifest.permissions.includes(required)) {
      return reject(
        "PermissionNotDeclared",
        `'${method}' requires the '${required}' permission, which this plugin did not declare`,
      );
    }

    const handler = this.opts.handlers[method];
    if (!handler) {
      return reject("UnknownMethod", `no host handler registered for '${method}'`);
    }

    try {
      const result = await handler(params);
      this.opts.onCall?.({ method, outcome: "ok" });
      return { kind: "helios:rpc-result", id, ok: true, result };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.opts.onCall?.({ method, outcome: "error", code: "HandlerError" });
      return { kind: "helios:rpc-result", id, ok: false, error: { code: "HandlerError", message } };
    }
  }
}
