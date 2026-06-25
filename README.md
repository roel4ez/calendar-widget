# Calendar widget

A minimal, embeddable month-view calendar that reads availability **and**
prices from a single iCal feed (e.g. a Google Calendar). Designed to be
embedded in a Wix page via `<iframe>` and hosted for free on GitHub
Pages.

- **Zero build step.** Static HTML + ESM imports from a CDN.
- **Minimal default theme**, fully overridable through CSS variables or a
  custom `theme.css`.
- **Free/busy + per-day prices** in one calendar. Title-driven: `FREE: 120`
  marks an available day with its price; anything else is booked.
- Works on phones, fits comfortably in a Wix iframe.

## Quick start

1. Fork or clone this repo.
2. Push to the `main` branch on GitHub.
3. In **Settings → Pages**, set the source to **GitHub Actions**. The
   included workflow publishes the repo as-is.
4. Your widget is live at
   `https://<your-username>.github.io/<repo-name>/`.

## Embedding in Wix

Add an HTML / iframe embed and point it at your Pages URL with query
parameters:

```html
<iframe
  src="https://YOUR.github.io/calendar-widget/?ical=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fical%2F...%2Fbasic.ics&currency=EUR"
  width="100%"
  height="560"
  style="border:0"
  loading="lazy"
></iframe>
```

> **URL-encode** your iCal URL (`encodeURIComponent("...")` in the browser
> console works well).

## Configuration (URL parameters)

| Param        | Default              | Notes                                                            |
| ------------ | -------------------- | ---------------------------------------------------------------- |
| `ical`       | _(required)_         | iCal URL. Title decides free vs busy (see below).                |
| `currency`   | —                    | ISO code, e.g. `EUR`. If set, prices are formatted as currency.  |
| `locale`     | browser locale       | e.g. `nl-BE`, `en-US`. Affects month/weekday names and currency. |
| `weekStart`  | `1` (Mon)            | `0` for Sunday.                                                  |
| `months`     | `2`                  | Number of months to render in a stack (1–24). Pass `months=1` for a single-month view. |
| `title`      | current month name   | Header title override.                                           |
| `legend`     | `true`               | Set `legend=false` to hide.                                      |
| `showPast`   | `true`               | `showPast=false` hides days before today.                        |
| `proxy`      | `https://calendar-proxy.rfauconn.workers.dev/?url=` | CORS proxy (see below). Empty string disables.    |

### Theme overrides via URL

Quick recolouring without editing CSS:

| Param     | CSS variable     |
| --------- | ---------------- |
| `accent`  | `--cal-accent`   |
| `bg`      | `--cal-bg`       |
| `fg`      | `--cal-fg`       |
| `freeBg`  | `--cal-free-bg`  |
| `busyBg`  | `--cal-busy-bg`  |
| `busyFg`  | `--cal-busy-fg`  |
| `border`  | `--cal-border`   |
| `font`    | `--cal-font`     |
| `headerFont` | `--cal-header-font` (month name + Today/prev/next) |
| `headerFg`   | `--cal-header-fg` (month name + Today/prev/next text colour) |
| `radius`  | `--cal-radius`   |

Hex codes need URL-encoding (`#` → `%23`). Example:
`?accent=%23c2410c&busyBg=%23faf5ef`.

For deeper customisation, edit `theme.css` directly — it's the canonical
source of styles.

## Event title conventions

The widget classifies each event in your iCal by its **title (SUMMARY)**:

| Title format             | Meaning                                  |
| ------------------------ | ---------------------------------------- |
| `FREE: 120` / `FREE 120` | Day is available at price `120`          |
| `FREE`                   | Day is available, no price shown         |
| anything else            | Day is **booked** (e.g. `BLOCKED`, guest name, …) |

Matching is case-insensitive, and the price can be any digits with
optional `.` or `,` (e.g. `FREE 99.50`, `FREE: 1,200`). Use
`?currency=EUR` to format prices as currency.

If a day is covered by both a `FREE` event and a booked event, the
booked event wins (no price is shown on busy days).

Example feed:

```
SUMMARY:FREE: 120          ← available, price 120
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260615

SUMMARY:BLOCKED             ← booked
DTSTART;VALUE=DATE:20260605
DTEND;VALUE=DATE:20260608

SUMMARY:Smith family        ← also booked
DTSTART;VALUE=DATE:20260620
DTEND;VALUE=DATE:20260625
```

### Google Calendar gotchas

> ⚠️ Two non-obvious things you must get right when feeding the widget
> from Google Calendar:
>
> 1. **Use the "Secret address in iCal format", not the "Public address".**
>    Google's *public* iCal feed rewrites every event title to literally
>    `Busy` for privacy, so the widget can never see `FREE: 120`. Only
>    the secret address keeps real titles. Find it under **Settings →
>    your calendar → Integrate calendar → Secret address in iCal format**
>    (URL ends in `/private-XXXX/basic.ics`).
> 2. **Set every event's status to "Busy"** (the default). Events marked
>    "Available" are stripped from the iCal export entirely. Use the
>    **title** to mark availability, not the busy/free toggle.

## CORS / proxy

Browsers can't fetch `calendar.google.com/...` directly because Google
doesn't return a CORS header. The widget therefore routes the request
through a tiny "proxy" — a server that fetches the iCal on your behalf
and re-sends it with the right header.

The default proxy points at a private Cloudflare Worker
(`calendar-proxy.rfauconn.workers.dev`) owned by this repo. If you fork
this project you should deploy your own — see below — and override the
default by either editing `widget.js` or passing `?proxy=...`.

Public CORS proxies exist but tend to get rate-limited or blocked when
hitting popular targets like Google Calendar, so a self-hosted Worker is
strongly recommended for anything beyond a quick demo.

### Deploy your own Cloudflare Worker proxy

1. Sign up at https://dash.cloudflare.com/sign-up (free, no card).
2. In the dashboard sidebar: **Workers & Pages → Create → Create Worker**.
3. Pick a name (e.g. `calendar-proxy`) and click **Deploy** — Cloudflare
   makes you deploy a "Hello World" stub before you can edit it.
4. Click **Edit code** and replace everything with:

   ```js
   export default {
     async fetch(req) {
       const url = new URL(req.url).searchParams.get("url");
       if (!url) return new Response("missing ?url=", { status: 400 });
       const res = await fetch(url);
       return new Response(res.body, {
         status: res.status,
         headers: {
           "content-type": "text/calendar",
           "access-control-allow-origin": "*",
           "cache-control": "public, max-age=300",
         },
       });
     },
   };
   ```

5. Click **Deploy**. You now have a URL like
   `https://calendar-proxy.YOURNAME.workers.dev/`.
6. Smoke-test it:
   ```sh
   curl "https://calendar-proxy.YOURNAME.workers.dev/?url=https%3A%2F%2Fcalendar.google.com%2Fcalendar%2Fical%2F...%2Fbasic.ics" | head
   ```
   You should see `BEGIN:VCALENDAR`.
7. Point the widget at it. The `proxy` value must end with `?url=` (URL-
   encoded as `%3Furl%3D`):
   ```
   ?ical=...&proxy=https%3A%2F%2Fcalendar-proxy.YOURNAME.workers.dev%2F%3Furl%3D
   ```

The free Workers tier allows 100,000 requests/day — far more than a Wix
embed will ever generate.

If you can host the iCal yourself with permissive CORS headers, set
`?proxy=` (empty value) to disable the proxy entirely.

## Local development

ESM imports need `http://`, not `file://`, so use a local static server:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000/?ical=...
```

## Files

- `index.html` — page shell
- `widget.js`  — calendar logic (vanilla JS, ical.js from esm.sh)
- `theme.css`  — styles + CSS variables (edit freely)
- `.github/workflows/pages.yml` — GitHub Pages deploy

## License

MIT
