// Sends short diagnostics about problems (freezes, desyncs, lost links, script errors) to the room
// server, which writes them to its log. Nothing here affects the game.
import { BUILD, relayBase } from './room-client.ts';

const PER_KIND = 5;
const TEXT_MAX = 1500;
const sent = new Map<string, number>();

/** Room and seat of the current online game, added to every report. */
export const reportContext: { room?: string; seat?: number; online?: boolean } = {};

function trim(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > TEXT_MAX ? `${v.slice(0, TEXT_MAX)}...` : v;
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => trim(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, trim(x, depth + 1)]));
}

/** Reports one problem. Each kind is sent at most a few times per page load. */
export function report(kind: string, detail: Record<string, unknown>): void {
  const base = relayBase();
  if (!base) return;
  const n = sent.get(kind) ?? 0;
  if (n >= PER_KIND) return;
  sent.set(kind, n + 1);
  const body = JSON.stringify({
    kind,
    build: BUILD,
    ...reportContext,
    page: location.pathname,
    agent: navigator.userAgent,
    detail: trim(detail),
  });
  // A plain-text body keeps this a simple request, so the browser sends no preflight.
  void fetch(`${base}/api/report`, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
}
