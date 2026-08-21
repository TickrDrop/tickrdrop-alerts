// Real upcoming events from Ticketmaster's Discovery API.
//
// Discovery is free (5,000 calls/day) and returns each event's public URL,
// which is what the alert flow needs. No TicketsData credits are spent here —
// those are only used when an alert actually checks a price.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Trending shifts slowly; cache so we're not hammering Discovery.
      "cache-control": "public, max-age=900",
    },
  });

const CLASSIFICATIONS = {
  music: "music",
  sports: "sports",
  arts: "arts & theatre",
};

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return json({ error: "Search isn't configured yet." }, 500);

  const q = new URLSearchParams({
    apikey: key,
    countryCode: "US",
    size: String(Math.min(Number(params.get("size")) || 12, 40)),
    sort: "relevance,desc",
  });

  const segment = CLASSIFICATIONS[params.get("segment")];
  if (segment) q.set("classificationName", segment);

  // Optional city filter, used by the "near you" row.
  const city = params.get("city");
  if (city) q.set("city", city);

  let res;
  try {
    res = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${q.toString()}`
    );
  } catch {
    return json({ error: "Couldn't reach Ticketmaster." }, 502);
  }

  if (!res.ok) {
    return json(
      { error: res.status === 401 ? "Search key was rejected." : "Unavailable." },
      502
    );
  }

  const body = await res.json();
  const events = (body?._embedded?.events || [])
    .filter((e) => e.url && e.dates?.start?.localDate)
    .map((e) => {
      const venue = e._embedded?.venues?.[0] || {};
      const range = (e.priceRanges || [])[0];
      return {
        name: e.name,
        date: e.dates.start.localDate,
        venue: venue.name || "",
        city: venue.city?.name || "",
        state: venue.state?.stateCode || "",
        segment: e.classifications?.[0]?.segment?.name || "",
        // Ticketmaster's own advertised floor, when they publish one. This is
        // a range they supply, not a live price we fetched.
        from: range?.min ? Math.round(range.min) : null,
        url: e.url,
      };
    })
    .filter((e, i, all) => all.findIndex((o) => o.url === e.url) === i);

  return json({ events });
};
