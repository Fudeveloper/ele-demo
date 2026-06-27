/**
 * 价格/库存定时同步 —— 对应 app.py 的 start_price_inventory_sync_timer。
 */

import { getConfig } from "./config";
import { syncPriceInventoryCache } from "./services/priceInventory";

let timer: NodeJS.Timeout | null = null;

export function startPriceInventoryTimer(): void {
  const cfg = getConfig();
  if (!cfg.priceInventorySyncEnabled) return;
  if (timer) return;
  const intervalSeconds = Math.max(60, cfg.priceInventorySyncIntervalMinutes * 60);
  timer = setInterval(() => {
    syncPriceInventoryCache()
      .then((r) => {
        if (r.total) console.log(`[价格库存定时同步] 完成 ${r.success}/${r.total}（失败 ${r.fail}）`);
      })
      .catch((err) => {
        console.warn("[价格库存定时同步] 失败:", err);
      });
  }, intervalSeconds * 1000);
  timer.unref?.();
}

export function stopPriceInventoryTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
