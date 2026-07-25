import React, { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import TeleopCameraPanel from "@/components/control/TeleopCameraPanel";
import { useToast } from "@/hooks/use-toast";
import { useApi } from "@/contexts/ApiContext";

const TeleoperationPage = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { baseUrl, fetchWithHeaders } = useApi();

  const stoppedRef = useRef(false);
  const stopTeleoperation = useCallback(async () => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    try {
      const res = await fetchWithHeaders(`${baseUrl}/stop-teleoperation`, {
        method: "POST",
      });
      const data = await res.json();
      if (data?.success) {
        toast({
          title: "Teleoperation stopped",
          description: "The arm was disconnected cleanly.",
        });
      }
    } catch {
      /* best-effort */
    }
  }, [baseUrl, fetchWithHeaders, toast]);

  useEffect(() => {
    const handlePageHide = () => {
      try {
        sessionStorage.setItem("lelab:teleop-stopped", "1");
      } catch {
        /* ignore */
      }
      fetch(`${baseUrl}/stop-teleoperation`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      stopTeleoperation();
    };
  }, [baseUrl, stopTeleoperation]);

  const handleGoBack = async () => {
    await stopTeleoperation();
    navigate("/");
  };

  return (
    <div
      className="min-h-screen bg-black text-white flex flex-col"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleGoBack}
          className="text-gray-400 hover:text-white hover:bg-black flex-shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-medium text-gray-200">Teleoperation</h1>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
        <TeleopCameraPanel />
      </main>
    </div>
  );
};

export default TeleoperationPage;
