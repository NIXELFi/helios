import { ToastHost as SharedToastHost } from "../../../components/ToastHost";
import { vaultToasts } from "../data/toast";

/**
 * The Vault's toast queue, bottom-center, above the drop-import strip (which
 * sits bottom-right). One instance lives in VaultHome so toasts survive screen
 * switches within the module. The rendering is the shared `ToastHost`.
 */
export function ToastHost() {
  return <SharedToastHost store={vaultToasts} />;
}
