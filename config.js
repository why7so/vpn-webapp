// Адрес вашего backend API (webapp/api.py), доступный по HTTPS.
// Пример: "https://api.myvpn.example.com" (без слэша на конце).
// ВАЖНО: замените на реальный адрес перед деплоем на Vercel/Netlify.
window.__API_BASE_URL__ = "https://vpn-bot-production-555c.up.railway.app";
// Username вашего Telegram-бота (без @), например "myvpn_bot".
// Используется только для кнопки "Войти через Telegram" на экране входа —
// она нужна, если сайт открыли в обычном браузере (не внутри Telegram) без
// активной сессии. Ссылка ведёт на t.me/<bot>?start=weblogin, бот выдаёт
// одноразовую ссылку обратно на сайт (см. handlers/user.py в боте).
window.__BOT_USERNAME__ = "jayconnectbot";
