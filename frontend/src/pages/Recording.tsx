import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  RotateCcw,
  Square,
  Play,
  Pause,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  getMuted,
  setMuted as persistMuted,
  playRecordingStartCue,
  playResetStartCue,
} from "@/lib/recordingAudio";
import { useApi } from "@/contexts/ApiContext";
import RecordingCameraFeed from "@/components/control/RecordingCameraFeed";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface RecordingConfig {
  leader_port: string;
  follower_port: string;
  leader_config: string;
  follower_config: string;
  dataset_repo_id: string;
  single_task: string;
  fps: number;
  video: boolean;
  push_to_hub: boolean;
  resume: boolean;
  streaming_encoding: boolean;
  cameras?: Record<
    string,
    { camera_index?: number; type?: string; [key: string]: unknown }
  >;
}

type Phase = "preparing" | "ready" | "resetting" | "recording" | "completed";

interface BackendStatus {
  recording_active: boolean;
  current_phase: string;
  paused?: boolean;
  preview_ready?: boolean;
  preview_cameras?: string[];
  current_episode?: number;
  total_episodes?: number | null;
  saved_episodes?: number;
  phase_elapsed_seconds?: number;
  phase_time_limit_s?: number | null;
  session_elapsed_seconds?: number;
  session_ended?: boolean;
  dataset_repo_id?: string;
  error?: string;
  available_controls: {
    stop_recording: boolean;
    start_episode?: boolean;
    end_episode?: boolean;
    restart_episode?: boolean;
    pause_episode?: boolean;
    resume_episode?: boolean;
    exit_early?: boolean;
    rerecord_episode?: boolean;
  };
}

const Recording = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { baseUrl, fetchWithHeaders } = useApi();

  const recordingConfig = location.state?.recordingConfig as RecordingConfig;

  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(
    null
  );
  const [recordingSessionStarted, setRecordingSessionStarted] = useState(false);
  const [optimisticPhase, setOptimisticPhase] = useState<Phase | null>(null);
  const [optimisticPaused, setOptimisticPaused] = useState<boolean | null>(
    null
  );
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [muted, setMutedState] = useState<boolean>(() => getMuted());
  const prevRealPhaseRef = useRef<Phase | null>(null);
  const startInitiatedRef = useRef(false);

  const toggleMute = useCallback(() => {
    setMutedState((prev) => {
      const next = !prev;
      persistMuted(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!recordingConfig) {
      toast({
        title: "No Configuration",
        description: "Please start recording from the main page.",
        variant: "destructive",
      });
      navigate("/");
    }
  }, [recordingConfig, navigate, toast]);

  useEffect(() => {
    if (recordingConfig && !startInitiatedRef.current) {
      startInitiatedRef.current = true;
      void startRecordingSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingConfig]);

  const optimisticPhaseRef = useRef(optimisticPhase);
  optimisticPhaseRef.current = optimisticPhase;

  useEffect(() => {
    if (!recordingSessionStarted) return;

    const pollStatus = async () => {
      try {
        const response = await fetchWithHeaders(`${baseUrl}/recording-status`);
        if (!response.ok) return;
        const status = await response.json();
        setBackendStatus(status);

        const currentOptimistic = optimisticPhaseRef.current;
        if (currentOptimistic && status.current_phase === currentOptimistic) {
          setOptimisticPhase(null);
        }
        if (
          optimisticPaused !== null &&
          Boolean(status.paused) === optimisticPaused
        ) {
          setOptimisticPaused(null);
        }

        const real = status.current_phase as Phase;
        const prev = prevRealPhaseRef.current;
        if (prev !== real) {
          if (real === "recording" && prev !== null) {
            playRecordingStartCue();
          } else if (
            (real === "ready" || real === "resetting") &&
            prev === "recording"
          ) {
            playResetStartCue();
          }
          prevRealPhaseRef.current = real;
        }

        if (!status.recording_active && status.session_ended) {
          if (status.current_phase === "error") {
            const saved = status.saved_episodes || 0;
            toast({
              title: saved > 0 ? "Recording Interrupted" : "Recording Failed",
              description:
                saved > 0
                  ? `${saved} episode(s) were saved before the session failed: ${status.error || "unknown error"}`
                  : status.error || "The recording session failed to start.",
              variant: "destructive",
            });
            if (saved === 0) {
              navigate("/");
              return;
            }
          }
          const datasetInfo = {
            dataset_repo_id:
              status.dataset_repo_id || recordingConfig.dataset_repo_id,
            single_task: recordingConfig.single_task,
            num_episodes: status.saved_episodes || 0,
            saved_episodes: status.saved_episodes || 0,
            session_elapsed_seconds: status.session_elapsed_seconds || 0,
          };
          const repoId = datasetInfo.dataset_repo_id;
          navigate(
            `/edit-dataset?repo=${encodeURIComponent(repoId)}&next=upload`,
            { state: { datasetInfo } },
          );
        }
      } catch (error) {
        console.error("Error polling recording status:", error);
      }
    };

    void pollStatus();
    const statusInterval = setInterval(pollStatus, 1000);
    return () => clearInterval(statusInterval);
  }, [
    recordingSessionStarted,
    recordingConfig,
    navigate,
    baseUrl,
    fetchWithHeaders,
    toast,
    optimisticPaused,
  ]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const startRecordingSession = async () => {
    try {
      const response = await fetchWithHeaders(`${baseUrl}/start-recording`, {
        method: "POST",
        body: JSON.stringify(recordingConfig),
      });

      const data = await response.json();

      if (response.ok) {
        setRecordingSessionStarted(true);
        toast({
          title: "Session ready",
          description: "Press Start episode when you're set.",
        });
      } else {
        toast({
          title: "Error Starting Recording",
          description: data.message || "Failed to start recording session.",
          variant: "destructive",
        });
        navigate("/");
      }
    } catch {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
      navigate("/");
    }
  };

  const handleStartOrEndEpisode = useCallback(async () => {
    const controls = backendStatus?.available_controls;
    if (!controls?.exit_early && !controls?.start_episode && !controls?.end_episode)
      return;
    if (optimisticPhase !== null) return;

    const realPhase = backendStatus!.current_phase as Phase;
    const next: Phase | null =
      realPhase === "recording"
        ? "ready"
        : realPhase === "ready" || realPhase === "resetting"
          ? "recording"
          : null;
    if (!next) return;

    setOptimisticPhase(next);
    setOptimisticPaused(null);

    try {
      const response = await fetchWithHeaders(
        `${baseUrl}/recording-exit-early`,
        { method: "POST" }
      );
      if (!response.ok) {
        const data = await response.json();
        setOptimisticPhase(null);
        toast({
          title: "Error",
          description: data.message,
          variant: "destructive",
        });
      }
    } catch {
      setOptimisticPhase(null);
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  }, [backendStatus, optimisticPhase, baseUrl, fetchWithHeaders, toast]);

  const handleRestartEpisode = useCallback(async () => {
    const controls = backendStatus?.available_controls;
    if (!controls?.restart_episode && !controls?.rerecord_episode) return;

    setOptimisticPaused(null);
    try {
      const response = await fetchWithHeaders(
        `${baseUrl}/recording-rerecord-episode`,
        { method: "POST" }
      );
      const data = await response.json();
      if (response.ok) {
        toast({
          title: "Restarting episode",
          description: `Episode ${backendStatus?.current_episode ?? ""} will be recorded again.`,
        });
      } else {
        toast({
          title: "Error",
          description: data.message,
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  }, [backendStatus, baseUrl, fetchWithHeaders, toast]);

  const handlePauseToggle = useCallback(async () => {
    if (!backendStatus) return;
    const controls = backendStatus.available_controls;
    const paused =
      optimisticPaused !== null
        ? optimisticPaused
        : Boolean(backendStatus.paused);
    const path = paused ? "/recording-resume" : "/recording-pause";
    if (paused && !controls.resume_episode && !controls.pause_episode) return;
    if (!paused && !controls.pause_episode) return;

    setOptimisticPaused(!paused);
    try {
      const response = await fetchWithHeaders(`${baseUrl}${path}`, {
        method: "POST",
      });
      if (!response.ok) {
        const data = await response.json();
        setOptimisticPaused(null);
        toast({
          title: "Error",
          description: data.message,
          variant: "destructive",
        });
      }
    } catch {
      setOptimisticPaused(null);
      toast({
        title: "Connection Error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    }
  }, [backendStatus, optimisticPaused, baseUrl, fetchWithHeaders, toast]);

  const handleStopRecording = useCallback(async () => {
    if (!backendStatus?.available_controls.stop_recording) return;
    try {
      await fetchWithHeaders(`${baseUrl}/stop-recording`, {
        method: "POST",
      });
      toast({
        title: "Ending session",
        description: "Finalizing dataset…",
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to stop recording.",
        variant: "destructive",
      });
    }
  }, [backendStatus, baseUrl, fetchWithHeaders, toast]);

  const requestStopRecording = useCallback(() => {
    if (!backendStatus?.available_controls.stop_recording) return;
    setShowStopConfirm(true);
  }, [backendStatus]);

  const confirmStopRecording = useCallback(async () => {
    setShowStopConfirm(false);
    await handleStopRecording();
  }, [handleStopRecording]);

  const cameraNames = useMemo(() => {
    const fromStatus = backendStatus?.preview_cameras;
    if (fromStatus && fromStatus.length > 0) return fromStatus;
    return Object.keys(recordingConfig?.cameras ?? {});
  }, [backendStatus?.preview_cameras, recordingConfig?.cameras]);

  if (!recordingConfig) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-lg">No recording configuration found.</p>
          <Button onClick={() => navigate("/")} className="mt-4">
            Return to Home
          </Button>
        </div>
      </div>
    );
  }

  if (!backendStatus) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-500 mx-auto mb-4"></div>
          <p className="text-lg">Connecting to recording session...</p>
        </div>
      </div>
    );
  }

  const realPhase = backendStatus.current_phase as Phase;
  const currentPhase: Phase = optimisticPhase ?? realPhase;
  const isReady = currentPhase === "ready" || currentPhase === "resetting";
  const isRecording = currentPhase === "recording";
  const isPaused =
    optimisticPaused !== null
      ? optimisticPaused
      : Boolean(backendStatus.paused) && isRecording;
  const currentEpisode = backendStatus.current_episode ?? 1;
  const savedEpisodes = backendStatus.saved_episodes ?? 0;
  const phaseElapsedTime = optimisticPhase
    ? 0
    : backendStatus.phase_elapsed_seconds || 0;
  const sessionElapsedTime = backendStatus.session_elapsed_seconds || 0;
  const controls = backendStatus.available_controls;

  const statusText =
    currentPhase === "preparing"
      ? "PREPARING SESSION"
      : isRecording && isPaused
        ? `PAUSED · EPISODE ${currentEpisode}`
        : isRecording
          ? `RECORDING EPISODE ${currentEpisode}`
          : isReady
            ? savedEpisodes > 0
              ? `READY · START EPISODE ${currentEpisode}`
              : `READY · START EPISODE ${currentEpisode}`
            : "SESSION COMPLETE";

  const phaseColor = isRecording
    ? isPaused
      ? {
          dot: "bg-yellow-500",
          pill: "bg-yellow-500/15 text-yellow-300",
          timer: "text-yellow-400",
        }
      : {
          dot: "bg-red-500",
          pill: "bg-red-500/15 text-red-300",
          timer: "text-green-400",
        }
    : isReady
      ? {
          dot: "bg-green-500",
          pill: "bg-green-500/15 text-green-400",
          timer: "text-green-400",
        }
      : {
          dot: "bg-gray-500",
          pill: "bg-gray-500/15 text-gray-300",
          timer: "text-gray-400",
        };

  const startLabel =
    savedEpisodes > 0 ? "Start new episode" : "Start episode";

  const canAdvance =
    (isReady && (controls.start_episode ?? controls.exit_early)) ||
    (isRecording && (controls.end_episode ?? controls.exit_early));
  const canRestart =
    isRecording && (controls.restart_episode ?? controls.rerecord_episode);
  const canPauseToggle =
    isRecording &&
    (isPaused
      ? (controls.resume_episode ?? true)
      : (controls.pause_episode ?? false));

  const previewReady = Boolean(backendStatus.preview_ready);

  return (
    <div
      className="min-h-screen bg-black text-white flex flex-col"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/")}
          className="h-9 w-9 text-gray-400 hover:text-white hover:bg-black flex-shrink-0"
          aria-label="Back to home"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <div
            role="status"
            aria-live="polite"
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-widest ${phaseColor.pill}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${phaseColor.dot} ${
                currentPhase !== "completed" && !isPaused ? "animate-pulse" : ""
              }`}
            />
            {statusText}
          </div>
          <span className="text-xs text-zinc-400">
            Ep{" "}
            <span className="text-white font-semibold">{currentEpisode}</span>
            <span className="mx-1 text-zinc-600">·</span>
            <span className="text-white font-semibold">{savedEpisodes}</span>{" "}
            saved
          </span>
        </div>
        <span
          className={`font-mono text-sm tabular-nums ${phaseColor.timer}`}
          aria-label={`Episode time ${formatTime(phaseElapsedTime)}`}
        >
          {formatTime(phaseElapsedTime)}
        </span>
        <span className="font-mono text-xs text-zinc-500 tabular-nums hidden sm:inline">
          {formatTime(sessionElapsedTime)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          className="h-9 w-9 text-gray-400 hover:text-white hover:bg-black"
        >
          {muted ? (
            <VolumeX className="w-4 h-4" />
          ) : (
            <Volume2 className="w-4 h-4" />
          )}
        </Button>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 overflow-y-auto pb-36">
        <div className="w-full max-w-3xl mx-auto">
          {cameraNames.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {cameraNames.map((name) => (
                <RecordingCameraFeed
                  key={name}
                  cameraName={name}
                  label={name}
                  enabled={previewReady}
                  className="rounded-lg border border-zinc-800"
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 text-center py-12">
              No cameras configured for this session.
            </p>
          )}
        </div>
      </main>

      <div
        className="fixed bottom-0 inset-x-0 z-40 border-t border-zinc-800 bg-black/95 px-3 pt-2"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}
      >
        <div className="flex flex-col gap-1.5 max-w-lg mx-auto">
          {isReady && (
            <Button
              onClick={handleStartOrEndEpisode}
              disabled={!canAdvance || optimisticPhase !== null}
              size="sm"
              className="w-full h-9 text-sm font-medium bg-green-500 hover:bg-green-600 text-black disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              {startLabel}
            </Button>
          )}

          {isRecording && (
            <>
              <div className="flex gap-1.5">
                <Button
                  onClick={handlePauseToggle}
                  disabled={!canPauseToggle}
                  variant="outline"
                  size="sm"
                  className="flex-1 h-9 text-sm border-zinc-700"
                >
                  {isPaused ? (
                    <>
                      <Play className="w-3.5 h-3.5 mr-1.5" />
                      Resume
                    </>
                  ) : (
                    <>
                      <Pause className="w-3.5 h-3.5 mr-1.5" />
                      Pause
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleRestartEpisode}
                  disabled={!canRestart}
                  variant="outline"
                  size="sm"
                  className="flex-1 h-9 text-sm border-zinc-700"
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                  Restart
                </Button>
                <Button
                  onClick={handleStartOrEndEpisode}
                  disabled={!canAdvance || optimisticPhase !== null}
                  size="sm"
                  className="flex-[1.4] h-9 text-sm font-medium bg-green-500 hover:bg-green-600 text-black disabled:opacity-50"
                >
                  End episode
                </Button>
              </div>
            </>
          )}

          <Button
            onClick={requestStopRecording}
            disabled={!controls.stop_recording}
            variant="ghost"
            size="sm"
            className="w-full h-8 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
          >
            <Square className="w-3 h-3 mr-1.5" />
            End session
          </Button>

          {currentPhase === "completed" && (
            <p className="text-center text-xs text-gray-400 pb-1">
              Recording complete — redirecting…
            </p>
          )}
        </div>
      </div>

      <AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <AlertDialogContent className="bg-black border-zinc-800 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>End recording session?</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-400">
              Saved episodes are kept. Unsaved work on the current episode is
              discarded. You'll go to the upload page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-black border-zinc-800 text-white hover:bg-zinc-900">
              Keep recording
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmStopRecording}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              End session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Recording;
