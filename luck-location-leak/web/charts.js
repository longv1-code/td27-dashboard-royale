/* Tiny dependency-free SVG chart kit for the Gilded Ace dashboard.
   Every chart: thin marks, recessive grid, hover tooltip, colors from CSS tokens. */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const tip = document.createElement("div");
  tip.className = "tip"; tip.hidden = true; tip.setAttribute("role", "status");
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(tip));

  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function showTip(html, ev) {
    tip.innerHTML = html; tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { tip.hidden = true; }

  function niceTicks(lo, hi, n = 5) {
    if (!isFinite(lo) || !isFinite(hi)) return [0];
    if (lo === hi) { hi = lo + 1; }
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const err = step0 / mag, step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const fmt = {
    usd: (v) => v == null ? "–" : (Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e4 ? "$" + (v / 1e3).toFixed(0) + "k" : Math.abs(v) >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "k" : "$" + v.toFixed(0)).replace("$-", "−$"),
    usd0: (v) => v == null ? "–" : (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString("en-US"),
    pct: (v, d = 1) => v == null || !isFinite(v) ? "–" : (v * 100).toFixed(d) + "%",
    num: (v, d = 0) => v == null || !isFinite(v) ? "–" : (+v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }),
    signed: (v, d = 1) => v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d),
  };

  function frame(host, { height = 260, margin = {} } = {}) {
    host.innerHTML = "";
    const W = Math.max(280, host.clientWidth || 600), H = height;
    const m = Object.assign({ t: 14, r: 16, b: 28, l: 56 }, margin);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, class: "chart", role: "img" }, host);
    return { svg, W, H, m, iw: W - m.l - m.r, ih: H - m.t - m.b };
  }

  /* Generic XY chart: numeric x (or index), several line series, optional band, shaded spans, markers. */
  function xy(host, o) {
    const f = frame(host, o);
    const { svg, m, iw, ih } = f;
    const xs = o.x; const n = xs.length;
    const xmin = o.xmin ?? Math.min(...xs), xmax = o.xmax ?? Math.max(...xs);
    let vals = [];
    o.series.forEach((s) => s.values.forEach((v) => v != null && isFinite(v) && vals.push(v)));
    if (o.band) { o.band.lo.forEach((v) => v != null && vals.push(v)); o.band.hi.forEach((v) => v != null && vals.push(v)); }
    if (o.yZero) vals.push(0);
    let ymin = o.ymin ?? Math.min(...vals), ymax = o.ymax ?? Math.max(...vals);
    const padY = (ymax - ymin) * 0.06 || 1; if (o.ymin == null) ymin -= o.yZero && ymin >= 0 ? 0 : padY; if (o.ymax == null) ymax += padY;
    const X = (v) => m.l + ((v - xmin) / (xmax - xmin || 1)) * iw;
    const Y = (v) => m.t + ih - ((v - ymin) / (ymax - ymin || 1)) * ih;
    const g = el("g", {}, svg);
    // shaded spans
    (o.shade || []).forEach((s) => {
      const x0 = X(s.from), x1 = X(s.to);
      el("rect", { x: x0, y: m.t, width: Math.max(1, x1 - x0), height: ih, class: "shade " + (s.cls || "") }, g);
      if (s.label) { const t = el("text", { x: x0 + 4, y: m.t + 11, class: "shade-label" }, g); t.textContent = s.label; }
    });
    // grid + y axis
    niceTicks(ymin, ymax, o.yTicks || 4).forEach((t) => {
      if (t < ymin || t > ymax) return;
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t), class: t === 0 && ymin < 0 ? "zero" : "grid" }, g);
      const tx = el("text", { x: m.l - 6, y: Y(t) + 4, class: "tick", "text-anchor": "end" }, g); tx.textContent = (o.yfmt || fmt.usd)(t);
    });
    (o.hlines || []).forEach((h) => { el("line", { x1: m.l, x2: m.l + iw, y1: Y(h.y), y2: Y(h.y), class: h.cls || "ref" }, g); if (h.label) { const t = el("text", { x: m.l + iw - 2, y: Y(h.y) - 4, class: "tick", "text-anchor": "end" }, g); t.textContent = h.label; } });
    // x ticks
    const xt = o.xticks || niceTicks(xmin, xmax, 6).map((v) => ({ v, label: (o.xfmt || String)(v) }));
    xt.forEach((t) => { if (t.v < xmin || t.v > xmax) return; const tx = el("text", { x: X(t.v), y: m.t + ih + 18, class: "tick", "text-anchor": "middle" }, g); tx.textContent = t.label; });
    el("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: "axis" }, g);
    // band
    if (o.band) {
      let d = "", first = true;
      for (let i = 0; i < n; i++) if (o.band.hi[i] != null) { d += (first ? "M" : "L") + X(xs[i]) + "," + Y(o.band.hi[i]); first = false; }
      for (let i = n - 1; i >= 0; i--) if (o.band.lo[i] != null) d += "L" + X(xs[i]) + "," + Y(o.band.lo[i]);
      el("path", { d: d + "Z", class: "band", style: o.band.color ? `fill:${o.band.color}` : null }, g);
    }
    // series
    o.series.forEach((s) => {
      let d = "", pen = false;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null || !isFinite(v)) { pen = false; continue; }
        d += (pen ? "L" : "M") + X(xs[i]).toFixed(1) + "," + Y(v).toFixed(1); pen = true;
      }
      if (s.area) el("path", { d: d + `L${X(xs[n - 1])},${Y(Math.max(ymin, 0))}L${X(xs[0])},${Y(Math.max(ymin, 0))}Z`, style: `fill:${s.color};opacity:.12;stroke:none` }, g);
      el("path", { d, fill: "none", style: `stroke:${s.color};stroke-width:${s.width || 2}px${s.dash ? ";stroke-dasharray:" + s.dash : ""}`, "stroke-linejoin": "round", "stroke-linecap": "round" }, g);
      if (s.label) { // direct label at last point
        let li = n - 1; while (li > 0 && (s.values[li] == null)) li--;
        const t = el("text", { x: X(xs[li]) + 4, y: Y(s.values[li]) + 4, class: "dlabel" }, g); t.textContent = s.label;
      }
    });
    (o.markers || []).forEach((mk) => {
      const cx = X(mk.x), cy = Y(mk.y);
      el("circle", { cx, cy, r: 5, class: "marker", style: `fill:${mk.color || "var(--accent)"}` }, g);
      if (mk.label) { const t = el("text", { x: cx + (mk.dx ?? 8), y: cy + (mk.dy ?? -8), class: "mlabel", "text-anchor": mk.anchor || "start" }, g); t.textContent = mk.label; }
    });
    // hover layer
    const cross = el("line", { y1: m.t, y2: m.t + ih, class: "cross", visibility: "hidden" }, svg);
    const dots = o.series.map((s) => el("circle", { r: 4, class: "hdot", style: `fill:${s.color}`, visibility: "hidden" }, svg));
    const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
    hit.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect(); const sx = (ev.clientX - r.left) * (f.W / r.width);
      const xv = xmin + ((sx - m.l) / iw) * (xmax - xmin);
      let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const dd = Math.abs(xs[i] - xv); if (dd < bd) { bd = dd; bi = i; } }
      cross.setAttribute("x1", X(xs[bi])); cross.setAttribute("x2", X(xs[bi])); cross.setAttribute("visibility", "visible");
      o.series.forEach((s, k) => { const v = s.values[bi]; if (v == null) { dots[k].setAttribute("visibility", "hidden"); return; } dots[k].setAttribute("cx", X(xs[bi])); dots[k].setAttribute("cy", Y(v)); dots[k].setAttribute("visibility", "visible"); });
      const head = o.tipTitle ? o.tipTitle(bi) : (o.xfmt || String)(xs[bi]);
      const rows = o.series.filter((s) => !s.noTip).map((s) => `<div class="tr"><i style="background:${s.color}"></i><span>${s.name}</span><b>${s.values[bi] == null ? "–" : (s.fmt || o.yfmt || fmt.usd)(s.values[bi])}</b></div>`).join("");
      showTip(`<div class="th">${head}</div>${rows}${o.tipExtra ? o.tipExtra(bi) : ""}`, ev);
    });
    hit.addEventListener("pointerleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); });
    if (o.onClick) hit.addEventListener("click", (ev) => { const r = svg.getBoundingClientRect(); const sx = (ev.clientX - r.left) * (f.W / r.width); const xv = xmin + ((sx - m.l) / iw) * (xmax - xmin); let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const dd = Math.abs(xs[i] - xv); if (dd < bd) { bd = dd; bi = i; } } o.onClick(bi); });
    svg.setAttribute("aria-label", o.aria || "chart");
    return { X, Y, svg };
  }

  /* Bars: vertical (default) or horizontal. items: [{label, value, color, tip, lo, hi}] */
  function bars(host, o) {
    const horiz = !!o.horizontal;
    const items = o.items;
    const height = o.height || (horiz ? Math.max(120, items.length * (o.rowH || 26) + 36) : 240);
    const f = frame(host, { height, margin: Object.assign(horiz ? { l: o.labelW || 120, r: 56, b: 22, t: 8 } : { l: 56, b: 34 }, o.margin || {}) });
    const { svg, m, iw, ih } = f;
    let vals = items.flatMap((d) => [d.value, d.lo, d.hi]).filter((v) => v != null && isFinite(v)); vals.push(0); if (o.ref != null) vals.push(o.ref);
    let lo = o.min ?? Math.min(...vals), hi = o.max ?? Math.max(...vals); if (hi === lo) hi = lo + 1;
    const S = (v) => (horiz ? m.l + ((v - lo) / (hi - lo)) * iw : m.t + ih - ((v - lo) / (hi - lo)) * ih);
    const g = el("g", {}, svg);
    niceTicks(lo, hi, horiz ? 4 : 4).forEach((t) => {
      if (t < lo || t > hi) return;
      if (horiz) { el("line", { x1: S(t), x2: S(t), y1: m.t, y2: m.t + ih, class: t === 0 ? "zero" : "grid" }, g); const tx = el("text", { x: S(t), y: m.t + ih + 15, class: "tick", "text-anchor": "middle" }, g); tx.textContent = (o.fmt || fmt.usd)(t); }
      else { el("line", { x1: m.l, x2: m.l + iw, y1: S(t), y2: S(t), class: t === 0 ? "zero" : "grid" }, g); const tx = el("text", { x: m.l - 6, y: S(t) + 4, class: "tick", "text-anchor": "end" }, g); tx.textContent = (o.fmt || fmt.usd)(t); }
    });
    if (o.ref != null) { if (horiz) el("line", { x1: S(o.ref), x2: S(o.ref), y1: m.t - 4, y2: m.t + ih, class: "ref" }, g); else el("line", { x1: m.l, x2: m.l + iw, y1: S(o.ref), y2: S(o.ref), class: "ref" }, g); }
    const band = (horiz ? ih : iw) / items.length, thick = Math.max(4, Math.min(o.barMax || 22, band - 2 - band * 0.25));
    items.forEach((d, i) => {
      const c = (horiz ? m.t : m.l) + band * i + (band - thick) / 2;
      const a = S(Math.max(lo, Math.min(0, hi))), b = S(d.value);
      const r = horiz ? { x: Math.min(a, b), y: c, width: Math.max(1, Math.abs(b - a)), height: thick } : { x: c, y: Math.min(a, b), width: thick, height: Math.max(1, Math.abs(b - a)) };
      const rect = el("rect", Object.assign(r, { rx: 3, style: `fill:${d.color || "var(--s1)"}`, class: "bar" + (d.cls ? " " + d.cls : "") }), g);
      if (d.lo != null && d.hi != null) {
        if (horiz) { el("line", { x1: S(d.lo), x2: S(d.hi), y1: c + thick / 2, y2: c + thick / 2, class: "whisk" }, g); }
        else el("line", { y1: S(d.lo), y2: S(d.hi), x1: c + thick / 2, x2: c + thick / 2, class: "whisk" }, g);
      }
      if (horiz) {
        const t = el("text", { x: m.l - 8, y: c + thick / 2 + 4, class: "blabel", "text-anchor": "end" }, g); t.textContent = d.label;
        if (o.valueLabels !== false) { const v = el("text", { x: Math.max(a, b, d.hi != null ? S(d.hi) : 0) + 5, y: c + thick / 2 + 4, class: "vlabel" }, g); v.textContent = (o.vfmt || o.fmt || fmt.usd)(d.value); }
      } else {
        const t = el("text", { x: c + thick / 2, y: m.t + ih + 16, class: "tick", "text-anchor": "middle" }, g); t.textContent = d.label;
        if (o.valueLabels) { const v = el("text", { x: c + thick / 2, y: Math.min(a, b) - 5, class: "vlabel", "text-anchor": "middle" }, g); v.textContent = (o.vfmt || o.fmt || fmt.usd)(d.value); }
      }
      const hitR = horiz ? { x: m.l, y: m.t + band * i, width: iw, height: band } : { x: m.l + band * i, y: m.t, width: band, height: ih };
      const hr = el("rect", Object.assign(hitR, { fill: "transparent", class: o.onClick ? "clickable" : "" }), g);
      hr.addEventListener("pointermove", (ev) => { rect.classList.add("hov"); showTip(d.tip || `<div class="th">${d.label}</div><b>${(o.fmt || fmt.usd)(d.value)}</b>`, ev); });
      hr.addEventListener("pointerleave", () => { rect.classList.remove("hov"); hideTip(); });
      if (o.onClick) hr.addEventListener("click", () => o.onClick(d, i));
    });
    svg.setAttribute("aria-label", o.aria || "bar chart");
  }

  /* Heatmap: rows x cols, sequential single hue. */
  function heat(host, o) {
    const cw = o.cellW || 0;
    const f = frame(host, { height: o.height || 230, margin: { l: 44, t: 6, r: 8, b: 26 } });
    const { svg, m, iw, ih } = f;
    const R = o.rows.length, C = o.cols.length, w = iw / C, h = ih / R;
    let mx = 0; o.values.forEach((r) => r.forEach((v) => { if (v > mx) mx = v; }));
    o.values.forEach((row, i) => row.forEach((v, j) => {
      const t = mx ? v / mx : 0;
      const rect = el("rect", { x: m.l + j * w + 1, y: m.t + i * h + 1, width: Math.max(1, w - 2), height: Math.max(1, h - 2), rx: 2, style: `fill:var(--seq);fill-opacity:${(0.06 + 0.94 * t).toFixed(3)}` }, svg);
      rect.addEventListener("pointermove", (ev) => showTip(`<div class="th">${o.rows[i]} · ${o.cols[j]}</div>${o.tip ? o.tip(v, i, j) : fmt.num(v)}`, ev));
      rect.addEventListener("pointerleave", hideTip);
    }));
    o.rows.forEach((r, i) => { const t = el("text", { x: m.l - 6, y: m.t + i * h + h / 2 + 4, class: "tick", "text-anchor": "end" }, svg); t.textContent = r; });
    o.cols.forEach((c, j) => { if (o.colEvery && j % o.colEvery) return; const t = el("text", { x: m.l + j * w + w / 2, y: m.t + ih + 16, class: "tick", "text-anchor": "middle" }, svg); t.textContent = c; });
    svg.setAttribute("aria-label", o.aria || "heatmap");
  }

  window.Charts = { xy, bars, heat, fmt, el, showTip, hideTip, niceTicks, frame };
})();
