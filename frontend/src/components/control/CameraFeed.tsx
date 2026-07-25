import React, { useEffect, useMemo, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import { cn } from "@/lib/utils";

/** Preview caps — independent of dataset/recording camera resolution. */
export const PREVIEW_WIDTH = 320;
export const PREVIEW_HEIGHT = 240;
export const PREVIEW_FPS = 10;
export const PREVIEW_QUALITY = 45;

interface CameraFeedProps {
  /** OpenCV camera index on the Mac host. */
  cameraIndex?: number;
  /** Capture width for the preview worker (defaults to low-latency preview size). */
  width?: number;
  height?: number;
  fps?: number;
  quality?: number;
  /** When true, do not open a preview stream. */
  paused?: boolean;
  /** Optional caption shown under the feed. */
  label?: string;
  /** Bump to force the img URL to reload (e.g. after reconnect). */
  reloadKey?: number;
  className?: string;
  /** Override the default 4:3 frame (e.g. fixed thumbnail size). */
  frameClassName?: string;
  /**
   * `poll` (default): fetch `/frame.jpg` — much lower latency on phones than
   * browser-buffered multipart MJPEG. `mjpeg`: classic `<img>` stream.
   */
  mode?: "poll" | "mjpeg";
}

/** Live Mac-camera feed via server JPEG (works over LAN / Cloudflare tunnel). */
const CameraFeed: React.FC<CameraFeedProps> = ({
  cameraIndex,
  width = PREVIEW_WIDTH,
  height = PREVIEW_HEIGHT,
  fps = PREVIEW_FPS,
  quality = PREVIEW_QUALITY,
  paused = false,
  label,
  reloadKey = 0,
  className,
  frameClassName,
  mode = "poll",
}) => {
  const { baseUrl } = useApi();
  const [hasError, setHasError] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      width: String(width),
      height: String(height),
      fps: String(fps),
      quality: String(quality),
      _: String(reloadKey),
    });
    return params.toString();
  }, [width, height, fps, quality, reloadKey]);

  const mjpegSrc = useMemo(() => {
    if (paused || cameraIndex == null || cameraIndex < 0 || mode !== "mjpeg") {
      return null;
    }
    return `${baseUrl}/cameras/${cameraIndex}/mjpeg?${query}`;
  }, [baseUrl, cameraIndex, paused, mode, query]);

  // Low-latency path: poll one JPEG at a time (skip backlog; no MJPEG buffer).
  useEffect(() => {
    if (mode !== "poll" || paused || cameraIndex == null || cameraIndex < 0) {
      return;
    }

    let cancelled = false;
    let objectUrl: string | undefined;
    const intervalMs = Math.max(50, 1000 / Math.max(1, fps));
    const frameUrl = `${baseUrl}/cameras/${cameraIndex}/frame.jpg?${query}`;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const run = async () => {
      while (!cancelled) {
        const t0 = performance.now();
        try {
          const res = await fetch(frameUrl, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          if (cancelled) break;
          const next = URL.createObjectURL(blob);
          if (imgRef.current) {
            imgRef.current.src = next;
          }
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = next;
          setHasFrame(true);
          setHasError(false);
        } catch {
          if (!cancelled) setHasError(true);
          await sleep(400);
          continue;
        }
        const wait = Math.max(0, intervalMs - (performance.now() - t0));
        if (wait > 0) await sleep(wait);
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mode, paused, cameraIndex, baseUrl, query, fps]);

  useEffect(() => {
    setHasError(false);
    setHasFrame(false);
  }, [mjpegSrc, reloadKey, cameraIndex, mode]);

  const showVideo =
    !hasError &&
    cameraIndex != null &&
    cameraIndex >= 0 &&
    !paused &&
    (mode === "mjpeg" ? !!mjpegSrc : true);

  return (
    <div className={cn("bg-black overflow-hidden", className)}>
      <div className={cn("aspect-[4/3] bg-black relative", frameClassName)}>
        {showVideo ? (
          <>
            <img
              ref={imgRef}
              src={mode === "mjpeg" ? mjpegSrc ?? undefined : undefined}
              alt={label ?? `Camera ${cameraIndex}`}
              className={cn(
                "w-full h-full object-cover",
                mode === "poll" && !hasFrame && "opacity-0"
              )}
              onError={() => {
                if (mode === "mjpeg") setHasError(true);
              }}
            />
            {mode === "poll" && !hasFrame && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-gray-500 text-sm">Connecting…</span>
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center">
            <VideoOff className="w-8 h-8 text-gray-500 mb-2" />
            <span className="text-gray-500 text-sm">
              {paused
                ? "Preview paused"
                : cameraIndex == null
                  ? "No camera selected"
                  : "Preview failed"}
            </span>
          </div>
        )}
      </div>
      {label && (
        <div className="p-2 text-sm text-gray-300 truncate border-t border-zinc-800">
          {label}
        </div>
      )}
    </div>
  );
};

export default CameraFeed;
