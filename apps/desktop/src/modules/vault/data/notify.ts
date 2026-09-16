import { osNotify as gated } from "../../../lib/os-notify";

/** Vault-sourced desktop notification (local-delete / sync warnings). Gated
 *  by Settings → Notifications → "Vault sync warnings" and quiet hours. */
export async function osNotify(title: string, body: string): Promise<void> {
  await gated("vault", title, body);
}
