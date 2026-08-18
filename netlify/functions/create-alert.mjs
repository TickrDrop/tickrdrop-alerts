// Saves a new alert. Storage is a single JSON array in Upstash Redis —
// simple and more than enough at beta scale.

const ALERTS_KEY = "tickrdrop:alerts";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  const body = await res.json();
  return body.result;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  if (!process.env.UPSTASH_REDIS_REST_URL) {
    return json({ error: "Storage is not configured." }, 500);
  }

  let input;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Could not read the request." }, 400);
  }

  const email = String(input.email || "").trim().toLowerCase();
  const maxPrice = Number(input.maxPrice);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    return json({ error: "Enter a target price above zero." }, 400);
  }
  if (!input.eventId) {
    return json({ error: "Choose an event first." }, 400);
  }

  const alert = {
    id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    email,
    maxPrice,
    eventId: String(input.eventId),
    eventName: String(input.eventName || "").slice(0, 200),
    eventDate: String(input.eventDate || ""),
    venue: String(input.venue || "").slice(0, 200),
    city: String(input.city || "").slice(0, 100),
    tmEventId: String(input.tmEventId || ""),
    status: "watching",
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastSeenPrice: null,
    firedAt: null,
    firedPrice: null,
  };

  try {
    const raw = await redis(["GET", ALERTS_KEY]);
    const alerts = raw ? JSON.parse(raw) : [];

    // Don't let one person stack duplicate watches on the same event.
    const duplicate = alerts.find(
      (a) =>
        a.email === email &&
        a.eventId === alert.eventId &&
        a.status === "watching"
    );
    if (duplicate) {
      return json(
        { error: "You're already watching this event." },
        409
      );
    }

    alerts.push(alert);
    await redis(["SET", ALERTS_KEY, JSON.stringify(alerts)]);

    return json({ ok: true, alert });
  } catch (err) {
    return json({ error: "Could not save the alert." }, 500);
  }
};
