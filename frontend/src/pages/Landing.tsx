import React, { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import LandingTopBar from "@/components/landing/LandingTopBar";
import RobotConfigManager from "@/components/landing/RobotConfigManager";
import RecordingModal from "@/components/landing/RecordingModal";
import JobsSection from "@/components/jobs/JobsSection";
import ModelsSection from "@/components/landing/ModelsSection";
import UsageInstructionsModal from "@/components/landing/UsageInstructionsModal";
import { useHfAuth } from "@/contexts/HfAuthContext";
import { useRobots } from "@/hooks/useRobots";
import { useDatasets } from "@/hooks/useDatasets";
import { useApi } from "@/contexts/ApiContext";
import { CameraConfig } from "@/components/recording/CameraConfiguration";
import { isHostedSpace } from "@/lib/isHostedSpace";
import { cn } from "@/lib/utils";
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

const ON_SPACE = isHostedSpace();

type MainTab = "teleop" | "record" | "train" | "rollout";

const TABS: { id: MainTab; label: string }[] = [
  { id: "teleop", label: "Teleoperation" },
  { id: "record", label: "Recording" },
  { id: "train", label: "Training" },
  { id: "rollout", label: "Rollout" },
];

const Landing = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialTab: MainTab =
    tabParam === "record" ||
    tabParam === "train" ||
    tabParam === "rollout" ||
    tabParam === "teleop"
      ? tabParam
      : "teleop";
  const [tab, setTabState] = useState<MainTab>(initialTab);

  const setTab = useCallback(
    (next: MainTab) => {
      setTabState(next);
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === "teleop") p.delete("tab");
          else p.set("tab", next);
          return p;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    if (
      tabParam === "record" ||
      tabParam === "train" ||
      tabParam === "rollout" ||
      tabParam === "teleop"
    ) {
      setTabState(tabParam);
    }
  }, [tabParam]);
  const [showUsageModal, setShowUsageModal] = useState(ON_SPACE);
  const { auth } = useHfAuth();
  const { baseUrl, fetchWithHeaders } = useApi();

  const {
    selectedName,
    selectedRecord,
    availableNames,
    isLoading: isLoadingRobots,
    selectRobot,
    createRobot,
    deleteRobot,
  } = useRobots();

  const { datasets, loading: datasetsLoading, refresh: refreshDatasets } =
    useDatasets();

  const [showRecordingModal, setShowRecordingModal] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [singleTask, setSingleTask] = useState("");
  const [streamingEncoding, setStreamingEncoding] = useState(true);
  const [cameras, setCameras] = useState<CameraConfig[]>([]);
  const [datasetPendingDelete, setDatasetPendingDelete] = useState<
    string | null
  >(null);
  const [isDeletingDataset, setIsDeletingDataset] = useState(false);

  const releaseStreamsRef = useRef<(() => void) | null>(null);

  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (cameras.length > 0) {
      if (releaseStreamsRef.current) releaseStreamsRef.current();
      setCameras([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only cleanup of prior session
  }, []);

  useEffect(() => {
    return () => {
      if (releaseStreamsRef.current) releaseStreamsRef.current();
    };
  }, []);

  const openRecordingModal = () => {
    setCameras(selectedRecord ? [...(selectedRecord.cameras ?? [])] : []);
    setShowRecordingModal(true);
  };

  const handleRecordingModalClose = (open: boolean) => {
    setShowRecordingModal(open);
    if (!open && releaseStreamsRef.current) {
      releaseStreamsRef.current();
    }
  };

  const confirmDeleteDataset = useCallback(async () => {
    if (!datasetPendingDelete) return;
    setIsDeletingDataset(true);
    try {
      const response = await fetchWithHeaders(`${baseUrl}/delete-dataset`, {
        method: "POST",
        body: JSON.stringify({ dataset_repo_id: datasetPendingDelete }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast({
          title: "Dataset deleted",
          description: `${datasetPendingDelete} removed from disk.`,
        });
        refreshDatasets();
      } else {
        toast({
          title: "Delete failed",
          description: data.message || "Could not delete the dataset.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Connection error",
        description: "Could not connect to the backend server.",
        variant: "destructive",
      });
    } finally {
      setIsDeletingDataset(false);
      setDatasetPendingDelete(null);
    }
  }, [
    datasetPendingDelete,
    baseUrl,
    fetchWithHeaders,
    toast,
    refreshDatasets,
  ]);

  const handleStartRecording = async () => {
    if (!selectedRecord) {
      toast({
        title: "No robot selected",
        description: "Select or create a robot first.",
        variant: "destructive",
      });
      return;
    }
    const robot = selectedRecord;
    if (!robot.is_clean) {
      toast({
        title: "Robot not ready",
        description: `${robot.name} needs calibration first (gear icon).`,
        variant: "destructive",
      });
      return;
    }
    if (!datasetName || !singleTask) {
      toast({
        title: "Missing dataset details",
        description: "Enter a dataset name and task description.",
        variant: "destructive",
      });
      return;
    }

    const datasetRepoId =
      auth.status === "authenticated"
        ? `${auth.username}/${datasetName}`
        : datasetName;

    if (cameras.length > 0 && releaseStreamsRef.current) {
      toast({
        title: "Preparing cameras",
        description: `Releasing ${cameras.length} preview stream(s)…`,
      });
      releaseStreamsRef.current();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const cameraDict = cameras.reduce(
      (acc, cam) => {
        acc[cam.name] = {
          type: cam.type,
          camera_index: cam.camera_index,
          width: cam.width,
          height: cam.height,
          fps: cam.fps,
          ...(cam.fourcc ? { fourcc: cam.fourcc } : {}),
          ...(cam.backend ? { backend: cam.backend } : {}),
        };
        return acc;
      },
      {} as Record<
        string,
        {
          type: string;
          camera_index?: number;
          width: number;
          height: number;
          fps?: number;
          fourcc?: string;
          backend?: string;
        }
      >,
    );

    const recordingConfig = {
      leader_port: robot.leader_port,
      follower_port: robot.follower_port,
      leader_config: robot.leader_config,
      follower_config: robot.follower_config,
      dataset_repo_id: datasetRepoId,
      single_task: singleTask,
      fps: 15,
      video: true,
      push_to_hub: false,
      resume: false,
      streaming_encoding: streamingEncoding,
      cameras: cameraDict,
    };

    setShowRecordingModal(false);
    navigate("/recording", { state: { recordingConfig } });
  };

  const localDatasets = datasets.filter(
    (d) => d.source === "local" || d.source === "both",
  );

  const repoPreview =
    datasetName && auth.status === "authenticated"
      ? `${auth.username}/${datasetName}`
      : datasetName || null;

  return (
    <div
      className="min-h-screen bg-black text-white pb-16"
      style={{ ["--tm-topbar-h" as string]: "48px" }}
    >
      <LandingTopBar />

      <div
        className="sticky z-20 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/70 border-b border-zinc-800"
        style={{ top: "var(--tm-topbar-h)" }}
      >
        <div className="mx-auto max-w-7xl px-4 py-3 space-y-3">
          <RobotConfigManager
            selectedName={selectedName}
            selectedRecord={selectedRecord}
            availableNames={availableNames}
            isLoading={isLoadingRobots}
            selectRobot={selectRobot}
            createRobot={createRobot}
            deleteRobot={deleteRobot}
            showTeleopButton={tab === "teleop"}
          />

          <nav className="flex gap-1 overflow-x-auto pb-0.5" aria-label="Main">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  "shrink-0 rounded-md px-4 py-2 text-sm font-medium transition-colors",
                  tab === t.id
                    ? "bg-green-500 text-black"
                    : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-white",
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {tab === "teleop" && (
          <section className="space-y-3 max-w-xl">
            <h2 className="text-xl font-semibold">Teleoperation</h2>
            <p className="text-sm text-zinc-400">
              Drive the follower with the leader arm. Calibrate first (gear on
              the robot card), then start teleop above. Live Mac cameras show on
              the next screen.
            </p>
            {!selectedRecord && (
              <p className="text-sm text-green-400">
                Create or select a robot above to begin.
              </p>
            )}
            {selectedRecord && !selectedRecord.is_clean && (
              <p className="text-sm text-green-400">
                {selectedRecord.name} still needs calibration before teleop.
              </p>
            )}
          </section>
        )}

        {tab === "record" && (
          <section className="space-y-6 max-w-xl">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Recording</h2>
              <p className="text-sm text-zinc-400">
                Create a Hugging Face dataset and record teleop episodes. You
                control when each episode starts and ends — no fixed episode
                count or timers.
              </p>
            </div>

            <div className="rounded-lg border border-zinc-800 p-4 space-y-4">
              <h3 className="font-medium text-white">New dataset</h3>
              <div className="space-y-2">
                <Label htmlFor="landing-dataset-name">Dataset name</Label>
                <Input
                  id="landing-dataset-name"
                  value={datasetName}
                  onChange={(e) =>
                    setDatasetName(
                      e.target.value.replace(/[^A-Za-z0-9._-]/g, "_"),
                    )
                  }
                  placeholder="my_pick_place"
                  className="bg-black border-zinc-800 text-white"
                />
                {repoPreview && (
                  <p className="text-xs text-zinc-500">
                    Will save as{" "}
                    <span className="font-mono text-zinc-300">{repoPreview}</span>
                  </p>
                )}
                {auth.status === "unauthenticated" && (
                  <p className="text-xs text-green-400/80">
                    Log in (top right) so the repo is under your HF username.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="landing-task">Task description</Label>
                <Input
                  id="landing-task"
                  value={singleTask}
                  onChange={(e) => setSingleTask(e.target.value)}
                  placeholder="pick up the cube and place it in the bowl"
                  className="bg-black border-zinc-800 text-white"
                />
              </div>
              <Button
                className="w-full bg-red-500 hover:bg-red-600 text-white"
                onClick={() => {
                  if (!datasetName || !singleTask) {
                    toast({
                      title: "Fill in name and task",
                      description:
                        "Dataset name and task description are required.",
                      variant: "destructive",
                    });
                    return;
                  }
                  openRecordingModal();
                }}
              >
                Review cameras &amp; start recording
              </Button>
            </div>

            <div className="space-y-3">
              <h3 className="font-medium text-white">Your datasets</h3>
              {datasetsLoading ? (
                <p className="text-sm text-zinc-500">Loading…</p>
              ) : localDatasets.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No local datasets yet. Create one above.
                </p>
              ) : (
                <ul className="space-y-2">
                  {localDatasets.map((d) => (
                    <li
                      key={d.repo_id}
                      className="flex items-stretch gap-2 rounded-lg border border-zinc-800 overflow-hidden"
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left px-3 py-2 hover:bg-zinc-950 hover:border-green-600"
                        onClick={() =>
                          navigate(
                            `/edit-dataset?repo=${encodeURIComponent(d.repo_id)}`,
                          )
                        }
                      >
                        <span className="font-mono text-sm break-all">
                          {d.repo_id}
                        </span>
                        <span className="block text-xs text-zinc-500 mt-0.5">
                          Edit episodes
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${d.repo_id}`}
                        disabled={isDeletingDataset}
                        className="h-auto w-11 shrink-0 rounded-none border-l border-zinc-800 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDatasetPendingDelete(d.repo_id);
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {tab === "train" && (
          <section className="space-y-6">
            <div className="space-y-3 max-w-xl">
              <h2 className="text-xl font-semibold">Training</h2>
              <p className="text-sm text-zinc-400">
                Train a policy on a recorded dataset — locally, on{" "}
                <span className="text-zinc-300">Hugging Face Jobs</span> (priced
                GPU flavors), or optionally Vast.ai. Watch loss on the job card;
                roll out from a checkpoint while cloud training continues.
              </p>
              <Button
                className="bg-green-500 hover:bg-green-600 text-black font-medium"
                onClick={() => navigate("/training")}
              >
                Configure &amp; start training
              </Button>
            </div>
            <ModelsSection />
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-white">Training jobs</h3>
              <p className="text-sm text-zinc-500">
                Recent runs and Hub imports. Open a job to monitor or save a
                checkpoint as a model.
              </p>
              <JobsSection />
            </div>
          </section>
        )}

        {tab === "rollout" && (
          <section className="space-y-6">
            <div className="space-y-3 max-w-xl">
              <h2 className="text-xl font-semibold">Rollout</h2>
              <p className="text-sm text-zinc-400">
                Run a trained policy on the follower arm (autonomous). Activate a
                saved model below, or open a training job and press play on a
                checkpoint to start rollout.
              </p>
            </div>
            <ModelsSection />
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-white">
                Start from a training job
              </h3>
              <JobsSection />
            </div>
          </section>
        )}
      </main>

      <UsageInstructionsModal
        open={showUsageModal}
        onOpenChange={setShowUsageModal}
        dismissible={!ON_SPACE}
      />

      <RecordingModal
        open={showRecordingModal}
        onOpenChange={handleRecordingModalClose}
        robot={selectedRecord}
        datasetName={datasetName}
        setDatasetName={setDatasetName}
        singleTask={singleTask}
        setSingleTask={setSingleTask}
        streamingEncoding={streamingEncoding}
        setStreamingEncoding={setStreamingEncoding}
        cameras={cameras}
        setCameras={setCameras}
        onStart={handleStartRecording}
        releaseStreamsRef={releaseStreamsRef}
      />

      <AlertDialog
        open={datasetPendingDelete != null}
        onOpenChange={(open) => {
          if (!open && !isDeletingDataset) setDatasetPendingDelete(null);
        }}
      >
        <AlertDialogContent className="bg-black border-zinc-800 text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete dataset from disk?</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-400">
              This permanently removes{" "}
              <span className="font-mono text-gray-200">
                {datasetPendingDelete}
              </span>{" "}
              from this Mac. It does not delete anything already pushed to the
              Hub.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isDeletingDataset}
              className="bg-black border-zinc-800 text-white hover:bg-zinc-900"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeletingDataset}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteDataset();
              }}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {isDeletingDataset ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Landing;
