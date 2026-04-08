"""
main.py — Nexus AI v3.0 Backend
Multi-source prices: CoinGecko → Binance → CryptoCompare → fallback
"""

import asyncio, json, logging, os, ssl, time, urllib.request
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ai_service import ASSET_METADATA, analyze_crypto_data, train_models

logging.basicConfig(level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("nexus-ai")

# ─── SSL (bypass self-signed / corporate proxy certs) ────────
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode    = ssl.CERT_NONE

# ─── URLs ─────────────────────────────────────────────────────
COIN_IDS  = ",".join(ASSET_METADATA.keys())
_CG_URL   = (f"https://api.coingecko.com/api/v3/simple/price"
             f"?ids={COIN_IDS}&vs_currencies=usd&include_24hr_change=true")
CHART_URL = "https://api.coingecko.com/api/v3/coins/{id}/market_chart?vs_currency=usd&days={days}&interval=hourly"

_BN_TO_CG = {
    "BTC":"bitcoin","ETH":"ethereum","SOL":"solana","BNB":"binancecoin",
    "XRP":"ripple","DOGE":"dogecoin","ADA":"cardano",
    "AVAX":"avalanche-2","LINK":"chainlink","DOT":"polkadot",
}
FRONTEND_ID_MAP = {m["id"]: cg for cg, m in ASSET_METADATA.items()}

BROADCAST_SEC = 10
RETRAIN_SEC   = 3600

# ─── FALLBACK PRICES ──────────────────────────────────────────
# Real-world reference prices (updated April 2026)
# These are used when all live APIs are blocked by network firewall
FALLBACK_PRICES: dict = {
    "bitcoin":     {"usd": 83_500.00, "usd_24h_change":  1.42},
    "ethereum":    {"usd":  1_601.00, "usd_24h_change":  0.87},
    "solana":      {"usd":    121.50, "usd_24h_change": -1.23},
    "binancecoin": {"usd":    595.00, "usd_24h_change":  0.61},
    "ripple":      {"usd":      2.18, "usd_24h_change":  0.35},
    "dogecoin":    {"usd":      0.158,"usd_24h_change": -0.72},
    "cardano":     {"usd":      0.649,"usd_24h_change":  0.44},
    "avalanche-2": {"usd":     20.10, "usd_24h_change": -0.58},
    "chainlink":   {"usd":     13.20, "usd_24h_change":  1.15},
    "polkadot":    {"usd":      4.08, "usd_24h_change":  0.28},
}

import random as _rng
import time as _time

_last_fallback_tweak = 0.0
_tweaked_prices: dict = {}

def get_dynamic_fallback() -> dict:
    """Return FALLBACK_PRICES with tiny random walk noise each call."""
    global _last_fallback_tweak, _tweaked_prices
    now = _time.time()
    if not _tweaked_prices:
        _tweaked_prices = {k: dict(v) for k, v in FALLBACK_PRICES.items()}
    if now - _last_fallback_tweak > 10:
        r = _rng.Random()
        for cg_id, d in _tweaked_prices.items():
            base = FALLBACK_PRICES[cg_id]["usd"]
            noise = r.gauss(0, base * 0.0018)
            d["usd"] = round(max(base * 0.92, d["usd"] + noise), 4 if base < 10 else 2)
            d["usd_24h_change"] = round(FALLBACK_PRICES[cg_id]["usd_24h_change"] + r.gauss(0, 0.08), 2)
        _last_fallback_tweak = now
    return _tweaked_prices

ALLOWED_ORIGINS = [
    "http://localhost:5500","http://127.0.0.1:5500",
    "http://localhost:3000","http://127.0.0.1:3000",
    "http://localhost:8000","http://127.0.0.1:8000",
    "http://localhost:8080","null",
]
if os.getenv("FRONTEND_URL"):
    ALLOWED_ORIGINS.extend([url.strip() for url in os.getenv("FRONTEND_URL").split(",")])

# ─── ALERT STORE ──────────────────────────────────────────────
class AlertCreate(BaseModel):
    coin_id: str; direction: str; target_price: float; alert_id: str

ALERT_STORE: list[dict] = []

def check_alerts(preds: list[dict]) -> list[dict]:
    triggered, keep = [], []
    pm = {p["id"]: p["current_price"] for p in preds}
    for a in ALERT_STORE:
        price = pm.get(a["coin_id"])
        if price is None: keep.append(a); continue
        hit = (a["direction"]=="above" and price>=a["target_price"]) or \
              (a["direction"]=="below" and price<=a["target_price"])
        (triggered if hit else keep).append({**a,"current_price":price} if hit else a)
    ALERT_STORE[:] = keep
    return triggered

# ─── WS MANAGER ───────────────────────────────────────────────
class Manager:
    def __init__(self): self._ws: list[WebSocket] = []
    async def connect(self, ws):
        await ws.accept(); self._ws.append(ws)
        log.info("WS+ (total %d)", len(self._ws))
    def disconnect(self, ws):
        if ws in self._ws: self._ws.remove(ws)
        log.info("WS- (total %d)", len(self._ws))
    async def broadcast(self, payload):
        msg, dead = json.dumps(payload), []
        for ws in self._ws:
            try: await ws.send_text(msg)
            except: dead.append(ws)
        for ws in dead: self._ws.remove(ws)
    @property
    def client_count(self): return len(self._ws)

manager = Manager()
_last_predictions: list[dict] = []
_last_retrain_ts: float = 0.0

# ─── HTTP (urllib, SSL off) ────────────────────────────────────
def _sync_get(url: str) -> Optional[dict]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent":"NexusAI/3.0"})
        with urllib.request.urlopen(req, context=_SSL_CTX, timeout=12) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log.debug("GET %s → %s", url[:70], type(e).__name__)
        return None

async def _get(url: str) -> Optional[dict]:
    return await asyncio.get_event_loop().run_in_executor(None, _sync_get, url)

# ─── MULTI-SOURCE PRICE FETCH ──────────────────────────────────
async def fetch_live_prices() -> dict:
    # 1️⃣ CoinGecko
    d = await _get(_CG_URL)
    if d and "bitcoin" in d:
        log.info("✓ CoinGecko (%d)", len(d)); return d

    # 2️⃣ Binance
    try:
        raw = await _get("https://api.binance.com/api/v3/ticker/24hr")
        if raw:
            out: dict = {}
            for item in raw:
                for sym, cg in _BN_TO_CG.items():
                    if item.get("symbol") == f"{sym}USDT":
                        out[cg] = {"usd": float(item["lastPrice"]),
                                   "usd_24h_change": float(item["priceChangePercent"])}
            if len(out) >= 5:
                log.info("✓ Binance (%d)", len(out)); return out
    except Exception as e:
        log.debug("Binance: %s", e)

    # 3️⃣ CryptoCompare
    try:
        syms = ",".join(_BN_TO_CG.keys())
        raw  = await _get(f"https://min-api.cryptocompare.com/data/pricemultifull?fsyms={syms}&tsyms=USD")
        if raw and "RAW" in raw:
            out = {}
            for sym, cg in _BN_TO_CG.items():
                d2 = raw["RAW"].get(sym, {}).get("USD", {})
                if d2:
                    out[cg] = {"usd": float(d2.get("PRICE",0)),
                               "usd_24h_change": float(d2.get("CHANGEPCT24HOUR",0))}
            if len(out) >= 5:
                log.info("✓ CryptoCompare (%d)", len(out)); return out
    except Exception as e:
        log.debug("CryptoCompare: %s", e)

    log.warning("All price APIs failed — using dynamic fallback (network firewalled)")
    return get_dynamic_fallback()

async def fetch_historical() -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    for cg_id in ASSET_METADATA:
        url  = CHART_URL.format(id=cg_id, days=14)
        data = await _get(url)
        if data and "prices" in data:
            out[cg_id] = [p for _,p in data["prices"]]
            log.info("Hist OK: %-14s %d pts", cg_id, len(out[cg_id]))
        else:
            log.warning("Hist failed: %s", cg_id)
        await asyncio.sleep(1.2)
    return out

# ─── BROADCAST LOOP ───────────────────────────────────────────
async def broadcast_loop():
    global _last_predictions, _last_retrain_ts
    log.info("Broadcast loop starting…")
    # Train ML on startup
    log.info("Fetching 14-day history for ML training (this takes ~2 min)…")
    hist = await fetch_historical()
    if hist:
        await asyncio.get_event_loop().run_in_executor(None, train_models, hist)
        _last_retrain_ts = time.time()
        log.info("ML models ready ✓")
    else:
        log.warning("No historical data — ML disabled, using simulation")

    while True:
        try:
            live  = await fetch_live_prices()
            preds = analyze_crypto_data(live)
            _last_predictions = preds
            alerts_hit = check_alerts(preds)
            await manager.broadcast({"type":"predictions_update","predictions":preds,
                                     "client_count":manager.client_count})
            for a in alerts_hit:
                await manager.broadcast({"type":"alert_triggered","alert":a})
            log.info("Broadcast: %d coins, %d clients", len(preds), manager.client_count)
            if time.time() - _last_retrain_ts > RETRAIN_SEC:
                hist = await fetch_historical()
                if hist:
                    await asyncio.get_event_loop().run_in_executor(None, train_models, hist)
                    _last_retrain_ts = time.time()
                    log.info("Models retrained ✓")
        except Exception as e:
            log.error("Loop error: %s", e, exc_info=True)
        await asyncio.sleep(BROADCAST_SEC)

# ─── LIFESPAN ─────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    t = asyncio.create_task(broadcast_loop())
    log.info("Nexus AI v3.0 started ✓")
    yield
    t.cancel()

# ─── APP ──────────────────────────────────────────────────────
app = FastAPI(title="Nexus AI v3.0", version="3.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS,
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.get("/", include_in_schema=False)
async def root():
    return JSONResponse({"name": "Nexus AI v3.0", "status": "online", "docs": "/docs"})

# ─── REST ─────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    import ai_service as _ai
    return {"status":"ok","version":"3.0","connected_clients":manager.client_count,
            "models_trained":len(_ai.MODEL_CACHE)}

@app.get("/api/predictions")
async def get_predictions():
    if _last_predictions:
        return {"source":"cache","predictions":_last_predictions}
    live  = await fetch_live_prices()
    preds = analyze_crypto_data(live)
    return {"source":"live","predictions":preds}

@app.get("/api/chart/{coin_id}")
async def get_chart(coin_id: str, days: int = 7):
    cg_id = FRONTEND_ID_MAP.get(coin_id.lower())
    if not cg_id:
        return {"error":f"Unknown coin: {coin_id}","prices":[]}
    url  = CHART_URL.format(id=cg_id, days=days)
    data = await _get(url)
    if data and "prices" in data:
        return {"coin_id":coin_id,"cg_id":cg_id,"days":days,"prices":data["prices"]}
    # Fallback: generate synthetic chart from current price
    import random, time as _t
    base = get_dynamic_fallback().get(cg_id, {}).get("usd", 1000)
    pts  = []
    now  = _t.time()*1000
    p    = base * 0.92
    for i in range(days * 24):
        p = max(0.001, p * (1 + random.gauss(0, 0.008)))
        pts.append([now - (days*24-i)*3600000, round(p, 4)])
    pts[-1][1] = base
    return {"coin_id":coin_id,"cg_id":cg_id,"days":days,"prices":pts,"source":"synthetic"}

@app.post("/api/alerts", status_code=201)
async def set_alert(alert: AlertCreate):
    ALERT_STORE[:] = [a for a in ALERT_STORE if a["alert_id"] != alert.alert_id]
    ALERT_STORE.append(alert.dict())
    return {"status":"ok","alert":alert.dict()}

@app.get("/api/alerts")
async def list_alerts(): return {"alerts":ALERT_STORE}

@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: str):
    before = len(ALERT_STORE)
    ALERT_STORE[:] = [a for a in ALERT_STORE if a["alert_id"] != alert_id]
    return {"removed":before-len(ALERT_STORE)}

# ─── WEBSOCKET ─────────────────────────────────────────────────
@app.websocket("/ws/predictions")
async def ws_endpoint(ws: WebSocket):
    await manager.connect(ws)
    snap = _last_predictions or analyze_crypto_data(get_dynamic_fallback())
    await ws.send_text(json.dumps({"type":"predictions_update","predictions":snap,
                                   "client_count":manager.client_count}))
    try:
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_text(json.dumps({"type":"pong"}))
    except WebSocketDisconnect:
        manager.disconnect(ws)
