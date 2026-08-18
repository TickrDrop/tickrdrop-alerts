// Searches SeatData for events. The API key never leaves the server.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default async (req) => {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (q.length < 3) {
    return json({ events: [] });
  }

  const key = process.env.SEATDATA_API_KEY;
  if (!key) {
    return json({ error: "SEATDATA_API_KEY is not set." }, 500);
  }

  try {
    const res = await fetch(
      `https://seatdata.io/api/v1/events/search?event_name=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );

    if (!res.ok) {
      return json({ error: `SeatData returned ${res.status}.` }, 502);
    }

    const body = await res.json();
    const today = new Date().toISOString().slice(0, 10);

    const events = (body.data || [])
      // Only upcoming events, and only ones we can send a buyer to.
      .filter((e) => e.event_date >= today && e.tm_event_id)
      .slice(0, 12)
      .map((e) => ({
        eventId: e.event_id,
        name: e.event_name,
        date: e.event_date,
        time: e.event_time,
        venue: e.venue_name,
        city: e.venue_city,
        state: e.venue_state,
        tmEventId: e.tm_event_id,
      }));

    return json({ events });
  } catch (err) {
    return json({ error: "Could not reach SeatData." }, 502);
  }
};
