// Wire protocol between a plugin (running inside the sandbox) and the Helios
// host broker. Every plugin capability is one request/response pair carried over
// `postMessage`. This is the ONLY channel a plugin has in or out — there is no
// other surface, by design (see docs/superpowers/specs/2026-06-25-v5-plugin-runtime-design.md).

/** Bumped when the message envelope shape changes incompatibly. Distinct from
 *  the SDK *contract* version (see manifest.ts) which tracks the API surface. */
export const PROTOCOL_VERSION = 1;

/** Sent by the plugin's SDK once its document is ready to receive init. */
export interface ReadyMessage {
  kind: "helios:ready";
  protocol: number;
}

/** Sent by the host in reply to `ready`: hands the plugin its (non-sensitive)
 *  context. After this the plugin may issue RPC calls. */
export interface InitMessage {
  kind: "helios:init";
  protocol: number;
  context: PluginContext;
}

/** A capability call from the plugin to the host. */
export interface RpcRequest {
  kind: "helios:rpc";
  /** Correlation id, unique per plugin frame. */
  id: string;
  /** e.g. "file.read", "storage.set", "engine.matlab.run". */
  method: string;
  params: unknown;
}

/** The host's reply to a single `RpcRequest`. */
export type RpcResponse =
  | { kind: "helios:rpc-result"; id: string; ok: true; result: unknown }
  | { kind: "helios:rpc-result"; id: string; ok: false; error: RpcError };

export interface RpcError {
  code: RpcErrorCode;
  message: string;
}

export type RpcErrorCode =
  | "PermissionNotDeclared"
  | "UnknownMethod"
  | "BadParams"
  | "HandlerError"
  | "Timeout";

/** Non-sensitive context handed to the plugin at init. Deliberately tiny — no
 *  PII, no auth tokens, no Supabase handles. A plugin learns who it is and the
 *  app theme, nothing more. */
export interface PluginContext {
  pluginId: string;
  pluginVersion: string;
  theme: "light" | "dark";
  locale: string;
}

export type HostToPluginMessage = InitMessage | RpcResponse;
export type PluginToHostMessage = ReadyMessage | RpcRequest;
