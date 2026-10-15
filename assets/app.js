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
    quotes: {},        // code -> {price,chg_pct,amount,time,source,prev_close}
    nav: {},           // code -> {nav,nav_date}
    es: null, fx: null,               // 实时报价 {price,chg_pct,prev_close,time,source}
    spxKline: {},       // date(美东) -> close，来自东财日线
    data: null,                        // data/sp500.json 快照
    position: 0.95,
    quoteAt: 0, esAt: 0, navAt: 0,     // 各源最近成功时间(ms)
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
            prev_close: num(d.f18),
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
            prev_close: num(a[4]),
            time: tencentTime(a[30]), source: "腾讯",
          };
          ok = true;
        }
      } catch (e) { /* 两个都失败，沿用旧值 */ }
    }
    if (ok) state.quoteAt = Date.now();
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

  /* ---------- 期货 / 汇率：ES 期货腾讯优先（国内直连、CORS *），Yahoo 兜底；汇率 Yahoo ---------- */
  async function yahoo(sym, range, interval) {
    return getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}`);
  }
  async function fetchEs() {
    try {
      const txt = await getText("https://qt.gtimg.cn/q=hf_ES");
      const m = /v_hf_ES="([^"]*)"/.exec(txt);
      if (m) {
        const a = m[1].split(",");
        if (a.length >= 8 && a[0]) {
          state.es = {
            price: num(a[0]), chg_pct: num(a[1]), prev_close: num(a[7]),
            time: a[12] ? `${a[12].slice(5)} ${a[6]}` : a[6], source: "腾讯",
          };
          state.src.fut = "live";
          return;
        }
      }
    } catch (e) { /* 走 Yahoo 兜底 */ }
    try {
      const r = await yahoo("ES=F", "1d", "1m");
      const meta = r.chart.result[0].meta;
      state.es = {
        price: num(meta.regularMarketPrice), chg_pct: num(meta.regularMarketChangePercent),
        prev_close: num(meta.chartPreviousClose || meta.previousClose),
        time: bjFromUnix(meta.regularMarketTime), source: "Yahoo",
      };
      state.src.fut = "live";
    } catch (e) {
      state.src.fut = "down";
    }
    if (state.es) state.esAt = Date.now();
  }
  async function fetchMarket() {
    await fetchEs();
    try {
      const r = await yahoo("CNY=X", "1d", "1m");
      const meta = r.chart.result[0].meta;
      state.fx = { price: num(meta.regularMarketPrice), time: bjFromUnix(meta.regularMarketTime) };
      state.src.fx = "live";
    } catch (e) {
      state.src.fx = "down";
    }
    setChip("src-fut", "期货 " + (state.es ? state.es.source : "中断"), state.src.fut);
    setChip("src-fx", "汇率 " + (state.fx ? "实时" : "中断"), state.src.fx);
  }
  async function fetchDaily() {
    // 标普500现货日线（东财，按美东日期）——两段式公式的「隔夜段」锚点
    try {
      const r = await getJSON(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.SPX" +
        "&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=0&end=20500101&lmt=12");
      const map = {};
      ((r && r.data && r.data.klines) || []).forEach((line) => {
        const [d, c] = line.split(",");
        if (d && c) map[d] = +c;
      });
      if (Object.keys(map).length) state.spxKline = map;
    } catch (e) { /* 保留旧值；JSON 快照里也有 spx_klines 兜底 */ }
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
    if (ok) state.navAt = Date.now();
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

  /* ---------- 计算：真实溢价率（与 scripts/update_data.py 同一两段式公式） ----------
     r_idx = (标普现货最近收盘 ÷ 净值日收盘 − 1) + (ES期货实时价 ÷ 期货昨结 − 1)
     est_nav = nav × (1 + r_idx × 仓位) × (1 + Δ汇率)；premium = 现价 ÷ est_nav − 1     */
  function spxMapLive() {
    if (Object.keys(state.spxKline).length) return state.spxKline;
    return (state.data && state.data.market && state.data.market.spx_klines) || {};
  }
  function fundCalc(f) {
    const snap = (state.data && state.data.funds || []).find((x) => x.code === f.code) || {};
    const q = state.quotes[f.code] || {};
    const navInfo = state.nav[f.code] || (snap.nav ? { nav: snap.nav, nav_date: snap.nav_date } : null);
    const nav = num(navInfo && navInfo.nav);
    const navDate = navInfo && navInfo.nav_date;
    const price = num(q.price != null ? q.price : snap.price);
    // 期货：腾讯优先；腾讯挂了大不了用 Yahoo；都挂用 JSON 快照价与昨结
    const esPrice = state.es ? state.es.price : num(state.data && state.data.market.es_futures.price);
    const esPrev = state.es ? state.es.prev_close : num(state.data && state.data.market.es_futures.prev_close);
    const esSnap = !state.es;
    const hao = snap.haoetf || null;

    let rIdx = null, rOvernight = null, rToday = null, spxLastDate = null;
    const spxMap = spxMapLive();
    const spxDates = Object.keys(spxMap).sort();
    spxLastDate = spxDates[spxDates.length - 1] || (state.data && state.data.market.spx_last && state.data.market.spx_last.date);
    const spxLast = spxLastDate ? spxMap[spxLastDate] : num(state.data && state.data.market.spx_last && state.data.market.spx_last.close);
    const spxNav = navDate && spxMap[navDate] != null ? spxMap[navDate] : null;
    if (esPrice && esPrev && navDate && spxNav != null && spxLast != null) {
      rOvernight = spxLast / spxNav - 1;          // 隔夜段：净值日收盘 → 最近美股收盘
      rToday = esPrice / esPrev - 1;               // 今日段：期货实时 ÷ 昨结
      rIdx = rOvernight + rToday;
    }
    // 汇率日内变动极小，Yahoo 不可达时按 0 处理（见口径说明）
    const rFx = 0;
    let estNav = null, premium = null;
    if (nav && price && rIdx != null) {
      estNav = nav * (1 + rIdx * state.position) * (1 + rFx);
      premium = (price / estNav - 1) * 100;
    }
    // 停牌/无成交：交易时段内成交额为 0 且现价=昨收
    const halted = isTrading() && price != null && (num(q.amount) === 0 || q.amount == null && snap.amount === 0)
      && q.prev_close != null && Math.abs(price - q.prev_close) < 1e-6;
    return {
      f, price, chg_pct: num(q.chg_pct != null ? q.chg_pct : snap.chg_pct),
      amount: num(q.amount != null ? q.amount : snap.amount),
      time: q.time || snap.quote_time || null,
      quoteSnap: q.price == null,
      halted,
      nav, navDate, navSnap: !state.nav[f.code],
      estNav, premium, naive: nav && price ? (price / nav - 1) * 100 : null,
      hao, quota: hao && hao.quota, esSnap,
      rIdx: rIdx * 100, rOvernight: rOvernight * 100, rToday: rToday * 100,
      spxLastDate, spxNav,
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
  function ageStr(at) {
    if (!at) return "—";
    const s = Math.round((Date.now() - at) / 1000);
    if (s < 60) return s + "秒前";
    if (s < 3600) return Math.round(s / 60) + "分钟前";
    return Math.round(s / 3600) + "小时前";
  }
  function renderCards() {
    const es = state.es || (state.data && state.data.market.es_futures) || null;
    const fx = state.fx || (state.data && state.data.market.fx) || null;
    const spxMap = spxMapLive();
    const spxDates = Object.keys(spxMap).sort();
    const spxLastDate = spxDates[spxDates.length - 1] ||
      (state.data && state.data.market.spx_last && state.data.market.spx_last.date);
    const spxLastClose = spxLastDate ? spxMap[spxLastDate] :
      (state.data && state.data.market.spx_last && state.data.market.spx_last.close);
    $("es-price").textContent = es && es.price != null ? fmt(es.price, 2) : "—";
    $("es-sub").innerHTML = es && es.chg_pct != null
      ? `<span class="${signCls(es.chg_pct)}">${pct(es.chg_pct)}</span>${es.time ? " · " + esc(es.time) : ""}${state.es ? " · " + esc(state.es.source || "实时") : "（快照）"}`
      : "等待数据";
    $("es-tag").textContent = state.es ? (state.es.source || "实时") : "快照";
    $("spx-price").textContent = spxLastClose != null ? fmt(spxLastClose, 2) : "—";
    $("spx-sub").textContent = spxLastDate ? "收盘日 " + esc(spxLastDate) : "—";
    $("fx-price").textContent = fx && fx.price != null ? fmt(fx.price, 4) : "—";
    $("fx-sub").innerHTML = fx && fx.time
      ? `<span class="muted">${esc(fx.time)}${state.fx ? "" : "（快照，按0变动）"}</span>` : "未取到（按0变动）";
    // 数据新鲜度卡片：浏览器各源最近刷新时间
    $("snap-time").textContent = isTrading() ? "数据链路实时" : "休市 · 数据待交易时段刷新";
    $("snap-sub").textContent = "行情 " + ageStr(state.quoteAt) + " · 期货 " + ageStr(state.esAt) +
      " · 净值 " + ageStr(state.navAt);
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
           <span class="prem-sm">隔夜 ${pct(r.rOvernight)} · 期货 ${pct(r.rToday)}</span>`;
      return `<tr class="${premClass(r.premium)}">
        <td>
          <div class="fund-name">${esc(f.name)} <span class="muted" style="font-weight:400">${f.market === "SH" ? "沪" : "深"}${f.code}</span></div>
          <div class="fund-meta">${esc(f.company)} · ${r.halted ? "<b style='color:var(--amber)'>停牌中</b>" : r.quota ? "申购：" + esc(r.quota) : "申购状态—"}</div>
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
