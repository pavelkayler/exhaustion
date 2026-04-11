import type { DemoStats } from "../demo/DemoBroker.js";
import type { PaperStats, PaperView } from "../paper/PaperBroker.js";
import type { RealStats } from "../real/RealBroker.js";

export type RuntimeBotStats = PaperStats & {
  executionMode: "paper" | "demo" | "real" | "empty";
  demoStats?: Omit<DemoStats, "mode">;
  realStats?: Omit<RealStats, "mode">;
};

export type ManualTestOrderResult = {
  ok: boolean;
  accepted: boolean;
  executionMode: "paper" | "demo" | "real" | "empty";
  symbol: string;
  side: "LONG" | "SHORT";
  message: string;
  reason?: string;
  retCode?: number;
  retMsg?: string;
  paperView: PaperView;
};
