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

  // Вход/регистрация вынесены на отдельную страницу login.html
  // (оформление в стиле карточки Anthropic: почта + Telegram).
  function goToLoginPage() {
    window.location.replace("login" + window.location.search);
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
    showTgPopup("Промокод", promoPopupText);
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
    // Кнопка (inline-результат, ссылка в посте и т.д.) со startapp=promo_<CODE>
    // — статична и живёт вечно: каждое повторное открытие приложения по ней
    // будет снова нести тот же start_param. localStorage — best-effort кэш
    // (быстро подавляет повтор без похода в сеть), но не единственная линия
    // защиты: в некоторых режимах открытия Mini App (особенно из
    // inline-результата) localStorage между запусками может не сохраняться.
    // Поэтому источник истины — ответ бэкенда: если код уже был погашен
    // этим пользователем раньше (see database.db.redeem_promo_code —
    // уникальный PromoRedemption на пользователя), API вернёт ошибку
    // "уже использовали", и мы просто ничего не показываем — деньги в
    // любом случае не задваиваются, а лишний попап не нужен.
    const storageKey = "promo_startparam_shown:" + code;
    if (localStorage.getItem(storageKey)) return;
    try {
      localStorage.setItem(storageKey, "1");
    } catch (e) {
      // localStorage недоступен (приватный режим и т.п.) — не страшно,
      // ниже всё равно подстрахует проверка ответа бэкенда.
    }

    try {
      const result = await api("/api/promo", { method: "POST", body: JSON.stringify({ code: code }) });
      await refreshProfile();
      showTgPopup("Промокод", shortenForPopup(result.message));
    } catch (e) {
      const alreadyUsed = typeof e.message === "string" && e.message.indexOf("уже использовали") !== -1;
      if (alreadyUsed) return; // повторное открытие той же ссылки — молча ничего не делаем
      showTgPopup("Промокод", e.message);
    }
  }

  const els = {
    loading: document.getElementById("loading"),
    main: document.getElementById("screen-main"),


    balance: document.getElementById("balance"),
    discount: document.getElementById("discount"),
    discountScope: document.getElementById("discount-scope"),
    topupShortcut: document.getElementById("topup-shortcut"),
    promoShortcut: document.getElementById("promo-shortcut"),

    ringSvg: document.getElementById("ring-svg"),
    daysLeft: document.getElementById("days-left"),
    subPlanName: document.getElementById("sub-plan-name"),
    subPlanDate: document.getElementById("sub-plan-date"),
    manageBtn: document.getElementById("manage-btn"),

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
    devicesQtyLabel: document.getElementById("devices-qty-label"),
    devicesTrack: document.getElementById("devices-track"),
    devicesOpenBtn: document.getElementById("devices-open-btn"),
    devicesBack: document.getElementById("devices-back"),
    devicesList: document.getElementById("devices-list"),
    devicesCount: document.getElementById("devices-count"),
    devicesLimit: document.getElementById("devices-limit"),
    devicesSummaryHint: document.getElementById("devices-summary-hint"),
    devicesEmpty: document.getElementById("devices-empty"),
    devicesNote: document.getElementById("devices-note"),
    navAdmin: document.getElementById("nav-admin"),
    adminTiles: document.getElementById("admin-tiles"),
    adminNodes: document.getElementById("admin-nodes"),
    adminPromos: document.getElementById("admin-promos"),
    adminPromoCode: document.getElementById("admin-promo-code"),
    adminPromoType: document.getElementById("admin-promo-type"),
    adminPromoValue: document.getElementById("admin-promo-value"),
    adminPromoLimit: document.getElementById("admin-promo-limit"),
    adminPromoPlan: document.getElementById("admin-promo-plan"),
    adminPlanWrap: document.getElementById("admin-plan-wrap"),
    adminValueLabel: document.getElementById("admin-value-label"),
    adminPromoCreate: document.getElementById("admin-promo-create"),
    devicesResetBtn: document.getElementById("devices-reset-btn"),
    devicesResetConfirm: document.getElementById("devices-reset-confirm"),
    devicesResetCancel: document.getElementById("devices-reset-cancel"),
    devicesResetApply: document.getElementById("devices-reset-apply"),
    devicesPayMethods: document.getElementById("devices-pay-methods"),

    payModal: document.getElementById("pay-modal"),
    payModalPlanLabel: document.getElementById("pay-modal-plan-label"),
    payModalPlan: document.getElementById("pay-modal-plan"),
    payModalMethod: document.getElementById("pay-modal-method"),
    payModalPrice: document.getElementById("pay-modal-price"),
    payModalCancel: document.getElementById("pay-modal-cancel"),
    payModalConfirm: document.getElementById("pay-modal-confirm"),

    brandName: document.getElementById("brand-name"),
    aboutName: document.getElementById("about-name"),
    aboutSupport: document.getElementById("about-support"),
    browserLogoutBtn: document.getElementById("browser-logout-btn"),

    accountTgId: document.getElementById("account-tg-id"),
    accountUsername: document.getElementById("account-username"),
    tgLinkTitle: document.getElementById("tg-link-title"),
    tgLinkCard: document.getElementById("tg-link-card"),
    tgLinkBtn: document.getElementById("tg-link-btn"),
    emailHint: document.getElementById("email-hint"),
    emailBound: document.getElementById("email-bound"),
    emailBoundValue: document.getElementById("email-bound-value"),
    emailUnbindBtn: document.getElementById("email-unbind-btn"),
    emailBindForm: document.getElementById("email-bind-form"),
    emailBindInput: document.getElementById("email-bind-input"),
    emailBindSend: document.getElementById("email-bind-send"),
    emailCodeForm: document.getElementById("email-code-form"),
    emailCodeHint: document.getElementById("email-code-hint"),
    emailCodeInput: document.getElementById("email-code-input"),
    emailCodeConfirm: document.getElementById("email-code-confirm"),
    emailCodeCancel: document.getElementById("email-code-cancel"),

    bottomNav: document.getElementById("bottom-nav-wrap"),
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

  // Список на платформу, а не одно значение: так добавить второе приложение
  // будет правкой данных, а не логики. Сейчас всюду один Happ.
  const PLATFORM_APPS = {
    ios: ["happ"],
    android: ["happ"],
    windows: ["happ"],
    macos: ["happ"],
    linux: ["happ"],
    other: ["happ"],
  };

  const APP_INFO = {
    happ: {
      name: "Happ",
      scheme: "happ",
      recommended: true,
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
      // Сырой URL, без encodeURIComponent: на percent-encoded Happ отвечает
      // "Неизвестный протокол". Тот же формат отдаёт страница /import и
      // connect.html, через который идёт путь из Telegram.
      const deepLink = app.scheme + "://add/" + subUrl;
      if (tg) {
        // Telegram Mini App WebView не умеет открывать кастомные URI-схемы
        // (happ://) — ни через tg.openLink(), ни через обычный
        // window.location внутри себя (известное ограничение Telegram, см.
        // https://github.com/tdlib/telegram-bot-api/issues/299). Поэтому
        // открываем HTTPS-страницу connect.html — Telegram выпускает её во
        // внешний системный браузер, а тот уже без проблем понимает
        // кастомные схемы и передаёт их установленному приложению.
        const redirectUrl =
          window.location.origin +
          window.location.pathname.replace(/[^/]*$/, "") +
          "connect.html?scheme=" +
          encodeURIComponent(app.scheme) +
          "&url=" +
          encodeURIComponent(subUrl);
        tg.openLink(redirectUrl);
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
  let selectedDeviceQty = 0; // выбранное на оси "Докупить устройства" количество (0 = без доп. устройств)

  function renderProfile(profile) {
    cachedProfile = profile;
    els.balance.textContent = Math.round(profile.balance) + " ₽";
    // Вкладка «Админ» — только тем, кто в ADMIN_IDS. Это лишь показ: доступ
    // к данным закрыт на бэкенде, каждый админ-эндпоинт проверяет права сам.
    els.navAdmin.classList.toggle("hidden", !profile.is_admin);

    els.discount.textContent = profile.discount_percent > 0 ? profile.discount_percent + "%" : "нет";

    // Скидка может действовать только на один тариф — тогда так и пишем.
    // Без этой строки «Скидка 80%» на главной обещала бы больше, чем есть.
    const scopePlan = profile.discount_percent > 0 ? profile.discount_plan_code : null;
    if (scopePlan) {
      const plan = cachedPlans.filter((p) => p.code === scopePlan)[0];
      els.discountScope.textContent = "только «" + (plan ? plan.title : scopePlan) + "»";
      els.discountScope.classList.remove("hidden");
    } else {
      els.discountScope.classList.add("hidden");
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

    renderAbout(profile);
    renderAccount(profile);
    renderConnectDevice();
  }

  function renderAbout(profile) {
    els.aboutName.textContent = profile.vpn_name || "VPN-сервис";
    if (profile.vpn_name) els.brandName.textContent = profile.vpn_name;
    els.aboutSupport.textContent = profile.support_username
      ? "По всем вопросам пишите: @" + profile.support_username
      : "Поддержка временно недоступна.";
  }

  function renderAccount(profile) {
    els.accountTgId.textContent = profile.tg_id != null ? String(profile.tg_id) : "—";
    els.accountUsername.textContent = profile.username ? "@" + profile.username : "—";
    renderEmailSection(profile.email || null, profile.telegram_linked !== false);
    renderTelegramLink(profile);
  }

  // ---------- привязка Telegram к почтовому аккаунту ----------
  // Блок виден только у аккаунтов без Telegram (регистрация по почте) и только
  // в обычном браузере (внутри Mini App Telegram и так есть). Кнопка получает
  // одноразовую ссылку t.me/<bot>?start=linktg_<token>, открывает её, дальше
  // бот проставляет tg_id — а мы это замечаем поллингом /api/me.
  let tgLinkPollTimer = null;

  function renderTelegramLink(profile) {
    const canLink = !initData && profile.telegram_linked === false;
    els.tgLinkTitle.classList.toggle("hidden", !canLink);
    els.tgLinkCard.classList.toggle("hidden", !canLink);
    if (!canLink) stopTelegramLinkPoll();
  }

  // Сколько ждём подтверждения в боте, прежде чем прекратить поллинг. Токен
  // привязки живёт 15 минут (TELEGRAM_LINK_TOKEN_TTL_SECONDS), дольше опрашивать
  // бессмысленно — иначе брошенная вкладка вечно дёргает /api/me.
  const TG_LINK_POLL_MS = 3000;
  const TG_LINK_POLL_LIMIT = (15 * 60 * 1000) / TG_LINK_POLL_MS;

  function stopTelegramLinkPoll() {
    if (tgLinkPollTimer) clearInterval(tgLinkPollTimer);
    tgLinkPollTimer = null;
  }

  function resetTelegramLinkBtn() {
    els.tgLinkBtn.disabled = false;
    els.tgLinkBtn.textContent = "Привязать Telegram";
  }

  async function startTelegramLink() {
    els.tgLinkBtn.disabled = true;
    els.tgLinkBtn.textContent = "Готовим ссылку…";

    // Окно открываем СРАЗУ по клику, до запроса за ссылкой: после await
    // браузер считает window.open программным и блокирует его (заметнее всего
    // в Safari на iOS). Пустую вкладку потом переводим на нужный адрес, а если
    // её всё же заблокировали — показываем ссылку отдельной строкой.
    //
    // Без "noopener" намеренно: с ним window.open по спецификации возвращает
    // null, и ссылку было бы некуда подставить. Вместо этого рвём связь
    // вручную сразу после перехода.
    const popup = window.open("", "_blank");
    try {
      const data = await api("/api/link/telegram/start", { method: "POST" });
      if (popup && !popup.closed) {
        popup.location = data.deep_link;
        try {
          popup.opener = null;
        } catch (e) {
          /* некоторые браузеры не дают трогать opener — не критично */
        }
      } else {
        els.tgLinkCard.insertAdjacentHTML(
          "beforeend",
          '<div class="email-hint" style="margin-top:10px">Всплывающее окно заблокировано — ' +
            '<a href="' + data.deep_link + '" target="_blank" rel="noopener">откройте бота вручную</a>.</div>'
        );
      }
      els.tgLinkBtn.textContent = "Ждём подтверждения в боте…";
      stopTelegramLinkPoll();
      let ticks = 0;
      tgLinkPollTimer = setInterval(async () => {
        if (++ticks > TG_LINK_POLL_LIMIT) {
          stopTelegramLinkPoll();
          resetTelegramLinkBtn();
          return;
        }
        try {
          const me = await api("/api/me");
          if (me.telegram_linked) {
            stopTelegramLinkPoll();
            showToast("Telegram привязан", false);
            renderProfile(me);
          }
        } catch (e) {
          /* сеть/сессия — просто ждём следующего тика */
        }
      }, TG_LINK_POLL_MS);
    } catch (e) {
      // Ссылку получить не удалось — закрываем заранее открытую пустую вкладку,
      // иначе она так и повиснет с about:blank.
      if (popup && !popup.closed) popup.close();
      showToast(e.message, true);
      resetTelegramLinkBtn();
    }
  }

  // ---------- привязка почты ----------
  // Почта — второй способ входа в этот же аккаунт, а не отдельная учётка,
  // поэтому привязка доступна только отсюда: запрос уходит с уже действующей
  // авторизацией (initData или Bearer), и сервер знает, к какому tg_id вязать.

  // Адрес, на который отправлен код привязки. Нужен на шаге подтверждения:
  // поле ввода к этому моменту уже скрыто, а сервер сверяет код именно с ним.
  let pendingBindEmail = "";

  function renderEmailSection(email, canUnbind) {
    const bound = !!email;
    els.emailBound.classList.toggle("hidden", !bound);
    els.emailBoundValue.textContent = email || "—";
    // У почтового аккаунта без Telegram почта — единственный вход, отвязать её
    // нельзя (сервер вернёт 409). Прячем кнопку, чтобы не путать.
    els.emailUnbindBtn.classList.toggle("hidden", !canUnbind);
    els.emailHint.textContent = bound
      ? "По этой почте можно войти в кабинет в браузере без Telegram."
      : "Привяжите почту, чтобы входить в личный кабинет в браузере без Telegram.";
    // Формы привязки прячем, когда почта уже есть: сменить адрес = сначала
    // отвязать, иначе пришлось бы отдельно разбирать «перепривязку» и держать
    // в голове, какой из двух адресов сейчас действующий.
    els.emailBindForm.classList.toggle("hidden", bound);
    els.emailCodeForm.classList.add("hidden");
    els.emailCodeInput.value = "";
  }

  async function requestBindCode() {
    const email = (els.emailBindInput.value || "").trim();
    if (!email) {
      showToast("Введите адрес почты", true);
      return;
    }
    els.emailBindSend.disabled = true;
    els.emailBindSend.textContent = "Отправляем…";
    try {
      await api("/api/email/bind/request", {
        method: "POST",
        body: JSON.stringify({ email: email }),
      });
      pendingBindEmail = email;
      els.emailCodeHint.textContent = "Код отправлен на " + email;
      els.emailBindForm.classList.add("hidden");
      els.emailCodeForm.classList.remove("hidden");
      els.emailCodeInput.focus();
    } catch (e) {
      showToast(e.message, true);
    } finally {
      els.emailBindSend.disabled = false;
      els.emailBindSend.textContent = "Выслать код";
    }
  }

  async function confirmBindCode() {
    const code = (els.emailCodeInput.value || "").trim();
    if (!code) {
      showToast("Введите код из письма", true);
      return;
    }
    els.emailCodeConfirm.disabled = true;
    els.emailCodeConfirm.textContent = "Проверяем…";
    try {
      const result = await api("/api/email/bind/confirm", {
        method: "POST",
        body: JSON.stringify({ email: pendingBindEmail, code: code }),
      });
      renderEmailSection(result.email);
      showToast("Почта привязана");
    } catch (e) {
      showToast(e.message, true);
    } finally {
      els.emailCodeConfirm.disabled = false;
      els.emailCodeConfirm.textContent = "Подтвердить";
    }
  }

  async function unbindEmail() {
    els.emailUnbindBtn.disabled = true;
    try {
      await api("/api/email/unbind", { method: "POST" });
      els.emailBindInput.value = "";
      renderEmailSection(null);
      showToast("Почта отвязана");
    } catch (e) {
      showToast(e.message, true);
    } finally {
      els.emailUnbindBtn.disabled = false;
    }
  }

  els.emailBindSend.onclick = requestBindCode;
  els.emailCodeConfirm.onclick = confirmBindCode;
  els.emailUnbindBtn.onclick = unbindEmail;
  els.tgLinkBtn.onclick = startTelegramLink;
  els.emailCodeCancel.onclick = () => {
    els.emailCodeForm.classList.add("hidden");
    els.emailBindForm.classList.remove("hidden");
    els.emailCodeInput.value = "";
  };
  els.emailBindInput.onkeydown = (e) => {
    if (e.key === "Enter") requestBindCode();
  };
  els.emailCodeInput.onkeydown = (e) => {
    if (e.key === "Enter") confirmBindCode();
  };

  // Подписи способов оплаты — используются и на кнопках выбора, и в модалке подтверждения
  const PAY_METHOD_LABELS = {
    free: "Бесплатно (по скидке)",
    balance: "С баланса",
    cryptobot: "Крипта (CryptoBot)",
    platega: "СБП (Platega)",
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

  let planModalState = null; // { plan, deviceValues, selectedQty, currentLimit }

  function deviceWordLocal(qty) {
    const mod10 = qty % 10;
    const mod100 = qty % 100;
    if (mod10 === 1 && mod100 !== 11) return "устройство";
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "устройства";
    return "устройств";
  }

  function planModalTotals() {
    const { plan, selectedQty, currentLimit } = planModalState;
    // Именно discountForPlan, а не сырой процент из профиля: скидка может быть
    // привязана к другому тарифу, и тогда в модалке нельзя показывать цену со
    // скидкой — бэкенд посчитает полную.
    const discount = discountForPlan(plan);
    const factor = discount > 0 ? Math.max(0, 1 - discount / 100) : 1;
    const planPriceRub = Math.round(plan.price_rub * factor);
    const planPriceUsdt = Math.round(plan.price_usdt * factor * 100) / 100;
    // selectedQty — сколько устройств ДОКУПАЕТСЯ (на оси при этом написан
    // итоговый лимит currentLimit + selectedQty). Платят за докупку.
    const extraQty = Math.max(0, selectedQty);
    const devicePriceRub = cachedDevices ? Math.round(cachedDevices.price_rub * extraQty) : 0;
    const devicePriceUsdt = cachedDevices ? Math.round(cachedDevices.price_usdt * extraQty * 100) / 100 : 0;
    return {
      discount: discount,
      priceRub: planPriceRub + devicePriceRub,
      priceUsdt: Math.round((planPriceUsdt + devicePriceUsdt) * 100) / 100,
      extraQty: extraQty,
      totalDevices: currentLimit + extraQty,
    };
  }

  // Рисует ось: линия + точки-остановки на значениях values, активная точка — selected.
  // onChange(value) вызывается при клике по точке. labelFor(value) — что писать
  // в точке: на обеих осях выбирается количество ДОКУПАЕМЫХ устройств, а
  // подписаны точки итоговым лимитом, поэтому подпись и значение расходятся.
  function renderDeviceTrack(container, values, selected, onChange, labelFor) {
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
      dot.textContent = labelFor ? labelFor(val) : String(val);
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
        ? "сейчас " + planModalState.currentLimit
        : "+" + totals.extraQty + " " + deviceWordLocal(totals.extraQty) + " → всего " + totals.totalDevices;

    renderDeviceTrack(
      els.planModalDots,
      deviceValues,
      selectedQty,
      (val) => {
        planModalState.selectedQty = val;
        renderPlanModalSelectView();
      },
      (val) => String(planModalState.currentLimit + val)
    );
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
      els.planModalMethods.appendChild(makeBtn("Бесплатно", () => goConfirm("free")));
    } else {
      if (balanceEnough) {
        els.planModalMethods.appendChild(makeBtn("С баланса", () => goConfirm("balance")));
      }
      els.planModalMethods.appendChild(makeBtn("Крипта", () => goConfirm("cryptobot"), "secondary"));
      els.planModalMethods.appendChild(makeBtn("СБП", () => goConfirm("platega"), "secondary"));
    }
  }

  function openPlanModal(plan) {
    // Ось показывает ИТОГОВОЕ количество устройств, а выбирается и оплачивается
    // докупка сверх текущего лимита (нулевая точка = ничего не докупать).
    // Привязка к текущему лимиту, а не к базовым трём: тому, кто уже докупал,
    // шкала «3 4 6 8 10» показывала бы неправду.
    const currentLimit =
      cachedDevices && cachedDevices.device_limit != null ? cachedDevices.device_limit : 3;
    const deviceValues = [0].concat(cachedDevices ? cachedDevices.extra_presets || [] : []);
    planModalState = { plan: plan, deviceValues: deviceValues, selectedQty: 0, currentLimit: currentLimit };
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

  // Скидка может быть привязана к одному тарифу (discount_plan_code с бэкенда).
  // Тогда и бейдж, и пересчёт цены показываем только на его плашке — иначе
  // человек увидел бы «-80%» на всех и посчитал бы, что переплатил.
  function discountForPlan(plan) {
    if (!cachedProfile || !(cachedProfile.discount_percent > 0)) return 0;
    const boundTo = cachedProfile.discount_plan_code;
    if (boundTo && boundTo !== plan.code) return 0;
    return cachedProfile.discount_percent;
  }

  function renderPlans(plans) {
    cachedPlans = plans;
    els.plansList.innerHTML = "";

    plans.forEach((plan) => {
      const discount = discountForPlan(plan);

      const card = document.createElement("div");
      card.className = "plan-card" + (discount > 0 ? " has-discount" : "");
      card.onclick = () => openPlanModal(plan);

      if (discount > 0) {
        const badge = document.createElement("div");
        badge.className = "plan-discount";
        badge.textContent = "-" + discount + "%";
        card.appendChild(badge);
      }

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
        showToast("Доступ выдан!" + devicesNote);
        await refreshProfile();
        if (extraQty) await refreshDevices();
        return;
      }
      // status === "invoice"
      if (tg) tg.openLink(result.pay_url);
      pollInvoice(result.invoice_id, async () => {
        showToast("Оплата подтверждена, доступ выдан!" + devicesNote);
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
    const balance = cachedProfile ? cachedProfile.balance : 0;
    const balanceEnough = balance >= priceRub;

    const wrap = document.createElement("div");
    wrap.className = "pay-methods";

    // Кнопку показываем всегда. Раньше при нехватке она просто исчезала, и
    // это читалось как «оплаты с баланса тут не бывает» вместо «не хватает
    // столько-то». Кнопка с суммой отвечает на оба вопроса сразу и ведёт к пополнению.
    if (balanceEnough) {
      wrap.appendChild(
        makeBtn("С баланса", () => openDeviceConfirm(qty, "balance", priceRub + " ₽"))
      );
    } else {
      const short = Math.ceil(priceRub - balance);
      wrap.appendChild(
        makeBtn(
          "Пополнить на " + short + " ₽",
          () => switchPage("plans-title", els.topupPresets),
          "secondary"
        )
      );
    }
    wrap.appendChild(
      makeBtn("Крипта", () => openDeviceConfirm(qty, "cryptobot", priceUsdt + " USDT"), "secondary")
    );
    wrap.appendChild(
      makeBtn("СБП", () => openDeviceConfirm(qty, "platega", priceRub + " ₽"), "secondary")
    );
    return wrap;
  }

  // Ось "Докупить устройства": та же точечная шкала, что и в модалке тарифа
  // (renderDeviceTrack). На точках написан ИТОГОВЫЙ лимит устройств, а
  // выбирается и оплачивается разница с текущим — extra_presets с бэкенда.
  // Первая точка — то, что у пользователя уже есть (покупки нет), поэтому
  // шкала привязана к его текущему лимиту, а не к базовым трём: тому, кто
  // уже докупал, «3 4 6 8 10» показывало бы неправду.
  function renderDeviceButtons(devices) {
    const currentLimit = devices.device_limit;

    // Лимит 0 = без ограничений: докупать нечего, и подписи вида "0, 1, 3"
    // были бы бессмыслицей.
    if (currentLimit <= 0) {
      els.devicesTrack.innerHTML = "";
      els.devicesQtyLabel.textContent = "без ограничений";
      els.devicesPayMethods.classList.add("hidden");
      els.devicesPayMethods.innerHTML = "";
      return;
    }

    const values = [0].concat(devices.extra_presets || []);
    if (values.indexOf(selectedDeviceQty) === -1) selectedDeviceQty = 0;

    renderDeviceTrack(
      els.devicesTrack,
      values,
      selectedDeviceQty,
      (val) => {
        selectedDeviceQty = val;
        renderDeviceButtons(cachedDevices);
      },
      (val) => String(currentLimit + val)
    );

    els.devicesQtyLabel.textContent =
      selectedDeviceQty === 0
        ? "сейчас " + currentLimit
        : "+" + selectedDeviceQty + " " + deviceWord(selectedDeviceQty) + " → всего " + (currentLimit + selectedDeviceQty);

    if (selectedDeviceQty === 0) {
      els.devicesPayMethods.classList.add("hidden");
      els.devicesPayMethods.innerHTML = "";
      return;
    }

    const priceRub = Math.round(devices.price_rub * selectedDeviceQty);
    const priceUsdt = Math.round(devices.price_usdt * selectedDeviceQty * 100) / 100;
    els.devicesPayMethods.innerHTML = "";
    els.devicesPayMethods.appendChild(deviceQtyButtons(selectedDeviceQty, priceRub, priceUsdt));
    els.devicesPayMethods.classList.remove("hidden");
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
        showToast("Устройства добавлены! Лимит: " + result.device_limit);
        await refreshDevices();
        return;
      }
      // status === "invoice"
      if (tg) tg.openLink(result.pay_url);
      pollInvoice(result.invoice_id, async (r) => {
        showToast("Оплата подтверждена! Лимит устройств: " + r.device_limit);
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
        showToast("Баланс пополнен! Текущий баланс: " + Math.round(r.balance) + " ₽");
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
    const shareText = "Моя VPN-подписка";
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

  // ---------- страница «Устройства» ----------

  function formatSeen(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 2) return "только что";
    if (diffMin < 60) return diffMin + " мин назад";
    if (diffMin < 60 * 24) return Math.floor(diffMin / 60) + " ч назад";
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  // id устройства, у которого сейчас открыто поле переименования. Хранится
  // отдельно от DOM: список перерисовывается целиком после каждого действия.
  let renamingDeviceId = null;

  function renderDevicesPage(devices) {
    const list = els.devicesList;
    list.innerHTML = "";

    // Счётчик — сколько устройств знает подписку, все подряд и независимо от
    // того, когда каждое заходило в последний раз. Лимит же считает НОДА и
    // считает другое — одновременные соединения. Смешивать их в одной строке
    // («4 из 3 одновременно») нельзя: получается, что лимит нарушен, хотя
    // одновременно работающих могло быть и два.
    const active = devices.filter((d) => !d.blocked).length;
    els.devicesCount.textContent = active;
    els.devicesLimit.textContent = deviceWord(active);

    const limit = cachedDevices ? cachedDevices.device_limit : 0;
    const blocked = devices.length - active;
    const hint = [];
    hint.push(
      limit > 0
        ? "Одновременно работают не больше " + limit + " — остальные подключатся, когда освободится место."
        : "Ограничения по числу подключений нет."
    );
    if (blocked) {
      hint.push("Отключено: " + blocked + " — можно включить обратно.");
    }
    els.devicesSummaryHint.textContent = hint.join(" ");

    els.devicesEmpty.classList.toggle("hidden", devices.length > 0);
    els.devicesNote.classList.toggle("hidden", devices.length === 0);

    devices.forEach((device) => {
      const card = document.createElement("div");
      card.className = "device-card" + (device.blocked ? " is-blocked" : "");

      const body = document.createElement("div");
      body.className = "device-body";

      const name = document.createElement("div");
      name.className = "device-name";
      name.textContent = device.name;
      body.appendChild(name);

      // Приложение — отдельной строкой под названием устройства: "Happ" и
      // "Hiddify" это программы, а не устройства, и в заголовке им не место.
      const meta = document.createElement("div");
      meta.className = "device-meta";
      const parts = [device.client_name, formatSeen(device.last_seen_at)];
      if (device.ip_address) parts.push(device.ip_address);
      meta.textContent = parts.join(" · ");
      body.appendChild(meta);

      if (device.blocked) {
        const badge = document.createElement("div");
        badge.className = "device-badge blocked";
        badge.textContent = "отключено";
        body.appendChild(badge);
      } else if (!device.identified_by_hwid) {
        // Клиент не прислал X-Hwid: строка опознана лишь по имени приложения,
        // и два устройства с ним склеятся в одно. Молчать об этом нельзя —
        // человек решит, что видит полный список.
        const badge = document.createElement("div");
        badge.className = "device-badge";
        badge.textContent = "приложение целиком";
        body.appendChild(badge);
      }

      if (renamingDeviceId === device.id) {
        const form = document.createElement("div");
        form.className = "device-rename";
        const input = document.createElement("input");
        input.className = "input";
        input.maxLength = 40;
        input.value = device.custom_name || "";
        input.placeholder = device.auto_name;
        const save = document.createElement("button");
        save.className = "device-btn accent";
        save.textContent = "ОК";
        save.onclick = () => renameDevice(device.id, input.value);
        input.onkeydown = (e) => {
          if (e.key === "Enter") renameDevice(device.id, input.value);
          if (e.key === "Escape") {
            renamingDeviceId = null;
            renderDevicesPage(devices);
          }
        };
        form.appendChild(input);
        form.appendChild(save);
        body.appendChild(form);
        setTimeout(() => input.focus(), 0);
      }

      card.appendChild(body);

      const actions = document.createElement("div");
      actions.className = "device-actions";

      const renameBtn = document.createElement("button");
      renameBtn.className = "device-btn";
      renameBtn.textContent = renamingDeviceId === device.id ? "Отмена" : "Имя";
      renameBtn.onclick = () => {
        renamingDeviceId = renamingDeviceId === device.id ? null : device.id;
        renderDevicesPage(devices);
      };
      actions.appendChild(renameBtn);

      const toggle = document.createElement("button");
      toggle.className = "device-btn" + (device.blocked ? " accent" : " danger");
      toggle.textContent = device.blocked ? "Включить" : "Отключить";
      toggle.onclick = () => setDeviceBlocked(device.id, !device.blocked);
      actions.appendChild(toggle);

      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  async function refreshDevicesPage() {
    const data = await api("/api/devices");
    cachedDevices = data;
    renderDevicesPage(data.devices || []);
  }

  async function setDeviceBlocked(deviceId, blocked) {
    try {
      await api("/api/devices/block", {
        method: "POST",
        body: JSON.stringify({ device_id: deviceId, blocked: blocked }),
      });
      showToast(blocked ? "Отключено — конфигурация пропадёт в течение часа" : "Включено обратно");
      renamingDeviceId = null;
      await refreshDevicesPage();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  async function renameDevice(deviceId, name) {
    try {
      await api("/api/devices/rename", {
        method: "POST",
        body: JSON.stringify({ device_id: deviceId, name: name }),
      });
      renamingDeviceId = null;
      await refreshDevicesPage();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  function showResetConfirm(show) {
    els.devicesResetConfirm.classList.toggle("hidden", !show);
    els.devicesResetBtn.classList.toggle("hidden", show);
  }

  async function resetAllDevices() {
    els.devicesResetApply.disabled = true;
    try {
      await api("/api/devices/reset", { method: "POST", body: JSON.stringify({}) });
      showToast("Все устройства отключены — ссылка обновлена");
      showResetConfirm(false);
      renamingDeviceId = null;
      // Профиль тоже: ссылка-подписка сменилась, а её показывает страница
      // подключения — иначе там осталась бы мёртвая.
      await refreshProfile();
      await refreshDevicesPage();
    } catch (e) {
      showToast(e.message, true);
    } finally {
      els.devicesResetApply.disabled = false;
    }
  }

  els.devicesResetBtn.onclick = () => showResetConfirm(true);
  els.devicesResetCancel.onclick = () => showResetConfirm(false);
  els.devicesResetApply.onclick = resetAllDevices;

  els.devicesOpenBtn.onclick = () => {
    switchPage("devices");
    showResetConfirm(false);
    // Список мог устареть с прошлого открытия: устройство могло прийти за
    // подпиской, пока человек ходил по другим страницам.
    refreshDevicesPage().catch((e) => showToast(e.message, true));
  };
  els.devicesBack.onclick = () => switchPage("about-card");

  // ---------- админ-панель ----------

  let adminPromoType = "days";

  // Порог, а не градиент: «почти полка» должно читаться с одного взгляда.
  function meterLevel(v) {
    if (v >= 85) return "crit";
    if (v >= 65) return "warn";
    return "";
  }

  function adminTile(label, value, suffix) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const k = document.createElement("div");
    k.className = "stat-k";
    k.textContent = label;
    const v = document.createElement("div");
    v.className = "stat-v";
    v.textContent = value;
    if (suffix) {
      const small = document.createElement("small");
      small.textContent = suffix;
      v.appendChild(small);
    }
    tile.appendChild(k);
    tile.appendChild(v);
    return tile;
  }

  function renderAdminTiles(totals) {
    const box = els.adminTiles;
    box.innerHTML = "";
    box.appendChild(adminTile("Соединений", totals.connections));
    box.appendChild(adminTile("Активных подписок", totals.subs));
    box.appendChild(adminTile("Пользователей", totals.users));
    box.appendChild(adminTile("Ноды онлайн", totals.nodes_up, " / " + totals.nodes_total));
  }

  function nodeStatRow(label, value, unit, fillPercent) {
    const row = document.createElement("div");
    row.className = "node-stat";

    const name = document.createElement("span");
    name.textContent = label;
    row.appendChild(name);

    const meter = document.createElement("span");
    meter.className = "meter";
    const fill = document.createElement("i");
    fill.className = meterLevel(fillPercent);
    fill.style.width = Math.max(0, Math.min(100, fillPercent)) + "%";
    meter.appendChild(fill);
    row.appendChild(meter);

    const num = document.createElement("b");
    num.textContent = value + unit;
    row.appendChild(num);
    return row;
  }

  function renderAdminNodes(nodes) {
    const box = els.adminNodes;
    box.innerHTML = "";

    if (!nodes.length) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.innerHTML = '<div class="email-hint">Нод в базе нет — подписка отдаётся по запасному списку из .env.</div>';
      box.appendChild(empty);
      return;
    }

    nodes.forEach((n) => {
      const card = document.createElement("div");
      card.className = "node-card";

      const head = document.createElement("div");
      head.className = "node-head";

      const body = document.createElement("div");
      body.style.flex = "1";
      body.style.minWidth = "0";
      const name = document.createElement("div");
      name.className = "node-name";
      name.textContent = n.name;
      const host = document.createElement("div");
      host.className = "node-host";
      host.textContent = n.protocol + " · " + n.host;
      body.appendChild(name);
      body.appendChild(host);
      head.appendChild(body);

      const state = document.createElement("span");
      state.className = "node-state" + (n.up ? "" : " down");
      state.textContent = n.up ? "online" : n.state || "offline";
      head.appendChild(state);
      card.appendChild(head);

      if (n.up && n.stats_at) {
        // conns — абсолютное число, шкалы у него нет. Делим на 6 просто чтобы
        // полоска отражала порядок величины: 600 соединений = полка.
        if (n.cpu != null) card.appendChild(nodeStatRow("CPU", n.cpu, "%", n.cpu));
        if (n.mem != null) card.appendChild(nodeStatRow("RAM", n.mem, "%", n.mem));
        if (n.conns != null) card.appendChild(nodeStatRow("Conn", n.conns, "", n.conns / 6));
      } else if (n.up) {
        const hint = document.createElement("div");
        hint.className = "node-host";
        hint.textContent = "Мастер-сервер ещё не присылал нагрузку по этой ноде.";
        card.appendChild(hint);
      } else {
        const hint = document.createElement("div");
        hint.className = "node-down-hint";
        hint.textContent = "Нода не отвечает — из подписок исключена.";
        card.appendChild(hint);
      }

      box.appendChild(card);
    });
  }

  function promoValueText(p) {
    if (p.type === "days") return "+" + Math.round(p.value) + " " + dayWord(Math.round(p.value));
    if (p.type === "balance") return "+" + Math.round(p.value) + " ₽ на баланс";
    return "скидка " + Math.round(p.value) + "%";
  }

  function dayWord(n) {
    if (n % 10 === 1 && n % 100 !== 11) return "день";
    if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return "дня";
    return "дней";
  }

  function renderAdminPromos(promos) {
    const box = els.adminPromos;
    box.innerHTML = "";

    if (!promos.length) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.innerHTML = '<div class="email-hint">Промокодов пока нет.</div>';
      box.appendChild(empty);
      return;
    }

    promos.forEach((p) => {
      const card = document.createElement("div");
      card.className = "promo-card" + (p.active ? "" : " is-off");

      const body = document.createElement("div");
      body.className = "promo-body";

      const code = document.createElement("div");
      code.className = "promo-code";
      code.textContent = p.code;
      body.appendChild(code);

      const parts = [promoValueText(p)];
      parts.push(p.limit ? p.used + " из " + p.limit : "использован " + p.used + " раз");
      if (p.plan_code) parts.push("тариф " + p.plan_code);
      if (!p.active) parts.push("выключен");
      const sub = document.createElement("div");
      sub.className = "promo-sub";
      sub.textContent = parts.join(" · ");
      body.appendChild(sub);

      card.appendChild(body);

      if (p.active) {
        const off = document.createElement("button");
        off.className = "device-btn danger";
        off.textContent = "Выключить";
        off.onclick = () => disablePromo(p.code);
        card.appendChild(off);
      }

      box.appendChild(card);
    });
  }

  function renderAdminPromoForm() {
    // Подпись поля и видимость привязки к тарифу зависят от типа: у «дней» и
    // «баланса» привязывать нечего — скидки там нет.
    const isDiscount = adminPromoType === "discount";
    els.adminValueLabel.textContent =
      adminPromoType === "days" ? "Дней" : adminPromoType === "balance" ? "Сумма, ₽" : "Скидка, %";
    els.adminPromoValue.placeholder = adminPromoType === "days" ? "30" : adminPromoType === "balance" ? "300" : "25";
    els.adminPlanWrap.classList.toggle("hidden", !isDiscount);

    Array.prototype.forEach.call(els.adminPromoType.children, (btn) => {
      btn.classList.toggle("active", btn.dataset.type === adminPromoType);
    });

    if (isDiscount && !els.adminPromoPlan.options.length) {
      const any = document.createElement("option");
      any.value = "";
      any.textContent = "любой тариф";
      els.adminPromoPlan.appendChild(any);
      cachedPlans.forEach((plan) => {
        const opt = document.createElement("option");
        opt.value = plan.code;
        opt.textContent = plan.title;
        els.adminPromoPlan.appendChild(opt);
      });
    }
  }

  async function refreshAdmin() {
    const data = await api("/api/admin/overview");
    renderAdminTiles(data.totals);
    renderAdminNodes(data.nodes || []);
    renderAdminPromos(data.promos || []);
    renderAdminPromoForm();
  }

  async function createPromo() {
    const code = els.adminPromoCode.value.trim();
    const value = els.adminPromoValue.value.trim();
    if (!code) {
      showToast("Введите код", true);
      return;
    }
    if (!value) {
      showToast("Введите значение", true);
      return;
    }

    els.adminPromoCreate.disabled = true;
    try {
      await api("/api/admin/promo", {
        method: "POST",
        body: JSON.stringify({
          code: code,
          type: adminPromoType,
          value: Number(value),
          limit: els.adminPromoLimit.value.trim() || null,
          plan_code: adminPromoType === "discount" ? els.adminPromoPlan.value || null : null,
        }),
      });
      showToast("Промокод " + code.toUpperCase() + " создан");
      els.adminPromoCode.value = "";
      els.adminPromoValue.value = "";
      els.adminPromoLimit.value = "";
      await refreshAdmin();
    } catch (e) {
      showToast(e.message, true);
    } finally {
      els.adminPromoCreate.disabled = false;
    }
  }

  async function disablePromo(code) {
    try {
      await api("/api/admin/promo/disable", { method: "POST", body: JSON.stringify({ code: code }) });
      showToast("Промокод " + code + " выключен");
      await refreshAdmin();
    } catch (e) {
      showToast(e.message, true);
    }
  }

  els.adminPromoType.onclick = (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    adminPromoType = btn.dataset.type;
    renderAdminPromoForm();
  };
  els.adminPromoCreate.onclick = createPromo;

  // ---------- страницы (нижняя навигация переключает их, без скролла по одной длинной странице) ----------

  const PAGE_IDS = ["top", "connect-device", "plans-title", "about-card", "devices", "admin"];
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
    // Ширина едет вместе с положением: вкладки теперь разной ширины из-за
    // подписей, и индикатор фиксированного размера промахивался бы мимо.
    // Отсчёт от левого края панели, а не от края кнопки: у индикатора
    // left: 6px, ровно как внутренний отступ .bottom-nav.
    const x = activeBtn.offsetLeft - 6;
    navIndicator.style.width = activeBtn.offsetWidth + "px";
    navIndicator.classList.toggle("no-anim", !!skipAnim);
    navIndicator.style.transform = "translateX(" + x + "px)";
    if (skipAnim) {
      // форсируем применение стилей без анимации, затем возвращаем transition
      void navIndicator.offsetWidth;
      navIndicator.classList.remove("no-anim");
    }
  }

  // Подстраницы, у которых нет своей вкладки в навбаре: пока мы на них,
  // подсвеченной остаётся вкладка родителя — иначе индикатор повисает между
  // кнопками и ни одна не выглядит активной.
  const NAV_PARENT = { devices: "about-card" };

  function setActiveNav(targetId, skipAnim) {
    targetId = NAV_PARENT[targetId] || targetId;
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
  // Длительность перехода берём из CSS (--page-anim), а не дублируем числом:
  // раньше JS ждал 170мс, а CSS анимировал 180мс, и любая правка одного из
  // значений молча рассинхронизировала второе.
  const PAGE_ANIM_MS = (() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--page-anim").trim();
    const ms = raw.endsWith("ms") ? parseFloat(raw) : parseFloat(raw) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : 190;
  })();

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Незавершённый переход. Быстрые тапы по навбару раньше накладывались друг на
  // друга: два независимых setTimeout могли переплестись и оставить страницу
  // скрытой или сдвинутой. Теперь новый переход сначала мгновенно доигрывает
  // предыдущий.
  let pending = null;

  function settlePending() {
    if (!pending) return;
    const { outgoing, incoming, timer } = pending;
    pending = null;
    window.clearTimeout(timer);

    outgoing.classList.add("hidden");
    outgoing.classList.remove("page-leaving");
    outgoing.style.removeProperty("top");
    outgoing.style.removeProperty("left");
    outgoing.style.removeProperty("width");
    outgoing.style.removeProperty("--slide-mult");

    incoming.classList.remove("page-enter");
    incoming.style.removeProperty("--slide-mult");
  }

  /**
   * Переключает видимую страницу. focusEl (необязательно) — элемент внутри
   * уже показанной страницы, к которому нужно проскроллить (используется
   * кнопками-шорткатами "Пополнить"/"Промокод"/"Управлять" с главной).
   */
  function switchPage(targetId, focusEl, skipAnim) {
    if (!PAGE_IDS.includes(targetId)) targetId = "top";

    settlePending();

    const currentId = PAGE_IDS.find((id) => pageEls[id] && !pageEls[id].classList.contains("hidden"));
    const instant = skipAnim || reducedMotion.matches;

    // Без анимации: первая загрузка страницы, переключение уже на текущую же
    // вкладку, либо системная настройка "уменьшить движение".
    if (instant || !currentId || currentId === targetId || !pageEls[currentId] || !pageEls[targetId]) {
      PAGE_IDS.forEach((id) => {
        if (pageEls[id]) pageEls[id].classList.toggle("hidden", id !== targetId);
      });
      setActiveNav(targetId, skipAnim);
      scrollAfterSwitch(focusEl, true);
      return;
    }

    // Плавный слайд: уходящая страница сдвигается в сторону движения по
    // навбару (влево при переходе "вперёд", вправо — "назад"), новая заезжает
    // с противоположной стороны. Обе анимируются ОДНОВРЕМЕННО: уходящая на
    // время перехода выводится из потока, поэтому приходящая сразу занимает её
    // место и задаёт высоту контейнера. Раньше переходы шли последовательно
    // (сначала 170мс на уход, потом 180мс на приход) — отсюда и ощущение
    // задержки при переключении вкладок.
    const outgoing = pageEls[currentId];
    const incoming = pageEls[targetId];
    const dir = PAGE_IDS.indexOf(targetId) > PAGE_IDS.indexOf(currentId) ? 1 : -1;

    setActiveNav(targetId, skipAnim);

    // Замер ДО вывода из потока: flex-элемент, став position: absolute,
    // схлопнулся бы по ширине контента и дёрнулся вбок перед уходом.
    const top = outgoing.offsetTop;
    const left = outgoing.offsetLeft;
    const width = outgoing.offsetWidth;

    outgoing.style.top = top + "px";
    outgoing.style.left = left + "px";
    outgoing.style.width = width + "px";
    outgoing.style.setProperty("--slide-mult", -dir);
    outgoing.classList.add("page-leaving");

    incoming.style.setProperty("--slide-mult", dir);
    incoming.classList.add("page-enter");
    incoming.classList.remove("hidden");

    // Скроллим сразу и мгновенно: контент в этот момент всё равно перекрыт
    // анимацией, а smooth-скролл поверх перехода растягивал его ещё на
    // несколько сотен миллисекунд.
    scrollAfterSwitch(focusEl, true);

    // Два кадра: первый — чтобы браузер зафиксировал стартовое состояние
    // (снятый hidden + page-enter), второй — чтобы снятие класса стало
    // отдельным изменением и transition реально сыграл.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!pending) return;
        incoming.classList.remove("page-enter");
      });
    });

    // transitionend как основной сигнал, таймер — страховка: событие не придёт,
    // если вкладка ушла в фон или переход был прерван.
    const onEnd = (e) => {
      if (e.target !== outgoing) return;
      outgoing.removeEventListener("transitionend", onEnd);
      settlePending();
    };
    outgoing.addEventListener("transitionend", onEnd);

    pending = {
      outgoing,
      incoming,
      timer: window.setTimeout(() => {
        outgoing.removeEventListener("transitionend", onEnd);
        settlePending();
      }, PAGE_ANIM_MS + 60),
    };
  }

  function scrollAfterSwitch(focusEl, instant) {
    if (focusEl) {
      requestAnimationFrame(() => focusEl.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      window.scrollTo({ top: 0, behavior: instant ? "auto" : "smooth" });
    }
  }

  els.navItems.forEach((btn) => {
    btn.onclick = () => {
      switchPage(btn.dataset.target);
      // Сводка админа живая: соединения и нагрузка нод меняются между
      // заходами, кешировать её смысла нет.
      if (btn.dataset.target === "admin") {
        refreshAdmin().catch((e) => showToast(e.message, true));
      }
    };
  });

  window.addEventListener("resize", () => moveNavIndicator(true));

  els.manageBtn.onclick = () => switchPage("plans-title", els.plansTitle);
  els.topupShortcut.onclick = () => switchPage("plans-title", els.topupPresets);
  els.promoShortcut.onclick = () => switchPage("plans-title", els.promoTitle);

  function initialPageFromHash() {
    const params = new URLSearchParams(window.location.search);
    const pageParam = params.get("page");
    if (pageParam && PAGE_IDS.includes(pageParam)) return pageParam;
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
      if (!incomingLoginToken) goToLoginPage();
      return;
    }

    try {
      const [profile, plansData, devices] = await Promise.all([
        api("/api/me"),
        api("/api/plans"),
        api("/api/devices"),
      ]);
      // Порядок важен: подпись «только «12 месяцев»» под скидкой берёт
      // название тарифа из cachedPlans, поэтому планы кладём в кэш до
      // отрисовки профиля — иначе в подписи окажется код вместо названия.
      cachedPlans = plansData.plans;
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
      // Протухшая браузерная сессия: api() при 401 уже вычистил токен и обнулил
      // sessionToken — отправляем на страницу входа, а не показываем ошибку.
      if (!initData && !sessionToken) {
        goToLoginPage();
        return;
      }
      els.loading.textContent = "Ошибка загрузки: " + e.message;
    }
  }

  init();
})();
