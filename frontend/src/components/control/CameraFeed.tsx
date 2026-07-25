import React, { useMemo, useState } from "react";
import { VideoOff } from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import { cn } from "@/lib/utils";

interface CameraFeedProps {
  /** OpenCV camera index on the Mac host. */
  cameraIndex?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** When true, do not open a preview stream. */
  paused?: boolean;
  /** Optional caption shown under the feed. */
  label?: string;
  /** Bump to force the img URL to reload (e.g. after reconnect). */
  reloadKey?: number;
  className?: string;
  /** Override the default 4:3 frame (e.g. fixed thumbnail size). */
  frameClassName?: string;
}

/** Live Mac-camera feed via server MJPEG (works over Cloudflare tunnel). */
const CameraFeed: React.FC<CameraFeedProps> = ({
  cameraIndex,
  width = 640,
  height = 480,
  fps = 15,
  paused = false,
  label,
  reloadKey = 0,
  className,
  frameClassName,
}) => {
  const { baseUrl } = useApi();
  const [hasError, setHasError] = useState(false);

  const src = useMemo(() => {
    if (paused || cameraIndex == null || cameraIndex < 0) return null;
    const params = new URLSearchParams({
      width: String(width),
      height: String(height),
      fps: String(fps),
      _: String(reloadKey),
    });
    return `${baseUrl}/cameras/${cameraIndex}/mjpeg?${params.toString()}`;
  }, [baseUrl, cameraIndex, width, height, fps, paused, reloadKey]);

  React.useEffect(() => {
    setHasError(false);
  }, [src]);

  const showVideo = !!src && !hasError;

  return (
    <div className={cn("bg-gray-900 overflow-hidden", className)}>
      <div className={cn("aspect-[4/3] bg-gray-800 relative", frameClassName)}>
        {showVideo ? (
          <img
            src={src}
            alt={label ?? `Camera ${cameraIndex}`}
            className="w-full h-full object-cover"
            onError={() => setHasError(true)}
          />
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
        <div className="p-2 text-sm text-gray-300 truncate border-t border-gray-800">
          {label}
        </div>
      )}
    </div>
  );
};

export default CameraFeed;
