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

    plansTitle: document.getElementById("plans-title"),
    plansList: document.getElementById("plans-list"),

    topupPresets: document.getElementById("topup-presets"),
    topupCustom: document.getElementById("topup-custom"),
    topupBtn: document.getElementById("topup-btn"),

    promoTitle: document.getElementById("promo-title"),
    promoInput: document.getElementById("promo-input"),
    promoBtn: document.getElementById("promo-btn"),

    devicesText: document.getElementById("devices-text"),

    payModal: document.getElementById("pay-modal"),
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

  // ---------- profile / subscription ----------

  let cachedPlans = [];
  let cachedProfile = null;

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
    lava: "💳 Карта / СБП (LAVA)",
  };

  function planPayButtons(plan) {
    const discount = cachedProfile ? cachedProfile.discount_percent : 0;
    const factor = discount > 0 ? Math.max(0, 1 - discount / 100) : 1;
    const priceRub = Math.round(plan.price_rub * factor);
    const priceUsdt = Math.round(plan.price_usdt * factor * 100) / 100;
    const isFree = priceRub <= 0;
    const balanceEnough = cachedProfile && cachedProfile.balance >= priceRub && !isFree;

    const wrap = document.createElement("div");
    wrap.className = "pay-methods";

    const priceText = (provider) =>
      provider === "balance" || provider === "lava" ? priceRub + " ₽" : priceUsdt + " USDT";

    if (isFree) {
      wrap.appendChild(
        makeBtn("🎁 Бесплатно", () => openPayConfirm(plan, "free", "Бесплатно"))
      );
      return wrap;
    }

    if (balanceEnough) {
      wrap.appendChild(
        makeBtn("💰 С баланса", () => openPayConfirm(plan, "balance", priceText("balance")))
      );
    }
    wrap.appendChild(
      makeBtn("💎 Крипта", () => openPayConfirm(plan, "cryptobot", priceText("cryptobot")), "secondary")
    );
    wrap.appendChild(
      makeBtn("💳 LAVA", () => openPayConfirm(plan, "lava", priceText("lava")), "secondary")
    );
    return wrap;
  }

  // ---------- экран подтверждения перед оплатой: товар — цена — кнопка «Оплатить» ----------
  let pendingPurchase = null; // { planCode, provider }

  function openPayConfirm(plan, provider, priceText) {
    pendingPurchase = { planCode: plan.code, provider: provider };
    els.payModalPlan.textContent = plan.title;
    els.payModalMethod.textContent = PAY_METHOD_LABELS[provider] || provider;
    els.payModalPrice.textContent = priceText;
    els.payModalConfirm.textContent = provider === "free" ? "Активировать" : "Оплатить";
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
    const { planCode, provider } = pendingPurchase;
    closePayConfirm();
    purchase(planCode, provider);
  };

  function makeBtn(text, onClick, cls) {
    const btn = document.createElement("button");
    btn.className = "btn" + (cls ? " " + cls : "");
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  function renderPlans(plans) {
    cachedPlans = plans;
    els.plansList.innerHTML = "";
    const discount = cachedProfile ? cachedProfile.discount_percent : 0;

    plans.forEach((plan) => {
      const card = document.createElement("div");
      card.className = "plan-card";

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
      card.appendChild(planPayButtons(plan));
      els.plansList.appendChild(card);
    });
  }

  async function refreshProfile() {
    const profile = await api("/api/me");
    renderProfile(profile);
    if (cachedPlans.length) renderPlans(cachedPlans); // пересчитать цены со скидкой
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

  async function purchase(planCode, provider) {
    try {
      const result = await api("/api/purchase", {
        method: "POST",
        body: JSON.stringify({ plan_code: planCode, provider: provider }),
      });
      if (result.status === "granted") {
        showToast("✅ Доступ выдан!");
        await refreshProfile();
        return;
      }
      // status === "invoice"
      if (tg) tg.openLink(result.pay_url);
      pollInvoice(result.invoice_id, async () => {
        showToast("✅ Оплата подтверждена, доступ выдан!");
        await refreshProfile();
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
      els.devicesText.textContent = devices.message;

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