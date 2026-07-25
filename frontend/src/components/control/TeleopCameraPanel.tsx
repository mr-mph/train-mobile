import React, { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRobots } from "@/hooks/useRobots";
import CameraFeed from "./CameraFeed";

/** Live Mac camera feeds for teleop — always streaming when cameras are configured. */
const TeleopCameraPanel: React.FC = () => {
  const [reloadKey, setReloadKey] = useState(0);
  const { selectedRecord, isLoading: robotsLoading } = useRobots();

  const configured = selectedRecord?.cameras ?? [];
  const feeds = configured.map((c) => ({
    key: c.id,
    name: c.name,
    cameraIndex: c.camera_index,
    width: c.width ?? 640,
    height: c.height ?? 480,
    fps: c.fps ?? 15,
  }));

  return (
    <div className="w-full max-w-3xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-gray-200">Cameras</h2>
        {feeds.length > 0 && (
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

      {feeds.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {feeds.map((feed) => (
            <CameraFeed
              key={`${feed.key}:${reloadKey}`}
              cameraIndex={feed.cameraIndex}
              width={feed.width}
              height={feed.height}
              fps={feed.fps}
              label={feed.name}
              reloadKey={reloadKey}
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
