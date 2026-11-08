/* Luck, Location, or Leak? — dashboard logic.
   All machine statistics are recomputed in the browser from additive daily sums,
   so changing the period never averages ratios. */
(async function () {
  const C = window.Charts, F = C.fmt;
  const $ = (s, r = document) => r.querySelector(s);
  const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const store = { get(k, d) { try { const v = localStorage.getItem("gla:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem("gla:" + k, JSON.stringify(v)); } catch { } } };

  let D;
  try { D = await (await fetch("data/data.json")).json(); }
  catch (e) { $("#loading").textContent = "Could not load data/data.json. Run pipeline/build.py first, then serve the web/ folder over HTTP."; return; }
  $("#rel").textContent = D.meta.release;

  // ---------------------------------------------------------------- indexes
  const T = D.dates.length, N = D.machines.length, M = D.md;
  const slotById = Object.fromEntries(D.floor.slots.map((s) => [s.id, s]));
  const locZone = D.locs.map((l) => slotById[l].zone);
  const locBank = D.loc_bank.map((b) => D.banks[b].id);
  const ZN = D.zone_names; const zoneIds = D.zones;
  const midx = Object.fromEntries(D.machines.map((m, i) => [m.id, i]));
  const cfg = D.configs;
  const sum = (a, t0, t1) => { let s = 0; for (let t = t0; t <= t1; t++) s += a[t] || 0; return s; };
  const VERD = {
    exposure: { label: "Exposure", long: "Too little time on the floor", color: "var(--v-exposure)", shape: "tri" },
    leak: { label: "Leak", long: "Payout differs from published game", color: "var(--v-leak)", shape: "dia" },
    weak: { label: "Truly weak", long: "Draws less play than identical games nearby", color: "var(--v-weak)", shape: "sq" },
    downtime: { label: "Downtime", long: "Broken often enough to matter", color: "var(--v-downtime)", shape: "sq" },
    location: { label: "Location", long: "Sits in a low-traffic zone", color: "var(--v-location)", shape: "sq" },
    luck: { label: "Unlucky", long: "Earned less than theo by chance", color: "var(--v-luck)", shape: "circ" },
    ok: { label: "Fair", long: "Performs like its peers", color: "var(--v-ok)", shape: "circ" },
  };
  const RULES = { exposureShare: 0.5, hitZ: 5, luckZleak: -4, weakIdx: 0.9, weakHi: 0.95, downShare: 0.015, zoneFactor: 0.8, luckZ: -1.645, minDays: 14 };
  const chip = (v) => `<span class="vchip ${v}" data-term="v_${v}"><i></i>${VERD[v].label}</span>`;

  // ---------------------------------------------------------------- state
  const S = { t0: 0, t1: T - 1, zone: "all", bank: "all", sel: store.get("sel", "M-1158"), group: store.get("group", "All tracked players") };
  const dIdx = (s) => Math.max(0, Math.min(T - 1, D.dates.indexOf(s) >= 0 ? D.dates.indexOf(s) : (s < D.dates[0] ? 0 : T - 1)));

  // ---------------------------------------------------------------- core: machine stats for a period
  function machineStats(t0, t1) {
    const days = t1 - t0 + 1;
    const rows = D.machines.map((m, i) => {
      const loc = M.loc[i]; let on = 0, last = -1; const zc = {};
      for (let t = t0; t <= t1; t++) if (loc[t] >= 0) { on++; last = loc[t]; zc[locZone[loc[t]]] = (zc[locZone[loc[t]]] || 0) + 1; }
      const zone = Object.keys(zc).sort((a, b) => zc[b] - zc[a])[0] || null;
      const r = { i, id: m.id, m, on, days, zone, loc: last >= 0 ? D.locs[last] : null, bank: last >= 0 ? locBank[last] : null };
      for (const k of ["ci", "hw", "theo", "avh", "occh", "spins", "hits", "var", "faults", "contrib", "lost_theo", "lost_ci", "cci", "costs"]) r[k] = sum(M[k][i], t0, t1);
      let sch = 0; for (let t = t0; t <= t1; t++) if (loc[t] >= 0) sch += M.schh[i][t]; r.sch = sch;
      const g = cfg[m.cfg]; r.g = g;
      r.avail = sch ? r.avh / sch : null; r.occ = r.avh ? r.occh / r.avh : null;
      r.hold = r.ci ? r.hw / r.ci : null; r.theoHold = r.ci ? r.theo / r.ci : 1 - g.rtp;
      r.luck = r.hw - r.theo; r.sd = Math.sqrt(r.var); r.lz = r.sd > 0 ? r.luck / r.sd : 0;
      r.hitRate = r.spins ? r.hits / r.spins : null;
      r.hz = r.spins ? (r.hits - r.spins * g.hit_p) / Math.sqrt(r.spins * g.hit_p * (1 - g.hit_p)) : 0;
      r.tpa = r.avh ? r.theo / r.avh : null;
      r.lostShare = r.theo > 0 ? r.lost_theo / (r.theo + r.lost_theo) : 0;
      // ratio-estimator SE of theo per available hour from daily values
      if (r.avh > 0 && on > 1) { let ss = 0; for (let t = t0; t <= t1; t++) if (loc[t] >= 0) { const e = M.theo[i][t] - r.tpa * M.avh[i][t]; ss += e * e; } r.tpaSe = Math.sqrt(ss * on / (on - 1)) / r.avh; }
      return r;
    });
    // peer model: log(theo per available hour) = zone effect + game effect (weighted by available hours)
    const ok = rows.filter((r) => r.on >= Math.min(RULES.minDays, days) && r.tpa > 0);
    const ze = Object.fromEntries(zoneIds.map((z) => [z, 0])), ce = Object.fromEntries(Object.keys(cfg).map((c) => [c, 0]));
    for (let it = 0; it < 40; it++) {
      for (const z of zoneIds) { let a = 0, w = 0; ok.forEach((r) => { if (r.zone === z) { a += r.avh * (Math.log(r.tpa) - ce[r.m.cfg]); w += r.avh; } }); if (w) ze[z] = a / w; }
      for (const c in ce) { let a = 0, w = 0; ok.forEach((r) => { if (r.m.cfg === c) { a += r.avh * (Math.log(r.tpa) - ze[r.zone]); w += r.avh; } }); if (w) ce[c] = a / w; }
    }
    let fl = 0, fw = 0; ok.forEach((r) => { fl += r.avh * ze[r.zone]; fw += r.avh; }); const zbar = fw ? fl / fw : 0;
    let cl = 0; ok.forEach((r) => { cl += r.avh * ce[r.m.cfg]; }); const cbar = fw ? cl / fw : 0;
    const zoneFactor = Object.fromEntries(zoneIds.map((z) => [z, Math.exp(ze[z] - zbar)]));
    const gameFactor = Object.fromEntries(Object.keys(ce).map((c) => [c, Math.exp(ce[c] - cbar)]));
    rows.forEach((r) => {
      if (!r.avh) return;
      let e = 0; const loc = M.loc[r.i];
      for (let t = t0; t <= t1; t++) if (loc[t] >= 0) e += M.avh[r.i][t] * Math.exp(ze[locZone[loc[t]]] + ce[r.m.cfg]);
      r.hat = e / r.avh; r.idx = r.tpa / r.hat;
      r.idxLo = r.tpaSe != null ? (r.tpa - 1.96 * r.tpaSe) / r.hat : null; r.idxHi = r.tpaSe != null ? (r.tpa + 1.96 * r.tpaSe) / r.hat : null;
      r.zf = r.zone ? zoneFactor[r.zone] : null;
      r.tests = [
        { k: "exposure", name: "Exposure", flag: r.on < RULES.exposureShare * days, text: `On the floor ${r.on} of ${days} days${r.m.install > D.dates[0] ? ` (installed ${r.m.install})` : ""}${r.m.retire ? ` (retired ${r.m.retire})` : ""}.` },
        { k: "leak", name: "Payout", flag: Math.abs(r.hz) > RULES.hitZ || r.lz < RULES.luckZleak, text: `Hit rate ${F.pct(r.hitRate, 2)} vs published ${F.pct(r.g.hit_p, 2)} (z = ${F.signed(r.hz, 1)}).` },
        { k: "weak", name: "Peer", flag: r.idx < RULES.weakIdx && r.idxHi != null && r.idxHi < RULES.weakHi, text: `Theo per available hour is ${F.pct(r.idx, 0)} of identical games in the same zone (95% CI ${F.pct(r.idxLo, 0)}–${F.pct(r.idxHi, 0)}).` },
        { k: "downtime", name: "Downtime", flag: r.lostShare > RULES.downShare, text: `Available ${F.pct(r.avail, 1)} of scheduled hours; downtime cost ${F.usd(r.lost_theo)} of theo (${F.pct(r.lostShare, 1)}).` },
        { k: "location", name: "Location", flag: r.zf != null && r.zf < RULES.zoneFactor, text: `${ZN[r.zone] || "–"} earns ${F.pct(r.zf, 0)} of the floor average per available hour for the same game mix.` },
        { k: "luck", name: "Luck", flag: r.lz < RULES.luckZ, text: `Won ${F.usd(r.hw)} vs theo ${F.usd(r.theo)}: luck ${F.usd(r.luck)}, z = ${F.signed(r.lz, 2)} (σ ${F.usd(r.sd)}).` },
      ];
      const first = r.tests.find((x) => x.flag);
      r.verdict = r.on === 0 ? "exposure" : first ? first.k : "ok";
      r.flags = r.tests.filter((x) => x.flag).map((x) => x.k);
    });
    rows.forEach((r) => { if (!r.avh) { r.verdict = "exposure"; r.flags = ["exposure"]; r.tests = []; } });
    return { rows, zoneFactor, gameFactor, ze, ce, days };
  }

  // ---------------------------------------------------------------- shell: presets, filters, tabs
  const PRESETS = [["H1 2025", 0, T - 1, "The full window: January 1 to June 30, 2025."], ["Q1", 0, dIdx("2025-03-31"), "January to March."], ["Q2", dIdx("2025-04-01"), T - 1, "April to June."], ["Walkway closed", dIdx("2025-03-03"), dIdx("2025-04-06"), "March 3 to April 6, while the Main Entrance to Back Forty walkway was closed for renovation."], ["After comp change", dIdx("2025-05-01"), T - 1, "May 1 onward, after the points price of comps was cut."]];
  const d0 = $("#d0"), d1 = $("#d1");
  d0.min = d1.min = D.dates[0]; d0.max = d1.max = D.dates[T - 1];
  $("#presets").append(...PRESETS.map(([n, a, b, tip]) => { const bt = h(`<button class="chip" type="button" aria-pressed="false" data-tip="${tip}">${n}</button>`); bt.onclick = () => setPeriod(a, b); return bt; }));
  const zs = $("#zoneSel"); zs.append(new Option("All zones", "all"), ...zoneIds.map((z) => new Option(ZN[z], z)));
  const bs = $("#bankSel");
  function fillBanks() { bs.innerHTML = ""; bs.append(new Option("All banks", "all"), ...D.banks.filter((b) => S.zone === "all" || b.zone === S.zone).map((b) => new Option(b.id + (S.zone === "all" ? " · " + ZN[b.zone] : ""), b.id))); bs.value = S.bank; }
  zs.onchange = () => { S.zone = zs.value; S.bank = "all"; fillBanks(); render(); };
  bs.onchange = () => { S.bank = bs.value; if (S.bank !== "all") { S.zone = D.banks.find((b) => b.id === S.bank).zone; zs.value = S.zone; } render(); };
  d0.onchange = () => setPeriod(dIdx(d0.value), Math.max(dIdx(d0.value), S.t1));
  d1.onchange = () => setPeriod(Math.min(S.t0, dIdx(d1.value)), dIdx(d1.value));
  function setPeriod(a, b) { S.t0 = a; S.t1 = b; render(); }
  const TABTIP = { verdict: "Which of the 10 lowest earners are truly underperforming once exposure, downtime, luck and location are accounted for?", demand: "How demand changed over the six months, and why: weekdays, events, the walkway closure, the city.", downtime: "How much play was lost to broken machines, which makers, and at what hour.", players: "What loyalty-card players wagered, got back and netted, and how concentrated it is.", comps: "What the comp program cost, and the May 1 change to the points price.", model: "The forecast model, how it was validated on a time holdout, and the decision it changes.", plan: "How we would spend the $100,000: priced bets with odds, assumptions and measurement.", evidence: "Every claim with its source table, the alternative we tested, and its limits. Plus a glossary." };
  const VIEWS = [
    ["verdict", "Q1", "The bottom 10", "var(--red)"], ["demand", "Q2", "Demand", "var(--chip-blue)"], ["downtime", "Q3", "Downtime", "var(--rust)"], ["players", "Q4", "Players", "var(--chip-purple)"],
    ["comps", "Q5", "Comps", "var(--chip-teal)"], ["model", "Model", "Forecast", "var(--chip-green)"], ["plan", "Q6", "$100k bet", "var(--amber)"], ["evidence", "App.", "Evidence", "#141414"],
  ];
  $("#tabs").append(...VIEWS.map(([id, b, n, c]) => h(`<a href="#${id}" role="tab" data-v="${id}" style="--c:${c}" data-tip="${TABTIP[id]}"><span class="tchip" aria-hidden="true"></span><b>${b}</b>${n}</a>`)));
  const view = () => { const v = location.hash.slice(1); return VIEWS.some((x) => x[0] === v) ? v : "verdict"; };
  window.addEventListener("hashchange", () => { render(); window.scrollTo({ top: 0 }); });
  let rT; window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(render, 150); });

  // full-period evidence used by the plan and the appendix (stable regardless of the period picker)
  const FULL = machineStats(0, T - 1);

  // ---------------------------------------------------------------- render dispatcher
  let cur;
  function render() {
    d0.value = D.dates[S.t0]; d1.value = D.dates[S.t1];
    [...$("#presets").children].forEach((b, k) => b.setAttribute("aria-pressed", String(PRESETS[k][1] === S.t0 && PRESETS[k][2] === S.t1)));
    zs.value = S.zone; fillBanks();
    const v = view();
    [...$("#tabs").children].forEach((a) => a.setAttribute("aria-current", a.dataset.v === v ? "page" : "false"));
    cur = machineStats(S.t0, S.t1);
    $("#stage").classList.toggle("slim", v !== "verdict");
    renderFan();
    const main = $("#main"); main.innerHTML = "";
    ({ verdict: vVerdict, demand: vDemand, downtime: vDowntime, players: vPlayers, comps: vComps, model: vModel, plan: vPlan, evidence: vEvidence })[v](main);
    main.querySelectorAll(".panel").forEach((p, k) => p.style.setProperty("--i", Math.min(k, 8)));
    main.querySelectorAll(".voucher .v").forEach(countUp);
  }
  // animate the first number inside a string ("$1.06M", "9 / 10", "16.1%") from 0 to its value
  function countUp(el) {
    const txt = el.textContent, m = txt.match(/-?[\d,]*\.?\d+/); if (!m || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = parseFloat(m[0].replace(/,/g, "")), dec = (m[0].split(".")[1] || "").length, comma = m[0].includes(","), t0 = performance.now(), dur = 900;
    const step = (now) => { const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3); let v = (target * e).toFixed(dec); if (comma) v = (+v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); el.textContent = txt.replace(m[0], v); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  const periodLabel = () => `${D.dates[S.t0]} → ${D.dates[S.t1]} (${S.t1 - S.t0 + 1} days)`;
  const inScope = (r) => (S.zone === "all" || r.zone === S.zone) && (S.bank === "all" || r.bank === S.bank);
  const panel = (id, title, sub, src) => h(`<section class="panel" id="${id}"><header><h3>${title}</h3>${sub ? `<span class="sub">${sub}</span>` : ""}</header><div class="body"></div>${src ? `<div class="src">${src}</div>` : ""}</section>`);
  const head = (eye, title, answer) => h(`<div class="head"><div class="eyebrow">${eye}</div><h2>${title}</h2><p class="answer">${autoTerm(answer)}</p></div>`);
  const kpis = (arr) => h(`<div class="grid g4">${arr.map((k, i) => `<div class="voucher" style="--i:${i}"${kpiTerm(k[0]) ? ` data-term="${kpiTerm(k[0])}" tabindex="0"` : ""}><span class="l">${k[0]}${kpiTerm(k[0]) ? ' <span class="info" aria-hidden="true">i</span>' : ""}</span><span class="v">${k[1]}</span><span class="d">${k[2] || ""}</span></div>`).join("")}</div>`);

  // ================================================================ Q1 VERDICT
  function vVerdict(main) {
    const { rows, zoneFactor } = cur;
    const active = rows.filter((r) => r.on > 0);
    const mgr = [...active].sort((a, b) => a.hw - b.hw).slice(0, 10);
    const counts = {}; mgr.forEach((r) => counts[r.verdict] = (counts[r.verdict] || 0) + 1);
    const weakAll = active.filter((r) => r.flags.includes("weak"));
    const leakAll = active.filter((r) => r.flags.includes("leak"));
    const order = ["exposure", "leak", "weak", "downtime", "location", "luck", "ok"];
    const sentence = order.filter((k) => counts[k]).map((k) => `${counts[k]} ${VERD[k].label.toLowerCase()}`).join(", ");
    main.append(head(`Q1 · ${periodLabel()}`, "Replace the machine only if the machine is the problem",
      `Ranked by raw house win, the bottom 10 break down as: ${sentence}. Once exposure, availability, luck and location are removed, only <b>${weakAll.length}</b> machine${weakAll.length === 1 ? " is" : "s are"} truly weak across the whole floor, and <b>${leakAll.length}</b> pays out differently from its published game.`));
    const shortfall = mgr.reduce((a, r) => a + r.luck, 0);
    const b40 = zoneFactor["Z-B40"];
    main.append(kpis([
      ["Manager's list in Back Forty", `${mgr.filter((r) => r.zone === "Z-B40").length} / 10`, `Back Forty earns ${F.pct(b40, 0)} of floor per available hour`],
      ["Not on floor all period", `${mgr.filter((r) => r.flags.includes("exposure") || r.on < r.days).length} / 10`, "installed or retired mid-period"],
      ["Luck in the bottom 10", F.usd(shortfall), "house win minus theo, summed"],
      ["Payout leaks floor-wide", String(leakAll.length), leakAll.map((r) => r.id).join(", ") || "none"],
    ]));

    // manager's list table
    const p1 = panel("p-mgr", "The manager's list, re-examined", "Bottom 10 by house win in this period, with every test. Select a row to load it into the inspector.", "Source: machine_day (meters, spins, Σbet²) ⨝ game_math (RTP, hit probability, variance) ⨝ placements. Luck z = (house win − theo) / √(Σbet² × payout variance).");
    const tb = h(`<div class="tw"><table><caption class="sr">The manager's 10 lowest-earning machines and the result of each test</caption><thead><tr><th scope="col">Machine</th><th scope="col">${term("zone", "Zone")} · game</th><th scope="col" class="n">${term("exposure", "Days")}</th><th scope="col" class="n">${term("housewin", "House win")}</th><th scope="col" class="n">${term("theo", "Theo")}</th><th scope="col" class="n">${term("luckz", "Luck z")}</th><th scope="col" class="n">${term("hitz", "Hit z")}</th><th scope="col" class="n">${term("peer", "Peer index")}</th><th scope="col">Verdict</th><th scope="col">Why</th></tr></thead><tbody></tbody></table></div>`);
    mgr.forEach((r, k) => {
      const why = (r.tests.find((t) => t.k === r.verdict) || {}).text || "Within normal range on every test.";
      const tr = h(`<tr class="click${r.id === S.sel ? " sel" : ""}" tabindex="0" aria-label="Inspect ${r.id}"><td class="mono"><b>${k + 1}.</b> ${r.id}</td><td>${esc(ZN[r.zone] || "–")}<br><span class="muted">${esc(r.m.theme)} · RTP ${F.pct(r.g.rtp, 0)}</span></td><td class="n">${r.on}/${r.days}</td><td class="n">${F.usd(r.hw)}</td><td class="n">${F.usd(r.theo)}</td><td class="n">${F.signed(r.lz, 2)}</td><td class="n">${F.signed(r.hz, 1)}</td><td class="n">${r.idx ? F.pct(r.idx, 0) : "–"}</td><td>${chip(r.verdict)}${r.flags.filter((f) => f !== r.verdict).map((f) => `<div class="muted" style="font-size:12px">also ${VERD[f].label.toLowerCase()}</div>`).join("")}</td><td class="why">${esc(why)}</td></tr>`);
      tr.onclick = tr.onkeydown = (e) => { if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return; e.preventDefault?.(); tb.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel")); tr.classList.add("sel"); inspect(r.id, true); };
      tb.querySelector("tbody").append(tr);
    });
    p1.querySelector(".body").append(tb, h(`<div class="legend">${order.map((k) => `<span>${chip(k)} <span class="muted">${VERD[k].long}</span></span>`).join("")}</div>`));
    main.append(p1);

    const row2 = h(`<div class="grid g64"></div>`); main.append(row2);
    // floor map
    const pm = panel("p-map", "Floor map", "Machines colored by verdict. Dashed orange walkway was closed for renovation Mar 3 – Apr 6.", "Source: floor_locations (x_m, y_m), floor_walkways, placements at the last day on floor in the period.");
    pm.classList.add("felt"); row2.append(pm); floorMap(pm.querySelector(".body"), rows);
    // fair ranking
    const fair = active.filter((r) => r.idx && r.on >= Math.min(RULES.minDays, cur.days) && inScope(r)).sort((a, b) => a.idx - b.idx).slice(0, 10);
    const pf = panel("p-fair", "The fair bottom 10", "Theo per available hour ÷ what identical games earn in the same zone. 100% = typical. Whiskers: 95% CI.", "Model: log(theo/available hour) = zone + game, fit on all machines in the period, weighted by available hours. Theo removes luck; per-hour removes downtime and exposure.");
    row2.append(pf);
    C.bars(pf.querySelector(".body"), { horizontal: true, labelW: 150, ref: 1, min: 0.6, max: 1.25, fmt: (v) => F.pct(v, 0),
      items: fair.map((r) => ({ label: `${r.id} · ${ZN[r.zone]?.split(" ")[0]}`, value: r.idx, lo: r.idxLo, hi: r.idxHi, color: VERD[r.flags.includes("weak") ? "weak" : r.verdict].color,
        tip: `<div class="th">${r.id} · ${esc(r.m.theme)}</div>${F.pct(r.idx, 0)} of peers (CI ${F.pct(r.idxLo, 0)}–${F.pct(r.idxHi, 0)})<br>${esc(ZN[r.zone])}, bank ${r.bank}<br>Manager's rank: ${mgr.includes(r) ? "in bottom 10" : "not in bottom 10"}` })),
      onClick: (d, i) => { S.sel = fair[i].id; render(); } });
    pf.querySelector(".body").append(h(`<p class="muted" style="font-size:13px">${fair.filter((r) => mgr.includes(r)).length} of these 10 appear on the manager's list. Peer indexes cluster tightly (most machines sit within ±10% of their peers), so a replacement buys little unless the game itself is the problem.</p>`));

    const row3 = h(`<div class="grid g2"></div>`); main.append(row3);
    // luck histogram
    const pl = panel("p-luck", "Is it just luck?", "Distribution of luck z-scores across all machines vs. what pure chance predicts.", "If every machine paid exactly to its configured RTP, z ~ Normal(0,1). Expected counts = N × bin probability.");
    row3.append(pl);
    const zsA = active.filter((r) => r.sd > 0).map((r) => r.lz);
    const bins = []; for (let b = -5; b < 5; b += 0.5) bins.push(b);
    const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
    const cnt = bins.map((b) => zsA.filter((z) => z >= b && z < b + 0.5).length);
    const exp = bins.map((b) => zsA.length * (Phi(b + 0.5) - Phi(b)));
    const dicebar = h(`<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><button class="btn small" type="button">Roll a chance-only floor</button><span class="dice">${DIE(3)}${DIE(4)}</span><span class="muted" style="font-size:13px" id="rollNote">Each roll draws ${zsA.length} machines that pay exactly to their RTP.</span></div>`);
    const lc = h(`<div></div>`); pl.querySelector(".body").append(dicebar, lc);
    const drawLuck = (sim) => C.xy(lc, { height: 230, x: bins.map((b) => b + 0.25), yfmt: (v) => F.num(v), yZero: true, ymin: 0,
      series: [{ name: "Machines observed", values: cnt, color: "var(--s1)", width: 2.5, area: true }, { name: "Expected by chance", values: exp, color: "var(--ink)", dash: "4 3", width: 1.5 }, ...(sim ? [{ name: "Your random floor", values: sim, color: "var(--s2)", width: 2 }] : [])],
      xticks: [-4, -2, 0, 2, 4].map((v) => ({ v, label: (v > 0 ? "+" : "") + v + "σ" })), tipTitle: (i) => `z in [${bins[i]}, ${bins[i] + 0.5})`, aria: "luck z histogram" });
    drawLuck(null);
    $("button", dicebar).onclick = () => {
      const dice = $(".dice", dicebar); dice.classList.remove("rolling"); void dice.offsetWidth; dice.classList.add("rolling");
      setTimeout(() => {
        dice.innerHTML = DIE(1 + ((Math.random() * 6) | 0)) + DIE(1 + ((Math.random() * 6) | 0));
        const z = zsA.map(gauss); const sim = bins.map((b) => z.filter((x) => x >= b && x < b + 0.5).length);
        drawLuck(sim); $("#rollNote").textContent = `This random floor has ${z.filter((x) => Math.abs(x) > 2).length} machines beyond ±2σ and its worst is z = ${Math.min(...z).toFixed(2)}. The real floor has ${zsA.filter((x) => Math.abs(x) > 2).length}, worst ${Math.min(...zsA).toFixed(2)}.`;
      }, RM() ? 0 : 600);
    };
    const beyond = zsA.filter((z) => Math.abs(z) > 2).length, expB = zsA.length * 2 * (1 - Phi(2));
    const ext = active.filter((r) => r.sd > 0).sort((a, b) => a.lz - b.lz)[0];
    pl.querySelector(".body").append(h(`<div class="legend"><span><i style="background:var(--s1)"></i>Observed</span><span><i style="background:var(--ink)"></i>Expected by chance</span><span><i style="background:var(--s2)"></i>Your random floor (after a roll)</span></div>`));
    pl.querySelector(".body").append(h(`<p style="font-size:13.5px">${beyond} machines sit beyond ±2σ; chance alone predicts ${expB.toFixed(0)}. The most extreme is <b class="mono">${ext.id}</b> at z = ${ext.lz.toFixed(2)}${Math.abs(ext.lz) > 3.5 ? `, a result chance produces less than once in ${F.num(1 / (2 * (1 - Phi(Math.abs(ext.lz)))) / zsA.length, 0)} floors of this size` : ""}. Most low earners are inside the chance envelope.</p>`));

    // hit-rate fingerprint
    const ph = panel("p-hit", "Payout fingerprint", "Hit rate is far less noisy than hold. Each dot is a machine: observed hit rate minus its game's published hit probability, in standard errors.", "Source: machine_day.payout_positive_spins / paid_spins vs game_math.hit_probability. Binomial z. |z| > 5 flagged (Bonferroni-safe for 310 machines).");
    row3.append(ph);
    const hz = active.filter((r) => r.spins > 0).sort((a, b) => Math.abs(b.hz) - Math.abs(a.hz));
    C.bars(ph.querySelector(".body"), { horizontal: true, labelW: 150, ref: 0, fmt: (v) => F.signed(v, 0), vfmt: (v) => "z " + F.signed(v, 1),
      items: hz.slice(0, 6).map((r) => ({ label: `${r.id} · ${r.m.theme}`, value: r.hz, color: Math.abs(r.hz) > RULES.hitZ ? "var(--v-leak)" : "var(--neutral)", tip: `<div class="th">${r.id}</div>Hit rate ${F.pct(r.hitRate, 2)} vs published ${F.pct(r.g.hit_p, 2)}<br>${F.num(r.spins)} spins` })) });
    const lk = hz[0];
    if (lk && Math.abs(lk.hz) > RULES.hitZ) ph.querySelector(".body").append(h(`<p class="callout"><b>${lk.id}</b> hits on ${F.pct(lk.hitRate, 1)} of spins; its published ${esc(lk.m.theme)} paytable hits on ${F.pct(lk.g.hit_p, 1)}. Over ${F.num(lk.spins)} spins that gap is ${F.num(lk.hz, 0)} standard errors, visible from the first day (≈${F.num(lk.hz / Math.sqrt(lk.on), 0)}σ per day). Its hold is ${F.pct(lk.hold, 1)} against a configured ${F.pct(lk.theoHold, 1)}. This is a lead for a paytable inspection, not evidence of wrongdoing. Every other machine is within ±${F.num(Math.abs(hz[1].hz), 1)}σ.</p>`));

    // case file
    caseFile(main, false);
  }
  function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

  function floorMap(host, rows) {
    host.innerHTML = "";
    const W = Math.max(300, host.clientWidth), xs = D.floor.slots.map((s) => s.x), ys = D.floor.slots.map((s) => s.y);
    const x0 = Math.min(...xs, 0) - 6, x1 = Math.max(...xs, 130) + 6, y0 = Math.min(...ys, 0) - 8, y1 = Math.max(...ys, 110) + 8;
    const sc = W / (x1 - x0), H = Math.round((y1 - y0) * sc);
    const X = (x) => (x - x0) * sc, Y = (y) => (y - y0) * sc;
    const svg = C.el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, role: "img", "aria-label": "Casino floor map" });
    const wrap = h(`<div class="floor"></div>`); wrap.append(svg); host.append(wrap);
    const zpos = Object.fromEntries(D.floor.zones.map((z) => [z.id, z]));
    const mid = Math.floor((S.t0 + S.t1) / 2);
    D.floor.walkways.forEach((w) => {
      const a = zpos[w.a], b = zpos[w.b];
      const closed = w.closed_from && !(D.dates[S.t1] < w.closed_from || D.dates[S.t0] >= w.closed_to);
      C.el("line", { x1: X(a.x), y1: Y(a.y), x2: X(b.x), y2: Y(b.y), class: "walk" + (closed ? " closed" : "") }, svg);
    });
    D.floor.entrances.forEach((e) => { C.el("rect", { x: X(e.x) - 5, y: Y(e.y) - 5, width: 10, height: 10, class: "door", rx: 2 }, svg); const right = X(e.x) > W * 0.7; const t = C.el("text", { x: X(e.x) + (right ? -8 : 8), y: Y(e.y) + (Y(e.y) < 14 ? 14 : 4), "text-anchor": right ? "end" : "start", class: "halo" }, svg); t.textContent = e.name; });
    const labelLater = () => D.floor.zones.forEach((z) => {
      const sl = D.floor.slots.filter((s) => s.zone === z.id); const ty = Math.min(...sl.map((s) => Y(s.y))) - 9; const tx = avg(sl.map((s) => X(s.x)));
      const t = C.el("text", { x: tx, y: Math.max(12, ty), class: "zone-label halo", "text-anchor": "middle" }, svg); t.textContent = z.name;
    });
    D.floor.outlets.forEach((o) => { C.el("circle", { cx: X(o.x), cy: Y(o.y), r: 7, class: "outlet" }, svg); });
    const byLoc = {}; rows.forEach((r) => { if (r.loc) byLoc[r.loc] = r; });
    const R = Math.max(3.2, Math.min(6, sc * 1.4));
    D.floor.slots.forEach((s) => {
      const r = byLoc[s.id]; const cx = X(s.x), cy = Y(s.y);
      if (!r) { C.el("circle", { cx, cy, r: R * 0.5, style: "fill:var(--line)" }, svg); return; }
      const v = VERD[r.verdict]; const dim = !inScope(r);
      let node;
      if (v.shape === "dia") node = C.el("path", { d: `M${cx},${cy - R * 1.3}L${cx + R * 1.3},${cy}L${cx},${cy + R * 1.3}L${cx - R * 1.3},${cy}Z` }, svg);
      else if (v.shape === "tri") node = C.el("path", { d: `M${cx},${cy - R * 1.2}L${cx + R * 1.1},${cy + R * 0.9}L${cx - R * 1.1},${cy + R * 0.9}Z` }, svg);
      else if (v.shape === "sq") node = C.el("rect", { x: cx - R * 0.95, y: cy - R * 0.95, width: R * 1.9, height: R * 1.9, rx: 1.5 }, svg);
      else node = C.el("circle", { cx, cy, r: R }, svg);
      node.setAttribute("class", "m" + (dim ? " dim" : "") + (r.id === S.sel ? " sel" : ""));
      node.style.fill = v.color;
      node.addEventListener("pointermove", (ev) => C.showTip(`<div class="th">${r.id} · ${esc(r.m.theme)}</div>${chip(r.verdict)}<br>${esc(ZN[r.zone])} · bank ${r.bank}<br>House win ${F.usd(r.hw)} · theo ${F.usd(r.theo)}<br>Peer index ${r.idx ? F.pct(r.idx, 0) : "–"} · luck z ${F.signed(r.lz, 2)}`, ev));
      node.addEventListener("pointerleave", C.hideTip);
      node.addEventListener("click", () => { S.sel = r.id; store.set("sel", r.id); render(); setTimeout(() => $("#p-case")?.scrollIntoView({ behavior: "smooth" }), 30); });
    });
    labelLater();
    host.append(h(`<div class="legend">${["leak", "weak", "location", "luck", "exposure", "ok"].map((k) => chip(k)).join(" ")}<span><span style="display:inline-block;width:10px;height:10px;background:var(--brass);border-radius:2px"></span> door</span></div>`));
  }

  function caseFile(main, replace) {
    const r = cur.rows[midx[S.sel]] || cur.rows[0];
    const spin = !!S.spin; S.spin = false;
    const p = h(`<section class="panel case" id="p-case"><header><div><div class="eyebrow">Case file</div><h3 style="font-size:20px">${r.id} · ${esc(r.m.theme)} <span class="muted" style="font-weight:500;font-size:14px">${esc(r.m.mfr)} · ${esc(r.m.lease.replace(/_/g, " "))} · ${esc(ZN[r.zone] || "off floor")} ${r.bank ? "· bank " + r.bank : ""}</span></h3></div><div>${chip(r.verdict)}</div></header>
      <label class="ctl" for="caseSel">Open another machine <select id="caseSel">${D.machines.map((m) => `<option ${m.id === r.id ? "selected" : ""}>${m.id}</option>`).join("")}</select></label>
      <dl><div><dt>${term("exposure", "Days on floor")}</dt><dd>${r.on}/${r.days}</dd></div><div><dt>${term("coinin", "Coin-in")}</dt><dd>${F.usd(r.ci)}</dd></div><div><dt>${term("housewin", "House win")}</dt><dd>${F.usd(r.hw)}</dd></div><div><dt>${term("theo", "Theo")}</dt><dd>${F.usd(r.theo)}</dd></div><div><dt>${term("hold", "Hold / config")}</dt><dd>${F.pct(r.hold, 1)} / ${F.pct(r.theoHold, 1)}</dd></div><div><dt>${term("availability", "Availability")}</dt><dd>${F.pct(r.avail, 2)}</dd></div><div><dt>${term("occupancy", "Occupancy")}</dt><dd>${F.pct(r.occ, 1)}</dd></div><div><dt>${term("contribution", "Contribution")}</dt><dd>${F.usd(r.contrib)}</dd></div></dl>
      <div class="inspect"><div class="insp-host"></div><div class="steps"><p class="muted" style="font-size:13.5px">Each test, in the order we apply them. The first one that flags decides the verdict.</p></div></div><div class="grid g2"><div id="c-funnel"></div><div id="c-hit"></div></div>
      <div class="src">Contribution = house win − lease − service − power − repair (supplied costs only). Funnel: cumulative house win − theo; band = ±1.96 × √(cumulative Σbet² × variance).</div></section>`);
    if (replace && $("#p-case")) $("#p-case").replaceWith(p); else main.append(p);
    $("#caseSel", p).onchange = (e) => inspect(e.target.value, false);
    mountInspector($(".insp-host", p), r, spin);
    const st = $(".steps", p);
    const TK = { exposure: "exposure", leak: "hitz", weak: "peer", downtime: "downtime", location: "location", luck: "luckz" };
    (r.tests || []).forEach((t) => st.append(h(`<div class="step"><span class="t term" tabindex="0" data-term="${TK[t.k]}">${t.name}</span><span>${esc(t.text)}</span><span class="r ${t.flag ? "flag" : "pass"}">${t.flag ? "FLAG" : "pass"}</span></div>`)));
    // luck funnel
    const xsI = [], cum = [], lo = [], hi = []; let c = 0, v = 0;
    for (let t = S.t0; t <= S.t1; t++) { if (M.loc[r.i][t] < 0) { xsI.push(t); cum.push(null); lo.push(null); hi.push(null); continue; } c += M.hw[r.i][t] - M.theo[r.i][t]; v += M.var[r.i][t]; xsI.push(t); cum.push(c); lo.push(-1.96 * Math.sqrt(v)); hi.push(1.96 * Math.sqrt(v)); }
    const fd = $("#c-funnel", p); fd.append(h(`<h3 style="font-size:14px">Luck funnel</h3>`)); const fdb = h("<div></div>"); fd.append(fdb);
    C.xy(fdb, { height: 210, x: xsI, band: { lo, hi }, series: [{ name: "Cumulative luck (win − theo)", values: cum, color: "var(--accent)", width: 2 }], hlines: [{ y: 0, cls: "zero" }],
      xticks: monthTicks(S.t0, S.t1), tipTitle: (i) => D.dates[xsI[i]], tipExtra: (i) => lo[i] == null ? "" : `<div class="muted">95% chance band ±${F.usd(hi[i])}</div>`, aria: "cumulative luck funnel" });
    fd.append(h(`<p class="muted" style="font-size:12.5px">Inside the blue funnel = consistent with chance. ${Math.abs(r.lz) > 1.96 ? "This machine finishes outside it." : "This machine stays inside it."}</p>`));
    // weekly hit rate
    const hd = $("#c-hit", p); hd.append(h(`<h3 style="font-size:14px">Weekly hit rate vs published</h3>`)); const hdb = h("<div></div>"); hd.append(hdb);
    const wk = [], hr = [];
    for (let t = S.t0; t <= S.t1; t += 7) { let a = 0, b = 0; for (let u = t; u < Math.min(t + 7, S.t1 + 1); u++) { a += M.hits[r.i][u]; b += M.spins[r.i][u]; } wk.push(t); hr.push(b ? a / b : null); }
    C.xy(hdb, { height: 210, x: wk, series: [{ name: "Observed", values: hr, color: "var(--accent)", width: 2 }, { name: "Published", values: wk.map(() => r.g.hit_p), color: "var(--ink)", dash: "4 3", width: 1.5 }],
      yfmt: (v) => F.pct(v, 0), xticks: monthTicks(S.t0, S.t1), tipTitle: (i) => "Week of " + D.dates[wk[i]], aria: "weekly hit rate" });
    hd.append(h(`<div class="legend"><span><i style="background:var(--accent)"></i>Observed</span><span><i style="background:var(--ink)"></i>Published ${F.pct(r.g.hit_p, 1)}</span></div>`));
  }
  function monthTicks(t0, t1) { const out = []; for (let t = t0; t <= t1; t++) if (D.dates[t].endsWith("-01") || t === t0) out.push({ v: t, label: new Date(D.dates[t] + "T12:00").toLocaleString("en-US", { month: "short", day: t === t0 && !D.dates[t].endsWith("-01") ? "numeric" : undefined }) }); return out.length > 7 ? out.filter((_, k) => k % 2 === 0) : out; }

  // ================================================================ Q2 DEMAND
  function vDemand(main) {
    const P = D.pday, t0 = S.t0, t1 = S.t1, idx = []; for (let t = t0; t <= t1; t++) idx.push(t);
    const ci = idx.map((t) => P.coin_in_usd[t]);
    const ma = idx.map((t, k) => { if (t - 6 < 0) return null; let s = 0; for (let u = t - 6; u <= t; u++) s += P.coin_in_usd[u]; return s / 7; });
    const tot = ci.reduce((a, b) => a + b, 0);
    const wdAvg = {}; idx.forEach((t) => { const w = D.weekday[t]; (wdAvg[w] = wdAvg[w] || []).push(P.coin_in_usd[t]); });
    const wdOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const did = D.closure_did;
    const sat = wdAvg.Sat ? avg(wdAvg.Sat) : null, tue = wdAvg.Tue ? avg(wdAvg.Tue) : null;
    main.append(head(`Q2 · ${periodLabel()}`, "Demand follows the weekend, the city calendar, and access to the back of the floor",
      `Floor coin-in averaged ${F.usd(tot / idx.length)} a day. Saturdays run ${F.pct(sat / tue - 1, 0)} above Tuesdays. Citywide events and the property's own tournament lift play; June softened in line with fewer Las Vegas visitors. The one structural shock was local: closing the Main Entrance → Back Forty walkway cut Back Forty play per available hour by ${F.pct(-did.did_effect, 0)} relative to the rest of the floor.`));
    const pz = panel("p-daily", "Daily floor coin-in", "All play, every machine. Shaded: events (orange = walkway closure).", "Source: property_day.coin_in_usd; events (announced_date shown in tooltip); 7-day trailing mean.");
    main.append(pz);
    const shade = D.events.map((e) => ({ from: dIdx(e.start), to: dIdx(e.end) + 0.9, label: e.scope === "property" ? "Promo" : "" })).filter((s) => s.to >= t0 && s.from <= t1);
    shade.push({ from: dIdx("2025-03-03"), to: dIdx("2025-04-06"), cls: "closed", label: "Walkway closed" });
    C.xy(pz.querySelector(".body"), { height: 260, x: idx, xmin: t0, xmax: t1, shade, series: [{ name: "Coin-in", values: ci, color: "var(--neutral)", width: 1.2 }, { name: "7-day mean", values: ma, color: "var(--s1)", width: 2.2 }],
      xticks: monthTicks(t0, t1), tipTitle: (i) => `${D.dates[idx[i]]} · ${D.weekday[idx[i]]}`, tipExtra: (i) => { const e = P.events[idx[i]]; return e ? `<div class="muted">${esc(e)}</div>` : ""; }, aria: "daily coin-in" });
    pz.querySelector(".body").append(h(`<div class="legend"><span><i style="background:var(--neutral)"></i>Daily</span><span><i style="background:var(--s1)"></i>7-day mean</span></div>`));

    const g = h(`<div class="grid g2"></div>`); main.append(g);
    // zone index by week
    const pzn = panel("p-zone", "Coin-in per available machine-hour, by zone", "Weekly. Back Forty is the only zone that broke pattern during the closure.", "Source: prepared_daily_view (coin_in_usd / available_hours), ratio of weekly sums.");
    g.append(pzn);
    const weeks = []; for (let t = t0; t <= t1; t += 7) weeks.push(t);
    const zSeries = zoneIds.map((z, k) => ({ name: ZN[z], color: z === "Z-B40" ? "var(--v-location)" : z === S.zone ? "var(--s1)" : "var(--neutral)", width: z === "Z-B40" || z === S.zone ? 2.4 : 1.2,
      values: weeks.map((w) => { let a = 0, b = 0; for (let i = 0; i < N; i++) for (let t = w; t < Math.min(w + 7, t1 + 1); t++) { const l = M.loc[i][t]; if (l >= 0 && locZone[l] === z) { a += M.ci[i][t]; b += M.avh[i][t]; } } return b ? a / b : null; }) }));
    zSeries.sort((a, b) => (a.width > b.width) - (b.width > a.width));
    C.xy(pzn.querySelector(".body"), { height: 250, x: weeks, xmin: t0, xmax: t1, series: zSeries, shade: [{ from: dIdx("2025-03-03"), to: dIdx("2025-04-06"), cls: "closed" }], yfmt: (v) => "$" + v.toFixed(0), xticks: monthTicks(t0, t1), tipTitle: (i) => "Week of " + D.dates[weeks[i]], aria: "zone coin-in per hour" });
    pzn.querySelector(".body").append(h(`<div class="legend"><span><i style="background:var(--v-location)"></i>Back Forty</span>${S.zone !== "all" && S.zone !== "Z-B40" ? `<span><i style="background:var(--s1)"></i>${ZN[S.zone]}</span>` : ""}<span><i style="background:var(--neutral)"></i>Other zones</span></div>`));

    const pd = panel("p-did", "Walkway closure: difference-in-differences", "Back Forty ÷ rest of floor, coin-in per available hour.", "W-ENT-B40 closed 2025-03-03 → 2025-04-06 (floor_walkways). Counters: S-B40 entries fell from 25 to 18/hour while other doors held.");
    g.append(pd);
    C.bars(pd.querySelector(".body"), { items: did.rows.map((r) => ({ label: r.period, value: r.ratio, color: r.period === "closed" ? "var(--v-location)" : "var(--neutral)", tip: `<div class="th">${r.period}</div>Back Forty $${r.b40_ci_avh}/h vs rest $${r.rest_ci_avh}/h<br>Occupancy ${F.pct(r.b40_occ, 1)} vs ${F.pct(r.rest_occ, 1)}` })), fmt: (v) => F.pct(v, 0), valueLabels: true, height: 200, min: 0, max: 0.8 });
    pd.querySelector(".body").append(h(`<p style="font-size:13.5px">Relative play fell <b>${F.pct(-did.did_effect, 0)}</b> while the walkway was closed and recovered to within ${F.pct(Math.abs(did.recovery), 0)} of its old level afterwards. Two things follow. Back Forty play is sensitive to how easy it is to reach, which is what signage changes. And Back Forty was already at ${F.pct(did.rows[0].ratio, 0)} of the floor before the closure, so its machines start every ranking at a disadvantage.</p>`));

    const g2 = h(`<div class="grid g3"></div>`); main.append(g2);
    const pw = panel("p-wd", "By weekday", "Average daily coin-in in the period.", "property_day grouped by local_weekday.");
    g2.append(pw);
    C.bars(pw.querySelector(".body"), { items: wdOrder.filter((w) => wdAvg[w]).map((w) => ({ label: w, value: avg(wdAvg[w]), color: w === "Fri" || w === "Sat" ? "var(--s1)" : "var(--neutral)" })), height: 210 });
    // LVCVA context (real)
    const pr = panel("p-real", "City context (real data)", "Monthly, indexed to January = 100.", "LVCVA visitor volume (Aug 2026 revision, published after the period: context only, never a model input). Property coin-in from property_day.");
    g2.append(pr);
    const months = D.real.lvcva.map((r) => r.month);
    const propM = months.map((m) => { let s = 0, n = 0; D.dates.forEach((d, t) => { if (d.startsWith(m)) { s += P.coin_in_usd[t]; n++; } }); return s / n; });
    const vis = D.real.lvcva.map((r) => r.visitor_volume / new Date(+r.month.slice(0, 4), +r.month.slice(5), 0).getDate());
    C.xy(pr.querySelector(".body"), { height: 210, x: months.map((_, k) => k), series: [{ name: "Gilded Ace coin-in/day", values: propM.map((v) => v / propM[0] * 100), color: "var(--s1)" }, { name: "LV visitors/day", values: vis.map((v) => v / vis[0] * 100), color: "var(--s2)" }],
      yfmt: (v) => v.toFixed(0), xticks: months.map((m, k) => ({ v: k, label: m.slice(5) })), tipTitle: (i) => months[i], aria: "city context" });
    pr.querySelector(".body").append(h(`<div class="legend"><span><i style="background:var(--s1)"></i>Property</span><span><i style="background:var(--s2)"></i>LV visitors</span></div>`));
    const pk = panel("p-hold", "Hold check vs. a real market", "Observed floor hold vs. Missouri statewide slot hold, by month.", "Missouri Gaming Commission (benchmark_state_monthly). Different market; used only as a sanity range.");
    g2.append(pk);
    const holdM = months.map((m) => { let a = 0, b = 0; D.dates.forEach((d, t) => { if (d.startsWith(m)) { a += P.house_win_usd[t]; b += P.coin_in_usd[t]; } }); return a / b; });
    C.xy(pk.querySelector(".body"), { height: 210, x: months.map((_, k) => k), series: [{ name: "Gilded Ace", values: holdM, color: "var(--s1)" }, { name: "Missouri", values: D.real.missouri.map((r) => r.hold), color: "var(--s2)" }], yfmt: (v) => F.pct(v, 1), xticks: months.map((m, k) => ({ v: k, label: m.slice(5) })), tipTitle: (i) => months[i], aria: "hold benchmark" });
    pk.querySelector(".body").append(h(`<div class="legend"><span><i style="background:var(--s1)"></i>Property</span><span><i style="background:var(--s2)"></i>Missouri</span></div>`));
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  // ================================================================ Q3 DOWNTIME
  function vDowntime(main) {
    const rows = cur.rows.filter((r) => r.on > 0 && inScope(r));
    const t0 = S.t0, t1 = S.t1;
    let dh = 0; rows.forEach((r) => { dh += r.sch - r.avh; });
    const lostCi = rows.reduce((a, r) => a + r.lost_ci, 0), lostTh = rows.reduce((a, r) => a + r.lost_theo, 0), th = rows.reduce((a, r) => a + r.theo, 0);
    const byMfr = {}; rows.forEach((r) => { const k = r.m.mfr; const o = byMfr[k] = byMfr[k] || { lt: 0, f: 0, md: 0, n: 0 }; o.lt += r.lost_theo; o.f += r.faults; o.md += r.on; o.n++; });
    const ridge = byMfr.Ridgeline || { lt: 0 };
    main.append(head(`Q3 · ${periodLabel()}${S.zone !== "all" ? " · " + ZN[S.zone] : ""}`, "Downtime is real, concentrated, and small next to location",
      `Machines were down ${F.num(dh, 0)} machine-hours, which cost about ${F.usd(lostCi)} of coin-in and ${F.usd(lostTh)} of theo (${F.pct(lostTh / (th + lostTh), 2)} of the floor's theo). Ridgeline cabinets account for ${F.pct(ridge.lt / lostTh, 0)} of it. Losses peak 8 p.m.–midnight, when play is heaviest and the grave shift starts with one technician.`));
    main.append(kpis([["Downtime", F.num(dh, 0) + " h", "machine-hours, scheduled − available"], ["Lost coin-in", F.usd(lostCi), "downtime × machine's own coin-in per hour at that hour"], ["Lost theo", F.usd(lostTh), F.pct(lostTh / (th + lostTh), 2) + " of theo"], ["Fault tickets", F.num(rows.reduce((a, r) => a + r.faults, 0)), "fault_repair opened"]]));
    const g = h(`<div class="grid g2"></div>`); main.append(g);
    const pw = panel("p-dt-week", "Lost theo per week, by manufacturer", "", "Source: machine_hour (available_seconds) × each machine's coin-in per available hour at that local hour × (1 − RTP).");
    g.append(pw);
    const weeks = []; for (let t = t0; t <= t1; t += 7) weeks.push(t);
    const mfrs = ["Ridgeline", "Northwind", "Halcyon"], col = { Ridgeline: "var(--s2)", Northwind: "var(--s1)", Halcyon: "var(--s3)" };
    C.xy(pw.querySelector(".body"), { height: 240, x: weeks, yZero: true, ymin: 0, series: mfrs.map((mf) => ({ name: mf, color: col[mf], values: weeks.map((w) => { let s = 0; rows.forEach((r) => { if (r.m.mfr === mf) for (let t = w; t < Math.min(w + 7, t1 + 1); t++) s += M.lost_theo[r.i][t]; }); return s; }) })),
      xticks: monthTicks(t0, t1), tipTitle: (i) => "Week of " + D.dates[weeks[i]], aria: "weekly lost theo" });
    pw.querySelector(".body").append(h(`<div class="legend">${mfrs.map((m) => `<span><i style="background:${col[m]}"></i>${m}</span>`).join("")}</div>`));
    const pm = panel("p-dt-mfr", "Faults per 1,000 machine-days", "Ridgeline breaks about three times as often, though its rate is falling.", "operations (fault_repair) via prepared_daily_view.faults_opened ÷ on-floor machine-days.");
    g.append(pm);
    C.bars(pm.querySelector(".body"), { horizontal: true, labelW: 90, fmt: (v) => v.toFixed(0), vfmt: (v) => v.toFixed(1), items: mfrs.filter((m) => byMfr[m]).map((m) => ({ label: m, value: byMfr[m].f / byMfr[m].md * 1000, color: col[m], tip: `<div class="th">${m}</div>${byMfr[m].n} machines · ${byMfr[m].f} faults<br>Lost theo ${F.usd(byMfr[m].lt)}` })) });
    const g2 = h(`<div class="grid g64"></div>`); main.append(g2);
    const ph = panel("p-dt-heat", "The downtime clock", "Lost theo by hour of the day. The ball rolls to the costliest hour.", "machine_hour downtime × each machine's own coin-in per working hour at that local hour × (1 − RTP). Whole window; America/Los_Angeles clock.");
    ph.classList.add("felt"); g2.append(ph); downtimeClock(ph.querySelector(".body"));
    const ps = panel("p-dt-staff", "Repair wait depends on who showed up", "Average hours from fault to technician, by slot techs actually on shift.", "operations (opened_at, work_started_at) ⨝ shift_roster (role = slot_tech) on gaming date and shift.");
    g2.append(ps);
    const tbl = h(`<div class="tw"><table><thead><tr><th>Shift</th><th class="n">Techs (plan/actual)</th><th class="n">Tickets</th><th class="n">Wait h</th><th class="n">Down h</th></tr></thead><tbody>${D.repair_staffing.map((r) => `<tr><td>${r.shift}</td><td class="n">${r.planned}/${r.actual}</td><td class="n">${r.n}</td><td class="n">${r.wait_h.toFixed(2)}</td><td class="n">${r.down_h.toFixed(2)}</td></tr>`).join("")}</tbody></table></div>`);
    ps.querySelector(".body").append(tbl);
    ps.querySelector(".body").append(h(`<p style="font-size:13px">A no-show on a one-tech day shift turns a 1.6-hour wait into 4.7 hours. The grave shift is always one tech and waits 1.8 hours. Fixing the wait saves real hours, but the plan tab shows the theo at stake is smaller than a technician costs.</p>`));
  }

  // ================================================================ Q4 PLAYERS
  function vPlayers(main) {
    const cols = D.guest_cube_cols, ix = Object.fromEntries(cols.map((c, k) => [c, k]));
    const months = [...new Set(D.guest_cube.map((r) => r[0]))].filter((m) => m >= D.dates[S.t0].slice(0, 7) && m <= D.dates[S.t1].slice(0, 7));
    const groups = Object.keys(D.guest_conc);
    if (!groups.includes(S.group)) S.group = groups[0];
    const [gk, gv] = S.group.includes(":") ? S.group.split(":") : [null, null];
    const sel = D.guest_cube.filter((r) => months.includes(r[0]) && (!gk || r[ix[gk]] === gv));
    const tot = (c) => sel.reduce((a, r) => a + (r[ix[c]] || 0), 0);
    const ci = tot("ci"), po = tot("po"), net = tot("net"), theo = tot("theo"), comp = tot("comp"), contrib = tot("contrib");
    const conc = D.guest_conc[S.group];
    main.append(head(`Q4 · tracked (loyalty-card) play · ${months[0]} → ${months[months.length - 1]}`, "Players lost about what the math expects, and a small group carries most of it",
      `Tracked players in <b>${esc(prettyGroup(S.group))}</b> wagered ${F.usd(ci)}, got back ${F.usd(po)} and netted ${F.usd(net)} (theo ${F.usd(theo)}). Over the half-year, the top 5% of players by theo produced ${F.pct(conc.top5, 0)} of it and the top 1% produced ${F.pct(conc.top1, 0)}; ${F.pct(conc.ahead_share, 0)} of players finished ahead. Locals are a small share of cards but most of the theo.`));
    const pick = h(`<div class="chips" role="group" aria-label="Guest group"></div>`);
    groups.forEach((g) => { const b = h(`<button class="chip" type="button" aria-pressed="${g === S.group}">${esc(prettyGroup(g))}</button>`); b.onclick = () => { S.group = g; store.set("group", g); render(); }; pick.append(b); });
    main.append(pick);
    main.append(kpis([["Wagered (coin-in)", F.usd(ci), "carded play"], ["Paid back", F.usd(po), F.pct(po / ci, 1) + " of wagers"], ["Players' net", F.usd(net), "payout − coin-in"], ["Finished ahead", F.pct(conc.ahead_share, 1), `of ${F.num(conc.players)} players, full window`]]));
    const g = h(`<div class="grid g3"></div>`); main.append(g);
    const pl = panel("p-lorenz", "Concentration of theo", "Share of theo from the top x% of players (full window).", "player_period summed per player first, then ranked by theo.");
    g.append(pl);
    const lz = conc.lorenz; const all = D.guest_conc["All tracked players"].lorenz;
    C.xy(pl.querySelector(".body"), { height: 230, x: lz.map((p) => p[0]), xmin: 0, xmax: 1, ymin: 0, ymax: 1, series: [{ name: prettyGroup(S.group), values: lz.map((p) => p[1]), color: "var(--s1)", width: 2.4 }, ...(S.group !== "All tracked players" ? [{ name: "All players", values: all.map((p) => p[1]), color: "var(--neutral)", width: 1.5 }] : []), { name: "Equal share", values: lz.map((p) => p[0]), color: "var(--ink)", dash: "3 3", width: 1 }],
      yfmt: (v) => F.pct(v, 0), xfmt: (v) => "top " + F.pct(v, 0), tipTitle: (i) => "Top " + F.pct(lz[i][0], 0) + " of players", aria: "lorenz" });
    const pn = panel("p-net", "How players finished", "Players by net result over the window.", "Net = payout − coin-in per player, summed over months. Tracked play only.");
    g.append(pn);
    C.bars(pn.querySelector(".body"), { items: conc.net_bins.map((b, k) => ({ label: b.replace(/\$/g, ""), value: conc.net_hist[k], color: k >= 6 ? "var(--s3)" : "var(--s2)", tip: `<div class="th">${b}</div>${F.num(conc.net_hist[k])} players` })), fmt: (v) => F.num(v), height: 230, margin: { b: 44 } });
    [...pn.querySelectorAll("text.tick")].forEach((t) => { if (t.getAttribute("text-anchor") === "middle" && t.textContent.length > 6) { t.setAttribute("transform", `rotate(-35 ${t.getAttribute("x")} ${t.getAttribute("y")})`); t.setAttribute("text-anchor", "end"); } });
    const pr = panel("p-region", "Theo by home region", "", "player_period.home_region (coarse).");
    g.append(pr);
    const regs = ["Local", "Regional", "Domestic", "International"];
    C.bars(pr.querySelector(".body"), { horizontal: true, labelW: 100, items: regs.map((rg) => { const rr = D.guest_cube.filter((r) => months.includes(r[0]) && r[ix.region] === rg && (!gk || gk === "region" || r[ix[gk]] === gv)); const t = rr.reduce((a, r) => a + r[ix.theo], 0); const p = D.guest_conc["region:" + rg]; return { label: rg, value: t, color: rg === "Local" ? "var(--s1)" : "var(--neutral)", tip: `<div class="th">${rg}</div>Theo ${F.usd(t)}<br>${F.num(p.players)} players · ${F.usd(p.theo / p.players)} theo each` }; }) });
    const pt = panel("p-month", "Month by month", "", "player_period. Contribution = coin-in − payout + POS cash − POS cogs (comp cost counted once, inside cogs).");
    main.append(pt);
    const mrows = months.map((m) => { const rr = sel.filter((r) => r[0] === m); const s = (c) => rr.reduce((a, r) => a + (r[ix[c]] || 0), 0); return { m, players: s("players"), visits: s("visits"), ci: s("ci"), net: s("net"), theo: s("theo"), comp: s("comp"), contrib: s("contrib"), ahead: s("ahead"), gamers: s("gamers") }; });
    pt.querySelector(".body").append(h(`<div class="tw"><table><thead><tr><th>Month</th><th class="n">Players</th><th class="n">Visits</th><th class="n">Wagered</th><th class="n">Net</th><th class="n">Theo</th><th class="n">Luck</th><th class="n">Ahead</th><th class="n">Comp cost</th><th class="n">Contribution</th></tr></thead><tbody>${mrows.map((r) => `<tr><td>${r.m}</td><td class="n">${F.num(r.players)}</td><td class="n">${F.num(r.visits)}</td><td class="n">${F.usd(r.ci)}</td><td class="n">${F.usd(r.net)}</td><td class="n">${F.usd(r.theo)}</td><td class="n">${F.usd(r.net + r.theo)}</td><td class="n">${F.pct(r.ahead / r.gamers, 1)}</td><td class="n">${F.usd(r.comp)}</td><td class="n">${F.usd(r.contrib)}</td></tr>`).join("")}</tbody></table></div>`));
    main.append(h(`<p class="callout"><b>Responsible play.</b> Nothing in this plan targets heavy losers or tries to increase their play. ${D.guest_conc["All tracked players"].net_hist[0]} tracked players lost more than $5,000 over the half-year; a protective follow-up (play-limit reminders offered at the card desk) is a better use of this list than marketing.</p>`));
  }
  const prettyGroup = (g) => g.includes(":") ? g.split(":")[1] + (g.startsWith("tier") ? " tier" : g.startsWith("age") ? " (age)" : "") : g;

  // ================================================================ Q5 COMPS
  function vComps(main) {
    const L = D.points_liability, CC = D.comp_change;
    const cols = D.guest_cube_cols, ix = Object.fromEntries(cols.map((c, k) => [c, k]));
    const months = [...new Set(D.guest_cube.map((r) => r[0]))];
    const mm = months.map((m) => { const rr = D.guest_cube.filter((r) => r[0] === m); const s = (c) => rr.reduce((a, r) => a + r[ix[c]], 0); return { m, comp: s("comp"), theo: s("theo"), face: s("comp_face"), n: s("comps"), pe: s("pe"), pr: s("pr") }; });
    const tot = mm.reduce((a, r) => a + r.comp, 0), totTheo = mm.reduce((a, r) => a + r.theo, 0);
    const pre = mm.filter((r) => r.m >= "2025-03" && r.m <= "2025-04"), post = mm.filter((r) => r.m >= "2025-05");
    const ri = (a) => a.reduce((x, r) => x + r.comp, 0) / a.reduce((x, r) => x + r.theo, 0);
    main.append(head("Q5 · loyalty program · full window", "On May 1 every comp got about half as expensive in points, and nothing else moved",
      `Comps cost the house ${F.usd(tot)} (economic cost; face value ${F.usd(mm.reduce((a, r) => a + r.face, 0))}), ${F.pct(tot / totTheo, 2)} of tracked theo. On 2025-05-01 the points needed per comp dollar fell by roughly half in every tier. Redemptions per day did not respond (${L.redemptions_per_day_mar_apr} before, ${L.redemptions_per_day_may_jun} after) and reinvestment edged from ${F.pct(ri(pre), 2)} to ${F.pct(ri(post), 2)}. The quiet cost is the point balance: the ${F.num(L.outstanding / 1e6, 0)}M unredeemed points are now worth ${F.usd(L.liability_post_rate)} at the new rate, up from ${F.usd(L.liability_pre_rate)}.`));
    main.append(kpis([["Comp cost (economic)", F.usd(tot), "counted once (inside POS cogs)"], ["Reinvestment", F.pct(tot / totTheo, 2), "comp cost ÷ tracked theo"], ["Cost per 1,000 points", `$${L.cost_per_1000_pre.toFixed(0)} → $${L.cost_per_1000_post.toFixed(0)}`, "before vs after May 1"], ["Point balance at new rate", F.usd(L.liability_post_rate), `${F.pct(L.redeem_rate_of_awarded, 1)} of points ever redeemed`]]));
    // the bar menu: what a drink costs in points, before and after May 1
    const pb = panel("p-bar", "The bar menu, priced in points", "Comps are drinks and food. Pick a tier, then pour the May 1 change.", "loyalty_ledger (redeem): average face value per benefit; points = face value × that tier's points per comp dollar before / after 2025-05-01.");
    pb.classList.add("felt"); main.append(pb);
    const GL = {
      SODA: `<rect x="12" y="8" width="16" height="26" rx="3" fill="#c8102e" stroke="#141414" stroke-width="2.5"/><rect x="12" y="15" width="16" height="6" fill="#fff8e7"/>`,
      BEER: `<rect x="9" y="10" width="18" height="24" rx="2" fill="#f6b81e" stroke="#141414" stroke-width="2.5"/><path d="M27 15h4a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-4" fill="none" stroke="#141414" stroke-width="2.5"/><path d="M8 10q3-5 7-2q3-4 7 0q4-3 6 2z" fill="#fff8e7" stroke="#141414" stroke-width="2"/>`,
      WINE: `<path d="M12 6h16c0 10-3 15-8 15s-8-5-8-15z" fill="#7b1530" stroke="#141414" stroke-width="2.5"/><path d="M20 21v10M13 34h14" stroke="#141414" stroke-width="2.5" stroke-linecap="round"/>`,
      COCKTAIL: `<path d="M6 7h28L20 21z" fill="#2ad4d9" stroke="#141414" stroke-width="2.5" stroke-linejoin="round"/><path d="M20 21v10M13 34h14" stroke="#141414" stroke-width="2.5" stroke-linecap="round"/><circle cx="27" cy="8" r="3.5" fill="#c8102e" stroke="#141414" stroke-width="1.5"/>`,
      COFFEE: `<path d="M9 14h20v12a8 8 0 0 1-8 8h-4a8 8 0 0 1-8-8z" fill="#fff8e7" stroke="#141414" stroke-width="2.5"/><path d="M29 17h3a3 3 0 0 1 0 7h-3" fill="none" stroke="#141414" stroke-width="2.5"/><path d="M15 6q2 3 0 6M21 6q2 3 0 6" stroke="#fff8e7" stroke-width="2" fill="none"/>`,
    };
    const PLATE = (c) => `<ellipse cx="20" cy="27" rx="16" ry="7" fill="#fff8e7" stroke="#141414" stroke-width="2.5"/><ellipse cx="20" cy="22" rx="10" ry="6" fill="${c}" stroke="#141414" stroke-width="2.5"/>`;
    const FOOD = { PASTRY: "#e0a24a", SANDWICH: "#d9b26a", SALAD: "#4caf50", BURGER: "#8a4b1f", PASTA: "#f2c14e" };
    const icon = (id) => { const k = id.replace("COMP-", ""); return `<svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true">${GL[k] || PLATE(FOOD[k] || "#e0a24a")}</svg>`; };
    let barTier = store.get("barTier", "Base"), poured = false;
    let wasPoured = false;
    const drawBar = () => {
      const a = CC.find((x) => x.tier === barTier && !x.after), b = CC.find((x) => x.tier === barTier && x.after);
      const maxPts = Math.max(...D.comp_items.map((it) => it.face)) * a.pts_per_face_usd;
      $(".body", pb).innerHTML = `<div class="chips" role="group" aria-label="Tier">${["Base", "Gold", "Platinum"].map((t) => `<button class="chip" type="button" aria-pressed="${t === barTier}" data-t="${t}">${t}</button>`).join("")}<button class="btn small red" type="button" id="pour" style="margin-left:auto">${poured ? "Back to April prices" : "Pour the May 1 change"}</button></div>
        <div class="menu">${D.comp_items.map((it) => { const p0 = Math.round(it.face * a.pts_per_face_usd), p1 = Math.round(it.face * b.pts_per_face_usd); return `<div class="mrow">${icon(it.id)}<span class="mname">${esc(it.id.replace("COMP-", "").toLowerCase())}<small>$${it.face.toFixed(2)} menu · house pays $${it.cost.toFixed(2)}</small></span>
          <span class="mbar"><i class="was" style="width:${(p0 / maxPts) * 100}%"></i><i class="now" style="width:${((wasPoured ? p1 : p0) / maxPts) * 100}%" data-to="${((poured ? p1 : p0) / maxPts) * 100}"></i></span>
          <span class="mpts">${poured ? `<s>${F.num(p0)}</s> ${F.num(p1)}` : F.num(p0)} pts</span></div>`; }).join("")}</div>
        <p style="font-size:14.5px">${poured ? `After May 1 a ${barTier} player's cocktail costs ${F.num(Math.round(16 * b.pts_per_face_usd))} points instead of ${F.num(Math.round(16 * a.pts_per_face_usd))}. The house still pays the same for the drink, and players did not order more of them, so the visible cost barely moved. What doubled is the value of every unredeemed point.` : `These are April prices. Press pour to apply the May 1 rate.`}</p>`;
      pb.querySelectorAll("[data-t]").forEach((bt) => bt.onclick = () => { barTier = bt.dataset.t; store.set("barTier", barTier); drawBar(); });
      requestAnimationFrame(() => requestAnimationFrame(() => pb.querySelectorAll(".mbar .now").forEach((i) => { i.style.width = i.dataset.to + "%"; })));
      wasPoured = poured;
      $("#pour", pb).onclick = () => { poured = !poured; drawBar(); if (poured) coinRain(25); };
    };
    drawBar();
    const g = h(`<div class="grid g2"></div>`); main.append(g);
    const pw = panel("p-comp-ppd", "Points needed per $1 of comp (face value)", "Weekly, by tier before redemption.", "loyalty_ledger (event_type = redeem): −Σpoints_delta ÷ Σface_value. Gaming-day weeks.");
    g.append(pw);
    const wks = [...new Set(D.comp_weekly.map((r) => r.wk))];
    const tiers = ["Base", "Gold", "Platinum"], tc = { Base: "var(--s1)", Gold: "var(--s4)", Platinum: "var(--s7)" };
    C.xy(pw.querySelector(".body"), { height: 250, x: wks.map((_, k) => k), ymin: 0, series: tiers.map((t) => ({ name: t, color: tc[t], label: t, values: wks.map((w) => { const r = D.comp_weekly.find((x) => x.wk === w && x.tier === t); return r && r.n > 20 ? r.pts / r.face : null; }) })),
      yfmt: (v) => v.toFixed(0), xticks: wks.map((w, k) => ({ v: k, label: w.slice(5) })).filter((_, k) => k % 4 === 0), tipTitle: (i) => "Week of " + wks[i], margin: { r: 64 }, aria: "points per comp dollar" });
    pw.querySelector(".body").append(h(`<div class="legend">${tiers.map((t) => `<span><i style="background:${tc[t]}"></i>${t}</span>`).join("")}</div>`));
    const pm = panel("p-comp-month", "Comp cost and redemptions by month", "", "player_period (comp_cost_usd, comps_redeemed, theo_usd).");
    g.append(pm);
    C.bars(pm.querySelector(".body"), { items: mm.map((r) => ({ label: r.m.slice(5), value: r.comp, color: r.m >= "2025-05" ? "var(--accent)" : "var(--neutral)", tip: `<div class="th">${r.m}</div>Comp cost ${F.usd(r.comp)}<br>${F.num(r.n)} comps · reinvestment ${F.pct(r.comp / r.theo, 2)}<br>Points earned ${F.num(r.pe / 1e6, 1)}M · redeemed ${F.num(r.pr / 1e6, 2)}M` })), height: 220, valueLabels: true });
    const pt = panel("p-comp-tier", "Before and after, by tier", "", "loyalty_ledger split at 2025-05-01 06:00 local.");
    main.append(pt);
    pt.querySelector(".body").append(h(`<div class="tw"><table><thead><tr><th>Tier</th><th class="n">Pts per $ before</th><th class="n">after</th><th class="n">Cost / 1k pts before</th><th class="n">after</th><th class="n">Redemptions Jan–Apr</th><th class="n">May–Jun</th></tr></thead><tbody>${tiers.map((t) => { const a = CC.find((x) => x.tier === t && !x.after), b = CC.find((x) => x.tier === t && x.after); return `<tr><td>${t}</td><td class="n">${a.pts_per_face_usd.toFixed(2)}</td><td class="n">${b.pts_per_face_usd.toFixed(2)}</td><td class="n">$${a.cost_per_1000pts.toFixed(2)}</td><td class="n">$${b.cost_per_1000pts.toFixed(2)}</td><td class="n">${F.num(a.n)}</td><td class="n">${F.num(b.n)}</td></tr>`; }).join("")}</tbody></table></div>`));
    main.append(h(`<p class="callout"><b>What would change our mind.</b> If points were redeemed faster after the change, the cost would show up as more redemptions; it has not yet (about 2 months of data). The drift from 14 to 12.5 points per dollar between January and April is tier mix: more redemptions came from Gold players, who already paid fewer points. The step on May 1 is a rate change in every tier at once.</p>`));
  }

  // ================================================================ MODEL
  function vModel(main) {
    const Mo = D.model, s = Mo.series, x = D.dates.map((_, k) => k);
    const best = Mo.scores[2], base = Mo.scores[0], wd = Mo.scores[1];
    main.append(head("Model · time-based holdout", "A frozen weekday + calendar forecast, and what it decides",
      `Trained on ${Mo.train}, scored once on ${Mo.test}. Holdout MAE: ${F.usd(best.mae)} a day for the model, ${F.usd(wd.mae)} for weekday means, ${F.usd(base.mae)} for a constant mean (${F.pct(1 - best.mae / base.mae, 0)} lower error than the baseline). Its job is to give a counterfactual for promotions. Against it, the February slot tournament added about ${F.usd(Object.values(Mo.lifts)[0].theo_lift)} of theo in three days; the June Locals Week, which the frozen model never saw, added ${F.usd(Object.values(Mo.lifts)[1].theo_lift)} over seven.`));
    const p = panel("p-forecast", "Daily floor coin-in: actual vs. frozen forecasts", "Shaded = holdout (May–June). Blue band = model 95% prediction interval.", "Fit with numpy least squares on log coin-in, Duan smearing for back-transform. Features known at freeze only.");
    main.append(p);
    const ti = D.dates.indexOf(Mo.train.split(" to ")[1].slice(0, 10)) + 1;
    C.xy(p.querySelector(".body"), { height: 290, x, shade: [{ from: ti, to: T - 1, cls: "test", label: "Holdout" }], band: { lo: s.lo, hi: s.hi }, series: [{ name: "Actual", values: s.y, color: "var(--ink)", width: 1.6 }, { name: "Model", values: s.model, color: "var(--s1)", width: 2 }, { name: "Weekday mean", values: s.weekday, color: "var(--s2)", width: 1.4, dash: "5 3" }, { name: "Constant", values: s.const, color: "var(--neutral)", width: 1.4, dash: "2 3" }],
      xticks: monthTicks(0, T - 1), tipTitle: (i) => `${D.dates[i]} · ${D.weekday[i]}${D.pday.events[i] ? " · " + D.pday.events[i] : ""}`, aria: "forecast vs actual" });
    p.querySelector(".body").append(h(`<div class="legend"><span><i style="background:var(--ink)"></i>Actual</span><span><i style="background:var(--s1)"></i>Model</span><span><i style="background:var(--s2)"></i>Weekday mean</span><span><i style="background:var(--neutral)"></i>Constant mean</span></div>`));
    const g = h(`<div class="grid g2"></div>`); main.append(g);
    const ps = panel("p-scores", "How it was validated", "", "Holdout scored once, after freezing. Bias = mean(forecast − actual).");
    g.append(ps);
    ps.querySelector(".body").append(h(`<div class="tw"><table><thead><tr><th>Forecast</th><th class="n">Holdout MAE</th><th class="n">MAPE</th><th class="n">Bias</th><th class="n">Train MAE</th></tr></thead><tbody>${Mo.scores.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${F.usd(r.mae)}</td><td class="n">${F.pct(r.mape, 1)}</td><td class="n">${F.usd(r.bias)}</td><td class="n">${F.usd(r.train_mae)}</td></tr>`).join("")}</tbody></table></div>`));
    ps.querySelector(".body").append(h(`<ul style="margin:0;padding-left:18px;font-size:13.5px;display:grid;gap:4px"><li>Split by time: train Jan 1–Apr 30, test May 1–Jun 30. No random split.</li><li>${esc(Mo.frozen)}</li><li>No lagged actuals, so a 61-day forecast never uses holdout results.</li><li>All three forecasts over-predict slightly (positive bias): June demand softened, matching fewer city visitors.</li></ul>`));
    const pl = panel("p-lifts", "Decision: what does a promotion weekend add?", "Actual minus forecast during each event; ± is one standard error from training residuals.", "Lift in theo = coin-in lift × floor theo hold (" + F.pct(Mo.floor_theo_hold, 2) + ").");
    g.append(pl);
    pl.querySelector(".body").append(h(`<div class="tw"><table><thead><tr><th>Event</th><th class="n">Days</th><th class="n">Coin-in lift</th><th class="n">Theo lift</th></tr></thead><tbody>${Object.entries(Mo.lifts).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v.days}</td><td class="n">${F.pct(v.lift_pct, 1)}</td><td class="n">${F.usd(v.theo_lift)} ± ${F.usd(v.theo_se)}</td></tr>`).join("")}</tbody></table></div>`));
    pl.querySelector(".body").append(h(`<p class="callout">Even if only 60% of the February tournament's lift repeats, the tournament format returns close to 3× its $15,000 catalogue price in theo. The discount-style Locals Week returned less and with more uncertainty ($27k ± $16k over seven days). <b>Decision:</b> fund one tournament-style promotion weekend in July, on a Friday–Sunday, and judge it against this same frozen forecast. The weekday pattern also says where a spare technician hour matters most: Friday and Saturday swing shift.</p>`));
  }

  // ================================================================ Q6 PLAN
  const ACT = Object.fromEntries(D.actions.map((a) => [a.action_type_id, a]));
  function planModel() {
    const R = FULL.rows, H = (D.model.lifts);
    const lk = [...R].filter((r) => r.on > 0).sort((a, b) => Math.abs(b.hz) - Math.abs(a.hz))[0];
    const lkDay = lk.ci / lk.on, lkSe = lk.sd / lk.ci;
    const b40 = R.filter((r) => r.zone === "Z-B40" && r.on > 0); const b40Day = b40.reduce((a, r) => a + r.theo, 0) / T;
    const ridgeDay = R.filter((r) => r.m.mfr === "Ridgeline").reduce((a, r) => a + r.lost_theo, 0) / T;
    const graveHeat = D.downtime_heat.filter((c) => c.hour >= 21 || c.hour < 5);
    const graveTheoPerH = graveHeat.reduce((a, c) => a + c.theo, 0) / graveHeat.reduce((a, c) => a + c.h, 0);
    const graveFaultsDay = D.repair_staffing.filter((r) => r.shift === "grave").reduce((a, r) => a + r.n, 0) / T;
    const tourn = Object.values(H)[0], locals = Object.values(H)[1];
    const royal = R.filter((r) => r.zone === "Z-B40" && r.m.cfg === "G-VID95" && r.on > 120 && !r.m.retire);
    const gf = FULL.gameFactor, zf = FULL.zoneFactor;
    const floorTpa = R.reduce((a, r) => a + r.theo, 0) / R.reduce((a, r) => a + r.avh, 0);
    const swapGain = royal.length ? avg(royal.map((r) => floorTpa * zf["Z-B40"] * (gf["G-NEW91"] - gf["G-VID95"]) * 24 * r.avail)) : 0;
    const ixc = D.guest_cube_cols.indexOf("comp"), compM = (a, b) => D.guest_cube.filter((r) => r[0] >= a && r[0] <= b).reduce((s, r) => s + r[ixc], 0);
    const compDayPre = compM("2025-03", "2025-04") / 61, compDayPost = compM("2025-05", "2025-06") / 61;
    return { lk, lkDay, lkSe, b40Day, ridgeDay, graveTheoPerH, graveFaultsDay, tourn, locals, royal, swapGain, compDayPre, compDayPost };
  }
  function vPlan(main) {
    const P = planModel();
    const plan = store.get("plan", null) || { "A-INSPECT": { on: true, q: 1 }, "A-WAYFINDING": { on: true, q: 1 }, "A-PROMO": { on: true, q: 1 } };
    const asm = Object.assign({ inspectP: 0.85, signLift: 0.05, promoHaircut: 0.6, pmCut: 0.25, techCut: 0.6, swapTransfer: 0.6 }, store.get("asm", {}));
    const cost = (id, q) => { const a = ACT[id]; return q * (a.unit_cost_cents + a.recurring_cost_cents_per_day * Math.max(0, 30 - a.lead_days)) / 100; };
    const eff = (id) => Math.max(0, 30 - ACT[id].lead_days);
    // benefit model: [low, mid, high] incremental theo in the 30-day horizon, per quantity q
    const B = {
      "A-INSPECT": { target: `${P.lk.id} first (hit-rate z = ${P.lk.hz.toFixed(0)}); more units add little`, f: (q) => { const gap = (lo) => Math.max(0, P.lk.theoHold - lo) * P.lkDay * eff("A-INSPECT"); return [gap(P.lk.hold + 1.96 * P.lkSe) * asm.inspectP, gap(P.lk.hold) * asm.inspectP, gap(Math.max(0, P.lk.hold - 1.96 * P.lkSe))]; },
        effect: "Restore the published paytable on the one machine whose payout fingerprint is off. Gap = (configured hold − observed hold) × coin-in per day.", measure: "Next 7 days: hit rate back inside ±3σ of the published 31.5% (detectable within one day); hold tracked weekly against theo with the luck funnel.", ev: [["verdict", "p-hit"], ["verdict", "p-case"]], slider: ["inspectP", "Chance the inspection confirms a paytable fault", 0.3, 1, 0.05] },
      "A-WAYFINDING": { target: "Back Forty (Z-B40)", f: (q) => { const base = P.b40Day * eff("A-WAYFINDING"); return [0, base * asm.signLift, base * Math.min(0.12, asm.signLift * 2)].map((v) => v * Math.min(q, 1)); },
        effect: `Back Forty earns ${F.usd(P.b40Day)} theo a day and lost ${F.pct(-D.closure_did.did_effect, 0)} of relative play when its walkway closed, so access drives it. Break-even lift: ${F.pct(cost("A-WAYFINDING", 1) / (P.b40Day * eff("A-WAYFINDING")), 1)}.`, measure: "Difference-in-differences again: Back Forty ÷ rest-of-floor coin-in per available hour, 20 days after install vs the 28 days before; S-B40 door counter as a leading signal.", ev: [["demand", "p-did"], ["demand", "p-zone"], ["verdict", "p-map"]], slider: ["signLift", "Assumed lift in Back Forty play", 0, 0.15, 0.01] },
      "A-PROMO": { target: "One Fri–Sun tournament weekend after Jul 15 (14-day lead)", f: (q) => [P.locals.theo_lift * 3 / 7 * q, P.tourn.theo_lift * asm.promoHaircut * q, P.tourn.theo_lift * q],
        effect: `Tournament weekend lifted coin-in ${F.pct(P.tourn.lift_pct, 0)} against the refit forecast (${F.usd(P.tourn.theo_lift)} theo). Low case uses the weaker Locals Week per-day lift.`, measure: "Score the weekend against the frozen forecast (same method as the Feb tournament); report lift ± SE, plus comp and F&B cost of the weekend.", ev: [["model", "p-lifts"], ["model", "p-forecast"]], slider: ["promoHaircut", "Share of February's lift we expect to repeat", 0.2, 1, 0.05] },
      "A-COMP-PILOT": { target: "Random half of carded players back on the pre-May point rate", f: () => [0, 0, 0], effect: "Pure information: tells us whether the May 1 rate change bought any extra visits or play. Comp costs themselves still flow through.", measure: "Treatment vs control theo per player and visits over 25 days; pre-registered 2-sided test.", ev: [["comps", "p-comp-ppd"]] },
      "A-COMP-CHANGE": { unit: "saved", target: "Floor-wide point cost per comp dollar back to 12", f: () => { const d = Math.max(0, P.compDayPost - P.compDayPre) * eff("A-COMP-CHANGE"); return [0, d, 2 * d]; }, effect: `Comp cost per day rose only ${F.usd(P.compDayPost - P.compDayPre)} after May 1, because redemptions did not increase. Reverting saves about that, shrinks the point balance's value, and risks goodwill; with no control group we could not measure the visit effect.`, measure: "Pre/post only (weak).", ev: [["comps", "p-comp-tier"]] },
      "A-TECH-SHIFT": { target: "Grave shift (21:00–05:00)", f: (q) => { const saved = 1.08 * asm.techCut / 0.6 * P.graveFaultsDay * eff("A-TECH-SHIFT") * P.graveTheoPerH * Math.min(q, 1); return [saved * 0.5, saved, saved * 1.5]; },
        effect: `Grave tickets wait 1.8 h with one tech vs 0.7 h when two are on. At ${F.usd(P.graveTheoPerH)} theo per down machine-hour overnight, that saves little money.`, measure: "Mean wait and downtime per grave ticket vs the prior 30 days.", ev: [["downtime", "p-dt-staff"], ["downtime", "p-dt-heat"]], slider: ["techCut", "Share of the wait gap a second tech removes", 0.2, 1, 0.05] },
      "A-PREVENTIVE": { target: "Ridgeline (highest fault rate)", f: (q) => { const v = P.ridgeDay * eff("A-PREVENTIVE") * asm.pmCut * Math.min(q, 1); return [v * 0.4, v, v * 1.6]; }, effect: `Ridgeline downtime costs ${F.usd(P.ridgeDay)} theo a day in total; even removing all of it would not repay $9,000 in 23 days.`, measure: "Faults per 1,000 machine-days, Ridgeline vs others.", ev: [["downtime", "p-dt-mfr"]], slider: ["pmCut", "Fault reduction from the sweep", 0.05, 0.6, 0.05] },
      "A-REPLACE-LEASE": { target: `Back Forty Royal Draw (95% RTP): ${P.royal.map((r) => r.id).join(", ")}`, f: (q) => { const v = P.swapGain * asm.swapTransfer * eff("A-REPLACE-LEASE") * Math.min(q, P.royal.length); return [0, v, v / asm.swapTransfer]; },
        effect: `Replace the game, not the machine: a 91% title like Aurora Link would hold more on the same traffic. Model gain ${F.usd(P.swapGain)} theo/day per unit if the game effect transfers to Back Forty; it has only been seen in the Center Pit.`, measure: "Peer index of the new title vs remaining Royal Draws in Back Forty.", ev: [["verdict", "p-fair"]], slider: ["swapTransfer", "Share of the game effect that transfers to Back Forty", 0, 1, 0.05] },
      "A-REPLACE-BUY": { target: "Not recommended", f: () => [0, 0, 0], effect: "$22,000 a unit charged in full this month; no machine is weak enough to justify it.", measure: "–", ev: [["verdict", "p-fair"]] },
      "A-MOVE-MACHINE": { target: "Not recommended", f: () => [0, 0, 0], effect: "Moving a machine out of Back Forty moves another into the low-traffic slot. With no spare slots, total theo barely changes.", measure: "–", ev: [["verdict", "p-map"]] },
      "A-MOVE-BANK": { target: "Not recommended", f: () => [0, 0, 0], effect: "Same zero-sum problem as single moves, with 480 minutes of downtime per bank.", measure: "–", ev: [["verdict", "p-map"]] },
      "A-SURVEY": { target: "July intercept survey ×3 sample", f: () => [0, 0, 0], effect: "Information only. The current survey's ±2–3 point error already answers our questions.", measure: "–", ev: [["demand", "p-real"]] },
    };
    const ids = Object.keys(B);
    const sel = ids.filter((id) => plan[id]?.on);
    const totalCost = sel.reduce((a, id) => a + cost(id, plan[id].q), 0);
    const ben = sel.reduce((a, id) => { const b = B[id].f(plan[id].q); return a.map((v, k) => v + b[k]); }, [0, 0, 0]);
    const problems = [];
    if (sel.length > 3) problems.push(`${sel.length} action types selected; the limit is 3.`);
    if (totalCost > 100000) problems.push(`Over budget by ${F.usd0(totalCost - 100000)}.`);
    if (plan["A-COMP-PILOT"]?.on && plan["A-COMP-CHANGE"]?.on) problems.push("The comp pilot and the floor-wide comp change cannot run together.");
    sel.forEach((id) => { if (plan[id].q > ACT[id].quantity_limit) problems.push(`${ACT[id].name}: limit is ${ACT[id].quantity_limit}.`); });
    if (plan["A-WAYFINDING"]?.on && plan["A-REPLACE-LEASE"]?.on) problems.push("Signage and replacements in Back Forty in the same month would make neither measurable. Pick one.");

    main.append(head("Q6 · $100,000 for July 1–30, 2025", "Spend a quarter, keep three quarters",
      `Each funded action answers one diagnosis: <b>leak</b> → inspect the one machine with a broken payout fingerprint; <b>location</b> → wayfinding for Back Forty; <b>demand</b> → one tournament weekend the forecast says pays for itself. Replacing the manager's bottom 10, adding technicians and preventive maintenance all fail break-even within 30 days, so we keep the rest.`));
    const SHORT = { "A-INSPECT": "Inspect", "A-WAYFINDING": "Signage", "A-PROMO": "Tournament", "A-COMP-PILOT": "Comp pilot", "A-COMP-CHANGE": "Comp rate", "A-TECH-SHIFT": "Technician", "A-PREVENTIVE": "Maintenance", "A-REPLACE-LEASE": "Lease swap", "A-REPLACE-BUY": "Buy swap", "A-MOVE-MACHINE": "Move machine", "A-MOVE-BANK": "Move bank", "A-SURVEY": "Survey" };
    const CHIPC = ["var(--gold)", "var(--chip-blue)", "var(--neon)", "var(--chip-purple)"];
    const pile = (amt, col) => { const n = Math.max(1, Math.round(amt / 5000)); return `<span class="pile">${Array.from({ length: n }, (_, k) => `<span style="--k:${k};background:${typeof col === "function" ? col(k) : col}"></span>`).join("")}</span>`; };
    const spent = sel.map((id) => cost(id, plan[id].q));
    const tbl = h(`<section class="panel felt" id="p-budget"><header><h3>The table · $100,000 bankroll</h3><span class="sub">${sel.length}/3 bets placed · one chip ≈ $5,000</span></header>
      <div class="bankroll"><div class="stacks" aria-label="Chip stacks: kept and each bet">
        <div class="stack">${pile(100000 - totalCost, (k) => (k % 2 ? "#141414" : "var(--red)"))}<span>Kept<br>${F.usd0(100000 - totalCost)}</span></div>
        ${sel.map((id, k) => `<div class="stack">${pile(spent[k], CHIPC[k] || CHIPC[3])}<span>${esc(SHORT[id])}<br>${F.usd0(spent[k])}</span></div>`).join("")}
      </div>
      <div class="grid g3"><div class="voucher"><span class="l">On the table</span><span class="v">${F.usd0(totalCost)}</span><span class="d">qty × (unit + daily × max(0, 30 − lead))</span></div><div class="voucher" data-term="theo" tabindex="0"><span class="l">Expected payout (theo) <span class="info" aria-hidden="true">i</span></span><span class="v">${F.usd(ben[1])}</span><span class="d">range ${F.usd(ben[0])} – ${F.usd(ben[2])}</span></div><div class="voucher"><span class="l">Net of the bets</span><span class="v">${F.usd(ben[1] - totalCost)}</span><span class="d">low case ${F.usd(ben[0] - totalCost)}</span></div></div></div>
      ${problems.length ? problems.map((p) => `<p class="warnline">✕ ${esc(p)}</p>`).join("") : `<p class="okline">✓ Within budget, at most 3 action types, no conflicting targets.</p>`}
      <p class="okline" style="font-weight:500">Tap a chip to place or pull a bet. Odds = expected theo ÷ cost over the 30-day horizon. Open "Read the odds" for the evidence, the assumption slider and the measurement plan.</p>
      <div class="spots"></div>
      <div class="src">Theo is expected house win, not profit: prizes are inside the promo price, comps and F&B are not modelled here. Benefits count only days after each action's lead time.</div></section>`);
    main.append(tbl);
    const spots = $(".spots", tbl);
    ids.forEach((id, k) => {
      const a = ACT[id], b = B[id], p = plan[id] || { on: false, q: 1 }, c = cost(id, p.q), bf = b.f(p.q);
      const odds = c ? bf[1] / c : 0, info = bf[2] === 0;
      const col = ["var(--red)", "var(--chip-blue)", "var(--gold-deep)", "var(--chip-purple)", "var(--neon)", "#141414"][k % 6];
      const spot = h(`<div class="spot${p.on ? " on" : ""}${!info && odds < 1 ? " bad" : ""}" id="act-${id}">
        <div class="top"><button class="betchip" type="button" style="--c:${col}" aria-pressed="${p.on}" aria-label="${p.on ? "Pull bet on" : "Place bet on"} ${esc(a.name)}"></button>
          <div><h3>${esc(a.name)}</h3><div class="line">${esc(b.target)}</div></div>
          <div class="odds${!info && odds < 1 ? " neg" : ""}">${info ? "Info" : odds.toFixed(1) + " : 1"}<small class="term" data-term="odds">${info ? "no direct payout" : "expected odds"}</small></div></div>
        <div class="line"><span>Bet ${F.usd0(c)}</span><span>${b.unit || "theo"} ${F.usd(bf[1])} (${F.usd(bf[0])}–${F.usd(bf[2])})</span><label for="q-${id}">Qty <input type="number" id="q-${id}" min="1" max="${a.quantity_limit}" value="${p.q}"></label></div>
        <details ${openSpots.has(id) ? "open" : ""}><summary>Read the odds</summary>
          <p>${b.effect}</p><p><b>Measure:</b> ${esc(b.measure)}</p>
          ${b.slider ? `<label class="ctl" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;margin-top:8px;text-transform:none;letter-spacing:0;font-family:var(--f-body)" for="sl-${id}"><span>${esc(b.slider[1])}</span><b class="mono">${F.pct(asm[b.slider[0]], 0)}</b><input type="range" id="sl-${id}" min="${b.slider[2]}" max="${b.slider[3]}" step="${b.slider[4]}" value="${asm[b.slider[0]]}" style="grid-column:1/-1"></label>` : ""}
          <div class="line" style="margin-top:6px">lead ${a.lead_days} d · limit ${a.quantity_limit}${a.downtime_minutes ? ` · ${a.downtime_minutes} min downtime/unit` : ""}</div>
          <div class="ev">${b.ev.map(([v, pid]) => `<button type="button" data-v="${v}" data-p="${pid}">Trace evidence → ${esc(pid.replace("p-", ""))}</button>`).join("")}</div></details></div>`);
      const save = () => { store.set("plan", plan); store.set("asm", asm); render(); };
      spot.querySelector(".betchip").onclick = () => { const on = !p.on; plan[id] = Object.assign(p, { on }); if (on && odds > 1) coinRain(30); save(); };
      spot.querySelector(`#q-${id}`).onchange = (e) => { plan[id] = Object.assign(p, { q: Math.max(1, Math.min(a.quantity_limit, +e.target.value || 1)) }); save(); };
      spot.querySelector("details").ontoggle = (e) => { e.target.open ? openSpots.add(id) : openSpots.delete(id); };
      if (b.slider) spot.querySelector(`#sl-${id}`).oninput = (e) => { asm[b.slider[0]] = +e.target.value; e.target.previousElementSibling.textContent = F.pct(+e.target.value, 0); clearTimeout(spot._t); spot._t = setTimeout(save, 300); };
      spot.querySelectorAll(".ev button").forEach((bt) => bt.onclick = () => trace(bt.dataset.v, bt.dataset.p));
      spots.append(spot);
    });
    const rst = h(`<button type="button" class="btn cream">Reset to our recommended bets</button>`); rst.onclick = () => { store.set("plan", null); store.set("asm", {}); render(); }; main.append(h(`<div></div>`).appendChild(rst).parentNode);
  }
  const openSpots = new Set();
  function trace(v, pid) { location.hash = v; setTimeout(() => { const el = document.getElementById(pid); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1700); } }, 80); }

  // ================================================================ EVIDENCE
  function claims() {
    const R = FULL.rows.filter((r) => r.on > 0), P = planModel(), Mo = D.model, L = D.points_liability;
    const mgr = D.manager_bottom10.map((id) => FULL.rows[midx[id]]);
    const exp = mgr.filter((r) => r.on < T);
    return [
      { id: "C1", claim: `${exp.length} of the manager's bottom 10 were not on the floor for the whole window (${exp.map((r) => `${r.id}: ${r.on} days`).join("; ")}).`, src: "machines.install_date/retire_date; machine_day.active", alt: "They could also be weak per hour.", lim: "Per-hour peer index for these machines rests on fewer days.", v: "verdict", p: "p-mgr" },
      { id: "C2", claim: `${mgr.filter((r) => r.zone === "Z-B40").length} of the bottom 10 sit in Back Forty, which earns ${F.pct(FULL.zoneFactor["Z-B40"], 0)} of the floor's theo per available hour for the same game mix.`, src: "prepared_daily_view; peer model log(theo/avh) = zone + game", alt: "Back Forty could simply hold weaker games. The model separates zone and game effects.", lim: "Zone and game are partly confounded (Royal Draw is concentrated there).", v: "verdict", p: "p-fair" },
      { id: "C3", claim: `${P.lk.id} hits on ${F.pct(P.lk.hitRate, 1)} of spins vs a published ${F.pct(P.lk.g.hit_p, 1)} (z = ${P.lk.hz.toFixed(0)}); its hold was ${F.pct(P.lk.hold, 1)} vs ${F.pct(P.lk.theoHold, 1)} configured (luck z = ${P.lk.lz.toFixed(2)}).`, src: "machine_day.payout_positive_spins, paid_spins; game_math.hit_probability", alt: "Bad luck. Rejected: hit rate is stable every week and no other machine exceeds |z| = 3.", lim: "A lead for inspection, not proof of tampering or fault.", v: "verdict", p: "p-hit" },
      { id: "C4", claim: `Luck z-scores across ${R.length} machines have SD ${std(R.map((r) => r.lz)).toFixed(2)} (chance predicts 1.0); outside ${P.lk.id}, low earners are within the chance envelope.`, src: "machine_day.sum_bet_squared × game_math.payout_multiplier_variance", alt: "Variance formula could understate risk on jackpot games.", lim: "Assumes spins independent within a machine.", v: "verdict", p: "p-luck" },
      { id: "C5", claim: `Only ${R.filter((r) => r.flags.includes("weak")).length} machine(s) are truly weak (peer index < 90% with CI upper bound < 95%): ${R.filter((r) => r.flags.includes("weak")).map((r) => r.id + " " + F.pct(r.idx, 0)).join(", ")}.`, src: "Peer model, daily ratio-estimator CI", alt: "Bank-level effects inside a zone may explain it.", lim: "Daily SE ignores autocorrelation; CI may be slightly narrow.", v: "verdict", p: "p-fair" },
      { id: "C6", claim: `Closing walkway W-ENT-B40 (Mar 3–Apr 6) cut Back Forty coin-in per available hour by ${F.pct(-D.closure_did.did_effect, 0)} relative to the rest of the floor; it recovered after.`, src: "floor_walkways; prepared_daily_view; zone_traffic_hourly", alt: "Seasonal shift in who visits. Rejected: other zones rose in March.", lim: "One event; no randomisation.", v: "demand", p: "p-did" },
      { id: "C7", claim: `Downtime cost ≈ ${F.usd(R.reduce((a, r) => a + r.lost_theo, 0))} theo in H1 (${F.pct(R.reduce((a, r) => a + r.lost_theo, 0) / R.reduce((a, r) => a + r.theo, 0), 2)} of theo); Ridgeline accounts for the largest share.`, src: "machine_hour.available_seconds × per-machine hourly coin-in rate × (1 − RTP)", alt: "Broken machines might shed play to neighbours (then the true loss is smaller).", lim: "Upper bound: assumes no substitution.", v: "downtime", p: "p-dt-week" },
      { id: "C8", claim: "Repair wait rises from 0.1 h (2 techs) to 4.7 h when a 1-tech day shift has a no-show.", src: "operations ⨝ shift_roster", alt: "Fault mix could differ by shift.", lim: "Small n for no-show days (20 tickets).", v: "downtime", p: "p-dt-staff" },
      { id: "C9", claim: `Top 5% of tracked players produce ${F.pct(D.guest_conc["All tracked players"].top5, 0)} of tracked theo; ${F.pct(D.guest_conc["All tracked players"].ahead_share, 0)} finished ahead.`, src: "player_period summed per player", alt: "Uncarded play is invisible and may be less concentrated.", lim: "Tracked play only (~66% of coin-in).", v: "players", p: "p-lorenz" },
      { id: "C10", claim: `On 2025-05-01 points per comp dollar roughly halved in every tier; cost per 1,000 points rose $${L.cost_per_1000_pre.toFixed(0)} → $${L.cost_per_1000_post.toFixed(0)} while redemptions/day stayed ${L.redemptions_per_day_mar_apr} → ${L.redemptions_per_day_may_jun}.`, src: "loyalty_ledger (redeem)", alt: "Tier mix shift. Rejected: step appears within each tier on the same day.", lim: "Two months of post data; behaviour may lag.", v: "comps", p: "p-comp-ppd" },
      { id: "C11", claim: `Frozen forecast beats the constant baseline on the May–June holdout: MAE ${F.usd(Mo.scores[2].mae)} vs ${F.usd(Mo.scores[0].mae)}.`, src: "property_day, calendar_day, events (announced ≤ Apr 30)", alt: "Weekday mean alone does most of the work (MAE " + F.usd(Mo.scores[1].mae) + ").", lim: "Two-month holdout; summer seasonality unseen.", v: "model", p: "p-scores" },
      { id: "C12", claim: `The February tournament added ${F.usd(P.tourn.theo_lift)} ± ${F.usd(P.tourn.theo_se)} theo vs a refit forecast; Locals Week added ${F.usd(P.locals.theo_lift)} ± ${F.usd(P.locals.theo_se)}.`, src: "Model residuals during events", alt: "Tournament coincided with other weekend demand.", lim: "Tournament estimate is in-sample (refit without it).", v: "model", p: "p-lifts" },
    ];
  }
  const std = (a) => { const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  function vEvidence(main) {
    main.append(head("Appendix", "Claims and evidence", "Every claim on this dashboard, the table it comes from, the competing explanation we tested, and what could still be wrong. Each row links to its chart."));
    const p = panel("p-claims", "Claims & evidence", "", "Full-window figures (Jan 1 – Jun 30), independent of the period picker.");
    const tb = h(`<div class="tw"><table><thead><tr><th>#</th><th>Claim</th><th>Table / query</th><th>Alternative explanation</th><th>Limitation</th><th></th></tr></thead><tbody></tbody></table></div>`);
    claims().forEach((c) => { const tr = h(`<tr><td class="mono">${c.id}</td><td>${esc(c.claim)}</td><td class="mono" style="font-size:12px">${esc(c.src)}</td><td>${esc(c.alt)}</td><td>${esc(c.lim)}</td><td><button type="button" class="iconbtn">Show</button></td></tr>`); tr.querySelector("button").onclick = () => trace(c.v, c.p); tb.querySelector("tbody").append(tr); });
    p.querySelector(".body").append(tb); main.append(p);
    const gl = panel("p-glossary", "Glossary", "Every term the dashboard uses. The same text appears when you hover or tab to a dotted term.", "");
    gl.querySelector(".body").append(h(`<dl class="gloss">${Object.entries(GLOSS).filter(([k]) => !k.startsWith("v_")).map(([k, [t, d]]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join("")}${Object.keys(VERD).map((k) => `<div><dt>${chip(k)}</dt><dd>${esc(GLOSS["v_" + k][1])}</dd></div>`).join("")}</dl>`));
    main.append(gl);
    const g = h(`<div class="grid g2"></div>`); main.append(g);
    const m = panel("p-method", "Method in one screen", "", "");
    m.querySelector(".body").append(h(`<ul style="margin:0;padding-left:18px;font-size:13.5px;display:grid;gap:6px">
      <li><b>Money math.</b> Ratio of sums only. Off-floor rows excluded. Theo = Σ bet × (1 − RTP). Comp cost counted once (inside POS cogs). DST day uses scheduled_seconds (23 h).</li>
      <li><b>Luck.</b> Var(house win) = Σbet² × payout-multiplier variance, from machine_day and game_math. z = (win − theo) / σ.</li>
      <li><b>Leak.</b> Binomial test of payout-positive spins against the published hit probability. Hit rate needs days to diverge, hold needs months.</li>
      <li><b>Location and exposure.</b> Theo per available hour, compared with a zone + game model fit across all machines in the selected period.</li>
      <li><b>Downtime.</b> machine_hour available seconds × that machine's own coin-in per available hour at that clock hour.</li>
      <li><b>Model.</b> Log-linear weekday + known-event forecast, frozen Apr 30, scored on May–June vs constant and weekday-mean baselines.</li>
      <li><b>Thresholds.</b> Exposure < ${RULES.exposureShare * 100}% of days · hit |z| > ${RULES.hitZ} · peer < ${RULES.weakIdx * 100}% with CI < ${RULES.weakHi * 100}% · downtime > ${RULES.downShare * 100}% of theo · zone < ${RULES.zoneFactor * 100}% · luck z < ${RULES.luckZ}.</li></ul>`));
    g.append(m);
    const ai = panel("p-ai", "AI-use disclosure", "", "");
    ai.querySelector(".body").append(h(`<div style="font-size:13.5px;display:grid;gap:6px"><p>Claude (Anthropic) helped explore the data, write the DuckDB pipeline and this dashboard's code, and draft the write-up. Every number was produced by code in this repository and checked against the source tables.</p><p>The optional <b>Ask the Pit Boss</b> panel sends questions plus this page's claims table to Google Gemini through our server. It answers only from those claims and cites them. With no server it falls back to keyword search over the same claims.</p><p>No AI output is used as data.</p></div>`));
    g.append(ai);
  }

  // ================================================================ casino FX: icons, glossary, fanned deck, inspector, downtime clock, coins, dice
  const RM = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ICON = {
    dice: `<svg viewBox="0 0 60 60" aria-hidden="true"><rect x="6" y="6" width="48" height="48" rx="11" fill="#fff8e7" stroke="#141414" stroke-width="4"/><circle cx="19" cy="19" r="5" fill="#c8102e"/><circle cx="30" cy="30" r="5" fill="#141414"/><circle cx="41" cy="41" r="5" fill="#c8102e"/></svg>`,
    pin: `<svg viewBox="0 0 60 60" aria-hidden="true"><path d="M30 56C30 56 11 34 11 23a19 19 0 0 1 38 0c0 11-19 33-19 33z" fill="#eb6834" stroke="#141414" stroke-width="4"/><circle cx="30" cy="23" r="7" fill="#fff8e7" stroke="#141414" stroke-width="3"/></svg>`,
    drop: `<svg viewBox="0 0 60 60" aria-hidden="true"><path d="M30 5C30 5 11 30 11 39a19 19 0 0 0 38 0C49 30 30 5 30 5z" fill="#2ad4d9" stroke="#141414" stroke-width="4"/><path d="M20 40a10 10 0 0 0 8 10" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/></svg>`,
    cherry: `<svg viewBox="0 0 60 60" aria-hidden="true"><path d="M21 40C25 22 34 12 47 8M39 42C39 26 42 16 47 8" fill="none" stroke="#2f7d32" stroke-width="4" stroke-linecap="round"/><circle cx="19" cy="42" r="11" fill="#c8102e" stroke="#141414" stroke-width="4"/><circle cx="40" cy="44" r="11" fill="#c8102e" stroke="#141414" stroke-width="4"/><circle cx="15" cy="38" r="3" fill="#fff"/></svg>`,
    bar: `<svg viewBox="0 0 60 60" aria-hidden="true"><rect x="3" y="17" width="54" height="26" rx="6" fill="#141414" stroke="#f6b81e" stroke-width="2"/><text x="30" y="36" text-anchor="middle" font-family="Bungee, Impact, sans-serif" font-size="15" fill="#f6b81e">BAR</text></svg>`,
    coin: `<svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="24" fill="#f6b81e" stroke="#141414" stroke-width="4"/><circle cx="30" cy="30" r="16" fill="none" stroke="#c98a00" stroke-width="3"/><text x="30" y="38" text-anchor="middle" font-family="Bungee, Impact, sans-serif" font-size="21" fill="#c98a00">$</text></svg>`,
  };
  const SYM = { seven: [`<span class="seven">7</span>`, "clear"], dice: [ICON.dice, "unlucky"], pin: [ICON.pin, "bad spot"], drop: [ICON.drop, "leak!"], cherry: [ICON.cherry, ""], bar: [ICON.bar, ""], coin: [ICON.coin, ""] };
  const sym = (k) => `<div class="sym" data-k="${k}">${SYM[k][0]}<i>${SYM[k][1]}</i></div>`;
  const ADVICE = { exposure: "not enough floor time to judge", leak: "inspect the paytable, don't replace", weak: "a real replacement candidate", downtime: "fix the downtime first", location: "fix the traffic, not the machine", luck: "just unlucky, keep it", ok: "performs like its peers, keep it" };

  // ---------------------------------------------------------------- glossary: hover / focus blurbs
  const GLOSS = {
    coinin: ["Coin-in", "Total amount wagered, including winnings that were bet again. It measures how much play a machine got."],
    housewin: ["House win", "Coin-in minus payouts: what the casino actually kept. It swings with luck and can be negative on a day when players get lucky."],
    theo: ["Theo (theoretical win)", "What a machine should have earned with average luck: every bet × (1 − RTP). Ranking on theo removes luck from the comparison."],
    hold: ["Hold", "House win ÷ coin-in. Compare it with the configured hold (1 − RTP). A large gap that lasts for months is a red flag."],
    rtp: ["RTP (return to player)", "The share of wagers a game is designed to pay back over the long run, for example 92%."],
    luckz: ["Luck score (z)", "How far house win landed from theo, in standard deviations of normal slot swings. Between −2 and +2 is ordinary luck. Below −4 almost never happens by chance."],
    hitz: ["Payout fingerprint (hit z)", "Compares how often a machine pays anything with how often its published paytable says it should. Beyond ±5 cannot be chance and points to a paytable problem."],
    hitrate: ["Hit rate", "Share of spins that pay back anything at all. It barely moves with luck, so it reveals a wrong paytable quickly."],
    peer: ["Peer index", "Theo per working hour compared with identical games in the same zone. 100% is typical; 85% means the machine draws 15% less play than its twins."],
    availability: ["Availability", "Share of scheduled hours the machine was working, not broken, moved or being installed."],
    exposure: ["Days on floor", "How many days in the period the machine was installed. A machine installed in May had far less chance to earn."],
    location: ["Location factor", "How much a zone earns per working hour compared with the floor average, for the same game mix. Back Forty is about 67%."],
    downtime: ["Downtime", "Hours a machine was scheduled but not playable. Lost theo = those hours × what that machine normally earns at that hour of day."],
    occupancy: ["Occupancy", "Share of working hours with someone seated and playing."],
    contribution: ["Contribution", "House win minus the costs supplied in the data: lease, service contract, power and repairs. It is not full profit."],
    carded: ["Tracked (carded) play", "Play recorded on a loyalty card. Uncarded play is invisible at the player level and is about a third of coin-in."],
    comp: ["Comp", "A free drink, meal or other benefit bought with loyalty points. Its cost to the house is the item's cost, not its menu price."],
    reinvest: ["Reinvestment", "Comp cost ÷ theo: the share of expected win given back to players as comps."],
    points: ["Points per comp dollar", "How many loyalty points buy $1 of menu value. Fewer points means a more generous program."],
    liability: ["Point balance value", "Unredeemed points × what a point now costs the house. A hidden cost that appears if players start redeeming more."],
    mae: ["MAE (mean absolute error)", "The average size of the forecast's daily miss, in dollars. Lower is better."],
    holdout: ["Holdout", "Days kept aside, never used to fit the model, and used once to score it honestly. Here: May and June."],
    odds: ["Expected odds", "Expected theo ÷ cost over the 30-day horizon. 3 : 1 means about three dollars of theo for every dollar spent."],
    lift: ["Lift", "Actual coin-in minus what the frozen forecast expected without the event."],
    zone: ["Zone", "An area of the casino floor, such as Back Forty or Center Pit."],
    bank: ["Bank", "A row of machines that sit together inside a zone."],
    concentration: ["Concentration", "How much of the total comes from the top few players. Top 5% producing 52% means a small group drives most of the result."],
    period: ["Analysis period", "Every machine figure on the page is recomputed for these dates, using sums over the days, never averages of daily ratios."],
  };
  Object.keys(VERD).forEach((k) => { GLOSS["v_" + k] = [`Verdict: ${VERD[k].label}`, { exposure: "On the floor for under half the period, so its total says little about the machine.", leak: "Its payout fingerprint differs from the published paytable (|hit z| > 5) or its luck score is below −4. Inspect before replacing.", weak: "Theo per working hour is under 90% of identical games in the same zone, and the 95% interval stays under 95%. A genuine replacement candidate.", downtime: "Downtime cost more than 1.5% of its theo.", location: "It sits in a zone that earns under 80% of the floor average for the same games. Fix traffic, not the machine.", luck: "Its luck score is below −1.65: it earned less than theo mostly by chance.", ok: "Passes every test. It performs like its peers." }[k]]; });
  const KPI_TERMS = [[/back forty|location/i, "location"], [/floor all period|days/i, "exposure"], [/luck/i, "luckz"], [/leak|payout/i, "hitz"], [/downtime/i, "downtime"], [/coin-in|wagered/i, "coinin"], [/theo/i, "theo"], [/fault/i, "downtime"], [/paid back|net/i, "housewin"], [/ahead/i, "carded"], [/comp cost/i, "comp"], [/reinvest/i, "reinvest"], [/1,000 points/i, "points"], [/point balance/i, "liability"], [/on the table|kept/i, "odds"]];
  const kpiTerm = (label) => (KPI_TERMS.find(([re]) => re.test(label)) || [])[1];
  const term = (k, label) => `<span class="term" tabindex="0" data-term="${k}">${label ?? GLOSS[k][0]}</span>`;
  // wrap the first plain-text mention of key words in a head answer with a hoverable term
  const AUTO = [["theo", /\btheo\b/], ["coinin", /\bcoin-in\b/], ["hold", /\bhold\b/], ["peer", /\bper available hour\b/], ["mae", /\bMAE\b/], ["holdout", /\bholdout\b/], ["reinvest", /\breinvestment\b/], ["comp", /\bcomps?\b/], ["carded", /\btracked\b/i], ["downtime", /\bdown\b/]];
  function autoTerm(html) {
    const used = new Set();
    return html.split(/(<[^>]+>)/).map((seg) => {
      if (seg.startsWith("<")) return seg;
      AUTO.forEach(([k, re]) => { if (used.has(k)) return; const m = seg.match(re); if (m) { used.add(k); seg = seg.replace(re, `\u0000${k}\u0001${m[0]}\u0002`); } });
      return seg;
    }).join("").replace(/\u0000(\w+)\u0001([^\u0002]+)\u0002/g, (_, k, w) => term(k, w));
  }
  const tipHtml = (el) => { const k = el.dataset.term; if (k && GLOSS[k]) return `<div class="th">${esc(GLOSS[k][0])}</div><div class="blurb">${esc(GLOSS[k][1])}</div>`; if (el.dataset.tip) return `${el.dataset.tipTitle ? `<div class="th">${esc(el.dataset.tipTitle)}</div>` : ""}<div class="blurb">${esc(el.dataset.tip)}</div>`; return null; };
  const tipTarget = (e) => e.target.closest && e.target.closest("[data-term],[data-tip]");
  document.addEventListener("pointermove", (e) => { const el = tipTarget(e); if (!el) return; const t = tipHtml(el); if (t) C.showTip(t, e); });
  document.addEventListener("pointerout", (e) => { const el = tipTarget(e); if (el && !el.contains(e.relatedTarget)) C.hideTip(); });
  document.addEventListener("focusin", (e) => { const el = tipTarget(e); if (!el) return; const t = tipHtml(el); if (!t) return; const r = el.getBoundingClientRect(); C.showTip(t, { clientX: r.left, clientY: r.bottom }); });
  document.addEventListener("focusout", () => C.hideTip());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") C.hideTip(); });

  // ---------------------------------------------------------------- the manager's hand: a fanned, face-up deck in the hero
  const suspects = () => cur.rows.filter((r) => r.on > 0).sort((a, b) => a.hw - b.hw).slice(0, 10);
  const SUIT = { leak: "♦", location: "♠", luck: "♣", exposure: "♥", weak: "♥", downtime: "♠", ok: "♣" };
  const SUITC = { leak: "var(--red)", exposure: "var(--red)", weak: "var(--red)" };
  function renderFan() {
    const fan = $("#fan"); if (!fan) return;
    const list = suspects(), n = list.length;
    fan.innerHTML = list.map((r, k) => {
      const why = (r.tests.find((t) => t.k === r.verdict) || {}).text || "Passes every test.";
      const ang = (k - (n - 1) / 2) * 4.2;
      return `<button class="pcard${r.id === S.sel ? " sel" : ""}" type="button" role="listitem" style="--a:${ang}deg;--k:${k};--n:${n}" data-id="${r.id}"
        aria-label="Rank ${k + 1}: ${r.id}, ${esc(r.m.theme)} in ${esc(ZN[r.zone] || "off floor")}. Verdict ${VERD[r.verdict].label}. ${esc(why)} Press to inspect.">
        <span class="pc-corner"><b>${k + 1}</b><span style="color:${SUITC[r.verdict] || "#141414"}">${SUIT[r.verdict]}︎</span></span>
        <span class="pc-id">${r.id}</span>${chip(r.verdict)}
        <span class="pc-why">${esc(why)}</span>
        <span class="pc-foot">${esc(ZN[r.zone] || "off floor")} · ${esc(r.m.theme)}<br>won ${F.usd(r.hw)} · theo ${F.usd(r.theo)}</span></button>`;
    }).join("");
    const cards = [...fan.children];
    const lift = (i) => cards.forEach((c, k) => { c.classList.toggle("up", k === i); c.style.setProperty("--d", k - i); });
    fan.onpointermove = (e) => { const r = fan.getBoundingClientRect(); const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))); lift(i); };
    fan.onpointerleave = () => cards.forEach((c) => { c.classList.remove("up"); c.style.removeProperty("--d"); });
    cards.forEach((c, k) => { c.onfocus = () => lift(k); c.onclick = () => inspect(c.dataset.id, true); });
    fan.onkeydown = (e) => { const i = cards.indexOf(document.activeElement); if (i < 0) return; if (e.key === "ArrowRight") { cards[Math.min(n - 1, i + 1)].focus(); e.preventDefault(); } if (e.key === "ArrowLeft") { cards[Math.max(0, i - 1)].focus(); e.preventDefault(); } };
  }
  function inspect(id, scroll) {
    S.sel = id; store.set("sel", id); S.spin = true;
    if (view() !== "verdict") { location.hash = "verdict"; return; }
    $("#fan")?.querySelectorAll(".pcard").forEach((c) => c.classList.toggle("sel", c.dataset.id === id));
    if ($("#p-case")) caseFile(null, true); else render();
    if (scroll) setTimeout(() => $("#p-case")?.scrollIntoView({ behavior: RM() ? "auto" : "smooth", block: "start" }), 40);
  }
  $("#pullBtn").onclick = () => inspect(suspects()[0].id, true);

  // ---------------------------------------------------------------- the inspector: a slot machine whose reels are the three tests
  const REEL = [["luckz", "Luck", (r) => `z ${F.signed(r.lz, 2)}`, (r) => (r.flags.includes("luck") ? "dice" : "seven")],
    ["location", "Location", (r) => `${r.zf ? F.pct(r.zf, 0) : "–"} of floor`, (r) => (r.flags.includes("location") ? "pin" : "seven")],
    ["hitz", "Payout", (r) => `hit z ${F.signed(r.hz, 1)}`, (r) => (r.flags.includes("leak") ? "drop" : "seven")]];
  function inspectorHTML(r) {
    const list = suspects(), i = list.findIndex((x) => x.id === r.id);
    return `<div class="slot">
      <div class="cab">
        <div class="crown"><b>INSPECTOR<small>${i >= 0 ? `Manager's list · ${i + 1} of ${list.length}` : "Any machine · 3 tests"}</small></b></div>
        <div class="window" role="group" aria-label="Test results for ${r.id}">${REEL.map(([tk, name, val], k) => `<div class="reelbox"><div class="reel" id="reel${k}" aria-hidden="true"><div class="strip"></div></div><span class="reellabel term" tabindex="0" data-term="${tk}">${name}</span><span class="reelval">${val(r)}</span></div>`).join("")}</div>
        <div class="led" id="led" aria-live="polite"></div>
        <div class="deck"><button class="btn small cream" type="button" id="prevSuspect">‹ Previous</button><span class="paytable" data-tip-title="How to read the reels" data-tip="A 7 means the machine passes that test. Dice = unlucky (luck score below −1.65). Map pin = low-traffic zone (under 80% of floor). Droplet = payout differs from the published paytable (|hit z| over 5)." tabindex="0">How to read it</span><button class="btn small" type="button" id="nextSuspect">Next ›</button></div>
      </div>
      <button class="lever" id="lever" type="button" aria-label="Next machine on the manager's list"><span class="base"></span><span class="arm"><span class="ball"></span></span></button>
    </div>`;
  }
  let spinning = false;
  function mountInspector(host, r, spin) {
    host.innerHTML = inspectorHTML(r);
    const led = $("#led", host);
    const setLed = () => { led.innerHTML = `<span class="big">${r.id} · ${esc(r.m.theme)}</span><span class="verdict">${VERD[r.verdict].label}: ${ADVICE[r.verdict]}</span><span class="count">won ${F.usd(r.hw)} vs theo ${F.usd(r.theo)} · on floor ${r.on}/${r.days} days</span>`; };
    const targets = REEL.map((x) => x[3](r));
    const doSpin = spin && !RM();
    let done = 0;
    targets.forEach((t, k) => {
      const reel = $(`#reel${k}`, host), strip = $(".strip", reel);
      if (!doSpin) { strip.innerHTML = sym(t); if (t !== "seven") reel.classList.add("flagged"); return; }
      const fill = ["cherry", "bar", "coin", "seven"]; const keys = []; for (let i = 0; i < 10 + k * 5; i++) keys.push(fill[(Math.random() * fill.length) | 0]); keys.push(t);
      strip.innerHTML = keys.map(sym).join(""); const H = reel.clientHeight || 118;
      strip.style.transform = "translateY(0)"; void strip.offsetHeight;
      const dur = 0.9 + k * 0.4; strip.style.transition = `transform ${dur}s cubic-bezier(.12,.8,.22,1.05)`; strip.style.transform = `translateY(${-(keys.length - 1) * H}px)`;
      setTimeout(() => { if (t !== "seven") reel.classList.add("flagged", "win"); if (++done === 3) { setLed(); spinning = false; if (r.verdict === "leak") coinRain(120); } }, dur * 1000 + 30);
    });
    if (doSpin) { spinning = true; led.innerHTML = `<span class="big">Testing ${r.id}…</span><span>luck · location · payout</span>`; } else setLed();
    const step = (d) => { if (spinning) return; const list = suspects(); const i = list.findIndex((x) => x.id === r.id); const nx = list[((i < 0 ? -1 : i) + d + list.length) % list.length]; const lv = $("#lever", host); lv.classList.add("pulled"); setTimeout(() => lv.classList.remove("pulled"), 380); inspect(nx.id, false); };
    $("#lever", host).onclick = () => step(1); $("#nextSuspect", host).onclick = () => step(1); $("#prevSuspect", host).onclick = () => step(-1);
  }
  // ---------------------------------------------------------------- downtime clock: a 24-pocket wheel; the ball lands on the costliest hour
  function downtimeClock(host) {
    const DAYS = ["All days", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let dsel = store.get("clockDay", "All days"), ballRot = 0;
    const shiftOf = (hh) => (hh >= 5 && hh < 13 ? ["Day", "1–2 techs planned"] : hh >= 13 && hh < 21 ? ["Swing", "2 techs planned"] : ["Grave", "1 tech"]);
    const hl = (hh) => `${String(hh).padStart(2, "0")}:00`;
    host.innerHTML = `<div class="chips" role="group" aria-label="Day of week">${DAYS.map((d) => `<button class="chip" type="button" data-d="${d}" aria-pressed="${d === dsel}">${d}</button>`).join("")}</div>
      <div class="clockrow"><div class="clockwrap"></div><div class="clockside" aria-live="polite"></div></div>
      <details class="tablewrap"><summary>Show the hourly numbers</summary><div class="tw"><table><thead><tr><th>Hour</th><th>Shift</th><th class="n">Machine-hours down</th><th class="n">Lost theo</th></tr></thead><tbody></tbody></table></div></details>`;
    const draw = () => {
      const vals = Array(24).fill(0), hrs = Array(24).fill(0);
      D.downtime_heat.forEach((c) => { if (dsel === "All days" || DAYS[c.dow + 1] === dsel) { vals[c.hour] += c.theo; hrs[c.hour] += c.h; } });
      const mx = Math.max(...vals) || 1, peak = vals.indexOf(Math.max(...vals)), tot = vals.reduce((a, b) => a + b, 0);
      const C0 = 170, R1 = 70, R2 = 128, R3 = 142;
      const P = (a, r) => `${(C0 + r * Math.sin(a)).toFixed(1)},${(C0 - r * Math.cos(a)).toFixed(1)}`;
      const arc = (h0, h1, ri, ro) => { const a0 = (h0 / 24) * 2 * Math.PI, a1 = (h1 / 24) * 2 * Math.PI, lg = h1 - h0 > 12 ? 1 : 0; return `M${P(a0, ri)}L${P(a0, ro)}A${ro},${ro} 0 ${lg} 1 ${P(a1, ro)}L${P(a1, ri)}A${ri},${ri} 0 ${lg} 0 ${P(a0, ri)}Z`; };
      const pockets = vals.map((v, hh) => { const t = v / mx, a = ((hh + 0.5) / 24) * 2 * Math.PI, [sx, sy] = P(a, (R1 + R2) / 2).split(","); const [sn, st] = shiftOf(hh);
        return `<path class="pocket" d="${arc(hh, hh + 1, R1, R2)}" style="fill:var(--red);fill-opacity:${(0.08 + 0.92 * t).toFixed(2)}" data-h="${hh}" tabindex="0" data-tip-title="${hl(hh)}–${hl((hh + 1) % 24)} · ${sn} shift" data-tip="${F.usd(v)} of theo lost (${F.pct(v / tot, 1)} of the day's total), ${F.num(hrs[hh], 0)} machine-hours down. ${sn} shift: ${st}."></path>
          <text x="${sx}" y="${+sy + 4}" text-anchor="middle" class="ph" style="fill:${t > 0.55 ? "#fff8e7" : "#141414"}">${hh}</text>`; }).join("");
      const shifts = [[5, 13, "var(--gold)", "DAY"], [13, 21, "var(--chip-blue)", "SWING"], [21, 29, "var(--chip-purple)", "GRAVE"]].map(([a, b, c, n]) => { const m = (((a + b) / 2) / 24) * 2 * Math.PI; const [lx, ly] = P(m, R3 + 14).split(","); return `<path d="${arc(a, b, R2 + 4, R3)}" style="fill:${c}" stroke="#141414" stroke-width="2"/><text x="${lx}" y="${+ly + 4}" text-anchor="middle" class="sl">${n}</text>`; }).join("");
      const target = ((peak + 0.5) / 24) * 360; ballRot = ballRot + 720 + ((((target - ballRot) % 360) + 360) % 360);
      $(".clockwrap", host).innerHTML = `<svg viewBox="0 0 340 340" class="clock" role="img" aria-label="Lost theo by hour of day; the ball marks the costliest hour, ${hl(peak)}">
        <circle cx="${C0}" cy="${C0}" r="${R3 + 22}" fill="#7a3d12" stroke="#141414" stroke-width="4"/>${shifts}${pockets}
        <circle cx="${C0}" cy="${C0}" r="${R1 - 4}" fill="var(--felt)" stroke="#141414" stroke-width="3"/>
        <text x="${C0}" y="${C0 - 10}" text-anchor="middle" class="cbig">${hl(peak)}</text><text x="${C0}" y="${C0 + 10}" text-anchor="middle" class="csm">costliest hour</text><text x="${C0}" y="${C0 + 26}" text-anchor="middle" class="csm">${F.usd(vals[peak])} theo</text>
        <g class="ballg" style="transform-origin:${C0}px ${C0}px;transform:rotate(${ballRot - 720}deg)"><circle cx="${C0}" cy="${C0 - R2 + 12}" r="8" fill="#fff8e7" stroke="#141414" stroke-width="2.5"/></g></svg>`;
      const g = $(".ballg", host); requestAnimationFrame(() => requestAnimationFrame(() => { g.style.transition = RM() ? "none" : "transform 1.8s cubic-bezier(.15,.75,.2,1)"; g.style.transform = `rotate(${ballRot}deg)`; }));
      const night = [20, 21, 22, 23].reduce((a, hh) => a + vals[hh], 0);
      $(".clockside", host).innerHTML = `<p style="font-size:15px">On <b>${dsel === "All days" ? "an average day" : dsel + "days"}</b>, downtime costs the most at <b>${hl(peak)}</b>. The four hours from 20:00 to midnight carry <b>${F.pct(night / tot, 0)}</b> of the lost theo: play is heavy and the grave shift starts with a single technician.</p>
        <p class="muted" style="font-size:13.5px">Each pocket is one hour of the local clock (0 = midnight); darker red means more theo lost to broken machines. The outer ring shows the technician shifts. Hover or tab to a pocket for its numbers.</p>`;
      $("tbody", host).innerHTML = vals.map((v, hh) => `<tr><td>${hl(hh)}</td><td>${shiftOf(hh)[0]}</td><td class="n">${F.num(hrs[hh], 0)}</td><td class="n">${F.usd(v)}</td></tr>`).join("");
    };
    host.querySelectorAll("[data-d]").forEach((b) => b.onclick = () => { dsel = b.dataset.d; store.set("clockDay", dsel); host.querySelectorAll("[data-d]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); draw(); });
    draw();
  }

  // coin + chip rain on a full-screen canvas
  const cv = $("#coins"), cx = cv.getContext("2d"); let coins = [], raf = 0;
  function coinRain(n = 80) {
    if (RM()) return; const dpr = devicePixelRatio || 1; cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    for (let i = 0; i < n; i++) coins.push({ x: Math.random() * cv.width, y: -Math.random() * cv.height * 0.6 - 40, vx: (Math.random() - 0.5) * 3 * dpr, vy: (1 + Math.random() * 4) * dpr, r: (9 + Math.random() * 11) * dpr, a: Math.random() * 6.28, va: 0.08 + Math.random() * 0.2, chip: Math.random() < 0.28, c: ["#c8102e", "#141414", "#1f5fae", "#11867f"][i % 4], dpr });
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    const W = cv.width, H = cv.height; cx.clearRect(0, 0, W, H);
    coins.forEach((c) => {
      c.vy += 0.22 * c.dpr; c.x += c.vx; c.y += c.vy; c.a += c.va; const sx = Math.max(0.12, Math.abs(Math.cos(c.a)));
      cx.save(); cx.translate(c.x, c.y); cx.scale(sx, 1); cx.lineWidth = 2.5 * c.dpr; cx.strokeStyle = "#141414";
      if (!c.chip) {
        cx.fillStyle = "#f6b81e"; cx.beginPath(); cx.arc(0, 0, c.r, 0, 7); cx.fill(); cx.stroke();
        cx.strokeStyle = "#c98a00"; cx.beginPath(); cx.arc(0, 0, c.r * 0.66, 0, 7); cx.stroke();
        if (sx > 0.5) { cx.fillStyle = "#b27700"; cx.font = `${c.r * 1.05}px Bungee, Impact, sans-serif`; cx.textAlign = "center"; cx.textBaseline = "middle"; cx.fillText("$", 0, c.r * 0.06); }
      } else {
        cx.fillStyle = c.c; cx.beginPath(); cx.arc(0, 0, c.r, 0, 7); cx.fill(); cx.stroke();
        cx.strokeStyle = "#fff8e7"; cx.lineWidth = 3.5 * c.dpr; cx.setLineDash([c.r * 0.45, c.r * 0.45]); cx.beginPath(); cx.arc(0, 0, c.r * 0.8, 0, 7); cx.stroke();
      }
      cx.restore();
    });
    coins = coins.filter((c) => c.y < H + 60);
    if (coins.length) raf = requestAnimationFrame(tick); else { cx.clearRect(0, 0, W, H); raf = 0; }
  }

  // dice: one random "chance-only" floor of the same size
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const DIE = (n) => { const P = { 1: [[30, 30]], 2: [[18, 18], [42, 42]], 3: [[17, 17], [30, 30], [43, 43]], 4: [[18, 18], [42, 18], [18, 42], [42, 42]], 5: [[17, 17], [43, 17], [30, 30], [17, 43], [43, 43]], 6: [[18, 16], [42, 16], [18, 30], [42, 30], [18, 44], [42, 44]] }[n]; return `<svg viewBox="0 0 60 60" class="die" aria-hidden="true"><rect x="5" y="5" width="50" height="50" rx="11" fill="#fff8e7" stroke="#141414" stroke-width="4"/>${P.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5" fill="${n === 1 ? "#c8102e" : "#141414"}"/>`).join("")}</svg>`; };

  // ================================================================ Ask the Pit Boss
  const askbtn = $("#askbtn"), box = $("#askbox"), log = $("#asklog");
  askbtn.onclick = () => { box.hidden = !box.hidden; askbtn.setAttribute("aria-expanded", String(!box.hidden)); if (!box.hidden && !log.children.length) greet(); if (!box.hidden) $("#askin").focus(); };
  function greet() {
    log.append(h(`<div class="msg bot">I answer from this dashboard's evidence. Try one:</div>`));
    const sg = h(`<div class="sugg"></div>`);
    ["Why is M-1158 flagged?", "Should we replace the bottom 10?", "What happened to comps in May?", "How was the model validated?"].forEach((q) => { const b = h(`<button type="button">${q}</button>`); b.onclick = () => ask(q); sg.append(b); });
    log.append(sg);
  }
  $("#askform").onsubmit = (e) => { e.preventDefault(); const q = $("#askin").value.trim(); if (q) ask(q); $("#askin").value = ""; };
  async function ask(q) {
    log.append(h(`<div class="msg me">${esc(q)}</div>`));
    const pending = h(`<div class="msg bot muted">Checking the evidence…</div>`); log.append(pending); log.scrollTop = log.scrollHeight;
    const cl = claims();
    const mm = q.match(/M-\d{4}/i); const mach = mm ? FULL.rows[midx[mm[0].toUpperCase()]] : null;
    const context = { period: periodLabel(), claims: cl.map(({ id, claim, src, alt, lim }) => ({ id, claim, src, alt, lim })), machine: mach ? { id: mach.id, verdict: mach.verdict, tests: mach.tests.map((t) => t.name + ": " + t.text + (t.flag ? " [FLAG]" : "")) } : null };
    let ans = null, cites = [], mode = "";
    if (llmOn) try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q, context }), signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) { const j = await r.json(); ans = j.answer; cites = j.cites || []; mode = j.provider || "LLM"; }
    } catch { }
    if (!ans) {
      mode = "offline keyword match";
      if (mach) { ans = `${mach.id} (${mach.m.theme}, ${ZN[mach.zone] || "off floor"}): verdict ${VERD[mach.verdict].label}. ` + mach.tests.filter((t) => t.flag).map((t) => t.text).join(" ") || "It passes every test."; }
      else {
        const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
        const scored = cl.map((c) => ({ c, s: words.reduce((a, w) => a + ((c.claim + " " + c.src + " " + c.alt).toLowerCase().includes(w) ? 1 : 0), 0) })).sort((a, b) => b.s - a.s);
        const top = scored.filter((x) => x.s > 0).slice(0, 2);
        ans = top.length ? top.map((x) => x.c.claim).join(" ") : "I couldn't match that to a claim. Try asking about a machine ID, comps, downtime, the model, or the budget.";
        cites = top.map((x) => x.c.id);
      }
    }
    pending.remove();
    const msg = h(`<div class="msg bot"></div>`); msg.textContent = ans;
    msg.append(h(`<div class="cite">${cites.length ? "Evidence: " + cites.join(", ") + " · " : ""}${esc(mode)}</div>`));
    cites.forEach((cid) => { const c = cl.find((x) => x.id === cid); if (c) { const b = h(`<button type="button" class="iconbtn" style="margin-top:4px;font-size:11.5px">Show ${cid}</button>`); b.onclick = () => trace(c.v, c.p); msg.append(b); } });
    log.append(msg); log.scrollTop = log.scrollHeight;
  }
  let llmOn = false;
  fetch("/api/health").then((r) => r.ok ? r.json() : null).then((j) => { if (j && j.llm) llmOn = true; if (j && j.llm) $("#askmode").textContent = `Answers by ${j.llm}, grounded in the evidence table.`; }).catch(() => { });

  $("#buildinfo").textContent = ` Data: ${D.meta.window}.`;
  render();
})();
