import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Scissors,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";

type EpisodeMeta = {
  episode_index: number;
  length: number;
  trim?: { start_frame: number; end_frame: number } | null;
};

type DatasetMeta = {
  repo_id: string;
  fps: number;
  cameras: string[];
  episodes: EpisodeMeta[];
};

type TimeseriesPoint = {
  frame: number;
  timestamp: number;
  action?: number[];
  state?: number[];
};

type DatasetInfoState = {
  dataset_repo_id: string;
  single_task: string;
  num_episodes: number;
  saved_episodes?: number;
  session_elapsed_seconds?: number;
};

const EditDataset = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const repoId = params.get("repo") || "";
  const nextStep = params.get("next");
  const goToUploadNext = nextStep === "upload";
  const incomingDatasetInfo = (
    location.state as { datasetInfo?: DatasetInfoState } | null
  )?.datasetInfo;
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();

  const [meta, setMeta] = useState<DatasetMeta | null>(null);
  const [episodeIdx, setEpisodeIdx] = useState(0);
  const [camera, setCamera] = useState<string>("");
  const [points, setPoints] = useState<TimeseriesPoint[]>([]);
  const [videoInfo, setVideoInfo] = useState<{
    url: string;
    from_timestamp: number;
    to_timestamp: number;
  } | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [loading, setLoading] = useState(false);

  const episode = meta?.episodes[episodeIdx];

  const reloadMeta = useCallback(async () => {
    if (!repoId) return;
    const r = await fetchWithHeaders(
      `${baseUrl}/datasets/${encodeURIComponent(repoId)}/meta`,
    );
    if (!r.ok) throw new Error(await r.text());
    const body = (await r.json()) as DatasetMeta;
    setMeta(body);
    if (!camera && body.cameras[0]) setCamera(body.cameras[0]);
    setEpisodeIdx((i) => Math.min(i, Math.max(0, body.episodes.length - 1)));
  }, [baseUrl, fetchWithHeaders, repoId, camera]);

  useEffect(() => {
    if (!repoId) return;
    reloadMeta().catch((e) =>
      toast({
        title: "Dataset load failed",
        description: String(e),
        variant: "destructive",
      }),
    );
  }, [repoId, reloadMeta, toast]);

  useEffect(() => {
    if (!meta || !episode || !camera) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [tsRes, vRes] = await Promise.all([
          fetchWithHeaders(
            `${baseUrl}/datasets/${encodeURIComponent(repoId)}/episodes/${episode.episode_index}/timeseries`,
          ),
          fetchWithHeaders(
            `${baseUrl}/datasets/${encodeURIComponent(repoId)}/episodes/${episode.episode_index}/video-info/${encodeURIComponent(camera)}`,
          ),
        ]);
        if (!tsRes.ok || !vRes.ok) throw new Error("Failed to load episode");
        const ts = await tsRes.json();
        const vi = await vRes.json();
        if (cancelled) return;
        setPoints(ts.points || []);
        setVideoInfo({
          url: `${baseUrl}${vi.url}`,
          from_timestamp: vi.from_timestamp,
          to_timestamp: vi.to_timestamp,
        });
        const len = episode.length || 1;
        setTrimStart(episode.trim?.start_frame ?? 0);
        setTrimEnd(episode.trim?.end_frame ?? len);
      } catch (e) {
        toast({
          title: "Episode load failed",
          description: String(e),
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meta, episode, camera, baseUrl, fetchWithHeaders, repoId, toast]);

  const chartPath = useMemo(() => {
    if (!points.length) return "";
    const vals = points.map((p) =>
      Array.isArray(p.action) && p.action.length ? Number(p.action[0]) : 0,
    );
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const w = 320;
    const h = 80;
    return vals
      .map((v, i) => {
        const x = (i / Math.max(1, vals.length - 1)) * w;
        const y = h - ((v - min) / span) * (h - 8) - 4;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [points]);

  const onDelete = async () => {
    if (!episode) return;
    if (!confirm(`Remove episode ${episode.episode_index}?`)) return;
    const r = await fetchWithHeaders(
      `${baseUrl}/datasets/${encodeURIComponent(repoId)}/episodes/${episode.episode_index}`,
      { method: "DELETE" },
    );
    if (!r.ok) {
      toast({
        title: "Delete failed",
        description: await r.text(),
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Episode removed" });
    await reloadMeta();
  };

  const onTrim = async () => {
    if (!episode) return;
    const r = await fetchWithHeaders(
      `${baseUrl}/datasets/${encodeURIComponent(repoId)}/episodes/${episode.episode_index}/trim`,
      {
        method: "POST",
        body: JSON.stringify({
          start_frame: trimStart,
          end_frame: trimEnd,
        }),
      },
    );
    if (!r.ok) {
      toast({
        title: "Trim failed",
        description: await r.text(),
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Trim saved" });
    await reloadMeta();
  };

  const buildDatasetInfo = (): DatasetInfoState => {
    const n = meta?.episodes.length ?? incomingDatasetInfo?.num_episodes ?? 0;
    return {
      dataset_repo_id: repoId,
      single_task: incomingDatasetInfo?.single_task ?? "",
      num_episodes: n,
      saved_episodes: n,
      session_elapsed_seconds:
        incomingDatasetInfo?.session_elapsed_seconds ?? 0,
    };
  };

  const continueToUpload = () => {
    navigate("/upload", { state: { datasetInfo: buildDatasetInfo() } });
  };

  const leaveReview = () => {
    navigate(goToUploadNext ? "/?tab=record" : "/");
  };

  if (!repoId) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-4 gap-4">
        <p className="text-gray-400">Pick a dataset from the home screen.</p>
        <Button onClick={() => navigate("/")}>Back</Button>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-black text-white flex flex-col"
      style={{
        paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <header className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 sticky top-0 bg-black/95 z-20">
        <Button
          variant="ghost"
          size="icon"
          onClick={leaveReview}
          className="text-white"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="font-semibold truncate">
            {goToUploadNext ? "Review episodes" : "Dataset"}
          </h1>
          <p className="text-xs text-gray-400 truncate">{repoId}</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 max-w-lg mx-auto w-full">
        {goToUploadNext && (
          <p className="text-sm text-zinc-400">
            Review and soft-trim or remove bad episodes before uploading.
            Trims/deletes are for local review — Hub upload still uses the full
            on-disk dataset for now.
          </p>
        )}

        {meta && (
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="secondary"
              size="icon"
              disabled={episodeIdx <= 0}
              onClick={() => setEpisodeIdx((i) => Math.max(0, i - 1))}
              className="h-12 w-12"
            >
              <ChevronLeft />
            </Button>
            <div className="text-center">
              <div className="text-lg font-semibold">
                Episode {episode?.episode_index ?? "—"}
              </div>
              <div className="text-xs text-gray-400">
                {episodeIdx + 1} / {meta.episodes.length} · {episode?.length ?? 0}{" "}
                frames · {meta.fps} fps
              </div>
            </div>
            <Button
              variant="secondary"
              size="icon"
              disabled={episodeIdx >= meta.episodes.length - 1}
              onClick={() =>
                setEpisodeIdx((i) => Math.min(meta.episodes.length - 1, i + 1))
              }
              className="h-12 w-12"
            >
              <ChevronRight />
            </Button>
          </div>
        )}

        {meta && meta.cameras.length > 1 && (
          <div className="flex gap-2 overflow-x-auto">
            {meta.cameras.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={c === camera ? "default" : "outline"}
                onClick={() => setCamera(c)}
                className="shrink-0"
              >
                {c}
              </Button>
            ))}
          </div>
        )}

        <div className="rounded-lg overflow-hidden border border-zinc-800 bg-black aspect-video">
          {videoInfo ? (
            <video
              key={videoInfo.url + String(videoInfo.from_timestamp)}
              src={`${videoInfo.url}#t=${videoInfo.from_timestamp},${videoInfo.to_timestamp}`}
              controls
              playsInline
              className="w-full h-full object-contain bg-black"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
              {loading ? "Loading…" : "No video"}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-zinc-800 bg-black p-3">
          <p className="text-xs text-gray-400 mb-2">Action[0] over time</p>
          <svg viewBox="0 0 320 80" className="w-full h-20">
            <path d={chartPath} fill="none" stroke="#4ade80" strokeWidth="2" />
          </svg>
        </div>

        <div className="space-y-3 rounded-lg border border-zinc-800 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Scissors className="w-4 h-4" /> Trim episode
          </div>
          <label className="block text-xs text-gray-400">
            Start frame
            <input
              type="range"
              min={0}
              max={Math.max(1, (episode?.length ?? 1) - 1)}
              value={trimStart}
              onChange={(e) => setTrimStart(Number(e.target.value))}
              className="w-full"
            />
            <span className="text-white">{trimStart}</span>
          </label>
          <label className="block text-xs text-gray-400">
            End frame
            <input
              type="range"
              min={1}
              max={episode?.length ?? 1}
              value={trimEnd}
              onChange={(e) => setTrimEnd(Number(e.target.value))}
              className="w-full"
            />
            <span className="text-white">{trimEnd}</span>
          </label>
          <Button onClick={onTrim} className="w-full h-12">
            Save trim
          </Button>
        </div>

        <Button
          variant="destructive"
          className="w-full h-12"
          onClick={onDelete}
        >
          <Trash2 className="w-4 h-4 mr-2" /> Remove episode
        </Button>

        {goToUploadNext ? (
          <div className="space-y-2 pt-2 border-t border-zinc-800">
            <Button
              onClick={continueToUpload}
              className="w-full h-12 bg-green-500 hover:bg-green-600 text-black font-semibold"
            >
              <Upload className="w-4 h-4 mr-2" />
              Continue to upload
            </Button>
            <Button
              variant="outline"
              onClick={leaveReview}
              className="w-full h-11 border-zinc-700"
            >
              Done without uploading
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default EditDataset;
