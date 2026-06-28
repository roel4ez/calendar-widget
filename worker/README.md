# booking-handler Worker

Cloudflare Worker that receives the POST from the booking form, server-side
validates it, re-checks availability against the live iCal, and sends two
emails via Resend (host notification + guest auto-reply).

## Deploy

You can deploy by pasting the code into the Cloudflare dashboard (no toolchain
required) or via Wrangler if you prefer a CLI.

### Dashboard route (fastest)

1. **Workers & Pages → Create → Create Worker** in the Cloudflare dashboard.
2. Pick a name (e.g. `booking-handler`) and click **Deploy** on the default
   stub.
3. Click **Edit code**, replace the contents with `booking-handler.js` from
   this folder, and click **Deploy**.
4. **Settings → Variables** — add the secrets below.

### Wrangler route

```sh
npm install -g wrangler
wrangler login
wrangler deploy worker/booking-handler.js --name booking-handler
wrangler secret put RESEND_API_KEY   --name booking-handler
wrangler secret put HOST_EMAIL       --name booking-handler
wrangler secret put FROM_EMAIL       --name booking-handler
wrangler secret put ICAL_URL         --name booking-handler
wrangler secret put ALLOWED_ORIGINS  --name booking-handler
```

## Required secrets / environment variables

| Name              | Example                                                  | Notes                                                                  |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `RESEND_API_KEY`  | `re_xxxxxxxxxxxxxxxx`                                    | From https://resend.com/api-keys                                       |
| `HOST_EMAIL`      | `katrin@typiqe.com`                                      | Where the booking notifications land                                   |
| `FROM_EMAIL`      | `bookings@typiqe.com`                                    | Must be on a verified Resend domain                                    |
| `ICAL_URL`        | `https://calendar.google.com/calendar/ical/.../basic.ics`| Same URL as the widget's `?ical=` — used for the server-side re-check  |
| `ALLOWED_ORIGINS` | `https://yourname.github.io,https://yoursite.com`        | Comma-separated; empty/unset disables origin checking (don't do this!) |
| `REPLY_TO_EMAIL`  | _(optional)_                                             | Override Reply-To on the host email; defaults to the guest's email     |

## Resend domain setup (one-time)

1. Sign up at https://resend.com (free).
2. **Domains → Add Domain** — enter the domain whose `FROM_EMAIL` you want to
   use (e.g. `typiqe.com`).
3. Resend shows DNS records (TXT + MX + DKIM). Add them to the domain's DNS.
4. Wait a few minutes for verification.
5. Generate an API key under **API Keys** and use it as `RESEND_API_KEY`.

Without a verified domain Resend will refuse to send.

## Local testing

```sh
curl -i https://booking-handler.YOURNAME.workers.dev \
  -H "content-type: application/json" \
  -H "Origin: https://yourname.github.io" \
  -d '{
    "checkIn":"2026-08-10","checkOut":"2026-08-15","nights":5,
    "name":"Test","email":"you@example.com","phone":"","guests":2,
    "message":"hello","extras":[],"breakdown":[{"label":"Stay","amount":600}],
    "total":600,"currency":"EUR","lang":"en",
    "icalSource":"https://...","renderedAt":"2026-06-01T10:00:00Z",
    "submittedAt":"2026-06-01T10:00:05Z"
  }'
```

## What the Worker does

1. Rejects non-POST and non-allowed-Origin requests.
2. Rate-limits to 1 request per minute per IP (best-effort in-memory Map).
3. Silently accepts honeypot submissions (`website` field non-empty) — they
   look successful but no email is sent.
4. Validates the payload shape and basic field constraints.
5. Re-fetches `ICAL_URL` and checks whether the requested range overlaps any
   non-`FREE` event (the iCal classifier is a lean text parser; if it fails,
   the request is allowed through to avoid blocking legitimate bookings).
6. Sends the host email (Reply-To = guest, so hitting Reply just works).
7. Sends the guest auto-reply (Reply-To = host).
