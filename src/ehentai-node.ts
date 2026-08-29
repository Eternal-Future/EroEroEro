// Node-only e-hentai bridges: HTTP proxy support for igneous acquisition and
// a local file that reliably persists the acquired igneous value. This file is
// NEVER imported by the Workers/Vercel entries, so the serverless graph stays
// free of Node built-ins.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProxyAgent } from "undici";
import {
  setEhAcquireFetcher,
  setEhPersistBridge,
  type EhPersistState,
} from "./ehentai";

interface PersistBridge {
  readState(): Promise<EhPersistState | null>;
  writeState(state: EhPersistState): Promise<void>;
}

export function installEhNodeBridge(): void {
  const proc = (globalThis as any).process;
  const stateFile = proc?.env?.EHENTAI_STATE_FILE ?? "eh-state.json";
  const dataDir = proc?.env?.EHENTAI_STATE_DIR ?? ".data";
  const statePath = join(proc.cwd(), dataDir, stateFile.replace(/^\.data\//, ""));

  const bridge: PersistBridge = {
    async readState() {
      try {
        const raw = await readFile(statePath, "utf8");
        return JSON.parse(raw) as EhPersistState;
      } catch {
        return null;
      }
    },
    async writeState(state) {
      try {
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(statePath, JSON.stringify(state), "utf8");
      } catch {
        // persisting is best-effort
      }
    },
  };

  setEhPersistBridge(bridge);

  const proxy = proc?.env?.EHENTAI_IGNEOUS_PROXY;
  if (proxy) {
    const agent = new ProxyAgent({ uri: proxy });
    setEhAcquireFetcher((url, init) => {
      return fetch(url, { ...(init ?? {}), dispatcher: agent } as any);
    });
  }
}