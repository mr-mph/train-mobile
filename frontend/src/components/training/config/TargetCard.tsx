import React, { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfigComponentProps } from "../types";
import { RunnerFlavor } from "@/lib/jobsApi";
import { useApi } from "@/contexts/ApiContext";

interface VastOffer {
  id: number | string;
  gpu_name?: string;
  num_gpus?: number;
  gpu_ram_gb?: number;
  dph_total?: number;
  dlperf?: number;
}

interface TargetCardProps extends ConfigComponentProps {
  authenticated: boolean;
  flavors: RunnerFlavor[];
  loading: boolean;
  hardwareError?: string | null;
  onRetryHardware?: () => void;
}

const formatHourly = (unitCostUsd: number, unitLabel: string): string => {
  const hourly = unitLabel === "minute" ? unitCostUsd * 60 : unitCostUsd;
  return `$${hourly.toFixed(2)}/hr`;
};

const formatFlavorLine = (f: RunnerFlavor): string => {
  const accel = f.accelerator ? f.accelerator : f.cpu;
  return `${f.pretty_name} · ${accel} · ${formatHourly(f.unit_cost_usd, f.unit_label)}`;
};

const formatVastLine = (o: VastOffer): string => {
  const gpus = o.num_gpus && o.num_gpus > 1 ? `${o.num_gpus}× ` : "";
  const name = o.gpu_name || "GPU";
  const price = `$${Number(o.dph_total || 0).toFixed(2)}/hr`;
  return `${gpus}${name} · ${price}`;
};

const TargetCard: React.FC<TargetCardProps> = ({
  config,
  updateConfig,
  authenticated,
  flavors,
  loading,
  hardwareError = null,
  onRetryHardware,
}) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [offers, setOffers] = useState<VastOffer[]>([]);
  const [vastLoading, setVastLoading] = useState(false);
  const [spend, setSpend] = useState<{ credit?: number } | null>(null);
  const targetRef = useRef(config.target);
  const updateConfigRef = useRef(updateConfig);
  const didPreferHf = useRef(false);
  targetRef.current = config.target;
  updateConfigRef.current = updateConfig;

  const refreshVast = useCallback(async () => {
    setVastLoading(true);
    try {
      const [oRes, sRes] = await Promise.all([
        fetchWithHeaders(`${baseUrl}/jobs/runners/vast/offers`),
        fetchWithHeaders(`${baseUrl}/jobs/runners/vast/spend`),
      ]);
      if (oRes.ok) {
        const body = await oRes.json();
        const next: VastOffer[] = body.offers || [];
        setOffers(next);

        // Drop a selected offer that disappeared from the marketplace.
        const current = targetRef.current;
        const selected = current.offer_id;
        if (
          current.runner === "vast" &&
          selected &&
          !next.some((o) => String(o.id) === String(selected))
        ) {
          updateConfigRef.current("target", {
            runner: "vast",
            offer_id: undefined,
          });
        }
      }
      if (sRes.ok) setSpend(await sRes.json());
    } catch {
      /* vast optional without key */
    } finally {
      setVastLoading(false);
    }
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    void refreshVast();
  }, [refreshVast]);

  // Once HF auth + flavors are available, prefer the first HF flavor when the
  // user is still on the default local target (don't override an explicit pick).
  useEffect(() => {
    if (didPreferHf.current) return;
    if (!authenticated || flavors.length === 0 || loading) return;
    if (config.target.runner !== "local") {
      didPreferHf.current = true;
      return;
    }
    didPreferHf.current = true;
    updateConfig("target", {
      runner: "hf_cloud",
      flavor: flavors[0].name,
    });
  }, [authenticated, flavors, loading, config.target.runner, updateConfig]);

  const target = config.target;
  const value =
    target.runner === "local"
      ? "local"
      : target.runner === "vast"
        ? `vast:${target.offer_id ?? ""}`
        : `hf:${target.flavor ?? ""}`;

  const handleChange = (v: string) => {
    if (v === "local") {
      updateConfig("target", { runner: "local" });
    } else if (v.startsWith("vast:")) {
      updateConfig("target", {
        runner: "vast",
        offer_id: v.slice("vast:".length),
      });
    } else if (v.startsWith("hf:")) {
      updateConfig("target", {
        runner: "hf_cloud",
        flavor: v.slice("hf:".length),
      });
    }
  };

  return (
    <Card className="bg-black border-zinc-800 rounded-xl">
      <CardHeader>
        <CardTitle className="text-white">Compute target</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <div className="flex items-center justify-between gap-2">
            <Label className="text-zinc-300">Run training on</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onRetryHardware?.();
                void refreshVast();
              }}
              disabled={vastLoading || loading}
              className="h-7 px-2 text-zinc-400 hover:text-white hover:bg-zinc-900"
              title="Refresh compute options"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 mr-1.5 ${
                  vastLoading || loading ? "animate-spin" : ""
                }`}
              />
              Refresh
            </Button>
          </div>
          <Select value={value} onValueChange={handleChange}>
            <SelectTrigger className="bg-black border-zinc-800 text-white rounded-lg mt-1">
              <SelectValue
                placeholder={
                  loading || vastLoading ? "Loading…" : "Select target"
                }
              />
            </SelectTrigger>
            <SelectContent className="bg-black border-zinc-800 text-white max-h-80">
              <SelectGroup>
                <SelectItem value="local">Local — your machine</SelectItem>
              </SelectGroup>

              <SelectGroup>
                <SelectLabel className="text-zinc-500">
                  Hugging Face Jobs · priced by flavor
                </SelectLabel>
                {!authenticated ? (
                  <SelectItem value="hf:__login__" disabled>
                    Log in with Hugging Face to unlock Jobs
                  </SelectItem>
                ) : loading ? (
                  <SelectItem value="hf:__loading__" disabled>
                    Loading HF hardware…
                  </SelectItem>
                ) : hardwareError ? (
                  <SelectItem value="hf:__error__" disabled>
                    Couldn’t load HF hardware — tap Refresh
                  </SelectItem>
                ) : flavors.length === 0 ? (
                  <SelectItem value="hf:__empty__" disabled>
                    No HF hardware flavors returned
                  </SelectItem>
                ) : (
                  flavors.map((f) => (
                    <SelectItem key={f.name} value={`hf:${f.name}`}>
                      HF · {formatFlavorLine(f)}
                    </SelectItem>
                  ))
                )}
              </SelectGroup>

              {offers.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-zinc-500">
                    Vast · under $3/hr · may go stale
                  </SelectLabel>
                  {offers.map((o) => (
                    <SelectItem key={String(o.id)} value={`vast:${o.id}`}>
                      {formatVastLine(o)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-zinc-500 mt-1">
            Prefer Hugging Face Jobs for reliable cloud GPUs with listed
            pricing. Vast is optional (set VAST_API_KEY) and offers expire
            quickly.
          </p>
          {!authenticated && (
            <p className="text-xs text-amber-400/90 mt-1">
              Sign in with Hugging Face above to run cloud Jobs.
            </p>
          )}
          {authenticated && hardwareError && (
            <p className="text-xs text-red-400 mt-1">{hardwareError}</p>
          )}
          {spend?.credit != null && (
            <p className="text-xs text-emerald-400 mt-1">
              Vast credit: ${Number(spend.credit).toFixed(2)}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default TargetCard;
