import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigResponse, RuntimeConfig } from "../../../shared/types/domain";
import { fetchRuntimeConfig, updateRuntimeConfig } from "../api/configApi";

const RUNTIME_CONFIG_UPDATED_EVENT = "runtime-config-updated";

function deepClone<T>(x: T): T {
  return structuredClone(x);
}

type UseRuntimeConfigOptions = {
  selectedBotId?: string;
  selectedBotPresetId?: string;
};

export function useRuntimeConfig(options?: UseRuntimeConfigOptions) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [draft, setDraft] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastApplied, setLastApplied] = useState<ConfigResponse["applied"] | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      let cfg = await fetchRuntimeConfig();
      const needsBotSelection = Boolean(options?.selectedBotId) && cfg.selectedBotId !== options?.selectedBotId;
      const needsPresetSelection = Boolean(options?.selectedBotPresetId) && cfg.selectedBotPresetId !== options?.selectedBotPresetId;
      if (needsBotSelection || needsPresetSelection) {
        await updateRuntimeConfig({
          ...(options?.selectedBotId ? { selectedBotId: options.selectedBotId } : {}),
          ...(options?.selectedBotPresetId ? { selectedBotPresetId: options.selectedBotPresetId } : {}),
        });
        cfg = await fetchRuntimeConfig();
      }
      setConfig(cfg);
      setDraft(deepClone(cfg));
      setLastApplied(null);
      setLastSavedAt(null);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, [options?.selectedBotId, options?.selectedBotPresetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    function onRuntimeConfigUpdated(event: Event) {
      const detail = (event as CustomEvent<RuntimeConfig | null>).detail;
      if (!detail) return;
      setConfig(detail);
      setDraft(deepClone(detail));
      setLastApplied(null);
      setLastSavedAt(Date.now());
    }
    window.addEventListener(RUNTIME_CONFIG_UPDATED_EVENT, onRuntimeConfigUpdated as EventListener);
    return () => {
      window.removeEventListener(RUNTIME_CONFIG_UPDATED_EVENT, onRuntimeConfigUpdated as EventListener);
    };
  }, []);

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    return JSON.stringify(config) !== JSON.stringify(draft);
  }, [config, draft]);

  async function save(nextDraft?: RuntimeConfig) {
    const payload = nextDraft ?? draft;
    if (!payload) return;
    setError(null);
    setSaving(true);
    try {
      const {
        selectedBotId: _selectedBotId,
        selectedBotPresetId: _selectedBotPresetId,
        selectedExecutionProfileId: _selectedExecutionProfileId,
        ...restPayload
      } = payload;
      const res = await updateRuntimeConfig({
        ...restPayload,
        ...(options?.selectedBotId ? { selectedBotId: options.selectedBotId } : {}),
        ...(options?.selectedBotPresetId ? { selectedBotPresetId: options.selectedBotPresetId } : {}),
      });
      setConfig(res.config);
      setDraft(deepClone(res.config));
      setLastApplied(res.applied ?? null);
      setLastSavedAt(Date.now());
      window.dispatchEvent(new CustomEvent<RuntimeConfig>(RUNTIME_CONFIG_UPDATED_EVENT, { detail: res.config }));
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!config) return;
    setDraft(deepClone(config));
  }

  return { config, draft, setDraft, dirty, error, saving, lastApplied, lastSavedAt, reload, save, reset };
}
