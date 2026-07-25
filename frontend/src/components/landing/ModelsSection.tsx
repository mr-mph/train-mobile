import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/contexts/ApiContext";
import { useToast } from "@/hooks/use-toast";

type ModelItem = {
  id: string;
  name: string;
  policy_ref: string;
  active: boolean;
  thumbnail_url?: string | null;
  source?: string;
  steps?: number | null;
};

const ModelsSection: React.FC = () => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const { toast } = useToast();
  const [models, setModels] = useState<ModelItem[]>([]);

  const reload = useCallback(async () => {
    const r = await fetchWithHeaders(`${baseUrl}/models`);
    if (!r.ok) return;
    const body = await r.json();
    setModels(body.models || []);
  }, [baseUrl, fetchWithHeaders]);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  const activate = async (id: string) => {
    const r = await fetchWithHeaders(`${baseUrl}/models/${id}/activate`, {
      method: "POST",
    });
    if (!r.ok) {
      toast({
        title: "Activate failed",
        description: await r.text(),
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Model activated" });
    await reload();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this saved model?")) return;
    const r = await fetchWithHeaders(`${baseUrl}/models/${id}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      toast({
        title: "Delete failed",
        description: await r.text(),
        variant: "destructive",
      });
      return;
    }
    await reload();
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-white">Saved models</h2>
      {models.length === 0 ? (
        <p className="text-sm text-gray-500">
          No saved models yet. After training or rollout, save a checkpoint here.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {models.map((m) => (
            <div
              key={m.id}
              className={`rounded-lg border p-3 bg-black ${
                m.active ? "border-green-500" : "border-zinc-800"
              }`}
            >
              <div className="aspect-video bg-black rounded mb-2 overflow-hidden">
                {m.thumbnail_url ? (
                  <img
                    src={`${baseUrl}${m.thumbnail_url}`}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">
                    No thumb
                  </div>
                )}
              </div>
              <div className="font-medium truncate">{m.name}</div>
              <div className="text-xs text-gray-400 truncate mb-2">
                {m.source}
                {m.steps != null ? ` · ${m.steps} steps` : ""}
                {m.active ? " · active" : ""}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  variant={m.active ? "secondary" : "default"}
                  disabled={m.active}
                  onClick={() => activate(m.id)}
                >
                  {m.active ? "Active" : "Use"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => remove(m.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default ModelsSection;
