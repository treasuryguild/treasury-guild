// Shared body of the scheduled functions: the actual logic lives in the Next
// cron routes so it can also be invoked manually in dev. Throws on a non-2xx
// so Netlify marks the scheduled run as failed instead of silently green.
export async function triggerCron(name: string, path: string): Promise<void> {
  const base = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) {
    throw new Error(`${name}: APP_URL and CRON_SECRET must be set`);
  }
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  console.log(`${name}:`, res.status, body);
  if (!res.ok) throw new Error(`${name} failed: ${res.status} ${body}`);
}
