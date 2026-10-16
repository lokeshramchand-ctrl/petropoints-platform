import * as Application from 'expo-application';

/**
 * Identifier an admin registers under Outlets → POS devices. On Android this is the per-device
 * ANDROID_ID. It survives app reinstalls but changes on factory reset, in which case the device
 * must be re-registered (the old id should be revoked).
 */
export function deviceSerial(): string | null {
  try {
    return Application.getAndroidId() || null;
  } catch {
    return null;
  }
}
