import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Fire a desktop OS notification. Best-effort: permission denial or any
 * runtime failure is silently swallowed — the in-app banner is the guaranteed
 * surface for local-delete warnings; the OS toast is a convenience bonus.
 */
export async function osNotify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    if (granted) {
      sendNotification({ title, body });
    }
  } catch {
    // Permission denied or notification API unavailable — no-op.
  }
}
