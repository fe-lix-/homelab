import { promises as fs } from 'fs';
import * as path from 'path';

const STATE_DIR = process.env.JOYNARR_STATE_DIR ?? '/app/state';
const STATE_FILE = path.join(STATE_DIR, 'tracked-series.json');

interface TrackedSeries {
  title: string;
  lastSeen: string;
}

interface State {
  series: Record<string, TrackedSeries>;
}

let memoryState: State | null = null;
let loadPromise: Promise<State> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function timestamp(): string {
  return new Date().toISOString();
}

async function load(): Promise<State> {
  if (memoryState) return memoryState;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as State;
        memoryState = { series: parsed.series ?? {} };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[${timestamp()}] [TrackedSeries] Failed to load state, starting empty:`, err);
        }
        memoryState = { series: {} };
      }
      return memoryState;
    })();
  }
  return loadPromise;
}

async function persist(): Promise<void> {
  const state = memoryState;
  if (!state) return;
  const tmp = `${STATE_FILE}.tmp`;
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, STATE_FILE);
}

function schedulePersist(): void {
  writeQueue = writeQueue.then(persist).catch(err => {
    console.warn(`[${timestamp()}] [TrackedSeries] Persist failed:`, err);
  });
}

export async function recordSeries(id: string, title: string): Promise<void> {
  if (!id) return;
  const state = await load();
  const existing = state.series[id];
  const now = timestamp();
  if (existing && existing.title === title && existing.lastSeen.slice(0, 10) === now.slice(0, 10)) {
    return;
  }
  state.series[id] = { title, lastSeen: now };
  schedulePersist();
}

export async function listSeriesIds(): Promise<string[]> {
  const state = await load();
  return Object.keys(state.series);
}

export async function listSeries(): Promise<Array<{ id: string; title: string; lastSeen: string }>> {
  const state = await load();
  return Object.entries(state.series).map(([id, v]) => ({ id, title: v.title, lastSeen: v.lastSeen }));
}
