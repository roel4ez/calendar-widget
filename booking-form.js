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
  parseDayKey,
  diffDays,
  formatPrice,
  formatMoney,
  parsePriceNumber,
} from "./calendar-data.js";
import { SUPPORTED, detectLanguage, getStrings, languageName } from "./i18n.js";

const params = new URLSearchParams(location.search);

const config = {
  ical: params.get("ical") || "",
  proxy: params.get("proxy") ?? "https://calendar-proxy.rfauconn.workers.dev/?url=",
  endpoint: params.get("endpoint") || "",
  locale: params.get("locale") || navigator.language || "en-US",
  currency: params.get("currency") || "",
  weekStart: clampInt(params.get("weekStart"), 0, 6, 1),
  months: clampInt(params.get("months"), 1, 24, 2),
  showLegend: params.get("legend") !== "false",
  title: params.get("title") || "",
  minStay: clampInt(params.get("minStay"), 1, 365, 1),
  maxStay: clampInt(params.get("maxStay"), 1, 365, 30),
  leadTime: clampInt(params.get("leadTime"), 0, 365, 1),
  checkInDay: parseCheckInDay(params.get("checkInDay")),
  mobileBreakpoint: clampInt(params.get("mobileBreakpoint"), 320, 1200, 600),
  extrasRaw: params.get("extras") || "",
  maxGuests: clampInt(params.get("maxGuests"), 1, 50, 10),
};

applyThemeOverrides(params);

const lang = detectLanguage(params.get("lang"), navigator.language);
let t = getStrings(lang);
let currentLang = lang;

const root = document.getElementById("booking");
const renderedAt = Date.now();

const state = {
  cursor: startOfMonth(new Date()),
  busy: new Set(),
  prices: new Map(),
  minStayMap: new Map(),
  loaded: false,
  error: null,
  // Range selection
  checkIn: null, // Date
  checkOut: null, // Date
  rangeError: null,
  // Form
  form: { name: "", email: "", phone: "", guests: 2, message: "", website: "" },
  selectedExtras: new Set(),
  extras: [],
  // Submission
  submitting: false,
  submitted: false,
  submitError: null,
  // Mobile mode
  isMobile: window.matchMedia(`(max-width: ${config.mobileBreakpoint}px)`).matches,
};

window.addEventListener("resize", () => {
  const wasMobile = state.isMobile;
  state.isMobile = window.matchMedia(`(max-width: ${config.mobileBreakpoint}px)`).matches;
  if (wasMobile !== state.isMobile) render();
});

main();

async function main() {
  state.extras = await loadExtras(config.extrasRaw);
  render();
  if (!config.ical) {
    state.error = "Missing ?ical= parameter";
    render();
    return;
  }
  try {
    const text = await fetchIcal(config.ical, config.proxy);
    const { busy, prices, minStay } = classifyEvents(
      text,
      state.cursor,
      24,
      6
    );
    state.busy = busy;
    state.prices = prices;
    state.minStayMap = minStay;
    state.loaded = true;
  } catch (e) {
    console.error(e);
    state.error = t.loadFail;
  }
  render();
}

// ── Extras loading ─────────────────────────────────────────────────────────

async function loadExtras(raw) {
  if (!raw) return [];
  // If it looks like a path/URL (ends with .json or contains /), fetch it.
  if (/\.json($|\?)/i.test(raw) || raw.startsWith("/") || raw.startsWith("http")) {
    try {
      const res = await fetch(raw, { credentials: "omit" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      return Array.isArray(data) ? data.filter(validExtra) : [];
    } catch (e) {
      console.warn("Could not load extras JSON:", e);
      return [];
    }
  }
  // Inline: key:Label:price:scale,key2:Label2:price2:scale2
  return raw
    .split(",")
    .map((part) => part.split(":"))
    .filter((bits) => bits.length >= 3)
    .map((bits) => ({
      key: bits[0].trim(),
      label: decodeURIComponent(bits[1].trim()),
      price: Number(bits[2]),
      scale: (bits[3] || "flat").trim(),
    }))
    .filter(validExtra);
}

function validExtra(e) {
  return (
    e &&
    typeof e.key === "string" &&
    typeof e.label === "string" &&
    Number.isFinite(Number(e.price)) &&
    ["flat", "perNight", "perGuest"].includes(e.scale || "flat")
  );
}

// ── Rendering ──────────────────────────────────────────────────────────────

function render() {
  root.innerHTML = "";
  root.appendChild(renderHeader());

  if (state.error) {
    root.appendChild(statusEl(state.error, true));
    return;
  }
  if (!state.loaded) {
    root.appendChild(statusEl(t.loading));
    return;
  }
  if (state.submitted) {
    root.appendChild(renderSuccess());
    notifyHeight();
    return;
  }

  // Section: calendar (desktop) or month grid + native pickers (mobile)
  const calSection = document.createElement("section");
  calSection.className = "cal";
  calSection.appendChild(renderCalNav());
  calSection.appendChild(renderMonths());
  if (config.showLegend) calSection.appendChild(renderLegend());
  root.appendChild(calSection);

  // Section: range summary / mobile pickers
  root.appendChild(renderRangeSummary());

  // Section: extras
  if (state.extras.length) root.appendChild(renderExtras());

  // Section: form fields
  root.appendChild(renderForm());

  // Section: total breakdown
  root.appendChild(renderTotal());

  // Submit button + error
  root.appendChild(renderSubmit());

  notifyHeight();
}

function renderHeader() {
  const wrap = document.createElement("div");
  wrap.className = "bf__header";

  const title = document.createElement("div");
  title.className = "cal__title";
  title.textContent = config.title || t.selectDates;
  wrap.appendChild(title);

  // Language switcher
  const sel = document.createElement("select");
  sel.className = "bf__lang";
  sel.setAttribute("aria-label", "Language");
  for (const code of SUPPORTED) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = languageName(code);
    if (code === currentLang) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    currentLang = sel.value;
    t = getStrings(currentLang);
    render();
  });
  wrap.appendChild(sel);

  return wrap;
}

function renderCalNav() {
  const nav = document.createElement("div");
  nav.className = "cal__header";

  const title = document.createElement("div");
  title.className = "cal__title cal__title--month";
  title.textContent =
    config.months === 1 ? formatMonth(state.cursor) : "";
  nav.appendChild(title);

  const ctrls = document.createElement("div");
  ctrls.className = "cal__nav";
  const prev = btn("‹", () => {
    state.cursor = addMonths(state.cursor, -1);
    render();
  });
  prev.setAttribute("aria-label", t.prev);
  const today = btn(t.today, () => {
    state.cursor = startOfMonth(new Date());
    render();
  });
  const next = btn("›", () => {
    state.cursor = addMonths(state.cursor, 1);
    render();
  });
  next.setAttribute("aria-label", t.next);
  ctrls.append(prev, today, next);
  nav.appendChild(ctrls);
  return nav;
}

function renderMonths() {
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
  return months;
}

function renderWeekdays() {
  const row = document.createElement("div");
  row.className = "cal__weekdays";
  const fmt = new Intl.DateTimeFormat(config.locale, { weekday: "short" });
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
  const leadCutoff = addDays(today, config.leadTime);

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
    const beforeLead = date < leadCutoff;
    const allowedWeekday =
      !config.checkInDay || config.checkInDay.includes(date.getDay());

    if (isToday) cell.classList.add("cal__day--today");
    if (isPast) {
      cell.classList.add("cal__day--past");
      cell.classList.add("cal__day--out");
      grid.appendChild(cell);
      continue;
    }
    if (isBusy) cell.classList.add("cal__day--busy");

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

    // Range highlighting
    if (!isBusy) {
      const inRange = isInSelectedRange(date);
      const isCheckIn = state.checkIn && sameDay(date, state.checkIn);
      const isCheckOut = state.checkOut && sameDay(date, state.checkOut);
      if (isCheckIn) cell.classList.add("cal__day--checkin");
      if (isCheckOut) cell.classList.add("cal__day--checkout");
      if (inRange && !isCheckIn && !isCheckOut)
        cell.classList.add("cal__day--inrange");
    }

    // Click handler (desktop only — on mobile the grid is view-only)
    const selectable = !isBusy && !state.isMobile;
    if (selectable) {
      cell.classList.add("cal__day--clickable");
      const disabled = beforeLead || !allowedWeekday;
      if (disabled && !state.checkIn) {
        cell.classList.add("cal__day--disabled");
      } else {
        cell.addEventListener("click", () => onDayClick(date));
      }
    }

    grid.appendChild(cell);
  }
  return grid;
}

function renderLegend() {
  const el = document.createElement("div");
  el.className = "cal__legend";
  el.innerHTML = `
    <span><i class="cal__swatch cal__swatch--free"></i>${escapeHtml(t.available)}</span>
    <span><i class="cal__swatch cal__swatch--busy"></i>${escapeHtml(t.booked)}</span>
    <span><i class="cal__swatch cal__swatch--sel"></i>${escapeHtml(t.selected)}</span>
  `;
  return el;
}

function renderRangeSummary() {
  const wrap = document.createElement("section");
  wrap.className = "bf__range";

  if (state.isMobile) {
    // Native date pickers
    const today = stripTime(new Date());
    const minDate = addDays(today, config.leadTime);
    const minStr = isoDate(minDate);
    // Find max sensible date (1 year out)
    const maxStr = isoDate(addMonths(today, 12));

    const ciLabel = document.createElement("label");
    ciLabel.className = "bf__field";
    ciLabel.innerHTML = `<span>${escapeHtml(t.checkIn || "Check-in")}</span>`;
    const ci = document.createElement("input");
    ci.type = "date";
    ci.min = minStr;
    ci.max = maxStr;
    ci.value = state.checkIn ? isoDate(state.checkIn) : "";
    ci.addEventListener("change", () => {
      const d = ci.value ? parseDayKey(ci.value) : null;
      if (d) tryPickCheckIn(d);
      else {
        state.checkIn = null;
        state.checkOut = null;
      }
      render();
    });
    ciLabel.appendChild(ci);

    const coLabel = document.createElement("label");
    coLabel.className = "bf__field";
    coLabel.innerHTML = `<span>${escapeHtml(t.checkOut || "Check-out")}</span>`;
    const co = document.createElement("input");
    co.type = "date";
    co.min = state.checkIn ? isoDate(addDays(state.checkIn, config.minStay)) : minStr;
    co.max = maxStr;
    co.value = state.checkOut ? isoDate(state.checkOut) : "";
    co.disabled = !state.checkIn;
    co.addEventListener("change", () => {
      const d = co.value ? parseDayKey(co.value) : null;
      if (d) tryPickCheckOut(d);
      render();
    });
    coLabel.appendChild(co);

    wrap.append(ciLabel, coLabel);
  }

  const summary = document.createElement("div");
  summary.className = "bf__summary";

  if (!state.checkIn) {
    summary.textContent = t.pickCheckIn;
  } else if (!state.checkOut) {
    const ci = formatDateShort(state.checkIn);
    summary.innerHTML = `<strong>${escapeHtml(t.checkIn || "Check-in")}:</strong> ${escapeHtml(ci)} · ${escapeHtml(t.pickCheckOut)}`;
  } else {
    const ci = formatDateShort(state.checkIn);
    const co = formatDateShort(state.checkOut);
    const n = diffDays(state.checkIn, state.checkOut);
    const total = stayTotal();
    summary.innerHTML = `
      <strong>${escapeHtml(ci)} → ${escapeHtml(co)}</strong>
      · ${escapeHtml(t.nights(n))}
      ${Number.isFinite(total) ? "· " + escapeHtml(formatMoney(total, config.locale, config.currency)) : ""}
    `;
  }

  if (state.checkIn || state.checkOut) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "bf__clear";
    clear.textContent = t.clearSelection;
    clear.addEventListener("click", () => {
      state.checkIn = null;
      state.checkOut = null;
      state.rangeError = null;
      render();
    });
    summary.appendChild(clear);
  }

  wrap.appendChild(summary);

  if (state.rangeError) {
    const err = document.createElement("div");
    err.className = "bf__error";
    err.textContent = state.rangeError;
    wrap.appendChild(err);
  }

  return wrap;
}

function renderExtras() {
  const wrap = document.createElement("section");
  wrap.className = "bf__section";
  const h = document.createElement("h3");
  h.textContent = t.extras;
  wrap.appendChild(h);

  const list = document.createElement("div");
  list.className = "bf__extras";
  const nights = state.checkIn && state.checkOut ? diffDays(state.checkIn, state.checkOut) : 0;
  const guests = Number(state.form.guests) || 1;

  for (const ex of state.extras) {
    const label = document.createElement("label");
    label.className = "bf__extra";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selectedExtras.has(ex.key);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedExtras.add(ex.key);
      else state.selectedExtras.delete(ex.key);
      render();
    });

    const text = document.createElement("span");
    text.className = "bf__extra-label";
    text.textContent = ex.label;

    const price = document.createElement("span");
    price.className = "bf__extra-price";
    const cost = extraCost(ex, nights, guests);
    const scaleLabel =
      ex.scale === "perNight" ? ` (${t.perNight})` :
      ex.scale === "perGuest" ? ` (${t.perGuest})` : "";
    price.textContent = `+ ${formatMoney(cost, config.locale, config.currency)}${scaleLabel}`;

    label.append(cb, text, price);
    list.appendChild(label);
  }
  wrap.appendChild(list);
  return wrap;
}

function renderForm() {
  const wrap = document.createElement("section");
  wrap.className = "bf__section";
  const h = document.createElement("h3");
  h.textContent = t.contactDetails;
  wrap.appendChild(h);

  const grid = document.createElement("div");
  grid.className = "bf__form";

  grid.appendChild(textField("name", t.name, "text", true));
  grid.appendChild(textField("email", t.email, "email", true));
  grid.appendChild(textField("phone", t.phone, "tel", false));
  grid.appendChild(guestsField());
  grid.appendChild(textField("message", t.message, "textarea", false));

  // Honeypot — visible to bots, hidden from humans
  const honey = document.createElement("input");
  honey.type = "text";
  honey.name = "website";
  honey.tabIndex = -1;
  honey.autocomplete = "off";
  honey.setAttribute("aria-hidden", "true");
  honey.style.position = "absolute";
  honey.style.left = "-9999px";
  honey.style.width = "1px";
  honey.style.height = "1px";
  honey.addEventListener("input", (e) => {
    state.form.website = e.target.value;
  });
  grid.appendChild(honey);

  wrap.appendChild(grid);
  return wrap;
}

function textField(key, label, type, required) {
  const wrap = document.createElement("label");
  wrap.className = "bf__field" + (type === "textarea" ? " bf__field--full" : "");
  const lab = document.createElement("span");
  lab.innerHTML = `${escapeHtml(label)} <em>(${escapeHtml(required ? t.required : t.optional)})</em>`;
  wrap.appendChild(lab);
  const input =
    type === "textarea"
      ? document.createElement("textarea")
      : document.createElement("input");
  if (type !== "textarea") input.type = type;
  input.value = state.form[key] || "";
  input.required = required;
  if (type === "textarea") input.rows = 4;
  input.addEventListener("input", (e) => {
    state.form[key] = e.target.value;
  });
  wrap.appendChild(input);
  return wrap;
}

function guestsField() {
  const wrap = document.createElement("label");
  wrap.className = "bf__field";
  const lab = document.createElement("span");
  lab.innerHTML = `${escapeHtml(t.guests)} <em>(${escapeHtml(t.required)})</em>`;
  wrap.appendChild(lab);
  const sel = document.createElement("select");
  for (let i = 1; i <= config.maxGuests; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i);
    if (i === Number(state.form.guests)) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", (e) => {
    state.form.guests = Number(e.target.value);
    // Re-render so per-guest extras update.
    if (state.extras.some((x) => x.scale === "perGuest")) render();
    else updateTotal();
  });
  wrap.appendChild(sel);
  return wrap;
}

function renderTotal() {
  const wrap = document.createElement("section");
  wrap.className = "bf__section bf__totals";
  const h = document.createElement("h3");
  h.textContent = t.summary;
  wrap.appendChild(h);

  const list = document.createElement("div");
  list.className = "bf__total-list";

  const items = computeBreakdown();
  let priceToConfirm = false;
  for (const item of items) {
    if (item.priceToConfirm) priceToConfirm = true;
    const row = document.createElement("div");
    row.className = "bf__total-row";
    const lab = document.createElement("span");
    lab.textContent = item.label;
    const val = document.createElement("span");
    val.textContent = Number.isFinite(item.amount)
      ? formatMoney(item.amount, config.locale, config.currency)
      : "—";
    row.append(lab, val);
    list.appendChild(row);
  }

  // Total row
  const total = totalAmount();
  const totalRow = document.createElement("div");
  totalRow.className = "bf__total-row bf__total-row--total";
  const tLab = document.createElement("span");
  tLab.textContent = t.total;
  const tVal = document.createElement("span");
  tVal.textContent = Number.isFinite(total)
    ? formatMoney(total, config.locale, config.currency)
    : "—";
  totalRow.append(tLab, tVal);
  list.appendChild(totalRow);

  wrap.appendChild(list);

  if (priceToConfirm) {
    const note = document.createElement("div");
    note.className = "bf__note";
    note.textContent = t.priceToConfirm;
    wrap.appendChild(note);
  }

  return wrap;
}

function renderSubmit() {
  const wrap = document.createElement("section");
  wrap.className = "bf__section bf__submit-wrap";

  if (state.submitError) {
    const err = document.createElement("div");
    err.className = "bf__error";
    err.textContent = state.submitError;
    wrap.appendChild(err);
  }

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "bf__submit";
  submit.textContent = state.submitting ? t.submitting : t.submit;
  submit.disabled = state.submitting;
  submit.addEventListener("click", onSubmit);
  wrap.appendChild(submit);
  return wrap;
}

function renderSuccess() {
  const wrap = document.createElement("section");
  wrap.className = "bf__success";
  wrap.textContent = t.success;
  return wrap;
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

function formatDateShort(d) {
  return new Intl.DateTimeFormat(config.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

function isoDate(d) {
  return dayKey(d);
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

// ── Range selection logic ──────────────────────────────────────────────────

function isInSelectedRange(date) {
  if (!state.checkIn || !state.checkOut) return false;
  return date > state.checkIn && date < state.checkOut;
}

function onDayClick(date) {
  state.rangeError = null;
  // Already have a complete range → start over with this click
  if (state.checkIn && state.checkOut) {
    tryPickCheckIn(date);
    render();
    return;
  }
  // No check-in yet
  if (!state.checkIn) {
    tryPickCheckIn(date);
    render();
    return;
  }
  // Have check-in, need check-out
  if (date.getTime() <= state.checkIn.getTime()) {
    // Restart with this date as the new check-in
    tryPickCheckIn(date);
    render();
    return;
  }
  tryPickCheckOut(date);
  render();
}

function tryPickCheckIn(date) {
  const today = stripTime(new Date());
  if (date < addDays(today, config.leadTime)) {
    state.rangeError = t.errLeadTime(config.leadTime);
    return;
  }
  if (config.checkInDay && !config.checkInDay.includes(date.getDay())) {
    state.rangeError = t.errCheckInDay;
    return;
  }
  if (state.busy.has(dayKey(date))) {
    state.rangeError = t.errBusyInRange;
    return;
  }
  state.checkIn = stripTime(date);
  state.checkOut = null;
  state.rangeError = null;
}

function tryPickCheckOut(date) {
  if (!state.checkIn) return;
  const co = stripTime(date);
  const nights = diffDays(state.checkIn, co);
  if (nights < 1) {
    state.rangeError = t.errMinStay(config.minStay);
    return;
  }
  // Check every night in [checkIn, checkOut) is free
  for (let d = state.checkIn; d < co; d = addDays(d, 1)) {
    if (state.busy.has(dayKey(d))) {
      state.rangeError = t.errBusyInRange;
      return;
    }
  }
  // Per-day minStay rule: take max of global + any in-range per-day
  let effectiveMin = config.minStay;
  for (let d = state.checkIn; d < co; d = addDays(d, 1)) {
    const m = state.minStayMap.get(dayKey(d));
    if (m && m > effectiveMin) effectiveMin = m;
  }
  if (nights < effectiveMin) {
    state.rangeError = t.errMinStay(effectiveMin);
    return;
  }
  if (nights > config.maxStay) {
    state.rangeError = t.errMaxStay(config.maxStay);
    return;
  }
  state.checkOut = co;
  state.rangeError = null;
}

// ── Pricing ────────────────────────────────────────────────────────────────

function stayTotal() {
  if (!state.checkIn || !state.checkOut) return NaN;
  let sum = 0;
  let allPriced = true;
  for (let d = state.checkIn; d < state.checkOut; d = addDays(d, 1)) {
    const raw = state.prices.get(dayKey(d));
    const num = parsePriceNumber(raw);
    if (!Number.isFinite(num) || num <= 0) {
      allPriced = false;
    } else {
      sum += num;
    }
  }
  return allPriced ? sum : NaN;
}

function extraCost(ex, nights, guests) {
  const p = Number(ex.price);
  if (!Number.isFinite(p)) return 0;
  if (ex.scale === "perNight") return p * Math.max(0, nights);
  if (ex.scale === "perGuest") return p * Math.max(1, guests);
  return p;
}

function computeBreakdown() {
  const items = [];
  const nights = state.checkIn && state.checkOut ? diffDays(state.checkIn, state.checkOut) : 0;
  const guests = Number(state.form.guests) || 1;
  const stay = stayTotal();
  if (state.checkIn && state.checkOut) {
    const ci = formatDateShort(state.checkIn);
    const co = formatDateShort(state.checkOut);
    items.push({
      label: `${t.stay} (${t.nights(nights)} · ${ci} → ${co})`,
      amount: stay,
      priceToConfirm: !Number.isFinite(stay),
    });
  } else {
    items.push({ label: t.stay, amount: NaN });
  }
  for (const ex of state.extras) {
    if (!state.selectedExtras.has(ex.key)) continue;
    const scaleLabel =
      ex.scale === "perGuest" ? ` (${guests} × ${t.perGuest})` :
      ex.scale === "perNight" ? ` (${nights} × ${t.perNight})` : "";
    items.push({
      label: ex.label + scaleLabel,
      amount: extraCost(ex, nights, guests),
    });
  }
  return items;
}

function totalAmount() {
  const items = computeBreakdown();
  let sum = 0;
  let priceToConfirm = false;
  for (const it of items) {
    if (!Number.isFinite(it.amount)) {
      priceToConfirm = true;
      continue;
    }
    sum += it.amount;
  }
  return priceToConfirm ? NaN : sum;
}

function updateTotal() {
  // Surgical update for things that don't need a full re-render (e.g. guest count change with no perGuest extras)
  const wrap = root.querySelector(".bf__totals");
  if (!wrap) return;
  const fresh = renderTotal();
  wrap.replaceWith(fresh);
}

// ── Submit ─────────────────────────────────────────────────────────────────

async function onSubmit() {
  state.submitError = null;
  // Honeypot
  if (state.form.website) {
    // Silent drop — looks successful to bots
    state.submitted = true;
    render();
    return;
  }
  // Time-to-submit (≥ 2 seconds since render)
  if (Date.now() - renderedAt < 2000) {
    state.submitError = t.errServer;
    render();
    return;
  }

  const errs = validateForm();
  if (errs.length) {
    state.submitError = errs[0];
    render();
    return;
  }

  if (!config.endpoint) {
    state.submitError = "Missing ?endpoint= (booking-handler Worker URL).";
    render();
    return;
  }

  const payload = buildPayload();

  state.submitting = true;
  render();

  try {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      state.submitError = t.errDatesGone;
    } else if (!res.ok) {
      state.submitError = t.errServer;
    } else {
      state.submitted = true;
    }
  } catch (e) {
    console.error(e);
    state.submitError = t.errServer;
  }
  state.submitting = false;
  render();
}

function validateForm() {
  const errs = [];
  if (!state.checkIn || !state.checkOut) errs.push(t.errNoRange);
  if (!state.form.name.trim() || !state.form.email.trim()) errs.push(t.errMissingFields);
  if (state.form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.form.email))
    errs.push(t.errEmail);
  return errs;
}

function buildPayload() {
  const breakdown = computeBreakdown().map((b) => ({
    label: b.label,
    amount: Number.isFinite(b.amount) ? b.amount : null,
  }));
  const total = totalAmount();
  return {
    checkIn: dayKey(state.checkIn),
    checkOut: dayKey(state.checkOut),
    nights: diffDays(state.checkIn, state.checkOut),
    name: state.form.name.trim(),
    email: state.form.email.trim(),
    phone: state.form.phone.trim(),
    guests: Number(state.form.guests) || 1,
    message: state.form.message.trim(),
    extras: [...state.selectedExtras]
      .map((k) => state.extras.find((x) => x.key === k))
      .filter(Boolean)
      .map((ex) => ({ key: ex.key, label: ex.label, scale: ex.scale, price: ex.price })),
    breakdown,
    total: Number.isFinite(total) ? total : null,
    currency: config.currency || null,
    lang: currentLang,
    icalSource: config.ical,
    renderedAt: new Date(renderedAt).toISOString(),
    submittedAt: new Date().toISOString(),
    website: state.form.website, // honeypot — server should drop if set
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseCheckInDay(v) {
  if (!v) return null;
  const nums = String(v)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return nums.length ? nums : null;
}

function notifyHeight() {
  // Iframe parent can listen for this and resize.
  if (window.parent === window) return;
  requestAnimationFrame(() => {
    const h = document.documentElement.scrollHeight;
    try {
      window.parent.postMessage({ type: "booking-widget:resize", height: h }, "*");
    } catch {
      /* cross-origin frames may reject this — ignore */
    }
  });
}
