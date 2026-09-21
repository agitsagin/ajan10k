// Ajan 10K botu. GitHub Actions her ~5 dakikada bir bunu çalıştırır.
// Bağımlılık yok, Node 20+. Veri: Binance'in herkese açık piyasa verisi (data-api.binance.vision).
import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../data/state.json', import.meta.url);
const API = 'https://data-api.binance.vision/api/v3';
const RESERVE = 2000, FEE = 0.001, LEV = 5;
const SYM = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };
const NAME = { BTC: 'Bitcoin', ETH: 'Ethereum' };

const S = JSON.parse(await readFile(FILE, 'utf8'));
const TL = n => Math.round(n).toLocaleString('tr-TR') + '₺';
const USD = n => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const log = (t, type, text) => { S.log.push({ t, type, text }); console.log(new Date(t).toISOString(), type, text); };

const value = (p, price) => { const pnl = p.margin * p.lev * (price / p.entry - 1); return { pnl, value: Math.max(0, p.margin + pnl) }; };
const equity = () => S.cash + S.positions.reduce((a, p) => a + value(p, S.prices[p.asset] ?? p.entry).value, 0);

function closePos(p, price, reason, t) {
  const v = value(p, price), fee = p.margin * p.lev * (price / p.entry) * FEE;
  S.cash += Math.max(0, v.value - fee);
  S.positions = S.positions.filter(x => x !== p);
  log(t, reason, `${NAME[p.asset]} ${p.lev}x kapatıldı: ${USD(p.entry)} → ${USD(price)}. Sonuç ${v.pnl >= 0 ? '+' : ''}${TL(v.pnl)} (komisyon ${TL(fee)}).`);
}
function openPos(asset, price, margin, t) {
  const fee = margin * LEV * FEE; S.cash -= margin + fee;
  const p = { id: asset + t, asset, lev: LEV, margin, entry: price, stop: +(price * 0.96).toFixed(2), target: +(price * 1.05).toFixed(2), high: price, openedAt: t };
  S.positions.push(p);
  log(t, 'AL', `${NAME[asset]} 5x long, ${TL(margin)} teminat, giriş ${USD(price)}. Stop ${USD(p.stop)}, hedef ${USD(p.target)}.`);
}

// Kurallar (tarayıcı sürümüyle birebir aynı). Her 1 dakikalık mumda önce stop kontrol edilir.
function evaluate(asset, low, high, t) {
  for (const p of S.positions.filter(x => x.asset === asset)) {
    if (low <= p.stop) { closePos(p, p.stop, p.stop >= p.entry ? 'STOP (KÂR)' : 'STOP', t); continue; }
    if (high > p.high) {
      p.high = high;
      if (p.high >= p.entry * 1.02) { const ns = +(p.high * 0.975).toFixed(2); if (ns > p.stop) p.stop = ns; }
    }
    if (high >= p.target) {
      closePos(p, p.target, 'HEDEF', t);
      S.pending.push({ asset, trigger: +(p.target * 0.985).toFixed(2), at: t });
      log(t, 'PLAN', `${NAME[asset]} ${USD(p.target * 0.985)} seviyesine geri çekilirse yeniden alınacak.`);
    }
  }
  for (const q of S.pending.filter(x => x.asset === asset)) {
    if (low <= q.trigger) {
      const margin = Math.floor((S.cash - RESERVE) / S.pending.length / (1 + LEV * FEE));
      S.pending = S.pending.filter(x => x !== q);
      if (margin >= 100) openPos(asset, q.trigger, margin, t);
    }
  }
}
function checkEnd(t) {
  if (S.done) return;
  const eq = equity();
  const closeAll = r => { for (const p of [...S.positions]) closePos(p, S.prices[p.asset], r, t); S.pending = []; };
  if (eq <= 0) { S.done = 'dead'; log(t, 'SON', 'Bakiye sıfırlandı. Ajan kapatıldı.'); }
  else if (eq >= S.target) { closeAll('HEDEF'); S.done = 'win'; log(t, 'SON', `Hedef tuttu: ${TL(S.cash)}. Ajan kazandı.`); }
  else if (t >= S.endTime) { closeAll('SÜRE'); S.done = 'end'; log(t, 'SON', `Süre doldu. Son bakiye ${TL(S.cash)}.`); }
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const now = Date.now();
const until = Math.min(now, S.endTime + 60000);
if (!S.done) {
  // Son çalışmadan bu yana kapanmış tüm 1 dakikalık mumları çek ve sırayla işle.
  const candles = [];
  for (const a of Object.keys(SYM)) {
    let st = S.lastTick;
    for (let i = 0; i < 30 && st < until; i++) {
      const k = await getJSON(`${API}/klines?symbol=${SYM[a]}&interval=1m&startTime=${st}&endTime=${until}&limit=1000`);
      const closed = k.filter(c => c[6] < now);
      closed.forEach(c => candles.push({ a, t: c[0], h: +c[2], l: +c[3], c: +c[4] }));
      if (k.length < 1000) break;
      st = k[k.length - 1][0] + 60000;
    }
  }
  candles.sort((x, y) => x.t - y.t || x.a.localeCompare(y.a));
  let lastT = S.lastTick;
  for (const c of candles) {
    if (S.done) break;
    S.prices[c.a] = c.c;
    evaluate(c.a, c.l, c.h, c.t);
    checkEnd(c.t);
    lastT = Math.max(lastT, c.t + 60000);
    if (c.t - S.lastHist >= 15 * 60000) { S.history.push({ t: c.t, eq: +equity().toFixed(2) }); S.lastHist = c.t; }
  }
  S.lastTick = lastT;
  console.log(`${candles.length} mum işlendi.`);
}

// Görüntü için anlık fiyatlar
const tk = await getJSON(`${API}/ticker/price?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT","USDTTRY"]')}`);
const m = Object.fromEntries(tk.map(x => [x.symbol, +x.price]));
S.live = { BTC: m.BTCUSDT, ETH: m.ETHUSDT, USDTRY: m.USDTTRY, at: now };
S.prices.USDTRY = m.USDTTRY;
S.lastRun = now; S.runs = (S.runs || 0) + 1;
S.equity = +equity().toFixed(2);
if (S.log.length > 1000) S.log = S.log.slice(-1000);

console.log(`Bakiye ${TL(S.equity)} | BTC ${USD(m.BTCUSDT)} | ETH ${USD(m.ETHUSDT)} | USDT/TRY ${m.USDTTRY}`);
await writeFile(FILE, JSON.stringify(S, null, 1));
