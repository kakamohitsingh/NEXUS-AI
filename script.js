/* ==========================================================
   NEXUS AI — script.js  v3.0
   10 Coins · ML Predictions · WebSocket · Portfolio
   Chart Modal · Price Alerts · ethers.js Wallet
   ========================================================== */
'use strict';

/* ── 1. CONFIG ─────────────────────────────────────────────── */
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// IMPORTANT: Replace this with your actual Render deployment URL (without https://)
const API_DOMAIN = isLocal ? 'localhost:8000' : 'your-app-name.onrender.com';

const CFG = {
  wsUrl:           isLocal ? `ws://${API_DOMAIN}/ws/predictions` : `wss://${API_DOMAIN}/ws/predictions`,
  apiBase:         isLocal ? `http://${API_DOMAIN}` : `https://${API_DOMAIN}`,
  broadcastSec:    10,
  reconnBaseMs:    2_000,
  reconnMaxMs:     30_000,
  reconnMaxTries:  10,
  tickMs:          3_000,
};

/* ── 2. COIN METADATA (mirrors backend ASSET_METADATA) ─────── */
const COIN_META = {
  btc:  { name:'Bitcoin',   symbol:'BTC',  logo:'asset-logo--btc',  label:'₿'    },
  eth:  { name:'Ethereum',  symbol:'ETH',  logo:'asset-logo--eth',  label:'Ξ'    },
  sol:  { name:'Solana',    symbol:'SOL',  logo:'asset-logo--sol',  label:'◎'    },
  bnb:  { name:'BNB',       symbol:'BNB',  logo:'asset-logo--bnb',  label:'BNB'  },
  xrp:  { name:'XRP',       symbol:'XRP',  logo:'asset-logo--xrp',  label:'XRP'  },
  doge: { name:'Dogecoin',  symbol:'DOGE', logo:'asset-logo--doge', label:'Ð'    },
  ada:  { name:'Cardano',   symbol:'ADA',  logo:'asset-logo--ada',  label:'ADA'  },
  avax: { name:'Avalanche', symbol:'AVAX', logo:'asset-logo--avax', label:'AVAX' },
  link: { name:'Chainlink', symbol:'LINK', logo:'asset-logo--link', label:'⬡'    },
  dot:  { name:'Polkadot',  symbol:'DOT',  logo:'asset-logo--dot',  label:'DOT'  },
};

/* ── 3. STATE ──────────────────────────────────────────────── */
let cachedPredictions   = [];
let wsSocket            = null;
let wsReconnAttempt     = 0;
let wsReconnTimer       = null;
let activeFilter        = 'all';
let tickerInterval      = null;
let countdownVal        = CFG.broadcastSec;
let countdownInterval   = null;
let modalChartInstance  = null;
let modalCurrentCoinId  = null;
let alertCoinId         = null;

/* ── 4. FORMATTERS ─────────────────────────────────────────── */
const fmt = {
  usd(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (v >= 1000) return '$' + v.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
    return '$' + v.toFixed(v >= 10 ? 2 : 4);
  },
  pct(v) { const s = v >= 0 ? '+' : ''; return `${s}${v.toFixed(2)}%`; },
};

/* ── 5. WATCHLIST ──────────────────────────────────────────── */
const WL_KEY = 'nexus_watchlist';
let watchlist = (() => { try { return new Set(JSON.parse(localStorage.getItem(WL_KEY)||'[]')); } catch { return new Set(); } })();
function saveWatchlist() { try { localStorage.setItem(WL_KEY, JSON.stringify([...watchlist])); } catch {} }

/* ── 6. ALERTS ─────────────────────────────────────────────── */
const ALT_KEY = 'nexus_alerts';
let alertStore = {};
function loadAlerts()  { try { alertStore = JSON.parse(localStorage.getItem(ALT_KEY)||'{}'); } catch { alertStore = {}; } }
function saveAlerts()  { try { localStorage.setItem(ALT_KEY, JSON.stringify(alertStore)); } catch {} }
loadAlerts();

/* ── 7. PORTFOLIO ──────────────────────────────────────────── */
const PF_KEY = 'nexus_portfolio';
let portfolio = { holdings: [] };
function loadPortfolio()  { try { portfolio = JSON.parse(localStorage.getItem(PF_KEY)||'{"holdings":[]}'); } catch {} }
function savePortfolio()  { try { localStorage.setItem(PF_KEY, JSON.stringify(portfolio)); } catch {} }
loadPortfolio();

/* ── 8. CARD BUILDER ───────────────────────────────────────── */
function buildCard(asset) {
  const up      = asset.forecast_direction === 'up';
  const dirCls  = up ? 'forecast-badge--up' : 'forecast-badge--down';
  const dirIcon = up ? 'fa-arrow-up' : 'fa-arrow-down';
  const dirLbl  = up ? 'Bullish' : 'Bearish';
  const chgCls  = asset.price_change_24h >= 0 ? 'trend--up' : 'trend--down';
  const starred = watchlist.has(asset.id);
  const alerted = !!alertStore[asset.id];
  const mlPowered = asset.ml_powered;

  return `<div class="prediction-card${starred ? ' watchlisted' : ''}"
      data-asset-id="${asset.id}"
      data-base-price="${asset.current_price}"
      data-forecast="${asset.forecast_direction}"
      role="article" aria-label="${asset.name} prediction">

    <button class="star-btn${starred?' starred':''}" data-star-id="${asset.id}"
      aria-label="${starred?'Remove from':'Add to'} watchlist" aria-pressed="${starred}"
      title="${starred?'Remove from Watchlist':'Add to Watchlist'}">
      <i class="fa-${starred?'solid':'regular'} fa-star" aria-hidden="true"></i>
    </button>

    <button class="alert-btn${alerted?' alerted':''}" data-alert-id="${asset.id}"
      aria-label="Set price alert for ${asset.name}" title="Set Price Alert">
      <i class="fa-${alerted?'solid':'regular'} fa-bell" aria-hidden="true"></i>
    </button>

    <div class="prediction-card__top">
      <div class="asset-info">
        <div class="asset-logo ${asset.logo_class}" aria-hidden="true">${asset.logo_label}</div>
        <div><div class="asset-name">${asset.name}</div><div class="asset-symbol">${asset.symbol}</div></div>
      </div>
      <div class="forecast-badge ${dirCls}" aria-label="AI: ${dirLbl}">
        <i class="fa-solid ${dirIcon}" aria-hidden="true"></i> ${dirLbl}
      </div>
    </div>

    <div class="prediction-card__price">
      <span class="price-current" data-price-display="${asset.id}">${fmt.usd(asset.current_price)}</span>
      <span class="price-change ${chgCls}" data-change-display="${asset.id}">${fmt.pct(asset.price_change_24h)}</span>
    </div>

    <div class="prediction-card__confidence">
      <div class="confidence-label">
        <span>AI Confidence${mlPowered?' <span class="ml-badge">⚡ ML</span>':''}</span>
        <strong data-conf-display="${asset.id}">${asset.confidence_score}%</strong>
      </div>
      <div class="progress-bar" role="progressbar"
        aria-valuenow="${asset.confidence_score}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar__fill" style="width:0%" data-progress="${asset.id}"></div>
      </div>
    </div>

    <div class="prediction-card__target">
      <span class="target-label"><i class="fa-solid fa-crosshairs" aria-hidden="true"></i> Next Target</span>
      <span class="target-price" data-target-display="${asset.id}">${fmt.usd(asset.next_target_price)}</span>
    </div>
    <div class="card-hint"><i class="fa-solid fa-chart-line"></i> Click for price history</div>
  </div>`;
}

/* ── 9. DASHBOARD RENDERER ─────────────────────────────────── */
function renderDashboard(predictions) {
  const grid = document.getElementById('predictions-grid');
  if (!grid) return;

  if (!predictions.length) {
    grid.innerHTML = `<div class="watchlist-empty" aria-live="polite">
      <i class="fa-solid fa-magnifying-glass"></i>
      <p>${activeFilter==='watchlist'?'Your watchlist is empty — star any card to add it.':'No assets match this filter.'}</p>
    </div>`;
    return;
  }

  grid.innerHTML = predictions.map(buildCard).join('');

  // Animate progress bars
  requestAnimationFrame(() => {
    predictions.forEach(a => {
      const bar = grid.querySelector(`[data-progress="${a.id}"]`);
      if (bar) bar.style.width = `${a.confidence_score}%`;
    });
    // Stagger entrance
    grid.querySelectorAll('.prediction-card').forEach((card, i) => {
      card.style.cssText += `opacity:0;transform:translateY(18px);transition:opacity .4s ease ${i*.07}s,transform .4s ease ${i*.07}s`;
      requestAnimationFrame(() => { card.style.opacity='1'; card.style.transform='translateY(0)'; });
    });
  });

  // Star buttons
  grid.querySelectorAll('.star-btn').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); toggleWatchlist(btn.dataset.starId, btn); }));

  // Bell buttons
  grid.querySelectorAll('.alert-btn').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); openAlertModal(btn.dataset.alertId); }));

  // Card click → chart modal (excluding buttons)
  grid.querySelectorAll('.prediction-card').forEach(card =>
    card.addEventListener('click', e => {
      if (e.target.closest('.star-btn')||e.target.closest('.alert-btn')) return;
      const id   = card.dataset.assetId;
      const pred = cachedPredictions.find(p => p.id === id);
      if (pred) openChartModal(id, pred.name);
    }));

  startTicker();
}

/* ── 10. CARD PRICE HOT-PATCH ──────────────────────────────── */
function patchCard(id, price, change, conf=null, target=null) {
  const card     = document.querySelector(`[data-asset-id="${id}"]`);
  const priceEl  = document.querySelector(`[data-price-display="${id}"]`);
  const changeEl = document.querySelector(`[data-change-display="${id}"]`);
  const confEl   = document.querySelector(`[data-conf-display="${id}"]`);
  const barEl    = document.querySelector(`[data-progress="${id}"]`);
  const targetEl = document.querySelector(`[data-target-display="${id}"]`);
  if (!priceEl || !card) return;

  const prev  = parseFloat(card.dataset.basePrice) || 0;
  const up    = price >= prev;

  priceEl.textContent  = fmt.usd(price);
  if (changeEl) { changeEl.textContent = fmt.pct(change); changeEl.className = `price-change ${change>=0?'trend--up':'trend--down'}`; }
  if (conf !== null && confEl) { confEl.textContent = `${conf}%`; }
  if (conf !== null && barEl) barEl.style.width = `${conf}%`;
  if (target !== null && targetEl) targetEl.textContent = fmt.usd(target);

  priceEl.classList.remove('flash-up','flash-down');
  void priceEl.offsetWidth;
  priceEl.classList.add(up ? 'flash-up' : 'flash-down');
  setTimeout(() => priceEl.classList.remove('flash-up','flash-down'), 700);

  card.dataset.basePrice = price;
}

/* ── 11. FILTER ────────────────────────────────────────────── */
function applyFilter(filter) {
  activeFilter = filter;
  let list = cachedPredictions;
  if (filter === 'bullish')   list = list.filter(a => a.forecast_direction === 'up');
  if (filter === 'bearish')   list = list.filter(a => a.forecast_direction === 'down');
  if (filter === 'watchlist') list = list.filter(a => watchlist.has(a.id));
  renderDashboard(list);
}

/* ── 12. WATCHLIST ─────────────────────────────────────────── */
function toggleWatchlist(id, btn) {
  const now = watchlist.has(id);
  watchlist[now ? 'delete' : 'add'](id);
  saveWatchlist();
  const on = !now;
  btn.classList.toggle('starred', on);
  btn.setAttribute('aria-pressed', on);
  btn.title = on ? 'Remove from Watchlist' : 'Add to Watchlist';
  btn.innerHTML = `<i class="fa-${on?'solid':'regular'} fa-star"></i>`;
  const card = document.querySelector(`[data-asset-id="${id}"]`);
  card?.classList.toggle('watchlisted', on);
  btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
  setTimeout(() => btn.classList.remove('pop'), 400);
  showToast(on ? `⭐ ${id.toUpperCase()} added to Watchlist` : `✕ ${id.toUpperCase()} removed`);
  if (activeFilter === 'watchlist') applyFilter('watchlist');
}

/* ── 13. CHART MODAL ───────────────────────────────────────── */
function openChartModal(coinId, coinName, days=7) {
  modalCurrentCoinId = coinId;
  const modal = document.getElementById('coin-chart-modal');
  const title = document.getElementById('modal-coin-title');
  if (title) title.textContent = `${coinName} — ${days}-Day Price History`;
  modal?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  // Timeframe buttons
  document.querySelectorAll('.tf-btn').forEach(b => {
    b.classList.toggle('tf-btn--active', parseInt(b.dataset.days) === days);
    b.onclick = () => openChartModal(coinId, coinName, parseInt(b.dataset.days));
  });
  fetchAndRenderChart(coinId, coinName, days);
}

function closeChartModal() {
  document.getElementById('coin-chart-modal')?.classList.add('hidden');
  document.body.style.overflow = '';
  if (modalChartInstance) { modalChartInstance.destroy(); modalChartInstance = null; }
}

async function fetchAndRenderChart(coinId, coinName, days) {
  const canvas = document.getElementById('modal-chart');
  if (!canvas) return;

  // Show loading
  const wrap = canvas.parentElement;
  wrap.style.opacity = '0.4';

  try {
    const res  = await fetch(`${CFG.apiBase}/api/chart/${coinId}?days=${days}`);
    const data = await res.json();
    wrap.style.opacity = '1';

    if (!data.prices?.length) { showToast('Chart data unavailable'); return; }

    const prices    = data.prices.map(([,p]) => p);
    const labels    = data.prices.map(([t]) => {
      const d = new Date(t);
      return days <= 7
        ? d.toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false})
        : d.toLocaleDateString('en-US', {month:'short', day:'numeric'});
    });
    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const chg7 = ((prices[prices.length-1] - prices[0]) / prices[0]) * 100;
    const curP = cachedPredictions.find(p => p.id === coinId)?.current_price ?? prices[prices.length-1];

    document.getElementById('modal-current-price').textContent = fmt.usd(curP);
    document.getElementById('modal-high').textContent  = fmt.usd(maxP);
    document.getElementById('modal-low').textContent   = fmt.usd(minP);
    const chgEl = document.getElementById('modal-change');
    if (chgEl) { chgEl.textContent = fmt.pct(chg7); chgEl.className = chg7>=0 ? 'trend--up' : 'trend--down'; }

    if (modalChartInstance) modalChartInstance.destroy();
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0,0,0,280);
    const up   = chg7 >= 0;
    grad.addColorStop(0, up ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');

    modalChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: coinName,
          data: prices,
          borderColor: up ? '#10b981' : '#ef4444',
          backgroundColor: grad,
          borderWidth: 2, pointRadius: 0, fill: true, tension: 0.35,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect:false, mode:'index' },
        plugins: {
          legend: { display:false },
          tooltip: {
            backgroundColor:'#0b1426', borderColor:'rgba(99,179,237,0.2)',
            borderWidth:1, padding:10, titleColor:'#e2e8f0', bodyColor:'#94a3b8',
            callbacks: { label: ctx => ` ${fmt.usd(ctx.parsed.y)}` }
          }
        },
        scales: {
          x: { grid:{color:'rgba(255,255,255,0.03)'}, ticks:{color:'#475569',font:{size:10},maxTicksLimit:8} },
          y: { grid:{color:'rgba(255,255,255,0.03)'}, ticks:{color:'#475569',font:{size:10},callback:v=>'$'+(v>=1000?(v/1000).toFixed(1)+'k':v.toFixed(2))} }
        },
        animation: { duration:600, easing:'easeInOutQuart' }
      }
    });
  } catch(e) {
    wrap.style.opacity = '1';
    showToast('Failed to load chart data');
  }
}

/* ── 14. ALERT SYSTEM ──────────────────────────────────────── */
async function requestNotifPerm() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const p = await Notification.requestPermission();
  return p === 'granted';
}

function fireNotification(title, body) {
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/favicon.ico' }); } catch {}
  }
}

function openAlertModal(coinId) {
  alertCoinId = coinId;
  const pred = cachedPredictions.find(p => p.id === coinId);
  const title = document.getElementById('alert-modal-title');
  if (title && pred) title.textContent = `Set Price Alert — ${pred.name}`;
  const existing = alertStore[coinId];
  const dirEl    = document.getElementById('alert-direction');
  const priceEl  = document.getElementById('alert-target-price');
  if (dirEl)   dirEl.value   = existing?.direction ?? 'above';
  if (priceEl) priceEl.value = existing?.targetPrice ?? (pred ? Math.round(pred.current_price * 1.05) : '');
  document.getElementById('alert-modal')?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  priceEl?.focus();
}

function closeAlertModal() {
  document.getElementById('alert-modal')?.classList.add('hidden');
  document.body.style.overflow = '';
  alertCoinId = null;
}

function saveAlert() {
  if (!alertCoinId) return;
  const direction   = document.getElementById('alert-direction')?.value;
  const targetPrice = parseFloat(document.getElementById('alert-target-price')?.value);
  if (!direction || isNaN(targetPrice) || targetPrice <= 0) { showToast('⚠ Enter a valid price'); return; }
  const alert = { coin_id:alertCoinId, direction, target_price:targetPrice,
                  alert_id:`${alertCoinId}_${Date.now()}` };
  alertStore[alertCoinId] = { direction, targetPrice, alertId: alert.alert_id };
  saveAlerts();
  // Sync to backend  (fire-and-forget)
  fetch(`${CFG.apiBase}/api/alerts`, { method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify(alert) }).catch(()=>{});
  // Update bell icon in DOM
  document.querySelector(`[data-alert-id="${alertCoinId}"]`)?.classList.add('alerted');
  const pred = cachedPredictions.find(p => p.id === alertCoinId);
  showToast(`🔔 Alert set: ${(pred?.symbol||alertCoinId).toUpperCase()} ${direction} ${fmt.usd(targetPrice)}`);
  closeAlertModal();
}

function clearAlert() {
  if (!alertCoinId) return;
  delete alertStore[alertCoinId];
  saveAlerts();
  fetch(`${CFG.apiBase}/api/alerts/${alertCoinId}`, { method:'DELETE' }).catch(()=>{});
  document.querySelector(`[data-alert-id="${alertCoinId}"]`)?.classList.remove('alerted');
  showToast(`✕ Alert removed`);
  closeAlertModal();
}

function checkAlerts(predictions) {
  predictions.forEach(pred => {
    const a = alertStore[pred.id];
    if (!a) return;
    const hit = (a.direction==='above' && pred.current_price >= a.targetPrice) ||
                (a.direction==='below' && pred.current_price <= a.targetPrice);
    if (!hit) return;
    const dir = a.direction==='above' ? '🚀 crossed above' : '🔻 dropped below';
    fireNotification(`${pred.symbol} Alert!`, `${pred.name} ${dir} ${fmt.usd(a.targetPrice)}`);
    showToast(`🔔 ${pred.symbol} ${dir} ${fmt.usd(a.targetPrice)}!`, 6000);
    delete alertStore[pred.id]; saveAlerts();
    document.querySelector(`[data-alert-id="${pred.id}"]`)?.classList.remove('alerted');
  });
}

/* ── 15. PORTFOLIO ─────────────────────────────────────────── */
function getPrice(coinId) {
  return cachedPredictions.find(p => p.id === coinId)?.current_price ?? 0;
}

function renderPortfolio() {
  const tbody   = document.getElementById('portfolio-body');
  const emptyEl = document.getElementById('portfolio-empty');
  const tableW  = document.getElementById('portfolio-table-wrap');

  if (!portfolio.holdings.length) {
    emptyEl?.classList.remove('hidden');
    if (tableW) tableW.style.display = 'none';
    ['portfolio-total-value','portfolio-total-invested'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '$0.00';
    });
    const p = document.getElementById('portfolio-total-pnl');
    if (p) { p.textContent = '$0.00'; p.className = ''; }
    return;
  }

  emptyEl?.classList.add('hidden');
  if (tableW) tableW.style.display = '';

  let totalInv = 0, totalVal = 0;

  if (tbody) {
    tbody.innerHTML = portfolio.holdings.map(h => {
      const m    = COIN_META[h.coinId] ?? { name:h.coinId, symbol:h.coinId.toUpperCase(), logo:'asset-logo--btc', label:'?' };
      const price = getPrice(h.coinId);
      const val   = h.amount * price;
      const inv   = h.amount * h.avgBuyPrice;
      const pnl   = val - inv;
      const pct   = inv > 0 ? (pnl/inv)*100 : 0;
      const sign  = pnl >= 0 ? '+' : '';
      const cls   = pnl >= 0 ? 'trend--up' : 'trend--down';
      totalInv += inv; totalVal += val;
      return `<tr data-holding-row="${h.coinId}">
        <td><span class="asset-logo ${m.logo} asset-logo--sm">${m.label}</span> ${m.name} <span class="asset-symbol">${m.symbol}</span></td>
        <td>${h.amount.toFixed(6)}</td>
        <td>${fmt.usd(h.avgBuyPrice)}</td>
        <td data-holding-price="${h.coinId}">${price ? fmt.usd(price) : '—'}</td>
        <td data-holding-value="${h.coinId}">${price ? fmt.usd(val) : '—'}</td>
        <td class="${cls}" data-holding-pnl="${h.coinId}">${price ? sign+fmt.usd(pnl) : '—'}</td>
        <td class="${cls}" data-holding-pct="${h.coinId}">${price ? sign+pct.toFixed(2)+'%' : '—'}</td>
        <td><button class="remove-holding-btn" data-coin-id="${h.coinId}" aria-label="Remove ${m.symbol}">
          <i class="fa-solid fa-trash-can"></i></button></td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('.remove-holding-btn').forEach(btn =>
      btn.addEventListener('click', () => removeHolding(btn.dataset.coinId)));
  }
  updatePortfolioSummary(totalInv, totalVal);
}

function updatePortfolioSummary(inv, val) {
  const pnl = val - inv;
  const pct = inv > 0 ? (pnl/inv)*100 : 0;
  const sign = pnl >= 0 ? '+' : '';
  const cls  = pnl >= 0 ? 'trend--up' : 'trend--down';
  const $ = id => document.getElementById(id);
  if ($('portfolio-total-value'))   $('portfolio-total-value').textContent   = fmt.usd(val);
  if ($('portfolio-total-invested')) $('portfolio-total-invested').textContent = fmt.usd(inv);
  if ($('portfolio-total-pnl')) {
    $('portfolio-total-pnl').textContent = `${sign}${fmt.usd(pnl)} (${sign}${pct.toFixed(2)}%)`;
    $('portfolio-total-pnl').className = `portfolio__stat-value ${cls}`;
  }
}

function liveUpdatePortfolio() {
  if (!portfolio.holdings.length) return;
  let totalInv = 0, totalVal = 0;
  portfolio.holdings.forEach(h => {
    const price = getPrice(h.coinId);
    if (!price) return;
    const val = h.amount * price, inv = h.amount * h.avgBuyPrice;
    const pnl = val - inv, pct = inv > 0 ? (pnl/inv)*100 : 0;
    const sign = pnl >= 0 ? '+' : '';
    const cls  = pnl >= 0 ? 'trend--up' : 'trend--down';
    const update = (sel, txt, c=null) => { const el = document.querySelector(sel); if (el) { el.textContent = txt; if (c) el.className = c; } };
    update(`[data-holding-price="${h.coinId}"]`, fmt.usd(price));
    update(`[data-holding-value="${h.coinId}"]`, fmt.usd(val));
    update(`[data-holding-pnl="${h.coinId}"]`,   sign+fmt.usd(pnl), cls);
    update(`[data-holding-pct="${h.coinId}"]`,   sign+pct.toFixed(2)+'%', cls);
    totalInv += inv; totalVal += val;
  });
  updatePortfolioSummary(totalInv, totalVal);
}

function addHolding(coinId, amount, avgBuyPrice) {
  const existing = portfolio.holdings.find(h => h.coinId === coinId);
  if (existing) {
    const tot = existing.amount + amount;
    existing.avgBuyPrice = (existing.amount*existing.avgBuyPrice + amount*avgBuyPrice) / tot;
    existing.amount = tot;
  } else {
    portfolio.holdings.push({ coinId, amount, avgBuyPrice });
  }
  savePortfolio(); renderPortfolio();
}

function removeHolding(coinId) {
  portfolio.holdings = portfolio.holdings.filter(h => h.coinId !== coinId);
  savePortfolio(); renderPortfolio();
  showToast(`✕ ${(COIN_META[coinId]?.symbol||coinId).toUpperCase()} removed from portfolio`);
}

/* ── 16. WEBSOCKET ─────────────────────────────────────────── */
function setWsStatus(state) {
  const badge = document.getElementById('ws-status');
  const text  = document.getElementById('ws-status-text');
  if (!badge) return;
  badge.classList.remove('ws-live','ws-connecting','ws-offline');
  const map = { live:{cls:'ws-live',t:'Live'}, connecting:{cls:'ws-connecting',t:'Connecting…'},
                reconnecting:{cls:'ws-connecting',t:'Reconnecting…'}, offline:{cls:'ws-offline',t:'Offline'} };
  const s = map[state] || map.offline;
  badge.classList.add(s.cls);
  if (text) text.textContent = s.t;
}

function connectWS() {
  if (wsSocket) {
    wsSocket.onopen = wsSocket.onclose = wsSocket.onerror = wsSocket.onmessage = null;
    if (wsSocket.readyState < 2) wsSocket.close();
    wsSocket = null;
  }
  setWsStatus(wsReconnAttempt === 0 ? 'connecting' : 'reconnecting');
  const ws = new WebSocket(CFG.wsUrl);
  wsSocket = ws;

  ws.onopen = () => {
    wsReconnAttempt = 0; setWsStatus('live'); setLoading(false); startCountdown();
  };

  ws.onmessage = ({ data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'predictions_update') {
        const incoming = msg.predictions ?? [];
        checkAlerts(incoming);
        if (!cachedPredictions.length) {
          cachedPredictions = incoming; applyFilter(activeFilter); setLoading(false);
        } else {
          incoming.forEach(a => {
            const ex = cachedPredictions.find(p => p.id === a.id);
            if (ex) { Object.assign(ex, a); patchCard(a.id, a.current_price, a.price_change_24h, a.confidence_score, a.next_target_price); }
          });
          cachedPredictions = incoming;
          liveUpdatePortfolio();
        }
        resetCountdown();
      }
      if (msg.type === 'alert_triggered' && msg.alert) {
        const a = msg.alert;
        fireNotification(`${a.coin_id.toUpperCase()} Alert!`, `Price crossed $${a.target_price} — now $${a.current_price}`);
        showToast(`🔔 ${a.coin_id.toUpperCase()} alert triggered!`, 6000);
      }
    } catch {}
  };

  ws.onerror = () => {};
  ws.onclose = () => {
    wsSocket = null;
    if (wsReconnAttempt >= CFG.reconnMaxTries) { setWsStatus('offline'); startHttpFallback(); return; }
    setWsStatus('reconnecting');
    const delay = Math.min(CFG.reconnBaseMs * 2**wsReconnAttempt, CFG.reconnMaxMs);
    wsReconnAttempt++;
    clearTimeout(wsReconnTimer);
    wsReconnTimer = setTimeout(connectWS, delay);
  };

  const ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 20_000);
  ws.addEventListener('close', () => clearInterval(ping), { once:true });
}

/* ── 17. HTTP FALLBACK ─────────────────────────────────────── */
let httpFbInterval = null;
async function fetchHttp() {
  try {
    const r = await fetch(`${CFG.apiBase}/api/predictions`);
    if (!r.ok) throw 0;
    const { predictions=[] } = await r.json();
    if (!predictions.length) return;
    checkAlerts(predictions);
    if (!cachedPredictions.length) { cachedPredictions = predictions; applyFilter(activeFilter); setLoading(false); }
    else { predictions.forEach(a => { const ex = cachedPredictions.find(p=>p.id===a.id); if(ex){ Object.assign(ex,a); patchCard(a.id,a.current_price,a.price_change_24h,a.confidence_score,a.next_target_price); } }); cachedPredictions=predictions; liveUpdatePortfolio(); }
    resetCountdown();
  } catch { setError(true); }
}
function startHttpFallback() { clearInterval(httpFbInterval); fetchHttp(); httpFbInterval = setInterval(fetchHttp, CFG.broadcastSec*1000); }

/* ── 18. MICRO-TICK (local jitter between WS updates) ─────── */
function startTicker() {
  stopTicker();
  tickerInterval = setInterval(() => {
    document.querySelectorAll('[data-asset-id]').forEach(card => {
      const id = card.dataset.assetId, base = parseFloat(card.dataset.basePrice)||0;
      if (!base) return;
      const j = (Math.random()-0.49) * base * 0.003;
      patchCard(id, Math.max(0.001, base+j), (j/base)*100);
    });
  }, CFG.tickMs);
}
function stopTicker() { if (tickerInterval) { clearInterval(tickerInterval); tickerInterval=null; } }

/* ── 19. COUNTDOWN ─────────────────────────────────────────── */
function startCountdown() {
  clearInterval(countdownInterval); resetCountdown();
  countdownInterval = setInterval(() => {
    countdownVal = Math.max(0, countdownVal-1);
    const el = document.getElementById('update-countdown');
    if (el) el.textContent = countdownVal;
    if (countdownVal <= 0) document.getElementById('refresh-icon')?.classList.add('spinning');
  }, 1000);
}
function resetCountdown() {
  countdownVal = CFG.broadcastSec;
  const el = document.getElementById('update-countdown'); if (el) el.textContent = countdownVal;
  document.getElementById('refresh-icon')?.classList.remove('spinning');
}

/* ── 20. LOADING / ERROR STATES ────────────────────────────── */
function setLoading(on) {
  document.getElementById('dashboard-loading')?.classList.toggle('hidden',!on);
  document.getElementById('dashboard-error')?.classList.add('hidden');
  if (on) {
    const g = document.getElementById('predictions-grid');
    if (g) g.innerHTML = Array(4).fill('<div class="prediction-card skeleton" aria-hidden="true"></div>').join('');
  }
}
function setError(show) {
  document.getElementById('dashboard-error')?.classList.toggle('hidden',!show);
  if (show) { const g=document.getElementById('predictions-grid'); if(g) g.innerHTML=''; }
}

/* ── 21. ETHERS.JS WALLET CONNECT ──────────────────────────── */
async function connectWallet() {
  const btn    = document.getElementById('connect-wallet-btn');
  const iconEl = btn?.querySelector('i');
  const textEl = btn?.querySelector('span');
  if (!btn) return;

  if (!window.ethereum) {
    showToast('⚠ MetaMask not found. Please install the MetaMask extension.');
    window.open('https://metamask.io/download/', '_blank');
    return;
  }
  if (!window.ethers) { showToast('⚠ ethers.js not loaded'); return; }

  btn.disabled = true;
  if (iconEl) iconEl.className = 'fa-solid fa-spinner fa-spin';
  if (textEl) textEl.textContent = 'Connecting…';

  try {
    const provider  = new ethers.BrowserProvider(window.ethereum);
    const accounts  = await provider.send('eth_requestAccounts', []);
    const signer    = await provider.getSigner();
    const address   = accounts[0];
    const balWei    = await provider.getBalance(address);
    const balEth    = parseFloat(ethers.formatEther(balWei)).toFixed(4);
    const shortAddr = `${address.slice(0,6)}…${address.slice(-4)}`;

    if (iconEl) iconEl.className = 'fa-solid fa-circle-check';
    if (textEl) textEl.textContent = `${shortAddr} (${balEth} ETH)`;
    btn.title = address;
    showToast(`✓ Wallet connected: ${shortAddr} | ${balEth} ETH`);

    // Listen for account changes
    window.ethereum.on('accountsChanged', accs => {
      if (!accs.length) {
        if (iconEl) iconEl.className = 'fa-solid fa-wallet';
        if (textEl) textEl.textContent = 'Connect Wallet';
        btn.disabled = false;
      } else {
        connectWallet();
      }
    });
  } catch (err) {
    if (iconEl) iconEl.className = 'fa-solid fa-wallet';
    if (textEl) textEl.textContent = 'Connect Wallet';
    const msg = err.code === 4001 ? 'Connection rejected by user.' : 'Wallet connection failed.';
    showToast(`⚠ ${msg}`);
  } finally {
    btn.disabled = false;
  }
}

/* ── 22. HERO CHART ─────────────────────────────────────────── */
let heroChart = null;
function renderHeroChart() {
  const canvas = document.getElementById('hero-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (heroChart) heroChart.destroy();
  const labels = ['Day 1','Day 2','Day 3','Day 4','Day 5','Day 6','Day 7','Day 8','Day 9','Day 10'];
  const actual = [64200,65800,64900,66400,67100,66800,67438,null,null,null];
  const fore   = [null,null,null,null,null,67200,67438,68900,69500,70200];
  const ctx    = canvas.getContext('2d');
  const gB = ctx.createLinearGradient(0,0,0,220); gB.addColorStop(0,'rgba(59,130,246,0.25)'); gB.addColorStop(1,'rgba(59,130,246,0)');
  const gP = ctx.createLinearGradient(0,0,0,220); gP.addColorStop(0,'rgba(139,92,246,0.2)');  gP.addColorStop(1,'rgba(139,92,246,0)');
  heroChart = new Chart(canvas, {
    type:'line',
    data:{ labels, datasets:[
      { label:'Actual Price', data:actual, borderColor:'#3b82f6', backgroundColor:gB, borderWidth:2.5, pointRadius:4, fill:true, tension:0.45, spanGaps:false },
      { label:'AI Forecast',  data:fore,   borderColor:'#a78bfa', backgroundColor:gP, borderWidth:2, borderDash:[5,4], pointRadius:4, fill:true, tension:0.45, spanGaps:false },
    ]},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{intersect:false,mode:'index'},
      plugins:{
        legend:{display:true,position:'top',align:'end',labels:{color:'#94a3b8',font:{family:'Inter',size:11},boxWidth:12,boxHeight:12,borderRadius:3,useBorderRadius:true,padding:12}},
        tooltip:{backgroundColor:'#0b1426',borderColor:'rgba(99,179,237,0.2)',borderWidth:1,padding:10,titleColor:'#e2e8f0',bodyColor:'#94a3b8',
          callbacks:{label:ctx=>` ${ctx.dataset.label}: ${fmt.usd(ctx.parsed.y)}`}}
      },
      scales:{
        x:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#475569',font:{family:'Inter',size:10}}},
        y:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#475569',font:{family:'Inter',size:10},callback:v=>'$'+(v/1000).toFixed(0)+'k'}}
      },
      animation:{duration:1000,easing:'easeInOutQuart'}
    }
  });
}

/* ── 23. HEADER / SCROLL / MOBILE NAV ─────────────────────── */
function setupHeader() {
  const hdr = document.getElementById('header');
  const btt = document.getElementById('back-to-top');
  const onScroll = () => {
    hdr?.classList.toggle('scrolled', window.scrollY > 20);
    btt?.classList.toggle('hidden', window.scrollY <= 300);
  };
  window.addEventListener('scroll', onScroll, { passive:true }); onScroll();
  btt?.addEventListener('click', () => window.scrollTo({ top:0, behavior:'smooth' }));
}

function setupMobileNav() {
  const btn   = document.getElementById('hamburger-btn');
  const links = document.getElementById('nav-links');
  if (!btn||!links) return;
  btn.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', open);
  });
  links.querySelectorAll('.nav__link').forEach(l => l.addEventListener('click', () => {
    links.classList.remove('open'); btn.classList.remove('active'); btn.setAttribute('aria-expanded','false');
  }));
}

/* ── 24. SMOOTH SCROLL + ANIMATIONS ────────────────────────── */
function setupSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href').slice(1); if (!id) return;
      const el = document.getElementById(id); if (!el) return;
      e.preventDefault();
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior:'smooth' });
    });
  });
}

function setupScrollAnimations() {
  const obs = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
  }), { threshold:0.12, rootMargin:'0px 0px -40px 0px' });
  document.querySelectorAll('.fade-in-up').forEach(el => obs.observe(el));
}

/* ── 25. TOAST ─────────────────────────────────────────────── */
let toastT = null;
function showToast(msg, ms=3000) {
  const el = document.getElementById('toast'); if (!el) return;
  clearTimeout(toastT); el.textContent = msg; el.classList.add('show');
  toastT = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── 26. FILTER BUTTONS ─────────────────────────────────────── */
function setupFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('filter-btn--active'));
      btn.classList.add('filter-btn--active');
      applyFilter(btn.dataset.filter);
    });
  });
}

/* ── 27. MISC BUTTONS ──────────────────────────────────────── */
function setupMisc() {
  // Retry
  document.getElementById('retry-btn')?.addEventListener('click', () => {
    setError(false); setLoading(true); wsReconnAttempt=0; connectWS();
  });
  // CTA
  document.getElementById('plan-free-btn')?.addEventListener('click',       () => showToast('🚀 Redirecting to sign-up…'));
  document.getElementById('plan-pro-btn')?.addEventListener('click',        () => showToast('⚡ Starting your free trial…'));
  document.getElementById('plan-enterprise-btn')?.addEventListener('click', () => showToast('📩 Opening sales contact form…'));
  document.getElementById('whitepaper-btn')?.addEventListener('click', e => { e.preventDefault(); showToast('📄 Whitepaper coming soon!'); });
  // Wallet
  document.getElementById('connect-wallet-btn')?.addEventListener('click', connectWallet);
  // Chart modal
  document.getElementById('chart-modal-close')?.addEventListener('click', closeChartModal);
  document.getElementById('coin-chart-modal')?.addEventListener('click', e => { if (e.target===e.currentTarget) closeChartModal(); });
  // Alert modal
  document.getElementById('alert-save-btn')?.addEventListener('click',   saveAlert);
  document.getElementById('alert-cancel-btn')?.addEventListener('click', closeAlertModal);
  document.getElementById('alert-clear-btn')?.addEventListener('click',  clearAlert);
  document.getElementById('alert-modal')?.addEventListener('click', e => { if (e.target===e.currentTarget) closeAlertModal(); });
  // Portfolio add
  document.getElementById('add-holding-btn')?.addEventListener('click', () => {
    const coinId   = document.getElementById('add-coin-select')?.value;
    const amount   = parseFloat(document.getElementById('add-amount')?.value);
    const buyPrice = parseFloat(document.getElementById('add-buy-price')?.value);
    if (!coinId || isNaN(amount) || amount<=0 || isNaN(buyPrice) || buyPrice<=0) {
      showToast('⚠ Fill in all fields correctly'); return;
    }
    addHolding(coinId, amount, buyPrice);
    const m = COIN_META[coinId];
    showToast(`✓ Added ${amount} ${m?.symbol||coinId.toUpperCase()} @ ${fmt.usd(buyPrice)}`);
    document.getElementById('add-amount').value = '';
    document.getElementById('add-buy-price').value = '';
  });
  // Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeChartModal(); closeAlertModal(); }
  });

  // Footer legal links → info toast
  document.getElementById('footer-privacy')?.addEventListener('click', e => {
    e.preventDefault();
    showToast('🔒 Privacy Policy: We only store data locally in your browser. No personal data is sent to our servers.');
  });
  document.getElementById('footer-terms')?.addEventListener('click', e => {
    e.preventDefault();
    showToast('📋 Terms: AI predictions are for educational use only. Not financial advice. Use at your own risk.');
  });
  document.getElementById('footer-cookies')?.addEventListener('click', e => {
    e.preventDefault();
    showToast('🍪 Cookies: We use localStorage only — no tracking cookies or third-party analytics.');
  });

  // Footer contact link → scroll to contact section or show modal
  document.getElementById('footer-contact-link')?.addEventListener('click', e => {
    e.preventDefault();
    openContactModal();
  });
}

/* ── 29. CONTACT MODAL ──────────────────────────────────────── */
function openContactModal() {
  // Create inline if not already present
  let modal = document.getElementById('contact-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'contact-modal';
    modal.className = 'modal-overlay';
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.innerHTML = `
      <div class="modal modal--sm">
        <div class="modal__header">
          <h3>Contact Nexus AI</h3>
          <button class="modal__close" id="contact-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="modal__body">
          <div class="alert-form">
            <div>
              <label for="contact-name">Your Name</label>
              <input id="contact-name" type="text" placeholder="Satoshi Nakamoto" style="width:100%;background:var(--color-bg);border:1px solid var(--color-border-glow);border-radius:var(--radius-md);padding:.65rem 1rem;color:var(--color-text);font-size:.95rem;font-family:var(--font-body)">
            </div>
            <div>
              <label for="contact-email">Email Address</label>
              <input id="contact-email" type="email" placeholder="you@example.com" style="width:100%;background:var(--color-bg);border:1px solid var(--color-border-glow);border-radius:var(--radius-md);padding:.65rem 1rem;color:var(--color-text);font-size:.95rem;font-family:var(--font-body)">
            </div>
            <div>
              <label for="contact-msg">Message</label>
              <textarea id="contact-msg" rows="4" placeholder="How can we help?" style="width:100%;background:var(--color-bg);border:1px solid var(--color-border-glow);border-radius:var(--radius-md);padding:.65rem 1rem;color:var(--color-text);font-size:.95rem;font-family:var(--font-body);resize:vertical"></textarea>
            </div>
          </div>
          <div style="display:flex;gap:1rem;margin-top:1.5rem">
            <a href="mailto:hello@nexus-ai.io" class="btn btn--primary" style="flex:1;text-align:center">
              <i class="fa-solid fa-envelope"></i> hello@nexus-ai.io
            </a>
          </div>
          <p style="font-size:.75rem;color:var(--color-text-faint);text-align:center;margin-top:.75rem">
            Or connect via
            <a href="https://twitter.com" target="_blank" style="color:var(--color-blue-bright)">Twitter</a> ·
            <a href="https://discord.com" target="_blank" style="color:var(--color-blue-bright)">Discord</a> ·
            <a href="https://t.me" target="_blank" style="color:var(--color-blue-bright)">Telegram</a>
          </p>
        </div>
        <div class="modal__actions">
          <button class="btn btn--primary" id="contact-send-btn"><i class="fa-solid fa-paper-plane"></i> Send Message</button>
          <button class="btn btn--ghost" id="contact-close-btn">Close</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('contact-modal-close')?.addEventListener('click', closeContactModal);
    document.getElementById('contact-close-btn')?.addEventListener('click', closeContactModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeContactModal(); });
    document.getElementById('contact-send-btn')?.addEventListener('click', () => {
      const name  = document.getElementById('contact-name')?.value.trim();
      const email = document.getElementById('contact-email')?.value.trim();
      const msg   = document.getElementById('contact-msg')?.value.trim();
      if (!name || !email || !msg) { showToast('⚠ Please fill in all fields'); return; }
      showToast(`✓ Message sent! We'll reply to ${email} soon.`);
      closeContactModal();
    });
  }
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeContactModal() {
  document.getElementById('contact-modal')?.classList.add('hidden');
  document.body.style.overflow = '';
}

/* ── 28. BOOT ───────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setupHeader();
  setupMobileNav();
  setupSmoothScroll();
  setupScrollAnimations();
  setupFilters();
  setupMisc();
  renderHeroChart();
  renderPortfolio();

  // Request push notification permission after short delay
  setTimeout(() => requestNotifPerm(), 3000);

  // Connect
  setLoading(true);
  connectWS();

  // Pause ticker when tab hidden (save CPU)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTicker();
    else { startTicker(); if (wsSocket?.readyState===1) wsSocket.send('ping'); }
  });

  console.info('[Nexus AI v3.0] Initialised | WS:', CFG.wsUrl);
});
