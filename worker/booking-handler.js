// booking-handler — Cloudflare Worker
//
// Receives a POST from the booking-form widget, server-side-validates the
// request (including a fresh check against the live iCal), and sends two
// emails via Resend:
//   1. Host notification with full booking details and price breakdown
//   2. Guest auto-reply confirming receipt
//
// Required secrets (set with `wrangler secret put` or in the dashboard):
//   RESEND_API_KEY     — Resend API key
//   HOST_EMAIL         — Where to send the host notification (e.g. host@example.com)
//   FROM_EMAIL         — Verified sender on your Resend domain (e.g. bookings@yourdomain.com)
//   ICAL_URL           — The same iCal URL the widget uses (for re-checking availability)
//   ALLOWED_ORIGINS    — Comma-separated list of allowed Origin headers
//                        e.g. "https://yourname.github.io,https://yoursite.com"
//
// Optional:
//   REPLY_TO_EMAIL     — Set to override the Reply-To header on the host email
//                        (defaults to the guest's email so the host can hit Reply)

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ratelimit = new Map(); // ip -> last submission timestamp

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const isAllowed = allowed.length === 0 || allowed.includes(origin);

    if (req.method === "OPTIONS") return cors(origin, isAllowed);
    if (req.method !== "POST") return text("method not allowed", 405);
    if (!isAllowed) return text("forbidden", 403);

    const ip =
      req.headers.get("CF-Connecting-IP") ||
      req.headers.get("X-Forwarded-For") ||
      "unknown";
    if (rateLimited(ip)) return json({ errors: ["rate limited"] }, 429, origin);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ errors: ["invalid JSON"] }, 400, origin);
    }

    // Honeypot — silently accept and drop
    if (body.website) return json({ ok: true }, 200, origin);

    const errors = validate(body);
    if (errors.length) return json({ errors }, 400, origin);

    // Re-check availability against the live iCal
    try {
      const icalText = await fetchIcal(env.ICAL_URL || body.icalSource);
      if (overlapsBusy(icalText, body.checkIn, body.checkOut)) {
        return json({ errors: ["Dates no longer available"] }, 409, origin);
      }
    } catch (e) {
      console.warn("iCal re-check failed:", e);
      // Fail open — better than blocking legitimate bookings if proxy is down
    }

    // Send the two emails
    try {
      await sendHostEmail(env, body);
      await sendGuestEmail(env, body);
    } catch (e) {
      console.error("email send failed:", e);
      return json({ errors: ["email send failed"] }, 502, origin);
    }

    return json({ ok: true }, 200, origin);
  },
};

// ── Validation ─────────────────────────────────────────────────────────────

function validate(b) {
  const errs = [];
  if (!isDateStr(b.checkIn)) errs.push("invalid checkIn");
  if (!isDateStr(b.checkOut)) errs.push("invalid checkOut");
  if (isDateStr(b.checkIn) && isDateStr(b.checkOut)) {
    const ci = parseDate(b.checkIn);
    const co = parseDate(b.checkOut);
    if (co <= ci) errs.push("checkOut must be after checkIn");
    if (diffDays(ci, co) > 365) errs.push("range too long");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (ci < today) errs.push("checkIn in the past");
  }
  if (!b.name || typeof b.name !== "string" || b.name.length > 200)
    errs.push("invalid name");
  if (!b.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || b.email.length > 200)
    errs.push("invalid email");
  if (b.phone && (typeof b.phone !== "string" || b.phone.length > 50))
    errs.push("invalid phone");
  if (b.message && (typeof b.message !== "string" || b.message.length > 5000))
    errs.push("message too long");
  if (!Number.isInteger(b.guests) || b.guests < 1 || b.guests > 50)
    errs.push("invalid guests");
  return errs;
}

function isDateStr(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function diffDays(a, b) {
  return Math.round((b - a) / 86400000);
}

// ── iCal re-check ──────────────────────────────────────────────────────────

async function fetchIcal(url) {
  if (!url) throw new Error("no iCal URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error("ical HTTP " + res.status);
  return res.text();
}

// Parses an iCal text and checks whether [checkIn, checkOut) overlaps any
// booked (non-FREE) event. This is a lean text-based parser sufficient for
// Google Calendar's iCal export — it doesn't need full RFC 5545 support.
function overlapsBusy(icalText, checkIn, checkOut) {
  const ci = parseDate(checkIn);
  const co = parseDate(checkOut);
  const events = parseVEvents(icalText);
  for (const ev of events) {
    const summary = (ev.SUMMARY || "").trim();
    if (/^free\b/i.test(summary)) continue; // FREE marks availability, not busy
    if ((ev.STATUS || "").toUpperCase() === "CANCELLED") continue;
    const start = parseDtValue(ev.DTSTART);
    const end = parseDtValue(ev.DTEND) || start;
    if (!start) continue;
    // Events overlap [ci, co) if start < co and end > ci
    if (start < co && end > ci) return true;
  }
  return false;
}

function parseVEvents(text) {
  const events = [];
  const lines = unfoldLines(text).split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const keyPart = line.slice(0, sep);
      const value = line.slice(sep + 1);
      const key = keyPart.split(";")[0]; // strip params like ;VALUE=DATE
      if (key === "DTSTART" || key === "DTEND") {
        cur[key] = { params: keyPart.slice(key.length + 1), value };
      } else {
        cur[key] = value;
      }
    }
  }
  return events;
}

function unfoldLines(text) {
  // iCal "line folding": a line starting with whitespace is a continuation of the previous line.
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseDtValue(field) {
  if (!field) return null;
  const v = field.value;
  // YYYYMMDD (date-only) or YYYYMMDDTHHMMSSZ
  const dateOnly = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    return new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
  }
  const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (dt) {
    if (dt[7]) return new Date(Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]));
    return new Date(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]);
  }
  return null;
}

// ── Email rendering ────────────────────────────────────────────────────────

async function sendHostEmail(env, b) {
  const subject = `Booking request from ${b.name} (${b.checkIn} → ${b.checkOut})`;
  const html = renderHostEmail(b);
  const text = renderHostEmailText(b);
  return sendResend(env, {
    to: env.HOST_EMAIL,
    replyTo: env.REPLY_TO_EMAIL || b.email,
    subject,
    html,
    text,
  });
}

async function sendGuestEmail(env, b) {
  const subject = renderGuestSubject(b);
  const html = renderGuestEmail(b);
  const text = renderGuestEmailText(b);
  return sendResend(env, {
    to: b.email,
    replyTo: env.HOST_EMAIL,
    subject,
    html,
    text,
  });
}

function renderHostEmail(b) {
  const breakdown = (b.breakdown || [])
    .map(
      (row) =>
        `<tr><td style="padding:4px 12px 4px 0;">${escapeHtml(row.label)}</td>` +
        `<td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums;">${row.amount != null ? formatMoney(row.amount, b.currency) : "—"}</td></tr>`
    )
    .join("");
  const totalRow = `<tr><td style="padding:8px 12px 4px 0;border-top:1px solid #ddd;font-weight:600;">Total</td>` +
    `<td style="padding:8px 0 4px;border-top:1px solid #ddd;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${b.total != null ? formatMoney(b.total, b.currency) : "—"}</td></tr>`;
  const extrasNote =
    b.extras && b.extras.length
      ? `<p><strong>Selected extras:</strong> ${b.extras.map((e) => escapeHtml(e.label)).join(", ")}</p>`
      : "";
  return `
    <div style="font-family:system-ui,sans-serif;font-size:14px;color:#111;line-height:1.5;max-width:560px;">
      <h2 style="margin:0 0 12px;">New booking request</h2>
      <p><strong>${escapeHtml(b.name)}</strong> (${escapeHtml(b.email)}${b.phone ? `, ${escapeHtml(b.phone)}` : ""}) requested:</p>
      <p style="font-size:16px;">
        <strong>${escapeHtml(b.checkIn)} → ${escapeHtml(b.checkOut)}</strong>
        · ${b.nights} night${b.nights === 1 ? "" : "s"}
        · ${b.guests} guest${b.guests === 1 ? "" : "s"}
      </p>
      ${b.message ? `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #ccc;color:#444;white-space:pre-wrap;">${escapeHtml(b.message)}</blockquote>` : ""}
      ${extrasNote}
      <table style="border-collapse:collapse;margin-top:12px;font-size:13px;">${breakdown}${totalRow}</table>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
      <p style="color:#666;font-size:12px;">Reply directly to this email to contact the guest. Language: ${b.lang || "en"}. Submitted: ${escapeHtml(b.submittedAt || "")}.</p>
    </div>
  `;
}

function renderHostEmailText(b) {
  const lines = [
    `New booking request from ${b.name} <${b.email}>${b.phone ? ` (${b.phone})` : ""}`,
    ``,
    `Dates: ${b.checkIn} → ${b.checkOut} (${b.nights} night${b.nights === 1 ? "" : "s"})`,
    `Guests: ${b.guests}`,
  ];
  if (b.message) lines.push(``, `Message:`, b.message);
  if (b.extras && b.extras.length)
    lines.push(``, `Extras: ${b.extras.map((e) => e.label).join(", ")}`);
  lines.push(``, `Price breakdown:`);
  for (const row of b.breakdown || []) {
    const amt = row.amount != null ? formatMoney(row.amount, b.currency) : "—";
    lines.push(`  ${row.label}  ${amt}`);
  }
  lines.push(`  ─────`);
  lines.push(`  Total  ${b.total != null ? formatMoney(b.total, b.currency) : "(to confirm)"}`);
  lines.push(``, `Submitted: ${b.submittedAt}`);
  return lines.join("\n");
}

function renderGuestSubject(b) {
  const subjects = {
    en: `We received your booking request`,
    nl: `We hebben je aanvraag ontvangen`,
    fr: `Nous avons reçu votre demande`,
    de: `Wir haben Ihre Anfrage erhalten`,
  };
  return subjects[b.lang] || subjects.en;
}

function renderGuestEmail(b) {
  const greeting = {
    en: `Hi ${escapeHtml(b.name)},`,
    nl: `Hallo ${escapeHtml(b.name)},`,
    fr: `Bonjour ${escapeHtml(b.name)},`,
    de: `Hallo ${escapeHtml(b.name)},`,
  }[b.lang] || `Hi ${escapeHtml(b.name)},`;
  const body = {
    en: `Thanks for your booking request. We've received the details below and will get back to you shortly to confirm.`,
    nl: `Bedankt voor je aanvraag. We hebben de gegevens hieronder ontvangen en komen snel bij je terug.`,
    fr: `Merci pour votre demande. Nous avons bien reçu les informations ci-dessous et vous recontacterons rapidement.`,
    de: `Danke für Ihre Anfrage. Wir haben die folgenden Angaben erhalten und melden uns in Kürze bei Ihnen.`,
  }[b.lang] || `Thanks for your booking request. We'll get back to you shortly.`;
  const summary = {
    en: `Your request`,
    nl: `Jouw aanvraag`,
    fr: `Votre demande`,
    de: `Ihre Anfrage`,
  }[b.lang] || `Your request`;
  const breakdown = (b.breakdown || [])
    .map(
      (row) =>
        `<tr><td style="padding:4px 12px 4px 0;">${escapeHtml(row.label)}</td>` +
        `<td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums;">${row.amount != null ? formatMoney(row.amount, b.currency) : "—"}</td></tr>`
    )
    .join("");
  const totalLabel = { en: "Total", nl: "Totaal", fr: "Total", de: "Gesamt" }[b.lang] || "Total";
  const totalRow = `<tr><td style="padding:8px 12px 4px 0;border-top:1px solid #ddd;font-weight:600;">${totalLabel}</td>` +
    `<td style="padding:8px 0 4px;border-top:1px solid #ddd;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">${b.total != null ? formatMoney(b.total, b.currency) : "—"}</td></tr>`;
  return `
    <div style="font-family:system-ui,sans-serif;font-size:14px;color:#111;line-height:1.5;max-width:560px;">
      <p>${greeting}</p>
      <p>${body}</p>
      <h3 style="margin:20px 0 8px;">${summary}</h3>
      <p>${escapeHtml(b.checkIn)} → ${escapeHtml(b.checkOut)} · ${b.nights} · ${b.guests} guest${b.guests === 1 ? "" : "s"}</p>
      <table style="border-collapse:collapse;font-size:13px;">${breakdown}${totalRow}</table>
    </div>
  `;
}

function renderGuestEmailText(b) {
  const intro = {
    en: `Hi ${b.name},\n\nThanks for your booking request. We'll get back to you shortly.`,
    nl: `Hallo ${b.name},\n\nBedankt voor je aanvraag. We komen snel bij je terug.`,
    fr: `Bonjour ${b.name},\n\nMerci pour votre demande. Nous vous recontacterons rapidement.`,
    de: `Hallo ${b.name},\n\nDanke für Ihre Anfrage. Wir melden uns in Kürze bei Ihnen.`,
  }[b.lang] || `Hi ${b.name},\n\nThanks for your booking request.`;
  return `${intro}\n\n${b.checkIn} → ${b.checkOut} (${b.nights} nights, ${b.guests} guests)\nTotal: ${b.total != null ? formatMoney(b.total, b.currency) : "(to confirm)"}`;
}

function formatMoney(num, currency) {
  if (!Number.isFinite(num)) return "—";
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(num);
    } catch {
      /* fall through */
    }
  }
  return String(Math.round(num));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// ── Resend ─────────────────────────────────────────────────────────────────

async function sendResend(env, { to, replyTo, subject, html, text }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
  if (!env.FROM_EMAIL) throw new Error("FROM_EMAIL missing");
  const payload = {
    from: env.FROM_EMAIL,
    to: [to],
    subject,
    html,
    text,
  };
  if (replyTo) payload.reply_to = replyTo;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${t}`);
  }
  return res.json();
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function parseAllowedOrigins(s) {
  return (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function cors(origin, isAllowed) {
  return new Response(null, { status: 204, headers: corsHeaders(origin, isAllowed) });
}

function corsHeaders(origin, isAllowed) {
  return {
    "Access-Control-Allow-Origin": isAllowed && origin ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(origin || "", true),
    },
  });
}

function text(msg, status) {
  return new Response(msg, { status });
}

function rateLimited(ip) {
  const now = Date.now();
  const last = ratelimit.get(ip);
  // Best-effort cleanup so the Map doesn't grow unbounded
  if (ratelimit.size > 1000) {
    for (const [k, v] of ratelimit) {
      if (now - v > RATE_LIMIT_WINDOW_MS * 5) ratelimit.delete(k);
    }
  }
  if (last && now - last < RATE_LIMIT_WINDOW_MS) return true;
  ratelimit.set(ip, now);
  return false;
}
