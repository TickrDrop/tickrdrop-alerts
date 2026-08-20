// Event search, powered by Ticketmaster's Discovery API.
//
// Discovery is free (5,000 calls/day) and — critically — returns each event's
// real public ticketmaster.com URL. That URL is what TicketsData needs to
// fetch live listings, so this is the bridge between "Karol G" and pricing.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default async (req) => {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 3) return json({ events: [] });

  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return json({ error: "Search isn't configured yet." }, 500);

  const params = new URLSearchParams({
    apikey: key,
    keyword: q,
    countryCode: "US",
    size: "40",
    sort: "date,asc",
  });

  let res;
  try {
    res = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params.toString()}`
    );
  } catch {
    return json({ error: "Couldn't reach Ticketmaster." }, 502);
  }

  if (!res.ok) {
    return json(
      { error: res.status === 401 ? "Search key was rejected." : "Search is unavailable." },
      502
    );
  }

  const body = await res.json();
  const raw = body?._embedded?.events || [];

  const events = raw
    // We can only price events we can hand to TicketsData, so a real URL
    // is non-negotiable.
    .filter((e) => e.url && e.dates?.start?.localDate)
    .map((e) => {
      const venue = e._embedded?.venues?.[0] || {};
      return {
        name: e.name,
        date: e.dates.start.localDate,
        time: e.dates.start.localTime || "",
        venue: venue.name || "",
        city: venue.city?.name || "",
        state: venue.state?.stateCode || "",
        url: e.url,
      };
    })
    // Discovery occasionally repeats an event across classifications.
    .filter((e, i, all) => all.findIndex((o) => o.url === e.url) === i)
    .slice(0, 15);

  return json({ events });
};
