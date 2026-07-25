import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useApi } from "@/contexts/ApiContext";

type LatencySource = "net" | `cam:${number}` | string;

interface LatencyContextValue {
  /** Best available latency in ms (camera preview preferred over API ping). */
  latencyMs: number | null;
  /** Report a sample from a live stream (e.g. camera preview). */
  reportLatency: (source: LatencySource, ms: number) => void;
  /** Clear a source when its feed unmounts / pauses. */
  clearLatency: (source: LatencySource) => void;
}

const LatencyContext = createContext<LatencyContextValue | null>(null);

const STALE_MS = 2500;
const NET_PING_MS = 2000;

export const LatencyProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const samplesRef = useRef<Map<LatencySource, { ms: number; at: number }>>(
    new Map()
  );
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const recompute = useCallback(() => {
    const now = performance.now();
    let camMax: number | null = null;
    let netMs: number | null = null;
    for (const [source, sample] of samplesRef.current) {
      if (now - sample.at > STALE_MS) {
        samplesRef.current.delete(source);
        continue;
      }
      if (typeof source === "string" && source.startsWith("cam:")) {
        camMax = camMax == null ? sample.ms : Math.max(camMax, sample.ms);
      } else if (source === "net") {
        netMs = sample.ms;
      }
    }
    setLatencyMs(camMax ?? netMs);
  }, []);

  const reportLatency = useCallback(
    (source: LatencySource, ms: number) => {
      if (!Number.isFinite(ms) || ms < 0) return;
      samplesRef.current.set(source, { ms: Math.round(ms), at: performance.now() });
      recompute();
    },
    [recompute]
  );

  const clearLatency = useCallback(
    (source: LatencySource) => {
      samplesRef.current.delete(source);
      recompute();
    },
    [recompute]
  );

  // Always-on API RTT so every page has a latency signal.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const ping = async () => {
      const t0 = performance.now();
      try {
        const res = await fetchWithHeaders(`${baseUrl}/health`, {
          cache: "no-store",
        });
        if (!cancelled && res.ok) {
          reportLatency("net", performance.now() - t0);
        }
      } catch {
        /* offline — leave last sample until stale */
      }
      if (!cancelled) {
        timer = window.setTimeout(ping, NET_PING_MS);
      }
    };

    void ping();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      samplesRef.current.delete("net");
    };
  }, [baseUrl, fetchWithHeaders, reportLatency]);

  const value = useMemo(
    () => ({ latencyMs, reportLatency, clearLatency }),
    [latencyMs, reportLatency, clearLatency]
  );

  return (
    <LatencyContext.Provider value={value}>{children}</LatencyContext.Provider>
  );
};

export function useLatency(): LatencyContextValue {
  const ctx = useContext(LatencyContext);
  if (!ctx) {
    throw new Error("useLatency must be used within LatencyProvider");
  }
  return ctx;
}
