const STORAGE_KEY = "rupeePulse.v2";
const OLD_STORAGE_KEY = "rupeePulse.v1";
const DB_NAME = "rupeePulseStorage";
const DB_STORE = "keyval";
const DB_VERSION = 1;
const ENCRYPTED_STORAGE_KEY = `${STORAGE_KEY}.encrypted`;
const VAULT_META_KEY = "rupeePulse.vaultMeta";
const VAULT_ROUNDS = 210000;
const MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
};
const CATEGORIES = [
  "Food & Groceries",
  "Transport",
  "Bills & Recharge",
  "Health",
  "Shopping",
  "Fuel",
  "Personal Transfer",
  "Income / Received",
  "Large / Review",
  "Miscellaneous"
];
const DEFAULT_BUDGETS = {
  "Food & Groceries": 4000,
  Transport: 3500,
  "Bills & Recharge": 3500,
  Health: 2000,
  Shopping: 3000,
  Fuel: 2500,
  "Personal Transfer": 6000,
  "Large / Review": 0,
  Miscellaneous: 2500
};

const ui = {
  expandedDay: "",
  categoryDetail: "",
  merchantScreen: "home",
  merchantListType: "frequent",
  merchantDetail: ""
};

let sessionVaultKey = null;
let unlockRequired = false;
let deferredInstallPrompt = null;
let state = loadState();
let pendingConfirmAction = null;

const $ = (id) => document.getElementById(id);
const money = (value) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: Math.abs(value || 0) % 1 ? 2 : 0
}).format(value || 0);
const compactMoney = (value) => {
  const abs = Math.abs(value || 0);
  if (abs >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `₹${(value / 1000).toFixed(1)}k`;
  return money(value || 0);
};
const clean = (text = "") => String(text).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[char]));
const norm = (text = "") => text.toLowerCase().replace(/[_./-]+/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

function defaultProfile(name = "Personal") {
  const id = `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    transactions: [],
    imports: [],
    merchantRules: {},
    settings: {
      dailyLimit: 700,
      selectedMonth: "all",
      categoryBudgets: { ...DEFAULT_BUDGETS }
    }
  };
}

function loadState() {
  if (getVaultMeta()?.enabled) {
    unlockRequired = true;
    const profile = defaultProfile("Locked");
    return { activeProfileId: profile.id, profiles: [profile], security: { vaultEnabled: true } };
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved?.profiles?.length) return normalizeState(saved);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }

  try {
    const old = JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) || "null");
    if (old) {
      const profile = defaultProfile("Personal");
      profile.transactions = (old.transactions || []).map(enrichTransaction);
      profile.imports = old.imports || [];
      profile.merchantRules = old.merchantRules || {};
      profile.settings = {
        ...profile.settings,
        ...old.settings,
        categoryBudgets: { ...DEFAULT_BUDGETS, ...(old.settings?.categoryBudgets || {}) }
      };
      return normalizeState({ activeProfileId: profile.id, profiles: [profile] });
    }
  } catch {
    localStorage.removeItem(OLD_STORAGE_KEY);
  }

  const profile = defaultProfile("Personal");
  return { activeProfileId: profile.id, profiles: [profile] };
}

function normalizeState(input) {
  const profiles = (input.profiles || []).map((profile) => ({
    ...defaultProfile(profile.name || "Profile"),
    ...profile,
    transactions: (profile.transactions || []).map(enrichTransaction),
    imports: profile.imports || [],
    merchantRules: profile.merchantRules || {},
    settings: {
      dailyLimit: 700,
      selectedMonth: "all",
      categoryBudgets: { ...DEFAULT_BUDGETS },
      security: {},
      ...(profile.settings || {}),
      categoryBudgets: { ...DEFAULT_BUDGETS, ...(profile.settings?.categoryBudgets || {}) }
    }
  }));
  if (!profiles.length) profiles.push(defaultProfile("Personal"));
  const activeProfileId = profiles.some((profile) => profile.id === input.activeProfileId)
    ? input.activeProfileId
    : profiles[0].id;
  return { ...input, activeProfileId, profiles, security: input.security || {} };
}

function saveState() {
  state.savedAt = new Date().toISOString();
  if (!state.security?.vaultEnabled) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  else localStorage.removeItem(STORAGE_KEY);
  persistState(state);
}

function getVaultMeta() {
  try {
    return JSON.parse(localStorage.getItem(VAULT_META_KEY) || "null");
  } catch {
    return null;
  }
}

function openStorageDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open app storage."));
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const request = tx.objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not read app storage."));
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not save app storage."));
  });
}

async function persistState(nextState = state) {
  try {
    const db = await openStorageDb();
    if (nextState.security?.vaultEnabled && sessionVaultKey) {
      await dbPut(db, ENCRYPTED_STORAGE_KEY, await encryptState(nextState, sessionVaultKey));
      await dbPut(db, STORAGE_KEY, null);
    } else if (!nextState.security?.vaultEnabled) {
      await dbPut(db, STORAGE_KEY, JSON.parse(JSON.stringify(nextState)));
    }
    db.close();
  } catch {
    // localStorage remains the immediate fallback if IndexedDB is unavailable.
  }
}

async function requestDurableStorage() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    // Some Android browsers decline silently; the app still keeps local backups.
  }
}

function hasUserData(nextState) {
  return nextState?.profiles?.some((item) => (item.transactions || []).length || (item.imports || []).length);
}

async function hydratePersistentState() {
  await requestDurableStorage();
  if (getVaultMeta()?.enabled) {
    unlockRequired = true;
    openLockModal();
    return;
  }
  try {
    const db = await openStorageDb();
    const saved = await dbGet(db, STORAGE_KEY);
    db.close();
    if (!saved?.profiles?.length) return;

    const durable = normalizeState(saved);
    const durableTime = Date.parse(durable.savedAt || "") || 0;
    const currentTime = Date.parse(state.savedAt || "") || 0;
    if (hasUserData(durable) && (!hasUserData(state) || durableTime > currentTime)) {
      state = durable;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      chooseLatestMonth();
      render();
      toast("Saved finance data restored.");
    }
  } catch {
    // Startup must never fail because durable storage is unavailable.
  }
}

function cryptoAvailable() {
  return Boolean(window.crypto?.subtle && window.crypto?.getRandomValues);
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(bytes) {
  const input = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < input.length; index += 0x8000) {
    binary += String.fromCharCode(...input.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function deriveVaultKey(passcode, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: VAULT_ROUNDS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptState(nextState, key) {
  const iv = randomBytes(12);
  const payload = new TextEncoder().encode(JSON.stringify(nextState));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
  return {
    version: 1,
    iv: bytesToBase64(iv),
    cipher: bytesToBase64(cipher),
    savedAt: nextState.savedAt || new Date().toISOString()
  };
}

async function decryptState(payload, key) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.cipher)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

function profile() {
  return state.profiles.find((item) => item.id === state.activeProfileId) || state.profiles[0];
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.classList.remove("show"), 3200);
}

function openProfileModal() {
  $("profileNameInput").value = "";
  $("profileModal").classList.remove("hidden");
  window.setTimeout(() => {
    if (typeof $("profileNameInput").focus === "function") $("profileNameInput").focus();
  }, 50);
}

function closeProfileModal() {
  $("profileModal").classList.add("hidden");
}

function openConfirmModal(title, message, action) {
  $("confirmTitle").textContent = title;
  $("confirmMessage").textContent = message;
  pendingConfirmAction = action;
  $("confirmModal").classList.remove("hidden");
}

function closeConfirmModal() {
  pendingConfirmAction = null;
  $("confirmModal").classList.add("hidden");
}

function openLockModal() {
  $("lockModal").classList.remove("hidden");
  window.setTimeout(() => {
    if (typeof $("vaultUnlockInput").focus === "function") $("vaultUnlockInput").focus();
  }, 50);
}

function closeLockModal() {
  $("vaultUnlockInput").value = "";
  $("lockModal").classList.add("hidden");
}

function createProfileFromModal() {
  const name = $("profileNameInput").value.trim();
  if (!name) {
    toast("Enter a profile name.");
    return;
  }
  const next = defaultProfile(name);
  state.profiles.push(next);
  state.activeProfileId = next.id;
  ui.expandedDay = "";
  ui.categoryDetail = "";
  ui.merchantScreen = "home";
  ui.merchantListType = "frequent";
  ui.merchantDetail = "";
  closeProfileModal();
  saveState();
  render();
  toast(`${next.name} profile created.`);
}

function bindEvents() {
  $("profileSelect").addEventListener("change", (event) => {
    state.activeProfileId = event.target.value;
    ui.expandedDay = "";
    ui.categoryDetail = "";
    ui.merchantScreen = "home";
    ui.merchantListType = "frequent";
    ui.merchantDetail = "";
    chooseLatestMonth();
    saveState();
    render();
  });

  $("addProfileBtn").addEventListener("click", () => {
    openProfileModal();
  });
  $("profileCancelBtn").addEventListener("click", closeProfileModal);
  $("profileCreateBtn").addEventListener("click", createProfileFromModal);
  $("profileNameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") createProfileFromModal();
    if (event.key === "Escape") closeProfileModal();
  });
  $("profileModal").addEventListener("click", (event) => {
    if (event.target === $("profileModal")) closeProfileModal();
  });
  $("confirmCancelBtn").addEventListener("click", closeConfirmModal);
  $("confirmOkBtn").addEventListener("click", () => {
    const action = pendingConfirmAction;
    closeConfirmModal();
    if (typeof action === "function") action();
  });
  $("confirmModal").addEventListener("click", (event) => {
    if (event.target === $("confirmModal")) closeConfirmModal();
  });
  $("vaultUnlockBtn").addEventListener("click", unlockVaultFromModal);
  $("vaultUnlockInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") unlockVaultFromModal();
  });
  $("vaultUseEmptyBtn").addEventListener("click", startEmptyApp);

  $("pdfInput").addEventListener("change", (event) => importFiles(event.target.files));
  $("loadDemoBtn").addEventListener("click", loadDemoData);
  $("exportBtn").addEventListener("click", exportBackup);
  $("restoreInput").addEventListener("change", restoreBackup);
  $("clearBtn").addEventListener("click", clearProfileData);
  $("vaultActionBtn").addEventListener("click", enableVaultFromSettings);
  $("vaultLockBtn").addEventListener("click", lockVaultNow);

  $("monthSelect").addEventListener("change", (event) => {
    profile().settings.selectedMonth = event.target.value;
    ui.expandedDay = "";
    ui.categoryDetail = "";
    ui.merchantScreen = "home";
    ui.merchantListType = "frequent";
    ui.merchantDetail = "";
    saveState();
    render();
  });

  $("saveLimitBtn").addEventListener("click", () => {
    const value = Math.max(1, Number($("dailyLimitInput").value) || 700);
    profile().settings.dailyLimit = value;
    saveState();
    render();
    toast(`Daily limit saved: ${money(value)}.`);
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewTarget));
  });
  document.querySelectorAll("[data-open-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      setView("viewMore");
      setPanel(button.dataset.openPanel);
    });
  });
  document.querySelectorAll(".feature-tab").forEach((button) => {
    button.addEventListener("click", () => setPanel(button.dataset.panel));
  });

  $("dailyList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-day]");
    if (!row) return;
    ui.expandedDay = ui.expandedDay === row.dataset.day ? "" : row.dataset.day;
    renderDailyList();
  });

  $("categoryList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-category]");
    if (!row) return;
    ui.categoryDetail = row.dataset.category;
    renderCategoryDetail();
  });
  $("closeCategoryDetail").addEventListener("click", () => {
    ui.categoryDetail = "";
    renderCategoryDetail();
  });

  $("merchantList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-merchant]");
    if (!row) return;
    ui.merchantScreen = "detail";
    ui.merchantDetail = row.dataset.merchant;
    renderMerchantsPanel();
  });
  document.querySelectorAll("[data-merchant-screen]").forEach((button) => {
    button.addEventListener("click", () => {
      ui.merchantScreen = "list";
      ui.merchantListType = button.dataset.merchantScreen;
      ui.merchantDetail = "";
      renderMerchantsPanel();
    });
  });
  $("merchantBackHome").addEventListener("click", () => {
    ui.merchantScreen = "home";
    ui.merchantDetail = "";
    renderMerchantsPanel();
  });
  $("closeMerchantDetail").addEventListener("click", () => {
    ui.merchantScreen = "list";
    ui.merchantDetail = "";
    renderMerchantsPanel();
  });

  $("ledgerSearch").addEventListener("input", renderLedger);
  $("ledgerFilter").addEventListener("change", renderLedger);
  $("ledgerList").addEventListener("change", (event) => {
    if (!event.target.matches("[data-category-id]")) return;
    const active = profile();
    const tx = active.transactions.find((item) => item.id === event.target.dataset.categoryId);
    if (!tx) return;
    tx.category = event.target.value;
    tx.aiSource = "manual";
    tx.aiConfidence = 100;
    tx.aiReason = "You confirmed this category from the ledger.";
    tx.aiNeedsReview = false;
    active.merchantRules[merchantKey(tx.merchant)] = tx.category;
    active.transactions.forEach((item) => {
      if (merchantKey(item.merchant) === merchantKey(tx.merchant)) {
        item.category = tx.category;
        item.aiSource = "manual";
        item.aiConfidence = 100;
        item.aiReason = "Applied from your merchant correction.";
        item.aiNeedsReview = false;
      }
    });
    saveState();
    render();
    toast(`${tx.merchant} will be sorted as ${tx.category}.`);
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("installBtn").classList.remove("hidden");
  });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("installBtn").classList.add("hidden");
  });
}

function setView(viewId) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active-view", view.id === viewId));
  document.querySelectorAll(".nav-btn").forEach((button) => button.classList.toggle("active", button.dataset.view === viewId));
  const shell = $("appShell");
  if (typeof shell.scrollTo === "function") shell.scrollTo({ top: 0, behavior: "smooth" });
  else window.scrollTo({ top: 0, behavior: "smooth" });
}

function setPanel(panelId) {
  document.querySelectorAll(".feature-panel").forEach((panel) => panel.classList.toggle("active-panel", panel.id === panelId));
  document.querySelectorAll(".feature-tab").forEach((button) => button.classList.toggle("active", button.dataset.panel === panelId));
  if (panelId === "panelLedger") renderLedger();
}

async function importFiles(files) {
  const selected = Array.from(files || []);
  if (!selected.length) return;
  let imported = 0;
  const active = profile();
  for (const file of selected) {
    try {
      toast(`Reading ${file.name}...`);
      const parsed = await parseGooglePayPdf(file);
      const before = active.transactions.length;
      mergeTransactions(active, parsed);
      imported += active.transactions.length - before;
      active.imports.unshift({
        id: `${Date.now()}-${file.name}`,
        name: file.name,
        importedAt: new Date().toISOString(),
        count: parsed.length
      });
    } catch (error) {
      console.error(error);
      toast(`Could not read ${file.name}: ${error.message}`);
    }
  }
  active.imports = active.imports.slice(0, 50);
  chooseLatestMonth();
  saveState();
  render();
  toast(imported ? `Imported ${imported} new transactions for ${active.name}.` : "No new transactions found.");
  $("pdfInput").value = "";
}

function mergeTransactions(targetProfile, transactions) {
  const existing = new Set(targetProfile.transactions.map((tx) => tx.id));
  for (const tx of transactions.map(enrichTransaction)) {
    if (existing.has(tx.id)) continue;
    targetProfile.transactions.push(tx);
    existing.add(tx.id);
  }
  targetProfile.transactions.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

function enrichTransaction(tx) {
  const enriched = { ...tx };
  enriched.merchant = canonicalMerchant(enriched.party || enriched.merchant || "");
  const prediction = categoryPrediction(enriched);
  const manuallyConfirmed = enriched.aiSource === "manual";
  enriched.category = enriched.category || prediction.category;
  if (manuallyConfirmed) {
    enriched.aiConfidence = 100;
    enriched.aiReason = enriched.aiReason || "You confirmed this category.";
    enriched.aiNeedsReview = false;
  } else {
    enriched.aiSource = prediction.source;
    enriched.aiConfidence = prediction.confidence;
    enriched.aiReason = prediction.reason;
    enriched.aiNeedsReview = prediction.needsReview;
  }
  enriched.month = enriched.month || enriched.date?.slice(0, 7) || "unknown";
  enriched.id = enriched.id || enriched.upiId || `${enriched.date}-${enriched.time}-${enriched.party}-${enriched.amount}`;
  return enriched;
}

function chooseLatestMonth() {
  const active = profile();
  const months = getMonths();
  if (!months.length) active.settings.selectedMonth = "all";
  else if (!months.includes(active.settings.selectedMonth) && active.settings.selectedMonth !== "all") active.settings.selectedMonth = months.at(-1);
  else if (active.settings.selectedMonth === "all" && months.length === 1) active.settings.selectedMonth = months[0];
}

function getMonths() {
  return [...new Set(profile().transactions.map((tx) => tx.month))].filter((month) => /^\d{4}-\d{2}$/.test(month)).sort();
}

function selectedTransactions() {
  const active = profile();
  const month = active.settings.selectedMonth;
  return month === "all" ? [...active.transactions] : active.transactions.filter((tx) => tx.month === month);
}

function paidOnly(items = selectedTransactions()) {
  return items.filter((tx) => tx.direction === "Paid");
}

function sum(items, selector = (item) => item.amount) {
  return items.reduce((total, item) => total + (Number(selector(item)) || 0), 0);
}

function groupBy(items, selector) {
  const map = new Map();
  for (const item of items) {
    const key = selector(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function render() {
  renderProfile();
  renderMonthSelect();
  renderHome();
  renderDaily();
  renderFlow();
  renderMore();
}

function renderProfile() {
  const active = profile();
  $("profileSelect").innerHTML = state.profiles.map((item) => `<option value="${clean(item.id)}">${clean(item.name)}</option>`).join("");
  $("profileSelect").value = active.id;
  $("profileName").textContent = active.name;
  $("profileAvatar").textContent = initials(active.name);
  $("importProfileName").textContent = active.name;
  const months = getMonths();
  $("profileMeta").textContent = active.transactions.length
    ? `${active.transactions.length} transactions - ${months.length} month${months.length === 1 ? "" : "s"}`
    : "No statements yet";
}

function renderMonthSelect() {
  const months = getMonths();
  const active = profile();
  $("monthSelect").innerHTML = [
    `<option value="all">All months</option>`,
    ...months.map((month) => `<option value="${month}">${formatMonth(month)}</option>`)
  ].join("");
  if (!months.includes(active.settings.selectedMonth) && active.settings.selectedMonth !== "all") active.settings.selectedMonth = months.at(-1) || "all";
  $("monthSelect").value = active.settings.selectedMonth;
  $("dailyLimitInput").value = active.settings.dailyLimit;
}

function renderHome() {
  const hasData = profile().transactions.length > 0;
  $("emptyState").classList.toggle("hidden", hasData);
  $("homeContent").classList.toggle("hidden", !hasData);
  if (!hasData) return;

  const tx = selectedTransactions();
  const paid = paidOnly(tx);
  const received = tx.filter((item) => item.direction === "Received");
  const spent = sum(paid);
  const got = sum(received);
  const daily = dailySeries(tx);
  const budget = daily.length * profile().settings.dailyLimit;
  const remaining = budget - spent;
  const extra = daily.reduce((total, day) => total + Math.max(0, day.amount - profile().settings.dailyLimit), 0);

  $("heroSpent").textContent = money(spent);
  $("heroSub").textContent = `${formatPeriod()} - ${tx.length} transactions`;
  $("statSent").textContent = money(spent);
  $("statReceived").textContent = money(got);
  $("statNet").textContent = money(got - spent);
  $("heroBadge").textContent = remaining >= 0 ? "Under limit" : "Over limit";
  $("heroBadge").classList.toggle("alert", remaining < 0);
  $("homeDailyMeta").textContent = extra ? `${money(extra)} over-limit` : `${money(Math.max(0, remaining))} cushion`;
  $("homeFlowMeta").textContent = `${topGroups(tx, bankLabel, (list) => sum(list), 1)[0]?.key || "No bank data"}`;
  renderAiCoach(tx, daily, remaining, extra);
  renderInsights(tx, daily, remaining, extra);
}

function renderDaily() {
  const tx = selectedTransactions();
  const daily = dailySeries(tx);
  const spent = sum(paidOnly(tx));
  const budget = daily.length * profile().settings.dailyLimit;
  const remaining = budget - spent;
  const extra = daily.reduce((total, day) => total + Math.max(0, day.amount - profile().settings.dailyLimit), 0);

  $("dailyPulseMeta").textContent = `${money(profile().settings.dailyLimit)} daily limit`;
  $("savedOrExtra").textContent = money(Math.abs(remaining));
  $("cumExtra").textContent = money(extra);
  renderDailyBars(daily, $("dailyBars"), { showLimit: true });
  renderDailyList();
}

function dailySeries(transactions) {
  const paid = paidOnly(transactions);
  const month = profile().settings.selectedMonth;
  if (month !== "all" && /^\d{4}-\d{2}$/.test(month)) {
    const [year, monthNumber] = month.split("-").map(Number);
    const days = new Date(year, monthNumber, 0).getDate();
    const byDate = groupBy(paid, (tx) => tx.date);
    return Array.from({ length: days }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      const list = byDate.get(date) || [];
      return { date, label: String(index + 1), amount: sum(list), count: list.length, items: list };
    });
  }
  return [...groupBy(paid, (tx) => tx.date)].map(([date, list]) => ({
    date,
    label: date.slice(8),
    amount: sum(list),
    count: list.length,
    items: list
  })).sort((a, b) => a.date.localeCompare(b.date));
}

function renderDailyBars(daily, element, options = {}) {
  const limit = profile().settings.dailyLimit;
  const max = Math.max(limit * 1.2, ...daily.map((day) => day.amount), 1);
  element.style.setProperty("--days", String(Math.max(daily.length, 1)));
  element.style.setProperty("--max", String(max));
  element.style.setProperty("--limit", String(limit));
  const limitLine = options.showLimit ? `<div class="limit-line"></div>` : "";
  element.innerHTML = limitLine + daily.map((day, index) => {
    const numeric = Number(day.label);
    const showLabel = numeric === 1 || numeric % 5 === 0 || index === daily.length - 1;
    const amount = Math.max(day.amount, day.amount ? 8 : 0);
    const cls = [
      "day-bar",
      day.amount ? "" : "empty",
      day.amount > limit ? "over" : "",
      options.category ? "category" : ""
    ].filter(Boolean).join(" ");
    return `<i class="${cls}" style="--amount:${amount}" data-day="${showLabel ? clean(day.label) : ""}" title="${clean(day.date)} - ${money(day.amount)}"></i>`;
  }).join("");
}

function renderDailyList() {
  const daily = dailySeries(selectedTransactions()).filter((day) => day.amount || day.count);
  $("dailyCountMeta").textContent = `${daily.length} spending day${daily.length === 1 ? "" : "s"}`;
  $("dailyList").innerHTML = [...daily].reverse().map((day) => {
    const over = Math.max(0, day.amount - profile().settings.dailyLimit);
    const cats = topGroups(day.items, (tx) => tx.category, (list) => sum(list), 3).map((cat) => `${cat.key}: ${compactMoney(cat.amount)}`).join(" - ");
    return `
      <article class="row-card" role="button" tabindex="0" data-day="${clean(day.date)}">
        <div class="row-icon">${clean(day.label)}</div>
        <div class="row-content">
          <div class="row-top">
            <div>
              <p class="row-title">${clean(formatDate(day.date))}${over ? ` crossed by ${money(over)}` : ""}</p>
              <p class="row-sub">${day.count} payments${cats ? ` - ${clean(cats)}` : ""}</p>
            </div>
            <div class="row-value ${over ? "bad" : ""}">${money(day.amount)}</div>
          </div>
          ${ui.expandedDay === day.date ? renderDayDetail(day) : ""}
        </div>
      </article>
    `;
  }).join("") || emptyRow("No daily expenses in this period.");
}

function renderDayDetail(day) {
  const byCategory = topGroups(day.items, (tx) => tx.category, (list) => sum(list), 10);
  const categoryRows = byCategory.map((row) => `<div class="tx-mini"><strong>${clean(row.key)}</strong><span>${money(row.amount)}</span></div>`).join("");
  const txRows = day.items.map((tx) => `<div class="tx-mini"><strong>${clean(tx.merchant)}</strong><span>${money(tx.amount)}</span></div>`).join("");
  return `<div class="day-detail">${categoryRows}${txRows}</div>`;
}

function renderFlow() {
  const tx = selectedTransactions();
  renderBanks(tx);
  renderCategories(tx);
  renderCategoryDetail();
}

function renderBanks(tx) {
  const rows = topGroups(tx, bankLabel, (list) => sum(list), 20);
  $("bankList").innerHTML = rows.map((row) => {
    const sent = sum(row.items.filter((item) => item.direction === "Paid"));
    const received = sum(row.items.filter((item) => item.direction === "Received"));
    return `
      <article class="row-card">
        <div class="row-icon">${clean(bankInitials(row.key))}</div>
        <div class="row-content">
          <div class="row-top">
            <div>
              <p class="row-title">${clean(row.key)}</p>
              <p class="row-sub">Sent ${money(sent)} - Received ${money(received)} - ${row.count} txns</p>
            </div>
            <div class="row-value">${money(sent + received)}</div>
          </div>
        </div>
      </article>
    `;
  }).join("") || emptyRow("No bank activity found.");
}

function renderCategories(tx) {
  const paid = paidOnly(tx);
  const rows = topGroups(paid, (item) => item.category, (list) => sum(list), 14);
  const max = Math.max(...rows.map((row) => row.amount), 1);
  $("categoryList").innerHTML = rows.map((row) => `
    <article class="row-card" role="button" tabindex="0" data-category="${clean(row.key)}">
      <div class="row-icon">${clean(categoryIcon(row.key))}</div>
      <div class="row-content">
        <div class="row-top">
          <div>
            <p class="row-title">${clean(row.key)}</p>
            <p class="row-sub">${row.count} payments - tap for per-day trend</p>
          </div>
          <div class="row-value">${money(row.amount)}</div>
        </div>
        <div class="progress"><i style="--w:${Math.min(100, row.amount / max * 100)}%;--c:${categoryColor(row.key)}"></i></div>
      </div>
    </article>
  `).join("") || emptyRow("No paid categories yet.");
}

function renderCategoryDetail() {
  const panel = $("categoryDetail");
  if (!ui.categoryDetail) {
    panel.classList.add("hidden");
    return;
  }
  const category = ui.categoryDetail;
  const items = paidOnly(selectedTransactions()).filter((tx) => tx.category === category);
  $("categoryDetailTitle").textContent = `${category} - ${money(sum(items))}`;
  const byDay = dailySeries(items);
  renderDailyBars(byDay, $("categoryDailyChart"), { category: true });
  $("categoryTxList").innerHTML = [...items].reverse().slice(0, 30).map(transactionRow).join("") || emptyRow("No transactions in this category.");
  panel.classList.remove("hidden");
}

function renderMore() {
  renderImportPanel();
  renderBudgetPanel();
  renderMerchantsPanel();
  renderLedger();
  renderSettingsPanel();
}

function renderImportPanel() {
  const active = profile();
  $("importMeta").textContent = `${active.imports.length} file${active.imports.length === 1 ? "" : "s"}`;
  $("importList").innerHTML = active.imports.map((item) => `
    <article class="row-card">
      <div class="row-icon">PDF</div>
      <div class="row-content">
        <div class="row-top">
          <div>
            <p class="row-title">${clean(item.name)}</p>
            <p class="row-sub">${clean(new Date(item.importedAt).toLocaleString())}</p>
          </div>
          <div class="row-value">${item.count}</div>
        </div>
      </div>
    </article>
  `).join("") || emptyRow("No PDFs imported for this profile yet.");
}

function renderBudgetPanel() {
  const tx = selectedTransactions();
  const daily = dailySeries(tx);
  const spent = sum(paidOnly(tx));
  const budget = daily.length * profile().settings.dailyLimit;
  const percent = budget ? Math.min(999, Math.round(spent / budget * 100)) : 0;
  $("budgetRing").style.setProperty("--p", `${Math.min(100, percent)}%`);
  $("budgetPercent").textContent = `${percent}%`;
  $("monthBudget").textContent = money(budget);
  $("monthRemaining").textContent = money(budget - spent);

  const rows = Object.entries(profile().settings.categoryBudgets).map(([category, budgetValue]) => {
    const amount = sum(paidOnly(tx).filter((item) => item.category === category));
    const pct = budgetValue ? Math.min(100, amount / budgetValue * 100) : amount ? 100 : 0;
    return { category, amount, budgetValue, pct };
  }).sort((a, b) => b.amount - a.amount);

  $("budgetCategoryList").innerHTML = rows.map((row) => `
    <article class="row-card">
      <div class="row-icon">${clean(categoryIcon(row.category))}</div>
      <div class="row-content">
        <div class="row-top">
          <div>
            <p class="row-title">${clean(row.category)}</p>
            <p class="row-sub">${money(row.amount)} of ${money(row.budgetValue)}</p>
          </div>
          <div class="row-value ${row.amount > row.budgetValue && row.budgetValue ? "bad" : ""}">${Math.round(row.pct)}%</div>
        </div>
        <div class="progress"><i style="--w:${row.pct}%;--c:${row.amount > row.budgetValue && row.budgetValue ? "var(--red)" : categoryColor(row.category)}"></i></div>
      </div>
    </article>
  `).join("");
}

function renderMerchantsPanel() {
  const paid = paidOnly(selectedTransactions());
  const frequent = merchantGroups(paid).slice(0, 30);
  const recurring = merchantGroups(paid, true).slice(0, 30);
  const listType = ui.merchantListType === "recurring" ? "recurring" : "frequent";
  const rows = listType === "recurring" ? recurring : frequent;

  $("frequentMerchantMeta").textContent = frequent.length
    ? `${frequent.length} merchants ranked by spend`
    : "Top merchants by total spend";
  $("recurringMerchantMeta").textContent = recurring.length
    ? `${recurring.length} repeated payment patterns`
    : "Repeated payments and patterns";

  $("merchantHome").classList.toggle("hidden", ui.merchantScreen !== "home");
  $("merchantListScreen").classList.toggle("hidden", ui.merchantScreen !== "list");
  $("merchantDetail").classList.toggle("hidden", ui.merchantScreen !== "detail");

  if (ui.merchantScreen === "list") {
    $("merchantListTitle").textContent = listType === "recurring" ? "Recurring merchants" : "Frequent merchants";
    $("merchantListMeta").textContent = listType === "recurring"
      ? "Repeated payments detected"
      : "Highest UPI spend first";
    $("merchantList").innerHTML = rows.map(merchantRow).join("") || emptyRow(
      listType === "recurring" ? "No recurring merchants yet." : "No merchants yet."
    );
  }

  if (ui.merchantScreen === "detail") renderMerchantDetail();
}

function renderMerchantDetail() {
  const panel = $("merchantDetail");
  if (!ui.merchantDetail) {
    panel.classList.add("hidden");
    return;
  }
  const merchant = ui.merchantDetail;
  const items = selectedTransactions().filter((tx) => tx.merchant === merchant);
  const sent = sum(items.filter((tx) => tx.direction === "Paid"));
  const received = sum(items.filter((tx) => tx.direction === "Received"));
  $("merchantDetailTitle").textContent = merchant;
  $("merchantDetailMeta").textContent = `${items.length} transactions - sent ${money(sent)} - received ${money(received)}`;
  $("merchantTxList").innerHTML = [...items].reverse().map(transactionRow).join("") || emptyRow("No transactions for this merchant.");
  panel.classList.remove("hidden");
}

function merchantGroups(items, recurringOnly = false) {
  return [...groupBy(items, (tx) => tx.merchant)].map(([key, list]) => {
    const months = new Set(list.map((tx) => tx.month)).size;
    const categories = topGroups(list, (tx) => tx.category, (group) => sum(group), 1);
    return {
      key,
      items: list,
      amount: sum(list),
      count: list.length,
      months,
      category: categories[0]?.key || "Uncategorized"
    };
  }).filter((row) => !recurringOnly || row.count >= 2 || row.months >= 2)
    .sort((a, b) => recurringOnly
      ? b.count - a.count || b.months - a.months || b.amount - a.amount
      : b.amount - a.amount || b.count - a.count || a.key.localeCompare(b.key));
}

function merchantRow(row) {
  return `
    <article class="row-card" role="button" tabindex="0" data-merchant="${clean(row.key)}">
      <div class="row-icon">${clean(initials(row.key))}</div>
      <div class="row-content">
        <div class="row-top">
          <div>
            <p class="row-title">${clean(row.key)}</p>
            <p class="row-sub">${row.count} payments - ${row.months} month${row.months === 1 ? "" : "s"} - ${clean(row.category)}</p>
          </div>
          <div class="merchant-total">
            <strong title="${money(row.amount)}">${money(row.amount)}</strong>
            <small>${row.count} txns</small>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderLedger() {
  renderReviewQueue();
  const query = norm($("ledgerSearch").value);
  const filter = $("ledgerFilter").value;
  let rows = [...selectedTransactions()].reverse();
  if (query) rows = rows.filter((tx) => norm(`${tx.party} ${tx.merchant} ${tx.bank} ${tx.bankLast4} ${tx.upiId} ${tx.category}`).includes(query));
  if (filter === "Paid" || filter === "Received") rows = rows.filter((tx) => tx.direction === filter);
  if (filter === "over") rows = rows.filter((tx) => tx.amount >= 1000);
  if (filter === "review") rows = rows.filter((tx) => tx.aiNeedsReview || Number(tx.aiConfidence || 0) < 75);
  rows = rows.slice(0, 120);
  $("ledgerList").innerHTML = rows.map((tx) => `
    <article class="ledger-card">
      <div class="row-icon">${tx.direction === "Received" ? "IN" : categoryIcon(tx.category)}</div>
      <div class="row-content">
        <div class="ledger-top">
          <div>
            <p class="row-title">${clean(tx.merchant)}</p>
            <p class="row-sub">${clean(formatDate(tx.date))} ${clean(tx.time)} - ${clean(bankLabel(tx))}</p>
          </div>
          <div class="row-value ${tx.direction === "Received" ? "good" : ""}" title="${money(tx.amount)}">${tx.direction === "Received" ? "+" : ""}${money(tx.amount)}</div>
        </div>
        <select data-category-id="${clean(tx.id)}" aria-label="Change category for ${clean(tx.merchant)}">
          ${CATEGORIES.map((cat) => `<option value="${clean(cat)}" ${cat === tx.category ? "selected" : ""}>${clean(cat)}</option>`).join("")}
        </select>
        ${aiMeta(tx)}
      </div>
    </article>
  `).join("") || emptyRow("No transactions match this search.");
}

function renderSettingsPanel() {
  renderVaultStatus();
  $("categoryBudgetEditor").innerHTML = Object.entries(profile().settings.categoryBudgets).map(([category, value]) => `
    <div class="budget-edit-row">
      <label for="budget-${clean(category)}">${clean(category)}</label>
      <input id="budget-${clean(category)}" data-budget-category="${clean(category)}" type="number" min="0" step="100" value="${Number(value) || 0}">
    </div>
  `).join("");
  $("categoryBudgetEditor").querySelectorAll("[data-budget-category]").forEach((input) => {
    input.addEventListener("change", () => {
      profile().settings.categoryBudgets[input.dataset.budgetCategory] = Math.max(0, Number(input.value) || 0);
      saveState();
      renderBudgetPanel();
    });
  });
}

function renderVaultStatus() {
  const enabled = Boolean(getVaultMeta()?.enabled || state.security?.vaultEnabled);
  $("vaultBadge").textContent = enabled ? "Encrypted" : "Local";
  $("vaultBadge").classList.toggle("secure", enabled);
  $("vaultStatus").textContent = enabled
    ? "Encrypted vault is enabled. Saved finance data is protected with your app passcode on this phone."
    : "Local storage is active. Add an app passcode to encrypt saved finance data.";
  $("vaultActionBtn").textContent = enabled ? "Update passcode" : "Enable vault";
  $("vaultLockBtn").disabled = !enabled;
}

async function enableVaultFromSettings() {
  const passcode = $("vaultPasscodeInput").value.trim();
  if (passcode.length < 4) {
    toast("Use at least 4 digits for the app passcode.");
    return;
  }
  if (!cryptoAvailable()) {
    toast("Encrypted vault needs HTTPS or installed app mode.");
    return;
  }
  try {
    const salt = randomBytes(16);
    const key = await deriveVaultKey(passcode, salt);
    sessionVaultKey = key;
    state.security = {
      ...(state.security || {}),
      vaultEnabled: true,
      encryptedAt: new Date().toISOString()
    };
    state.savedAt = new Date().toISOString();
    const db = await openStorageDb();
    await dbPut(db, ENCRYPTED_STORAGE_KEY, await encryptState(state, key));
    await dbPut(db, STORAGE_KEY, null);
    db.close();
    localStorage.setItem(VAULT_META_KEY, JSON.stringify({
      enabled: true,
      salt: bytesToBase64(salt),
      iterations: VAULT_ROUNDS,
      createdAt: new Date().toISOString()
    }));
    localStorage.removeItem(STORAGE_KEY);
    $("vaultPasscodeInput").value = "";
    renderVaultStatus();
    toast("Encrypted vault enabled.");
  } catch (error) {
    toast(error.message || "Could not enable encrypted vault.");
  }
}

async function unlockVaultFromModal() {
  const passcode = $("vaultUnlockInput").value.trim();
  const meta = getVaultMeta();
  if (!meta?.enabled) {
    closeLockModal();
    return;
  }
  if (!passcode) {
    toast("Enter your app passcode.");
    return;
  }
  try {
    const key = await deriveVaultKey(passcode, base64ToBytes(meta.salt));
    const db = await openStorageDb();
    const encrypted = await dbGet(db, ENCRYPTED_STORAGE_KEY);
    db.close();
    if (!encrypted?.cipher) throw new Error("Encrypted vault data was not found.");
    const restored = await decryptState(encrypted, key);
    state = normalizeState(restored);
    state.security = { ...(state.security || {}), vaultEnabled: true };
    sessionVaultKey = key;
    unlockRequired = false;
    localStorage.removeItem(STORAGE_KEY);
    closeLockModal();
    chooseLatestMonth();
    render();
    toast("Finance vault unlocked.");
  } catch {
    toast("Wrong passcode or vault data is unavailable.");
  }
}

function lockVaultNow() {
  if (!getVaultMeta()?.enabled && !state.security?.vaultEnabled) {
    toast("Enable encrypted vault first.");
    return;
  }
  saveState();
  unlockRequired = true;
  openLockModal();
}

function startEmptyApp() {
  localStorage.removeItem(VAULT_META_KEY);
  localStorage.removeItem(STORAGE_KEY);
  sessionVaultKey = null;
  unlockRequired = false;
  const next = defaultProfile("Personal");
  state = { activeProfileId: next.id, profiles: [next], security: {} };
  closeLockModal();
  chooseLatestMonth();
  saveState();
  render();
  toast("Started a new empty app profile.");
}

function renderAiCoach(transactions, daily, remaining, extra) {
  const analysis = periodAnalysis(transactions, daily, remaining, extra);
  $("aiCoachScore").textContent = analysis.score;
  $("aiCoachTitle").textContent = analysis.title;
  $("aiCoachText").textContent = analysis.text;
  $("aiCoachChips").innerHTML = analysis.chips.map((chip) => `<span>${clean(chip)}</span>`).join("");
}

function renderReviewQueue() {
  const rows = reviewTransactions(selectedTransactions()).slice(0, 4);
  $("reviewQueueTitle").textContent = rows.length
    ? `${rows.length} transactions need review`
    : "No category review needed";
  $("reviewQueueMeta").textContent = rows.length
    ? "Confirm these to improve future AI sorting."
    : "High-confidence categories are ready.";
  $("reviewQueueList").innerHTML = rows.map((tx) => `
    <article class="row-card">
      <div class="row-icon">${clean(categoryIcon(tx.category))}</div>
      <div class="row-content">
        <div class="row-top">
          <div>
            <p class="row-title">${clean(tx.merchant)}</p>
            <p class="row-sub">${clean(tx.category)} - ${clean(tx.aiReason || "Needs review")}</p>
          </div>
          <div class="row-value">${money(tx.amount)}</div>
        </div>
        ${aiMeta(tx)}
      </div>
    </article>
  `).join("");
}

function renderInsights(transactions, daily, remaining, extra) {
  const paid = paidOnly(transactions);
  const topDay = [...daily].sort((a, b) => b.amount - a.amount)[0];
  const topMerchant = topGroups(paid, (tx) => tx.merchant, (list) => sum(list), 1)[0];
  const topCategory = topGroups(paid, (tx) => tx.category, (list) => sum(list), 1)[0];
  const reviews = reviewTransactions(transactions);
  const stats = aiStats(transactions);
  $("homeInsightMeta").textContent = `${stats.avgConfidence}% AI confidence`;
  const rows = [
    {
      icon: remaining >= 0 ? "OK" : "!",
      title: remaining >= 0 ? `${money(remaining)} below monthly baseline` : `${money(Math.abs(remaining))} above monthly baseline`,
      sub: `Daily limit is ${money(profile().settings.dailyLimit)}.`
    },
    topDay && {
      icon: "DY",
      title: `${formatDate(topDay.date)} was the highest spend day`,
      sub: `${money(topDay.amount)} across ${topDay.count} payments.`
    },
    topMerchant && {
      icon: initials(topMerchant.key),
      title: `${topMerchant.key} is your top merchant`,
      sub: `${money(topMerchant.amount)} across ${topMerchant.count} payments.`
    },
    topCategory && {
      icon: categoryIcon(topCategory.key),
      title: `${topCategory.key} leads category spend`,
      sub: `${money(topCategory.amount)} this period.`
    },
    reviews.length > 0 && {
      icon: "AI",
      title: `${reviews.length} payments need category review`,
      sub: "Confirm them in More > Ledger to teach the app."
    },
    extra > 0 && {
      icon: "EX",
      title: `${money(extra)} cumulative over-limit spend`,
      sub: "Only the amount above the daily limit is counted."
    }
  ].filter(Boolean);

  $("insightsList").innerHTML = rows.map((row) => `
    <article class="row-card">
      <div class="row-icon">${clean(row.icon)}</div>
      <div class="row-content">
        <div class="row-top">
          <div>
            <p class="row-title">${clean(row.title)}</p>
            <p class="row-sub">${clean(row.sub)}</p>
          </div>
        </div>
      </div>
    </article>
  `).join("");
}

function periodAnalysis(transactions, daily, remaining, extra) {
  const paid = paidOnly(transactions);
  const stats = aiStats(transactions);
  const overDays = daily.filter((day) => day.amount > profile().settings.dailyLimit).length;
  const recurring = recurringCandidates(paid).length;
  const reviews = reviewTransactions(transactions).length;
  let score = 100;
  score -= remaining < 0 ? 22 : 0;
  score -= Math.min(20, overDays * 4);
  score -= Math.min(14, reviews * 2);
  score -= Math.min(10, extra / Math.max(profile().settings.dailyLimit, 1) * 5);
  score += Math.min(6, recurring);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const topCategory = topGroups(paid, (tx) => tx.category, (list) => sum(list), 1)[0];
  return {
    score,
    title: score >= 82 ? "Healthy month detected" : score >= 62 ? "Watch this month closely" : "Overspend risk is high",
    text: remaining >= 0
      ? `You are ${money(remaining)} under baseline. Top spend area is ${topCategory?.key || "not clear yet"}.`
      : `You are ${money(Math.abs(remaining))} over baseline. Review high-value and low-confidence payments first.`,
    chips: [
      `${stats.avgConfidence}% AI confidence`,
      `${overDays} over-limit days`,
      `${reviews} review items`
    ]
  };
}

function aiStats(transactions) {
  const values = transactions.map((tx) => Number(tx.aiConfidence || 0)).filter(Boolean);
  const avgConfidence = values.length ? Math.round(sum(values.map((value) => ({ amount: value }))) / values.length) : 0;
  return { avgConfidence, count: values.length };
}

function reviewTransactions(transactions) {
  return transactions.filter((tx) => tx.aiNeedsReview || Number(tx.aiConfidence || 0) < 75 || tx.category === "Large / Review")
    .sort((a, b) => Number(b.amount) - Number(a.amount));
}

function aiMeta(tx) {
  const confidence = Number(tx.aiConfidence || 0);
  const tone = confidence >= 88 ? "good" : confidence >= 75 ? "warn" : "bad";
  return `
    <div class="ai-meta">
      <span class="confidence ${tone}">${confidence || "--"}% AI</span>
      <span>${clean(tx.aiReason || "AI reason unavailable")}</span>
    </div>
  `;
}

function transactionRow(tx) {
  return `
    <article class="row-card">
      <div class="row-icon">${tx.direction === "Received" ? "IN" : categoryIcon(tx.category)}</div>
      <div class="row-content">
        <div class="row-top">
          <div>
            <p class="row-title">${clean(tx.merchant)}</p>
            <p class="row-sub">${clean(formatDate(tx.date))} ${clean(tx.time)} - ${clean(tx.category)}</p>
          </div>
          <div class="row-value ${tx.direction === "Received" ? "good" : ""}">${tx.direction === "Received" ? "+" : ""}${money(tx.amount)}</div>
        </div>
        ${aiMeta(tx)}
      </div>
    </article>
  `;
}

function topGroups(items, selector, valueSelector = (list) => sum(list), limit = 5) {
  return [...groupBy(items, selector)].map(([key, list]) => ({
    key,
    items: list,
    amount: valueSelector(list),
    count: list.length
  })).sort((a, b) => b.amount - a.amount || b.count - a.count).slice(0, limit);
}

function recurringCandidates(items) {
  return topGroups(items, (tx) => tx.merchant, (list) => sum(list), 40)
    .filter((row) => row.count >= 2)
    .sort((a, b) => b.count - a.count || b.amount - a.amount);
}

function duplicateCandidates(items) {
  return topGroups(items, (tx) => `${tx.date}-${tx.merchant}-${tx.amount}`, (list) => sum(list), 20)
    .filter((row) => row.count >= 2);
}

function categoryFor(tx) {
  return categoryPrediction(tx).category;
}

function categoryPrediction(tx) {
  if (tx.direction === "Received") {
    return {
      category: "Income / Received",
      confidence: 98,
      reason: "Incoming UPI transaction detected.",
      source: "ai-rule",
      needsReview: false
    };
  }
  const merchant = tx.merchant || canonicalMerchant(tx.party);
  let active = null;
  try {
    active = state?.profiles ? profile() : null;
  } catch {
    active = null;
  }
  const rule = active?.merchantRules?.[merchantKey(merchant)];
  if (rule) {
    return {
      category: rule,
      confidence: 100,
      reason: "Matched your previous correction for this merchant.",
      source: "user-rule",
      needsReview: false
    };
  }
  const s = norm(`${tx.party} ${merchant}`);
  const matches = [
    [/pmpml|pune mahanagar|parivahan|parivaahan|irctc|redbus|railway|metro|uber|ola|rapido|ticket|bus/, "Transport", 94, "Matched public transport, ticketing, cab, or travel keywords."],
    [/jio|vi\b|vodafone|airtel|postpaid|mobile|recharge|electricity|broadband|bill|dth/, "Bills & Recharge", 93, "Matched recharge, bill, telecom, or utility keywords."],
    [/hospital|medical|pharma|clinic|doctor|spandan|apollo|medplus|health|diagnostic/, "Health", 92, "Matched health, medicine, clinic, or diagnostic keywords."],
    [/zepto|blinkit|swiggy|zomato|food|caterers|vannakam|amul|parlour|grabngo|restaurant|cafe|canteen|kitchen|tea|coffee|dosa|pizza|burger|biryani|bakery|mart|grocery/, "Food & Groceries", 91, "Matched food, grocery, restaurant, cafe, or canteen keywords."],
    [/fuel|petrol|diesel|hpcl|bpcl|iocl|station/, "Fuel", 91, "Matched fuel station or petroleum keywords."],
    [/amazon|flipkart|myntra|meesho|shopping|marketplace|pay balance/, "Shopping", 88, "Matched shopping marketplace or wallet-balance keywords."],
    [/rent|hasegaonkar|friend|family|loan|split|transfer/, "Personal Transfer", 76, "Looks like a personal transfer; review if it was actually a bill or purchase."]
  ];
  for (const [pattern, category, confidence, reason] of matches) {
    if (pattern.test(s)) return { category, confidence, reason, source: "ai-rule", needsReview: confidence < 82 };
  }
  if (Number(tx.amount) >= 1000) {
    return {
      category: "Large / Review",
      confidence: 58,
      reason: "Large payment without a known merchant pattern.",
      source: "ai-rule",
      needsReview: true
    };
  }
  return {
    category: "Miscellaneous",
    confidence: 62,
    reason: "No strong merchant pattern found.",
    source: "ai-rule",
    needsReview: true
  };
}

function canonicalMerchant(party = "") {
  const s = norm(party);
  if (!s) return "Unknown";
  if (/pmpml|www pmpml org|pune mahanagar|mahanagar pariv|parivahan|parivaahan/.test(s)) return "PMPML";
  if (/irctc/.test(s)) return "IRCTC";
  if (/redbus/.test(s)) return "RedBus";
  if (/jio/.test(s)) return "JIO";
  if (/\bvi\b|vodafone/.test(s)) return "Vi";
  if (/airtel/.test(s)) return "Airtel";
  if (/zepto/.test(s)) return "Zepto";
  if (/amazon/.test(s)) return "Amazon Pay";
  if (/amul/.test(s)) return "Amul";
  if (/spandan/.test(s)) return "Spandan Hospital";
  if (/infosys/.test(s)) return "Infosys Food Court";
  if (/hasegaonkar omkar balaji/.test(s)) return "Hasegaonkar Omkar Balaji";
  const withoutLegal = s
    .replace(/\b(private|limited|pvt|ltd|llp|india|services|service|sewa|official|merchant)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return titleCase(withoutLegal || s);
}

function merchantKey(merchant) {
  return norm(merchant);
}

function bankLabel(tx) {
  return `${tx.bank || "Unknown bank"} ${tx.bankLast4 || ""}`.trim();
}

function bankInitials(label) {
  if (/icici/i.test(label)) return "IC";
  if (/baroda/i.test(label)) return "BoB";
  return initials(label);
}

function initials(text = "") {
  return text.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "UP";
}

function titleCase(text = "") {
  return text.split(/\s+/).filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function categoryIcon(category) {
  if (/food/i.test(category)) return "FD";
  if (/transport/i.test(category)) return "TR";
  if (/bill/i.test(category)) return "BL";
  if (/health/i.test(category)) return "HL";
  if (/shopping/i.test(category)) return "SH";
  if (/fuel/i.test(category)) return "FL";
  if (/income/i.test(category)) return "IN";
  if (/review/i.test(category)) return "RV";
  return "UP";
}

function categoryColor(category) {
  if (/food/i.test(category)) return "var(--green)";
  if (/transport/i.test(category)) return "var(--cyan)";
  if (/bill/i.test(category)) return "var(--amber)";
  if (/health/i.test(category)) return "var(--violet)";
  if (/review/i.test(category)) return "var(--red)";
  return "var(--green)";
}

function formatMonth(month) {
  const [year, value] = month.split("-");
  const date = new Date(Number(year), Number(value) - 1, 1);
  return date.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function formatDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function formatPeriod() {
  const active = profile();
  if (active.settings.selectedMonth !== "all") return formatMonth(active.settings.selectedMonth);
  const months = getMonths();
  if (!months.length) return "No period";
  return `${formatMonth(months[0])} - ${formatMonth(months.at(-1))}`;
}

function emptyRow(message) {
  return `
    <article class="row-card">
      <div class="row-icon">--</div>
      <div class="row-content">
        <p class="row-title">${clean(message)}</p>
        <p class="row-sub">Import a Google Pay PDF from More > Import.</p>
      </div>
    </article>
  `;
}

async function parseGooglePayPdf(file) {
  if (!("DecompressionStream" in window)) {
    throw new Error("PDF import needs Chrome or Edge because parsing happens privately on-device.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = await extractPdfText(bytes);
  const transactions = parseGooglePayText(text, file.name);
  if (!transactions.length) throw new Error("No Google Pay transactions found.");
  return transactions;
}

async function extractPdfText(bytes) {
  const binary = bytesToBinary(bytes);
  const objects = parsePdfObjects(binary);
  const fontMaps = {};
  for (const [, raw] of objects) {
    if (!/\/Type\s*\/Font/.test(raw)) continue;
    const name = raw.match(/\/Name\s*\/(F\d+)/)?.[1] || raw.match(/\/(F\d+)\b/)?.[1];
    const toUnicode = raw.match(/\/ToUnicode\s+(\d+)\s+0\s+R/)?.[1];
    if (name && toUnicode) fontMaps[name] = parseCMap(await inflatedText(Number(toUnicode), objects));
  }

  const pages = [...objects].filter(([, raw]) => /\/Type\s*\/Page\b/.test(raw));
  const pageTexts = [];
  for (const [, pageRaw] of pages) {
    for (const id of contentObjectIds(pageRaw)) {
      pageTexts.push(decodePdfContent(await inflatedText(id, objects), fontMaps));
    }
  }
  return pageTexts.join("\n");
}

function parsePdfObjects(binary) {
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\s*([\s\S]*?)\s*endobj/g;
  let match;
  while ((match = re.exec(binary))) objects.set(Number(match[1]), match[2]);
  return objects;
}

function contentObjectIds(pageRaw) {
  const array = pageRaw.match(/\/Contents\s*\[([^\]]+)\]/)?.[1];
  if (array) return [...array.matchAll(/(\d+)\s+0\s+R/g)].map((item) => Number(item[1]));
  const single = pageRaw.match(/\/Contents\s+(\d+)\s+0\s+R/)?.[1];
  return single ? [Number(single)] : [];
}

async function inflatedText(id, objects) {
  const raw = objects.get(id);
  if (!raw) return "";
  const stream = streamBytes(raw);
  if (!stream) return "";
  try {
    const output = /\/FlateDecode/.test(raw) ? await inflateZlib(stream) : stream;
    return bytesToBinary(output);
  } catch {
    return "";
  }
}

function streamBytes(raw) {
  const streamIndex = raw.indexOf("stream");
  if (streamIndex < 0) return null;
  let start = streamIndex + 6;
  if (raw[start] === "\r" && raw[start + 1] === "\n") start += 2;
  else if (raw[start] === "\n") start += 1;
  const end = raw.indexOf("endstream", start);
  if (end < 0) return null;
  let data = raw.slice(start, end);
  if (data.endsWith("\r\n")) data = data.slice(0, -2);
  else if (data.endsWith("\n") || data.endsWith("\r")) data = data.slice(0, -1);
  return binaryToBytes(data);
}

async function inflateZlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseCMap(text) {
  const map = new Map();
  const bfcharBlocks = [...text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)].map((block) => block[1]).join("\n");
  let match;
  const charRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g;
  while ((match = charRe.exec(bfcharBlocks))) map.set(parseInt(match[1], 16), unicodeFromHex(match[2]));

  const bfrangeBlocks = [...text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)].map((block) => block[1]).join("\n");
  const rangeRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>/g;
  while ((match = rangeRe.exec(bfrangeBlocks))) {
    const start = parseInt(match[1], 16);
    const end = parseInt(match[2], 16);
    const unicodeStart = parseInt(match[3], 16);
    if (end >= start && end - start < 500) {
      for (let code = start; code <= end; code += 1) map.set(code, String.fromCodePoint(unicodeStart + code - start));
    }
  }
  const arrayRangeRe = /<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+\[([^\]]+)\]/g;
  while ((match = arrayRangeRe.exec(bfrangeBlocks))) {
    const start = parseInt(match[1], 16);
    const values = [...match[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((item) => unicodeFromHex(item[1]));
    values.forEach((value, offset) => map.set(start + offset, value));
  }
  return map;
}

function decodePdfContent(content, fontMaps) {
  const blocks = [];
  const blockRe = /BT([\s\S]*?)ET/g;
  let blockMatch;
  while ((blockMatch = blockRe.exec(content))) {
    let font = "F5";
    let text = "";
    const tokenRe = /\/(F\d+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>/g;
    let token;
    while ((token = tokenRe.exec(blockMatch[1]))) {
      if (token[1]) font = token[1];
      if (token[2]) text += decodeHexText(token[2], fontMaps[font]);
    }
    if (text.trim()) blocks.push(text);
  }
  return blocks.join("\n");
}

function decodeHexText(hex, map) {
  let out = "";
  for (let index = 0; index < hex.length; index += 4) {
    const code = parseInt(hex.slice(index, index + 4), 16);
    out += map?.get(code) ?? "";
  }
  return out;
}

function unicodeFromHex(hex) {
  let output = "";
  for (let index = 0; index < hex.length; index += 4) output += String.fromCodePoint(parseInt(hex.slice(index, index + 4), 16));
  return output;
}

function bytesToBinary(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) out += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return out;
}

function binaryToBytes(binary) {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 255;
  return bytes;
}

function parseGooglePayText(text, fileName) {
  const tokens = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
  const transactions = [];
  for (let index = 0; index < tokens.length - 14; index += 1) {
    const day = tokens[index];
    const monthName = tokens[index + 1]?.replace(",", "");
    const year = tokens[index + 2];
    const time = tokens[index + 3];
    const ampm = tokens[index + 4];
    const direction = tokens[index + 5];
    if (!/^\d{2}$/.test(day) || !MONTHS[monthName] || !/^20\d{2}$/.test(year) || !/^\d{2}:\d{2}$/.test(time) || !/^(AM|PM)$/.test(ampm) || !/^(Paid|Received)$/.test(direction)) continue;

    let cursor = index + 6;
    const relation = tokens[cursor];
    if (!/^(to|from)$/i.test(relation)) continue;
    cursor += 1;

    const party = [];
    while (cursor < tokens.length && !(tokens[cursor] === "UPI" && tokens[cursor + 1] === "Transaction" && tokens[cursor + 2] === "ID:")) {
      party.push(tokens[cursor]);
      cursor += 1;
    }
    if (cursor >= tokens.length) continue;
    cursor += 3;
    const upiId = tokens[cursor] || "";
    cursor += 1;
    if (tokens[cursor] !== "Paid" || !/^(by|to)$/i.test(tokens[cursor + 1] || "")) continue;
    const accountRole = tokens[cursor + 1];
    cursor += 2;

    const bankParts = [];
    while (cursor < tokens.length && !/^₹/.test(tokens[cursor])) {
      bankParts.push(tokens[cursor]);
      cursor += 1;
    }
    if (!/^₹/.test(tokens[cursor] || "")) continue;

    const amount = Number(tokens[cursor].replace(/[₹,]/g, ""));
    const bankLast4 = /^\d{4}$/.test(bankParts.at(-1) || "") ? bankParts.at(-1) : "";
    const bank = bankLast4 ? bankParts.slice(0, -1).join(" ") : bankParts.join(" ");
    const date = `${year}-${MONTHS[monthName]}-${day}`;
    const partyName = party.join(" ").replace(/\s+/g, " ").trim();
    const tx = {
      id: upiId || `${date}-${time}-${partyName}-${amount}`,
      sourceFile: fileName,
      date,
      month: date.slice(0, 7),
      time: `${time} ${ampm}`,
      direction,
      relation,
      party: partyName,
      upiId,
      accountRole,
      bank,
      bankLast4,
      amount
    };
    tx.merchant = canonicalMerchant(tx.party);
    tx.category = categoryFor(tx);
    transactions.push(tx);
    index = cursor;
  }
  return transactions;
}

function exportBackup() {
  const active = profile();
  const blob = new Blob([JSON.stringify({ ...state, exportedProfileId: active.id }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rupee-pulse-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Backup downloaded.");
}

async function restoreBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const restored = JSON.parse(await file.text());
    state = normalizeState(restored);
    chooseLatestMonth();
    saveState();
    render();
    toast("Backup restored.");
  } catch (error) {
    toast(error.message || "Could not restore backup.");
  }
  $("restoreInput").value = "";
}

function clearProfileData() {
  const active = profile();
  openConfirmModal(
    "Clear profile data?",
    `This will remove all imported statements and category rules for ${active.name}.`,
    () => clearActiveProfileData()
  );
}

function clearActiveProfileData() {
  const active = profile();
  active.transactions = [];
  active.imports = [];
  active.merchantRules = {};
  ui.expandedDay = "";
  ui.categoryDetail = "";
  ui.merchantScreen = "home";
  ui.merchantListType = "frequent";
  ui.merchantDetail = "";
  saveState();
  render();
  toast(`${active.name} profile cleared.`);
}

function loadDemoData() {
  const active = profile();
  const demo = [
    ["2026-02-01", "09:03 AM", "Paid", "ZEPTO MARKETPLACE PRIVATE LIMITED", "Bank of Baroda", "9162", 100],
    ["2026-02-01", "10:06 AM", "Paid", "JIO Postpaid", "Bank of Baroda", "9162", 118],
    ["2026-02-01", "03:58 PM", "Paid", "IRCTC E-TICKETING", "Bank of Baroda", "9162", 421.8],
    ["2026-02-01", "04:02 PM", "Received", "Golden Verma", "Bank of Baroda", "9162", 320],
    ["2026-02-14", "08:12 PM", "Paid", "Airtel recharge", "ICICI Bank", "7666", 759],
    ["2026-02-18", "06:30 PM", "Paid", "Large personal payment", "ICICI Bank", "7666", 3570],
    ["2026-03-02", "11:20 AM", "Paid", "Pune Mahanagar Parivahan Sewa", "Bank of Baroda", "9162", 20],
    ["2026-03-14", "09:45 AM", "Paid", "www.pmpml.org", "ICICI Bank", "7666", 20],
    ["2026-03-14", "06:05 PM", "Paid", "PMPML", "ICICI Bank", "7666", 20],
    ["2026-03-30", "08:30 PM", "Paid", "Amazon Pay Balance", "Bank of Baroda", "9162", 1602],
    ["2026-04-01", "01:10 PM", "Paid", "Family transfer", "Bank of Baroda", "9162", 9634],
    ["2026-04-14", "10:10 AM", "Paid", "Vi recharge", "ICICI Bank", "7666", 727],
    ["2026-04-23", "07:20 PM", "Paid", "Amul Parlour", "ICICI Bank", "7666", 73],
    ["2026-04-26", "05:50 PM", "Paid", "Large review payment", "Bank of Baroda", "9162", 20114],
    ["2026-04-28", "09:00 AM", "Paid", "RADHE FUEL STATION", "Bank of Baroda", "9162", 1000]
  ].map(([date, time, direction, party, bank, bankLast4, amount], index) => {
    const tx = {
      id: `demo-${active.id}-${index}`,
      sourceFile: "demo-data",
      date,
      month: date.slice(0, 7),
      time,
      direction,
      relation: direction === "Paid" ? "to" : "from",
      party,
      upiId: `DEMO${String(index + 1).padStart(4, "0")}`,
      accountRole: direction === "Paid" ? "by" : "to",
      bank,
      bankLast4,
      amount
    };
    return enrichTransaction(tx);
  });
  mergeTransactions(active, demo);
  active.imports.unshift({ id: `demo-${Date.now()}`, name: "demo-data", importedAt: new Date().toISOString(), count: demo.length });
  chooseLatestMonth();
  saveState();
  render();
  toast("Demo data loaded.");
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

bindEvents();
chooseLatestMonth();
render();
hydratePersistentState();
