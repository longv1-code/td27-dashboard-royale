/* Tiny dependency-free SVG chart kit for the Gilded Ace dashboard.
   Every chart: thin marks, recessive grid, hover tooltip, colors from CSS tokens.

   Motion: each chart remembers its last drawn geometry (keyed by panel id + aria label).
   When the same chart is redrawn with new data (period, zone, bank, slider…), bars, whiskers,
   value labels and line paths tween from where they were to where they are now, instead of
   popping. The first time a chart appears, bars grow from the baseline and lines draw in
   left to right. Charts.forget() clears memory (used on tab change), Charts.instant(true)
   skips motion (used on window resize). */
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

  // ------------------------------------------------------------------ motion
  const MEM = new Map();
  let INSTANT = false, uid = 0;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  /* run fn(t) from 0→1 over dur ms; fn(1) immediately when motion is off */
  function animate(dur, fn, delay = 0) {
    if (INSTANT || reduced()) { fn(1); return; }
    let t0 = null;
    fn(0);
    const step = (now) => {
      if (t0 == null) t0 = now + delay;
      const p = Math.max(0, Math.min(1, (now - t0) / dur));
      fn(ease(p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function memKey(host, o, kind) {
    if (o.key) return kind + ":" + o.key;
    const p = host.closest("[id]");
    return kind + ":" + (p ? p.id : "") + ":" + (o.aria || "");
  }
  /* y (pixels) of a remembered polyline at pixel x; clamps to its ends */
  function yAt(prev, x) {
    if (!prev) return null;
    const { px, py } = prev; let lastI = -1, firstI = -1;
    for (let i = 0; i < px.length; i++) if (py[i] != null) { if (firstI < 0) firstI = i; lastI = i; }
    if (firstI < 0) return null;
    if (x <= px[firstI]) return py[firstI];
    if (x >= px[lastI]) return py[lastI];
    for (let i = firstI; i < lastI; i++) {
      if (py[i] == null) continue;
      let j = i + 1; while (j <= lastI && py[j] == null) j++;
      if (x >= px[i] && x <= px[j]) { const t = (x - px[i]) / (px[j] - px[i] || 1); return lerp(py[i], py[j], t); }
      i = j - 1;
    }
    return py[lastI];
  }

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
    const m = Object.assign({ t: 16, r: 18, b: 30, l: 58 }, margin);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, class: "chart", role: "img" }, host);
    return { svg, W, H, m, iw: W - m.l - m.r, ih: H - m.t - m.b };
  }

  /* Generic XY chart: numeric x (or index), several line series, optional band, shaded spans, markers. */
  function xy(host, o) {
    const f = frame(host, o);
    const { svg, m, iw, ih } = f;
    const key = memKey(host, o, "xy"), prev = MEM.get(key);
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
    const base = Y(Math.max(ymin, Math.min(0, ymax)));
    const g = el("g", {}, svg);
    // shaded spans
    (o.shade || []).forEach((s) => {
      const x0 = Math.max(m.l, X(s.from)), x1 = Math.min(m.l + iw, X(s.to));
      if (x1 <= x0) return;
      el("rect", { x: x0, y: m.t, width: Math.max(1, x1 - x0), height: ih, class: "shade " + (s.cls || "") }, g);
      if (s.label) { const t = el("text", { x: x0 + 5, y: m.t + 13, class: "shade-label" }, g); t.textContent = s.label; }
    });
    // grid + y axis
    niceTicks(ymin, ymax, o.yTicks || 4).forEach((t) => {
      if (t < ymin || t > ymax) return;
      el("line", { x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t), class: t === 0 && ymin < 0 ? "zero" : "grid" }, g);
      const tx = el("text", { x: m.l - 8, y: Y(t) + 4, class: "tick", "text-anchor": "end" }, g); tx.textContent = (o.yfmt || fmt.usd)(t);
    });
    (o.hlines || []).forEach((h) => { el("line", { x1: m.l, x2: m.l + iw, y1: Y(h.y), y2: Y(h.y), class: h.cls || "ref" }, g); if (h.label) { const t = el("text", { x: m.l + iw - 2, y: Y(h.y) - 4, class: "tick", "text-anchor": "end" }, g); t.textContent = h.label; } });
    // x ticks
    const xt = o.xticks || niceTicks(xmin, xmax, 6).map((v) => ({ v, label: (o.xfmt || String)(v) }));
    xt.forEach((t) => { if (t.v < xmin || t.v > xmax) return; const tx = el("text", { x: X(t.v), y: m.t + ih + 20, class: "tick", "text-anchor": "middle" }, g); tx.textContent = t.label; });
    el("line", { x1: m.l, x2: m.l + iw, y1: m.t + ih, y2: m.t + ih, class: "axis" }, g);

    // marks live in their own group so a first draw can wipe in left → right
    const marks = el("g", {}, svg);
    const px = xs.map(X);
    const toPx = (arr) => arr.map((v) => (v == null || !isFinite(v) ? null : Y(v)));
    const tracks = [];
    const startFor = (name, target) => {
      const p = prev && prev.tracks[name];
      return target.map((y, i) => (y == null ? null : p ? (yAt(p, px[i]) ?? base) : base));
    };
    let bandNode = null;
    if (o.band) {
      bandNode = el("path", { class: "band", style: o.band.color ? `fill:${o.band.color}` : null }, marks);
      const hiT = toPx(o.band.hi), loT = toPx(o.band.lo);
      tracks.push({ name: "__hi", target: hiT, start: startFor("__hi", hiT) }, { name: "__lo", target: loT, start: startFor("__lo", loT) });
    }
    const lineNodes = o.series.map((s) => {
      const target = toPx(s.values);
      tracks.push({ name: "s:" + s.name, target, start: startFor("s:" + s.name, target) });
      const area = s.area ? el("path", { style: `fill:${s.color};opacity:.14;stroke:none` }, marks) : null;
      const line = el("path", { fill: "none", style: `stroke:${s.color};stroke-width:${s.width || 2}px${s.dash ? ";stroke-dasharray:" + s.dash : ""}`, "stroke-linejoin": "round", "stroke-linecap": "round" }, marks);
      return { s, area, line };
    });
    const pathOf = (py) => { let d = "", pen = false; for (let i = 0; i < n; i++) { const v = py[i]; if (v == null) { pen = false; continue; } d += (pen ? "L" : "M") + px[i].toFixed(1) + "," + v.toFixed(1); pen = true; } return d; };
    const live = {};
    const drawAt = (t) => {
      tracks.forEach((tr) => { live[tr.name] = tr.target.map((y, i) => (y == null ? null : lerp(tr.start[i], y, t))); });
      if (bandNode) {
        const hi = live.__hi, lo = live.__lo; let d = "", first = true;
        for (let i = 0; i < n; i++) if (hi[i] != null) { d += (first ? "M" : "L") + px[i] + "," + hi[i]; first = false; }
        for (let i = n - 1; i >= 0; i--) if (lo[i] != null) d += "L" + px[i] + "," + lo[i];
        bandNode.setAttribute("d", d ? d + "Z" : "");
      }
      lineNodes.forEach(({ s, area, line }) => {
        const d = pathOf(live["s:" + s.name]);
        line.setAttribute("d", d);
        if (area && d) area.setAttribute("d", d + `L${px[n - 1]},${base}L${px[0]},${base}Z`);
      });
    };
    if (prev) animate(o.morphMs || 650, drawAt);
    else {
      drawAt(1);
      if (!INSTANT && !reduced()) {
        const id = "clip" + ++uid, cp = el("clipPath", { id }, el("defs", {}, svg));
        const r = el("rect", { x: 0, y: 0, width: m.l, height: f.H }, cp);
        marks.setAttribute("clip-path", `url(#${id})`);
        animate(o.introMs || 900, (t) => r.setAttribute("width", m.l + (iw + m.r) * t));
      }
    }
    MEM.set(key, { tracks: Object.fromEntries(tracks.map((tr) => [tr.name, { px, py: tr.target }])) });

    // direct labels + markers sit on the final geometry and fade in once the marks settle
    const late = el("g", { class: "late" }, svg);
    o.series.forEach((s) => {
      if (!s.label) return;
      let li = n - 1; while (li > 0 && (s.values[li] == null)) li--;
      const t = el("text", { x: X(xs[li]) + 5, y: Y(s.values[li]) + 4, class: "dlabel" }, late); t.textContent = s.label;
    });
    (o.markers || []).forEach((mk) => {
      const cx = X(mk.x), cy = Y(mk.y);
      el("circle", { cx, cy, r: 5, class: "marker", style: `fill:${mk.color || "var(--accent)"}` }, late);
      if (mk.label) { const t = el("text", { x: cx + (mk.dx ?? 8), y: cy + (mk.dy ?? -8), class: "mlabel", "text-anchor": mk.anchor || "start" }, late); t.textContent = mk.label; }
    });
    if (!prev && late.childNodes.length) animate(300, (t) => late.setAttribute("opacity", t), (o.introMs || 900) * 0.7);

    // hover layer
    const cross = el("line", { y1: m.t, y2: m.t + ih, class: "cross", visibility: "hidden" }, svg);
    const dots = o.series.map((s) => el("circle", { r: 4.5, class: "hdot", style: `fill:${s.color}`, visibility: "hidden" }, svg));
    const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
    const nearest = (ev) => { const r = svg.getBoundingClientRect(); const sx = (ev.clientX - r.left) * (f.W / r.width); const xv = xmin + ((sx - m.l) / iw) * (xmax - xmin); let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const dd = Math.abs(xs[i] - xv); if (dd < bd) { bd = dd; bi = i; } } return bi; };
    hit.addEventListener("pointermove", (ev) => {
      const bi = nearest(ev);
      cross.setAttribute("x1", X(xs[bi])); cross.setAttribute("x2", X(xs[bi])); cross.setAttribute("visibility", "visible");
      o.series.forEach((s, k) => { const v = s.values[bi]; if (v == null) { dots[k].setAttribute("visibility", "hidden"); return; } dots[k].setAttribute("cx", X(xs[bi])); dots[k].setAttribute("cy", Y(v)); dots[k].setAttribute("visibility", "visible"); });
      const head = o.tipTitle ? o.tipTitle(bi) : (o.xfmt || String)(xs[bi]);
      const rows = o.series.filter((s) => !s.noTip).map((s) => `<div class="tr"><i style="background:${s.color}"></i><span>${s.name}</span><b>${s.values[bi] == null ? "–" : (s.fmt || o.yfmt || fmt.usd)(s.values[bi])}</b></div>`).join("");
      showTip(`<div class="th">${head}</div>${rows}${o.tipExtra ? o.tipExtra(bi) : ""}`, ev);
    });
    hit.addEventListener("pointerleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); });
    if (o.onClick) hit.addEventListener("click", (ev) => o.onClick(nearest(ev)));
    svg.setAttribute("aria-label", o.aria || "chart");
    return { X, Y, svg };
  }

  /* Bars: vertical (default) or horizontal. items: [{label, value, color, tip, lo, hi, key}]
     Items are matched to the previous draw by key (or label), so a re-ranked list slides into its new order. */
  function bars(host, o) {
    const horiz = !!o.horizontal;
    const items = o.items;
    const height = o.height || (horiz ? Math.max(130, items.length * (o.rowH || 30) + 40) : 250);
    const f = frame(host, { height, margin: Object.assign(horiz ? { l: o.labelW || 120, r: 64, b: 24, t: 8 } : { l: 58, b: 36 }, o.margin || {}) });
    const { svg, m, iw, ih } = f;
    const key = memKey(host, o, "bars"), prev = MEM.get(key) || null;
    let vals = items.flatMap((d) => [d.value, d.lo, d.hi]).filter((v) => v != null && isFinite(v)); vals.push(0); if (o.ref != null) vals.push(o.ref);
    let lo = o.min ?? Math.min(...vals), hi = o.max ?? Math.max(...vals); if (hi === lo) hi = lo + 1;
    const S = (v) => { const c = Math.max(lo, Math.min(hi, v)); return horiz ? m.l + ((c - lo) / (hi - lo)) * iw : m.t + ih - ((c - lo) / (hi - lo)) * ih; };
    const g = el("g", {}, svg);
    niceTicks(lo, hi, 4).forEach((t) => {
      if (t < lo || t > hi) return;
      if (horiz) { el("line", { x1: S(t), x2: S(t), y1: m.t, y2: m.t + ih, class: t === 0 ? "zero" : "grid" }, g); const tx = el("text", { x: S(t), y: m.t + ih + 17, class: "tick", "text-anchor": "middle" }, g); tx.textContent = (o.fmt || fmt.usd)(t); }
      else { el("line", { x1: m.l, x2: m.l + iw, y1: S(t), y2: S(t), class: t === 0 ? "zero" : "grid" }, g); const tx = el("text", { x: m.l - 8, y: S(t) + 4, class: "tick", "text-anchor": "end" }, g); tx.textContent = (o.fmt || fmt.usd)(t); }
    });
    if (o.ref != null) { if (horiz) el("line", { x1: S(o.ref), x2: S(o.ref), y1: m.t - 4, y2: m.t + ih, class: "ref" }, g); else el("line", { x1: m.l, x2: m.l + iw, y1: S(o.ref), y2: S(o.ref), class: "ref" }, g); }
    const band = (horiz ? ih : iw) / Math.max(1, items.length), thick = Math.max(4, Math.min(o.barMax || 22, band - 2 - band * 0.25));
    const a = S(Math.max(lo, Math.min(0, hi)));
    const vf = o.vfmt || o.fmt || fmt.usd;
    const next = {};
    items.forEach((d, i) => {
      const id = d.key ?? d.label;
      const c = (horiz ? m.t : m.l) + band * i + (band - thick) / 2;
      const b = S(d.value);
      const tgt = { c, b, wlo: d.lo != null ? S(d.lo) : null, whi: d.hi != null ? S(d.hi) : null, v: d.value };
      const p = prev && prev[id];
      // new bars grow from the baseline; known bars move from where they were (value, length and rank)
      const src = p || { c, b: a, wlo: null, whi: null, v: 0, fresh: true };
      next[id] = tgt;
      const rect = el("rect", { rx: 3, style: `fill:${d.color || "var(--s1)"}`, class: "bar" + (d.cls ? " " + d.cls : "") }, g);
      const whisk = tgt.wlo != null && tgt.whi != null ? el("line", { class: "whisk" }, g) : null;
      const lab = el("text", horiz ? { x: m.l - 10, class: "blabel", "text-anchor": "end" } : { class: "tick", "text-anchor": "middle" }, g); lab.textContent = d.label;
      const showV = horiz ? o.valueLabels !== false : !!o.valueLabels;
      const vl = showV ? el("text", horiz ? { class: "vlabel" } : { class: "vlabel", "text-anchor": "middle" }, g) : null;
      const set = (t) => {
        const cc = lerp(src.c, c, t), bb = lerp(src.b, b, t);
        const w0 = src.wlo != null ? lerp(src.wlo, tgt.wlo, t) : tgt.wlo, w1 = src.whi != null ? lerp(src.whi, tgt.whi, t) : tgt.whi;
        if (horiz) {
          rect.setAttribute("x", Math.min(a, bb)); rect.setAttribute("width", Math.max(1, Math.abs(bb - a))); rect.setAttribute("y", cc); rect.setAttribute("height", thick);
          if (whisk) { whisk.setAttribute("x1", w0); whisk.setAttribute("x2", w1); whisk.setAttribute("y1", cc + thick / 2); whisk.setAttribute("y2", cc + thick / 2); }
          lab.setAttribute("y", cc + thick / 2 + 4);
          if (vl) { vl.setAttribute("x", Math.max(a, bb, whisk ? w1 : 0) + 6); vl.setAttribute("y", cc + thick / 2 + 4); vl.textContent = vf(t >= 1 ? d.value : lerp(src.v, d.value, t)); }
        } else {
          rect.setAttribute("y", Math.min(a, bb)); rect.setAttribute("height", Math.max(1, Math.abs(bb - a))); rect.setAttribute("x", cc); rect.setAttribute("width", thick);
          if (whisk) { whisk.setAttribute("y1", w0); whisk.setAttribute("y2", w1); whisk.setAttribute("x1", cc + thick / 2); whisk.setAttribute("x2", cc + thick / 2); }
          lab.setAttribute("x", cc + thick / 2); lab.setAttribute("y", m.t + ih + 18);
          if (vl) { vl.setAttribute("x", cc + thick / 2); vl.setAttribute("y", Math.min(a, bb) - 6); vl.textContent = vf(t >= 1 ? d.value : lerp(src.v, d.value, t)); }
        }
        if (whisk && src.fresh) whisk.setAttribute("opacity", Math.max(0, (t - 0.6) / 0.4));
      };
      animate(prev ? 650 : 700, set, prev ? 0 : i * 35);
      const hitR = horiz ? { x: m.l, y: m.t + band * i, width: iw, height: band } : { x: m.l + band * i, y: m.t, width: band, height: ih };
      const hr = el("rect", Object.assign(hitR, { fill: "transparent", class: o.onClick ? "clickable" : "" }), g);
      hr.addEventListener("pointermove", (ev) => { rect.classList.add("hov"); showTip(d.tip || `<div class="th">${d.label}</div><b>${(o.fmt || fmt.usd)(d.value)}</b>`, ev); });
      hr.addEventListener("pointerleave", () => { rect.classList.remove("hov"); hideTip(); });
      if (o.onClick) hr.addEventListener("click", () => o.onClick(d, i));
    });
    MEM.set(key, next);
    svg.setAttribute("aria-label", o.aria || "bar chart");
  }

  /* Heatmap: rows x cols, sequential single hue. */
  function heat(host, o) {
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

  /* Tween the first number inside an element's text from its previous value (remembered by key)
     to the new one: "$1.06M", "9 / 10", "16.1%", "−$63k". The first appearance counts up from 0.
     Unchanged values stay still; changed ones get a brief flash (.ticked) so the eye finds them. */
  const NUMS = new Map();
  function tweenNumber(node, key) {
    const txt = node.textContent, m = txt.match(/-?[\d,]*\.?\d+/);
    if (!m) return;
    const target = parseFloat(m[0].replace(/,/g, "")), dec = (m[0].split(".")[1] || "").length, comma = m[0].includes(",");
    const known = NUMS.has(key), from = known ? NUMS.get(key) : 0;
    NUMS.set(key, target);
    if (from === target) return;
    const show = (v) => { let s = (+v).toFixed(dec); if (comma) s = (+s).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); return txt.replace(m[0], s); };
    if (known) { node.classList.remove("ticked"); void node.offsetWidth; node.classList.add("ticked"); }
    animate(known ? 650 : 900, (t) => { node.textContent = t >= 1 ? txt : show(lerp(from, target, t)); });
  }

  window.Charts = {
    xy, bars, heat, fmt, el, showTip, hideTip, niceTicks, frame, animate, tweenNumber,
    forget() { MEM.clear(); NUMS.clear(); },
    instant(on) { INSTANT = !!on; },
  };
})();
