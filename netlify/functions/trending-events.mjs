// Upcoming events from Ticketmaster's Discovery API.
//
// Note on ordering: Discovery exposes no popularity or "trending" ranking for
// events. Sorting by relevance with no keyword returns something close to
// arbitrary, so we sort by date and show the soonest events instead. Label it
// accordingly in the UI — this is "happening soon", not "trending".
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

// Discovery returns a spread of crops. Prefer a wide one around card width;
// fall back to whatever is available rather than showing nothing.
function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const wide = images
    .filter((i) => i.url && i.ratio === "16_9" && (i.width || 0) >= 480)
    .sort((a, b) => (a.width || 0) - (b.width || 0))[0];
  return (wide || images.find((i) => i.url) || {}).url || null;
}

const CLASSIFICATIONS = {
  music: "music",
  sports: "sports",
  arts: "arts & theatre",
};

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) return json({ error: "Search isn't configured yet." }, 500);

  const want = Math.min(Number(params.get("size")) || 12, 40);

  // De-duplicating by performer collapses residencies hard — a dozen dates of
  // one act become one card. Pull a deep pool so there's enough left over.
  const q = new URLSearchParams({
    apikey: key,
    countryCode: "US",
    size: "180",
    sort: "date,asc",
    startDateTime: new Date().toISOString().slice(0, 19) + "Z",
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

  const mapped = (body?._embedded?.events || [])
    .filter((e) => e.url && e.dates?.start?.localDate)
    .map((e) => {
      const venue = e._embedded?.venues?.[0] || {};
      const attraction = e._embedded?.attractions?.[0] || {};
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
        image: pickImage(e.images),
        seatmap: e.seatmap?.staticUrl || null,
        url: e.url,
        // Used only for de-duplication below.
        _key: attraction.id || e.name,
      };
    });

  // Discovery happily returns a dozen dates of the same residency. Show each
  // performer once — the soonest date — so the grid isn't eleven Eagles shows.
  const seen = new Set();
  const events = mapped
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((e) => {
      if (seen.has(e._key)) return false;
      seen.add(e._key);
      return true;
    })
    .map(({ _key, ...rest }) => rest)
    .slice(0, want);

  return json({ events });
};
