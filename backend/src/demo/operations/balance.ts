import type { BybitDemoRestClient } from "../../bybit/BybitDemoRestClient.js";

type StartDemoBalancePollingArgs = {
  balancePollTimer: NodeJS.Timeout | null;
  lifecycleToken: number;
  isRunningLifecycle: (token?: number) => boolean;
  getWalletUsdtBalance: () => Promise<number | null>;
  setBalanceSnapshot: (balance: number | null, updatedAtMs: number) => void;
};

export async function readDemoWalletUsdtBalance(rest: BybitDemoRestClient): Promise<number | null> {
  if (!rest.hasCredentials()) return null;
  try {
    const result: any = await rest.getWalletBalance({ coin: "USDT" });
    const accounts = Array.isArray(result?.list) ? result.list : [];
    for (const account of accounts) {
      const coins = Array.isArray(account?.coin) ? account.coin : [];
      const usdt = coins.find((coin: any) => String(coin?.coin ?? "").toUpperCase() === "USDT");
      if (!usdt) continue;
      const candidates = [usdt.walletBalance, usdt.equity, usdt.availableToWithdraw, usdt.availableBalance];
      for (const value of candidates) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function startDemoBalancePolling(args: StartDemoBalancePollingArgs): NodeJS.Timeout | null {
  if (args.balancePollTimer) return args.balancePollTimer;
  const token = args.lifecycleToken;
  const poll = async () => {
    try {
      const balance = await args.getWalletUsdtBalance();
      if (!args.isRunningLifecycle(token)) return;
      args.setBalanceSnapshot(balance, Date.now());
    } catch {
    }
  };
  void poll();
  return setInterval(() => {
    void poll();
  }, 60_000);
}

export function stopDemoBalancePolling(balancePollTimer: NodeJS.Timeout | null): NodeJS.Timeout | null {
  if (!balancePollTimer) return null;
  clearInterval(balancePollTimer);
  return null;
}
