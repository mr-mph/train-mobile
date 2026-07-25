import React, { useEffect, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import { cn } from "@/lib/utils";

const httpToWs = (httpBase: string): string => {
  if (typeof window === "undefined") return "ws://localhost:8000";
  if (!httpBase) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return httpBase.replace(/^http/, "ws");
};

interface RecordingCameraFeedProps {
  /** Dataset / robot camera name (matches FrameBroker slot). */
  cameraName: string;
  label?: string;
  className?: string;
  /** When false, do not connect (session still preparing). */
  enabled?: boolean;
}

/**
 * Live preview during recording — uses ``/ws/recording-preview/{name}``.
 * Never opens ``/ws/cameras/{index}`` (that fights the session for the device).
 */
const RecordingCameraFeed: React.FC<RecordingCameraFeedProps> = ({
  cameraName,
  label,
  className,
  enabled = true,
}) => {
  const { baseUrl, wsBaseUrl } = useApi();
  const [hasFrame, setHasFrame] = useState(false);
  const [hasError, setHasError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const objectUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled || !cameraName) {
      setHasFrame(false);
      setHasError(false);
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | undefined;

    setHasFrame(false);
    setHasError(false);

    const applyBlob = (blob: Blob) => {
      const next = URL.createObjectURL(blob);
      if (imgRef.current) imgRef.current.src = next;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = next;
      setHasFrame(true);
      setHasError(false);
    };

    const connect = () => {
      if (cancelled) return;
      const root = wsBaseUrl || httpToWs(baseUrl);
      const url = `${root}/ws/recording-preview/${encodeURIComponent(cameraName)}`;
      const socket = new WebSocket(url);
      ws = socket;
      socket.binaryType = "arraybuffer";

      socket.onmessage = (ev) => {
        if (cancelled || ws !== socket) return;
        const buf = ev.data as ArrayBuffer;
        if (buf.byteLength < 5) return;
        applyBlob(new Blob([buf.slice(4)], { type: "image/jpeg" }));
      };

      socket.onerror = () => {
        if (!cancelled && ws === socket) setHasError(true);
      };

      socket.onclose = () => {
        if (cancelled || ws !== socket) return;
        reconnectTimer = window.setTimeout(connect, 500);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      const socket = ws;
      ws = null;
      socket?.close();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = undefined;
      }
    };
  }, [enabled, cameraName, baseUrl, wsBaseUrl]);
  return (
    <div className={cn("bg-black overflow-hidden", className)}>
      <div className="aspect-[4/3] bg-black relative">
        {enabled ? (
          <>
            <img
              ref={imgRef}
              alt={label ?? cameraName}
              className={cn(
                "w-full h-full object-cover",
                !hasFrame && "opacity-0"
              )}
            />
            {!hasFrame && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-gray-500 text-sm">
                  {hasError ? "Waiting for preview…" : "Connecting…"}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center">
            <VideoOff className="w-8 h-8 text-gray-500 mb-2" />
            <span className="text-gray-500 text-sm">Preparing cameras…</span>
          </div>
        )}
      </div>
      {(label || cameraName) && (
        <div className="p-2 text-sm text-gray-300 truncate border-t border-zinc-800">
          {label ?? cameraName}
        </div>
      )}
    </div>
  );
};

export default RecordingCameraFeed;
