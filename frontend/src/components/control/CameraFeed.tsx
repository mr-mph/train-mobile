import React, { useEffect, useMemo, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import { cn } from "@/lib/utils";

/** Preview caps — independent of dataset/recording camera resolution. */
export const PREVIEW_WIDTH = 320;
export const PREVIEW_HEIGHT = 240;
export const PREVIEW_FPS = 15;
export const PREVIEW_QUALITY = 40;

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
   * `ws` (default): server-pushed JPEGs over WebSocket — smoothest / lowest latency.
   * `poll`: HTTP `/frame.jpg` fallback.
   * `mjpeg`: classic `<img>` multipart stream.
   */
  mode?: "ws" | "poll" | "mjpeg";
}

const httpToWs = (httpBase: string): string => {
  if (typeof window === "undefined") return "ws://localhost:8000";
  if (!httpBase) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return httpBase.replace(/^http/, "ws");
};

/** Live Mac-camera feed (WebSocket push by default). */
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
  mode = "ws",
}) => {
  const { baseUrl, wsBaseUrl } = useApi();
  const [hasError, setHasError] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [activeMode, setActiveMode] = useState<"ws" | "poll" | "mjpeg">(mode);
  const imgRef = useRef<HTMLImageElement>(null);
  const objectUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setActiveMode(mode);
  }, [mode, reloadKey, cameraIndex]);

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
    if (paused || cameraIndex == null || cameraIndex < 0 || activeMode !== "mjpeg") {
      return null;
    }
    return `${baseUrl}/cameras/${cameraIndex}/mjpeg?${query}`;
  }, [baseUrl, cameraIndex, paused, activeMode, query]);

  const applyBlob = (blob: Blob) => {
    const next = URL.createObjectURL(blob);
    if (imgRef.current) imgRef.current.src = next;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = next;
    setHasFrame(true);
    setHasError(false);
  };

  // WebSocket push path
  useEffect(() => {
    if (activeMode !== "ws" || paused || cameraIndex == null || cameraIndex < 0) {
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let sawFrame = false;
    let failCount = 0;

    const connect = () => {
      if (cancelled) return;
      const root = wsBaseUrl || httpToWs(baseUrl);
      const url = `${root}/ws/cameras/${cameraIndex}?${query}`;
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        failCount = 0;
      };

      ws.onmessage = (ev) => {
        if (cancelled) return;
        const buf = ev.data as ArrayBuffer;
        if (buf.byteLength < 5) return;
        const jpeg = buf.slice(4);
        applyBlob(new Blob([jpeg], { type: "image/jpeg" }));
        sawFrame = true;
      };

      ws.onerror = () => {
        failCount += 1;
      };

      ws.onclose = () => {
        if (cancelled) return;
        if (!sawFrame && failCount >= 2) {
          setActiveMode("poll");
          return;
        }
        reconnectTimer = window.setTimeout(connect, 600);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }
    };
  }, [activeMode, paused, cameraIndex, baseUrl, wsBaseUrl, query]);

  // HTTP poll fallback
  useEffect(() => {
    if (activeMode !== "poll" || paused || cameraIndex == null || cameraIndex < 0) {
      return;
    }

    let cancelled = false;
    const frameUrl = `${baseUrl}/cameras/${cameraIndex}/frame.jpg?${query}`;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const run = async () => {
      while (!cancelled) {
        try {
          const res = await fetch(frameUrl, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          if (cancelled) break;
          applyBlob(blob);
        } catch {
          if (!cancelled) setHasError(true);
          await sleep(500);
          continue;
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }
    };
  }, [activeMode, paused, cameraIndex, baseUrl, query]);

  useEffect(() => {
    setHasError(false);
    setHasFrame(false);
  }, [mjpegSrc, reloadKey, cameraIndex, activeMode]);

  const showVideo =
    !hasError &&
    cameraIndex != null &&
    cameraIndex >= 0 &&
    !paused &&
    (activeMode === "mjpeg" ? !!mjpegSrc : true);

  return (
    <div className={cn("bg-black overflow-hidden", className)}>
      <div className={cn("aspect-[4/3] bg-black relative", frameClassName)}>
        {showVideo ? (
          <>
            <img
              ref={imgRef}
              src={activeMode === "mjpeg" ? mjpegSrc ?? undefined : undefined}
              alt={label ?? `Camera ${cameraIndex}`}
              className={cn(
                "w-full h-full object-cover",
                (activeMode === "ws" || activeMode === "poll") && !hasFrame && "opacity-0"
              )}
              onError={() => {
                if (activeMode === "mjpeg") setHasError(true);
              }}
            />
            {(activeMode === "ws" || activeMode === "poll") && !hasFrame && (
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
