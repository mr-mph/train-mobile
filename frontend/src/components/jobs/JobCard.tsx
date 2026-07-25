import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { JobRecord } from "@/lib/jobsApi";
import {
  Square,
  X,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  XCircle,
  ExternalLink,
  Play,
} from "lucide-react";
import { useApi } from "@/contexts/ApiContext";
import {
  JobCheckpoint,
  listJobCheckpoints,
} from "@/lib/checkpointsApi";
import CheckpointDropdown from "@/components/jobs/CheckpointDropdown";

interface Props {
  job: JobRecord;
  onStop: (id: string) => void;
  onDelete: (id: string) => void;
  onPlay: (job: JobRecord, step: number) => void;
}

function relativeTime(epochSec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - epochSec);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

const statePresentation: Record<
  JobRecord["state"],
  { label: string; color: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  running: { label: "Running", color: "text-green-400", Icon: Loader2 },
  done: { label: "Done", color: "text-zinc-400", Icon: CheckCircle2 },
  failed: { label: "Failed", color: "text-red-400", Icon: XCircle },
  interrupted: { label: "Interrupted", color: "text-green-400", Icon: AlertTriangle },
};

const JobCard: React.FC<Props> = ({ job, onStop, onDelete, onPlay }) => {
  const navigate = useNavigate();
  const { baseUrl, fetchWithHeaders } = useApi();
  const present = statePresentation[job.state];
  const Icon = present.Icon;
  const isRunning = job.state === "running";
  const isImported = job.runner === "imported";
  const importedSource = job.hf_repo_id || job.output_dir;
  const isProvisioning =
    isRunning &&
    Boolean(job.status_message) &&
    job.metrics.total_steps === 0;
  const isStarting = isRunning && job.metrics.total_steps === 0 && !isProvisioning;
  const stateLabel = isImported
    ? "Imported"
    : isProvisioning
      ? "Starting"
      : present.label;
  const progressPct =
    job.metrics.total_steps > 0
      ? Math.min(100, (job.metrics.current_step / job.metrics.total_steps) * 100)
      : 0;

  const [elapsedSec, setElapsedSec] = useState(() =>
    Math.max(0, Date.now() / 1000 - job.started_at),
  );

  useEffect(() => {
    if (!isProvisioning && !isStarting) return;
    const tick = () =>
      setElapsedSec(Math.max(0, Date.now() / 1000 - job.started_at));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isProvisioning, isStarting, job.started_at]);

  const subtitle = isImported
    ? importedSource
    : isProvisioning
      ? `${job.status_message} · ${formatElapsed(elapsedSec)}`
      : isStarting
        ? `starting… · ${formatElapsed(elapsedSec)}`
        : isRunning
          ? `started ${relativeTime(job.started_at)}`
          : job.ended_at != null
            ? `ended ${relativeTime(job.ended_at)}`
            : present.label.toLowerCase();

  const [checkpoints, setCheckpoints] = useState<JobCheckpoint[]>([]);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);

  useEffect(() => {
    if (job.checkpoint_count <= 0) {
      setCheckpoints([]);
      setSelectedStep(null);
      return;
    }
    let cancelled = false;
    listJobCheckpoints(baseUrl, fetchWithHeaders, job.id)
      .then((cks) => {
        if (cancelled) return;
        setCheckpoints(cks);
        if (cks.length > 0) {
          const latest = cks[cks.length - 1].step;
          setSelectedStep((prev) =>
            prev != null && cks.some((c) => c.step === prev) ? prev : latest,
          );
        } else {
          setSelectedStep(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCheckpoints([]);
          setSelectedStep(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, job.id, job.checkpoint_count]);

  const handleAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      if (window.confirm("Stop this run?")) onStop(job.id);
    } else if (isImported) {
      if (window.confirm("Remove this imported model? The source files are left untouched."))
        onDelete(job.id);
    } else if (window.confirm("Delete this run? This wipes the output directory.")) {
      onDelete(job.id);
    }
  };

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedStep == null) return;
    onPlay(job, selectedStep);
  };

  const showProgressBar = isRunning;
  const showInferenceRow = checkpoints.length > 0 && selectedStep != null;
  const progressLabel = isProvisioning
    ? `Waiting ${formatElapsed(elapsedSec)}`
    : isStarting
      ? "Training starting…"
      : `${progressPct.toFixed(1)}%`;

  return (
    <Card
      onClick={() => {
        if (!isImported) navigate(`/training/${job.id}`);
      }}
      className={`bg-black border-zinc-800 rounded-xl transition-colors ${
        isImported ? "" : "cursor-pointer hover:border-zinc-700"
      }`}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className={`flex items-center gap-1.5 text-xs font-semibold ${present.color}`}>
            <Icon className={`w-3.5 h-3.5 ${isRunning ? "animate-spin" : ""}`} />
            {stateLabel}
          </div>
          {job.runner === "hf_cloud" && job.hf_job_url ? (
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="h-7 w-7 text-zinc-400 hover:text-white"
              aria-label="Open Hub job page"
            >
              <a
                href={job.hf_job_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={handleAction}
              className="h-7 w-7 text-zinc-400 hover:text-white"
              aria-label={isRunning ? "Stop job" : "Delete job"}
            >
              {isRunning ? <Square className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
        <div>
          <div className="text-white font-semibold truncate" title={job.name}>
            {job.name}
          </div>
          {/* Imported subtitles are file paths — truncate the *start* (rtl
              flips the ellipsis to the left) so the more useful tail stays
              visible. The leading LRM keeps the path's first "/" from being
              bidi-reordered to the wrong end. */}
          <div
            className="text-xs text-zinc-400 truncate"
            title={subtitle}
            style={isImported ? { direction: "rtl", textAlign: "left" } : undefined}
          >
            {isImported ? "\u200e" + subtitle : subtitle}
          </div>
        </div>
        {showProgressBar ? (
          <div className="relative h-5 w-full overflow-hidden rounded-md bg-black border border-zinc-800">
            <div
              className="h-full bg-gradient-to-r from-green-600 to-green-400 transition-[width] duration-500"
              style={{ width: `${isProvisioning || isStarting ? 100 : progressPct}%` }}
            />
            {(isProvisioning || isStarting) && (
              <div className="absolute inset-0 bg-zinc-900/60" />
            )}
            <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-white tabular-nums drop-shadow">
              {progressLabel}
            </div>
          </div>
        ) : null}
        {showInferenceRow ? (
          <div className="flex items-center gap-2">
            <CheckpointDropdown
              checkpoints={checkpoints}
              selectedStep={selectedStep}
              onChange={setSelectedStep}
            />
            <Button
              size="icon"
              onClick={handlePlay}
              className="h-8 w-8 bg-green-500 hover:bg-green-600 text-white"
              aria-label="Run rollout with this checkpoint"
            >
              <Play className="w-4 h-4" />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default JobCard;
