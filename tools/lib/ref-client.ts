// Talks to tools/ref-server.ts. Runs queue on the server and can take many minutes before it answers,
// longer than fetch's header timeout, so this uses a plain request with no timeout.
import http from 'node:http';

export const SERVER = `http://127.0.0.1:${process.env.REF_PORT ?? 8793}`;

/** JSON that keeps NaN, the infinities, -0 and undefined, which states from the reference often hold. */
export function encodeSpecial(v: unknown): string {
  return JSON.stringify(v, function (this: unknown, k: string, x: unknown) {
    const raw = (this as Record<string, unknown>)[k];
    if (typeof raw === 'number' && (!Number.isFinite(raw) || Object.is(raw, -0))) return { $num: Object.is(raw, -0) ? '-0' : String(raw) };
    if (raw === undefined && k !== '') return { $undef: 1 };
    return x;
  });
}

export function decodeSpecial<T>(text: string): T {
  return JSON.parse(text, (_k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      if (typeof x.$num === 'string' && Object.keys(x).length === 1) return x.$num === '-0' ? -0 : Number(x.$num);
      if (x.$undef === 1 && Object.keys(x).length === 1) return undefined;
    }
    return x;
  }) as T;
}

export function serverPost<T>(path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${SERVER}${path}`, { method: 'POST' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(text));
        else resolve(decodeSpecial<T>(text));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export function serverUp(): Promise<boolean> {
  return fetch(`${SERVER}/status`).then((r) => r.ok, () => false);
}
