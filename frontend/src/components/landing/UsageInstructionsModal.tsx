import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dismissible?: boolean;
}

const UsageInstructionsModal: React.FC<Props> = ({
  open,
  onOpenChange,
  dismissible = true,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-black border-zinc-800 text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">Welcome to TrainMobile</DialogTitle>
          <DialogDescription className="text-gray-400 text-left space-y-3 pt-2">
            <p>
              Run the host on your Mac, open this UI on your phone (Cloudflare
              Tunnel), then: calibrate → teleop/record → edit dataset → train on
              Vast.ai → rollout → save models.
            </p>
            <p className="font-mono text-xs bg-black/50 p-2 rounded border border-zinc-800">
              lelab --dev
            </p>
          </DialogDescription>
        </DialogHeader>
        {dismissible && (
          <Button onClick={() => onOpenChange(false)} className="w-full">
            Continue
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default UsageInstructionsModal;
