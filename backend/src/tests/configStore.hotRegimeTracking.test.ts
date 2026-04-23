import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

async function loadConfigStoreAtDir(tempDir: string) {
  process.chdir(tempDir);
  vi.resetModules();
  return await import("../runtime/configStore.js");
}

describe("configStore hot regime tracking", () => {
  it("defaults useHotRegimeTracking to false", async () => {
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-config-"));

    try {
      const runtime = await loadConfigStoreAtDir(tempDir);
      expect(runtime.configStore.get().botConfig.observe.useHotRegimeTracking).toBe(false);
    } finally {
      process.chdir(previousCwd);
      vi.resetModules();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists true and false safely across reloads", async () => {
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-config-roundtrip-"));

    try {
      const firstLoad = await loadConfigStoreAtDir(tempDir);
      firstLoad.configStore.update({
        botConfig: {
          observe: {
            useHotRegimeTracking: true,
          },
        },
      });
      firstLoad.configStore.persist();

      const configPath = path.join(tempDir, "data", "config.json");
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).botConfig.observe.useHotRegimeTracking).toBe(true);

      const secondLoad = await loadConfigStoreAtDir(tempDir);
      expect(secondLoad.configStore.get().botConfig.observe.useHotRegimeTracking).toBe(true);

      secondLoad.configStore.update({
        botConfig: {
          observe: {
            useHotRegimeTracking: false,
          },
        },
      });
      secondLoad.configStore.persist();

      const thirdLoad = await loadConfigStoreAtDir(tempDir);
      expect(thirdLoad.configStore.get().botConfig.observe.useHotRegimeTracking).toBe(false);
    } finally {
      process.chdir(previousCwd);
      vi.resetModules();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves hot regime tracking and custom thresholds across universe-only updates", async () => {
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-config-universe-only-"));

    try {
      const runtime = await loadConfigStoreAtDir(tempDir);
      runtime.configStore.update({
        botConfig: {
          observe: {
            useHotRegimeTracking: true,
          },
          candidate: {
            minPriceMove1mPct: 0.65,
            minPriceMove3mPct: 1.35,
          },
        },
      });

      const afterHotToggle = runtime.configStore.get();
      expect(afterHotToggle.botConfig.observe.useHotRegimeTracking).toBe(true);
      expect(afterHotToggle.botConfig.candidate.minPriceMove1mPct).toBe(0.65);
      expect(afterHotToggle.botConfig.candidate.minPriceMove3mPct).toBe(1.35);

      runtime.configStore.update({
        universe: {
          selectedId: "bybit-linear-usdt-open-interest-top200",
          symbols: ["BTCUSDT", "ETHUSDT"],
        },
      });

      const afterUniverseRefresh = runtime.configStore.get();
      expect(afterUniverseRefresh.botConfig.observe.useHotRegimeTracking).toBe(true);
      expect(afterUniverseRefresh.botConfig.candidate.minPriceMove1mPct).toBe(0.65);
      expect(afterUniverseRefresh.botConfig.candidate.minPriceMove3mPct).toBe(1.35);
      expect(afterUniverseRefresh.universe.selectedId).toBe("bybit-linear-usdt-open-interest-top200");
    } finally {
      process.chdir(previousCwd);
      vi.resetModules();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("filters hard-excluded symbols out of persisted universe config", async () => {
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exhaustion-config-exclusions-"));

    try {
      const runtime = await loadConfigStoreAtDir(tempDir);
      runtime.configStore.update({
        universe: {
          selectedId: "custom",
          symbols: ["BTCUSDT", "USDCUSDT", "PAXGUSDT", "XAUTUSDT", "ETHUSDT"],
        },
      });

      const next = runtime.configStore.get();
      expect(next.universe.symbols).toEqual(["BTCUSDT", "ETHUSDT"]);
    } finally {
      process.chdir(previousCwd);
      vi.resetModules();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
