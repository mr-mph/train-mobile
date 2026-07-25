import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfigComponentProps } from "../types";
import { RunnerFlavor } from "@/lib/jobsApi";
import { useApi } from "@/contexts/ApiContext";

interface VastOffer {
  id: number | string;
  gpu_name?: string;
  gpu_ram_gb?: number;
  dph_total?: number;
  reliability?: number;
  geolocation?: string;
}

interface TargetCardProps extends ConfigComponentProps {
  authenticated: boolean;
  flavors: RunnerFlavor[];
  loading: boolean;
}

const formatHourly = (unitCostUsd: number, unitLabel: string): string => {
  const hourly = unitLabel === "minute" ? unitCostUsd * 60 : unitCostUsd;
  return `$${hourly.toFixed(2)}/hr`;
};

const formatFlavorLine = (f: RunnerFlavor): string => {
  const accel = f.accelerator ? f.accelerator : f.cpu;
  return `${f.pretty_name} · ${accel} · ${formatHourly(f.unit_cost_usd, f.unit_label)}`;
};

const TargetCard: React.FC<TargetCardProps> = ({
  config,
  updateConfig,
  authenticated,
  flavors,
  loading,
}) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [offers, setOffers] = useState<VastOffer[]>([]);
  const [vastLoading, setVastLoading] = useState(false);
  const [spend, setSpend] = useState<{ credit?: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setVastLoading(true);
      try {
        const [oRes, sRes] = await Promise.all([
          fetchWithHeaders(`${baseUrl}/jobs/runners/vast/offers`),
          fetchWithHeaders(`${baseUrl}/jobs/runners/vast/spend`),
        ]);
        if (cancelled) return;
        if (oRes.ok) {
          const body = await oRes.json();
          setOffers(body.offers || []);
        }
        if (sRes.ok) setSpend(await sRes.json());
      } catch {
        /* vast optional without key */
      } finally {
        if (!cancelled) setVastLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

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
          <Label className="text-zinc-300">Run training on</Label>
          <Select value={value} onValueChange={handleChange}>
            <SelectTrigger className="bg-black border-zinc-800 text-white rounded-lg mt-1">
              <SelectValue
                placeholder={
                  loading || vastLoading ? "Loading…" : "Select target"
                }
              />
            </SelectTrigger>
            <SelectContent className="bg-black border-zinc-800 text-white max-h-80">
              <SelectItem value="local">Local — your machine</SelectItem>
              {offers.map((o) => (
                <SelectItem key={String(o.id)} value={`vast:${o.id}`}>
                  Vast · {o.gpu_name || "GPU"} · {o.gpu_ram_gb ?? "?"}GB · $
                  {Number(o.dph_total || 0).toFixed(3)}/hr
                </SelectItem>
              ))}
              {flavors.map((f) => (
                <SelectItem
                  key={f.name}
                  value={`hf:${f.name}`}
                  disabled={!authenticated}
                >
                  HF · {formatFlavorLine(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-zinc-500 mt-1">
            Vast streams loss directly to TrainMobile (no W&B required). Set
            VAST_API_KEY in .env.
          </p>
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
