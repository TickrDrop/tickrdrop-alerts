# TickrDrop alerts — setup

Follow these in order. Don't skip ahead; each one depends on the last.
Total time: about 30 minutes.

---

## What you're setting up

Three accounts talk to each other:

- **Netlify** — hosts the pages and runs the hourly price check. You have this.
- **Upstash** — remembers the alerts people set. Free.
- **Resend** — sends the alert emails. Free.

Plus your existing **SeatData** key for prices.

---

## Step 1 — Upstash (storage)

1. Go to **upstash.com** and sign up (Google or email).
2. Click **Create Database**. Name it `tickrdrop`. Pick the region closest to you. Choose the free tier.
3. On the database page, scroll to **REST API**.
4. Copy these two values into a note. You'll paste them in Step 3.
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

---

## Step 2 — Resend (email)

1. Go to **resend.com** and sign up.
2. Go to **API Keys** → **Create API Key**. Name it `tickrdrop`.
3. Copy the key into your note. It starts with `re_`.

> During testing, emails can only be sent to the address you signed up with.
> That's a Resend rule, not a bug. To email anyone else, you'll verify
> tickrdrop.com under **Domains** later — takes DNS changes and a few hours.

---

## Step 3 — Put the files on Netlify

**If your site is connected to GitHub:** copy these files into your repo,
keeping the folder structure exactly as-is, then commit and push.

**If you drag folders into Netlify:** go to netlify.com, click **Add new site**
→ **Deploy manually**, and drag the whole `tickrdrop-alerts` folder onto the
drop zone. This creates a *separate* test site, which is what you want for now —
your live tickrdrop.com stays untouched.

---

## Step 4 — Add your keys to Netlify

In Netlify: your site → **Site configuration** → **Environment variables** →
**Add a variable** for each of these.

| Name | Value |
|---|---|
| `SEATDATA_API_KEY` | your SeatData key |
| `UPSTASH_REDIS_REST_URL` | from Step 1 |
| `UPSTASH_REDIS_REST_TOKEN` | from Step 1 |
| `RESEND_API_KEY` | from Step 2 |
| `ADMIN_KEY` | any password you invent — protects your alerts page |
| `MONITOR_ENABLED` | `false` — leave it off until you've tested |
| `DAILY_REQUEST_CAP` | `40` |

After adding them all, go to **Deploys** → **Trigger deploy** → **Clear cache
and deploy site**. Environment variables only take effect on a fresh deploy.

---

## Step 5 — Test it

1. Open your new site's URL. Type an artist name. Results should appear.
2. Pick an event. **Set your target ABOVE the current price** — this makes the
   alert fire immediately instead of making you wait days. Use your own email.
3. Go to `/admin.html`, enter your `ADMIN_KEY`. You should see the alert listed
   as *watching*.
4. In Netlify, set `MONITOR_ENABLED` to `true` and redeploy.
5. Go to **Functions** → **check-prices** → **Run**. Within a minute you should
   have an email, and the admin page should show the alert as *fired*.

That's the whole loop working.

---

## Spending controls

Your SeatData balance is small, so three guards are built in:

- `MONITOR_ENABLED=false` stops all price checks instantly. Your off switch.
- `DAILY_REQUEST_CAP` is a hard ceiling. It stops mid-run rather than overspending.
- The checker calls SeatData **once per event**, not once per alert. Ten people
  watching the same show costs one call.

Current schedule is hourly. To change it, edit the last lines of
`netlify/functions/check-prices.mjs`:

```js
export const config = { schedule: "0 * * * *" };   // hourly
// "0 */4 * * *"  = every 4 hours (cheapest, matches SeatData's actual refresh)
// "*/15 * * * *" = every 15 minutes (burns balance fast — don't, on this data)
```

Every-4-hours is the honest setting for SeatData: their prices only update
about three times a day, so checking more often costs money and tells you
nothing new.

---

## Swapping the data source later

All SeatData contact lives in two places:

- `search-events.mjs` → the `fetch` call
- `check-prices.mjs` → the `getPrice()` function

To move to a different provider, those are the only two spots that change.
Everything else — storage, emails, pages, admin — stays as it is.
