/* 标普500场内基金 · 真实溢价率 —— 全部数值在浏览器端实时计算，无服务端参与 */
(function () {
  "use strict";

  /* 仅跟踪标普500指数基金（剔除信息科技/生物科技/医疗保健等衍生品） */
  const FUNDS = [
    { code: "513500", name: "标普500ETF博时", company: "博时基金", market: "SH", secid: "1.513500", tk: "sh513500" },
    { code: "159612", name: "标普500ETF国泰", company: "国泰基金", market: "SZ", secid: "0.159612", tk: "sz159612" },
    { code: "159655", name: "标普500ETF华夏", company: "华夏基金", market: "SZ", secid: "0.159655", tk: "sz159655" },
    { code: "513650", name: "标普500ETF南方", company: "南方基金", market: "SH", secid: "1.513650", tk: "sh513650" },
    { code: "161125", name: "标普500LOF易方达", company: "易方达基金", market: "SZ", secid: "0.161125", tk: "sz161125" },
  ];
  const DATA_URL = "data/sp500.json";
  const IV = { quote: 3000, market: 10000, snap: 60000, nav: 300000, daily: 300000 };
  const CLAMP_FX = 0.005; // 汇率变动 sanity 保护

  const state = {
    quotes: {},        // code -> {price,chg_pct,amount,time,source}
    nav: {},           // code -> {nav,nav_date}
    es: null, fx: null,               // 实时报价 {price,chg_pct,time}
    esDaily: {}, fxDaily: {},        // date(ET) -> close
    data: null,                        // data/sp500.json 快照
    position: 0.95,
    src: { quote: null, fut: null, fx: null, nav: null, snap: null },
  };

  /* ---------- 工具 ---------- */
  const $ = (id) => document.getElementById(id);
  const num = (v) => (v === null || v === undefined || v === "" || isNaN(+v) ? null : +v);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, d = 4) => (v == null ? "—" : (+v).toFixed(d));
  const pct = (v, d = 2) => (v == null ? "—" : (v >= 0 ? "+" : "") + (+v).toFixed(d) + "%");
  const wan = (v) => (v == null ? "—" : (+v / 1e4).toLocaleString("zh-CN", { maximumFractionDigits: 0 }) + "万");
  const signCls = (v) => (v == null ? "" : v > 0 ? "up" : v < 0 ? "down" : "");

  function bjParts(d = new Date()) {
    const p = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    }).formatToParts(d).reduce((o, x) => ((o[x.type] = x.value), o), {});
    return p;
  }
  function nowBJT() {
    const p = bjParts();
    return {
      time: `${p.hour}:${p.minute}:${p.second}`,
      date: `${p.year}-${p.month}-${p.day}`,
      hour: +p.hour + (+p.minute) / 60,
      weekday: p.weekday,
    };
  }
  function isTrading() {
    const n = nowBJT();
    if (["周六", "周日"].includes(n.weekday)) return false;
    const h = n.hour;
    return (h >= 9.25 && h < 11.5) || (h >= 13 && h < 15);
  }
  async function getJSON(url, timeout = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }
  async function getText(url, timeout = 12000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } finally {
      clearTimeout(t);
    }
  }
  const setChip = (id, text, kind) => {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = "chip" + (kind ? " " + kind : "");
  };

  /* ---------- 行情：东财 push2 优先，腾讯兜底（均支持跨域） ---------- */
  async function fetchQuotes() {
    const secids = FUNDS.map((f) => f.secid).join(",");
    const url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=" + secids +
      "&fields=f1,f2,f3,f4,f12,f13,f14,f18,f48,f124";
    let ok = false;
    try {
      const js = await getJSON(url);
      if (js && js.data && js.data.diff) {
        for (const d of js.data.diff) {
          const code = String(d.f12 || "");
          state.quotes[code] = {
            price: num(d.f2), chg_pct: (num(d.f4) || 0) / 100, amount: num(d.f48),
            time: d.f124 ? bjFromUnix(d.f124) : null, source: "东财",
          };
          ok = true;
        }
      }
    } catch (e) { /* 走腾讯 */ }
    if (!ok) {
      try {
        const txt = await getText("https://qt.gtimg.cn/q=" + FUNDS.map((f) => f.tk).join(","));
        const re = /v_(s[hz]\w+)="([^"]*)"/g;
        let m;
        while ((m = re.exec(txt))) {
          const code = m[1].slice(2);
          const a = m[2].split("~");
          if (a.length < 33 || !a[3]) continue;
          state.quotes[code] = {
            price: num(a[3]), chg_pct: num(a[32]),
            amount: num(a[37]) ? num(a[37]) * 1e4 : null,
            time: tencentTime(a[30]), source: "腾讯",
          };
          ok = true;
        }
      } catch (e) { /* 两个都失败，沿用旧值 */ }
    }
    state.src.quote = ok ? "live" : (Object.keys(state.quotes).length ? "snap" : "down");
    setChip("src-quote", "行情 " + (ok ? (state.quotes[FUNDS[0].code] || {}).source || "实时" : "中断"), state.src.quote);
  }
  function bjFromUnix(ts) {
    try { return new Date(+ts * 1000).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); }
    catch (e) { return null; }
  }
  function tencentTime(s) {
    s = String(s || "").replace(/\D/g, "");
    return s.length === 14 ? `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}` : null;
  }

  /* ---------- 期货 / 汇率：Yahoo Finance ---------- */
  async function yahoo(sym, range, interval) {
    return getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}`);
  }
  async function fetchMarket() {
    for (const [sym, key] of [["ES=F", "es"], ["CNY=X", "fx"]]) {
      try {
        const r = await yahoo(sym, "1d", "1m");
        const meta = r.chart.result[0].meta;
        state[key] = { price: num(meta.regularMarketPrice), chg_pct: num(meta.regularMarketChangePercent), time: bjFromUnix(meta.regularMarketTime) };
        state.src[key === "es" ? "fut" : "fx"] = "live";
      } catch (e) {
        state.src[key === "es" ? "fut" : "fx"] = "down";
      }
    }
    setChip("src-fut", "期货 " + (state.es ? "实时" : "中断"), state.src.fut);
    setChip("src-fx", "汇率 " + (state.fx ? "实时" : "中断"), state.src.fx);
  }
  async function fetchDaily() {
    for (const [sym, key] of [["ES=F", "esDaily"], ["CNY=X", "fxDaily"]]) {
      try {
        const r = await yahoo(sym, "5d", "1d");
        const res = r.chart.result[0];
        const daily = {};
        (res.timestamp || []).forEach((t, i) => {
          const c = res.indicators.quote[0].close[i];
          if (c == null) return;
          daily[etDate(t)] = c;
        });
        state[key] = daily;
      } catch (e) { /* 保留旧值 */ }
    }
  }
  function etDate(ts) { // Yahoo 日线按美东时间计日
    const d = new Date(+ts * 1000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
  }

  /* ---------- 净值：天天基金移动端（跨域） ---------- */
  async function fetchNav() {
    let ok = 0;
    for (const f of FUNDS) {
      try {
        const js = await getJSON(
          "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=" + f.code +
          "&pageIndex=1&pageSize=2&deviceid=1&plat=Android&product=EFund&version=6.2.8&appType=ttjj");
        if (js && js.Datas && js.Datas[0]) {
          state.nav[f.code] = { nav: num(js.Datas[0].DWJZ), nav_date: js.Datas[0].FSRQ };
          ok++;
        }
      } catch (e) { /* 单只失败不阻塞 */ }
    }
    state.src.nav = ok === FUNDS.length ? "live" : ok > 0 ? "snap" : "down";
    setChip("src-nav", "净值 " + (ok === FUNDS.length ? "实时" : ok > 0 ? "部分" : "中断"), state.src.nav);
  }

  /* ---------- 快照：data/sp500.json（Actions 每5分钟生成，含 HaoETF 对照） ---------- */
  async function fetchSnap() {
    try {
      const js = await getJSON(DATA_URL + "?_=" + Date.now());
      state.data = js;
      state.src.snap = "live";
      const gen = js.generated_at ? js.generated_at.replace("T", " ").replace("+08:00", "") : "";
      const ageMin = Math.round((Date.now() - new Date(js.generated_at).getTime()) / 60000);
      setChip("src-snap", `快照 ${gen.slice(5, 16)}（${ageMin}分钟前）`, ageMin > 30 ? "snap" : "live");
    } catch (e) {
      state.src.snap = "down";
      setChip("src-snap", "快照 读取失败", "down");
    }
  }

  /* ---------- 计算：真实溢价率（与 scripts/update_data.py 同一公式） ---------- */
  function pickRef(daily, navDate) {
    if (!daily || !navDate) return null;
    if (daily[navDate] != null) return daily[navDate];
    const earlier = Object.keys(daily).filter((d) => d < navDate).sort();
    return earlier.length ? daily[earlier[earlier.length - 1]] : null;
  }
  function fundCalc(f) {
    const snap = (state.data && state.data.funds || []).find((x) => x.code === f.code) || {};
    const q = state.quotes[f.code] || {};
    const navInfo = state.nav[f.code] || (snap.nav ? { nav: snap.nav, nav_date: snap.nav_date } : null);
    const nav = num(navInfo && navInfo.nav);
    const navDate = navInfo && navInfo.nav_date;
    const price = num(q.price != null ? q.price : snap.price);
    const esPrice = state.es ? state.es.price : num(state.data && state.data.market.es_futures.price);
    const esSnap = !state.es;
    const fxPrice = state.fx ? state.fx.price : num(state.data && state.data.market.fx.price);
    const fxSnap = !state.fx;
    let esRef = num(snap.es_ref);
    if (esRef == null) esRef = pickRef(state.esDaily, navDate);
    let fxRef = num(snap.fx_ref);
    if (fxRef == null) fxRef = pickRef(state.fxDaily, navDate);
    const hao = snap.haoetf || null;

    let estNav = null, premium = null, rIdx = 0, rFx = 0;
    if (nav && price && esPrice && esRef) {
      rIdx = esPrice / esRef - 1;
      if (fxPrice && fxRef) rFx = Math.max(-CLAMP_FX, Math.min(CLAMP_FX, fxPrice / fxRef - 1));
      estNav = nav * (1 + rIdx * state.position) * (1 + rFx);
      premium = (price / estNav - 1) * 100;
    }
    return {
      f, price, chg_pct: num(q.chg_pct != null ? q.chg_pct : snap.chg_pct),
      amount: num(q.amount != null ? q.amount : snap.amount),
      time: q.time || snap.quote_time || null,
      quoteSnap: q.price == null,
      nav, navDate, navSnap: !state.nav[f.code],
      estNav, premium, naive: nav && price ? (price / nav - 1) * 100 : null,
      hao, quota: hao && hao.quota, esSnap, fxSnap, rIdx: rIdx * 100, rFx: rFx * 100,
    };
  }

  /* ---------- 渲染 ---------- */
  function renderClock() {
    const n = nowBJT();
    $("bj-time").textContent = n.time;
    const trading = isTrading();
    const st = $("market-status");
    st.textContent = trading ? "A股交易中" : "休市 / 夜盘";
    st.className = "chip " + (trading ? "live" : "");
  }
  function renderCards() {
    const es = state.es || (state.data && state.data.market.es_futures) || null;
    const spx = state.data && state.data.market.spx_spot;
    const fx = state.fx || (state.data && state.data.market.fx) || null;
    $("es-price").textContent = es && es.price != null ? fmt(es.price, 2) : "—";
    $("es-sub").innerHTML = es && es.chg_pct != null
      ? `<span class="${signCls(es.chg_pct)}">${pct(es.chg_pct)}</span>${es.time ? " · " + esc(es.time) : ""}${state.es ? "" : "（快照）"}`
      : "等待数据";
    $("es-tag").textContent = state.es ? "实时" : "快照";
    $("spx-price").textContent = spx && spx.price != null ? fmt(spx.price, 2) : "—";
    $("spx-sub").textContent = spx && spx.date ? "收盘日 " + esc(spx.date) : "—";
    $("fx-price").textContent = fx && fx.price != null ? fmt(fx.price, 4) : "—";
    $("fx-sub").innerHTML = fx && fx.time
      ? `<span class="muted">${esc(fx.time)}${state.fx ? "" : "（快照）"}</span>` : "等待数据";
    $("snap-time").textContent = state.data && state.data.generated_at
      ? state.data.generated_at.replace("T", " ").slice(5, 16) : "—";
    $("snap-sub").textContent = state.data && state.data.funds
      ? `${state.data.funds.length} 只 · 仅标普500指数` : "未加载";
  }
  function premClass(p) {
    if (p == null) return "";
    if (p >= 5) return "prem-hot";
    if (p >= 2) return "prem-warm";
    if (p <= -1) return "prem-cheap";
    return "";
  }
  function renderTable() {
    const rows = FUNDS.map(fundCalc).sort((a, b) =>
      (b.premium == null ? -1e9 : b.premium) - (a.premium == null ? -1e9 : a.premium));
    const tb = $("fund-rows");
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="8" class="loading">数据加载中…</td></tr>`; return; }
    tb.innerHTML = rows.map((r) => {
      const f = r.f;
      const haoTxt = r.hao && r.hao.premium_pct != null
        ? `<span class="price-main">${pct(r.hao.premium_pct)}</span>
           <span class="price-sub">T-1口径 ${r.hao.t1_premium_pct != null ? pct(r.hao.t1_premium_pct) : "—"}</span>`
        : `<span class="muted">—</span>`;
      const premTip = r.premium == null
        ? `<span class="muted">缺估值基准</span><span class="prem-sm">净值/期货数据不全</span>`
        : `<span class="prem">${pct(r.premium)}</span>
           <span class="prem-sm">Δ期货 ${pct(r.rIdx)} · Δ汇率 ${pct(r.rFx)}</span>`;
      return `<tr class="${premClass(r.premium)}">
        <td>
          <div class="fund-name">${esc(f.name)} <span class="muted" style="font-weight:400">${f.market === "SH" ? "沪" : "深"}${f.code}</span></div>
          <div class="fund-meta">${esc(f.company)} · ${r.quota ? "申购：" + esc(r.quota) : "申购状态—"}</div>
        </td>
        <td>
          <div class="price-main">${fmt(r.price, 3)}</div>
          <div class="price-sub ${signCls(r.chg_pct)}">${pct(r.chg_pct)}${r.quoteSnap ? " · 快照" : ""}</div>
        </td>
        <td>
          <div class="price-main">${fmt(r.nav, 4)}</div>
          <div class="price-sub">${r.navDate ? esc(r.navDate.slice(5)) : "—"}${r.navSnap ? " · 快照" : ""}</div>
        </td>
        <td>
          <div class="price-main">${fmt(r.estNav, 4)}</div>
          <div class="price-sub">仓位 ${Math.round(state.position * 100)}%</div>
        </td>
        <td class="col-prem">${premTip}</td>
        <td class="muted">${r.naive != null ? pct(r.naive) : "—"}</td>
        <td>${haoTxt}</td>
        <td class="muted">${wan(r.amount)}</td>
      </tr>`;
    }).join("");
  }
  function render() { renderClock(); renderCards(); renderTable(); }

  /* ---------- 启动 ---------- */
  async function refreshAll() {
    await Promise.all([fetchQuotes(), fetchMarket(), fetchSnap()]);
    fetchNav(); fetchDaily();
    render();
  }
  function init() {
    const slider = $("pos-slider");
    slider.addEventListener("input", () => {
      state.position = +slider.value / 100;
      $("pos-value").textContent = slider.value + "%";
      renderTable();
    });
    refreshAll();
    setInterval(fetchQuotes, IV.quote);
    setInterval(fetchMarket, IV.market);
    setInterval(fetchSnap, IV.snap);
    setInterval(fetchNav, IV.nav);
    setInterval(fetchDaily, IV.daily);
    setInterval(render, 1000); // 时钟与红绿状态
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
