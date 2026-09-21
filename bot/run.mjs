// Ajan 10K botu, maliyet modeli v2. GitHub Actions ~5 dakikada bir çalıştırır. Node 20+, bağımlılık yok.
//
// GERÇEK MALİYETLER (hepsi hesaba katılır, hiçbiri atlanmaz):
//  1. TL -> USDT çevrimi: Binance spot USDT/TRY, %0,1 komisyon + alım-satım makası (kayma %0,02)
//  2. Vadeli işlem komisyonu: Binance USDⓈ-M, piyasa emri (taker) %0,05, limit emir (maker) %0,02
//  3. Kayma: piyasa ve stop emirleri %0,01 daha kötü fiyattan dolar; fiyat stopun altında açılırsa (boşluk) açılış fiyatından dolar
//  4. Fonlama (funding): 8 saatte bir (00:00, 08:00, 16:00 UTC) gerçek fonlama oranı, pozisyon büyüklüğü üzerinden
//  5. Tasfiye: bakım teminatı (BTC %0,4, ETH %0,5) altına düşen pozisyon tamamen kaybedilir
//  6. Çıkış maliyeti: gösterilen bakiye, "şu an her şeyi kapatıp TL'ye çevirsem elime geçecek" tutardır
//     (pozisyon kapama komisyonu + kayma + USDT->TL çevrimi düşülmüş halde)
//  7. Gram gümüş: alış-satış makası, işlem başına %0,75 (tahmini; geçmiş makas verisi yok)
//  8. Vergi: 2026 itibarıyla kriptoya özel işlem vergisi/stopaj yürürlükte değil (Mart 2026 teklifi geri çekildi);
//     bu büyüklükteki kazanç değer artış kazancı istisnasının altında kalır. Bu nedenle 0₺.
import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../data/state.json', import.meta.url);
const SPOT = 'https://data-api.binance.vision/api/v3';
const C = { spotFee: 0.001, fxSlip: 0.0002, taker: 0.0005, maker: 0.0002, slip: 0.0001, mmr: { BTC: 0.004, ETH: 0.005 }, silverSpread: 0.0075, lev: 5 };
const SYM = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };
const NAME = { BTC: 'Bitcoin', ETH: 'Ethereum' };
const T0 = Date.parse('2026-09-21T07:05:00Z');   // 10:05 TSİ
const T1 = Date.parse('2026-09-21T08:42:00Z');   // 11:42 TSİ, gümüş satışı
const END = Date.parse('2026-09-28T20:59:00Z');  // 28 Eylül 23:59 TSİ
const RESERVE_TL = 2000, H8 = 8 * 3600e3;
const now = Date.now();

let S = JSON.parse(await readFile(FILE, 'utf8'));
const TL = n => Math.round(n).toLocaleString('tr-TR') + '₺';
const USD = n => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const log = (t, type, text) => { S.log.push({ t, type, text }); console.log(new Date(t).toISOString(), type, text); };
const rate = () => S.prices.USDTRY;

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function klines(sym, from, to) {
  const out = [];
  let st = from;
  for (let i = 0; i < 40 && st < to; i++) {
    const k = await getJSON(`${SPOT}/klines?symbol=${sym}&interval=1m&startTime=${st}&endTime=${to}&limit=1000`);
    k.filter(c => c[6] < now).forEach(c => out.push({ t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
    if (k.length < 1000) break;
    st = k[k.length - 1][0] + 60000;
  }
  return out;
}

async function fundingRate(asset, F) {
  try {
    const j = await getJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYM[asset]}&startTime=${F - 60000}&endTime=${F + 60000}&limit=5`);
    const r = j.find(x => Math.abs(x.fundingTime - F) < 60000);
    if (r) return { rate: +r.fundingRate, src: 'Binance Vadeli' };
  } catch (e) { console.log('Binance fonlama erişilemedi:', e.message); }
  try {
    const j = await getJSON(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${asset}-USDT-SWAP&after=${F + 60000}&limit=3`);
    const r = (j.data || []).find(x => Math.abs(+x.fundingTime - F) < 60000);
    if (r) return { rate: +(r.realizedRate || r.fundingRate), src: 'OKX' };
  } catch (e) { console.log('OKX fonlama erişilemedi:', e.message); }
  try {
    const j = await getJSON('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'fundingHistory', coin: asset, startTime: F - H8 + 1, endTime: F }) });
    if (Array.isArray(j) && j.length) return { rate: j.reduce((a, x) => a + +x.fundingRate, 0), src: `Hyperliquid, ${j.length} saatlik oranın toplamı` };
  } catch (e) { console.log('Hyperliquid fonlama erişilemedi:', e.message); }
  return { rate: 0.0001, src: 'hiçbir kaynağa ulaşılamadı, standart %0,01 oran kullanıldı' };
}

// ---------- işlemler ----------
function liqPrice(p) { return (p.qty * p.entry - p.marginU) / (p.qty * (1 - C.mmr[p.asset])); }

function openPos(asset, px, budgetU, t, kind) {
  const feeRate = kind === 'taker' ? C.taker : C.maker;
  const fill = kind === 'taker' ? px * (1 + C.slip) : px;
  const marginU = budgetU / (1 + C.lev * feeRate);
  const notional = marginU * C.lev, qty = notional / fill, fee = notional * feeRate;
  S.usdt -= marginU + fee;
  S.costs.fut += fee * rate();
  S.costs.slip += qty * (fill - px) * rate();
  const p = { asset, lev: C.lev, marginU, qty, entry: fill, stop: +(fill * 0.96).toFixed(2), target: +(fill * 1.05).toFixed(2), high: fill, openedAt: t };
  S.positions.push(p);
  log(t, 'AL', `${NAME[asset]} 5x long, ${TL(marginU * rate())} teminat, giriş ${USD(fill)} (${kind === 'taker' ? 'piyasa emri' : 'limit emir'}, komisyon ${TL(fee * rate())}). Stop ${USD(p.stop)}, hedef ${USD(p.target)}.`);
}
function closePos(p, fill, refPx, kind, reason, t) {
  const feeRate = kind === 'taker' ? C.taker : C.maker;
  const fee = p.qty * fill * feeRate, pnl = p.qty * (fill - p.entry);
  S.usdt += Math.max(0, p.marginU + pnl) - fee;
  S.costs.fut += fee * rate();
  S.costs.slip += Math.max(0, p.qty * (refPx - fill)) * rate();
  S.positions = S.positions.filter(x => x !== p);
  log(t, reason, `${NAME[p.asset]} kapatıldı: ${USD(p.entry)} → ${USD(fill)}. Brüt ${pnl >= 0 ? '+' : ''}${TL(pnl * rate())}, komisyon ${TL(fee * rate())}.`);
}
function liquidate(p, t) {
  S.positions = S.positions.filter(x => x !== p);
  log(t, 'TASFİYE', `${NAME[p.asset]} pozisyonu tasfiye edildi, ${TL(p.marginU * rate())} teminatın tamamı kaybedildi.`);
}

function evaluate(asset, c, t) {
  for (const p of S.positions.filter(x => x.asset === asset)) {
    if (c.l <= p.stop) {
      const fill = Math.min(p.stop, c.o) * (1 - C.slip);
      if (fill <= liqPrice(p)) { liquidate(p, t); continue; }
      closePos(p, fill, p.stop, 'taker', p.stop >= p.entry ? 'STOP (KÂR)' : 'STOP', t);
      continue;
    }
    if (c.l <= liqPrice(p)) { liquidate(p, t); continue; }
    if (c.h > p.high) {
      p.high = c.h;
      if (p.high >= p.entry * 1.02) { const ns = +(p.high * 0.975).toFixed(2); if (ns > p.stop) { p.stop = ns; } }
    }
    if (c.h > p.target) {   // limit satış emri: fiyatın hedefin üzerine geçmesi gerekir
      closePos(p, p.target, p.target, 'maker', 'HEDEF', t);
      S.pending.push({ asset, trigger: +(p.target * 0.985).toFixed(2), at: t });
      log(t, 'PLAN', `${NAME[asset]} için ${USD(p.target * 0.985)} seviyesine limit alış emri bırakıldı.`);
    }
  }
  for (const q of S.pending.filter(x => x.asset === asset)) {
    if (c.l < q.trigger) {
      const budget = S.usdt / S.pending.length;
      S.pending = S.pending.filter(x => x !== q);
      if (budget * rate() >= 100) openPos(asset, q.trigger, budget, t, 'maker');
    }
  }
}
async function applyFunding(F, px) {
  for (const p of S.positions) {
    if (p.openedAt >= F) continue;
    const f = await fundingRate(p.asset, F);
    const pay = p.qty * (px[p.asset] ?? p.entry) * f.rate;
    if (S.usdt >= pay) S.usdt -= pay; else { p.marginU -= pay - S.usdt; S.usdt = 0; }
    S.costs.funding += pay * rate();
    log(F, 'FONLAMA', `${NAME[p.asset]} fonlama oranı %${(f.rate * 100).toFixed(4)} (${f.src}): ${pay >= 0 ? 'ödenen' : 'alınan'} ${TL(Math.abs(pay * rate()))}.`);
  }
}

// Net bakiye: şu an her şeyi kapatıp TL'ye çevirsem elime geçecek tutar
function equityTL() {
  const r = rate() * (1 - C.fxSlip);
  let u = S.usdt;
  for (const p of S.positions) {
    const px = (S.prices[p.asset] ?? p.entry) * (1 - C.slip);
    u += Math.max(0, p.marginU + p.qty * (px - p.entry)) - p.qty * px * C.taker;
  }
  return S.tl + (S.silver ? S.silver.value : 0) + Math.max(0, u) * r * (1 - C.spotFee);
}
function cashOut(reason, t) {
  for (const p of [...S.positions]) { const px = S.prices[p.asset]; closePos(p, px * (1 - C.slip), px, 'taker', reason, t); }
  S.pending = [];
  if (S.usdt > 0) {
    const r = rate() * (1 - C.fxSlip), tl = S.usdt * r * (1 - C.spotFee);
    S.costs.fx += S.usdt * rate() - tl;
    S.tl += tl;
    log(t, 'ÇEVRİM', `${S.usdt.toFixed(2)} USDT, TL'ye çevrildi: ${TL(tl)}.`);
    S.usdt = 0;
  }
}
function checkEnd(t) {
  if (S.done) return;
  const eq = equityTL();
  if (eq >= S.target) { cashOut('HEDEF', t); S.done = 'win'; log(t, 'SON', `Hedef tuttu, net bakiye ${TL(S.tl)}. Ajan kazandı.`); }
  else if (t >= END) { cashOut('SÜRE', t); S.done = 'end'; log(t, 'SON', `Süre doldu, net bakiye ${TL(S.tl)}.`); }
}

// ---------- v2'ye geçiş: her şeyi 10:05'ten itibaren yeni maliyetlerle yeniden hesapla ----------
if (S.version !== 2) {
  const oldEq = S.equity;
  S = { version: 2, startCapital: 10000, target: 20000, startTime: T0, endTime: END, tl: 0, usdt: 0, silver: null,
    positions: [], pending: [], prices: {}, costs: { fut: 0, fx: 0, slip: 0, funding: 0, silver: 0 },
    lastTick: T0, lastHist: T0, history: [], log: [], done: null, runs: S.runs || 0, fundingDone: [] };
  const first = async sym => (await klines(sym, T0 - 15 * 60000, T0 + 60000)).filter(c => c.t <= T0).pop();
  const [b, e, fx] = [await first('BTCUSDT'), await first('ETHUSDT'), await first('USDTTRY')];
  S.prices = { BTC: b.o, ETH: e.o, USDTRY: fx.c };
  log(T0, 'BİLGİ', `Maliyet modeli v2: tüm geçmiş 10:05'ten itibaren gerçek komisyon, kur çevrimi, kayma ve fonlama ile yeniden hesaplandı. Eski modelde bakiye ${oldEq ? TL(oldEq) : '—'} idi. Başlangıç fiyatları artık doviz.com değil, Binance.`);
  S.tl = RESERVE_TL;
  S.silver = { value: 1000 * (1 - C.silverSpread) };
  S.costs.silver += 1000 * C.silverSpread;
  log(T0, 'AL', `Gram gümüş 1.000₺, 103,93₺'den. Alış makası (tahmini %0,75): ${TL(1000 * C.silverSpread)}.`);
  const fxRate = fx.c * (1 + C.fxSlip), tlIn = 7000;
  S.usdt = tlIn / fxRate * (1 - C.spotFee);
  S.costs.fx += tlIn - S.usdt * fx.c;
  log(T0, 'ÇEVRİM', `7.000₺, USDT'ye çevrildi (kur ${fxRate.toFixed(4)}, %0,1 komisyon): ${S.usdt.toFixed(2)} USDT.`);
  const u = S.usdt;
  openPos('BTC', b.o, u * 4 / 7, T0, 'taker');
  openPos('ETH', e.o, S.usdt, T0, 'taker');
  S.history.push({ t: T0, eq: +equityTL().toFixed(2) });
}

// ---------- son çalışmadan bu yana her dakikayı işle ----------
if (!S.done) {
  const until = Math.min(now, END + 60000);
  const cs = [];
  for (const [a, sym] of [['USDTRY', 'USDTTRY'], ['BTC', 'BTCUSDT'], ['ETH', 'ETHUSDT']]) {
    (await klines(sym, S.lastTick, until)).forEach(c => cs.push({ a, ...c }));
  }
  const order = { USDTRY: 0, BTC: 1, ETH: 2 };
  cs.sort((x, y) => x.t - y.t || order[x.a] - order[y.a]);
  let lastT = S.lastTick;
  for (let i = 0; i < cs.length && !S.done; i++) {
    const c = cs[i];
    if (c.a === 'USDTRY') { S.prices.USDTRY = c.c; }
    else {
      if (c.t % H8 === 0 && c.t > T0 && c.a === 'BTC' && !S.fundingDone.includes(c.t)) {
        const px = { BTC: c.o, ETH: (cs.find(x => x.t === c.t && x.a === 'ETH') || {}).o };
        await applyFunding(c.t, px);
        S.fundingDone.push(c.t);
      }
      evaluate(c.a, c, c.t);
      S.prices[c.a] = c.c;
    }
    if (S.silver && c.t >= T1) {
      const v = 1000 * (104.04 / 103.93) * (1 - C.silverSpread);
      S.costs.silver += 1000 * (104.04 / 103.93) * C.silverSpread;
      S.tl += v; S.silver = null;
      log(T1, 'SAT', `Gram gümüş 104,04₺'den satıldı. Satış makası dahil net ${TL(v)} (canlı gümüş verisi olmadığı için pozisyon kapatıldı).`);
    }
    checkEnd(c.t);
    lastT = Math.max(lastT, c.t + 60000);
    if (c.t - S.lastHist >= 15 * 60000) { S.history.push({ t: c.t, eq: +equityTL().toFixed(2) }); S.lastHist = c.t; }
  }
  S.lastTick = lastT;
  console.log(`${cs.length} mum işlendi.`);
}

const tk = await getJSON(`${SPOT}/ticker/price?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT","USDTTRY"]')}`);
const m = Object.fromEntries(tk.map(x => [x.symbol, +x.price]));
S.live = { BTC: m.BTCUSDT, ETH: m.ETHUSDT, USDTRY: m.USDTTRY, at: now };
S.lastRun = now; S.runs = (S.runs || 0) + 1;
S.equity = +equityTL().toFixed(2);
S.costModel = C;
if (S.log.length > 1500) S.log = S.log.slice(-1500);
console.log(`Net bakiye ${TL(S.equity)} | maliyetler ${JSON.stringify(S.costs)} | BTC ${USD(m.BTCUSDT)} ETH ${USD(m.ETHUSDT)} USDT/TRY ${m.USDTTRY}`);
await writeFile(FILE, JSON.stringify(S, null, 1));
