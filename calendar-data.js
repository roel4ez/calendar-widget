// Shared calendar data helpers used by both the read-only calendar (widget.js)
// and the booking form (booking-form.js).
import ICAL from "https://esm.sh/ical.js@2.1.0";

export function fetchIcal(url, proxy) {
  const target = proxy ? normalizeProxy(proxy) + encodeURIComponent(url) : url;
  return fetch(target, { credentials: "omit" }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

export function normalizeProxy(p) {
  let s = String(p).trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  if (!/[?&=]$/.test(s)) s += s.includes("?") ? "&" : "/?";
  return s;
}

function parseEvents(icsText) {
  const jcal = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent");
  return vevents.map((v) => new ICAL.Event(v));
}

function safeParse(icsText) {
  try {
    return parseEvents(icsText);
  } catch (e) {
    console.warn("ical parse failed", e);
    return [];
  }
}

// Classify each day from the iCal feed.
// Returns:
//   busy: Set<dayKey>
//   prices: Map<dayKey, string>  (raw price string)
//   minStay: Map<dayKey, number> (parsed from `min<N>` in FREE titles)
export function classifyEvents(icsText, anchorDate, monthsAhead = 12, monthsBehind = 12) {
  const busy = new Set();
  const prices = new Map();
  const minStay = new Map();
  const events = safeParse(icsText);
  const rangeStart = addMonths(anchorDate, -monthsBehind);
  const rangeEnd = addMonths(anchorDate, monthsAhead);
  for (const ev of events) {
    if (ev.status && ev.status.toUpperCase() === "CANCELLED") continue;
    const summary = (ev.summary || "").trim();
    const priceMatch = summary.match(/^free\b[^\d-]*([\d.,]+)/i);
    const isFree = /^free\b/i.test(summary);
    const minMatch = summary.match(/\bmin(\d+)\b/i);
    iterateOccurrences(ev, rangeStart, rangeEnd, (start, end) => {
      forEachDay(start, end, (d) => {
        const k = dayKey(d);
        if (priceMatch) prices.set(k, priceMatch[1]);
        if (isFree && minMatch) minStay.set(k, parseInt(minMatch[1], 10));
        if (!isFree) busy.add(k);
      });
    });
  }
  // Defensive: don't list a day as busy AND priced — busy wins.
  for (const k of busy) prices.delete(k);
  return { busy, prices, minStay };
}

function iterateOccurrences(ev, rangeStart, rangeEnd, cb) {
  const startDate = ev.startDate;
  const endDate = ev.endDate;
  if (!startDate) return;
  if (ev.isRecurring()) {
    const it = ev.iterator();
    let next;
    let guard = 0;
    while ((next = it.next()) && guard++ < 2000) {
      const occStart = next.toJSDate();
      if (occStart > rangeEnd) break;
      const details = ev.getOccurrenceDetails(next);
      const occEnd = details.endDate.toJSDate();
      if (occEnd < rangeStart) continue;
      cb(occStart, occEnd, startDate.isDate);
    }
  } else {
    const s = startDate.toJSDate();
    const e = endDate ? endDate.toJSDate() : s;
    if (e < rangeStart || s > rangeEnd) return;
    cb(s, e, startDate.isDate);
  }
}

function forEachDay(start, end, cb) {
  // iCal DTEND is exclusive for all-day events; for timed events, count the
  // end day only if the event extends past midnight on that day.
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  let last;
  if (sameDay(start, end)) {
    last = s;
  } else {
    const endMid = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    const endsAtMidnight =
      end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0;
    last = endsAtMidnight ? addDays(endMid, -1) : endMid;
  }
  for (let d = s; d <= last; d = addDays(d, 1)) cb(d);
}

// ── theme overrides ────────────────────────────────────────────────────────

export function applyThemeOverrides(p) {
  const map = {
    accent: "--cal-accent",
    bg: "--cal-bg",
    fg: "--cal-fg",
    freeBg: "--cal-free-bg",
    busyBg: "--cal-busy-bg",
    busyFg: "--cal-busy-fg",
    border: "--cal-border",
    font: "--cal-font",
    headerFont: "--cal-header-font",
    headerFg: "--cal-header-fg",
    radius: "--cal-radius",
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(map)) {
    const val = p.get(k);
    if (val) root.style.setProperty(v, val);
  }
}

// ── date utils ─────────────────────────────────────────────────────────────

export function clampInt(v, min, max, dflt) {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
export function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
export function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
export function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
export function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseDayKey(k) {
  const [y, m, d] = k.split("-").map((x) => parseInt(x, 10));
  return new Date(y, m - 1, d);
}
export function diffDays(a, b) {
  const ms = stripTime(b) - stripTime(a);
  return Math.round(ms / 86400000);
}
function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatPrice(raw, locale, currency) {
  const num = Number(String(raw).replace(/[^\d.,-]/g, "").replace(",", "."));
  if (currency && Number.isFinite(num) && num > 0) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(num);
    } catch {
      /* fall through */
    }
  }
  return String(raw);
}

export function formatMoney(num, locale, currency) {
  if (!Number.isFinite(num)) return "—";
  if (currency) {
    try {
      return new Intl.NumberFormat(locale, {
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

export function parsePriceNumber(raw) {
  if (raw == null) return NaN;
  const num = Number(String(raw).replace(/[^\d.,-]/g, "").replace(",", "."));
  return num;
}
