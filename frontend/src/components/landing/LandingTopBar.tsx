import React from "react";
import HfAuthChip from "./HfAuthChip";

const LandingTopBar: React.FC = () => {
  return (
    <header
      className="sticky top-0 z-30 w-full border-b border-zinc-800 bg-black/95 backdrop-blur supports-[backdrop-filter]:bg-black/70"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
        <span className="text-base font-semibold tracking-tight text-white">
          TrainMobile
        </span>
        <HfAuthChip />
      </div>
    </header>
  );
};

export default LandingTopBar;
