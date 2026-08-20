// Saves a new alert. Storage is a single JSON array in Upstash Redis —
// simple and more than enough at beta scale.

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

// Events now arrive from Discovery search, which gives us a proper name,
// venue and date. We still validate the URL and pull the event ID out of it,
// since that URL is what TicketsData needs.
function validateEventUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { error: "That doesn't look like a web address." };
  }

  if (!/(^|\.)ticketmaster\.com$/i.test(u.hostname)) {
    return { error: "That isn't a Ticketmaster event." };
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("event");
  if (i < 1) {
    return { error: "Choose an event from the search results." };
  }

  return {
    eventUrl: `https://www.ticketmaster.com${u.pathname}`,
    eventId: parts[i + 1] || "",
  };
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
  const quantity = Number(input.quantity || 1);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
    return json({ error: "Enter a target price above zero." }, 400);
  }
  if (![1, 2, 3, 4].includes(quantity)) {
    return json({ error: "Choose between 1 and 4 tickets." }, 400);
  }

  const parsed = validateEventUrl(input.eventUrl || "");
  if (parsed.error) return json({ error: parsed.error }, 400);

  const eventName = String(input.eventName || "").trim().slice(0, 200);
  if (!eventName) return json({ error: "Choose an event first." }, 400);

  const sections = String(input.sections || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);

  const alert = {
    id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    email,
    maxPrice,
    quantity,
    sections,
    eventUrl: parsed.eventUrl,
    eventId: parsed.eventId,
    eventName,
    eventDate: String(input.eventDate || "").slice(0, 10),
    venue: String(input.venue || "").slice(0, 200),
    city: String(input.city || "").slice(0, 100),
    status: "watching",
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastSeenPrice: null,
    priceAsOf: null,
    firedAt: null,
    firedPrice: null,
    firedSeat: null,
  };

  try {
    const raw = await redis(["GET", ALERTS_KEY]);
    const alerts = raw ? JSON.parse(raw) : [];

    const duplicate = alerts.find(
      (a) =>
        a.email === email &&
        a.eventUrl === alert.eventUrl &&
        a.quantity === quantity &&
        a.status === "watching"
    );
    if (duplicate) {
      return json({ error: "You're already watching this event." }, 409);
    }

    alerts.push(alert);
    await redis(["SET", ALERTS_KEY, JSON.stringify(alerts)]);
    return json({ ok: true, alert });
  } catch {
    return json({ error: "Could not save the alert." }, 500);
  }
};
