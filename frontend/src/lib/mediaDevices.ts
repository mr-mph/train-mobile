/**
 * `navigator.mediaDevices` only exists in a secure context (HTTPS or
 * localhost). Phone/LAN access over plain HTTP has no MediaDevices API —
 * never touch it without this guard.
 */
export function getMediaDevices(): MediaDevices | null {
  if (typeof navigator === "undefined") return null;
  const md = navigator.mediaDevices;
  return md && typeof md === "object" ? md : null;
}
