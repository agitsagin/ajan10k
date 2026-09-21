# Ajan 10K

Sanal 10.000₺ ile 1 haftada 2 kat hedefleyen, gerçek Binance verisiyle çalışan kâğıt üzerinde (paper trading) bot.

- `bot/run.mjs`: botun beyni. Kurallar burada, açıkça yazılı.
- `.github/workflows/bot.yml`: GitHub Actions botu her ~5 dakikada bir çalıştırır.
- `data/state.json`: botun tüm durumu. Her değişiklik zaman damgalı bir commit olarak kalır.
- `public/`: Vercel'de yayınlanan panel. Durumu doğrudan bu depodan okur.

Gerçek para kullanılmaz. Yatırım tavsiyesi değildir.
