import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/contexts/ApiContext";
import { useHfAuth } from "@/contexts/HfAuthContext";

import { TrainingConfig, TrainingStatus, LogEntry } from "@/components/training/types";
import TrainingHeader from "@/components/training/TrainingHeader";
import ConfigurationTab from "@/components/training/ConfigurationTab";
import MonitoringStats from "@/components/training/monitoring/MonitoringStats";
import TrainingLogs from "@/components/training/monitoring/TrainingLogs";
import TrainingExtraGate from "@/components/training/TrainingExtraGate";
import PolicyExtraDialog from "@/components/training/PolicyExtraDialog";
import HfAuthBanner from "@/components/landing/HfAuthBanner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Loader2, Play, Square, Trash2, ArrowLeft } from "lucide-react";

import { DatasetItem, listDatasets } from "@/lib/replayApi";
import {
  JobRecord,
  TrainingRequest,
  getJob,
  getJobLogs,
  getJobLogFile,
  listJobs,
  startTrainingJob,
  stopJob,
  deleteJob,
  listRunnerHardware,
  RunnerFlavor,
} from "@/lib/jobsApi";
import { JobCheckpoint, listJobCheckpoints } from "@/lib/checkpointsApi";
import CheckpointDropdown from "@/components/jobs/CheckpointDropdown";
import InferenceModal from "@/components/landing/InferenceModal";
import { useRobots } from "@/hooks/useRobots";

const POLL_INTERVAL_MS = 1000;
const MAX_LOG_LINES = 5000;

function jobToStatus(job: JobRecord | null, isStarting: boolean): TrainingStatus {
  // Adapter so MonitoringStats can keep its current prop shape.
  if (!job) {
    return {
      training_active: isStarting,
      current_step: 0,
      total_steps: 0,
      available_controls: { stop_training: false, pause_training: false, resume_training: false },
    };
  }
  return {
    training_active: job.state === "running",
    current_step: job.metrics.current_step,
    total_steps: job.metrics.total_steps,
    current_loss: job.metrics.current_loss ?? undefined,
    current_lr: job.metrics.current_lr ?? undefined,
    grad_norm: job.metrics.grad_norm ?? undefined,
    eta_seconds: job.metrics.eta_seconds ?? undefined,
    available_controls: {
      stop_training: job.state === "running",
      pause_training: false,
      resume_training: false,
    },
  };
}

function configToRequest(c: TrainingConfig): TrainingRequest {
  // The backend's TrainingRequest has more optional fields; the form covers
  // the user-meaningful subset.
  return {
    target: c.target,
    dataset_repo_id: c.dataset_repo_id,
    policy_type: c.policy_type,
    steps: c.steps,
    batch_size: c.batch_size,
    seed: c.seed,
    num_workers: c.num_workers,
    log_freq: c.log_freq,
    save_freq: c.save_freq,
    save_checkpoint: c.save_checkpoint,
    resume: c.resume,
    wandb_enable: c.wandb_enable,
    wandb_project: c.wandb_project,
    wandb_entity: c.wandb_entity,
    wandb_notes: c.wandb_notes,
    wandb_mode: c.wandb_mode,
    wandb_disable_artifact: c.wandb_disable_artifact,
    policy_device: c.policy_device,
    policy_use_amp: c.policy_use_amp,
    optimizer_type: c.optimizer_type,
    optimizer_lr: c.optimizer_lr,
    optimizer_weight_decay: c.optimizer_weight_decay,
    optimizer_grad_clip_norm: c.optimizer_grad_clip_norm,
    use_policy_training_preset: c.use_policy_training_preset,
  };
}

const ConfigurationMode: React.FC = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { auth } = useHfAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const prefilledDatasetRepoId =
    (location.state as { datasetRepoId?: string } | null)?.datasetRepoId ?? "";

  const [trainingConfig, setTrainingConfig] = useState<TrainingConfig>({
    target: { runner: "local" },
    dataset_repo_id: prefilledDatasetRepoId,
    policy_type: "act",
    steps: 10000,
    batch_size: 8,
    seed: 1000,
    num_workers: 4,
    log_freq: 250,
    save_freq: 1000,
    save_checkpoint: true,
    resume: false,
    wandb_enable: false,
    wandb_mode: "online",
    wandb_disable_artifact: false,
    policy_device: "cuda",
    policy_use_amp: false,
    optimizer_type: "adam",
    use_policy_training_preset: true,
  });

  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [trainingExtraAvailable, setTrainingExtraAvailable] = useState<boolean | null>(null);
  const [trainingExtraInstallHint, setTrainingExtraInstallHint] = useState<string>("pip install accelerate");
  const [localJobRunning, setLocalJobRunning] = useState<boolean>(false);
  const [isStarting, setIsStarting] = useState(false);
  const [policyExtra, setPolicyExtra] = useState<{
    policyType: string;
    packageName: string;
    installTarget: string;
    installHint: string;
  } | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [flavors, setFlavors] = useState<RunnerFlavor[]>([]);
  const [hardwareLoading, setHardwareLoading] = useState(true);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [hardwareTick, setHardwareTick] = useState(0);

  useEffect(() => {
    setDatasetsLoading(true);
    listDatasets(baseUrl, fetchWithHeaders)
      .then(setDatasets)
      .catch(() => setDatasets([]))
      .finally(() => setDatasetsLoading(false));
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    fetchWithHeaders(`${baseUrl}/system/training-extra`)
      .then((r) => r.json())
      .then((data: { available: boolean; install_hint: string }) => {
        setTrainingExtraAvailable(data.available);
        setTrainingExtraInstallHint(data.install_hint);
      })
      .catch(() => setTrainingExtraAvailable(true));
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    // Only the local lock matters for the Start button; cloud jobs can stack.
    // Pull a generous slice so a running local isn't masked by newer cloud
    // jobs in the started_at-desc ordering.
    listJobs(baseUrl, fetchWithHeaders, 200)
      .then((j) =>
        setLocalJobRunning(
          j.some((r) => r.runner === "local" && r.state === "running"),
        ),
      )
      .catch(() => setLocalJobRunning(false));
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    // Re-fetches when auth status flips (e.g. user pastes a token in
    // HfAuthBanner) so flavors unlock without a page reload.
    setHardwareLoading(true);
    listRunnerHardware(baseUrl, fetchWithHeaders)
      .then((data) => {
        setAuthenticated(data.authenticated);
        setFlavors(data.flavors);
        setHardwareError(data.error ?? null);
      })
      .catch((e) => {
        setAuthenticated(false);
        setFlavors([]);
        setHardwareError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setHardwareLoading(false));
  }, [baseUrl, fetchWithHeaders, auth.status, hardwareTick]);

  const updateConfig = <T extends keyof TrainingConfig>(key: T, value: TrainingConfig[T]) => {
    setTrainingConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleStart = async () => {
    if (!trainingConfig.dataset_repo_id.trim()) {
      toast({ title: "Error", description: "Dataset repository ID is required", variant: "destructive" });
      return;
    }

    // Pre-flight: smolvla/pi0/diffusion need an optional package installed
    // locally. Catch it here with a one-click installer instead of a buried
    // ImportError after the job has already started. Cloud jobs run in their
    // own environment, so the local package is irrelevant — skip the check.
    if (trainingConfig.target.runner === "local") {
      try {
        const r = await fetchWithHeaders(
          `${baseUrl}/system/policy-extra/${trainingConfig.policy_type}`,
        );
        if (r.ok) {
          const extra = await r.json();
          if (extra.needs_extra && !extra.available) {
            setPolicyExtra({
              policyType: trainingConfig.policy_type,
              packageName: extra.package,
              installTarget: extra.install_target,
              installHint: extra.install_hint,
            });
            return;
          }
        }
      } catch {
        // Check failed (offline / older backend) — fall through and let the
        // job report any problem itself.
      }
    }

    setIsStarting(true);
    try {
      const job = await startTrainingJob(baseUrl, fetchWithHeaders, configToRequest(trainingConfig));
      const isVast = trainingConfig.target.runner === "vast";
      toast({
        title: isVast ? "Provisioning Vast…" : "Training Started",
        description: isVast
          ? `${job.name} — status is on the Jobs screen`
          : job.name,
      });
      // Vast provision can take minutes; leave the config page and show live
      // status on the main Jobs list instead of blocking here.
      navigate(isVast ? "/?tab=train" : `/training/${job.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Error", description: msg, variant: "destructive" });
      // If the failure was the 409 case, refresh our running-job knowledge.
      listJobs(baseUrl, fetchWithHeaders, 200)
        .then((j) =>
          setLocalJobRunning(
            j.some((r) => r.runner === "local" && r.state === "running"),
          ),
        )
        .catch(() => {});
    } finally {
      setIsStarting(false);
    }
  };

  if (trainingExtraAvailable === null) {
    return (
      <div className="min-h-screen bg-black text-white p-4">
        <div className="max-w-7xl mx-auto">
          <TrainingHeader />
          <div className="flex items-center justify-center py-24 text-zinc-400">
            <Loader2 className="w-6 h-6 animate-spin mr-3" />
            Checking training environment…
          </div>
        </div>
      </div>
    );
  }

  if (trainingExtraAvailable === false) {
    return (
      <div className="min-h-screen bg-black text-white p-4">
        <div className="max-w-7xl mx-auto">
          <TrainingHeader />
          <TrainingExtraGate installHint={trainingExtraInstallHint} />
        </div>
      </div>
    );
  }

  const targetRequiresAuth = trainingConfig.target.runner === "hf_cloud";
  const targetMissingFlavor =
    (trainingConfig.target.runner === "hf_cloud" &&
      !trainingConfig.target.flavor) ||
    (trainingConfig.target.runner === "vast" && !trainingConfig.target.offer_id);
  const localBlocked =
    trainingConfig.target.runner === "local" && localJobRunning;
  const startDisabled =
    isStarting ||
    !trainingConfig.dataset_repo_id.trim() ||
    localBlocked ||
    (targetRequiresAuth && !authenticated) ||
    targetMissingFlavor;
  const startTooltip = localBlocked
    ? "Another local training is already running"
    : targetRequiresAuth && !authenticated
    ? "Log in to Hugging Face to use cloud compute"
    : targetMissingFlavor
    ? trainingConfig.target.runner === "vast"
      ? "Select a Vast GPU offer"
      : "Select a hardware flavor"
    : undefined;

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-7xl mx-auto">
        <TrainingHeader />
        <HfAuthBanner />
        <ConfigurationTab
          config={trainingConfig}
          updateConfig={updateConfig}
          datasets={datasets}
          datasetsLoading={datasetsLoading}
          authenticated={authenticated}
          flavors={flavors}
          hardwareLoading={hardwareLoading}
          hardwareError={hardwareError}
          onRetryHardware={() => setHardwareTick((t) => t + 1)}
        />
        <div className="max-w-3xl mx-auto mt-6 flex justify-end">
          {(() => {
            const startButton = (
              <Button
                onClick={handleStart}
                disabled={startDisabled}
                size="lg"
                className="bg-green-500 hover:bg-green-600 text-white font-semibold px-6"
              >
                {isStarting ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Starting…
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 mr-2" /> Start Training
                  </>
                )}
              </Button>
            );
            // Native `title` doesn't fire reliably on disabled buttons across
            // browsers — and since Radix's tooltip relies on pointer events
            // that a disabled button swallows, wrap in a span so the trigger
            // still receives hover/focus.
            if (!startTooltip) return startButton;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>{startButton}</span>
                </TooltipTrigger>
                <TooltipContent>{startTooltip}</TooltipContent>
              </Tooltip>
            );
          })()}
        </div>
      </div>

      {policyExtra && (
        <PolicyExtraDialog
          open={!!policyExtra}
          onOpenChange={(o) => !o && setPolicyExtra(null)}
          policyType={policyExtra.policyType}
          packageName={policyExtra.packageName}
          installTarget={policyExtra.installTarget}
          installHint={policyExtra.installHint}
        />
      )}
    </div>
  );
};

const MonitoringMode: React.FC<{ jobId: string }> = ({ jobId }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const navigate = useNavigate();

  const { selectedRecord } = useRobots();
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const [checkpoints, setCheckpoints] = useState<JobCheckpoint[]>([]);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [inferenceModalOpen, setInferenceModalOpen] = useState(false);

  // Seed logs from the persistent on-disk file once on mount, so navigating
  // away and back (or coming in fresh on a finished/interrupted job) shows
  // the full log history. Polling /logs continues from this point — the
  // backend drains the live queue in the same /log-file call so we don't
  // double-display lines that were buffered when we landed.
  useEffect(() => {
    let cancelled = false;
    getJobLogFile(baseUrl, fetchWithHeaders, jobId)
      .then((seeded) => {
        if (!cancelled && seeded.length > 0) setLogs(seeded);
      })
      .catch(() => {
        // 404 or transient — fall through; live polling will fill in.
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders, jobId]);

  // Read latest job state from a ref so the polling intervals below stay
  // stable instead of tearing down/rebuilding on every state transition.
  const jobStateRef = useRef(job?.state);
  jobStateRef.current = job?.state;

  // Poll checkpoints — every 5s while the job is running.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      listJobCheckpoints(baseUrl, fetchWithHeaders, jobId)
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
    };
    tick();
    const id = setInterval(() => {
      if (cancelled) return;
      if (jobStateRef.current && jobStateRef.current !== "running") return;
      tick();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders, jobId]);

  // Poll the job + its logs while running. Caps log lines to avoid unbounded growth.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getJob(baseUrl, fetchWithHeaders, jobId);
        if (cancelled) return;
        setJob(next);
        if (next.state === "running") {
          const newLogs = await getJobLogs(baseUrl, fetchWithHeaders, jobId);
          if (!cancelled && newLogs.length > 0) {
            setLogs((prev) => {
              const merged = [...prev, ...newLogs];
              return merged.length > MAX_LOG_LINES
                ? merged.slice(merged.length - MAX_LOG_LINES)
                : merged;
            });
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const id = setInterval(() => {
      if (cancelled) return;
      if (jobStateRef.current && jobStateRef.current !== "running") return;
      tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [baseUrl, fetchWithHeaders, jobId]);

  // Auto-scroll the log panel as new lines arrive.
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const getProgressPercentage = () => {
    if (!job || job.metrics.total_steps === 0) return 0;
    return (job.metrics.current_step / job.metrics.total_steps) * 100;
  };

  const handleStop = async () => {
    if (!job) return;
    if (!window.confirm("Stop this run?")) return;
    try {
      const next = await stopJob(baseUrl, fetchWithHeaders, job.id);
      setJob(next);
      toast({ title: "Stopping…" });
    } catch (e) {
      toast({
        title: "Stop failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const handleDelete = async () => {
    if (!job) return;
    if (!window.confirm("Delete this run? This wipes the output directory.")) return;
    try {
      await deleteJob(baseUrl, fetchWithHeaders, job.id);
      toast({ title: "Job removed" });
      navigate("/");
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  const handleSaveModel = async () => {
    if (!job) return;
    const checkpoints = await listJobCheckpoints(baseUrl, fetchWithHeaders, job.id).catch(
      () => [],
    );
    const last = checkpoints[checkpoints.length - 1];
    const policyRef = last?.ref || job.hf_repo_id || job.output_dir;
    if (!policyRef) {
      toast({
        title: "Nothing to save",
        description: "No checkpoint found yet.",
        variant: "destructive",
      });
      return;
    }
    const name = window.prompt("Model name", job.name) || job.name;
    const r = await fetchWithHeaders(`${baseUrl}/models`, {
      method: "POST",
      body: JSON.stringify({
        name,
        policy_ref: policyRef,
        source: job.runner === "vast" ? "vast" : job.runner === "hf_cloud" ? "hf" : "local",
        job_id: job.id,
        dataset_repo_id: job.config?.dataset_repo_id,
        steps: job.metrics?.current_step,
        activate: true,
      }),
    });
    if (!r.ok) {
      toast({
        title: "Save failed",
        description: await r.text(),
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Saved to TrainMobile models" });
  };

  if (error && !job) {
    return (
      <div className="min-h-screen bg-black text-white p-4">
        <div className="max-w-7xl mx-auto space-y-4">
          <Button variant="ghost" onClick={() => navigate("/")} className="text-zinc-400">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Jobs
          </Button>
          <p className="text-red-300">Couldn't load job {jobId}: {error}</p>
        </div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="min-h-screen bg-black text-white p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-center py-24 text-zinc-400">
          <Loader2 className="w-6 h-6 animate-spin mr-3" /> Loading job…
        </div>
      </div>
    );
  }

  const isRunning = job.state === "running";
  const isProvisioning =
    isRunning && Boolean(job.status_message) && job.metrics.total_steps === 0;
  const [provisionElapsed, setProvisionElapsed] = useState(() =>
    Math.max(0, Date.now() / 1000 - job.started_at),
  );

  useEffect(() => {
    if (!isProvisioning) return;
    const tick = () =>
      setProvisionElapsed(Math.max(0, Date.now() / 1000 - job.started_at));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isProvisioning, job.started_at]);

  const formatElapsed = (seconds: number): string => {
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
  };

  return (
    <div className="min-h-screen bg-black text-white p-4">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => navigate("/?tab=train")} className="text-zinc-400 hover:text-white">
              <ArrowLeft className="w-4 h-4 mr-2" /> Jobs
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-white">{job.name}</h1>
                {job.runner === "hf_cloud" ? (
                  <span className="text-xs px-2 py-0.5 rounded bg-green-500 text-green-400 border border-green-700">
                    HF · {job.hf_flavor ?? "cloud"}
                  </span>
                ) : job.runner === "vast" ? (
                  <span className="text-xs px-2 py-0.5 rounded bg-green-900/40 text-green-300 border border-green-700">
                    Vast · {job.hf_flavor ?? "gpu"}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded bg-zinc-900 text-zinc-200 border border-zinc-800">
                    Local
                  </span>
                )}
                {job.runner === "hf_cloud" && job.hf_repo_id && job.state === "done" && (
                  <a
                    href={`https://huggingface.co/${job.hf_repo_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-green-400 hover:text-green-400 underline"
                  >
                    View on Hub ↗
                  </a>
                )}
                {job.wandb_run_url && (
                  <a
                    href={job.wandb_run_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-green-400 hover:text-green-400 underline"
                  >
                    View on W&B ↗
                  </a>
                )}
              </div>
              <p className="text-xs text-zinc-400">
                {isProvisioning
                  ? `${job.status_message} · ${formatElapsed(provisionElapsed)}`
                  : job.state}
                {job.error_message ? ` — ${job.error_message}` : ""}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {!isRunning && (
              <Button
                onClick={handleSaveModel}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                Save model
              </Button>
            )}
            {isRunning ? (
              <Button onClick={handleStop} className="bg-red-500 hover:bg-red-600 text-white">
                <Square className="w-4 h-4 mr-2" /> Stop
              </Button>
            ) : (
              <Button onClick={handleDelete} variant="ghost" className="text-zinc-400 hover:text-white">
                <Trash2 className="w-4 h-4 mr-2" /> Delete
              </Button>
            )}
          </div>
        </div>

        <MonitoringStats
          jobId={jobId}
          trainingStatus={jobToStatus(job, false)}
          getProgressPercentage={getProgressPercentage}
          formatTime={formatTime}
        />
        <div className="bg-black border border-zinc-800 rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold text-zinc-300">Run rollout</span>
            {checkpoints.length === 0 ? (
              <span className="text-xs text-zinc-500">
                No checkpoints yet — wait for the first save.
              </span>
            ) : (
              <>
                <CheckpointDropdown
                  checkpoints={checkpoints}
                  selectedStep={selectedStep}
                  onChange={setSelectedStep}
                />
                <Button
                  onClick={() => {
                    if (job.runner === "local" && isRunning) {
                      const ok = window.confirm(
                        "Local training is using the GPU — roll out anyway? This may slow or stall training.",
                      );
                      if (!ok) return;
                    }
                    setInferenceModalOpen(true);
                  }}
                  disabled={selectedStep == null}
                  className="bg-green-500 hover:bg-green-600 text-white"
                >
                  <Play className="w-4 h-4 mr-2" />
                  Run on robot
                </Button>
              </>
            )}
          </div>
          {isRunning &&
            (job.runner === "hf_cloud" || job.runner === "vast") &&
            checkpoints.length > 0 && (
              <p className="text-xs text-zinc-500">
                Training continues on the cloud — roll out uses the selected
                checkpoint without pausing the job.
              </p>
            )}
        </div>
        <InferenceModal
          open={inferenceModalOpen}
          onOpenChange={setInferenceModalOpen}
          robot={selectedRecord}
          jobId={jobId}
          initialStep={selectedStep}
        />
        <TrainingLogs logs={logs} logContainerRef={logContainerRef} />
      </div>
    </div>
  );
};

const Training: React.FC = () => {
  const { jobId } = useParams<{ jobId?: string }>();
  return jobId ? <MonitoringMode jobId={jobId} /> : <ConfigurationMode />;
};

export default Training;
