import React, { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRobots } from "@/hooks/useRobots";
import CameraFeed, {
  PREVIEW_FPS,
  PREVIEW_HEIGHT,
  PREVIEW_QUALITY,
  PREVIEW_WIDTH,
} from "./CameraFeed";

export interface CameraFeedSpec {
  key: string;
  name: string;
  cameraIndex?: number;
}

interface TeleopCameraPanelProps {
  /** When true, do not open preview streams (e.g. recording holds the devices). */
  paused?: boolean;
  /** Override robot cameras — useful when navigating with an explicit config. */
  cameras?: CameraFeedSpec[];
  /** Hide the Cameras heading (page already has a title). */
  hideHeader?: boolean;
}

/** Live Mac camera feeds — same layout for teleop and recording. */
const TeleopCameraPanel: React.FC<TeleopCameraPanelProps> = ({
  paused = false,
  cameras: camerasProp,
  hideHeader = false,
}) => {
  const [reloadKey, setReloadKey] = useState(0);
  const { selectedRecord, isLoading: robotsLoading } = useRobots();

  const feeds: CameraFeedSpec[] =
    camerasProp ??
    (selectedRecord?.cameras ?? []).map((c) => ({
      key: c.id,
      name: c.name,
      cameraIndex: c.camera_index,
    }));

  return (
    <div className="w-full max-w-3xl mx-auto flex flex-col gap-4">
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-gray-200">Cameras</h2>
          {feeds.length > 0 && !paused && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setReloadKey((k) => k + 1)}
              className="h-9 w-9 text-gray-400 hover:text-white flex-shrink-0"
              title="Retry camera feeds"
              aria-label="Retry camera feeds"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}

      {feeds.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {feeds.map((feed) => (
            <CameraFeed
              key={`${feed.key}:${reloadKey}`}
              cameraIndex={feed.cameraIndex}
              width={PREVIEW_WIDTH}
              height={PREVIEW_HEIGHT}
              fps={PREVIEW_FPS}
              quality={PREVIEW_QUALITY}
              label={feed.name}
              reloadKey={reloadKey}
              paused={paused}
              className="rounded-lg border border-zinc-800"
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500 text-center py-12">
          {robotsLoading
            ? "Loading robot..."
            : "No cameras configured. Add them on the Calibration page."}
        </p>
      )}
    </div>
  );
};

export default TeleopCameraPanel;
