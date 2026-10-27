// One JSON line per event. The Worker's log storage indexes the fields, so events can be filtered
// by name, room or seat in the dashboard or followed live with `npx wrangler tail`.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
