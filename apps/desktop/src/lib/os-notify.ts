import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { notificationAllowed, type NotificationSource } from "./prefs";

/**
 * Fire a desktop OS notification, gated by the user's notification
 * preferences (master switch, per-source switch, quiet hours). Best-effort:
 * permission denial or any runtime failure is swallowed — callers keep their
 * own in-app surface as the guaranteed one; the OS toast is a bonus.
 * `force` skips the preference gate (the "send a test" button in Settings).
 */
export async function osNotify(
  source: NotificationSource,
  title: string,
  body: string,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (!opts.force && !notificationAllowed(source)) return false;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const perm = await requestPermission();
      granted = perm === "granted";
    }
    if (!granted) return false;
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}
