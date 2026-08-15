(function () {
  "use strict";

  const API_BASE_URL = (window.__API_BASE_URL__ || "").replace(/\/$/, "");
  const tg = window.Telegram && window.Telegram.WebApp;

  if (tg) {
    tg.ready();
    tg.expand();
    // Тема приложения зафиксирована на тёмную — принудительно красим системную
    // шапку/фон Telegram-WebView, чтобы они не подстраивались под светлую тему
    // пользователя и не спорили с нашим тёмным дизайном.
    try {
      if (tg.setHeaderColor) tg.setHeaderColor("#0b0c0b");
      if (tg.setBackgroundColor) tg.setBackgroundColor("#0b0c0b");
    } catch (e) {
      /* старые клиенты Telegram могут не поддерживать эти методы */
    }
  }

  const initData = tg ? tg.initData : "";

  // ---------- авторизация в обычном браузере (вне Telegram Mini App) ----------
  // Если приложение открыто не внутри Telegram (initData пуст), используем
  // сессию браузера: либо уже сохранённый токен из прошлого визита, либо
  // свежий login_token в URL — он приходит по одноразовой ссылке из бота
  // (см. handlers/user.py: /start weblogin), которую сайт предлагает открыть
  // кнопкой "Войти через Telegram", если сессии ещё нет.
  const BOT_USERNAME = window.__BOT_USERNAME__ || "";
  const SESSION_STORAGE_KEY = "vpn_session_token";
  let sessionToken = initData ? null : localStorage.getItem(SESSION_STORAGE_KEY) || null;

  const authParams = new URLSearchParams(window.location.search);
  const incomingLoginToken = authParams.get("login_token");
  if (incomingLoginToken) {
    // сразу убираем токен из адреса — он одноразовый, повторное чтение
    // страницы с тем же URL не должно пытаться использовать его снова
    authParams.delete("login_token");
    const restAuthParams = authParams.toString();
    const cleanAuthUrl =
      window.location.pathname + (restAuthParams ? "?" + restAuthParams : "") + window.location.hash;
    window.history.replaceState({}, "", cleanAuthUrl);
  }

  async function ensureBrowserAuth() {
    if (initData) return true; // внутри Telegram Mini App — авторизация через initData, тут делать нечего
    if (sessionToken) return true;
    if (!incomingLoginToken) return false;

    try {
      const resp = await fetch(API_BASE_URL + "/api/browser-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: incomingLoginToken }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error((data && data.error) || "Не удалось войти");
      sessionToken = data.session_token;
      localStorage.setItem(SESSION_STORAGE_KEY, sessionToken);
      return true;
    } catch (e) {
      els.loading.textContent =
        "Не удалось войти: " + e.message + ". Запросите новую ссылку в боте (/start weblogin).";
      return false;
    }
  }

  function showBrowserLoginScreen() {
    if (BOT_USERNAME) {
      const loginUrl = "https://t.me/" + BOT_USERNAME + "?start=weblogin";
      els.loading.innerHTML =
        '<div>Откройте личный кабинет через Telegram:</div>' +
        '<a class="btn btn-standalone" href="' +
        loginUrl +
        '" target="_blank" rel="noopener">Войти через Telegram</a>';
    } else {
      els.loading.textContent = "Откройте мини-приложение через кнопку в Telegram-боте.";
    }
  }

  // ---------- popup с результатом активации промокода ----------
  // Кнопка "Активировать" промокода (в боте) ведёт сюда с параметром
  // ?promo_popup=..., чтобы результат показывался всплывающим окном внутри
  // приложения, а не отдельным сообщением в чате бота.
  const promoPopupParams = new URLSearchParams(window.location.search);
  const promoPopupText = promoPopupParams.get("promo_popup");
  if (promoPopupText) {
    // сразу убираем параметр из адреса, чтобы обновление страницы или
    // возврат назад не показывали окно повторно
    promoPopupParams.delete("promo_popup");
    const restParams = promoPopupParams.toString();
    const cleanUrl =
      window.location.pathname + (restParams ? "?" + restParams : "") + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
  }

  function showTgPopup(title, message) {
    if (tg && tg.showPopup) {
      tg.showPopup({ title: title, message: message });
    } else if (tg && tg.showAlert) {
      tg.showAlert(message);
    } else {
      window.alert(message);
    }
  }

  function showPromoPopupIfAny() {
    if (!promoPopupText) return;
    showTgPopup("🎁 Промокод", promoPopupText);
  }

  // ---------- автоактивация промокода при открытии по прямой ссылке ----------
  // Кнопка "Активировать" (t.me/<bot>/<short_name>?startapp=promo_<CODE>)
  // открывает приложение сразу, минуя чат с ботом. Telegram передаёт код
  // приложению через initDataUnsafe.start_param — сами вызываем /api/promo
  // и показываем результат попапом.
  const startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param || "" : "";
  const autoPromoCode = startParam.indexOf("promo_") === 0 ? startParam.slice("promo_".length) : null;

  function shortenForPopup(text) {
    // showPopup ограничен 256 символами, а ссылка-подписка и так видна на
    // главном экране приложения — обрезаем текст на этой строке (если есть)
    // и подстраховываемся на случай других длинных сообщений.
    const lines = text.split("\n");
    const cutIdx = lines.findIndex((l) => l.indexOf("Ваша ссылка-подписка") === 0);
    const kept = cutIdx === -1 ? lines : lines.slice(0, cutIdx);
    let result = kept.join("\n").trim();
    if (result.length > 250) result = result.slice(0, 247).trim() + "...";
    return result;
  }

  async function redeemPromoFromStartParam(code) {
    try {
      const result = await api("/api/promo", { method: "POST", body: JSON.stringify({ code: code }) });
      await refreshProfile();
      showTgPopup("🎁 Промокод", shortenForPopup(result.message));
    } catch (e) {
      showTgPopup("Промокод", "❌ " + e.message);
    }
  }

  const els = {
    loading: document.getElementById("loading"),
    main: document.getElementById("screen-main"),

    discountChip: document.getElementById("discount-chip"),

    balance: document.getElementById("balance"),
    discount: document.getElementById("discount"),
    topupShortcut: document.getElementById("topup-shortcut"),
    promoShortcut: document.getElementById("promo-shortcut"),

    ringSvg: document.getElementById("ring-svg"),
    daysLeft: document.getElementById("days-left"),
    subPlanName: document.getElementById("sub-plan-name"),
    subPlanDate: document.getElementById("sub-plan-date"),
    manageBtn: document.getElementById("manage-btn"),

    autorenewCard: document.getElementById("autorenew-card"),
    autorenewDot: document.getElementById("autorenew-dot"),
    autorenewSub: document.getElementById("autorenew-sub"),
    autorenewToggleBtn: document.getElementById("autorenew-toggle-btn"),

    subUrlBlock: document.getElementById("sub-url-block"),
    subUrl: document.getElementById("sub-url"),
    copySubUrl: document.getElementById("copy-sub-url"),
    shareSubUrl: document.getElementById("share-sub-url"),
    connectNoSub: document.getElementById("connect-no-sub"),

    connectAppSelect: document.getElementById("connect-app-select"),
    connectStepAppName: document.getElementById("connect-step-app-name"),
    connectStoreBtn: document.getElementById("connect-store-btn"),
    connectAddSubBtn: document.getElementById("connect-add-sub-btn"),
    connectOtherDeviceBtn: document.getElementById("connect-other-device-btn"),
    connectPlatformChips: document.getElementById("connect-platform-chips"),

    plansTitle: document.getElementById("plans-title"),
    plansList: document.getElementById("plans-list"),

    planModal: document.getElementById("plan-modal"),
    planModalTitle: document.getElementById("plan-modal-title"),
    planModalPrice: document.getElementById("plan-modal-price"),
    planModalDevicesQty: document.getElementById("plan-modal-devices-qty"),
    planModalDots: document.getElementById("plan-modal-dots"),
    planModalSelectView: document.getElementById("plan-modal-select-view"),
    planModalCancel: document.getElementById("plan-modal-cancel"),
    planModalPay: document.getElementById("plan-modal-pay"),
    planModalMethodView: document.getElementById("plan-modal-method-view"),
    planModalMethods: document.getElementById("plan-modal-methods"),
    planModalBack: document.getElementById("plan-modal-back"),

    topupPresets: document.getElementById("topup-presets"),
    topupCustom: document.getElementById("topup-custom"),
    topupBtn: document.getElementById("topup-btn"),

    promoTitle: document.getElementById("promo-title"),
    promoInput: document.getElementById("promo-input"),
    promoBtn: document.getElementById("promo-btn"),

    devicesText: document.getElementById("devices-text"),
    devicesPresets: document.getElementById("devices-presets"),

    payModal: document.getElementById("pay-modal"),
    payModalPlanLabel: document.getElementById("pay-modal-plan-label"),
    payModalPlan: document.getElementById("pay-modal-plan"),
    payModalMethod: document.getElementById("pay-modal-method"),
    payModalPrice: document.getElementById("pay-modal-price"),
    payModalCancel: document.getElementById("pay-modal-cancel"),
    payModalConfirm: document.getElementById("pay-modal-confirm"),

    aboutName: document.getElementById("about-name"),
    aboutSupport: document.getElementById("about-support"),
    browserLogoutBtn: document.getElementById("browser-logout-btn"),

    accountTgId: document.getElementById("account-tg-id"),
    accountUsername: document.getElementById("account-username"),

    bottomNav: document.getElementById("bottom-nav"),
    navItems: document.querySelectorAll(".nav-item"),

    toast: document.getElementById("toast"),
  };

  let toastTimer = null;
  function showToast(message, isError) {
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");
    els.toast.style.color = isError ? "#ff6b6b" : "";
    if (tg && tg.HapticFeedback) {
      tg.HapticFeedback.notificationOccurred(isError ? "error" : "success");
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3500);
  }

  async function api(path, options) {
    options = options || {};
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    if (initData) {
      headers["Authorization"] = "tma " + initData;
    } else if (sessionToken) {
      headers["Authorization"] = "Bearer " + sessionToken;
    }

    const resp = await fetch(API_BASE_URL + path, Object.assign({}, options, { headers }));
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      /* пустой ответ (напр. OPTIONS) */
    }
    if (!resp.ok) {
      if (resp.status === 401 && !initData) {
        // сессия браузера протухла или была отозвана — просим войти заново
        localStorage.removeItem(SESSION_STORAGE_KEY);
        sessionToken = null;
      }
      throw new Error((data && data.error) || "Ошибка сервера (" + resp.status + ")");
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return "нет активной подписки";
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function fmtDateShort(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return "до " + d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  function daysLeftFrom(iso) {
    if (!iso) return 0;
    const diffMs = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  }

  // ---------- dotted progress ring ----------
  // Плановая длительность подписки бэкенду неизвестна фронтенду напрямую,
  // поэтому прогресс считается относительно скользящего 30-дневного цикла
  // (типичная длительность тарифа). Если дней остаётся больше — кольцо просто полное.
  const RING_CYCLE_DAYS = 30;
  const RING_DOTS = 48;
  const RING_RADIUS = 52;
  const RING_CENTER = 60;

  function renderRing(daysLeft) {
    const svg = els.ringSvg;
    svg.innerHTML = "";
    const progress = Math.max(0, Math.min(1, daysLeft / RING_CYCLE_DAYS));
    const filledDots = Math.round(progress * RING_DOTS);

    for (let i = 0; i < RING_DOTS; i++) {
      const angle = (Math.PI * 2 * i) / RING_DOTS - Math.PI / 2;
      const x = RING_CENTER + RING_RADIUS * Math.cos(angle);
      const y = RING_CENTER + RING_RADIUS * Math.sin(angle);
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", x.toFixed(2));
      dot.setAttribute("cy", y.toFixed(2));
      dot.setAttribute("r", "2.6");
      dot.setAttribute("fill", i < filledDots ? "var(--accent-ink)" : "rgba(14,18,6,0.22)");
      svg.appendChild(dot);
    }
  }

  // ---------- подключение устройства: автоопределение ОС + рекомендуемые приложения ----------

  const PLATFORM_LABELS = { ios: "iOS", android: "Android", windows: "Windows" };

  const PLATFORM_APPS = {
    ios: ["incy", "happ"],
    android: ["happ"],
    windows: ["happ"],
    macos: ["happ"],
    linux: ["happ"],
    other: ["happ"],
  };

  const APP_INFO = {
    incy: {
      name: "INCY",
      scheme: "incy",
      recommended: true,
      storeUrls: { ios: "https://apps.apple.com/us/app/incy/id6756943388" },
      storeLabels: { ios: "App Store" },
    },
    happ: {
      name: "Happ",
      scheme: "happ",
      recommended: false,
      storeUrls: {
        ios: "https://apps.apple.com/us/app/happ-proxy-utility/id6504287215",
        android: "https://play.google.com/store/apps/details?id=com.happproxy",
        windows: "https://www.happ.su/main",
        macos: "https://www.happ.su/main",
        linux: "https://www.happ.su/main",
        other: "https://www.happ.su/main",
      },
      storeLabels: { ios: "App Store", android: "Google Play" },
    },
  };

  let connectPlatform = null;
  const connectSelectedApp = {};

  function detectPlatform() {
    const tgPlatform = tg && tg.platform;
    const ua = navigator.userAgent || "";
    if (tgPlatform === "ios" || /iPhone|iPad|iPod/.test(ua)) return "ios";
    if (tgPlatform === "android" || tgPlatform === "android_x" || /Android/.test(ua)) return "android";
    if (/Windows/.test(ua)) return "windows";
    if (/Macintosh|Mac OS X/.test(ua)) return "macos";
    if (/Linux/.test(ua)) return "linux";
    return "other";
  }

  function currentSubUrl() {
    return cachedProfile && cachedProfile.subscription && cachedProfile.subscription.subscription_url
      ? cachedProfile.subscription.subscription_url
      : null;
  }

  function renderConnectDevice() {
    if (!connectPlatform) connectPlatform = detectPlatform();
    const appIds = PLATFORM_APPS[connectPlatform] || PLATFORM_APPS.other;

    if (!connectSelectedApp[connectPlatform] || appIds.indexOf(connectSelectedApp[connectPlatform]) === -1) {
      const recommended = appIds.find((id) => APP_INFO[id].recommended);
      connectSelectedApp[connectPlatform] = recommended || appIds[0];
    }
    const appId = connectSelectedApp[connectPlatform];
    const app = APP_INFO[appId];

    els.connectAppSelect.innerHTML = "";
    if (appIds.length > 1) {
      els.connectAppSelect.classList.remove("hidden");
      appIds.forEach((id) => {
        const info = APP_INFO[id];
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "app-option" + (id === appId ? " active" : "");
        const nameSpan = document.createElement("span");
        nameSpan.textContent = info.name;
        opt.appendChild(nameSpan);
        if (info.recommended) {
          const badge = document.createElement("span");
          badge.className = "app-option-badge";
          badge.textContent = "рекомендуем";
          opt.appendChild(badge);
        }
        opt.onclick = () => {
          connectSelectedApp[connectPlatform] = id;
          renderConnectDevice();
        };
        els.connectAppSelect.appendChild(opt);
      });
    } else {
      els.connectAppSelect.classList.add("hidden");
    }

    const storeUrl = app.storeUrls[connectPlatform] || app.storeUrls.other || app.storeUrls.ios;
    const storeLabel = app.storeLabels[connectPlatform] || "Скачать";

    els.connectStepAppName.textContent =
      app.name + " — рекомендуемое приложение для " + (PLATFORM_LABELS[connectPlatform] || "вашего устройства");
    els.connectStoreBtn.textContent = "↗ " + storeLabel;
    els.connectStoreBtn.href = storeUrl;
    els.connectStoreBtn.onclick = (e) => {
      if (tg) {
        e.preventDefault();
        tg.openLink(storeUrl);
      }
    };

    const subUrl = currentSubUrl();
    els.connectAddSubBtn.disabled = !subUrl;
    els.connectAddSubBtn.textContent = subUrl ? "+ Добавить подписку" : "Сначала оформите подписку";
    els.connectAddSubBtn.onclick = () => {
      if (!subUrl) return;
      const deepLink = app.scheme + "://add/" + encodeURIComponent(subUrl);
      if (tg) {
        tg.openLink(deepLink);
      } else {
        window.location.href = deepLink;
      }
    };
  }

  els.connectOtherDeviceBtn.onclick = () => {
    if (!els.connectPlatformChips.classList.contains("hidden")) {
      els.connectPlatformChips.classList.add("hidden");
      return;
    }
    els.connectPlatformChips.classList.remove("hidden");
    els.connectPlatformChips.innerHTML = "";
    Object.keys(PLATFORM_LABELS).forEach((id) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (id === connectPlatform ? " active" : "");
      chip.textContent = PLATFORM_LABELS[id];
      chip.onclick = () => {
        connectPlatform = id;
        els.connectPlatformChips.classList.add("hidden");
        renderConnectDevice();
      };
      els.connectPlatformChips.appendChild(chip);
    });
  };

  // ---------- profile / subscription ----------

  let cachedPlans = [];
  let cachedProfile = null;
  let cachedDevices = null;

  function renderProfile(profile) {
    cachedProfile = profile;
    els.balance.textContent = Math.round(profile.balance) + " ₽";
    els.discount.textContent = profile.discount_percent > 0 ? profile.discount_percent + "%" : "нет";

    if (profile.discount_percent > 0) {
      els.discountChip.textContent = "-" + profile.discount_percent + "%";
      els.discountChip.classList.remove("hidden");
    } else {
      els.discountChip.classList.add("hidden");
    }

    const sub = profile.subscription;
    const active = !!(sub && sub.active);
    const days = active ? daysLeftFrom(sub.expires_at) : 0;

    els.daysLeft.textContent = active ? days : 0;
    renderRing(active ? days : 0);

    if (sub) {
      els.subPlanName.textContent = active ? "Подписка активна" : "Подписка истекла";
      els.subPlanDate.textContent = fmtDateShort(sub.expires_at);
      if (sub.subscription_url) {
        els.subUrlBlock.classList.remove("hidden");
        els.subUrl.textContent = sub.subscription_url;
        els.connectNoSub.classList.add("hidden");
      } else {
        els.subUrlBlock.classList.add("hidden");
        els.connectNoSub.classList.remove("hidden");
      }
    } else {
      els.subPlanName.textContent = "Нет подписки";
      els.subPlanDate.textContent = "Выберите тариф ниже";
      els.subUrlBlock.classList.add("hidden");
      els.connectNoSub.classList.remove("hidden");
    }

    renderAutoRenew(profile);
    renderAbout(profile);
    renderAccount(profile);
    renderConnectDevice();
  }

  function renderAbout(profile) {
    els.aboutName.textContent = profile.vpn_name || "VPN-сервис";
    els.aboutSupport.textContent = profile.support_username
      ? "По всем вопросам пишите: @" + profile.support_username
      : "Поддержка временно недоступна.";
  }

  function renderAccount(profile) {
    els.accountTgId.textContent = profile.tg_id != null ? String(profile.tg_id) : "—";
    els.accountUsername.textContent = profile.username ? "@" + profile.username : "—";
  }

  // Бэкенд в этой версии API не отдаёт поле автопродления явно.
  // Блок рассчитан на необязательное поле profile.auto_renew (true/false).
  // Пока бэкенд его не присылает — показываем нейтральный статус без переключателя,
  // чтобы не врать пользователю. Как только API станет отдавать auto_renew
  // (и появится эндпоинт POST /api/auto-renew), кнопка-переключатель включится сама.
  function renderAutoRenew(profile) {
    const hasField = typeof profile.auto_renew === "boolean";
    const sub = profile.subscription;
    const hasActiveSub = !!(sub && sub.active);

    if (!hasField) {
      els.autorenewDot.className = "autorenew-dot";
      els.autorenewSub.textContent = hasActiveSub
        ? "Продлевайте вручную на странице тарифов"
        : "Появится после активации тарифа";
      els.autorenewToggleBtn.classList.add("hidden");
      return;
    }

    const on = profile.auto_renew === true;
    els.autorenewDot.className = "autorenew-dot " + (on ? "on" : "off");
    els.autorenewSub.textContent = on ? "Включено — спишем с баланса автоматически" : "Выключено — продлевайте вручную";
    els.autorenewToggleBtn.textContent = on ? "Выключить" : "Включить";
    els.autorenewToggleBtn.className = "autorenew-toggle-btn" + (on ? " is-on" : "");
    els.autorenewToggleBtn.classList.remove("hidden");
    els.autorenewToggleBtn.onclick = () => toggleAutoRenew(!on);
  }

  async function toggleAutoRenew(nextValue) {
    try {
      await api("/api/auto-renew", { method: "POST", body: JSON.stringify({ enabled: nextValue }) });
      showToast(nextValue ? "Автопродление включено" : "Автопродление выключено");
      await refreshProfile();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  // Подписи способов оплаты — используются и на кнопках выбора, и в модалке подтверждения
  const PAY_METHOD_LABELS = {
    free: "🎁 Бесплатно (по скидке)",
    balance: "💰 С баланса",
    cryptobot: "💎 Крипта (CryptoBot)",
    platega: "💳 СБП (Platega)",
  };

  // ---------- экран подтверждения перед оплатой: товар — цена — кнопка «Оплатить» ----------
  let pendingPurchase = null; // { type: "plan", planCode, provider, extraQty } | { type: "devices", qty, provider }

  function openPayConfirm(plan, provider, priceText, extraQty) {
    extraQty = extraQty || 0;
    pendingPurchase = { type: "plan", planCode: plan.code, provider: provider, extraQty: extraQty };
    els.payModalPlanLabel.textContent = "Тариф";
    els.payModalPlan.textContent = plan.title + (extraQty ? " + " + extraQty + " устр." : "");
    els.payModalMethod.textContent = PAY_METHOD_LABELS[provider] || provider;
    els.payModalPrice.textContent = priceText;
    els.payModalConfirm.textContent = provider === "free" ? "Активировать" : "Оплатить";
    els.payModal.classList.remove("hidden");
  }

  function openDeviceConfirm(qty, provider, priceText) {
    pendingPurchase = { type: "devices", qty: qty, provider: provider };
    els.payModalPlanLabel.textContent = "Устройства";
    els.payModalPlan.textContent = "+" + qty;
    els.payModalMethod.textContent = PAY_METHOD_LABELS[provider] || provider;
    els.payModalPrice.textContent = priceText;
    els.payModalConfirm.textContent = "Оплатить";
    els.payModal.classList.remove("hidden");
  }

  function closePayConfirm() {
    pendingPurchase = null;
    els.payModal.classList.add("hidden");
  }

  els.payModalCancel.onclick = closePayConfirm;
  els.payModal.onclick = (e) => {
    if (e.target === els.payModal) closePayConfirm(); // клик по затемнению — тоже отмена
  };
  els.payModalConfirm.onclick = () => {
    if (!pendingPurchase) return;
    const pending = pendingPurchase;
    closePayConfirm();
    if (pending.type === "devices") {
      purchaseDevices(pending.qty, pending.provider);
    } else {
      purchase(pending.planCode, pending.provider, pending.extraQty || 0);
    }
  };

  function makeBtn(text, onClick, cls) {
    const btn = document.createElement("button");
    btn.className = "btn" + (cls ? " " + cls : "");
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  // ---------- модалка выбора тарифа: план -> ось доп. устройств -> способ оплаты ----------

  let planModalState = null; // { plan, deviceValues, selectedQty }

  function deviceWordLocal(qty) {
    const mod10 = qty % 10;
    const mod100 = qty % 100;
    if (mod10 === 1 && mod100 !== 11) return "устройство";
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "устройства";
    return "устройств";
  }

  function planModalTotals() {
    const { plan, selectedQty, baseLimit } = planModalState;
    const discount = cachedProfile ? cachedProfile.discount_percent : 0;
    const factor = discount > 0 ? Math.max(0, 1 - discount / 100) : 1;
    const planPriceRub = Math.round(plan.price_rub * factor);
    const planPriceUsdt = Math.round(plan.price_usdt * factor * 100) / 100;
    // n — выбранное на оси общее количество устройств, докупается (n - baseLimit) штук.
    // Цена доп. устройств считается по формуле (n - baseLimit) * price_за_устройство.
    const extraQty = Math.max(0, selectedQty - (baseLimit || 0));
    const devicePriceRub = cachedDevices ? Math.round(cachedDevices.price_rub * extraQty) : 0;
    const devicePriceUsdt = cachedDevices ? Math.round(cachedDevices.price_usdt * extraQty * 100) / 100 : 0;
    return {
      discount: discount,
      priceRub: planPriceRub + devicePriceRub,
      priceUsdt: Math.round((planPriceUsdt + devicePriceUsdt) * 100) / 100,
      extraQty: extraQty,
    };
  }

  // Рисует ось: линия + точки-остановки на значениях values, активная точка — selected.
  // onChange(value) вызывается при клике по точке.
  function renderDeviceTrack(container, values, selected, onChange) {
    container.innerHTML = "";
    const line = document.createElement("div");
    line.className = "device-track-line";
    container.appendChild(line);

    const lastIndex = values.length - 1;
    const selectedIndex = Math.max(0, values.indexOf(selected));

    const fill = document.createElement("div");
    fill.className = "device-track-fill";
    fill.style.width = (lastIndex > 0 ? (selectedIndex / lastIndex) * 100 : 0) + "%";
    container.appendChild(fill);

    values.forEach((val, i) => {
      const pct = lastIndex > 0 ? (i / lastIndex) * 100 : 0;
      const dot = document.createElement("div");
      dot.className = "device-dot" + (val === selected ? " active" : "");
      dot.style.left = pct + "%";
      dot.textContent = String(val);
      dot.onclick = () => onChange(val);
      container.appendChild(dot);
    });
  }

  function renderPlanModalSelectView() {
    const { plan, deviceValues, selectedQty } = planModalState;
    els.planModalTitle.textContent = plan.title;

    const totals = planModalTotals();
    if (totals.discount > 0) {
      els.planModalPrice.innerHTML =
        '<span class="old">' + plan.price_usdt + "$ / " + plan.price_rub + "₽</span> " +
        totals.priceUsdt + "$ / " + totals.priceRub + "₽";
    } else {
      els.planModalPrice.textContent = totals.priceUsdt + "$ / " + totals.priceRub + "₽";
    }

    els.planModalDevicesQty.textContent =
      totals.extraQty === 0
        ? "без доп. устройств"
        : "+" + totals.extraQty + " " + deviceWordLocal(totals.extraQty);

    renderDeviceTrack(els.planModalDots, deviceValues, selectedQty, (val) => {
      planModalState.selectedQty = val;
      renderPlanModalSelectView();
    });
  }

  function renderPlanModalMethods() {
    const { plan } = planModalState;
    const totals = planModalTotals();
    const isFree = totals.priceRub <= 0;
    const balanceEnough = cachedProfile && cachedProfile.balance >= totals.priceRub && !isFree;

    const priceText = (provider) =>
      provider === "balance" || provider === "platega" ? totals.priceRub + " ₽" : totals.priceUsdt + " USDT";

    const goConfirm = (provider) => {
      closePlanModal();
      openPayConfirm(plan, provider, priceText(provider), totals.extraQty);
    };

    els.planModalMethods.innerHTML = "";
    if (isFree) {
      els.planModalMethods.appendChild(makeBtn("🎁 Бесплатно", () => goConfirm("free")));
    } else {
      if (balanceEnough) {
        els.planModalMethods.appendChild(makeBtn("💰 С баланса", () => goConfirm("balance")));
      }
      els.planModalMethods.appendChild(makeBtn("💎 Крипта", () => goConfirm("cryptobot"), "secondary"));
      els.planModalMethods.appendChild(makeBtn("💳 СБП", () => goConfirm("platega"), "secondary"));
    }
  }

  function openPlanModal(plan) {
    // Базовый лимит устройств (уже включён в тариф, докупка не нужна) — приходит с бэкенда,
    // по умолчанию 3. Ось показывает общее количество устройств (n), а не докупаемое сверху.
    const baseLimit = cachedDevices && cachedDevices.base_device_limit != null ? cachedDevices.base_device_limit : 3;
    const deviceValues = [baseLimit].concat(cachedDevices ? cachedDevices.qty_presets : []);
    planModalState = { plan: plan, deviceValues: deviceValues, selectedQty: baseLimit, baseLimit: baseLimit };
    els.planModalSelectView.classList.remove("hidden");
    els.planModalMethodView.classList.add("hidden");
    renderPlanModalSelectView();
    els.planModal.classList.remove("hidden");
  }

  function closePlanModal() {
    planModalState = null;
    els.planModal.classList.add("hidden");
  }

  els.planModalCancel.onclick = closePlanModal;
  els.planModal.onclick = (e) => {
    if (e.target === els.planModal) closePlanModal();
  };
  els.planModalPay.onclick = () => {
    if (!planModalState) return;
    els.planModalSelectView.classList.add("hidden");
    els.planModalMethodView.classList.remove("hidden");
    renderPlanModalMethods();
  };
  els.planModalBack.onclick = () => {
    if (!planModalState) return;
    els.planModalMethodView.classList.add("hidden");
    els.planModalSelectView.classList.remove("hidden");
    renderPlanModalSelectView();
  };

  function renderPlans(plans) {
    cachedPlans = plans;
    els.plansList.innerHTML = "";
    const discount = cachedProfile ? cachedProfile.discount_percent : 0;

    plans.forEach((plan) => {
      const card = document.createElement("div");
      card.className = "plan-card";
      card.onclick = () => openPlanModal(plan);

      const title = document.createElement("div");
      title.className = "plan-title";
      title.textContent = plan.title;
      card.appendChild(title);

      const price = document.createElement("div");
      price.className = "plan-price";
      if (discount > 0) {
        const factor = Math.max(0, 1 - discount / 100);
        price.innerHTML =
          '<span class="old">' + plan.price_usdt + "$ / " + plan.price_rub + "₽</span> " +
          (Math.round(plan.price_usdt * factor * 100) / 100) + "$ / " + Math.round(plan.price_rub * factor) + "₽";
      } else {
        price.textContent = plan.price_usdt + "$ / " + plan.price_rub + "₽";
      }
      card.appendChild(price);
      els.plansList.appendChild(card);
    });
  }

  async function refreshProfile() {
    const profile = await api("/api/me");
    renderProfile(profile);
    if (cachedPlans.length) renderPlans(cachedPlans); // пересчитать цены со скидкой
    if (cachedDevices) renderDeviceButtons(cachedDevices); // пересчитать доступность оплаты с баланса
  }

  async function pollInvoice(invoiceId, onPaid) {
    showToast("Проверяем оплату…");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const result = await api("/api/invoice/" + invoiceId);
        if (result.status === "paid") {
          onPaid(result);
          return;
        }
      } catch (e) {
        showToast(e.message, true);
        return;
      }
    }
    showToast("Оплата пока не найдена. Если уже оплатили — подождите ещё немного и откройте кабинет заново.", true);
  }

  async function purchase(planCode, provider, extraQty) {
    extraQty = extraQty || 0;
    const devicesNote = extraQty ? " Устройства добавлены: +" + extraQty + "." : "";
    try {
      const result = await api("/api/purchase", {
        method: "POST",
        body: JSON.stringify({ plan_code: planCode, provider: provider, extra_devices_qty: extraQty }),
      });
      if (result.status === "granted") {
        showToast("✅ Доступ выдан!" + devicesNote);
        await refreshProfile();
        if (extraQty) await refreshDevices();
        return;
      }
      // status === "invoice"
      if (tg) tg.openLink(result.pay_url);
      pollInvoice(result.invoice_id, async () => {
        showToast("✅ Оплата подтверждена, доступ выдан!" + devicesNote);
        await refreshProfile();
        if (extraQty) await refreshDevices();
      });
    } catch (e) {
      showToast(e.message, true);
    }
  }

  // ---------- доп. услуга: докупить устройства ----------

  async function refreshDevices() {
    const devices = await api("/api/devices");
    renderDevices(devices);
  }

  function deviceWord(qty) {
    const mod10 = qty % 10;
    const mod100 = qty % 100;
    if (mod10 === 1 && mod100 !== 11) return "устройство";
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "устройства";
    return "устройств";
  }

  function deviceQtyButtons(qty, priceRub, priceUsdt) {
    const balanceEnough = cachedProfile && cachedProfile.balance >= priceRub;

    const wrap = document.createElement("div");
    wrap.className = "pay-methods";

    if (balanceEnough) {
      wrap.appendChild(
        makeBtn("💰 С баланса", () => openDeviceConfirm(qty, "balance", priceRub + " ₽"))
      );
    }
    wrap.appendChild(
      makeBtn("💎 Крипта", () => openDeviceConfirm(qty, "cryptobot", priceUsdt + " USDT"), "secondary")
    );
    wrap.appendChild(
      makeBtn("💳 СБП", () => openDeviceConfirm(qty, "platega", priceRub + " ₽"), "secondary")
    );
    return wrap;
  }

  function renderDeviceButtons(devices) {
    els.devicesPresets.innerHTML = "";
    (devices.qty_presets || []).forEach((qty) => {
      const priceRub = Math.round(devices.price_rub * qty);
      const priceUsdt = Math.round(devices.price_usdt * qty * 100) / 100;

      const card = document.createElement("div");
      card.className = "plan-card";

      const title = document.createElement("div");
      title.className = "plan-title";
      title.textContent = "+" + qty + " " + deviceWord(qty);
      card.appendChild(title);

      const price = document.createElement("div");
      price.className = "plan-price";
      price.textContent = priceUsdt + "$ / " + priceRub + "₽";
      card.appendChild(price);

      card.appendChild(deviceQtyButtons(qty, priceRub, priceUsdt));
      els.devicesPresets.appendChild(card);
    });
  }

  function renderDevices(devices) {
    cachedDevices = devices;
    els.devicesText.textContent = devices.message;
    renderDeviceButtons(devices);
  }

  async function purchaseDevices(qty, provider) {
    try {
      const result = await api("/api/devices/purchase", {
        method: "POST",
        body: JSON.stringify({ qty: qty, provider: provider }),
      });
      if (result.status === "granted") {
        showToast("✅ Устройства добавлены! Лимит: " + result.device_limit);
        await refreshDevices();
        return;
      }
      // status === "invoice"
      if (tg) tg.openLink(result.pay_url);
      pollInvoice(result.invoice_id, async (r) => {
        showToast("✅ Оплата подтверждена! Лимит устройств: " + r.device_limit);
        await refreshDevices();
      });
    } catch (e) {
      showToast(e.message, true);
    }
  }

  function renderTopupPresets(presets) {
    els.topupPresets.innerHTML = "";
    presets.forEach((amount) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.textContent = "+" + amount + "₽";
      chip.onclick = () => doTopup(amount);
      els.topupPresets.appendChild(chip);
    });
  }

  async function doTopup(amount) {
    if (!amount || amount < 10) {
      showToast("Минимальная сумма — 10 ₽", true);
      return;
    }
    try {
      const result = await api("/api/topup", { method: "POST", body: JSON.stringify({ amount: amount }) });
      if (tg) tg.openLink(result.pay_url);
      pollInvoice(result.invoice_id, async (r) => {
        showToast("✅ Баланс пополнен! Текущий баланс: " + Math.round(r.balance) + " ₽");
        await refreshProfile();
      });
    } catch (e) {
      showToast(e.message, true);
    }
  }

  els.topupBtn.onclick = () => doTopup(parseFloat(els.topupCustom.value));

  els.promoBtn.onclick = async () => {
    const code = els.promoInput.value.trim();
    if (!code) return;
    try {
      const result = await api("/api/promo", { method: "POST", body: JSON.stringify({ code: code }) });
      showToast(result.message);
      els.promoInput.value = "";
      await refreshProfile();
    } catch (e) {
      showToast(e.message, true);
    }
  };

  els.browserLogoutBtn.onclick = async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } catch (e) {
      /* сессия и так протухла/невалидна — всё равно чистим локально */
    }
    localStorage.removeItem(SESSION_STORAGE_KEY);
    window.location.href = window.location.pathname;
  };

  els.copySubUrl.onclick = () => {
    const text = els.subUrl.textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    showToast("Скопировано");
  };

  els.shareSubUrl.onclick = () => {
    const url = els.subUrl.textContent;
    if (!url) return;
    const shareText = "🐸 Моя VPN-подписка";
    const shareUrl = "https://t.me/share/url?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(shareText);
    if (tg) {
      tg.openTelegramLink(shareUrl);
    } else if (navigator.share) {
      navigator.share({ title: shareText, url: url }).catch(() => {});
    } else {
      if (navigator.clipboard) navigator.clipboard.writeText(url);
      showToast("Скопировано — отправьте ссылку вручную");
    }
  };

  function scrollToSection(el) {
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- страницы (нижняя навигация переключает их, без скролла по одной длинной странице) ----------

  const PAGE_IDS = ["top", "connect-device", "plans-title", "about-card"];
  const pageEls = {};
  PAGE_IDS.forEach((id) => {
    pageEls[id] = document.querySelector('.page[data-page="' + id + '"]');
  });

  const navIndicator = document.getElementById("nav-indicator");
  let currentNavTarget = null;

  function moveNavIndicator(skipAnim) {
    if (!navIndicator) return;
    const activeBtn = Array.from(els.navItems).find((b) => b.classList.contains("active"));
    if (!activeBtn) return;
    const x = activeBtn.offsetLeft;
    navIndicator.style.width = activeBtn.offsetWidth + "px";
    navIndicator.classList.toggle("no-anim", !!skipAnim);
    navIndicator.style.transform = "translateX(" + x + "px)";
    if (skipAnim) {
      // форсируем применение стилей без анимации, затем возвращаем transition
      void navIndicator.offsetWidth;
      navIndicator.classList.remove("no-anim");
    }
  }

  function setActiveNav(targetId, skipAnim) {
    if (targetId === currentNavTarget) return;
    currentNavTarget = targetId;
    els.navItems.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.target === targetId);
    });
    moveNavIndicator(skipAnim);
  }

  /**
   * Переключает видимую страницу. focusEl (необязательно) — элемент внутри
   * уже показанной страницы, к которому нужно проскроллить (используется
   * кнопками-шорткатами "Пополнить"/"Промокод"/"Управлять" с главной).
   */
  function switchPage(targetId, focusEl, skipAnim) {
    if (!PAGE_IDS.includes(targetId)) targetId = "top";

    PAGE_IDS.forEach((id) => {
      if (pageEls[id]) pageEls[id].classList.toggle("hidden", id !== targetId);
    });
    setActiveNav(targetId, skipAnim);

    if (focusEl) {
      requestAnimationFrame(() => focusEl.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      window.scrollTo({ top: 0, behavior: skipAnim ? "auto" : "smooth" });
    }
  }

  els.navItems.forEach((btn) => {
    btn.onclick = () => switchPage(btn.dataset.target);
  });

  window.addEventListener("resize", () => moveNavIndicator(true));

  els.manageBtn.onclick = () => switchPage("plans-title", els.plansTitle);
  els.topupShortcut.onclick = () => switchPage("plans-title", els.topupPresets);
  els.promoShortcut.onclick = () => switchPage("plans-title", els.promoTitle);

  function initialPageFromHash() {
    const hash = (window.location.hash || "").replace("#", "");
    return PAGE_IDS.includes(hash) ? hash : "top";
  }

  async function init() {
    if (!API_BASE_URL || API_BASE_URL.indexOf("example.com") !== -1) {
      els.loading.textContent = "Не настроен адрес API — отредактируйте config.js перед деплоем.";
      return;
    }

    const authOk = await ensureBrowserAuth();
    if (!authOk) {
      // если был login_token и обмен не удался, ensureBrowserAuth уже показал
      // текст ошибки — не затираем его общим экраном входа
      if (!incomingLoginToken) showBrowserLoginScreen();
      return;
    }

    try {
      const [profile, plansData, devices] = await Promise.all([
        api("/api/me"),
        api("/api/plans"),
        api("/api/devices"),
      ]);
      renderProfile(profile);
      renderPlans(plansData.plans);
      renderTopupPresets(plansData.topup_presets_rub);
      renderDevices(devices);

      els.loading.classList.add("hidden");
      els.main.classList.remove("hidden");
      els.bottomNav.classList.remove("hidden");

      // сразу показываем нужную страницу без анимации (переход из #loading,
      // индикатор ещё не имеет размеров до первого кадра — тот же приём,
      // что раньше использовался для moveNavIndicator(true))
      switchPage(initialPageFromHash(), null, true);
      requestAnimationFrame(() => moveNavIndicator(true));

      // кнопка "Выйти" нужна только для сессии обычного браузера — внутри
      // Telegram Mini App выходить не из чего, initData живёт сама по себе
      if (!initData && sessionToken) {
        els.browserLogoutBtn.classList.remove("hidden");
      }

      if (autoPromoCode) {
        redeemPromoFromStartParam(autoPromoCode);
      } else {
        showPromoPopupIfAny();
      }
    } catch (e) {
      els.loading.textContent = "Ошибка загрузки: " + e.message;
    }
  }

  init();
})();
