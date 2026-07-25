import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/contexts/ApiContext";
import { getMediaDevices } from "@/lib/mediaDevices";

export interface AvailableCamera {
  index: number;
  name: string;
  deviceId: string;
  available: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

interface UseAvailableCamerasOptions {
  /** When false, do nothing. Use to gate on modal open. */
  enabled?: boolean;
}

/**
 * Enumerates cv2 camera indices from `/available-cameras` and, when the
 * browser MediaDevices API is available (HTTPS / localhost), merges each
 * with the matching browser deviceId (by AVFoundation localizedName).
 *
 * On plain LAN HTTP, MediaDevices is undefined — we still return Mac-host
 * cameras from the API so configuration and server-side previews work.
 */
export function useAvailableCameras({
  enabled = true,
}: UseAvailableCamerasOptions = {}) {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [cameras, setCameras] = useState<AvailableCamera[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async (): Promise<AvailableCamera[]> => {
    setIsLoading(true);
    try {
      const media = getMediaDevices();
      let browserDevices: { deviceId: string; label: string }[] = [];

      if (media) {
        // Need a permission grant before enumerateDevices() returns labels.
        try {
          const probe = await media.getUserMedia({ video: true });
          probe.getTracks().forEach((t) => t.stop());
        } catch {
          // ignore — we'll still try to enumerate, just without labels
        }
        try {
          browserDevices = (await media.enumerateDevices())
            .filter((d) => d.kind === "videoinput")
            .map((d) => ({ deviceId: d.deviceId, label: d.label }));
        } catch {
          browserDevices = [];
        }
      }

      const r = await fetchWithHeaders(`${baseUrl}/available-cameras`);
      if (!r.ok) {
        setCameras([]);
        return [];
      }
      const data = await r.json();
      const backendCams: {
        index: number;
        name?: string;
        available: boolean;
      }[] = data.cameras ?? [];

      // Browser's MediaDeviceInfo.label starts with AVFoundation's localizedName
      // but Chrome often appends "(vendorId:productId)". Match by exact, then
      // prefix, then either-contains. Skipped entirely when MediaDevices is
      // unavailable (LAN HTTP) — deviceId stays empty; previews use cv2 index.
      const used = new Set<string>();
      const merged: AvailableCamera[] = backendCams.map((cam) => {
        const label = cam.name || `Camera ${cam.index}`;
        const target = norm(label);
        const candidates = browserDevices.filter(
          (d) => !used.has(d.deviceId) && d.label
        );
        const match =
          candidates.find((d) => norm(d.label) === target) ||
          candidates.find((d) => norm(d.label).startsWith(target)) ||
          candidates.find(
            (d) =>
              norm(d.label).includes(target) || target.includes(norm(d.label))
          );
        if (match) used.add(match.deviceId);
        return {
          index: cam.index,
          name: label,
          deviceId: match?.deviceId ?? "",
          available: cam.available,
        };
      });
      setCameras(merged);
      return merged;
    } catch {
      setCameras([]);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const media = getMediaDevices();
    if (!media || typeof media.addEventListener !== "function") {
      return;
    }
    const handler = () => {
      void refresh();
    };
    media.addEventListener("devicechange", handler);
    return () => media.removeEventListener("devicechange", handler);
  }, [enabled, refresh]);

  return { cameras, isLoading, refresh };
}
