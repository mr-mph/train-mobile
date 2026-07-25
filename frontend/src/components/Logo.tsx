import React from "react";
import { cn } from "@/lib/utils";

interface LogoProps extends React.HTMLAttributes<HTMLDivElement> {
  iconOnly?: boolean;
}

/** Text brand mark — no image logo. */
const Logo: React.FC<LogoProps> = ({ className, iconOnly = false }) => {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {!iconOnly && (
        <span className="font-bold text-white text-xl tracking-tight sm:text-2xl">
          TrainMobile
        </span>
      )}
      {iconOnly && (
        <span className="font-bold text-white text-sm tracking-tight">TM</span>
      )}
    </div>
  );
};

export default Logo;
