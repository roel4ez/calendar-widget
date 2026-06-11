import ICAL from "https://esm.sh/ical.js@2.1.0";

const params = new URLSearchParams(location.search);

const config = {
  ical: params.get("ical") || "",
  proxy: params.get("proxy") ?? "https://calendar-proxy.rfauconn.workers.dev/?url=",
  locale: params.get("locale") || navigator.language || "en-US",
  currency: params.get("currency") || "",
  weekStart: clampInt(params.get("weekStart"), 0, 6, 1), // 0=Sun, 1=Mon
  months: clampInt(params.get("months"), 1, 24, 1),
  showLegend: params.get("legend") !== "false",
  showPast: params.get("showPast") !== "false",
  title: params.get("title") || "",
};

applyThemeOverrides(params);

const root = document.getElementById("cal");
const state = {
  cursor: startOfMonth(new Date()),
  busy: new Set(),
  prices: new Map(),
  loaded: false,
  error: null,
};

main();

async function main() {
  render();
  if (!config.ical) {
    state.error = "Missing ?ical= parameter";
    render();
    return;
  }
  try {
    const text = await fetchIcal(config.ical);
    const { busy, prices } = classifyEvents(text);
    state.busy = busy;
    state.prices = prices;
    state.loaded = true;
  } catch (e) {
    console.error(e);
    state.error = "Could not load calendar";
  }
  render();
}

function fetchIcal(url) {
  const target = config.proxy
    ? normalizeProxy(config.proxy) + encodeURIComponent(url)
    : url;
  return fetch(target, { credentials: "omit" }).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  });
}

function normalizeProxy(p) {
  let s = p.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  // Ensure it ends with a query separator so the encoded URL appends cleanly.
  if (!/[?&=]$/.test(s)) s += s.includes("?") ? "&" : "/?";
  return s;
}

function parseEvents(icsText) {
  const jcal = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent");
  return vevents.map((v) => new ICAL.Event(v));
}

function classifyEvents(icsText) {
  const busy = new Set();
  const prices = new Map();
  const events = safeParse(icsText);
  const rangeStart = addMonths(state.cursor, -12);
  const rangeEnd = addMonths(state.cursor, 12 + config.months);
  for (const ev of events) {
    if (ev.status && ev.status.toUpperCase() === "CANCELLED") continue;
    const summary = (ev.summary || "").trim();
    const priceMatch = summary.match(/^free\b[^\d-]*([\d.,]+)/i);
    const isFree = /^free\b/i.test(summary);
    iterateOccurrences(ev, rangeStart, rangeEnd, (start, end) => {
      forEachDay(start, end, (d) => {
        const k = dayKey(d);
        if (priceMatch) prices.set(k, priceMatch[1]);
        else if (isFree) {
          /* free with no price: leave neither busy nor priced */
        } else busy.add(k);
      });
    });
  }
  return { busy, prices };
}

function safeParse(icsText) {
  try {
    return parseEvents(icsText);
  } catch (e) {
    console.warn("ical parse failed", e);
    return [];
  }
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

function render() {
  root.innerHTML = "";
  root.appendChild(renderHeader());

  if (state.error) {
    root.appendChild(statusEl(state.error, true));
    return;
  }
  if (!state.loaded) {
    root.appendChild(statusEl("Loading…"));
    return;
  }

  for (let i = 0; i < config.months; i++) {
    const month = addMonths(state.cursor, i);
    if (i > 0) {
      const sub = document.createElement("div");
      sub.className = "cal__title cal__title--sub";
      sub.style.marginTop = "20px";
      sub.style.marginBottom = "8px";
      sub.textContent = formatMonth(month);
      root.appendChild(sub);
    }
    root.appendChild(renderWeekdays());
    root.appendChild(renderMonthGrid(month));
  }

  if (config.showLegend) root.appendChild(renderLegend());
}

function renderHeader() {
  const wrap = document.createElement("div");
  wrap.className = "cal__header";

  const title = document.createElement("div");
  title.className = "cal__title";
  title.textContent =
    config.title || (config.months === 1 ? formatMonth(state.cursor) : "");
  wrap.appendChild(title);

  const nav = document.createElement("div");
  nav.className = "cal__nav";

  const prev = btn("‹", () => {
    state.cursor = addMonths(state.cursor, -1);
    render();
  });
  const today = btn("Today", () => {
    state.cursor = startOfMonth(new Date());
    render();
  });
  const next = btn("›", () => {
    state.cursor = addMonths(state.cursor, 1);
    render();
  });
  nav.append(prev, today, next);
  wrap.appendChild(nav);
  return wrap;
}

function renderWeekdays() {
  const row = document.createElement("div");
  row.className = "cal__weekdays";
  const fmt = new Intl.DateTimeFormat(config.locale, { weekday: "short" });
  // Reference Sunday: 2024-01-07 was a Sunday.
  const ref = new Date(2024, 0, 7);
  for (let i = 0; i < 7; i++) {
    const d = addDays(ref, (config.weekStart + i) % 7);
    const cell = document.createElement("div");
    cell.className = "cal__weekday";
    cell.textContent = fmt.format(d);
    row.appendChild(cell);
  }
  return row;
}

function renderMonthGrid(monthDate) {
  const grid = document.createElement("div");
  grid.className = "cal__grid";
  const first = startOfMonth(monthDate);
  const last = endOfMonth(monthDate);
  const leading = (first.getDay() - config.weekStart + 7) % 7;
  const totalCells = Math.ceil((leading + last.getDate()) / 7) * 7;
  const today = stripTime(new Date());

  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - leading + 1;
    const cell = document.createElement("div");
    cell.className = "cal__day";
    if (dayNum < 1 || dayNum > last.getDate()) {
      cell.classList.add("cal__day--out");
      grid.appendChild(cell);
      continue;
    }
    const date = new Date(first.getFullYear(), first.getMonth(), dayNum);
    const key = dayKey(date);
    const isPast = date < today;
    const isToday = sameDay(date, today);
    const isBusy = state.busy.has(key);

    if (isToday) cell.classList.add("cal__day--today");
    if (isPast) cell.classList.add("cal__day--past");
    if (isBusy) cell.classList.add("cal__day--busy");

    if (isPast && !config.showPast) {
      cell.classList.add("cal__day--out");
      grid.appendChild(cell);
      continue;
    }

    const num = document.createElement("div");
    num.className = "cal__num";
    num.textContent = String(dayNum);
    cell.appendChild(num);

    cell.setAttribute(
      "aria-label",
      `${date.toDateString()} — ${isBusy ? "booked" : "available"}`
    );

    if (!isBusy && state.prices.has(key)) {
      const p = document.createElement("div");
      p.className = "cal__price";
      p.textContent = formatPrice(state.prices.get(key));
      cell.appendChild(p);
    }

    grid.appendChild(cell);
  }
  return grid;
}

function renderLegend() {
  const el = document.createElement("div");
  el.className = "cal__legend";
  el.innerHTML = `
    <span><i class="cal__swatch cal__swatch--free"></i>Available</span>
    <span><i class="cal__swatch cal__swatch--busy"></i>Booked</span>
  `;
  return el;
}

function statusEl(text, isError = false) {
  const el = document.createElement("div");
  el.className = "cal__status" + (isError ? " cal__status--error" : "");
  el.textContent = text;
  return el;
}

function btn(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cal__btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function formatPrice(raw) {
  const num = Number(String(raw).replace(/[^\d.,-]/g, "").replace(",", "."));
  if (config.currency && Number.isFinite(num) && num > 0) {
    try {
      return new Intl.NumberFormat(config.locale, {
        style: "currency",
        currency: config.currency,
        maximumFractionDigits: 0,
      }).format(num);
    } catch {
      /* fall through */
    }
  }
  return raw;
}

function formatMonth(d) {
  return new Intl.DateTimeFormat(config.locale, {
    month: "long",
    year: "numeric",
  }).format(d);
}

function applyThemeOverrides(p) {
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

function clampInt(v, min, max, dflt) {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function stripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n) {
  return String(n).padStart(2, "0");
}
