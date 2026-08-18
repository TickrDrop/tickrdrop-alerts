// The engine, running on TicketsData live inventory.
//
// Key difference from the old SeatData version: we compare against the
// ALL-IN price (base + fees), not the base price. That's the number the
// buyer actually pays, so an alert can't be undercut at checkout.
//
// Spend guards, in order:
//   MONITOR_ENABLED=false      stops everything
//   DAILY_REQUEST_CAP          hard ceiling on API calls per day
//   one call per event         not one per alert

const ALERTS_KEY = "tickrdrop:alerts";

// Confirmed against the "Equivalent API call" panel in the Live API Tester.
// Note: TicketsData authenticates with username/password as query parameters
// rather than a header, so we never log the request URL anywhere.
const TD_BASE = "https://ticketsdata.com/fetch";

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

// Pull every live resale listing for one event.
async function fetchListings(eventUrl, platform = "ticketmaster") {
  const params = new URLSearchParams({
    event_url: eventUrl,
    platform,
    username: process.env.TICKETSDATA_USERNAME || "",
    password: process.env.TICKETSDATA_PASSWORD || "",
  });

  let res;
  try {
    res = await fetch(`${TD_BASE}?${params.toString()}`);
  } catch {
    return { error: "Could not reach TicketsData." };
  }

  // Never echo the URL back — it carries the credentials.
  if (!res.ok) return { error: `TicketsData returned ${res.status}.` };

  let payload;
  try {
    payload = await res.json();
  } catch {
    return { error: "TicketsData sent something we couldn't read." };
  }

  const offers = payload?.body?._embedded?.offer;
  if (!Array.isArray(offers)) return { error: "No listings in the response." };

  const listings = offers
    .filter((o) => o.inventoryType === "resale")
    .map((o) => ({
      section: o.section || null,
      row: o.row || null,
      base: o.listPrice,
      total: o.totalPrice,
      fees: Number(((o.totalPrice ?? 0) - (o.listPrice ?? 0)).toFixed(2)),
      quantities: o.sellableQuantities || [],
    }))
    .filter((l) => typeof l.total === "number" && l.total > 0);

  return {
    listings,
    asOf: payload?.body?.meta?.modified || new Date().toISOString(),
    quotaRemaining: payload?.quota_remaining ?? null,
  };
}

// Narrow to what this person actually asked for, then take the cheapest.
function bestMatch(listings, alert) {
  let pool = listings;

  if (alert.quantity > 1) {
    pool = pool.filter((l) => l.quantities.includes(alert.quantity));
  }

  if (alert.sections && alert.sections.length) {
    const wanted = alert.sections.map((s) => String(s).toUpperCase());
    pool = pool.filter(
      (l) => l.section && wanted.includes(l.section.toUpperCase())
    );
  }

  if (!pool.length) return null;
  return pool.reduce((a, b) => (b.total < a.total ? b : a));
}

function minutesOld(iso) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function emailBody(alert, hit, asOf) {
  const age = minutesOld(asOf);
  const when = alert.eventDate
    ? new Date(alert.eventDate + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  const seat = [
    hit.section ? `Section ${hit.section}` : null,
    hit.row ? `Row ${hit.row}` : null,
  ]
    .filter(Boolean)
    .join(" &middot; ");

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#0e0f10;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;color:#f4efe6;">

    <div style="font-size:22px;letter-spacing:-0.02em;margin-bottom:28px;">
      <span style="color:#f4efe6;">Tickr</span><span style="color:#e8c468;">Drop</span>
    </div>

    <p style="font-size:15px;line-height:1.5;margin:0 0 4px;">Your price hit.</p>
    <h1 style="font-size:26px;line-height:1.25;margin:0 0 6px;font-weight:normal;">
      ${alert.eventName}
    </h1>
    <p style="font-size:14px;color:#9a958c;margin:0 0 28px;">
      ${when}${alert.venue ? " &middot; " + alert.venue : ""}
    </p>

    <div style="background:#16181a;border-radius:10px;padding:22px 24px;margin-bottom:10px;">
      ${seat ? `<div style="font-size:17px;margin-bottom:14px;">${seat}</div>` : ""}
      <table style="width:100%;font-family:'JetBrains Mono',Menlo,monospace;font-size:14px;">
        <tr>
          <td style="color:#9a958c;padding-bottom:6px;">Ticket</td>
          <td style="text-align:right;padding-bottom:6px;">$${hit.base.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="color:#9a958c;padding-bottom:10px;">Fees</td>
          <td style="text-align:right;padding-bottom:10px;">$${hit.fees.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="color:#f4efe6;border-top:1px solid #24272a;padding-top:10px;">
            You pay${alert.quantity > 1 ? " (each)" : ""}
          </td>
          <td style="color:#e8c468;text-align:right;font-size:21px;border-top:1px solid #24272a;padding-top:10px;">
            $${hit.total.toFixed(2)}
          </td>
        </tr>
      </table>
    </div>

    <p style="font-size:12.5px;color:#7d786f;margin:0 0 22px;">
      Your target was $${alert.maxPrice.toFixed(2)} all-in${alert.quantity > 1 ? `, ${alert.quantity} together` : ""}.
    </p>

    <a href="${alert.eventUrl}"
       style="display:block;background:#e8c468;color:#0e0f10;text-decoration:none;
              text-align:center;padding:15px;border-radius:8px;font-size:16px;
              font-family:Georgia,serif;margin-bottom:22px;">
      Go to tickets
    </a>

    <p style="font-size:12px;line-height:1.6;color:#7d786f;margin:0;">
      Priced ${age === 0 ? "moments" : age + " minute" + (age === 1 ? "" : "s")} ago,
      fees included. Resale moves fast &mdash; this seat may already be gone.
    </p>

  </div>
</body>
</html>`;
}

async function sendEmail(alert, hit, asOf) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.ALERT_FROM_EMAIL || "onboarding@resend.dev",
      to: [alert.email],
      subject: `${alert.eventName} — $${hit.total.toFixed(2)} all-in`,
      html: emailBody(alert, hit, asOf),
    }),
  });
  return res.ok;
}

export default async () => {
  if (process.env.MONITOR_ENABLED !== "true") {
    return json({ skipped: "MONITOR_ENABLED is not true." });
  }
  if (!process.env.TICKETSDATA_USERNAME || !process.env.TICKETSDATA_PASSWORD) {
    return json({ error: "TicketsData credentials are not set." }, 500);
  }

  const cap = Number(process.env.DAILY_REQUEST_CAP || 10);
  const log = [];

  let alerts;
  try {
    const raw = await redis(["GET", ALERTS_KEY]);
    alerts = raw ? JSON.parse(raw) : [];
  } catch {
    return json({ error: "Could not read stored alerts." }, 500);
  }

  const today = new Date().toISOString().slice(0, 10);

  for (const a of alerts) {
    if (a.status === "watching" && a.eventDate && a.eventDate < today) {
      a.status = "expired";
    }
  }

  const watching = alerts.filter((a) => a.status === "watching" && a.eventUrl);
  if (!watching.length) {
    await redis(["SET", ALERTS_KEY, JSON.stringify(alerts)]);
    return json({ checked: 0, fired: 0, note: "Nothing to watch." });
  }

  let used = Number((await redis(["GET", usageKey()])) || 0);
  const eventUrls = [...new Set(watching.map((a) => a.eventUrl))];

  let checked = 0;
  let fired = 0;
  let quota = null;

  for (const eventUrl of eventUrls) {
    if (used >= cap) {
      log.push(`Daily cap of ${cap} reached — stopping.`);
      break;
    }

    const result = await fetchListings(eventUrl);
    used += 1;
    checked += 1;

    if (result.error) {
      log.push(`${result.error}`);
      continue;
    }

    quota = result.quotaRemaining;
    log.push(`${result.listings.length} live resale listings found.`);

    for (const alert of alerts) {
      if (alert.eventUrl !== eventUrl || alert.status !== "watching") continue;

      const hit = bestMatch(result.listings, alert);
      alert.lastCheckedAt = new Date().toISOString();
      alert.lastSeenPrice = hit ? hit.total : null;
      alert.priceAsOf = result.asOf;

      if (!hit) {
        log.push(`Nothing matched ${alert.email}'s filters.`);
        continue;
      }

      if (hit.total <= alert.maxPrice) {
        if (await sendEmail(alert, hit, result.asOf)) {
          alert.status = "fired";
          alert.firedAt = new Date().toISOString();
          alert.firedPrice = hit.total;
          alert.firedSeat = [hit.section, hit.row].filter(Boolean).join(" / ");
          fired += 1;
          log.push(`Emailed ${alert.email} — $${hit.total} in ${hit.section}.`);
        } else {
          log.push(`Email failed for ${alert.email}.`);
        }
      }
    }
  }

  await redis(["SET", ALERTS_KEY, JSON.stringify(alerts)]);
  await redis(["SET", usageKey(), String(used)]);
  await redis(["EXPIRE", usageKey(), "172800"]);

  return json({
    checked,
    fired,
    requestsUsedToday: used,
    cap,
    quotaRemaining: quota,
    log,
  });
};

// Every 15 minutes. This data expires after 60 seconds, so tighter is better —
// but each run costs one credit per distinct event. While on the 25-credit
// trial, leave MONITOR_ENABLED off and run this by hand instead.
// "0 * * * *" = hourly · "*/30 * * * *" = every 30 min
export const config = {
  schedule: "*/15 * * * *",
};
