// The engine. Runs on a schedule, checks each watched event once,
// and emails anyone whose target has been met.
//
// Spend guards, in order:
//   MONITOR_ENABLED=false      stops everything
//   DAILY_REQUEST_CAP          hard ceiling on SeatData calls per day
//   one call per event         not one per alert

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

function usageKey() {
  return `tickrdrop:usage:${new Date().toISOString().slice(0, 10)}`;
}

async function getPrice(eventId) {
  const res = await fetch(
    `https://seatdata.io/api/v1/events/${eventId}/stats`,
    { headers: { Authorization: `Bearer ${process.env.SEATDATA_API_KEY}` } }
  );
  if (!res.ok) return null;

  const body = await res.json();
  const newest = (body.data || [])[0];
  if (!newest || typeof newest.get_in !== "number") return null;

  return {
    getIn: newest.get_in,
    getInPair: newest.get_in_qty2plus,
    medianPrice: newest.median_price,
    asOf: newest.timestamp,
  };
}

function hoursOld(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
}

function emailBody(alert, price) {
  const buyUrl = alert.tmEventId
    ? `https://www.ticketmaster.com/event/${alert.tmEventId}`
    : "https://www.ticketmaster.com";

  const age = hoursOld(price.asOf);
  const when = alert.eventDate
    ? new Date(alert.eventDate + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0e0f10;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#f4efe6;">

    <div style="font-size:22px;letter-spacing:-0.02em;margin-bottom:28px;">
      <span style="color:#f4efe6;">Tickr</span><span style="color:#e8c468;">Drop</span>
    </div>

    <p style="font-size:15px;line-height:1.5;color:#f4efe6;margin:0 0 4px;">
      Your price hit.
    </p>
    <h1 style="font-size:26px;line-height:1.25;margin:0 0 6px;color:#f4efe6;font-weight:normal;">
      ${alert.eventName}
    </h1>
    <p style="font-size:14px;color:#9a958c;margin:0 0 28px;">
      ${when}${alert.venue ? " &middot; " + alert.venue : ""}${alert.city ? ", " + alert.city : ""}
    </p>

    <div style="background:#16181a;border-radius:10px;padding:22px 24px;margin-bottom:24px;">
      <table style="width:100%;font-family:'JetBrains Mono',Menlo,monospace;font-size:14px;">
        <tr>
          <td style="color:#9a958c;padding-bottom:8px;">Your target</td>
          <td style="color:#f4efe6;text-align:right;padding-bottom:8px;">$${alert.maxPrice.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="color:#9a958c;">Cheapest seat</td>
          <td style="color:#e8c468;text-align:right;font-size:20px;">$${price.getIn.toFixed(2)}</td>
        </tr>
      </table>
    </div>

    <a href="${buyUrl}"
       style="display:block;background:#e8c468;color:#0e0f10;text-decoration:none;
              text-align:center;padding:15px;border-radius:8px;font-size:16px;
              font-family:Georgia,serif;margin-bottom:22px;">
      See tickets
    </a>

    <p style="font-size:12px;line-height:1.6;color:#7d786f;margin:0 0 6px;">
      Price recorded ${age} hour${age === 1 ? "" : "s"} ago and shown before
      marketplace fees. Resale prices move fast &mdash; check the live total at checkout.
    </p>
    <p style="font-size:12px;line-height:1.6;color:#7d786f;margin:0;">
      Pricing data provided by <a href="https://seatdata.io" style="color:#7d786f;">SeatData.io</a>.
    </p>

  </div>
</body>
</html>`;
}

async function sendEmail(alert, price) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL || "onboarding@resend.dev",
      to: [alert.email],
      subject: `${alert.eventName} is at $${price.getIn.toFixed(2)}`,
      html: emailBody(alert, price),
    }),
  });
  return res.ok;
}

export default async () => {
  if (process.env.MONITOR_ENABLED !== "true") {
    return json({ skipped: "MONITOR_ENABLED is not true." });
  }

  const cap = Number(process.env.DAILY_REQUEST_CAP || 40);
  const log = [];

  let alerts;
  try {
    const raw = await redis(["GET", ALERTS_KEY]);
    alerts = raw ? JSON.parse(raw) : [];
  } catch {
    return json({ error: "Could not read stored alerts." }, 500);
  }

  const today = new Date().toISOString().slice(0, 10);
  const watching = alerts.filter(
    (a) => a.status === "watching" && (!a.eventDate || a.eventDate >= today)
  );

  // Expire anything whose event has passed.
  for (const a of alerts) {
    if (a.status === "watching" && a.eventDate && a.eventDate < today) {
      a.status = "expired";
    }
  }

  if (watching.length === 0) {
    await redis(["SET", ALERTS_KEY, JSON.stringify(alerts)]);
    return json({ checked: 0, fired: 0, note: "Nothing to watch." });
  }

  let used = Number((await redis(["GET", usageKey()])) || 0);
  const eventIds = [...new Set(watching.map((a) => a.eventId))];

  let checked = 0;
  let fired = 0;

  for (const eventId of eventIds) {
    if (used >= cap) {
      log.push(`Daily cap of ${cap} reached — stopping.`);
      break;
    }

    const price = await getPrice(eventId);
    used += 1;
    checked += 1;

    if (!price) {
      log.push(`No price returned for event ${eventId}.`);
      continue;
    }

    for (const alert of alerts) {
      if (alert.eventId !== eventId || alert.status !== "watching") continue;

      alert.lastCheckedAt = new Date().toISOString();
      alert.lastSeenPrice = price.getIn;
      alert.priceAsOf = price.asOf;

      if (price.getIn <= alert.maxPrice) {
        const sent = await sendEmail(alert, price);
        if (sent) {
          alert.status = "fired";
          alert.firedAt = new Date().toISOString();
          alert.firedPrice = price.getIn;
          fired += 1;
          log.push(`Emailed ${alert.email} — ${alert.eventName} at $${price.getIn}.`);
        } else {
          log.push(`Email failed for ${alert.email}.`);
        }
      }
    }
  }

  await redis(["SET", ALERTS_KEY, JSON.stringify(alerts)]);
  await redis(["SET", usageKey(), String(used)]);
  await redis(["EXPIRE", usageKey(), "172800"]);

  return json({ checked, fired, requestsUsedToday: used, cap, log });
};

// Every hour, on the hour. Change to "*/15 * * * *" for every 15 minutes,
// or "0 */4 * * *" for every 4 hours.
export const config = {
  schedule: "0 * * * *",
};
