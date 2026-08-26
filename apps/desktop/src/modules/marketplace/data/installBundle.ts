// The download → verify → unpack half of installing, extracted so the normal
// install path and the reviewer's test-drive share it exactly.
//
// A reviewer previewing a pending build must run the SAME bytes through the SAME
// verification a member would; a second, slightly different copy of this sequence
// would be the easiest place in the feature for the two to quietly diverge.

import { invoke } from "@tauri-apps/api/core";
import type { useSupabaseClient } from "@helios/auth";
import type { PluginManifest } from "@helios/plugin-sdk";

type Client = ReturnType<typeof useSupabaseClient>;

const SCHEMA = "marketplace";
const BUNDLE_BUCKET = "plugins";
/** Only needs to outlive a single download. */
export const SIGNED_URL_TTL = 120;

/** Everything `install_plugin` / `install_plugin_for_review` return: the metadata
 *  needed to fetch the bundle and prove it is the one that was approved. */
export interface InstallMetaRow {
  plugin_id: string;
  version: string;
  manifest: PluginManifest;
  bundle_sha256: string;
  bundle_bytes: number;
  signature: string;
  sig_alg: string;
  signing_key_id: string;
}

interface PublicKeyRow {
  key_id: string;
  public_key: string;
  alg: string;
}

/** Mint a short-lived signed URL for a content-addressed bundle. */
export async function signedBundleUrl(client: Client, sha256: string): Promise<string> {
  const signed = await client.storage.from(BUNDLE_BUCKET).createSignedUrl(sha256, SIGNED_URL_TTL);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(signed.error?.message ?? "could not sign bundle URL");
  }
  return signed.data.signedUrl;
}

/**
 * Download, verify (sha256 + Ed25519), and unpack a bundle into the local cache.
 *
 * The caller has already recorded the install server-side — that ordering is
 * deliberate and documented in the Rust command: a failed unpack is a true no-op
 * because the install is staged and swapped, so the server never ends up claiming
 * a version the disk does not have.
 */
export async function installBundle(client: Client, row: InstallMetaRow): Promise<void> {
  const signedUrl = await signedBundleUrl(client, row.bundle_sha256);

  const pk = await client.schema(SCHEMA).rpc("signing_public_key");
  if (pk.error) throw new Error(pk.error.message);
  const keyRow = ((pk.data ?? []) as PublicKeyRow[])[0];
  if (!keyRow) throw new Error("no marketplace signing key available");

  await invoke("install_plugin_bundle", {
    pluginId: row.plugin_id,
    version: row.version,
    signedUrl,
    expectedSha256: row.bundle_sha256,
    bundleBytes: row.bundle_bytes,
    signature: row.signature,
    sigAlg: row.sig_alg,
    publicKey: keyRow.public_key,
    // H1: the bundle's own manifest cannot grant itself more than was approved.
    approvedPermissions: row.manifest.permissions ?? [],
  });
}
