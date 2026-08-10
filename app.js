(function () {
  "use strict";

  const API_BASE_URL = (window.__API_BASE_URL__ || "").replace(/\/$/, "");
  const tg = window.Telegram && window.Telegram.WebApp;

  if (tg) {
    tg.ready();
    tg.expand();
  }

  const initData = tg ? tg.initData : "";

  const els = {
    loading: document.getElementById("loading"),
    main: document.getElementById("screen-main"),
    balance: document.getElementById("balance"),
    discount: document.getElementById("discount"),
    subExpiry: document.getElementById("sub-expiry"),
    subUrlBlock: document.getElementById("sub-url-block"),
    subUrl: document.getElementById("sub-url"),
    copySubUrl: document.getElementById("copy-sub-url"),
    plansList: document.getElementById("plans-list"),
    topupPresets: document.getElementById("topup-presets"),
    topupCustom: document.getElementById("topup-custom"),
    topupBtn: document.getElementById("topup-btn"),
    promoInput: document.getElementById("promo-input"),
    promoBtn: document.getElementById("promo-btn"),
    devicesText: document.getElementById("devices-text"),
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
    if (initData) headers["Authorization"] = "tma " + initData;

    const resp = await fetch(API_BASE_URL + path, Object.assign({}, options, { headers }));
    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      /* пустой ответ (напр. OPTIONS) */
    }
    if (!resp.ok) {
      throw new Error((data && data.error) || "Ошибка сервера (" + resp.status + ")");
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return "нет активной подписки";
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  let cachedPlans = [];
  let cachedProfile = null;

  function renderProfile(profile) {
    cachedProfile = profile;
    els.balance.textContent = Math.round(profile.balance) + " ₽";
    els.discount.textContent = profile.discount_percent > 0 ? profile.discount_percent + "%" : "нет";

    if (profile.subscription) {
      els.subExpiry.textContent = fmtDate(profile.subscription.expires_at) + (profile.subscription.active ? "" : " (истекла)");
      if (profile.subscription.subscription_url) {
        els.subUrlBlock.classList.remove("hidden");
        els.subUrl.textContent = profile.subscription.subscription_url;
      }
    } else {
      els.subExpiry.textContent = "нет активной подписки";
      els.subUrlBlock.classList.add("hidden");
    }
  }

  function planPayButtons(plan) {
    const discount = cachedProfile ? cachedProfile.discount_percent : 0;
    const factor = discount > 0 ? Math.max(0, 1 - discount / 100) : 1;
    const priceRub = Math.round(plan.price_rub * factor);
    const priceUsdt = Math.round(plan.price_usdt * factor * 100) / 100;
    const isFree = priceRub <= 0;
    const balanceEnough = cachedProfile && cachedProfile.balance >= priceRub && !isFree;

    const wrap = document.createElement("div");
    wrap.className = "pay-methods";

    if (isFree) {
      wrap.appendChild(makeBtn("🎁 Бесплатно", () => purchase(plan.code, "free")));
      return wrap;
    }

    if (balanceEnough) {
      wrap.appendChild(makeBtn("💰 С баланса", () => purchase(plan.code, "balance")));
    }
    wrap.appendChild(makeBtn("💎 Крипта", () => purchase(plan.code, "cryptobot"), "secondary"));
    wrap.appendChild(makeBtn("💳 LAVA", () => purchase(plan.code, "lava"), "secondary"));
    return wrap;
  }

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

  els.copySubUrl.onclick = () => {
    const text = els.subUrl.textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    showToast("Скопировано");
  };

  async function init() {
    if (!API_BASE_URL || API_BASE_URL.indexOf("example.com") !== -1) {
      els.loading.textContent = "Не настроен адрес API — отредактируйте config.js перед деплоем.";
      return;
    }
    if (!initData) {
      els.loading.textContent = "Открой мини-приложение через кнопку в Telegram-боте.";
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
    } catch (e) {
      els.loading.textContent = "Ошибка загрузки: " + e.message;
    }
  }

  init();
})();
