import {
  fetchIcal,
  classifyEvents,
  applyThemeOverrides,
  clampInt,
  startOfMonth,
  endOfMonth,
  addMonths,
  addDays,
  stripTime,
  sameDay,
  dayKey,
  formatPrice,
} from "./calendar-data.js";

const params = new URLSearchParams(location.search);

const config = {
  ical: params.get("ical") || "",
  proxy: params.get("proxy") ?? "https://calendar-proxy.rfauconn.workers.dev/?url=",
  locale: params.get("locale") || navigator.language || "en-US",
  currency: params.get("currency") || "",
  weekStart: clampInt(params.get("weekStart"), 0, 6, 1), // 0=Sun, 1=Mon
  months: clampInt(params.get("months"), 1, 24, 2),
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
    const text = await fetchIcal(config.ical, config.proxy);
    const { busy, prices } = classifyEvents(text, state.cursor, 12 + config.months, 12);
    state.busy = busy;
    state.prices = prices;
    state.loaded = true;
  } catch (e) {
    console.error(e);
    state.error = "Could not load calendar";
  }
  render();
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

  const months = document.createElement("div");
  months.className = "cal__months";
  if (config.months > 1) months.classList.add("cal__months--multi");
  for (let i = 0; i < config.months; i++) {
    const month = addMonths(state.cursor, i);
    const block = document.createElement("div");
    block.className = "cal__month";
    if (config.months > 1) {
      const sub = document.createElement("div");
      sub.className = "cal__title cal__title--sub";
      sub.textContent = formatMonth(month);
      block.appendChild(sub);
    }
    block.appendChild(renderWeekdays());
    block.appendChild(renderMonthGrid(month));
    months.appendChild(block);
  }
  root.appendChild(months);

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
  const ref = new Date(2024, 0, 7); // Sunday
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
      p.textContent = formatPrice(state.prices.get(key), config.locale, config.currency);
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

function formatMonth(d) {
  return new Intl.DateTimeFormat(config.locale, {
    month: "long",
    year: "numeric",
  }).format(d);
}
