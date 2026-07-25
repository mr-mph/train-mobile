import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { useHfAuth } from "@/contexts/HfAuthContext";
import HfAuthDialog from "./HfAuthDialog";

const HfAuthChip: React.FC = () => {
  const { auth } = useHfAuth();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (auth.status === "loading") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-black px-3 py-1 text-xs text-gray-400">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>Checking HF…</span>
      </div>
    );
  }

  if (auth.status === "authenticated") {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-black px-3 py-1 text-xs text-gray-200"
        title="Hugging Face authenticated"
      >
        <span
          className="h-2 w-2 rounded-full bg-emerald-400"
          aria-hidden="true"
        />
        <span>{auth.username}</span>
      </div>
    );
  }

  // unauthenticated
  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border border-green-700/60 bg-green-500 px-3 py-1 text-xs text-green-400 hover:bg-green-500 transition-colors"
        aria-label="Hugging Face not configured — show login instructions"
      >
        <span
          className="h-2 w-2 rounded-full bg-green-500"
          aria-hidden="true"
        />
        <span>HF not configured</span>
      </button>
      <HfAuthDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
};

export default HfAuthChip;
