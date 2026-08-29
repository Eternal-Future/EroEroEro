import { getGallery } from "./nhentai";
import { ehGet, ehPut } from "./ehstore";

const KEY_PREFIX = "nh_date_";

export async function getNhPublishDate(id: number | string, apiKey?: string): Promise<number | undefined> {
  const key = `${KEY_PREFIX}${id}`;
  try {
    const cached = await ehGet(key);
    if (cached) {
      const n = Number(cached);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    // storage can fail; proceed to network
  }
  try {
    const g = await getGallery(Number(id), apiKey);
    if (g && Number.isFinite(g.upload_date)) {
      const ts = g.upload_date;
      try {
        await ehPut(key, String(ts));
      } catch {
        // best effort
      }
      return ts;
    }
  } catch {
    // detail fetch failed; leave unset so the item sorts neutrally
  }
  return undefined;
}