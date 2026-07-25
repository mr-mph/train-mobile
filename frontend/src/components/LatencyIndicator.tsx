import React from "react";
import { useLatency } from "@/contexts/LatencyContext";
import { cn } from "@/lib/utils";

/** Fixed top-of-page latency chip — one for the whole app, not per camera. */
const LatencyIndicator: React.FC = () => {
  const { latencyMs } = useLatency();

  const color =
    latencyMs == null
      ? "text-zinc-500"
      : latencyMs < 150
        ? "text-green-400"
        : latencyMs < 350
          ? "text-yellow-400"
          : "text-red-400";

  return (
    <div
      className="pointer-events-none fixed left-1/2 z-[60] -translate-x-1/2"
      style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}
      aria-live="polite"
      title="Network / camera preview latency"
    >
      <div
        className={cn(
          "rounded-md bg-black/75 px-2.5 py-0.5 font-mono text-[11px] tabular-nums tracking-tight shadow-sm ring-1 ring-zinc-800",
          color
        )}
      >
        {latencyMs == null ? "— ms" : `${latencyMs} ms`}
      </div>
    </div>
  );
};

export default LatencyIndicator;
