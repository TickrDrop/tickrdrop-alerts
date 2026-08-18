// Your ops view. Lists every alert and today's API spend.
// Protected by ADMIN_KEY so it isn't public.

const ALERTS_KEY = "tickrdrop:alerts";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function redis(command) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return (await res.json()).result;
}

export default async (req) => {
  const url = new URL(req.url);
  const supplied = url.searchParams.get("key") || "";

  if (!process.env.ADMIN_KEY || supplied !== process.env.ADMIN_KEY) {
    return json({ error: "Not authorized." }, 401);
  }

  try {
    const raw = await redis(["GET", ALERTS_KEY]);
    const alerts = raw ? JSON.parse(raw) : [];
    const day = new Date().toISOString().slice(0, 10);
    const used = Number((await redis(["GET", `tickrdrop:usage:${day}`])) || 0);

    return json({
      alerts: alerts.slice().reverse(),
      counts: {
        watching: alerts.filter((a) => a.status === "watching").length,
        fired: alerts.filter((a) => a.status === "fired").length,
        expired: alerts.filter((a) => a.status === "expired").length,
        total: alerts.length,
      },
      requestsUsedToday: used,
      cap: Number(process.env.DAILY_REQUEST_CAP || 40),
      monitorEnabled: process.env.MONITOR_ENABLED === "true",
    });
  } catch {
    return json({ error: "Could not read stored alerts." }, 500);
  }
};
