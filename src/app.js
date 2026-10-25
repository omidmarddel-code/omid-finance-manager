import { NativeBiometric } from "@capgo/capacitor-native-biometric";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { StatusBar } from "@capacitor/status-bar";
import { isValidJalaaliDate, toGregorian, toJalaali } from "jalaali-js";
import {
  all,
  clearStore,
  initializeDatabase,
  isNativeDatabase,
  remove as dbRemove,
  save as dbSave,
} from "./db.js";
import {
  displayCategory,
  getLanguage,
  localizeDOM,
  locale,
  setLanguage,
  t,
} from "./i18n.js";
import {
  installmentMonths,
  installmentPaidCount,
  installmentBalance,
  installmentDueAmount,
} from "./finance-utils.js";

const root = document.querySelector("#app");
// Every data mutation schedules a debounced in-app auto-backup, so the latest
// snapshot (and the quick-restore target) always reflects the newest change.
async function save(storeName, row) {
  await dbSave(storeName, row);
  scheduleAutoBackup();
}
async function remove(storeName, key) {
  await dbRemove(storeName, key);
  scheduleAutoBackup();
}
const number = {
  format: (amount, options) =>
    new Intl.NumberFormat(
      getLanguage() === "en" ? "en-US" : "fa-IR",
      options,
    ).format(amount),
};
const money = (amount) =>
  `${number.format(Math.round(Number(amount) || 0))} ${getLanguage() === "en" ? "Toman" : "تومان"}`;
// Keep date-only values in the device's local timezone (the app's users work in Tehran).
const dateNow = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
let lastBackPressAt = 0;
const localizeDigits = (value) =>
  getLanguage() === "en"
    ? String(value)
    : String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
const normalizeDigits = (value) =>
  String(value)
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632));
const amountDigits = (value) => normalizeDigits(value).replace(/[^0-9]/g, "");
const formatAmount = (value) =>
  amountDigits(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function formatJalaliDate(isoDate) {
  const [gy, gm, gd] = isoDate.split("-").map(Number);
  const { jy, jm, jd } = toJalaali(gy, gm, gd);
  return localizeDigits(
    `${jy}/${String(jm).padStart(2, "0")}/${String(jd).padStart(2, "0")}`,
  );
}
function parseJalaliParts(value) {
  const match = normalizeDigits(value)
    .trim()
    .match(/^(\d{4})[./]?(\d{1,2})[./]?(\d{1,2})$/);
  if (!match) return null;
  const [, jyText, jmText, jdText] = match;
  const jy = Number(jyText);
  const jm = Number(jmText);
  const jd = Number(jdText);
  try {
    if (!isValidJalaaliDate(jy, jm, jd)) return null;
    const { gy, gm, gd } = toGregorian(jy, jm, jd);
    return {
      jy,
      jm,
      jd,
      iso: `${gy}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}`,
    };
  } catch {
    return null;
  }
}
function parseJalaliDate(value) {
  return parseJalaliParts(value)?.iso || null;
}
const jalaliMonthLength = (year, month) =>
  month <= 6
    ? 31
    : month <= 11
      ? 30
      : isValidJalaaliDate(year, 12, 30)
        ? 30
        : 29;
function addJalaliMonth(jy, jm, diff) {
  const total = jy * 12 + (jm - 1) + diff;
  return { jy: Math.floor(total / 12), jm: (((total % 12) + 12) % 12) + 1 };
}
const jalaliKey = (jy, jm) => `${jy}-${String(jm).padStart(2, "0")}`;
const monthNow = () => {
  const [gy, gm, gd] = dateNow().split("-").map(Number);
  const { jy, jm } = toJalaali(gy, gm, gd);
  return jalaliKey(jy, jm);
};
const localDateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const id = () => crypto.randomUUID();
const escape = (text = "") =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const state = {
  page: "home",
  unlocked: false,
  availableBio: false,
  transactions: [],
  installments: [],
  payments: [],
  checks: [],
  categories: [],
  settings: {},
  budgets: [],
  savingsTransfers: [],
  savingsMovements: [],
  pendingMonthEntry: false,
  monthPromptShown: false,
  monthCycle: monthNow(),
  search: "",
  filter: "all",
  report: monthNow(),
  reportType: "month",
  lockTimer: 0,
  lastActivity: Date.now(),
  settingsPane: "home",
};
const defaultCategories = [
  "غذا",
  "خانه",
  "خودرو",
  "سوخت",
  "خرید",
  "درمان",
  "تفریح",
  "قبوض",
  "موبایل",
  "پوشاک",
  "سایر",
];
const tabs = [
  ["home", "خانه", "⌂"],
  ["expenses", "هزینه‌ها", "≡"],
  ["installments", "اقساط", "▤"],
  ["checks", "چک‌ها", "▣"],
  ["reports", "گزارش", "▥"],
  ["settings", "تنظیمات", "⚙"],
];

const fontSizeScale = { small: 0.88, normal: 1, large: 1.16, xlarge: 1.32 };
const fontSizeKey = () => {
  const value = setting("fontSize", "large");
  return fontSizeScale[value] ? value : "large";
};
function applyFontSize() {
  const key = fontSizeKey();
  if (key === "normal") document.documentElement.removeAttribute("data-font");
  else document.documentElement.dataset.font = key;
}
const setting = (key, fallback = "") => {
  try {
    return JSON.parse(state.settings[key] ?? JSON.stringify(fallback));
  } catch {
    return state.settings[key] ?? fallback;
  }
};
async function setSetting(key, value) {
  const stored = JSON.stringify(value);
  state.settings[key] = stored;
  await save("settings", { key, value: stored });
}
async function applyStatusBarTheme(theme) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await StatusBar.setOverlaysWebView({ overlay: false });
  } catch (error) {
    console.warn("Could not update Android status bar overlay.", error);
  }
  try {
    await StatusBar.setStyle({ style: theme === "dark" ? "DARK" : "LIGHT" });
  } catch (error) {
    console.warn("Could not update Android status bar icons.", error);
  }
  try {
    await StatusBar.setBackgroundColor({
      color: theme === "dark" ? "#111820" : "#edf4fa",
    });
  } catch (error) {
    console.warn("Could not update Android status bar color.", error);
  }
  try {
    await StatusBar.show();
  } catch (error) {
    console.warn("Could not show Android status bar.", error);
  }
}
async function refresh() {
  const [
    transactions,
    installments,
    payments,
    checks,
    categories,
    settings,
    budgets,
    savingsTransfers,
    savingsMovements,
  ] = await Promise.all(
    [
      "transactions",
      "installments",
      "payments",
      "checks",
      "categories",
      "settings",
      "budgets",
      "savings_transfers",
      "savings_movements",
    ].map(all),
  );
  const recordedPayments = new Map();
  for (const payment of payments)
    recordedPayments.set(
      payment.installment_id,
      (recordedPayments.get(payment.installment_id) || 0) + 1,
    );
  for (const item of installments) {
    let changed = false;
    if (!item.due_month) {
      // Older Android database schemas did not persist these two schedule fields.
      // start_date is the next due date entered by the user; reconstruct the original base month.
      const initialPaid = Math.min(
        Math.trunc(Number(item.months) || 0),
        Math.max(0, Math.trunc(Number(item.paid_count) || 0)),
      );
      item.paid_count = Math.min(
        installmentMonths(item),
        initialPaid + (recordedPayments.get(item.id) || 0),
      );
      const nextMonth = isoToJalaliKey(item.start_date);
      const [jy, jm] = nextMonth.split("-").map(Number);
      const firstMonth = addJalaliMonth(jy, jm, -initialPaid);
      const day = Math.min(
        Number(item.due_day) || 1,
        jalaliMonthLength(firstMonth.jy, firstMonth.jm),
      );
      item.due_month = `${jalaliKey(firstMonth.jy, firstMonth.jm)}-${String(day).padStart(2, "0")}`;
      const nextDueMonth = addJalaliMonth(
        firstMonth.jy,
        firstMonth.jm,
        item.paid_count,
      );
      const nextDueDay = Math.min(
        Number(item.due_day) || 1,
        jalaliMonthLength(nextDueMonth.jy, nextDueMonth.jm),
      );
      item.next_due_date = jalaliToIso(
        nextDueMonth.jy,
        nextDueMonth.jm,
        nextDueDay,
      );
      changed = true;
    }
    if (!item.next_due_date) {
      item.next_due_date = item.start_date;
      changed = true;
    }
    if (changed) await save("installments", item);
  }
  Object.assign(state, {
    transactions,
    installments,
    payments,
    checks,
    categories,
    settings: Object.fromEntries(settings.map((row) => [row.key, row.value])),
    budgets,
    savingsTransfers,
    savingsMovements,
  });
  scheduleAutoBackup();
}
export function savingsBalance() {
  return (
    state.savingsTransfers.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0,
    ) +
    state.savingsMovements.reduce(
      (sum, row) =>
        sum + (row.kind === "deposit" ? 1 : -1) * Number(row.amount || 0),
      0,
    )
  );
}
export function confirmSavingsFunding(amount, month) {
  const deficit = Math.max(
    0,
    Number(amount) - Math.max(0, monthData(month).rawRemaining),
  );
  if (!deficit) return 0;
  const savings = savingsBalance();
  if (savings >= deficit)
    return confirm(
      t("موجودی ماه کافی نیست. مبلغ باقی‌مانده از پس‌انداز برداشت شود؟"),
    )
      ? deficit
      : null;
  const available = Math.max(0, savings);
  if (available <= 0) {
    alert(t("پس‌اندازی نداری."));
    return null;
  }
  return confirm(
    "پس‌انداز برای پوشش کامل این هزینه کافی نیست. فقط مبلغ " +
      available.toLocaleString() +
      " تومان قابل برداشت است و ماندهٔ ماه همچنان منفی خواهد بود. ادامه می‌دهی؟",
  )
    ? available
    : null;
}
const monthName = (key) => {
  const [year, month] = key.split("-").map(Number);
  const names = getLanguage() === "en" ? jalaliMonthsEn : jalaliMonths;
  return `${names[month - 1]} ${localizeDigits(year)}`;
};
const shortDate = (value) => formatJalaliDate(value);
const addMonth = (key, diff) => {
  const [year, month] = key.split("-").map(Number);
  const next = addJalaliMonth(year, month, diff);
  return jalaliKey(next.jy, next.jm);
};
const legacyPeriodToJalali = (period) => {
  const match = String(period || "").match(/^(\d{4})-(\d{2})$/);
  if (!match || Number(match[1]) < 1700) return period;
  const { jy, jm } = toJalaali(Number(match[1]), Number(match[2]), 15);
  return jalaliKey(jy, jm);
};

async function digest(pin, salt) {
  const data = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${pin}`),
  );
  return [...new Uint8Array(data)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function salaryEstimateFor(month) {
  const stored = setting(`salaryEstimate:${month}`, null);
  if (stored !== null && stored !== "") return +stored || 0;
  const legacyEstimate = Object.entries(state.settings).find(([key]) => {
    const match = key.match(/^salaryEstimate:(\d{4}-\d{2})$/);
    return match && legacyPeriodToJalali(match[1]) === month;
  });
  if (legacyEstimate) {
    try {
      return +JSON.parse(legacyEstimate[1]) || 0;
    } catch {
      return 0;
    }
  }
  // Backward compatibility: older versions saved the estimate only in monthlySalary.
  const oldGregorianMonth = dateNow().slice(0, 7);
  if (
    month === monthNow() &&
    (setting(`salary-estimate:${month}`, false) ||
      setting(`salary-estimate:${oldGregorianMonth}`, false))
  )
    return +setting("monthlySalary", 0) || 0;
  return 0;
}
export function monthData(month) {
  const rows = state.transactions.filter(
    (row) => isoToJalaliKey(row.date) === month,
  );
  const expenses = rows.filter((row) => row.kind === "expense");
  const salaryRows = rows.filter((row) => row.kind === "salary");
  const salaryActual = salaryRows.reduce((sum, row) => sum + +row.amount, 0);
  const salaryEstimate = salaryEstimateFor(month);
  const salaryReceived = salaryRows.length > 0;
  const salary = salaryReceived ? salaryActual : salaryEstimate;
  const income = rows
    .filter((row) => row.kind === "income")
    .reduce((sum, row) => sum + +row.amount, 0);
  const expense = expenses.reduce((sum, row) => sum + +row.amount, 0);
  // New payments are keyed by their Jalali due cycle; paid_at is the actual cash-flow month.
  // Fall back to period for records created by older app versions.
  const payments = state.payments.filter((row) =>
    row.paid_at
      ? isoToJalaliKey(row.paid_at) === month
      : legacyPeriodToJalali(row.period) === month,
  );
  const paid = payments.reduce((sum, row) => sum + +row.amount, 0);
  const monthTransfer =
    state.savingsTransfers.find((row) => row.period === month) ||
    state.savingsTransfers.find(
      (row) => legacyPeriodToJalali(row.period) === month,
    );
  const savingsTransferred = Number(monthTransfer?.amount || 0);
  const savingsWithdrawals = state.savingsMovements
    .filter(
      (row) => row.kind === "withdrawal" && isoToJalaliKey(row.date) === month,
    )
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const due = state.installments.reduce((sum, item) => {
    for (let offset = 0; offset < installmentMonths(item); offset++) {
      // Match obligations and financial reports by the same Jalali month key.
      if (dueMonthForOffset(item, offset).key === month) {
        sum += installmentDueAmount(item, offset);
      }
    }
    return sum;
  }, 0);
  const rawRemaining =
    salary + income + savingsWithdrawals - expense - paid - savingsTransferred;
  return {
    rows,
    expenses,
    salary,
    salaryActual,
    salaryEstimate,
    salaryReceived,
    income,
    expense,
    paid,
    savingsTransferred,
    savingsWithdrawals,
    due,
    rawRemaining,
    remaining: rawRemaining,
    payments,
  };
}
function yearData(year) {
  const months = Array.from(
    { length: 12 },
    (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`,
  ).map(monthData);
  const rawRemaining = months.reduce((sum, row) => sum + row.rawRemaining, 0);
  return {
    rows: months.flatMap((row) => row.rows),
    expenses: months.flatMap((row) => row.expenses),
    salary: months.reduce((sum, row) => sum + row.salary, 0),
    income: months.reduce((sum, row) => sum + row.income, 0),
    expense: months.reduce((sum, row) => sum + row.expense, 0),
    paid: months.reduce((sum, row) => sum + row.paid, 0),
    savingsTransferred: months.reduce(
      (sum, row) => sum + row.savingsTransferred,
      0,
    ),
    due: months.reduce((sum, row) => sum + row.due, 0),
    rawRemaining,
    remaining: rawRemaining,
  };
}
async function closePreviousMonths() {
  // باقی ماندهٔ ماه‌های قبل به صورت خودکار به پس‌انداز منتقل نمی‌شود؛
  // انتقال فقط با دستور دستی کاربر انجام می‌گیرد.
  return;
}
async function transferRemainingToSavings(month = monthNow()) {
  if (
    state.savingsTransfers.some(
      (transfer) => legacyPeriodToJalali(transfer.period) === month,
    )
  ) {
    toast("مازاد این ماه قبلاً به پس‌انداز منتقل شده است.", true);
    return;
  }
  const surplus = monthData(month).rawRemaining;
  if (surplus <= 0) {
    toast("مازادی برای انتقال به پس‌انداز وجود ندارد.", true);
    return;
  }
  const transfer = { period: month, amount: surplus, created_at: dateNow() };
  await save("savings_transfers", transfer);
  state.savingsTransfers.push(transfer);
  await refresh();
  render();
  toast("مازاد ماه به پس‌انداز منتقل شد.");
}
async function prepareCurrentMonth() {
  const current = monthNow();
  state.monthCycle = current;
  await closePreviousMonths();
  state.pendingMonthEntry = false;
  state.monthPromptShown = false;
}
async function checkMonthCycle() {
  if (monthNow() === state.monthCycle) return;
  await prepareCurrentMonth();
  if (state.unlocked && !document.querySelector("#modalRoot .modal")) render();
}
function debtRemaining() {
  return state.installments.reduce(
    (sum, item) => sum + installmentBalance(item),
    0,
  );
}
function installmentNotificationId(installmentId, period) {
  let hash = 2166136261;
  for (const char of `${installmentId}:${period}`)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 2_000_000_000) + 1;
}
async function requestInstallmentNotificationPermission() {
  if (!Capacitor.isNativePlatform()) return false;
  let permission = await LocalNotifications.checkPermissions();
  if (permission.display !== "granted")
    permission = await LocalNotifications.requestPermissions();
  return permission.display === "granted";
}
async function cancelInstallmentNotifications() {
  const pending = await LocalNotifications.getPending();
  const notifications = pending.notifications
    .filter(
      (notification) => notification.extra?.kind === "installment-reminder",
    )
    .map((notification) => ({ id: notification.id }));
  if (notifications.length) await LocalNotifications.cancel({ notifications });
}
async function cancelExpenseLogReminders() {
  const pending = await LocalNotifications.getPending();
  const notifications = pending.notifications
    .filter((n) => n.extra?.kind === "expense-log-reminder")
    .map((n) => ({ id: n.id }));
  if (notifications.length) await LocalNotifications.cancel({ notifications });
}
async function scheduleExpenseLogReminders() {
  if (!Capacitor.isNativePlatform()) return;
  if (!setting("expenseLogReminders", true)) {
    await cancelExpenseLogReminders();
    return;
  }
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== "granted") {
    await cancelExpenseLogReminders();
    return;
  }
  await cancelExpenseLogReminders();
  const now = new Date();
  const notifications = [9, 21].map((hour) => {
    const at = new Date(now);
    at.setHours(hour, 0, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return {
      id: installmentNotificationId("expense-log", String(hour)),
      title: getLanguage() === "en" ? "Expense reminder" : "یادآوری ثبت هزینه",
      body:
        getLanguage() === "en"
          ? "If you had any expenses, remember to record them in the app."
          : "اگر خرجی داشتی، یادت باشد آن را در برنامه ثبت کنی.",
      schedule: { at, repeats: true, allowWhileIdle: true },
      isExactNotification: false,
      extra: { kind: "expense-log-reminder" },
    };
  });
  await LocalNotifications.schedule({ notifications });
}
async function cancelCheckNotifications() {
  const pending = await LocalNotifications.getPending();
  const notifications = pending.notifications
    .filter((n) => n.extra?.kind === "check-reminder")
    .map((n) => ({ id: n.id }));
  if (notifications.length) await LocalNotifications.cancel({ notifications });
}
async function scheduleCheckNotifications() {
  if (!Capacitor.isNativePlatform()) return;
  await cancelCheckNotifications();
  if (
    !state.checks.length ||
    (await LocalNotifications.checkPermissions()).display !== "granted"
  )
    return;
  const now = new Date();
  const notifications = [];
  for (const check of state.checks) {
    for (const daysBefore of [7, 2]) {
      const at = new Date(`${check.due_date}T09:00:00`);
      at.setDate(at.getDate() - daysBefore);
      if (at <= now) continue;
      notifications.push({
        id: installmentNotificationId(`check:${check.id}`, String(daysBefore)),
        title:
          getLanguage() === "en"
            ? "Check payment reminder"
            : "یادآوری پرداخت چک",
        body:
          getLanguage() === "en"
            ? `“${check.title}” for ${money(check.amount)} is due in ${daysBefore} days (${formatJalaliDate(check.due_date)}).`
            : `چک «${check.title}» به مبلغ ${money(check.amount)} تا ${daysBefore} روز دیگر، در تاریخ ${formatJalaliDate(check.due_date)} سررسید می‌شود.`,
        schedule: { at, allowWhileIdle: true },
        isExactNotification: false,
        extra: { kind: "check-reminder", checkId: check.id, daysBefore },
      });
      if (notifications.length >= 450) break;
    }
    if (notifications.length >= 450) break;
  }
  if (notifications.length)
    await LocalNotifications.schedule({ notifications });
}
// The Jalali month a given unpaid installment belongs to.
function dueMonthForOffset(item, offset) {
  const base = item.due_month || isoToJalaliKey(item.start_date);
  const [by, bm] = base.split("-").map(Number);
  const target = addJalaliMonth(by, bm, offset);
  const day = Math.min(
    Number(item.due_day) || 1,
    jalaliMonthLength(target.jy, target.jm),
  );
  return { ...target, day, key: jalaliKey(target.jy, target.jm) };
}
// The date + 9am the reminder for that installment fires on.
function dueDateForOffset(item, offset) {
  const { jy, jm, day } = dueMonthForOffset(item, offset);
  return new Date(`${jalaliToIso(jy, jm, day)}T09:00:00`);
}
async function scheduleInstallmentNotifications() {
  if (!Capacitor.isNativePlatform()) return;
  if (!setting("installmentReminders", true)) {
    await cancelInstallmentNotifications();
    return;
  }
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== "granted") {
    await cancelInstallmentNotifications();
    return;
  }
  await cancelInstallmentNotifications();
  const now = new Date();
  const notifications = [];
  for (const item of state.installments) {
    for (
      let offset = installmentPaidCount(item);
      offset < installmentMonths(item) &&
      installmentBalance(item) > 0 &&
      notifications.length < 450;
      offset++
    ) {
      const period = dueMonthForOffset(item, offset).key;
      const dueDate = dueDateForOffset(item, offset);
      const dueAmount = installmentDueAmount(item, offset);
      if (
        dueAmount <= 0 ||
        state.payments.some(
          (payment) =>
            payment.installment_id === item.id && payment.period === period,
        )
      )
        continue;
      // Alert for the oldest missed installment shortly after enabling reminders, then
      // schedule future installments normally. Later overdue items become the next alert
      // after the preceding installment is recorded as paid.
      if (
        offset > installmentPaidCount(item) &&
        localDateKey(dueDate) < dateNow()
      )
        continue;
      let at = dueDate;
      if (at <= now) at = new Date(now.getTime() + 60_000);
      notifications.push({
        id: installmentNotificationId(item.id, period),
        title: getLanguage() === "en" ? "Installment due today" : "یادآوری قسط",
        body:
          getLanguage() === "en"
            ? `“${item.name}” is due today. Amount: ${money(dueAmount)}.`
            : `قسط «${item.name}» امروز سررسید می‌شود؛ مبلغ ${money(dueAmount)} است.`,
        schedule: { at, allowWhileIdle: true },
        // Deliver during idle without requesting Android's separate exact-alarm access.
        isExactNotification: false,
        extra: { kind: "installment-reminder", installmentId: item.id, period },
      });
    }
    if (notifications.length >= 450) break;
  }
  if (notifications.length)
    await LocalNotifications.schedule({ notifications });
}
function jalaliToIso(jy, jm, jd) {
  const { gy, gm, gd } = toGregorian(jy, jm, jd);
  return `${gy}-${String(gm).padStart(2, "0")}-${String(gd).padStart(2, "0")}`;
}
const isoToJalaliKey = (isoDate) => {
  const [gy, gm, gd] = isoDate.split("-").map(Number);
  const { jy, jm } = toJalaali(gy, gm, gd);
  return jalaliKey(jy, jm);
};
function jalaliDateInput(label, name, isoDate = dateNow()) {
  return `<label>${label}<span class="jalali-date-control"><input name="${name}" type="text" data-jalali inputmode="numeric" maxlength="10" placeholder="${getLanguage() === "en" ? "1405/07/09" : "۱۴۰۵/۰۷/۰۹"}" dir="ltr" autocomplete="off" value="${formatJalaliDate(isoDate)}" required /><button type="button" class="calendar-trigger" data-calendar-open aria-label="${getLanguage() === "en" ? "Open calendar" : "باز کردن تقویم"}" title="${getLanguage() === "en" ? "Open calendar" : "باز کردن تقویم"}">▦</button></span><small class="field-error" hidden></small><span class="jalali-calendar" hidden></span></label>`;
}
const jalaliMonths = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];
const jalaliMonthsEn = [
  "Farvardin",
  "Ordibehesht",
  "Khordad",
  "Tir",
  "Mordad",
  "Shahrivar",
  "Mehr",
  "Aban",
  "Azar",
  "Dey",
  "Bahman",
  "Esfand",
];
let activeJalaliCalendar = null;
function drawJalaliCalendar(
  wrapper,
  year,
  month,
  popup = wrapper.querySelector(".jalali-calendar"),
) {
  const field = wrapper.querySelector("input[data-jalali]");
  const current = parseJalaliParts(field.value);
  const firstDate = new Date(`${jalaliToIso(year, month, 1)}T12:00:00`);
  const offset = (firstDate.getDay() + 1) % 7;
  const count = jalaliMonthLength(year, month);
  const english = getLanguage() === "en";
  const weekdays = english
    ? ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]
    : ["ش", "ی", "د", "س", "چ", "پ", "ج"];
  const monthName = (english ? jalaliMonthsEn : jalaliMonths)[month - 1];
  const today = toJalaali(
    new Date().getFullYear(),
    new Date().getMonth() + 1,
    new Date().getDate(),
  );
  const cells = [
    ...Array(offset).fill('<span class="calendar-empty"></span>'),
    ...Array.from({ length: count }, (_, index) => {
      const day = index + 1;
      const selected =
        current?.jy === year && current?.jm === month && current?.jd === day;
      const isToday =
        today.jy === year && today.jm === month && today.jd === day;
      return `<button type="button" class="calendar-day${selected ? " selected" : ""}${isToday ? " today" : ""}" data-calendar-day="${day}">${localizeDigits(day)}</button>`;
    }),
  ].join("");
  wrapper.dataset.calendarYear = String(year);
  wrapper.dataset.calendarMonth = String(month);
  popup.innerHTML = `<div class="calendar-heading"><button type="button" class="calendar-nav" data-calendar-step="-1" aria-label="${english ? "Previous month" : "ماه قبل"}">‹</button><strong>${monthName} ${localizeDigits(year)}</strong><button type="button" class="calendar-nav" data-calendar-step="1" aria-label="${english ? "Next month" : "ماه بعد"}">›</button></div><div class="calendar-weekdays">${weekdays.map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-days">${cells}</div>`;
  popup.hidden = false;
}
function positionJalaliCalendar() {
  if (!activeJalaliCalendar) return;
  const { wrapper, popup, anchor } = activeJalaliCalendar;
  if (!wrapper.isConnected || !anchor.isConnected) {
    closeJalaliCalendar();
    return;
  }
  const fieldRect = anchor.getBoundingClientRect();
  if (fieldRect.bottom < 0 || fieldRect.top > window.innerHeight) {
    closeJalaliCalendar();
    return;
  }
  const popupRect = popup.getBoundingClientRect();
  const width = Math.min(popupRect.width || 252, window.innerWidth - 16);
  const left = Math.max(
    8,
    Math.min(fieldRect.left, window.innerWidth - width - 8),
  );
  const below = window.innerHeight - fieldRect.bottom - 8;
  const above = fieldRect.top - 8;
  let top =
    below >= popupRect.height || below >= above
      ? fieldRect.bottom + 6
      : fieldRect.top - popupRect.height - 6;
  top = Math.max(8, Math.min(top, window.innerHeight - popupRect.height - 8));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}
function closeJalaliCalendar() {
  if (!activeJalaliCalendar) return;
  const { wrapper, popup, reposition } = activeJalaliCalendar;
  window.removeEventListener("scroll", reposition, true);
  window.removeEventListener("resize", reposition);
  popup.hidden = true;
  popup.style.left = "";
  popup.style.top = "";
  wrapper.append(popup);
  activeJalaliCalendar = null;
}
function openJalaliCalendar(wrapper) {
  closeJalaliCalendar();
  const parts =
    parseJalaliParts(wrapper.querySelector("input[data-jalali]").value) ||
    toJalaali(
      new Date().getFullYear(),
      new Date().getMonth() + 1,
      new Date().getDate(),
    );
  const popup = wrapper.querySelector(".jalali-calendar");
  const anchor = wrapper.querySelector("[data-calendar-open]");
  document.body.append(popup);
  drawJalaliCalendar(wrapper, parts.jy, parts.jm, popup);
  const reposition = () => positionJalaliCalendar();
  activeJalaliCalendar = { wrapper, popup, anchor, reposition };
  positionJalaliCalendar();
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
}
function pageHeading(title, sub) {
  const displayedTitle = title === "نمای کلی" ? "داشبورد" : title;
  return `<div class="page-heading"><div>${sub ? `<p class="eyebrow">${sub}</p>` : ""}<h1>${displayedTitle}</h1></div>${title === "نمای کلی" ? `<span class="today-chip">${new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</span>` : ""}</div>`;
}

function authScreen() {
  const setup = !setting("pinHash");
  root.innerHTML = `<main class="auth-shell">
    <section class="auth-card">
      <div class="auth-brand"><b>مدیریت مالی حقوق</b></div>
      ${setup ? "" : '<p class="eyebrow">خوش برگشتی</p>'}
      <h1>${setup ? "رمز خود را وارد کنید" : "ورود به حساب"}</h1>
      ${setup ? "" : '<p class="auth-copy">برای دیدن فضای مالی خود، PIN را وارد کن.</p>'}
      <form data-form="pin">
        <label>${setup ? "PIN چهار یا شش رقمی" : "PIN ورود"}<input name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" minlength="4" maxlength="6" pattern="[0-9]{4}|[0-9]{6}" required placeholder="••••" /></label>
        ${setup ? '<label>تکرار PIN<input name="confirm" type="password" inputmode="numeric" minlength="4" maxlength="6" required placeholder="••••" /></label>' : ""}
        <p class="form-error" id="authError"></p>
        <button class="primary-button full-button">${setup ? "ساخت قفل" : "ورود امن"} <span>←</span></button>
      </form>
      ${!setup && state.availableBio && setting("biometricEnabled", true) ? '<button class="outline-button full-button" data-action="biometric">◎ ورود با اثر انگشت</button>' : ""}
    </section>
  </main>`;
}

function transactionRows(rows, deletable = false) {
  return rows
    .map((item) => {
      const positive = item.kind !== "expense";
      const title =
        item.kind === "salary" && item.title === "حقوق ماهانه"
          ? t(item.title)
          : item.title;
      return `<div class="transaction-row"><span class="transaction-icon ${positive ? "positive-icon" : "expense-icon"}">${positive ? "+" : "−"}</span><div class="transaction-main"><b>${escape(title)}</b><small>${escape(displayCategory(item.category || (item.kind === "salary" ? "حقوق" : "درآمد")))} · ${shortDate(item.date)}</small></div><strong class="transaction-amount ${positive ? "positive-text" : ""}">${positive ? "+" : "−"}${money(item.amount)}</strong>${deletable ? `<button class="row-delete" data-action="delete" data-id="${item.id}" title="حذف">×</button>` : ""}</div>`;
    })
    .join("");
}
function home() {
  const data = monthData(monthNow());
  const salary = data.salaryEstimate;
  const salaryDiff = data.salaryActual - data.salaryEstimate;
  const budgetRow =
    state.budgets.find((row) => row.month === monthNow()) ||
    state.budgets.find((row) => legacyPeriodToJalali(row.month) === monthNow());
  const budget = budgetRow
    ? Number(budgetRow.amount) || 0
    : +setting("monthlyBudget", 0);
  const latest = data.rows
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4);
  const percent = budget ? Math.min(100, (data.expense / budget) * 100) : 0;
  const categoryTotals = Object.entries(
    data.expenses.reduce((totals, item) => {
      const category = item.category || "سایر";
      totals[category] = (totals[category] || 0) + Number(item.amount || 0);
      return totals;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  const pieColors = ["#347fda", "#22a98b", "#f0a34a", "#9270d6", "#e16d78"];
  const pieItems = categoryTotals.slice(0, 4);
  if (categoryTotals.length > 4)
    pieItems.push([
      "سایر",
      categoryTotals.slice(4).reduce((sum, [, amount]) => sum + amount, 0),
    ]);
  let pieCursor = 0;
  const pieStops = pieItems
    .map(([, amount], index) => {
      const start = pieCursor;
      pieCursor += data.expense ? (amount / data.expense) * 100 : 0;
      return `${pieColors[index % pieColors.length]} ${start}% ${pieCursor}%`;
    })
    .join(", ");
  const pieLegend = pieItems
    .map(
      ([category, amount], index) =>
        `<div class="pie-legend-row"><span class="pie-legend-name"><i style="--pie-color:${pieColors[index % pieColors.length]}"></i>${escape(displayCategory(category))}</span><strong>${money(amount)}</strong><small>${number.format(data.expense ? Math.round((amount / data.expense) * 100) : 0)}${getLanguage() === "en" ? "%" : "٪"}</small></div>`,
    )
    .join("");
  return `${pageHeading("نمای کلی", "")}<section class="overview-section"><div class="overview-heading"><div><p class="eyebrow">گزارش کلی ماه</p><h2>ترکیب هزینه‌ها</h2></div><span class="overview-period">${monthName(monthNow())}</span></div>${data.expense ? `<div class="overview-chart-layout"><div class="expense-donut" style="--donut-stops:${pieStops}"><div class="donut-center"><small>هزینهٔ کل</small><strong>${money(data.expense)}</strong></div></div><div class="pie-legend">${pieLegend}</div></div>` : '<div class="pie-empty"><span>◔</span><p>با ثبت هزینه، گزارش این ماه اینجا نمایش داده می‌شود.</p></div>'}</section>${budget && percent >= 80 ? `<div class="notice"><b>${percent >= 100 ? "از سقف بودجه عبور کردی" : "به سقف بودجه نزدیک شدی"}</b><span>${money(data.expense)} از ${money(budget)}</span></div>` : ""}<section class="balance-panel"><div class="balance-top"><span>موجودی باقی‌مانده</span><span>${monthName(monthNow())}</span></div><strong class="balance-number ${data.remaining < 0 ? "negative-text" : data.remaining > 0 ? "positive-text" : ""}">${money(data.remaining)}</strong><div class="balance-equation"><span>${money(data.salary + data.income)} درآمد</span><b>−</b><span>${money(data.expense)} هزینه</span><b>−</b><span>${money(data.paid)} قسط پرداختی</span></div></section><section class="metric-grid"><article><small>حقوق پیش‌بینی‌شده</small><strong>${money(salary)}</strong>${data.salaryReceived ? "<small>جایگزین با حقوق واقعی</small>" : `<button class="text-action" data-action="salary-estimate">${salary ? "✎ ویرایش حقوق تخمینی" : "＋ ثبت حقوق تخمینی"}</button>`}</article><article class="metric-mint"><small>حقوق دریافت‌شده</small><strong>${money(data.salaryActual)}</strong>${data.salaryReceived && salary && salaryDiff ? `<small class="${salaryDiff > 0 ? "positive-text" : "negative-text"}">${salaryDiff > 0 ? "+" : "−"}${money(Math.abs(salaryDiff))} نسبت به تخمین</small>` : ""}<button class="text-action" data-action="salary">${data.salaryReceived ? "✎ ویرایش حقوق واقعی" : "✅ حقوق دریافت شد"}</button></article><article><small>سایر درآمدها</small><strong>${money(data.income)}</strong><button class="text-action" data-action="income">＋ ثبت درآمد</button></article><article><small>مجموع هزینه‌ها</small><strong class="negative-text">${money(data.expense)}</strong><small>${number.format(data.expenses.length)} مورد</small></article><article><small>اقساط ماه</small><strong>${money(data.due)}</strong><small>مجموع سررسید</small></article><article><small>بدهی اقساط</small><strong>${money(debtRemaining())}</strong><small>مانده کل</small></article></section><section class="home-lower"><article class="section-block"><div class="section-title"><div><p class="eyebrow">کنترل خرج‌کرد</p><h2>بودجهٔ ماه</h2></div><button class="subtle-button" data-page="settings">تنظیم</button></div>${budget ? `<div class="budget-line"><span>${money(data.expense)} <small>از ${money(budget)}</small></span><b>${number.format(Math.round(percent))}٪</b></div><div class="progress-track"><i style="width:${percent}%"></i></div><p class="muted-copy">ماندهٔ قابل‌خرج: ${money(Math.max(0, budget - data.expense))}</p>` : '<p class="muted-copy">بودجهٔ ماهانه را برای کنترل هزینه‌ها تنظیم کن.</p><button class="outline-button" data-page="settings">تنظیم بودجه ←</button>'}</article><article class="section-block"><div class="section-title"><div><p class="eyebrow">آخرین فعالیت‌ها</p><h2>تراکنش‌های ماه</h2></div><button class="subtle-button" data-page="expenses">همه</button></div>${latest.length ? transactionRows(latest) : '<p class="muted-copy">هنوز تراکنشی ثبت نشده است.</p>'}</article></section>`;
}
function expenses() {
  const rows = state.transactions
    .filter((item) => item.kind === "expense")
    .filter((item) => state.filter === "all" || item.category === state.filter)
    .filter((item) =>
      `${item.title} ${item.category} ${item.note}`
        .toLowerCase()
        .includes(state.search.toLowerCase()),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  return `${pageHeading("هزینه‌ها", "ثبت و بررسی خرج‌کرد")}<section class="list-toolbar"><label class="search-field">⌕ <input id="search" value="${escape(state.search)}" placeholder="جست‌وجوی هزینه..." /></label><select id="categoryFilter"><option value="all">همه دسته‌ها</option>${state.categories.map((item) => `<option value="${escape(item.name)}" ${item.name === state.filter ? "selected" : ""}>${escape(displayCategory(item.name))}</option>`).join("")}</select><button class="primary-button" data-action="expense">＋ ثبت هزینه</button></section><section class="list-summary"><span>جمع نتایج</span><strong>${money(rows.reduce((sum, row) => sum + +row.amount, 0))}</strong><small>${number.format(rows.length)} تراکنش</small></section><section class="section-block">${rows.length ? transactionRows(rows, true) : '<div class="empty-state"><b>هزینه‌ای پیدا نشد</b><small>فیلتر را تغییر بده یا هزینه‌ای ثبت کن.</small></div>'}</section>`;
}
function themePanel() {
  const selectedTheme = setting("theme", "light");
  return `<section class="settings-section theme-section"><p class="eyebrow">زبان برنامه</p><div class="segmented-control language-control" role="group" aria-label="انتخاب زبان"><button type="button" data-language-choice="fa" class="${getLanguage() === "fa" ? "selected" : ""}">فارسی</button><button type="button" data-language-choice="en" class="${getLanguage() === "en" ? "selected" : ""}">English</button></div><p class="eyebrow font-size-label">ظاهر برنامه</p><h2>پوسته</h2><div class="segmented-control theme-control" role="group" aria-label="انتخاب تم"><button type="button" data-theme-choice="light" class="${selectedTheme === "light" ? "selected" : ""}">روشن</button><button type="button" data-theme-choice="dark" class="${selectedTheme === "dark" ? "selected" : ""}">تاریک</button></div><p class="eyebrow font-size-label">اندازهٔ نوشته</p><div class="segmented-control font-control" role="group" aria-label="اندازهٔ فونت">${[
    ["small", "کوچک"],
    ["normal", "معمولی"],
    ["large", "بزرگ"],
    ["xlarge", "خیلی بزرگ"],
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-font-choice="${value}" class="${fontSizeKey() === value ? "selected" : ""}">${label}</button>`,
    )
    .join("")}</div></section>`;
}
function installmentReminderPanel() {
  if (!Capacitor.isNativePlatform()) return "";
  return `<section class="settings-section"><p class="eyebrow">اعلان‌های محلی</p><h2>یادآوری‌ها</h2><label class="toggle-row"><span>اعلان روز سررسید قسط<small>ساعت ۹ صبح، بدون نیاز به اینترنت</small></span><input type="checkbox" id="installmentReminderToggle" ${setting("installmentReminders", true) ? "checked" : ""} /></label><label class="toggle-row"><span>یادآوری ثبت هزینه<small>هر روز ساعت ۹ صبح و ۹ شب</small></span><input type="checkbox" id="expenseLogReminderToggle" ${setting("expenseLogReminders", true) ? "checked" : ""} /></label></section>`;
}
function savingsSummary() {
  const total = savingsBalance();
  const latest = state.savingsTransfers
    .slice()
    .sort((a, b) =>
      legacyPeriodToJalali(b.period).localeCompare(
        legacyPeriodToJalali(a.period),
      ),
    )[0];
  const currentRemaining = monthData(monthNow()).remaining;
  return `<section class="section-block savings-summary"><div><p class="eyebrow">پس‌انداز</p><h2>پس‌انداز</h2><small class="muted-copy">${latest ? `آخرین انتقال: ${monthName(legacyPeriodToJalali(latest.period))}` : "هنوز انتقالی به پس‌انداز ثبت نشده است."}</small>${currentRemaining > 0 ? `<button class="outline-button" data-action="savings-transfer" style="margin-top:8px;">انتقال مازاد (${money(currentRemaining)})</button>` : ""}</div><strong class="${total < 0 ? "negative-text" : "positive-text"} savings-total">${money(total)}</strong></section>`;
}
function installmentDueInfo(item, offset) {
  const at = dueDateForOffset(item, offset || 0);
  const label = formatJalaliDate(localDateKey(at));
  const [year, month, day] = dateNow().split("-").map(Number);
  const days = Math.round(
    (Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) -
      Date.UTC(year, month - 1, day)) /
      86_400_000,
  );
  let status = "";
  const dueLabel = getLanguage() === "en" ? "Due" : "سررسید";
  if (days > 7) return { dayLabel: `${dueLabel} ${label}`, status: "" };
  if (days > 0)
    status = `${number.format(days)} ${getLanguage() === "en" ? "days left" : "روز مانده"}`;
  else if (days === 0)
    status = getLanguage() === "en" ? "Due today" : "سررسید امروز";
  else status = getLanguage() === "en" ? "Past due" : "سررسید گذشته";
  return { dayLabel: `${dueLabel} ${label}`, status };
}
function installments() {
  const current = monthNow();
  const records = state.installments.filter(
    (item) =>
      installmentBalance(item) > 0 &&
      installmentPaidCount(item) < installmentMonths(item),
  );
  return `${pageHeading("اقساط", "تعهدهای مالی و سررسیدها")}<section class="installment-summary"><div><small>سررسید این ماه</small><strong>${money(monthData(current).due)}</strong></div><div><small>بدهی باقی‌مانده</small><strong>${money(debtRemaining())}</strong></div><button class="primary-button" data-action="installment">＋ قسط جدید</button></section><section class="installment-list">${
    records.length
      ? records
          .map((item) => {
            const offset = installmentPaidCount(item);
            const due = dueMonthForOffset(item, offset);
            const dueDate = jalaliToIso(due.jy, due.jm, due.day);
            const isDue = dueDate <= dateNow();
            const paidThisMonth = state.payments.some(
              (row) =>
                row.installment_id === item.id &&
                (row.paid_at
                  ? isoToJalaliKey(row.paid_at) === current
                  : legacyPeriodToJalali(row.period) === current),
            );
            const debt = installmentBalance(item);
            const dueInfo = installmentDueInfo(item, offset);
            const amountDue = installmentDueAmount(item, offset);
            return `<article class="installment-row"><div class="installment-head"><div><span class="installment-glyph">▤</span><div><h2>${escape(item.name)}</h2><small>${dueInfo.dayLabel}</small></div></div><span class="status-pill ${paidThisMonth ? "is-paid" : ""}">${paidThisMonth ? "پرداخت‌شده این ماه" : isDue ? `سررسید${dueInfo.status ? `<br>${dueInfo.status}` : ""}` : `${number.format(Math.max(0, installmentMonths(item) - offset))} قسط مانده`}</span></div><div class="installment-numbers"><div><small>مبلغ این قسط</small><b>${money(amountDue)}</b></div><div><small>بدهی مانده</small><b>${money(debt)}</b></div><div><small>پرداخت</small><b>${number.format(offset)} از ${number.format(installmentMonths(item))}</b></div></div><div class="installment-footer"><span>سررسید بعدی ${formatJalaliDate(dueDate)}</span>${isDue ? `<button class="pay-button" data-action="pay" data-id="${escape(item.id)}" data-period="${due.key}">☑️ پرداخت شد</button>` : ""}</div></article>`;
          })
          .join("")
      : '<div class="empty-state"><b>قسطی ثبت نشده</b><small>قسط‌ها را اضافه کن تا سررسید ماهانه اینجا نمایش داده شود.</small><button class="outline-button" data-action="installment">افزودن قسط</button></div>'
  }</section>`;
}
function checkForm(item = null) {
  const title = item ? "ویرایش چک" : "ثبت چک جدید";
  const body = `<form data-form="check" data-id="${item ? escape(item.id) : ""}">${input("عنوان یا شماره چک", "title", "text", 'maxlength="60"', item?.title || "")}${amountInput("مبلغ چک (تومان)", "amount", item?.amount || "")}${jalaliDateInput("تاریخ سررسید چک", "due_date", item?.due_date || dateNow())}<p class="muted-copy">مبلغ چک فقط جهت اطلاع ثبت می‌شود و در موجودی، درآمد و هزینه محاسبه نخواهد شد.</p><button class="primary-button">${item ? "ذخیره تغییرات" : "ثبت چک"}</button></form>`;
  modal(title, body);
}
function checks() {
  const rows = state.checks
    .slice()
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const list = rows
    .map((item) => {
      const days = Math.ceil(
        (new Date(`${item.due_date}T00:00:00`).getTime() -
          new Date(`${dateNow()}T00:00:00`).getTime()) /
          86_400_000,
      );
      const status =
        days < 0
          ? "سررسید گذشته"
          : days === 0
            ? "سررسید امروز"
            : `${number.format(days)} روز مانده`;
      return `<article class="check-row"><div class="check-row-main"><span class="check-icon">▣</span><div><b>${escape(item.title)}</b><small>${escape(formatJalaliDate(item.due_date))} · ${status}</small></div></div><strong>${money(item.amount)}</strong><div class="check-actions"><button class="text-action" data-action="edit-check" data-id="${escape(item.id)}">ویرایش</button><button class="row-delete" data-action="delete-check" data-id="${escape(item.id)}" aria-label="حذف چک">×</button></div></article>`;
    })
    .join("");
  return `${pageHeading("چک‌ها", "ثبت اطلاعات و یادآوری سررسید")}<section class="check-notice"><b>صرفاً جهت اطلاع</b><span>مبلغ چک‌ها در موجودی، درآمد، هزینه و گزارش‌های مالی محاسبه نمی‌شود.</span></section><section class="list-toolbar check-toolbar"><span>${number.format(rows.length)} چک ثبت‌شده</span><button class="primary-button" data-action="add-check">＋ ثبت چک</button></section><section class="check-list">${rows.length ? list : '<div class="empty-state"><b>چکی ثبت نشده</b><small>چک‌ها را ثبت کن تا پیش از سررسید یادآوری دریافت کنی.</small></div>'}</section>`;
}
function reports() {
  const reportMonth =
    state.reportType === "year"
      ? `${state.report.slice(0, 4)}-01`
      : state.report;
  const data =
    state.reportType === "year"
      ? yearData(reportMonth.slice(0, 4))
      : monthData(reportMonth);
  const prev = monthData(addMonth(reportMonth, -1));
  const byCategory = {};
  data.expenses.forEach((row) => {
    byCategory[row.category || "سایر"] =
      (byCategory[row.category || "سایر"] || 0) + +row.amount;
  });
  const highest = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
  const years =
    state.reportType === "year"
      ? Array.from(
          { length: 12 },
          (_, i) =>
            `${state.report.slice(0, 4)}-${String(i + 1).padStart(2, "0")}`,
        )
      : [addMonth(reportMonth, -2), addMonth(reportMonth, -1), reportMonth];
  const flow = years.map(monthData);
  const monthLabels = years.map(
    (month) =>
      (getLanguage() === "en" ? jalaliMonthsEn : jalaliMonths)[
        Number(month.slice(5, 7)) - 1
      ],
  );
  // Use the same numbers shown in the metric cards (exact reporting period),
  // not the flow buckets, so the donut always matches the report itself.
  const chartSeries = [
    ["income", "درآمد", "#3fbf7f", (+data.salary || 0) + (+data.income || 0)],
    ["expense", "هزینه", "#e5484d", +data.expense || 0],
    ["loan", "قسط", "#3d7fd8", +data.paid || 0],
  ];
  const total = chartSeries.reduce(
    (sum, [, , value]) => sum + (+value || 0),
    0,
  );
  const reportKey =
    state.reportType === "year" ? reportMonth.slice(0, 4) : reportMonth;
  console.info("[report-chart]", {
    type: state.reportType,
    reportKey,
    stateReport: state.report,
    transactions: state.transactions.length,
    payments: state.payments.length,
    rowsInPeriod: data.rows.length,
    salary: data.salary,
    income: data.income,
    expense: data.expense,
    paid: data.paid,
    total,
  });
  const R = 60;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segments = chartSeries
    .filter(([, , value]) => +value > 0)
    .map(([key, label, color, value]) => {
      const len = (value / Math.max(1, total)) * C;
      const seg = `<circle class="donut-seg donut-${key}" cx="80" cy="80" r="${R}" fill="none" stroke="${color}" stroke-width="26" stroke-dasharray="${Math.max(0, len - 2)} ${C - Math.max(0, len - 2)}" stroke-dashoffset="${-offset}" transform="rotate(-90 80 80)"><title>${label}: ${money(value)} (${number.format(Math.round((value / Math.max(1, total)) * 100))}٪)</title></circle>`;
      offset += len;
      return seg;
    })
    .join("");
  const donut =
    total > 0
      ? `<div class="donut-wrap" style="display:flex" data-donut data-total="${total}"><svg class="donut" viewBox="0 0 160 160" role="img" aria-label="${t("ترکیب درآمد، هزینه و قسط")}"><circle class="donut-track" cx="80" cy="80" r="${R}" fill="none" stroke-width="26"></circle>${segments}<text class="donut-center-label" x="80" y="71" text-anchor="middle">${t("جمع کل")}</text><text class="donut-center-value" x="80" y="90" text-anchor="middle">${money(total)}</text></svg><div class="donut-legend">${chartSeries.map(([key, label, color, value]) => `<div class="donut-legend-row"><i class="legend-dot legend-${key}" style="--dot:${color}"></i><span>${label}</span><b class="num">${money(value)}</b><small>${number.format(Math.round((value / Math.max(1, total)) * 100))}٪</small></div>`).join("")}</div></div>`
      : `<p class="muted-copy donut-empty">${t("داده‌ای برای نمایش سری وجود ندارد.")}<br><small>${t("بازه:")} ${reportKey} · ${t("تعداد تراکنش در این بازه:")} ${number.format(data.rows.length)}</small></p>`;
  const chart = `<div class="chart-block">${donut}</div>`;
  const flowTable = `<table class="flow-table"><thead><tr><th>${t("ماه")}</th><th>${t("درآمد")}</th><th>${t("هزینه")}</th><th>${t("قسط")}</th></tr></thead><tbody>${flow.map((row, index) => `<tr><td>${monthLabels[index]}</td><td>${money(row.salary + row.income)}</td><td>${money(row.expense)}</td><td>${money(row.paid)}</td></tr>`).join("")}</tbody></table>`;

  return `${pageHeading("گزارش‌ها", "تصویر روشن‌تر از جریان پول")}<section class="report-toolbar"><div class="segmented-control"><button data-mode="month" class="${state.reportType === "month" ? "selected" : ""}">ماهانه</button><button data-mode="year" class="${state.reportType === "year" ? "selected" : ""}">سالانه</button></div><button class="icon-button" data-action="report-prev">‹</button><strong>${state.reportType === "month" ? monthName(reportMonth) : number.format(+state.report.slice(0, 4))}</strong><button class="icon-button" data-action="report-next">›</button><button class="outline-button" data-action="pdf">PDF</button></section><section class="report-metrics">${[
    ["درآمد کل", data.salary + data.income],
    ["حقوق دریافتی", data.salary],
    ["سایر درآمدها", data.income],
    ["هزینه کل", data.expense],
    ["اقساط پرداخت‌شده", data.paid],
    ["مبلغ باقی‌مانده", data.remaining],
    ["بدهی اقساط باقی‌مانده", debtRemaining()],
    [
      "میانگین هزینه",
      data.expenses.length ? data.expense / data.expenses.length : 0,
    ],
    ["بیشترین دسته", highest?.[0] || "—"],
  ]
    .map(([label, value]) => {
      const cls =
        label === "مبلغ باقی‌مانده" && typeof value === "number"
          ? value < 0
            ? "negative-text"
            : value > 0
              ? "positive-text"
              : ""
          : "";
      return `<article><small>${label}</small><strong class="${cls}">${typeof value === "number" ? money(value) : escape(value)}</strong></article>`;
    })
    .join(
      "",
    )}</section><section class="report-details"><article class="detail-card"><h2>جریان پول ماهانه</h2>${flowTable}</article><article class="detail-card"><h2>دسته‌بندی هزینه‌ها</h2>${
    Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([name, value]) =>
          `<div class="detail-row"><span>${escape(displayCategory(name))}</span><b>${money(value)}</b><small>${number.format(data.expense ? Math.round((value / data.expense) * 100) : 0)}٪</small></div>`,
      )
      .join("") || '<p class="muted-copy">داده‌ای برای نمایش نیست.</p>'
  }</article></section>${state.reportType === "month" ? `<section class="comparison-panel"><div><p class="eyebrow">مقایسه با ماه قبل</p><h2>هزینه‌ها ${data.expense > prev.expense ? `${number.format(Math.round(((data.expense - prev.expense) / Math.max(1, prev.expense)) * 100))}٪ بیشتر` : "کمتر یا برابر"}</h2></div><div>${monthName(addMonth(reportMonth, -1))} <b>${money(prev.expense)}</b><br>${monthName(reportMonth)} <b>${money(data.expense)}</b></div></section>` : ""}`;
}
function backupSection() {
  const last = state.lastBackup;
  const native = Capacitor.isNativePlatform();
  const folder =
    setting("backupDir", "documents") === "downloads"
      ? "پوشهٔ Downloads"
      : "پوشهٔ Documents";
  let pickedBackup = null;
  try {
    pickedBackup = JSON.parse(
      localStorage.getItem("hamrah-picked-backup") || "null",
    );
  } catch {
    pickedBackup = null;
  }
  return `<section class="settings-section backup-section"><p class="eyebrow">انتقال اطلاعات</p><h2>پشتیبان‌گیری</h2><p class="muted-copy">${native ? `فایل پشتیبان در ${folder} گوشی ذخیره می‌شود و می‌توانی آن را در گالری، فایل‌ها یا فضای ابری خودت نگه داری.` : "فایل پشتیبان در پوشهٔ دانلود دستگاه ذخیره می‌شود."}</p>${last ? `<p class="muted-copy backup-last">آخرین پشتیبان: ${escape(last.name)}</p>` : ""}<div class="backup-actions"><button class="outline-button full-button" data-action="backup">📥 ذخیرهٔ فایل پشتیبان</button><button class="outline-button full-button" data-action="restore">📂 بازگردانی از فایل پشتیبان</button></div>${pickedBackup ? `<div class="backup-actions"><button class="outline-button full-button" data-action="restore-picked">⏱ بازگردانی همان فایل: ${escape(pickedBackup.name)}</button></div>` : ""}${native ? `<label>محل ذخیرهٔ فایل<select id="backupDir"><option value="documents" ${setting("backupDir", "documents") === "documents" ? "selected" : ""}>پوشهٔ Documents</option><option value="downloads" ${setting("backupDir", "documents") === "downloads" ? "selected" : ""}>پوشهٔ Downloads</option></select></label>` : ""}<label class="toggle-row"><span>نگه‌داشتن پشتیبان داخل برنامه<small>آخرین نسخه در خود برنامه ذخیره می‌شود و سریع برگردانده می‌شود</small></span><input type="checkbox" id="backupAutoSave" ${setting("backupAutoSave", true) ? "checked" : ""} /></label><div class="backup-actions">${last ? `<button class="outline-button full-button" data-action="quick-backup">🔄 پشتیبان سریع</button>` : ""}${last?.uri ? `<button class="outline-button full-button" data-action="quick-restore">↩️ بازگردانی از آخرین پشتیبان داخلی</button>` : ""}</div><p class="muted-copy backup-auto">پشتیبان خودکار بعد از هر ثبت اطلاعات فعال است.</p></section>`;
}
function settings() {
  const pane = state.settingsPane || "home";
  const heading = (title) => pageHeading("تنظیمات", title);
  if (pane === "home") {
    return `${pageHeading("تنظیمات", "کنترل برنامه و حریم خصوصی")}<section class="settings-menu">
      <button class="settings-menu-item" data-action="settings-open" data-pane="budget"><span>💰</span><div><b>درآمد و بودجه</b><small>حقوق، سقف هزینه، هدف پس‌انداز</small></div><span>›</span></button>
      <button class="settings-menu-item" data-action="settings-open" data-pane="security"><span>🔒</span><div><b>امنیت دستگاه</b><small>قفل، بیومتریک، PIN</small></div><span>›</span></button>
      <button class="settings-menu-item" data-action="settings-open" data-pane="backup"><span>💾</span><div><b>پشتیبان‌گیری</b><small>ذخیره و بازگردانی اطلاعات</small></div><span>›</span></button>
      <button class="settings-menu-item" data-action="settings-open" data-pane="categories"><span>🏷</span><div><b>دسته‌بندی‌ها</b><small>مدیریت دسته‌های هزینه</small></div><span>›</span></button>
      <button class="settings-menu-item" data-action="settings-open" data-pane="appearance"><span>🎨</span><div><b>ظاهر و اندازهٔ نوشته</b><small>تم، زبان، اندازهٔ فونت</small></div><span>›</span></button>
      <button class="settings-menu-item" data-action="settings-open" data-pane="guide"><span>📖</span><div><b>راهنمای برنامه</b><small>آموزش گام‌به‌گام استفاده</small></div><span>›</span></button>
      <button class="settings-menu-item" data-action="settings-open" data-pane="contact"><span>👤</span><div><b>ارتباط با ما</b><small>امید مرددل · 09197392944</small></div><span>›</span></button>
      <button class="settings-menu-item" data-action="settings-open" data-pane="reset"><span>♻️</span><div><b>بازنشانی</b><small>پاک‌کردن اطلاعات برنامه</small></div><span>›</span></button>
    </section>`;
  }
  if (pane === "budget") {
    return `${heading("درآمد و بودجه")}<form data-form="settings" class="settings-section"><p class="eyebrow">برنامه‌ریزی ماهانه</p><h2>درآمد و بودجه</h2><label>حقوق تقریبی ماهانه<input name="salary" type="text" inputmode="numeric" data-amount value="${formatAmount(setting("monthlySalary", 0) || "")}" placeholder="تومان" /></label><label>سقف بودجهٔ هزینه<input name="budget" type="text" inputmode="numeric" data-amount value="${formatAmount(setting("monthlyBudget", 0) || "")}" placeholder="تومان" /></label><label>هدف پس‌انداز<input name="savings" type="text" inputmode="numeric" data-amount value="${formatAmount(setting("savingsGoal", 0) || "")}" placeholder="تومان" /></label><button class="primary-button">ذخیرهٔ تنظیمات</button></form>`;
  }
  if (pane === "security") {
    return `${heading("امنیت دستگاه")}<section class="settings-section"><p class="eyebrow">قفل برنامه</p><h2>امنیت دستگاه</h2><label>قفل خودکار بعد از<select id="autoLock"><option value="1" ${setting("autoLockMinutes", 5) === 1 ? "selected" : ""}>۱ دقیقه</option><option value="5" ${setting("autoLockMinutes", 5) === 5 ? "selected" : ""}>۵ دقیقه</option><option value="15" ${setting("autoLockMinutes", 5) === 15 ? "selected" : ""}>۱۵ دقیقه</option><option value="30" ${setting("autoLockMinutes", 5) === 30 ? "selected" : ""}>۳۰ دقیقه</option></select></label><label class="toggle-row"><span>ورود بیومتریک<small>تأیید فقط توسط Android انجام می‌شود</small></span><input type="checkbox" id="bioToggle" ${setting("biometricEnabled", true) ? "checked" : ""} ${state.availableBio ? "" : "disabled"} /></label><button class="outline-button full-button" data-action="change-pin">تغییر PIN</button></section>`;
  }
  if (pane === "backup") {
    return `${heading("پشتیبان‌گیری")}${backupSection()}`;
  }
  if (pane === "categories") {
    return `${heading("دسته‌بندی‌ها")}<section class="settings-section"><p class="eyebrow">دسته‌بندی‌ها</p><h2>دسته‌های هزینه</h2><div class="category-chips">${state.categories.map((item) => `<span>${escape(displayCategory(item.name))}<button data-action="delete-category" data-id="${item.id}">×</button></span>`).join("")}</div><button class="text-action" data-action="category">＋ افزودن دسته</button></section>`;
  }
  if (pane === "appearance") {
    return `${heading("ظاهر برنامه")}${themePanel()}`;
  }
  if (pane === "guide") {
    return `${heading("راهنمای برنامه")}<section class="settings-section guide-section">
      <p class="eyebrow">${t("راهنمای گام‌به‌گام")}</p>
      <h2>${t("با برنامه آشنا شو")}</h2>
      <p class="muted-copy">${t("این برنامه یک دفتر مالی شخصی و کاملاً آفلاین است؛ همهٔ اطلاعات فقط روی همین دستگاه ذخیره می‌شود و هیچ داده‌ای به اینترنت یا فضای ابری ارسال نمی‌شود.")}</p>
      <ol class="guide-steps">
        <li><b>${t("۱. ثبت حقوق و بودجه")}</b><span>${t("در صفحهٔ اصلی می‌توانی")} <b>${t("حقوق تخمینی")}</b> ${t("ماه را ثبت کنی (ویرایش یا ثبت از تنظیمات ← درآمد و بودجه). این مبلغ تا زمان ثبت حقوق واقعی در موجودی لحاظ می‌شود؛ بعد از ثبت حقوق واقعی، اختلاف آن خودکار در موجودی اعمال می‌شود و برای هر ماه فقط یک رکورد حقوق ثبت می‌شود. سقف بودجهٔ هزینه و هدف پس‌انداز را هم همان‌جا تعیین کن؛ اگر هزینه‌ها به سقف بودجه برسد، هشدار می‌گیری.")}</span></li>
        <li><b>${t("۲. ثبت درآمد و هزینه")}</b><span>${t("از صفحهٔ")} <b>${t("هزینه‌ها")}</b> ${t("هزینه یا درآمد دیگر ثبت کن (عنوان، مبلغ، دسته، تاریخ شمسی و توضیحات). تاریخ نمی‌تواند آینده باشد و جست‌وجو و فیلتر دسته دارد. اگر موجودی ماه کافی نباشد، برنامه پیشنهاد می‌دهد کسری از")} <b>${t("پس‌انداز")}</b> ${t("برداشت شود؛ اگر نپذیری یا پس‌اندازی نباشد، تراکنش ثبت نمی‌شود. هر تراکنش را می‌توانی حذف کنی.")}</span></li>
        <li><b>${t("۳. مدیریت اقساط")}</b><span>${t("در صفحهٔ")} <b>${t("اقساط")}</b> ${t("قسط را با نام، مبلغ ماهانه، مبلغ کل بدهی، تعداد کل ماه‌ها، تعداد اقساط پرداخت‌شده و سررسید بعدی ثبت کن (مثلاً اگر ۸ از ۱۲ قسط را داده‌ای، ۸ را وارد کن؛ برنامه از قسط نهم ادامه می‌دهد). فقط در ماه سررسید، دکمهٔ")} <b>${t("پرداخت شد")}</b> ${t("ظاهر می‌شود؛ با زدن آن، مبلغ از موجودی کسر و یک قسط تسویه می‌شود و اگر موجودی کافی نباشد، برداشت از پس‌انداز پیشنهاد می‌شود. اقساط عقب‌افتاده در محاسبهٔ بدهی باقی می‌مانند. بدهی باقی‌ماندهٔ کل بالای صفحه نمایش داده می‌شود.")}</span></li>
        <li><b>${t("۴. ثبت چک‌ها")}</b><span>${t("در صفحهٔ")} <b>${t("چک‌ها")}</b> ${t("چک‌ها را با عنوان، مبلغ و تاریخ سررسید ثبت کن. مبلغ چک صرفاً جهت اطلاع است و در موجودی و گزارش‌های مالی محاسبه نمی‌شود؛ اما ۷ و ۲ روز قبل از سررسید اعلان یادآوری می‌گیری و وضعیت هر چک (روز مانده، سررسید امروز یا گذشته) نشان داده می‌شود.")}</span></li>
        <li><b>${t("۵. مشاهدهٔ گزارش‌ها")}</b><span>${t("در صفحهٔ")} <b>${t("گزارش")}</b> ${t("حالت ماهانه یا سالانه را انتخاب و با فلش‌ها بین ماه‌ها/سال‌ها حرکت کن. درآمد کل، حقوق دریافتی، سایر درآمدها، هزینه، اقساط پرداختی، مبلغ باقی‌مانده، بدهی باقی‌مانده و میانگین و بیشترین دسته را با نمودار دایره‌ای، جدول جریان پول ۳ ماه/۱۲ ماه، تفکیک دسته‌بندی و مقایسه با ماه قبل ببین. با دکمهٔ PDF هم می‌توانی از گزارش خروجی بگیری (چ/ذخیره).")}</span></li>
        <li><b>${t("۶. پس‌انداز")}</b><span>${t("مازاد هر ماه به‌صورت خودکار به پس‌انداز منتقل نمی‌شود. در کارت")} <b>${t("پس‌انداز")}</b> ${t("صفحهٔ اصلی، اگر ماه جاری مازاد داشته باشی، دکمهٔ")} <b>${t("انتقال مازاد")}</b> ${t("ظاهر می‌شود و با زدن آن مبلغ باقی‌مانده به پس‌انداز منتقل و از موجودی ماه کسر می‌شود (هر ماه فقط یک بار). برعکس، اگر هنگام هزینه یا قسط موجودی کافی نباشد، برنامه با تأیید تو از پس‌انداز برداشت می‌کند. مجموع پس‌انداز همیشه در همان کارت نمایش داده می‌شود.")}</span></li>
        <li><b>${t("۷. یادآوری‌ها")}</b><span>${t("از بخش یادآوری‌ها در تنظیمات:")} <b>${t("اعلان روز سررسید قسط")}</b> ${t("(ساعت ۹ صبح روز سررسید) و")} <b>${t("یادآوری ثبت هزینه")}</b> ${t("(هر روز ساعت ۹ صبح و ۹ شب) را روشن یا خاموش کن. برای یادآوری چک‌ها هم فقط کافی است چک را ثبت کنی. همهٔ اعلان‌ها محلی هستند و به اینترنت نیاز ندارند؛ فقط باید مجوز اعلان را داده باشی.")}</span></li>
        <li><b>${t("۸. امنیت")}</b><span>${t("در اولین اجرا PIN چهار یا شش رقمی می‌سازی. از")} <b>${t("تنظیمات ← امنیت دستگاه")}</b> ${t("قفل خودکار (۱ تا ۳۰ دقیقه)، ورود بیومتریک (اثر انگشت) و تغییر PIN را مدیریت کن. PIN با هش SHA-256 ذخیره می‌شود و با بازنشانی اطلاعات حفظ می‌شود.")}</span></li>
        <li><b>${t("۹. پشتیبان‌گیری")}</b><span>${t("از")} <b>${t("تنظیمات ← پشتیبان‌گیری")}</b> ${t("فایل پشتیبان کامل بگیر (در پوشهٔ Documents یا Downloads گوشی ذخیره می‌شود) و بعداً بازگردانی کن. پشتیبان سریع داخلی، پشتیبان خودکار بعد از هر ثبت اطلاعات (فقط داخل برنامه) و انتخاب محل ذخیره هم در دسترس است. قبل از تعویض گوشی یا پاک‌کردن اطلاعات حتماً پشتیبان بگیر.")}</span></li>
        <li><b>${t("۱۰. شخصی‌سازی")}</b><span>${t("از")} <b>${t("تنظیمات ← ظاهر و اندازهٔ نوشته")}</b> ${t("پوستهٔ روشن/تاریک، زبان (فارسی/English) و اندازهٔ فونت (کوچک تا خیلی بزرگ) را تنظیم کن. دسته‌بندی هزینه‌ها را هم از بخش")} <b>${t("دسته‌بندی‌ها")}</b> ${t("اضافه یا حذف کن (دسته‌ای که تراکنش دارد حذف نمی‌شود).")}</span></li>
      </ol>
      <div class="guide-tips">
        <b>${t("💡 نکته‌های مهم")}</b>
        <ul>
          <li>${t("تاریخ‌ها به شمسی وارد می‌شوند؛ مثل ۱۴۰۵/۱۰/۲.")}</li>
          <li>${t("مبالغ همیشه به تومان است.")}</li>
          <li>${t("مبلغ چک‌ها در محاسبات مالی محاسبه نمی‌شود و صرفاً برای یادآوری است.")}</li>
          <li>${t("موجودی صفحهٔ اصلی یعنی: درآمد + حقوق + برداشت از پس‌انداز منهای هزینه، اقساط پرداختی و مبلغ منتقل‌شده به پس‌انداز.")}</li>
          <li>${t("با تغییر ماه شمسی، خودکار ماه جدید آغاز می‌شود و صفحهٔ ثبت حقوق تخمینی پیشنهاد می‌شود.")}</li>
          <li>${t("برای یادآوری اقساط، چک‌ها و ثبت هزینه، مجوز اعلان را به برنامه بده.")}</li>
        </ul>
      </div>
    </section>`;
  }
  if (pane === "contact") {
    return `${heading("ارتباط با ما")}<section class="settings-section contact-card luxury-contact">
      <div class="contact-hero luxury-hero">
        <div class="contact-avatar-wrap">
          <img class="contact-avatar" src="/omid-marddel.jpg" alt="امید مرددل" />
        </div>
        <div class="contact-hero-text">
          <p class="eyebrow">سلام! 👋</p>
          <h2>امید مرددل</h2>
          <p class="contact-role">سازندهٔ برنامه</p>
        </div>
      </div>
      <p class="contact-intro">برای پیشنهاد، انتقاد یا گزارش مشکل، از راه‌های زیر با من در تماس باش.</p>
      <div class="contact-links luxury-links">
        <a class="contact-link luxury-link contact-phone" href="sms:+989197392944">
          <span class="contact-link-icon luxury-icon">📞</span>
          <span class="luxury-link-text">
            <b>پیامک</b>
            <span class="contact-phone-number" dir="ltr">09197392944</span>
          </span>
          <span class="luxury-arrow">›</span>
        </a>
        <button class="contact-link luxury-link" data-action="open-link" data-url="https://t.me/+989197392944">
          <span class="contact-link-icon luxury-icon">✈️</span>
          <span class="luxury-link-text">
            <b>تلگرام</b>
            <small>پیام و پیشنهاد</small>
          </span>
          <span class="luxury-arrow">›</span>
        </button>
        <button class="contact-link luxury-link" data-action="open-link" data-url="https://wa.me/989197392944">
          <span class="contact-link-icon luxury-icon">💬</span>
          <span class="luxury-link-text">
            <b>واتساپ</b>
            <small>ارتباط مستقیم</small>
          </span>
          <span class="luxury-arrow">›</span>
        </button>
      </div>
    </section>`;
  }
  if (pane === "reset") {
    return `${heading("بازنشانی")}<section class="settings-section reset-section"><p class="eyebrow">بازنشانی</p><h2>پاک‌کردن اطلاعات برنامه</h2><p class="muted-copy">تراکنش‌ها، اقساط و تنظیمات پاک می‌شوند؛ PIN ورود حفظ می‌شود.</p><button type="button" class="danger-button" data-action="reset-app">بازنشانی همهٔ اطلاعات</button></section>`;
  }
  state.settingsPane = "home";
  return settings();
}
async function resetAppData() {
  const savedPin = ["pinHash", "pinSalt"]
    .map((key) => ({ key, value: state.settings[key] }))
    .filter((row) => row.value !== undefined);
  if (Capacitor.isNativePlatform()) {
    try {
      await cancelInstallmentNotifications();
    } catch (error) {
      console.warn(
        "Could not cancel installment reminders during reset.",
        error,
      );
    }
    try {
      await cancelExpenseLogReminders();
    } catch (error) {
      console.warn("Could not cancel expense reminders during reset.", error);
    }
    try {
      await cancelCheckNotifications();
    } catch (error) {
      console.warn("Could not cancel check reminders during reset.", error);
    }
  }
  for (const table of [
    "transactions",
    "installments",
    "payments",
    "checks",
    "categories",
    "budgets",
    "savings_transfers",
    "savings_movements",
  ])
    await clearStore(table);
  await clearStore("settings");
  for (const row of savedPin) await save("settings", row);
  for (const name of defaultCategories)
    await save("categories", { id: id(), name });
  Object.assign(state, {
    report: monthNow(),
    reportType: "month",
    search: "",
    filter: "all",
  });
  await refresh();
  setLanguage("fa");
  document.documentElement.dataset.theme = "light";
  applyFontSize();
  await applyStatusBarTheme("light");
  render();
  toast("اطلاعات برنامه پاک شد؛ PIN حفظ شد.");
}
function render() {
  if (!state.unlocked) {
    authScreen();
    localizeDOM(root);
    return;
  }
  let body = { home, expenses, installments, checks, reports, settings }[
    state.page
  ]();
  if (state.page === "home") {
    body = body
      .replace("ثبت دریافت دیگر", "ویرایش حقوق واقعی")
      .replace("✅ حقوق دریافت شد", "ثبت حقوق واقعی");
    body = body.replace(
      '<section class="home-lower">',
      `${savingsSummary()}<section class="home-lower">`,
    );
  }
  root.innerHTML = `<div class="app-shell"><header class="topbar"><a class="brand-link" data-page="home"><b>مدیریت مالی حقوق</b></a></header><main class="content-area">${body}</main><nav class="bottom-nav">${tabs.map(([key, label, glyph]) => `<button class="nav-item ${state.page === key ? "active" : ""}" data-page="${key}"><span>${glyph}</span>${label}</button>`).join("")}</nav><div id="modalRoot"></div><div id="toast" role="status"></div></div>`;
  const settingsSide = document.querySelector(".settings-side");
  if (settingsSide) {
    settingsSide.insertAdjacentHTML("afterbegin", themePanel());
    settingsSide.insertAdjacentHTML("afterbegin", installmentReminderPanel());
  }
  localizeDOM(root);
  const autoLock = document.querySelector("#autoLock");
  if (autoLock) autoLock.value = String(setting("autoLockMinutes", 5));
}
function toast(text, error = false) {
  const node = document.querySelector("#toast");
  if (!node) return;
  node.textContent = t(text);
  node.className = `toast toast-visible ${error ? "toast-error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.className = ""), 2500);
}
function modal(title, content) {
  const node = document.querySelector("#modalRoot");
  node.innerHTML = `<div class="modal-backdrop"><section class="modal"><div class="modal-head"><h2>${title}</h2><button class="icon-button" data-action="close">×</button></div>${content}</section></div>`;
  localizeDOM(node);
  node.querySelector(".modal").addEventListener("click", (event) => {
    if (event.target.matches('.modal-head [data-action="close"]')) {
      node.innerHTML = "";
      return;
    }
  });
  node.querySelector("input,select,textarea")?.focus();
}
function input(label, name, type = "text", attrs = "", value = "") {
  return `<label>${label}<input name="${name}" type="${type}" ${attrs} ${value ? `value="${escape(value)}"` : ""} required /></label>`;
}
function amountInput(label, name, value = "") {
  return input(
    label,
    name,
    "text",
    'inputmode="numeric" data-amount dir="ltr" autocomplete="off"',
    formatAmount(value),
  );
}
function transactionForm(kind) {
  const expense = kind === "expense";
  const salaryRows =
    kind === "salary"
      ? state.transactions
          .filter(
            (row) =>
              row.kind === "salary" && isoToJalaliKey(row.date) === monthNow(),
          )
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];
  const salaryTotal = salaryRows.reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );
  const title = expense
    ? "ثبت هزینه"
    : kind === "salary"
      ? salaryRows.length
        ? "ویرایش حقوق واقعی"
        : "ثبت حقوق واقعی"
      : "ثبت درآمد دیگر";
  const titleField =
    kind === "salary" ? "" : input("عنوان", "title", "text", 'maxlength="60"');
  const salaryDate = salaryRows[salaryRows.length - 1]?.date || dateNow();
  const amountValue =
    kind === "salary"
      ? String(
          salaryTotal > 0 ? salaryTotal : salaryEstimateFor(monthNow()) || "",
        )
      : "";
  modal(
    title,
    `<form data-form="transaction" data-kind="${kind}">${titleField}${amountInput(kind === "salary" ? "مبلغ حقوق واقعی (تومان)" : "مبلغ (تومان)", "amount", amountValue)}${expense ? `<label>دسته‌بندی<select name="category">${state.categories.map((item) => `<option value="${escape(item.name)}">${escape(displayCategory(item.name))}</option>`).join("")}</select></label>` : ""}${jalaliDateInput("تاریخ شمسی", "date", salaryDate)}<label>توضیحات<textarea name="note" rows="2"></textarea></label><button class="primary-button">ذخیره</button></form>`,
  );
}
function installmentForm() {
  modal(
    "افزودن قسط",
    `<form data-form="installment">${input("نام قسط", "name")}${amountInput("مبلغ هر ماه (تومان)", "monthly")}${amountInput("مبلغ کل بدهی (تومان)", "total")}${input("تعداد کل ماه‌ها", "months", "number", 'min="1"')}${input("تعداد پرداخت‌شده", "paid", "number", 'min="0"', "0")}${jalaliDateInput("سررسید قسط بعدی", "due", dateNow())}<p class="muted-copy">تعداد پرداخت‌شده را تعداد اقساطی که تا الان دادید وارد کنید؛ سررسید بعدی از ماه بعد آن تعداد حساب می‌شود.</p><button class="primary-button">ثبت قسط</button></form>`,
  );
}
function monthEntryForm() {
  modal(
    `حقوق تخمینی ${monthName(monthNow())}`,
    `<p class="muted-copy">این مبلغ تا زمان ثبت حقوق واقعی در موجودی حساب می‌شود. بعد از ثبت حقوق واقعی، اختلاف آن به‌صورت خودکار در موجودی اعمال می‌شود.</p><form data-form="month-entry">${amountInput("حقوق تخمینی این ماه (تومان)", "salaryEstimate", String(salaryEstimateFor(monthNow()) || +setting("monthlySalary", 0) || ""))}<button class="primary-button">ذخیرهٔ حقوق تخمینی</button></form>`,
  );
}
function download(name, data, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([data], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
function backupFileName() {
  return `hamrah-backup-${formatJalaliDate(dateNow()).replaceAll("/", "-")}.json`;
}
async function backup() {
  const payload = { app: "hamrah-finance", version: 2 };
  for (const table of [
    "transactions",
    "installments",
    "payments",
    "checks",
    "categories",
    "settings",
    "budgets",
    "savings_transfers",
    "savings_movements",
  ])
    payload[table] = await all(table);
  const contents = JSON.stringify(payload, null, 2);
  const name = backupFileName();
  if (Capacitor.isNativePlatform()) {
    const baseDir =
      setting("backupDir", "documents") === "downloads"
        ? Directory.ExternalStorage
        : Directory.Documents;
    let savedPath = "";
    try {
      const result = await Filesystem.writeFile({
        path: name,
        data: contents,
        directory: baseDir,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      savedPath = result.uri || name;
    } catch (error) {
      // If the public folder is not writable, at least keep a copy inside the app so it is never lost.
      const fallback = await Filesystem.writeFile({
        path: name,
        data: contents,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      savedPath = fallback.uri || name;
      toast("در پوشهٔ عمومی ذخیره نشد؛ داخل خود برنامه ذخیره شد.", true);
    }
    try {
      await Share.share({
        title: "نسخهٔ پشتیبان مدیریت مالی حقوق",
        text: "فایل پشتیبان برنامه",
        files: [savedPath],
        dialogTitle: "ذخیرهٔ فایل پشتیبان",
      });
    } catch (error) {
      /* user closed the share sheet */
    }
    state.lastBackup = { name, uri: savedPath, at: new Date().toISOString() };
    if (setting("backupAutoSave", true))
      await setSetting("lastBackup", state.lastBackup);
    render();
    toast("فایل پشتیبان ذخیره شد.");
    return;
  }
  download(name, contents, "application/json");
  state.lastBackup = { name, uri: "", at: new Date().toISOString() };
  if (setting("backupAutoSave", true))
    await setSetting("lastBackup", state.lastBackup);
  render();
  toast("نسخهٔ پشتیبان آماده شد.");
}
async function restoreText(text) {
  const payload = JSON.parse(text);
  const requiredTables = [
    "transactions",
    "installments",
    "payments",
    "categories",
    "settings",
    "budgets",
  ];
  if (
    payload.app !== "hamrah-finance" ||
    requiredTables.some((table) => !Array.isArray(payload[table]))
  )
    throw new Error("فایل پشتیبان معتبر نیست.");
  const tables = [
    ...requiredTables,
    "checks",
    "savings_transfers",
    "savings_movements",
  ];
  if (!Array.isArray(payload.checks)) payload.checks = [];
  if (!Array.isArray(payload.savings_transfers)) payload.savings_transfers = [];
  if (!Array.isArray(payload.savings_movements)) payload.savings_movements = [];
  if (
    !confirm(t("اطلاعات فعلی با نسخهٔ پشتیبان جایگزین می‌شود. ادامه می‌دهی؟"))
  )
    return;
  for (const table of tables) {
    await clearStore(table);
    for (const row of payload[table]) await save(table, row);
  }
  await applyRestoredData();
}
async function restorePick() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.style.display = "none";
  document.body.appendChild(input);
  await new Promise((resolve) => {
    input.addEventListener("change", resolve, { once: true });
    window.addEventListener("focus", () => setTimeout(resolve, 1000), {
      once: true,
    });
    input.click();
  });
  const file = input.files?.[0];
  input.remove();
  if (!file) return;
  // Remember the picked file so it can be restored again from the same place.
  try {
    const contents = await file.text();
    JSON.parse(contents); // validate before remembering
    localStorage.setItem(
      "hamrah-picked-backup",
      JSON.stringify({
        name: file.name,
        at: new Date().toISOString(),
        contents,
      }),
    );
    await restoreText(contents);
  } catch (error) {
    toast(error.message || "پشتیبان داخلی خوانده نشد.", true);
  }
}
async function quickBackup() {
  return autoBackup();
}
async function quickRestore() {
  if (!state.lastBackup?.uri) return;
  if (state.lastBackup.uri === "local") {
    const raw = localStorage.getItem("hamrah-auto-backup");
    if (!raw) {
      toast("پشتیبان داخلی خوانده نشد.", true);
      return;
    }
    if (
      !confirm(
        t(
          "اطلاعات فعلی با آخرین پشتیبان داخل برنامه جایگزین می‌شود. ادامه می‌دهی؟",
        ),
      )
    )
      return;
    await restoreText(JSON.parse(raw).contents);
    return;
  }
  const result = await Filesystem.readFile({
    path: state.lastBackup.name,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
  if (
    !confirm(
      t(
        "اطلاعات فعلی با آخرین پشتیبان داخل برنامه جایگزین می‌شود. ادامه می‌دهی؟",
      ),
    )
  )
    return;
  await restoreText(
    typeof result.data === "string"
      ? result.data
      : new TextDecoder().decode(result.data),
  );
}
async function saveQuickBackup() {
  try {
    const record = await quickBackup();
    state.lastBackup = record;
    render();
    toast("پشتیبان سریع داخل برنامه ذخیره شد.");
  } catch (error) {
    toast("ذخیرهٔ پشتیبان انجام نشد.", true);
  }
}
let autoBackupTimer = null;
async function autoBackup() {
  const payload = { app: "hamrah-finance", version: 2 };
  for (const table of [
    "transactions",
    "installments",
    "payments",
    "checks",
    "categories",
    "settings",
    "budgets",
    "savings_transfers",
    "savings_movements",
  ])
    payload[table] = await all(table);
  const contents = JSON.stringify(payload);
  const name = "hamrah-auto-backup.json";
  try {
    let record;
    if (Capacitor.isNativePlatform()) {
      const result = await Filesystem.writeFile({
        path: name,
        data: contents,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      record = { name, uri: result.uri || name, at: new Date().toISOString() };
    } else {
      localStorage.setItem(
        "hamrah-auto-backup",
        JSON.stringify({ name, at: new Date().toISOString(), contents }),
      );
      record = { name, uri: "local", at: new Date().toISOString() };
    }
    state.lastBackup = record;
    if (setting("backupAutoSave", true)) await setSetting("lastBackup", record);
  } catch (error) {
    console.warn("Auto backup failed", error);
  }
}
function scheduleAutoBackup() {
  if (autoBackupTimer) clearTimeout(autoBackupTimer);
  autoBackupTimer = setTimeout(() => {
    autoBackup().catch((error) => console.warn("Auto backup failed", error));
  }, 800);
}
async function applyRestoredData() {
  await refresh();
  await prepareCurrentMonth();
  document.documentElement.dataset.theme = setting("theme", "light");
  applyFontSize();
  // The rolling in-app backup is preserved (and re-taken after restore) so the
  // quick-restore target stays available.
  if (Capacitor.isNativePlatform()) {
    await scheduleInstallmentNotifications();
    await scheduleExpenseLogReminders();
    await scheduleCheckNotifications();
  }
  state.unlocked = false;
  render();
  toast("اطلاعات با موفقیت برگردانده شد.");
}
async function handleForm(form) {
  const value = Object.fromEntries(new FormData(form));
  for (const field of form.querySelectorAll("[data-amount]")) {
    value[field.name] = amountDigits(value[field.name]);
    if (!Number.isSafeInteger(Number(value[field.name] || 0)))
      return toast("مبلغ از محدودهٔ عددی قابل‌محاسبه خارج است.", true);
    if (
      field.required &&
      (!value[field.name] ||
        (form.dataset.form !== "month-entry" && value[field.name] === "0"))
    ) {
      field.setCustomValidity("مبلغ معتبر وارد کن.");
      field.reportValidity();
      return;
    }
  }
  if (form.dataset.form === "pin") {
    const pin = value.pin;
    const error = document.querySelector("#authError");
    if (!/^\d{4}(?:\d{2})?$/.test(pin)) {
      error.textContent = "PIN باید ۴ یا ۶ رقم باشد.";
      return;
    }
    if (!setting("pinHash")) {
      if (pin !== value.confirm) {
        error.textContent = "دو PIN یکسان نیستند.";
        return;
      }
      const salt = id();
      await setSetting("pinSalt", salt);
      await setSetting("pinHash", await digest(pin, salt));
    } else if ((await digest(pin, setting("pinSalt"))) !== setting("pinHash")) {
      error.textContent = "PIN واردشده درست نیست.";
      return;
    }
    state.unlocked = true;
    startTimer();
    render();
    return;
  }
  if (form.dataset.form === "transaction") {
    const transactionDate = parseJalaliDate(value.date);
    if (!transactionDate)
      return toast("تاریخ شمسی معتبر نیست؛ سال/ماه/روز را بررسی کن.", true);
    if (transactionDate > dateNow())
      return toast("تاریخ نمی‌تواند بعد از امروز باشد.", true);
    if (
      form.dataset.kind === "salary" &&
      isoToJalaliKey(transactionDate) !== monthNow()
    )
      return toast("تاریخ حقوق واقعی باید در ماه جاری باشد.", true);
    if (form.dataset.kind !== "salary" && !value.title.trim())
      return toast("عنوان را وارد کن.", true);
    let savingsWithdrawal = 0;
    if (form.dataset.kind === "expense") {
      savingsWithdrawal = confirmSavingsFunding(
        +value.amount,
        isoToJalaliKey(transactionDate),
      );
      if (savingsWithdrawal === null) return;
    }
    if (form.dataset.kind === "salary") {
      if (+value.amount <= 0) {
        return toast("مبلغ حقوق باید بزرگتر از صفر باشد.", true);
      }
      const salaryRows = state.transactions.filter(
        (row) =>
          row.kind === "salary" && isoToJalaliKey(row.date) === monthNow(),
      );
      const salaryId = salaryRows[0]?.id || `salary-${monthNow()}`;
      await save("transactions", {
        id: salaryId,
        kind: "salary",
        title: "حقوق ماهانه",
        amount: +value.amount,
        category: "حقوق",
        date: transactionDate,
        note: value.note || "",
      });
      for (const duplicate of salaryRows.slice(1))
        await remove("transactions", duplicate.id);
    } else {
      const transaction = {
        id: id(),
        kind: form.dataset.kind,
        title: value.title.trim(),
        amount: +value.amount,
        category: value.category || "",
        date: transactionDate,
        note: value.note || "",
      };
      await save("transactions", transaction);
      if (savingsWithdrawal > 0) {
        try {
          await save("savings_movements", {
            id: id(),
            kind: "withdrawal",
            amount: savingsWithdrawal,
            date: transactionDate,
            note: `پوشش هزینه: ${transaction.title}`,
            transaction_id: transaction.id,
          });
        } catch (error) {
          await remove("transactions", transaction.id);
          throw error;
        }
      }
    }
    await refresh();
    render();
    toast("تراکنش ثبت شد.");
  }
  if (form.dataset.form === "check") {
    if (!value.title.trim())
      return toast("عنوان یا شماره چک را وارد کن.", true);
    const dueDate = parseJalaliDate(value.due_date);
    if (!dueDate)
      return toast(
        "تاریخ سررسید چک معتبر نیست؛ سال/ماه/روز را بررسی کن.",
        true,
      );
    const amount = Number(value.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0)
      return toast("مبلغ چک باید عدد صحیحِ مثبت و به تومان باشد.", true);
    const previous = state.checks.find((row) => row.id === form.dataset.id);
    const check = {
      id: previous?.id || id(),
      title: value.title.trim(),
      amount,
      due_date: dueDate,
      created_at: previous?.created_at || dateNow(),
    };
    await save("checks", check);
    await refresh();
    let message = "چک ثبت شد؛ مبلغ آن در محاسبات مالی وارد نمی‌شود.";
    if (Capacitor.isNativePlatform()) {
      try {
        if (await requestInstallmentNotificationPermission())
          await scheduleCheckNotifications();
        else message = "چک ثبت شد؛ برای اعلان سررسید، مجوز اعلان را فعال کن.";
      } catch (error) {
        console.warn("Could not schedule check reminders.", error);
        message = "چک ثبت شد؛ زمان‌بندی اعلان انجام نشد.";
      }
    }
    state.page = "checks";
    render();
    toast(message);
  }
  if (form.dataset.form === "installment") {
    const dueParts = parseJalaliParts(value.due);
    if (!dueParts)
      return toast("سررسید قسط بعدی معتبر نیست؛ مثل ۱۴۰۵/۱۰/۲ وارد کن.", true);
    const monthly = Number(value.monthly);
    const total = Number(value.total);
    const months = Number(value.months);
    const paid = Number(value.paid || 0);
    if (
      !Number.isSafeInteger(monthly) ||
      monthly <= 0 ||
      !Number.isSafeInteger(total) ||
      total <= 0
    )
      return toast(
        "مبلغ قسط و بدهی باید عدد صحیحِ مثبت و به تومان باشد.",
        true,
      );
    if (!Number.isSafeInteger(months) || months < 1)
      return toast("تعداد ماه‌ها باید عدد صحیح و حداقل ۱ باشد.", true);
    if (!Number.isSafeInteger(paid) || paid < 0 || paid > months)
      return toast(
        "تعداد پرداخت‌شده باید عدد صحیح و بین صفر و تعداد کل باشد.",
        true,
      );
    if (!Number.isSafeInteger(monthly * months) || total > monthly * months)
      return toast("مبلغ کل با مبلغ ماهانه و تعداد ماه‌ها سازگار نیست.", true);
    if (!value.name.trim()) return toast("نام قسط را وارد کن.", true);
    // start_month is the Jalali month of the NEXT unpaid installment, so the schedule
    // counts every already-paid installment and continues from that one (e.g. paid 8 of 12 -> starts at 9).
    const startParts = addJalaliMonth(
      dueParts.jy,
      dueParts.jm,
      -Math.max(0, +value.paid),
    );
    const startDay = Math.min(
      dueParts.jd,
      jalaliMonthLength(startParts.jy, startParts.jm),
    );
    await save("installments", {
      id: id(),
      name: value.name.trim(),
      monthly_amount: monthly,
      total_amount: total,
      months,
      paid_count: paid,
      start_date: dueParts.iso,
      next_due_date: dueParts.iso,
      due_day: dueParts.jd,
      due_month: `${startParts.jy}-${String(startParts.jm).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`,
    });
    await refresh();
    let savedMessage = "قسط ثبت شد.";
    if (Capacitor.isNativePlatform() && setting("installmentReminders", true)) {
      try {
        if (await requestInstallmentNotificationPermission())
          await scheduleInstallmentNotifications();
        else {
          await setSetting("installmentReminders", false);
          savedMessage = "قسط ثبت شد؛ مجوز اعلان داده نشد.";
        }
      } catch (error) {
        console.warn("Could not schedule installment reminders.", error);
        savedMessage = "قسط ثبت شد؛ زمان‌بندی اعلان انجام نشد.";
      }
    }
    state.page = "installments";
    render();
    toast(savedMessage);
  }
  if (form.dataset.form === "month-entry") {
    const period = monthNow();
    await setSetting("monthlySalary", +value.salaryEstimate || 0);
    await setSetting(`salaryEstimate:${period}`, +value.salaryEstimate || 0);
    await setSetting(`salary-estimate:${period}`, true);
    state.pendingMonthEntry = false;
    state.monthPromptShown = false;
    render();
    toast("حقوق تخمینی ماه ذخیره شد و در موجودی لحاظ شد.");
  }
  if (form.dataset.form === "settings") {
    await setSetting("monthlySalary", +value.salary || 0);
    await setSetting("monthlyBudget", +value.budget || 0);
    await setSetting("savingsGoal", +value.savings || 0);
    await save("budgets", { month: monthNow(), amount: +value.budget || 0 });
    await refresh();
    render();
    toast("تنظیمات ذخیره شد.");
  }
  if (form.dataset.form === "category") {
    const name = value.name.trim();
    if (!name || state.categories.some((row) => row.name === name))
      return toast("نام دسته خالی یا تکراری است.", true);
    await save("categories", { id: id(), name });
    await refresh();
    render();
    toast("دسته اضافه شد.");
  }
  if (form.dataset.form === "change-pin") {
    if (
      (await digest(value.current, setting("pinSalt"))) !== setting("pinHash")
    )
      return toast("PIN فعلی درست نیست.", true);
    if (!/^\d{4}(?:\d{2})?$/.test(value.next) || value.next !== value.confirm)
      return toast("PIN جدید باید ۴ یا ۶ رقم و یکسان باشد.", true);
    const salt = id();
    await setSetting("pinSalt", salt);
    await setSetting("pinHash", await digest(value.next, salt));
    render();
    toast("PIN تغییر کرد.");
  }
}
function startTimer() {
  clearInterval(state.lockTimer);
  state.lastActivity = Date.now();
  state.lockTimer = setInterval(() => {
    if (state.unlocked && monthNow() !== state.monthCycle)
      void checkMonthCycle();
    if (
      state.unlocked &&
      Date.now() - state.lastActivity >= +setting("autoLockMinutes", 5) * 60_000
    )
      lock();
  }, 5000);
}
function lock() {
  state.unlocked = false;
  clearInterval(state.lockTimer);
  authScreen();
  void autoBiometric();
}
function autoBiometric() {
  if (
    Capacitor.isNativePlatform() &&
    !state.unlocked &&
    setting("pinHash") &&
    state.availableBio &&
    setting("biometricEnabled", true)
  )
    return biometric();
}
function handleAndroidBack() {
  const modalRoot = document.querySelector("#modalRoot");
  if (modalRoot?.firstElementChild) {
    modalRoot.innerHTML = "";
    return;
  }
  if (
    state.unlocked &&
    state.page === "settings" &&
    state.settingsPane &&
    state.settingsPane !== "home"
  ) {
    state.settingsPane = "home";
    lastBackPressAt = 0;
    render();
    return;
  }
  if (state.unlocked && state.page !== "home") {
    state.page = "home";
    lastBackPressAt = 0;
    render();
    return;
  }
  const now = Date.now();
  if (now - lastBackPressAt <= 2000) {
    lastBackPressAt = 0;
    if (window.confirm(t("می‌خواهید از برنامه خارج شوید؟"))) void App.exitApp();
    return;
  }
  lastBackPressAt = now;
  toast("برای خروج، دوباره دکمهٔ بازگشت را بزنید.");
}
async function biometric() {
  try {
    await NativeBiometric.verifyIdentity({
      reason: t("ورود به مدیریت مالی حقوق"),
      title: t("تأیید هویت"),
      description: t("اطلاعات بیومتریک ذخیره نمی‌شود"),
    });
    state.unlocked = true;
    startTimer();
    render();
  } catch {
    toast("تأیید نشد؛ با PIN وارد شو.", true);
  }
}
root.addEventListener("input", (event) => {
  if (event.target.matches("input[data-jalali]")) {
    const field = event.target;
    const error = field.closest("label")?.querySelector(".field-error");
    const parsed = parseJalaliDate(field.value);
    const invalid = Boolean(field.value.trim()) && !parsed;
    field.setCustomValidity(
      invalid ? t("تاریخ معتبر نیست؛ مثل ۱۴۰۵/۰۷/۰۹ وارد کن.") : "",
    );
    if (error) {
      error.hidden = !invalid;
      error.textContent = invalid
        ? t("تاریخ معتبر نیست؛ سال.ماه.روز را بررسی کن.")
        : "";
    }
    return;
  }
  const field = event.target;
  if (!field.matches("[data-amount]")) return;
  field.setCustomValidity("");
  const cursor = field.selectionStart;
  const digitsBeforeCursor = amountDigits(field.value.slice(0, cursor)).length;
  field.value = formatAmount(field.value);
  if (cursor !== null) {
    let position = 0;
    let digits = 0;
    while (position < field.value.length && digits < digitsBeforeCursor) {
      if (/\d/.test(field.value[position])) digits++;
      position++;
    }
    field.setSelectionRange(position, position);
  }
});
root.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  try {
    await handleForm(form);
  } catch (error) {
    console.error(error);
    toast("ذخیره انجام نشد.", true);
  }
});
document.addEventListener("click", (event) => {
  if (!activeJalaliCalendar) return;
  const { wrapper, popup } = activeJalaliCalendar;
  if (event.target.closest("[data-calendar-open]")) return;
  if (!popup.contains(event.target)) {
    closeJalaliCalendar();
    return;
  }
  const step = event.target.closest("[data-calendar-step]");
  if (step) {
    let year = Number(wrapper.dataset.calendarYear),
      month =
        Number(wrapper.dataset.calendarMonth) +
        Number(step.dataset.calendarStep);
    if (month < 1) {
      month = 12;
      year--;
    } else if (month > 12) {
      month = 1;
      year++;
    }
    drawJalaliCalendar(wrapper, year, month, popup);
    positionJalaliCalendar();
    return;
  }
  const day = event.target.closest("[data-calendar-day]");
  if (day) {
    const field = wrapper.querySelector("input[data-jalali]");
    field.value = formatJalaliDate(
      jalaliToIso(
        Number(wrapper.dataset.calendarYear),
        Number(wrapper.dataset.calendarMonth),
        Number(day.dataset.calendarDay),
      ),
    );
    closeJalaliCalendar();
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
});
function animateButtonTap(event) {
  const button = event.target.closest("button");
  if (
    !button ||
    button.disabled ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const navIcon = button.matches(".nav-item")
    ? button.querySelector("span:first-child")
    : null;
  const iconButton = button.matches(
    ".calendar-trigger,.calendar-nav,.icon-button,.row-delete,.pay-button",
  );
  const target = navIcon || (iconButton ? button : null);
  if (target?.animate) {
    target.animate(
      [
        { transform: "scale(.78) rotate(0deg)", filter: "brightness(1)" },
        {
          transform: "scale(1.3) rotate(10deg)",
          filter: "brightness(1.45)",
          offset: 0.42,
        },
        {
          transform: "scale(.94) rotate(-5deg)",
          filter: "brightness(1.18)",
          offset: 0.72,
        },
        { transform: "scale(1) rotate(0deg)", filter: "brightness(1)" },
      ],
      { duration: 560, easing: "cubic-bezier(.2,.8,.25,1)" },
    );
  } else if (button.animate) {
    button.animate(
      [
        { filter: "brightness(1)", boxShadow: "0 0 0 rgba(100,170,255,0)" },
        {
          filter: "brightness(1.16)",
          boxShadow: "0 0 22px rgba(100,170,255,.3)",
          offset: 0.45,
        },
        { filter: "brightness(1)", boxShadow: "0 0 0 rgba(100,170,255,0)" },
      ],
      { duration: 430, easing: "ease-out" },
    );
  }
}
root.addEventListener("pointerdown", animateButtonTap);
root.addEventListener("click", (event) => {
  if (event.detail === 0) animateButtonTap(event);
});
root.addEventListener("click", async (event) => {
  const calendarOpen = event.target.closest("[data-calendar-open]");
  if (calendarOpen) {
    const wrapper = calendarOpen.closest("label");
    if (activeJalaliCalendar?.wrapper === wrapper) closeJalaliCalendar();
    else openJalaliCalendar(wrapper);
    return;
  }
  const fontChoice = event.target.closest("[data-font-choice]");
  if (fontChoice) {
    await setSetting("fontSize", fontChoice.dataset.fontChoice);
    applyFontSize();
    render();
    return;
  }
  const languageChoice = event.target.closest("[data-language-choice]");
  if (languageChoice) {
    const language = languageChoice.dataset.languageChoice;
    if (getLanguage() !== language) {
      await setSetting("language", language);
      setLanguage(language);
      if (Capacitor.isNativePlatform()) {
        try {
          await Promise.all([
            scheduleInstallmentNotifications(),
            scheduleExpenseLogReminders(),
            scheduleCheckNotifications(),
          ]);
        } catch (error) {
          console.warn("Could not refresh localized notification text.", error);
        }
      }
      render();
      toast(
        language === "en"
          ? "Language changed to English."
          : "زبان به فارسی تغییر کرد.",
      );
    }
    return;
  }
  const themeChoice = event.target.closest("[data-theme-choice]");
  if (themeChoice) {
    const theme = themeChoice.dataset.themeChoice;
    await setSetting("theme", theme);
    document.documentElement.dataset.theme = theme;
    await applyStatusBarTheme(theme);
    render();
    return;
  }
  const page = event.target.closest("[data-page]");
  if (page) {
    event.preventDefault();
    state.page = page.dataset.page;
    if (state.page === "settings") state.settingsPane = "home";
    render();
    if (page.matches(".nav-item"))
      requestAnimationFrame(() => {
        const active = root.querySelector(".nav-item.active");
        if (active) animateButtonTap({ target: active });
      });
    return;
  }
  const mode = event.target.closest("[data-mode]");
  if (mode) {
    state.reportType = mode.dataset.mode;
    render();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (!action) return;
  const key = action.dataset.id || action.dataset.action;
  try {
    switch (action.dataset.action) {
      case "lock":
        lock();
        break;
      case "biometric":
        await biometric();
        break;
      case "expense":
        transactionForm("expense");
        break;
      case "income":
        transactionForm("income");
        break;
      case "salary":
        transactionForm("salary");
        break;
      case "salary-estimate":
        monthEntryForm();
        break;
      case "installment":
        installmentForm();
        break;
      case "add-check":
        checkForm();
        break;
      case "edit-check":
        checkForm(state.checks.find((row) => row.id === key));
        break;
      case "delete-check": {
        if (confirm(t("این چک حذف شود؟"))) {
          await remove("checks", key);
          await refresh();
          if (Capacitor.isNativePlatform()) {
            try {
              await scheduleCheckNotifications();
            } catch (error) {
              console.warn("Could not update check reminders.", error);
            }
          }
          render();
          toast("چک حذف شد.");
        }
        break;
      }
      case "close":
        document.querySelector("#modalRoot").innerHTML = "";
        break;
      case "pay": {
        const item = state.installments.find((row) => row.id === key);
        const offset = item ? installmentPaidCount(item) : 0;
        const period = item ? dueMonthForOffset(item, offset).key : "";
        const amount = item ? installmentDueAmount(item, offset) : 0;
        if (
          item &&
          offset < installmentMonths(item) &&
          amount > 0 &&
          !state.payments.some(
            (row) => row.installment_id === key && row.period === period,
          )
        ) {
          const paymentDate = dateNow();
          const savingsWithdrawal = confirmSavingsFunding(amount, monthNow());
          if (savingsWithdrawal === null) break;
          const payment = {
            id: id(),
            installment_id: key,
            period,
            amount,
            paid_at: paymentDate,
          };
          await save("payments", payment);
          if (savingsWithdrawal > 0) {
            try {
              await save("savings_movements", {
                id: id(),
                kind: "withdrawal",
                amount: savingsWithdrawal,
                date: paymentDate,
                note: `پوشش پرداخت قسط: ${item.name}`,
                payment_id: payment.id,
              });
            } catch (error) {
              await remove("payments", payment.id);
              throw error;
            }
          }
          // A single payment clears one scheduled installment. Missed months stay outstanding.
          item.paid_count = Math.min(installmentMonths(item), offset + 1);
          if (item.paid_count < installmentMonths(item)) {
            const nextDue = dueMonthForOffset(item, item.paid_count);
            item.next_due_date = jalaliToIso(
              nextDue.jy,
              nextDue.jm,
              nextDue.day,
            );
          }
          await save("installments", item);
          await refresh();
          try {
            await scheduleInstallmentNotifications();
          } catch (error) {
            console.warn("Could not update installment reminders.", error);
          }
          render();
          toast("پرداخت قسط ثبت شد.");
        }
        break;
      }
      case "delete":
        if (confirm(t("این تراکنش حذف شود؟"))) {
          for (const movement of state.savingsMovements.filter(
            (row) => row.transaction_id === key,
          ))
            await remove("savings_movements", movement.id);
          await remove("transactions", key);
          await refresh();
          render();
        }
        break;
      case "category":
        modal(
          "دسته‌بندی تازه",
          `<form data-form="category">${input("نام دسته", "name", "text", 'maxlength="30"')}<button class="primary-button">افزودن</button></form>`,
        );
        break;
      case "delete-category": {
        const item = state.categories.find((row) => row.id === key);
        if (
          item &&
          state.transactions.some((row) => row.category === item.name)
        )
          return toast("دسته‌ای که تراکنش دارد حذف نمی‌شود.", true);
        if (item && confirm(t("این دسته حذف شود؟"))) {
          await remove("categories", key);
          await refresh();
          render();
        }
        break;
      }
      case "change-pin":
        modal(
          "تغییر PIN",
          `<form data-form="change-pin">${input("PIN فعلی", "current", "password", 'minlength="4" maxlength="6"')}${input("PIN جدید", "next", "password", 'minlength="4" maxlength="6"')}${input("تکرار PIN جدید", "confirm", "password", 'minlength="4" maxlength="6"')}<button class="primary-button">ذخیره PIN</button></form>`,
        );
        break;
      case "settings-open":
        state.settingsPane = action.dataset.pane || "home";
        render();
        break;
      case "open-link":
        if (action.dataset.url)
          window.open(action.dataset.url, "_blank", "noopener");
        break;
      case "reset-app":
        if (
          confirm(
            t(
              "همهٔ تراکنش‌ها، اقساط و تنظیمات پاک می‌شوند. PIN ورود حفظ می‌شود. ادامه می‌دهی؟",
            ),
          )
        )
          await resetAppData();
        break;
      case "backup":
        await backup();
        break;
      case "restore":
        await restorePick();
        break;
      case "restore-picked":
        try {
          const picked = JSON.parse(
            localStorage.getItem("hamrah-picked-backup") || "null",
          );
          if (!picked) {
            toast("پشتیبان داخلی خوانده نشد.", true);
            break;
          }
          await restoreText(picked.contents);
        } catch (error) {
          toast(error.message || "پشتیبان داخلی خوانده نشد.", true);
        }
        break;
      case "quick-backup":
        await saveQuickBackup();
        break;
      case "quick-restore":
        try {
          await quickRestore();
        } catch (error) {
          toast("پشتیبان داخلی خوانده نشد.", true);
        }
        break;
      case "savings-transfer":
        await transferRemainingToSavings();
        break;
      case "pdf":
        window.print();
        break;
      case "report-prev":
        state.report = addMonth(
          state.report,
          state.reportType === "year" ? -12 : -1,
        );
        render();
        break;
      case "report-next":
        state.report = addMonth(
          state.report,
          state.reportType === "year" ? 12 : 1,
        );
        render();
        break;
    }
  } catch (error) {
    console.error(error);
    toast(error.message || "عملیات انجام نشد.", true);
  }
});
root.addEventListener("input", (event) => {
  if (event.target.id === "search") {
    state.search = event.target.value;
    const cursor = event.target.selectionStart;
    render();
    const input = document.querySelector("#search");
    input?.focus();
    input?.setSelectionRange(cursor, cursor);
  }
});
root.addEventListener("change", async (event) => {
  if (event.target.id === "categoryFilter") {
    state.filter = event.target.value;
    render();
  }
  if (event.target.id === "autoLock") {
    await setSetting("autoLockMinutes", +event.target.value);
    startTimer();
  }
  if (event.target.id === "bioToggle")
    await setSetting("biometricEnabled", event.target.checked);
  if (event.target.id === "backupDir")
    await setSetting("backupDir", event.target.value);
  if (event.target.id === "backupAutoSave")
    await setSetting("backupAutoSave", event.target.checked);
  if (event.target.id === "installmentReminderToggle") {
    try {
      if (!event.target.checked) {
        await setSetting("installmentReminders", false);
        await cancelInstallmentNotifications();
        toast("یادآوری قسط خاموش شد.");
      } else if (await requestInstallmentNotificationPermission()) {
        await setSetting("installmentReminders", true);
        await scheduleInstallmentNotifications();
        toast("یادآوری سررسید قسط فعال شد.");
      } else {
        event.target.checked = false;
        await setSetting("installmentReminders", false);
        toast("برای یادآوری قسط باید مجوز اعلان را بدهی.", true);
      }
    } catch (error) {
      event.target.checked = false;
      await setSetting("installmentReminders", false);
      console.error(error);
      toast("فعال‌سازی یادآوری انجام نشد.", true);
    }
  }
  if (event.target.id === "expenseLogReminderToggle") {
    try {
      if (!event.target.checked) {
        await setSetting("expenseLogReminders", false);
        await cancelExpenseLogReminders();
        toast("یادآوری ثبت هزینه خاموش شد.");
      } else if (await requestInstallmentNotificationPermission()) {
        await setSetting("expenseLogReminders", true);
        await scheduleExpenseLogReminders();
        toast("یادآوری ثبت هزینه فعال شد.");
      } else {
        event.target.checked = false;
        await setSetting("expenseLogReminders", false);
        toast("برای یادآوری ثبت هزینه باید مجوز اعلان را بدهی.", true);
      }
    } catch (error) {
      event.target.checked = false;
      await setSetting("expenseLogReminders", false);
      console.error(error);
      toast("فعال‌سازی یادآوری انجام نشد.", true);
    }
  }
  if (Capacitor.isNativePlatform() && event.target.id === "backupDir") {
    await setSetting("backupDir", event.target.value);
    toast("محل ذخیرهٔ پشتیبان تغییر کرد.");
  }
});
document.addEventListener("pointerdown", () => {
  if (state.unlocked) state.lastActivity = Date.now();
});
document.addEventListener("keydown", () => {
  if (state.unlocked) state.lastActivity = Date.now();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.unlocked && monthNow() !== state.monthCycle)
    void checkMonthCycle();
  if (
    state.unlocked &&
    Date.now() - state.lastActivity >= +setting("autoLockMinutes", 5) * 60_000
  )
    lock();
});

async function boot() {
  try {
    await initializeDatabase();
    await refresh();
    setLanguage(setting("language", "fa"));
    document.documentElement.dataset.theme = setting("theme", "light");
    applyFontSize();
    if (!state.categories.length)
      for (const name of defaultCategories)
        await save("categories", { id: id(), name });
    await prepareCurrentMonth();
    if (Capacitor.isNativePlatform()) {
      await applyStatusBarTheme(setting("theme", "light"));
      App.addListener("backButton", handleAndroidBack);
      state.availableBio = Boolean(
        (await NativeBiometric.isAvailable()).isAvailable,
      );
      if (state.installments.length && setting("installmentReminders", true)) {
        const permission = await LocalNotifications.checkPermissions();
        if (
          permission.display !== "granted" &&
          !(await requestInstallmentNotificationPermission())
        )
          await setSetting("installmentReminders", false);
      }
      try {
        await scheduleInstallmentNotifications();
      } catch (error) {
        console.warn("Could not schedule installment reminders.", error);
      }
      if (setting("expenseLogReminders", true)) {
        try {
          if (await requestInstallmentNotificationPermission())
            await scheduleExpenseLogReminders();
          else await setSetting("expenseLogReminders", false);
        } catch (error) {
          console.warn("Could not schedule expense reminders.", error);
        }
      }
      if (state.checks.length) {
        try {
          if (await requestInstallmentNotificationPermission())
            await scheduleCheckNotifications();
        } catch (error) {
          console.warn("Could not schedule check reminders.", error);
        }
      }
    }
    render();
    void autoBiometric();
  } catch (error) {
    console.error(error);
    root.innerHTML = `<main class="boot-screen"><b>راه‌اندازی ناموفق بود</b><span>${escape(error.message)}</span></main>`;
  }
}
boot();
