/* Humidity dashboard — fetches /api/readings and renders stat tiles,
   three single-series line charts (small multiples), and the table.
   Vanilla JS + SVG, no dependencies. */

"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const CHARTS = [
  // Hero: humidity, fixed 0-100% scale, full width and taller.
  { id: "chart-rh",   field: "rh",     cssVar: "--series-rh",   decimals: 1, unit: "%",
    w: 800, h: 260, domain: [0, 100], ticks: 5 },
  // Small multiples underneath, half width each, auto-scaled y.
  { id: "chart-temp", field: "temp_c", cssVar: "--series-temp", decimals: 1, unit: "°C",
    w: 390, h: 170, ticks: 3 },
  { id: "chart-vbat", field: "vbat",   cssVar: "--series-vbat", decimals: 2, unit: "V",
    w: 390, h: 170, ticks: 3 },
];
const PAD = { top: 10, right: 14, bottom: 22, left: 44 };
const INTERVAL_MS = 5 * 60 * 1000;

let currentHours = 24;

function fmt(v, decimals) {
  return v == null ? "–" : v.toFixed(decimals);
}

function timeLabel(iso, rangeHours) {
  const d = new Date(iso);
  if (rangeHours <= 24) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString([], { hour: "numeric" });
}

function el(name, attrs, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const ticks = [];
  for (let t = lo; t <= max + step * 0.001; t += step) {
    if (t >= min - step * 0.001) ticks.push(+t.toFixed(10));
  }
  return ticks;
}

function renderChart(cfg, rows, rangeHours) {
  const host = document.getElementById(cfg.id);
  host.textContent = "";
  const pts = rows.filter(r => r[cfg.field] != null);
  if (pts.length < 2) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Not enough data yet.";
    host.appendChild(p);
    return;
  }

  const W = cfg.w, H = cfg.h;
  const xs = pts.map(r => new Date(r.iso_ts).getTime());
  const ys = pts.map(r => r[cfg.field]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin, yMax;
  if (cfg.domain) {
    [yMin, yMax] = cfg.domain;           // fixed scale (hero RH: 0-100%)
  } else {
    yMin = Math.min(...ys); yMax = Math.max(...ys);
    const yPad = (yMax - yMin) * 0.1 || 0.5;
    yMin -= yPad; yMax += yPad;
  }

  const X = t => PAD.left + ((t - xMin) / (xMax - xMin || 1)) * (W - PAD.left - PAD.right);
  const Y = v => H - PAD.bottom - ((v - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, null);
  host.appendChild(svg);

  // gridlines + y labels (clean numbers, recessive)
  for (const t of niceTicks(yMin, yMax, cfg.ticks || 4)) {
    el("line", { x1: PAD.left, x2: W - PAD.right, y1: Y(t), y2: Y(t), class: "grid-line" }, svg);
    const lbl = el("text", { x: PAD.left - 6, y: Y(t) + 4, "text-anchor": "end", class: "axis-label" }, svg);
    lbl.textContent = cfg.decimals >= 2 ? t.toFixed(2) : String(+t.toFixed(1));
  }
  // x labels: first / middle / last on wide charts, first / last on small ones
  for (const frac of (W >= 600 ? [0, 0.5, 1] : [0, 1])) {
    const t = xMin + frac * (xMax - xMin);
    const anchor = frac === 0 ? "start" : frac === 1 ? "end" : "middle";
    const lbl = el("text", { x: X(t), y: H - 6, "text-anchor": anchor, class: "axis-label" }, svg);
    lbl.textContent = timeLabel(new Date(t).toISOString(), rangeHours);
  }

  const color = getComputedStyle(document.documentElement).getPropertyValue(cfg.cssVar).trim();
  const lineD = pts.map((r, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join("");
  const areaD = lineD +
    `L${X(xs[xs.length - 1]).toFixed(1)},${H - PAD.bottom}L${X(xs[0]).toFixed(1)},${H - PAD.bottom}Z`;
  el("path", { d: areaD, fill: color, class: "area-fill" }, svg);
  el("path", { d: lineD, stroke: color, class: "series-line" }, svg);
  // end-dot with surface ring
  el("circle", {
    cx: X(xs[xs.length - 1]), cy: Y(ys[ys.length - 1]), r: 4, fill: color, class: "end-dot",
  }, svg);

  attachHover(host, svg, cfg, pts, xs, ys, X, Y, color, rangeHours);
}

function attachHover(host, svg, cfg, pts, xs, ys, X, Y, color, rangeHours) {
  const W = cfg.w, H = cfg.h;
  const crosshair = el("line", {
    y1: PAD.top, y2: H - PAD.bottom, class: "crosshair", visibility: "hidden",
  }, svg);
  const dot = el("circle", { r: 4, fill: color, class: "end-dot", visibility: "hidden" }, svg);

  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.hidden = true;
  const key = document.createElement("span");
  key.className = "key";
  key.style.borderTopColor = color;
  const val = document.createElement("span");
  val.className = "val";
  const when = document.createElement("div");
  when.className = "when";
  tip.append(key, val, when);
  host.appendChild(tip);

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    const target = xs[0] + ((mx - PAD.left) / (W - PAD.left - PAD.right)) * (xs[xs.length - 1] - xs[0]);
    let best = 0;
    for (let i = 1; i < xs.length; i++) {
      if (Math.abs(xs[i] - target) < Math.abs(xs[best] - target)) best = i;
    }
    const px = X(xs[best]), py = Y(ys[best]);
    crosshair.setAttribute("x1", px);
    crosshair.setAttribute("x2", px);
    crosshair.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px);
    dot.setAttribute("cy", py);
    dot.setAttribute("visibility", "visible");
    val.textContent = `${fmt(ys[best], cfg.decimals)} ${cfg.unit}`;
    when.textContent = timeLabel(pts[best].iso_ts, rangeHours);
    tip.hidden = false;
    const hostRect = host.getBoundingClientRect();
    let left = ((px / W) * hostRect.width) + 12;
    if (left + tip.offsetWidth > hostRect.width) left -= tip.offsetWidth + 24;
    tip.style.left = `${left}px`;
    tip.style.top = `${(py / H) * hostRect.height - 8}px`;
  }
  function onLeave() {
    crosshair.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.hidden = true;
  }
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);
}

function renderTiles(rows) {
  const last = rows.length ? rows[rows.length - 1] : null;
  document.getElementById("tile-temp").textContent = last ? `${fmt(last.temp_c, 1)} °C` : "–";
  document.getElementById("tile-rh").textContent = last ? `${fmt(last.rh, 1)} %` : "–";
  document.getElementById("tile-vbat").textContent = last && last.vbat != null ? `${fmt(last.vbat, 2)} V` : "–";

  const seen = document.getElementById("tile-seen");
  const status = document.getElementById("tile-status");
  if (!last) {
    seen.textContent = "–";
    status.textContent = "";
    return;
  }
  const age = Date.now() - new Date(last.iso_ts).getTime();
  seen.textContent = new Date(last.iso_ts).toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  if (age > 2.5 * INTERVAL_MS) {
    const mins = Math.round(age / 60000);
    status.textContent = `⚠ ${mins} min ago — node may be offline`;
    status.className = "tile-status warn";
  } else {
    status.textContent = "on schedule";
    status.className = "tile-status";
  }
}

function renderTable(rows) {
  const tbody = document.querySelector("#readings-table tbody");
  tbody.textContent = "";
  for (const r of rows.slice(-20).reverse()) {
    const tr = document.createElement("tr");
    const cells = [
      new Date(r.iso_ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      fmt(r.temp_c, 1), fmt(r.rh, 1), fmt(r.vbat, 2),
      r.rssi == null ? "–" : String(r.rssi),
      r.boot == null ? "–" : String(r.boot),
      r.err == null ? "" : String(r.err),
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 6 && text) td.className = "err";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

async function refresh() {
  const res = await fetch(`/api/readings?hours=${currentHours}`);
  const { rows } = await res.json();
  renderTiles(rows);
  for (const cfg of CHARTS) renderChart(cfg, rows, currentHours);
  renderTable(rows);
}

document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach(b => b.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    currentHours = +btn.dataset.hours;
    refresh();
  });
});

refresh();
setInterval(refresh, 60 * 1000);

// Background tabs freeze setInterval (and system sleep halts it entirely), so
// a dormant tab keeps showing its last fetch and the staleness counter just
// climbs. Re-fetch the moment the tab becomes visible again to catch up.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
