# Frontend мини-приложения (Telegram WebApp)

Статический сайт (без сборки) — личный кабинет пользователя, открывается кнопкой
в меню бота. Ходит за данными в backend API (`webapp/api.py`), который крутится
рядом с ботом.

## Деплой на Vercel

1. Отредактируйте `config.js` — впишите реальный адрес backend API:
   ```js
   window.__API_BASE_URL__ = "https://api.myvpn.example.com";
   ```
2. Импортируйте эту папку (`webapp-frontend/`) как отдельный проект в Vercel
   (New Project → выбрать эту папку как Root Directory). Build-команда не нужна —
   это чистый статический сайт (Framework Preset: **Other**).
3. После деплоя Vercel даст домен вида `https://your-project.vercel.app` — HTTPS уже включён.
4. Впишите этот домен в `.env` бота:
   ```
   WEBAPP_URL=https://your-project.vercel.app
   API_CORS_ORIGIN=https://your-project.vercel.app
   ```
5. Перезапустите бота — в меню появится кнопка «Личный кабинет».

## Деплой на Netlify

Аналогично: New site from Git (или Drag&Drop папки) → Root directory `webapp-frontend`,
build command пустой, publish directory — сама папка (`.`).

## Backend API (обязательно, отдельно от Vercel)

Vercel/Netlify — только статика. Backend (`webapp/api.py`) — обычный Python-процесс
(aiohttp), который стартует вместе с ботом (`main.py`) и слушает `API_HOST:API_PORT`
(по умолчанию `0.0.0.0:8080`). Его нужно:

1. Разместить на своём сервере/VPS (там же, где бот).
2. Пробросить наружу через reverse-proxy с HTTPS на отдельном домене/поддомене,
   например через **Caddy** (сам получает Let's Encrypt сертификат):
   ```
   api.myvpn.example.com {
       reverse_proxy localhost:8080
   }
   ```
   или через nginx + certbot аналогично.
3. Указать этот домен в `config.js` фронтенда (`API_BASE_URL`) и в `.env` бота
   (`API_CORS_ORIGIN`) — иначе браузер внутри Telegram заблокирует запросы (CORS).

Без HTTPS на backend API Telegram WebApp (который сам всегда открывается по HTTPS)
не сможет к нему достучаться — это ограничение браузеров/Telegram, не бота.
