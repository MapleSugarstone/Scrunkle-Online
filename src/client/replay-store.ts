// Saved replays, kept in this browser (IndexedDB). The list and the recordings are separate stores,
// so the Replays screen reads only the short entries. A recording is stored gzipped.
import { REPLAY_NAME_MAX, type FinishedReplay, type ReplayBody, type ReplayMeta } from './replay.ts';
import { fromExactJson, toExactJson } from '../engine/snapshot.ts';
import { REPLAY_FILE_TYPE, STORAGE_PREFIX } from '../game/page.ts';

const DB = `${STORAGE_PREFIX}-replays`;
const META = 'meta';
const DATA = 'data';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(META, { keyPath: 'id' });
      r.result.createObjectStore(DATA);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function gzip(text: string): Promise<Blob> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

export async function saveReplay(r: FinishedReplay): Promise<ReplayMeta> {
  const meta: ReplayMeta = { id: crypto.randomUUID(), saved: Date.now(), ...r.meta };
  // Start states hold -0, NaN and the infinities, which plain JSON loses.
  const blob = await gzip(toExactJson(r.body));
  const d = await db();
  const t = d.transaction([META, DATA], 'readwrite');
  t.objectStore(META).put(meta);
  t.objectStore(DATA).put(blob, meta.id);
  await done(t);
  return meta;
}

/** Saved replays, newest first. */
export async function listReplays(): Promise<ReplayMeta[]> {
  try {
    const d = await db();
    const all = await request(d.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<ReplayMeta[]>);
    return all.sort((a, b) => b.saved - a.saved);
  } catch {
    return [];
  }
}

export async function loadReplay(id: string): Promise<{ meta: ReplayMeta; body: ReplayBody } | null> {
  const d = await db();
  const t = d.transaction([META, DATA], 'readonly');
  const [meta, blob] = await Promise.all([request(t.objectStore(META).get(id) as IDBRequest<ReplayMeta | undefined>), request(t.objectStore(DATA).get(id) as IDBRequest<Blob | undefined>)]);
  if (!meta || !blob) return null;
  return { meta, body: fromExactJson<ReplayBody>(await gunzip(blob)) };
}

// ---------------------------------------------------------------- replay files

export { REPLAY_FILE_TYPE };
const FILE_KIND = `${STORAGE_PREFIX}-replay`;
const FILE_MAX = 30 * 1024 * 1024;
const FRAMES_MAX = 30 * 60 * 30;

/** A replay as one gzipped file: its list entry and its recording. */
export async function replayFile(id: string): Promise<Blob | null> {
  const r = await loadReplay(id);
  if (!r) return null;
  const { id: _id, saved: _saved, ...meta } = r.meta;
  return gzip(toExactJson({ format: 1, kind: FILE_KIND, meta, body: r.body }));
}

const isText = (v: unknown): v is string => typeof v === 'string';
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
const isInputs = (v: unknown) =>
  Array.isArray(v) && v.length <= 4 && v.every((p) => p && typeof p === 'object' && isTexts((p as { keys?: unknown }).keys));

/** The replay in a file's parsed contents, or null when they are not one this version can read. */
function readReplayFile(v: unknown): FinishedReplay | null {
  if (!v || typeof v !== 'object') return null;
  const { format, kind, meta: m, body: b } = v as Record<string, Record<string, unknown> | undefined>;
  if ((format as unknown) !== 1 || (kind as unknown) !== FILE_KIND || !m || !b) return null;
  if (!isText(m.mode) || !isTexts(m.fighters) || !isText(m.stage) || !isTexts(m.names) || !isText(m.build)) return null;
  if (typeof m.online !== 'boolean' || (m.name !== undefined && !isText(m.name))) return null;
  if (b.format !== 1 || typeof b.t0 !== 'number' || !b.start || typeof b.start !== 'object') return null;
  if (!Array.isArray(b.runs) || !Array.isArray(b.checks)) return null;
  // The runs must add up to the length the entry gives, which also keeps a crafted file from expanding without end.
  let frames = 0;
  for (const run of b.runs as unknown[]) {
    if (!Array.isArray(run) || !Number.isInteger(run[0]) || run[0] < 1 || !isInputs(run[1])) return null;
    frames += run[0];
  }
  if (frames !== m.frames || frames > FRAMES_MAX) return null;
  if (!(b.checks as unknown[]).every((c) => Array.isArray(c) && Number.isInteger(c[0]) && Number.isInteger(c[1]))) return null;
  return {
    meta: { name: m.name?.slice(0, REPLAY_NAME_MAX), mode: m.mode, fighters: m.fighters, stage: m.stage, frames, online: m.online, names: m.names, build: m.build },
    body: b as unknown as ReplayBody,
  };
}

/** Keeps the replay in a replay file in this browser. Throws with a message the player can read when the file is not one. */
export async function importReplay(file: Blob): Promise<ReplayMeta> {
  if (file.size > FILE_MAX) throw new Error('The file is too large to be a replay.');
  let data: unknown;
  try {
    data = fromExactJson<unknown>(await gunzip(file));
  } catch {
    throw new Error('The file is not a replay.');
  }
  const replay = readReplayFile(data);
  if (!replay) throw new Error('The file is not a replay, or a newer version of the game made it.');
  return saveReplay(replay);
}

/** Gives a replay a name, or takes it away when `name` is empty. */
export async function renameReplay(id: string, name: string): Promise<void> {
  const d = await db();
  const t = d.transaction(META, 'readwrite');
  const store = t.objectStore(META);
  const meta = await request(store.get(id) as IDBRequest<ReplayMeta | undefined>);
  if (!meta) return;
  if (name) meta.name = name;
  else delete meta.name;
  store.put(meta);
  await done(t);
}

export async function deleteReplay(id: string): Promise<void> {
  const d = await db();
  const t = d.transaction([META, DATA], 'readwrite');
  t.objectStore(META).delete(id);
  t.objectStore(DATA).delete(id);
  await done(t);
}
