/* ПЛЯСКИ — панель учёта. Данные живут в SQLite (data/plyaski.sqlite3), интерфейс — здесь. */

const STATE = {
  data: null,
  view: "attendance",
  branch: "all",
  search: "",
  status: "all",
  activity: "all",
  direction: "all",
  attention: false,
  sort: { key: "name", dir: 1 },
  attendanceDate: null,
  attendanceMarks: {},
  attendanceMarksDate: null,
  attendanceExtra: new Set(),
  attendanceExpanded: new Set(),
  individualDraft: {},
  salaryYear: null,
  salaryMonth: null,
  salaries: null,
};

const BRANCH_COLORS = ["var(--sever)", "#9d8cff", "#5fe0d4", "var(--warn)"];

const FINANCE_FIELDS = [
  // auto — статью считает сервер по платежам и зарплатам, руками её не вводят.
  { key: "income_subs", label: "Абонементы", group: "in", auto: "по платежам учеников" },
  { key: "income_rent", label: "Аренда зала", group: "in" },
  { key: "expense_rent", label: "Аренда помещения", group: "out" },
  { key: "expense_coaches", label: "ЗП тренеров", group: "out", auto: "по начисленным зарплатам тренеров" },
  { key: "expense_admins", label: "ЗП админов", group: "out", auto: "по начисленным зарплатам администраторов" },
  { key: "expense_ads", label: "Реклама", group: "out" },
  { key: "expense_merch", label: "Костюмы", group: "out" },
  { key: "expense_other", label: "Прочее", group: "out" },
];
const INCOME_KEYS = FINANCE_FIELDS.filter((f) => f.group === "in").map((f) => f.key);
const EXPENSE_KEYS = FINANCE_FIELDS.filter((f) => f.group === "out").map((f) => f.key);

// Цвета статей расходов подобраны под тёмный фон: достаточно светлые, чтобы
// на полосе читалась тёмная подпись процентов, и различимые между собой.
const EXPENSE_COLORS = {
  expense_rent: "#9d8cff",
  expense_coaches: "#ff7a6e",
  expense_admins: "#ffae5c",
  expense_ads: "#ffd65c",
  expense_merch: "#5fe0d4",
  expense_other: "#a3adbb",
};

const DIRECTION_HINTS = ["Детский танец", "Эстрадный танец", "Современный танец", "Классический танец", "Ритмика", "Базовая акробатика", "ОФП", "Растяжка", "Здоровая спина", "Силовая тренировка", "Танцевальное кардио", "Пилатес", "МФР"];
const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const HALLS = ["Основной", "Малый"];
const SOURCE_OPTIONS = [
  "Сарафанное радио",
  "Вконтакте",
  "Чат ЖК",
  "Сайт",
  "Telegram",
  "Яндекс Карты",
  "2gis",
  "Листовки в детском саду",
  "Увидели студию в ЖК",
];

/* --- утилиты ------------------------------------------------------------ */

const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const money = (v) => `${nf.format(Math.round(v || 0))} ₽`;
const moneyShort = (v) => {
  const abs = Math.abs(v || 0);
  if (abs >= 1000000) return `${(v / 1000000).toFixed(abs >= 10000000 ? 0 : 1).replace(".", ",")} млн`;
  if (abs >= 10000) return `${Math.round(v / 1000)} тыс`;
  return nf.format(Math.round(v || 0));
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const parsed = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const studentDirections = (student) => {
  const values = Array.isArray(student?.directions) ? student.directions : String(student?.direction || "").split(",");
  return values.map((value) => String(value || "").trim()).filter(Boolean);
};
const studentHasDirection = (student, direction) => {
  const target = String(direction || "").trim().toLowerCase();
  return studentDirections(student).some((value) => value.toLowerCase() === target);
};
const studentDirectionLabel = (student) => studentDirections(student).join(", ");

/* --- даты (хранятся как ISO "ГГГГ-ММ-ДД", везде рядом с input[type=date]) */

function pad2(n) {
  return String(n).padStart(2, "0");
}
function isoOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function isoToday() {
  return isoOf(new Date());
}
function isoParts(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  return y && m && d ? { y, m, d } : null;
}
function fmtDate(iso) {
  const p = isoParts(iso);
  return p ? `${pad2(p.d)}.${pad2(p.m)}.${p.y}` : "";
}
function daysLeft(iso) {
  const p = isoParts(iso);
  if (!p) return null;
  const target = new Date(p.y, p.m - 1, p.d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}
/* Срок абонемента: календарные месяцы (15.09 → 15.10) или дни. Месяцы
   главнее — если у вида задано и то и другое, считаем месяцами. */
function addMonthsIso(iso, months) {
  const p = isoParts(iso);
  if (!p) return "";
  const index = p.m - 1 + months;
  const y = p.y + Math.floor(index / 12);
  const m = ((index % 12) + 12) % 12;
  const last = new Date(y, m + 1, 0).getDate(); // 31.01 + 1 мес = 28.02, а не 03.03
  return isoOf(new Date(y, m, Math.min(p.d, last)));
}
function termEndIso(startIso, type) {
  if (!startIso || !type) return "";
  if (type.validity_months) return addMonthsIso(startIso, type.validity_months);
  if (type.validity_days) return addDaysIso(startIso, type.validity_days);
  return "";
}
function termLabel(type) {
  if (!type) return "—";
  if (type.validity_months) return `${type.validity_months} ${plural(type.validity_months, "месяц", "месяца", "месяцев")}`;
  if (type.validity_days) return `${type.validity_days} ${plural(type.validity_days, "день", "дня", "дней")}`;
  return "—";
}

/* Продление абонемента. Новый абонемент начинается там, где кончился
   прежний — без разрыва, как и заведено (15.09 → 15.10, потом 15.10 → …).
   Если прежний давно истёк, начинаем с сегодняшнего дня: иначе ученик
   заплатил бы за дни, которые уже прошли. Срок — по виду абонемента, а если
   у вида он не задан — такой же длины, как прошлый. */
function renewalPlan(student) {
  const type = STATE.data.subscriptionTypes.find((t) => t.id === student.subscription_type_id);
  if (!type) return null;
  const today = isoToday();
  const start = student.until && student.until >= today ? student.until : today;
  let until = termEndIso(start, type);
  if (!until && student.cycle_start && student.until) {
    const a = isoParts(student.cycle_start);
    const b = isoParts(student.until);
    const length = a && b ? Math.round((new Date(b.y, b.m - 1, b.d) - new Date(a.y, a.m - 1, a.d)) / 86400000) : 0;
    if (length > 0) until = addDaysIso(start, length);
  }
  const price = student.price || type.price || null;
  return { type, start, until, price };
}

function renewalStatus(student) {
  if (!student.until) return "Дата окончания абонемента не указана";
  const days = daysLeft(student.until);
  const when =
    days < 0
      ? `истёк ${-days} ${plural(-days, "день", "дня", "дней")} назад`
      : days === 0
      ? "истекает сегодня"
      : `осталось ${days} ${plural(days, "день", "дня", "дней")}`;
  return `Абонемент до ${fmtDate(student.until)} — ${when}`;
}

function addDaysIso(iso, delta) {
  const p = isoParts(iso);
  if (!p) return "";
  const d = new Date(p.y, p.m - 1, p.d);
  d.setDate(d.getDate() + delta);
  return isoOf(d);
}
function isoWeekday(iso) {
  const p = isoParts(iso);
  if (!p) return 0;
  const day = new Date(p.y, p.m - 1, p.d).getDay(); // 0=вс..6=сб
  return (day + 6) % 7; // 0=пн..6=вс
}
const plural = (n, one, few, many) => {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

const branchColor = (id) => {
  const idx = STATE.data.branches.findIndex((b) => b.id === id);
  return BRANCH_COLORS[idx % BRANCH_COLORS.length];
};
const branchName = (id) => (STATE.data.branches.find((b) => b.id === id) || {}).name || id;
// Филиал показываем, только когда их больше одного: с единственным «Север»
// на каждой строке и в каждой форме это просто шум. Откроется второй —
// переключатель, подписи и поля вернутся сами, данные для этого уже есть.
const multiBranch = () => ((STATE.data && STATE.data.branches) || []).length > 1;
/* --- общие детали разметки ----------------------------------------------
   Один набор деталей на всю панель: строки списка, аватары, итоги, пояснения
   выглядят везде одинаково — так глаз не переучивается от раздела к разделу. */

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words[0][0] + (words[1] ? words[1][0] : "")).toUpperCase();
}
const avatar = (name, muted = false) => `<span class="avatar${muted ? " avatar--muted" : ""}" aria-hidden="true">${esc(initials(name))}</span>`;
const chev = `<span class="chev" aria-hidden="true"></span>`;

/* Строка списка — главный элемент на телефоне: слева аватар или значок,
   посередине заголовок и подпись, справа сумма или метка и шеврон. */
function listRow({ attrs = "", lead = "", title = "", sub = "", side = "", chevron = true, muted = false, cls = "" }) {
  const classes = ["list-row", lead ? "has-avatar" : "", muted ? "is-muted" : "", chevron ? "" : "list-row--static", cls].filter(Boolean).join(" ");
  return `<div class="${classes}"${attrs}>
    ${lead ? `<span class="list-row__lead">${lead}</span>` : ""}
    <span class="list-row__main">
      <span class="list-row__title">${title}</span>
      ${sub ? `<span class="list-row__sub">${sub}</span>` : ""}
    </span>
    <span class="list-row__side">${side}${chevron ? chev : ""}</span>
  </div>`;
}
const rowMeta = (value, note = "", noteCls = "", valueCls = "") =>
  `<span class="list-row__meta"><span class="list-row__value${valueCls ? " " + valueCls : ""}">${value}</span>${
    note ? `<span class="list-row__note${noteCls ? " " + noteCls : ""}">${note}</span>` : ""
  }</span>`;

/* Три главных числа раздела одной строкой — вместо трёх отдельных карточек,
   которые на телефоне ложатся «две и одна». */
function summaryCard(items) {
  return `<section class="card summary">${items
    .map(
      (item) => `<div class="summary__item">
        <span class="summary__label">${esc(item.label)}</span>
        <span class="summary__value num${item.cls ? " " + item.cls : ""}"${item.attrs || ""}>${item.value}</span>
      </div>`
    )
    .join("")}</section>`;
}
const moneyHtml = (value) => `${moneyShort(value)}<small> ₽</small>`;

/* Значки 24×24, линия 1.8 — как в дизайн-системе. */
const ICON = {
  phone: `<svg viewBox="0 0 24 24"><path d="M5 4h3.5l1.7 4.3-2.2 1.4a11 11 0 0 0 6.3 6.3l1.4-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z"/></svg>`,
  users: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.4"/><path d="M2.8 20c0-3.5 2.8-6.2 6.2-6.2s6.2 2.7 6.2 6.2"/><circle cx="17.2" cy="8.6" r="2.5"/><path d="M15.6 14.1c3 .3 5.1 2.8 5.1 5.9"/></svg>`,
  repeat: `<svg viewBox="0 0 24 24"><path d="M4 9.5A5.5 5.5 0 0 1 9.5 4H18l-2.5-2.5M20 14.5a5.5 5.5 0 0 1-5.5 5.5H6l2.5 2.5"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 3v3M16 3v3"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
  left: `<svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg>`,
  right: `<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></svg>`,
  pulse: `<svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 5 12 2.5-6H21"/></svg>`,
};

const badge = (cls, text) => `<span class="badge${cls ? " badge--" + cls : ""}">${esc(text)}</span>`;

/* «Внимание»: одна причина, по которой ученику стоит позвонить. Статус
   показываем, только когда что-то не так; если всё в порядке — пусто. */
function attentionOf(student) {
  if (student.status === "Ушёл") return null;
  if (hasRenewablePlan(student)) {
    const days = student.until ? daysLeft(student.until) : null;
    const short = student.until ? fmtDate(student.until).slice(0, 5) : "";
    if (days !== null && days < 0) return { cls: "danger", text: `истёк ${short}` };
    const type = subscriptionType(student);
    if (type && !isUnlimited(type) && student.remaining !== null && student.remaining !== undefined) {
      if (student.remaining <= 0) return { cls: "danger", text: "занятия закончились" };
      if (student.remaining === 1) return { cls: "warning", text: "последнее занятие" };
    }
    if (days !== null && days <= 7) return { cls: "warning", text: `истекает ${short}` };
  }
  if ((student.activity === "Затих" || student.activity === "Пропал") && student.daysSinceVisit) {
    const n = student.daysSinceVisit;
    return { cls: "danger", text: `${n} ${plural(n, "день", "дня", "дней")} без занятий` };
  }
  return null;
}
const attentionBadge = (student) => {
  if (student.status === "Ушёл") return badge("", "ушёл");
  const a = attentionOf(student);
  return a ? badge(a.cls, a.text) : "";
};

/* Идёт ли занятие сейчас. В расписании нет длительности, поэтому считаем,
   что занятие длится час. */
const CLASS_MINUTES = 60;
function minutesOf(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(time || "");
  return m ? +m[1] * 60 + +m[2] : null;
}
function classState(group, dateIso) {
  if (group.is_individual || dateIso !== isoToday()) return "";
  const start = minutesOf(group.time);
  if (start === null) return "";
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  if (now >= start && now < start + CLASS_MINUTES) return "now";
  return now >= start + CLASS_MINUTES ? "past" : "";
}

/* Компактное пустое состояние: одна строка с галочкой вместо большой пустой карточки. */
function emptyRow(title, text, action = "", neutral = false) {
  return `<div class="empty-row">
    <span class="empty-row__ico${neutral ? " empty-row__ico--neutral" : ""}">${neutral ? ICON.pulse : ICON.check}</span>
    <span class="empty-row__text"><b>${esc(title)}</b>${esc(text)}${action}</span>
  </div>`;
}

/* Длинное пояснение «как считается» свёрнуто: оно нужно раз, а место на
   экране — каждый день. */
const infoBlock = (summary, html) => `<details class="info"><summary>${esc(summary)}</summary>${html}</details>`;

// Поле «Филиал» в форме: при одном филиале — скрытое, значение подставляется само.
function branchField(name, selected, label = "Филиал", extraOptions = "") {
  const branches = STATE.data.branches;
  if (!multiBranch()) return `<input type="hidden" name="${name}" value="${esc(selected || (branches[0] || {}).id || "")}">`;
  return `<label class="field"><span>${esc(label)}</span><select name="${name}">${extraOptions}${branches
    .map((b) => `<option value="${esc(b.id)}"${b.id === selected ? " selected" : ""}>${esc(b.name)}</option>`)
    .join("")}</select></label>`;
}
const branchesInScope = () =>
  STATE.branch === "all" ? STATE.data.branches : STATE.data.branches.filter((b) => b.id === STATE.branch);
/* Кто сейчас в панели. Владелец видит всё; администратор — без зарплат,
   финансов и справочников. Сервер проверяет то же самое сам. */
const currentUser = () => (STATE.data && STATE.data.user) || {};
const isOwner = () => currentUser().role !== "admin";
const OWNER_VIEWS = new Set(["finance", "salaries"]);

// За что платим: единица, к которой привязана ставка.
const rateUnit = (type) => (type === "monthly" ? "мес" : type === "per_student" ? "ученика" : "занятие");
const rateUnitShort = (type) => (type === "monthly" ? "мес" : type === "per_student" ? "чел." : "зан.");

const allStudents = () =>
  branchesInScope().flatMap((branch) => branch.students.map((student) => ({ ...student, _branch: branch.id })));

function findStudentById(id) {
  for (const branch of STATE.data.branches) {
    const found = branch.students.find((s) => s.id === id);
    if (found) return found;
  }
  return null;
}

function subscriptionType(student) {
  return STATE.data.subscriptionTypes.find((t) => t.id === student.subscription_type_id) || null;
}
function isUnlimited(type) {
  return !type || type.classes_count === null || type.classes_count === undefined;
}
function remainingLabel(student) {
  if (!student.subscription_type_id) return "—";
  const type = subscriptionType(student);
  if (isUnlimited(type)) return "Безлимит";
  return `${student.remaining} из ${type.classes_count}`;
}
// Продлевать имеет смысл только настоящий многоразовый абонемент. Разовое,
// пробное и индивидуальное (одно занятие) — это разовая покупка: у неё нечему
// «заканчиваться», поэтому такие ученики не попадают в «Абонементы на исходе»
// ни по остатку занятий, ни по сроку действия. Безлимит продлевают по дате.
function hasRenewablePlan(student) {
  if (!student.subscription_type_id) return false;
  const type = subscriptionType(student);
  if (!type) return false;
  if (isUnlimited(type)) return true;
  return type.classes_count > 1;
}
function remainingDanger(student) {
  if (!hasRenewablePlan(student)) return false;
  const type = subscriptionType(student);
  if (isUnlimited(type)) return false;
  return student.remaining !== null && student.remaining !== undefined && student.remaining <= 2;
}

const monthIncome = (m) => INCOME_KEYS.reduce((sum, k) => sum + (m[k] || 0), 0);
const monthExpense = (m) => EXPENSE_KEYS.reduce((sum, k) => sum + (m[k] || 0), 0);
const monthFilled = (m) => INCOME_KEYS.concat(EXPENSE_KEYS).some((k) => m[k] !== null && m[k] !== undefined);

function financeTotals(branches) {
  const totals = { income: 0, expense: 0, profit: 0, byExpense: {}, byIncome: {} };
  EXPENSE_KEYS.forEach((k) => (totals.byExpense[k] = 0));
  INCOME_KEYS.forEach((k) => (totals.byIncome[k] = 0));
  branches.forEach((branch) =>
    branch.months.forEach((month) => {
      INCOME_KEYS.forEach((k) => (totals.byIncome[k] += month[k] || 0));
      EXPENSE_KEYS.forEach((k) => (totals.byExpense[k] += month[k] || 0));
      totals.income += monthIncome(month);
      totals.expense += monthExpense(month);
    })
  );
  totals.profit = totals.income - totals.expense;
  return totals;
}

function studentStats(students) {
  const stats = { total: students.length, active: 0, renewed: 0, left: 0, going: 0, quiet: 0, lost: 0 };
  let payers = 0;
  let repeat = 0;
  let money = 0;
  students.forEach((s) => {
    if (s.status === "Активен") stats.active += 1;
    else if (s.status === "Продлил") stats.renewed += 1;
    else if (s.status === "Ушёл") stats.left += 1;

    if (s.activity === "Ходит") stats.going += 1;
    else if (s.activity === "Затих") stats.quiet += 1;
    else if (s.activity === "Пропал") stats.lost += 1;

    if (s.paymentsCount >= 1) payers += 1;
    if (s.renewed) repeat += 1;
    money += s.paidTotal || 0;
  });
  // Удержание по деньгам: какая доля заплативших купила абонемент повторно.
  stats.retention = payers ? repeat / payers : null;
  stats.payers = payers;
  stats.repeat = repeat;
  stats.revenue = money;
  stats.perStudent = students.length ? money / students.length : 0;
  return stats;
}

function activityPill(student) {
  const map = { Ходит: "pill--active", Затих: "pill--warn", Пропал: "pill--left", "Не начал": "pill--muted" };
  const days = student.daysSinceVisit;
  const title = days === null || days === undefined ? "нет ни одного посещения" : `последний раз ${days} ${plural(days, "день", "дня", "дней")} назад`;
  return `<span class="pill ${map[student.activity] || "pill--muted"}" title="${esc(title)}"><i></i>${esc(student.activity)}</span>`;
}

/* --- обмен с сервером ----------------------------------------------------- */

function checkSession(response) {
  if (response.status === 401) {
    showGate("Сессия закончилась — войдите заново");
    throw new Error("Нужно войти в панель");
  }
  return response;
}

async function loadState() {
  const response = checkSession(await fetch("/api/state"));
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Не удалось прочитать базу");
  STATE.data = payload;
}

async function loadAttendanceMarks() {
  const response = await fetch(`/api/attendance?date=${encodeURIComponent(STATE.attendanceDate)}`);
  const payload = await response.json();
  STATE.attendanceMarks = payload.marks || {};
  STATE.attendanceMarksDate = STATE.attendanceDate;
}

async function setAttendanceDate(date) {
  STATE.attendanceDate = date;
  STATE.attendanceExtra = new Set();
  STATE.attendanceExpanded = new Set();
  await loadAttendanceMarks();
  render();
}

async function loadSalaries() {
  const response = checkSession(await fetch(`/api/salaries?year=${STATE.salaryYear}&month=${STATE.salaryMonth}`));
  STATE.salaries = await response.json();
}

async function setSalaryMonth(year, month) {
  if (month < 1) {
    month = 12;
    year -= 1;
  } else if (month > 12) {
    month = 1;
    year += 1;
  }
  STATE.salaryYear = year;
  STATE.salaryMonth = month;
  await loadSalaries();
  render();
}

async function markAttendance(groupId, studentId, status) {
  const payload = { group_id: groupId, student_id: studentId, date: STATE.attendanceDate, status };
  const group = STATE.data.groups.find((g) => g.id === groupId);
  // Правка тренера/цены у уже отмеченного индивидуального занятия тоже идёт
  // через эту функцию (тот же статус, что уже сохранён) — платёж в этом
  // случае не пишем повторно, только когда статус действительно новый.
  const previousStatus = ((STATE.attendanceMarks[groupId] || {})[studentId] || {}).status || null;
  const isNewMark = Boolean(status) && status !== previousStatus;
  if (group && group.is_individual && status) {
    const { coachId, price } = individualState(groupId, studentId);
    if (!coachId) {
      toast("Сначала выберите тренера, который провёл занятие", "error");
      return;
    }
    payload.coach_id = coachId;
    payload.lesson_price = price;
  }
  const ok = await act("attendance.mark", payload);
  if (ok) {
    if (isNewMark && status === "dropin") await recordDropinPayment(studentId, group);
    if (isNewMark && status === "present" && group && group.is_individual) {
      await recordIndividualPayment(studentId, group, payload.coach_id, payload.lesson_price);
    }
    await loadAttendanceMarks();
    render();
  }
}

/* Разовое занятие не по абонементу: посещение не списывается с абонемента
   ученика (см. compute_remaining на сервере — там считаются только «present»),
   но деньги за него нужны студии сразу, поэтому пишем платёж день в день. */
async function recordDropinPayment(studentId, group) {
  const dropinType = (STATE.data.subscriptionTypes || []).find((t) => t.name === "Разовое занятие");
  if (!dropinType || !dropinType.price) {
    toast("Отмечено, но тариф «Разовое занятие» не найден — впишите оплату вручную в карточке ученика", "error");
    return;
  }
  await act(
    "payment.create",
    {
      student_id: studentId,
      amount: dropinType.price,
      payment_date: STATE.attendanceDate,
      subscription_type_id: dropinType.id,
      note: group ? `Разовое посещение · ${group.direction}` : "Разовое посещение",
    },
    `Разовое занятие — записано ${money(dropinType.price)}`
  );
}

/* Индивидуальное занятие: вся сумма от ученика — доход студии, тренеру из неё
   идёт процент (individual_share, считается отдельно в зарплатах). Без этого
   платежа занятие было бы видно только как расход на тренера, а не как доход. */
async function recordIndividualPayment(studentId, group, coachId, price) {
  if (!price) {
    toast("Занятие отмечено, но без цены — впишите оплату вручную в карточке ученика", "error");
    return;
  }
  const coach = STATE.data.coaches.find((c) => c.id === coachId);
  await act(
    "payment.create",
    {
      student_id: studentId,
      amount: price,
      payment_date: STATE.attendanceDate,
      subscription_type_id: null,
      note: `Индивидуальное занятие${coach ? ` · ${coach.name}` : ""}`,
    },
    `Индивидуальное занятие — записано ${money(price)}`
  );
}

let savingDepth = 0;
async function act(action, payload, successMessage) {
  savingDepth += 1;
  document.getElementById("saving").hidden = false;
  try {
    const response = checkSession(
      await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      })
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Ошибка сохранения");
    STATE.data = data;
    if (successMessage) toast(successMessage);
    return true;
  } catch (error) {
    toast(error.message, "error");
    await loadState().catch(() => {});
    render();
    return false;
  } finally {
    savingDepth -= 1;
    if (savingDepth === 0) document.getElementById("saving").hidden = true;
  }
}

function toast(text, kind = "ok") {
  const node = document.createElement("div");
  node.className = `toast${kind === "error" ? " toast--error" : ""}`;
  node.textContent = text;
  document.getElementById("toasts").append(node);
  setTimeout(() => {
    node.style.transition = "opacity .3s ease";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 320);
  }, kind === "error" ? 5200 : 2600);
}

/* --- графики ------------------------------------------------------------ */

function monthlySeries(branches) {
  const labels = [];
  branches.forEach((branch) =>
    branch.months.forEach((month, index) => {
      if (!labels[index]) labels[index] = month.label;
    })
  );
  return labels.map((label, index) => {
    let income = 0;
    let expense = 0;
    branches.forEach((branch) => {
      const month = branch.months[index];
      if (!month) return;
      income += monthIncome(month);
      expense += monthExpense(month);
    });
    return { label: label || "", income, expense, profit: income - expense };
  });
}

function monthChart(series) {
  // Рисуем в том размере, в каком график покажут: на телефоне сетка узкая,
  // иначе картинка шириной 1180 ужимается втрое вместе с подписями осей.
  const compact = matchMedia("(max-width: 820px)").matches;
  const W = compact ? 360 : 1180;
  const H = compact ? 200 : 250;
  const pad = compact ? { top: 12, right: 8, bottom: 26, left: 40 } : { top: 14, right: 12, bottom: 30, left: 46 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = Math.max(1, ...series.map((s) => Math.max(s.income, s.expense, Math.abs(s.profit))));
  const step = innerW / Math.max(series.length, 1);
  const barW = Math.min(26, step / 3.2);
  const y = (value) => pad.top + innerH - (value / max) * innerH;

  const ticks = [0, 0.5, 1].map((t) => {
    const value = max * t;
    return `<line class="grid-line" x1="${pad.left}" x2="${W - pad.right}" y1="${y(value)}" y2="${y(value)}"/>
      <text x="${pad.left - 8}" y="${y(value) + 3.5}" text-anchor="end">${moneyShort(value)}</text>`;
  });

  const bars = series
    .map((point, index) => {
      const cx = pad.left + step * index + step / 2;
      const incomeH = Math.max(0, pad.top + innerH - y(point.income));
      const expenseH = Math.max(0, pad.top + innerH - y(point.expense));
      const short = (point.label || "").split(" ")[0].slice(0, 3);
      return `
        <rect class="bar" x="${cx - barW - 1.5}" y="${y(point.income)}" width="${barW}" height="${incomeH}" rx="3" fill="var(--plus)">
          <title>${esc(point.label)} · доход ${money(point.income)}</title>
        </rect>
        <rect class="bar" x="${cx + 1.5}" y="${y(point.expense)}" width="${barW}" height="${expenseH}" rx="3" fill="var(--minus)" opacity=".85">
          <title>${esc(point.label)} · расход ${money(point.expense)}</title>
        </rect>
        <text x="${cx}" y="${H - 10}" text-anchor="middle">${esc(short)}</text>`;
    })
    .join("");

  const line = series
    .map((point, index) => `${index ? "L" : "M"}${pad.left + step * index + step / 2},${y(point.profit)}`)
    .join(" ");
  const dots = series
    .map((point, index) => {
      const cx = pad.left + step * index + step / 2;
      return `<circle cx="${cx}" cy="${y(point.profit)}" r="3.4" fill="var(--surface)" stroke="var(--accent)" stroke-width="2">
        <title>${esc(point.label)} · прибыль ${money(point.profit)}</title></circle>`;
    })
    .join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Доход, расход и прибыль по месяцам">
    ${ticks.join("")}
    ${bars}
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
}

function reactionBar(totals) {
  const income = totals.income;
  if (!income) {
    return `<p class="empty empty--compact">Внесите доходы и расходы — здесь появится разложение денег по статьям.</p>`;
  }
  const segments = EXPENSE_KEYS.filter((key) => totals.byExpense[key] > 0).map((key) => ({
    key,
    label: FINANCE_FIELDS.find((f) => f.key === key).label,
    value: totals.byExpense[key],
    color: EXPENSE_COLORS[key],
  }));
  if (totals.profit > 0) segments.push({ key: "profit", label: "Прибыль", value: totals.profit, color: "var(--plus)" });

  const scale = Math.max(income, totals.expense);
  const bar = segments
    .map((segment) => {
      const share = (segment.value / scale) * 100;
      return `<div class="reaction__seg" style="flex-basis:${share}%;background:${segment.color}" title="${esc(segment.label)}: ${money(segment.value)}">${
        share > 11 ? `${Math.round((segment.value / income) * 100)}%` : ""
      }</div>`;
    })
    .join("");

  const legend = segments
    .map(
      (segment) => `<span class="legend-item"><i style="background:${segment.color}"></i>${esc(segment.label)} <b class="num">${money(
        segment.value
      )}</b></span>`
    )
    .join("");

  const loss = totals.profit < 0 ? `<p class="kpi__foot" style="color:var(--minus)">Расходы превышают доход на ${money(-totals.profit)}.</p>` : "";
  return `<div class="reaction"><div class="reaction__bar">${bar}</div><div class="reaction__legend">${legend}</div>${loss}</div>`;
}

/* Полоски «сколько учеников в чём». Ученики без значения — не отдельная
   полоса без названия: «не указано» ничего не говорит о том, откуда приходят
   или куда ходят, а длинной полосой забивает всё остальное. Поэтому они идут
   одной строкой под графиком, а если значения нет ни у кого — вместо графика
   подсказка, где его заполнить. */
function barList({ entries, unknown }, color, missing) {
  if (!entries.length) {
    return `<div class="empty empty--compact"><b>${esc(missing.title)}</b>${esc(missing.hint)}</div>`;
  }
  const max = Math.max(...entries.map((e) => e.value));
  const note = unknown
    ? `<p class="bars__note">Ещё ${unknown} ${plural(unknown, "ученик", "ученика", "учеников")} — ${esc(missing.short)}</p>`
    : "";
  return `<div class="bars">${entries
    .map(
      (entry) => `<div class="bars__row">
        <span title="${esc(entry.label)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry.label)}</span>
        <span class="bars__track"><span class="bars__fill" style="width:${(entry.value / max) * 100}%;background:${color}"></span></span>
        <span class="bars__value num">${entry.value}</span>
      </div>`
    )
    .join("")}${note}</div>`;
}

function groupCount(students, field) {
  const map = new Map();
  let unknown = 0;
  students.forEach((student) => {
    const values = (field === "direction" ? studentDirections(student) : [student[field]])
      .map((value) => (value || "").trim())
      .filter(Boolean);
    if (!values.length) unknown += 1;
    values.forEach((key) => map.set(key, (map.get(key) || 0) + 1));
  });
  const entries = [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  return { entries, unknown };
}

/* --- вид: сводка -------------------------------------------------------- */

function viewDashboard() {
  const branches = branchesInScope();
  const students = allStudents();
  const stats = studentStats(students);
  const withMoney = isOwner();
  const today = isoToday();
  const weekday = isoWeekday(today);
  const byTime = (a, b) => (a.time || "99").localeCompare(b.time || "99");

  // На исходе: срок кончается в ближайшие две недели или занятий почти не осталось.
  const expiring = students
    .map((student) => ({ ...student, days: daysLeft(student.until) }))
    .filter(
      (student) =>
        student.status !== "Ушёл" &&
        hasRenewablePlan(student) &&
        ((student.days !== null && student.days <= 14) || remainingDanger(student))
    )
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));
  const lastUntil = expiring.map((s) => s.until).filter(Boolean).sort().pop();

  // «+N за месяц» — кто начал заниматься за последние 30 дней.
  const monthAgo = addDaysIso(today, -30);
  const newcomers = students.filter((s) => s.start && s.start > monthAgo && s.start <= today).length;
  const regular = STATE.data.groups.filter((g) => g.active && !g.is_individual);
  const weekClasses = regular.reduce((sum, g) => sum + g.weekdays.length, 0);
  const todayGroups = regular.filter((g) => g.weekdays.includes(weekday)).sort(byTime);

  const longDate = (iso) => {
    const p = isoParts(iso);
    return p ? `${p.d} ${MONTHS_GEN[p.m - 1]}` : "";
  };
  const stat = ({ label, icon, value, foot = "", accent = false, cls = "" }) => `<div class="stat${accent ? " stat--accent" : ""}">
      <div class="stat__top"><span>${esc(label)}</span><span class="stat__ico">${icon}</span></div>
      <div class="stat__num${cls ? " " + cls : ""}">${value}</div>
      <div class="stat__foot">${foot}</div>
    </div>`;

  const stats4 = `<div class="grid g4">
    ${stat({
      label: "Абонементы на исходе",
      icon: ICON.phone,
      value: expiring.length,
      accent: expiring.length > 0,
      foot: expiring.length
        ? `${badge("", "требуют звонка")}${lastUntil ? `<span>до ${esc(longDate(lastUntil))}</span>` : ""}`
        : "<span>в ближайшие две недели ничего</span>",
    })}
    ${stat({
      label: "Учеников",
      icon: ICON.users,
      value: stats.total,
      foot: `${newcomers ? badge("success", `+${newcomers} за месяц`) : ""}<span>${stats.going} ходят, ${stats.quiet} затихли</span>`,
    })}
    ${stat({
      label: "Удержание",
      icon: ICON.repeat,
      value: stats.retention === null ? "—" : `${Math.round(stats.retention * 100)}%`,
      foot: stats.retention === null ? "<span>появится после первых оплат</span>" : `<span>${stats.repeat} из ${stats.payers} продлили</span>`,
    })}
    ${stat({
      label: "Занятий на неделе",
      icon: ICON.calendar,
      value: weekClasses,
      foot: `<span>${todayGroups.length} сегодня, по расписанию</span>`,
    })}
  </div>`;

  // --- абонементы на исходе: кому звонить ---
  const expiringBadge = (s) => {
    if (s.days !== null && s.days <= 14) {
      const short = fmtDate(s.until).slice(0, 5);
      if (s.days < 0) return badge("danger", `истёк ${short}`);
      return badge(s.days <= 7 ? "warning" : "", `до ${short}`);
    }
    if (s.remaining !== null && s.remaining !== undefined && s.remaining <= 0) return badge("danger", "занятия закончились");
    return badge("warning", `${s.remaining} ${plural(s.remaining, "занятие", "занятия", "занятий")}`);
  };
  const planLine = (s) => {
    const type = subscriptionType(s);
    const parts = [studentDirectionLabel(s) || s.plan || "без направления"];
    if (type) parts.push(isUnlimited(type) ? "безлимит" : `осталось ${s.remaining ?? "—"}`);
    return parts.join(", ");
  };
  const callButton = (s) =>
    s.phone
      ? `<a class="btn btn--sm btn--call" href="tel:${esc(String(s.phone).replace(/[^\d+]/g, ""))}" aria-label="Позвонить: ${esc(s.name)}">${ICON.phone}<span>Позвонить</span></a>`
      : `<span class="btn btn--sm btn--ghost btn--call is-disabled">${ICON.phone}<span>Нет номера</span></span>`;
  const expiringCard = `<section class="card">
    <div class="card__head"><div><h2>Абонементы на исходе</h2></div>${expiring.length ? `<span class="count hot">${expiring.length}</span>` : ""}</div>
    ${
      expiring.length
        ? `<div class="list">${expiring
            .map(
              (s) => `<div class="list-row" data-student-id="${s.id}">
                <span class="list-row__main"><span class="list-row__title">${esc(s.name)}</span><span class="list-row__sub">${esc(planLine(s))}</span></span>
                <span class="list-row__side">${expiringBadge(s)}${callButton(s)}</span>
              </div>`
            )
            .join("")}</div>`
        : emptyRow("Всё под контролем", "В ближайшие две недели ничего не заканчивается.")
    }
  </section>`;

  // --- сегодня: занятия дня с отметками ---
  const marksReady = STATE.attendanceDate === today && STATE.attendanceMarksDate === today;
  const individualToday = marksReady
    ? STATE.data.groups.filter((g) => g.active && g.is_individual && Object.keys((STATE.attendanceMarks || {})[g.id] || {}).length)
    : [];
  const todayRows = [...todayGroups, ...individualToday]
    .map((g) => {
      const state = classState(g, today);
      const p = sessionProgress(g);
      const coach = g.is_individual ? "тренер у каждого занятия свой" : g.coach_id ? coachName(g.coach_id) : "тренер не назначен";
      const meta = [g.hall ? `${g.hall} зал` : "", coach].filter(Boolean).join(", ");
      let side;
      if (state === "now") side = badge("brand", "идёт");
      else if (g.is_individual) side = `<span class="num muted">${p.marked} ${plural(p.marked, "запись", "записи", "записей")}</span>`;
      else if (marksReady && p.total && p.marked === p.total) side = badge("success", `${p.marked}/${p.total}`);
      else side = `<span class="num muted">${marksReady ? `${p.marked}/${p.total}` : `${p.total} уч.`}</span>`;
      return `<div class="today-row${state === "now" ? " is-now" : state === "past" ? " is-past" : ""}" data-today-group="${g.id}" role="button">
        <span class="time${g.time ? "" : " dim"}">${esc(g.time || "—")}</span>
        <span class="list-row__main"><span class="today-row__name">${esc(g.direction)}</span><span class="list-row__sub">${esc(meta)}</span></span>
        ${side}
      </div>`;
    })
    .join("");
  const todayCard = `<section class="card">
    <div class="card__head"><div><h2>Сегодня</h2></div><button class="btn btn--ghost" type="button" data-go="attendance">Отметить</button></div>
    ${todayRows ? `<div class="list">${todayRows}</div>` : emptyRow("Сегодня занятий нет", "По расписанию на этот день групп нет.", "", true)}
  </section>`;

  // --- кто затих ---
  const quiet = students
    .filter((s) => s.status !== "Ушёл" && (s.activity === "Затих" || s.activity === "Пропал"))
    .sort((a, b) => (b.daysSinceVisit || 0) - (a.daysSinceVisit || 0));
  const quietCard = `<section class="card">
    <div class="card__head"><div><h2>Кто затих</h2></div>${quiet.length ? `<span class="count">${quiet.length}</span>` : ""}</div>
    ${
      quiet.length
        ? `<div class="list">${quiet
            .map((s) =>
              listRow({
                attrs: ` data-student-id="${s.id}"`,
                title: esc(s.name),
                sub: esc(`${s.daysSinceVisit} ${plural(s.daysSinceVisit, "день", "дня", "дней")} без занятий`),
                chevron: false,
              })
            )
            .join("")}</div>`
        : emptyRow("Все ходят", `Никто не пропадал дольше ${STATE.data.quietAfterDays} дней.`)
    }
  </section>`;

  // --- по направлениям и откуда приходят ---
  const distribution = (title, field, empty) => {
    const { entries, unknown } = groupCount(students, field);
    if (!entries.length) return `<section class="card"><div class="card__head"><div><h2>${esc(title)}</h2></div></div>${empty}</section>`;
    const max = Math.max(...entries.map((e) => e.value));
    return `<section class="card">
      <div class="card__head"><div><h2>${esc(title)}</h2></div></div>
      <div class="bars">${entries
        .map(
          (e) => `<div class="bars__row">
            <span title="${esc(e.label)}">${esc(e.label)}</span>
            <span class="bars__track"><span class="bars__fill" style="width:${(e.value / max) * 100}%;background:var(--brand-400)"></span></span>
            <span class="bars__value">${e.value}</span>
          </div>`
        )
        .join("")}</div>
      ${unknown ? `<p class="bars__note">Ещё ${unknown} ${plural(unknown, "ученик", "ученика", "учеников")} — ${field === "source" ? "источник не указан" : "без направления"}.</p>` : `<p class="bars__note">Штриховка — остальные ученики.</p>`}
    </section>`;
  };
  const row3 = `<div class="grid g3">
    ${quietCard}
    ${distribution("По направлениям", "direction", emptyRow("Направления не указаны", "Направление выбирают в карточке ученика — от него зависит группа в «Посещаемости».", "", true))}
    ${distribution(
      "Откуда приходят",
      "source",
      emptyRow(
        "Источник пока не указан",
        "Заполните «Рекламный источник» в карточке ученика, и здесь появится статистика.",
        `<button class="btn btn--ghost" type="button" data-go="students">Открыть учеников</button>`,
        true
      )
    )}
  </div>`;

  // --- деньги (только владельцу) ---
  let moneyBlock = "";
  if (withMoney) {
    const totals = financeTotals(branches);
    const series = monthlySeries(branches).filter((point) => point.income || point.expense);
    moneyBlock =
      summaryCard([
        { label: "Доход", value: moneyHtml(totals.income), cls: totals.income ? "is-plus" : "" },
        { label: "Расход", value: moneyHtml(totals.expense), cls: totals.expense ? "is-minus" : "" },
        { label: "Прибыль", value: moneyHtml(totals.profit), cls: totals.profit < 0 ? "is-minus" : "" },
      ]) +
      `<div class="grid g-2-1">
        <section class="card">
          <div class="card__head"><div><h2>Доход, расход, прибыль</h2><p class="eyebrow">по месяцам</p></div>
            <div class="reaction__legend">
              <span class="legend-item"><i style="background:var(--success)"></i>Доход</span>
              <span class="legend-item"><i style="background:var(--danger)"></i>Расход</span>
              <span class="legend-item"><i style="background:var(--brand-400)"></i>Прибыль</span>
            </div>
          </div>
          <div class="card__body">${
            series.length ? monthChart(series) : emptyRow("Ещё нет заполненных месяцев", "Суммы появятся с первыми оплатами.", "", true)
          }</div>
        </section>
        <section class="card">
          <div class="card__head"><div><h2>Куда уходят деньги</h2><p class="eyebrow">из ${esc(money(totals.income))} дохода</p></div></div>
          <div class="card__body">${reactionBar(totals)}</div>
        </section>
      </div>`;
  }

  return stats4 + `<div class="grid g-2-1">${expiringCard}${todayCard}</div>` + row3 + moneyBlock;
}

/* --- вид: ученики ------------------------------------------------------- */

function filteredStudents() {
  const query = STATE.search.trim().toLowerCase();
  let rows = allStudents();
  if (STATE.status !== "all") rows = rows.filter((s) => s.status === STATE.status);
  if (STATE.activity !== "all") rows = rows.filter((s) => s.activity === STATE.activity);
  if (STATE.direction !== "all") rows = rows.filter((s) => studentHasDirection(s, STATE.direction));
  if (STATE.attention) rows = rows.filter((s) => attentionOf(s));
  if (query) {
    // «8906 441» находит «+7 906 441-16-70»: цифры сравниваем без форматирования.
    const digits = query.replace(/\D/g, "").replace(/^8/, "7");
    rows = rows.filter(
      (s) =>
        [s.name, s.phone, studentDirectionLabel(s), s.plan, s.source, s.note].some((value) =>
          String(value || "").toLowerCase().includes(query)
        ) ||
        (digits.length >= 3 && String(s.phone || "").replace(/\D/g, "").replace(/^8/, "7").includes(digits))
    );
  }
  const { key, dir } = STATE.sort;
  rows.sort((a, b) => {
    let left = a[key];
    let right = b[key];
    if (key === "until" || key === "start") {
      left = left || "9999-99-99";
      right = right || "9999-99-99";
    } else if (key === "price") {
      left = left ?? -Infinity;
      right = right ?? -Infinity;
    } else if (key === "remaining" || key === "daysSinceVisit" || key === "paidTotal") {
      left = left === null || left === undefined ? Infinity : left;
      right = right === null || right === undefined ? Infinity : right;
    } else {
      left = String(left || "").toLowerCase();
      right = String(right || "").toLowerCase();
    }
    if (left < right) return -1 * dir;
    if (left > right) return 1 * dir;
    return 0;
  });
  return rows;
}

function statusPill(status) {
  const map = { Активен: "pill--active", Продлил: "pill--renew", "Ушёл": "pill--left" };
  return `<span class="pill ${map[status] || "pill--muted"}"><i></i>${esc(status)}</span>`;
}

function untilCell(student) {
  if (!student.until) return `<span class="cell-sub">не указано</span>`;
  const days = daysLeft(student.until);
  let hint = "";
  if (student.status !== "Ушёл" && days !== null) {
    if (days < 0) hint = `<span class="cell-sub" style="color:var(--minus)">истёк</span>`;
    else if (days <= 14) hint = `<span class="cell-sub" style="color:var(--warn)">через ${days} ${plural(days, "день", "дня", "дней")}</span>`;
  }
  return `<span class="num">${esc(fmtDate(student.until))}</span>${hint}`;
}

function viewStudents() {
  const everyone = allStudents();
  const rows = filteredStudents();
  const directions = [...new Set(everyone.flatMap(studentDirections))].sort();
  const showBranch = STATE.branch === "all" && STATE.data.branches.length > 1;
  const sortArrow = (key) => (STATE.sort.key === key ? `<span class="arrow">${STATE.sort.dir > 0 ? "↑" : "↓"}</span>` : "");
  const attentionCount = everyone.filter((s) => attentionOf(s)).length;
  const filtered = STATE.search.trim() || STATE.attention || STATE.direction !== "all";

  // Панель фильтров: поиск, «Все / Внимание N», направление, «Показано N из M».
  const head = `
    <div class="filters">
      <input id="searchInput" type="search" placeholder="Имя или телефон" value="${esc(STATE.search)}" aria-label="Поиск учеников">
      <span class="seg" role="group" aria-label="Кого показать">
        <button type="button" class="${STATE.attention ? "" : "is-active"}" data-attention="0">Все</button>
        <button type="button" class="${STATE.attention ? "is-active" : ""}" data-attention="1">Внимание ${attentionCount}</button>
      </span>
      <select class="chip-select${STATE.direction !== "all" ? " is-set" : ""}" id="directionFilter" aria-label="Направление">
        <option value="all">Все направления</option>
        ${directions.map((d) => `<option value="${esc(d)}"${STATE.direction === d ? " selected" : ""}>${esc(d)}</option>`).join("")}
      </select>
      ${filtered ? `<span class="filters__count">Показано ${rows.length} из ${everyone.length}</span>` : ""}
    </div>`;

  if (!rows.length) {
    return `<section class="card">${head}${
      everyone.length
        ? emptyRow("Никого не нашли", "Проверьте запрос или сбросьте фильтры.", "", true)
        : emptyRow("Учеников пока нет", "Нажмите «Добавить ученика» — запись сразу попадёт в базу.", "", true)
    }</section>`;
  }

  const planSub = (student) => {
    const type = subscriptionType(student);
    const parts = [];
    if (type) parts.push(isUnlimited(type) ? "безлимит" : `${type.classes_count} ${plural(type.classes_count, "занятие", "занятия", "занятий")}`);
    else parts.push(student.plan || "без абонемента");
    if (student.price) parts.push(money(student.price));
    return parts.join(", ");
  };
  const untilCellNew = (student) => {
    if (!student.until) return `<span class="faint">—</span>`;
    const days = daysLeft(student.until);
    const cls = student.status === "Ушёл" || days === null ? "" : days < 0 ? "date-over" : days <= 7 ? "date-soon" : "";
    return `<span class="num ${cls}">${esc(fmtDate(student.until))}</span>`;
  };
  // «Осталось»: безлимит — словом, счётный — мини-прогресс и «X из N».
  const leftCell = (student) => {
    const type = subscriptionType(student);
    if (!type) return `<span class="faint">—</span>`;
    if (isUnlimited(type)) return `<span class="muted">безлимит</span>`;
    const left = Math.max(0, student.remaining ?? 0);
    const share = type.classes_count ? Math.round((left / type.classes_count) * 100) : 0;
    return `<span class="cell-left"><span class="progress progress--mini"><span style="width:${share}%"></span></span><span class="num">${left} из ${type.classes_count}</span></span>`;
  };

  const body = rows
    .map(
      (student) => `<tr class="clickable" data-branch="${esc(student._branch)}" data-id="${student.id}">
        <td><span class="cell-strong">${esc(student.name)}</span>
          <span class="cell-sub${student.phone ? "" : " is-faint"}">${esc(student.phone || "телефон не указан")}</span></td>
        ${showBranch ? `<td>${esc(branchName(student._branch))}</td>` : ""}
        <td><span class="cell-strong">${esc(studentDirectionLabel(student) || "—")}</span><span class="cell-sub">${esc(planSub(student))}</span></td>
        <td>${untilCellNew(student)}</td>
        <td>${leftCell(student)}</td>
        <td class="right"><span class="num">${student.paymentsCount || 0}</span>${
          student.paidTotal ? `<span class="cell-sub num">${money(student.paidTotal)}</span>` : ""
        }</td>
        <td>${attentionBadge(student)}</td>
      </tr>`
    )
    .join("");

  // Телефон: строка — аватар, имя, направление и срок; справа причина внимания.
  const mobile = rows
    .map((student) => {
      const parts = [studentDirectionLabel(student) || "без направления"];
      if (student.until) parts.push(`до ${fmtDate(student.until).slice(0, 5)}`);
      const type = subscriptionType(student);
      if (type && !isUnlimited(type) && student.remaining !== null && student.remaining !== undefined) parts.push(`осталось ${student.remaining}`);
      return listRow({
        attrs: ` data-student-id="${student.id}"`,
        title: esc(student.name),
        sub: esc(parts.join(", ")),
        side: attentionBadge(student),
        muted: student.status === "Ушёл",
        chevron: false,
      });
    })
    .join("");

  return `<section class="card">${head}
    <div class="list only-mobile">${mobile}</div>
    <div class="table-wrap only-desktop"><table id="studentsTable">
      <thead><tr>
        <th class="sortable" data-sort="name">Ученик${sortArrow("name")}</th>
        ${showBranch ? "<th>Филиал</th>" : ""}
        <th class="sortable" data-sort="direction">Абонемент${sortArrow("direction")}</th>
        <th class="sortable" data-sort="until">Действует до${sortArrow("until")}</th>
        <th class="sortable" data-sort="remaining">Осталось${sortArrow("remaining")}</th>
        <th class="sortable right" data-sort="paidTotal">Оплат${sortArrow("paidTotal")}</th>
        <th>Внимание</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

/* --- вид: финансы ------------------------------------------------------- */

function financeCard(branch) {
  const totals = financeTotals([branch]);
  const currentIndex = branch.months.findIndex((m) => !monthFilled(m));

  const rows = branch.months
    .map((month, index) => {
      const income = monthIncome(month);
      const expense = monthExpense(month);
      const profit = income - expense;
      const cells = FINANCE_FIELDS.map((field) => {
        const fact = month[`fact_${field.key}`];
        const stored = month[field.key];
        if (field.auto) {
          return `<td class="col-group-${field.group}">
            <span class="fin-auto num" title="Считается само — ${esc(field.auto)}">${stored ? nf.format(stored) : "—"}</span>
          </td>`;
        }
        const mismatch = fact !== null && fact !== undefined && Math.round(fact) !== Math.round(stored || 0);
        return `<td class="col-group-${field.group}">
          <input class="fin-input num" type="text" inputmode="numeric" placeholder="—"
                 value="${stored === null || stored === undefined ? "" : nf.format(stored)}"
                 data-branch="${esc(branch.id)}" data-id="${month.id}" data-index="${index}" data-field="${field.key}" aria-label="${esc(field.label)}, ${esc(month.label)}">
          ${mismatch ? `<span class="fin-fact" title="Фактически по данным панели">факт ${moneyShort(fact)}</span>` : ""}
        </td>`;
      }).join("");
      return `<tr${index === currentIndex ? ' class="is-current"' : ""} data-row="${index}">
        <td class="cell-strong" style="white-space:nowrap">${esc(month.label)}</td>
        ${cells}
        <td class="right num col-sum-in" data-derived="income" data-index="${index}">${income ? money(income) : "—"}</td>
        <td class="right num col-sum-out" data-derived="expense" data-index="${index}">${expense ? money(expense) : "—"}</td>
        <td class="right num cell-strong" data-derived="profit" data-index="${index}" style="color:${profit < 0 ? "var(--minus)" : profit > 0 ? "var(--plus)" : "inherit"}">${
        income || expense ? money(profit) : "—"
      }</td>
        <td class="right">${
          // Месяц с платежами или зарплатами панель держит сама: удалённый,
          // он тут же вернулся бы. Удалять можно только пустой, добавленный руками.
          FINANCE_FIELDS.some((field) => field.auto && month[field.key])
            ? ""
            : `<span class="row-actions"><button class="icon-btn icon-btn--danger" data-delete-month="${index}" title="Удалить месяц">✕</button></span>`
        }</td>
      </tr>`;
    })
    .join("");

  const totalCells = FINANCE_FIELDS.map(
    (field) => `<td class="right num col-group-${field.group}" data-total="${field.key}">${
      totals.byIncome[field.key] || totals.byExpense[field.key] ? money(totals.byIncome[field.key] ?? totals.byExpense[field.key]) : "—"
    }</td>`
  ).join("");

  // Телефон: месяц — карточка. Статьи строками, ручные — полем справа,
  // посчитанные сами — просто суммой с пометкой «авто». Итог месяца внизу.
  const finRow = (month, index, field) => {
    const stored = month[field.key];
    const value = field.auto
      ? `<span class="fin-auto num">${stored ? esc(money(stored)) : "—"}</span>`
      : `<input class="fin-input num" type="text" inputmode="numeric" placeholder="—"
               value="${stored === null || stored === undefined ? "" : nf.format(stored)}"
               data-branch="${esc(branch.id)}" data-id="${month.id}" data-index="${index}" data-field="${field.key}" aria-label="${esc(field.label)}, ${esc(month.label)}">`;
    return `<div class="fin-row fin-row--${field.group}">
      <span class="fin-row__label">${field.auto ? `<small>авто</small>` : ""}${esc(field.label)}</span>
      ${value}
    </div>`;
  };
  const months = [...branch.months.map((month, index) => ({ month, index }))].reverse(); // свежий месяц сверху
  const mobile = months
    .map(({ month, index }) => {
      const income = monthIncome(month);
      const expense = monthExpense(month);
      const profit = income - expense;
      const deletable = !FINANCE_FIELDS.some((field) => field.auto && month[field.key]);
      return `<div class="month-card${index === currentIndex ? " is-current" : ""}">
        <div class="month-card__head">
          <h3>${esc(month.label)}</h3>
          ${deletable ? `<button class="icon-btn icon-btn--danger" type="button" data-delete-month="${index}" aria-label="Удалить месяц">✕</button>` : ""}
        </div>
        <p class="month-card__group month-card__group--in">Доходы</p>
        ${FINANCE_FIELDS.filter((f) => f.group === "in").map((f) => finRow(month, index, f)).join("")}
        <p class="month-card__group month-card__group--out">Расходы</p>
        ${FINANCE_FIELDS.filter((f) => f.group === "out").map((f) => finRow(month, index, f)).join("")}
        <div class="month-card__foot">
          <div class="summary__item"><span class="summary__label">Доход</span><span class="summary__value num" data-derived="income" data-index="${index}">${income ? money(income) : "—"}</span></div>
          <div class="summary__item"><span class="summary__label">Расход</span><span class="summary__value num" data-derived="expense" data-index="${index}">${expense ? money(expense) : "—"}</span></div>
          <div class="summary__item"><span class="summary__label">Прибыль</span><span class="summary__value num" data-derived="profit" data-index="${index}" style="color:${
            profit < 0 ? "var(--minus)" : profit > 0 ? "var(--plus)" : "inherit"
          }">${income || expense ? money(profit) : "—"}</span></div>
        </div>
      </div>`;
    })
    .join("");

  return `<section class="card" data-finance="${esc(branch.id)}">
    <div class="card__head">
      <div>
        <p class="eyebrow">${
          multiBranch() ? `<span class="branch-tag"><i style="background:${branchColor(branch.id)}"></i>${esc(branch.name)}</span>` : "По месяцам"
        }</p>
        <h2 data-finance-title>Прибыль ${money(totals.profit)}</h2>
      </div>
      <span style="display:flex;gap:8px">
        <button class="btn btn--outline btn--sm" data-add-month="${esc(branch.id)}" type="button">${ICON.plus}Месяц</button>
      </span>
    </div>
    <div class="only-mobile">${
      mobile || `<div class="empty empty--compact"><b>Месяцев пока нет</b>Появятся сами с первой оплатой или добавьте кнопкой выше.</div>`
    }</div>
    <div class="table-wrap only-desktop"><table>
      <thead><tr>
        <th>Месяц</th>
        ${FINANCE_FIELDS.map(
          (field) =>
            `<th class="right col-group-${field.group}"${field.auto ? ` title="Считается само — ${esc(field.auto)}"` : ""}>${esc(field.label)}${
              field.auto ? '<small class="th-auto">авто</small>' : ""
            }</th>`
        ).join("")}
        <th class="right">Доход</th><th class="right">Расход</th><th class="right">Прибыль</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr class="total-row">
        <td>Итого</td>
        ${totalCells}
        <td class="right num col-sum-in" data-total="income">${money(totals.income)}</td>
        <td class="right num col-sum-out" data-total="expense">${money(totals.expense)}</td>
        <td class="right num" data-total="profit" style="color:${totals.profit < 0 ? "var(--minus)" : "var(--plus)"}">${money(totals.profit)}</td>
        <td></td>
      </tr></tfoot>
    </table></div>
  </section>`;
}

function viewFinance() {
  const branches = branchesInScope();
  const totals = financeTotals(branches);
  const hint = infoBlock(
    "Что считается само",
    `<p>«Абонементы», «ЗП тренеров» и «ЗП админов» панель считает сама — по оплатам учеников и начисленным зарплатам.
      Они обновляются сразу, как только записали оплату или отметили занятие, а месяц с деньгами появляется сам.
      Аренду, рекламу, мерч и прочее вводите в полях — каждое значение сразу сохраняется.</p>`
  );
  const summary = summaryCard([
    { label: "Доход", value: moneyHtml(totals.income), cls: totals.income ? "is-plus" : "" },
    { label: "Расход", value: moneyHtml(totals.expense), cls: totals.expense ? "is-minus" : "" },
    { label: "Прибыль", value: moneyHtml(totals.profit), cls: totals.profit < 0 ? "is-minus" : "is-brand" },
  ]);
  return summary + hint + branches.map(financeCard).join("");
}

function refreshFinanceDerived(branchId) {
  const branch = STATE.data.branches.find((b) => b.id === branchId);
  const card = document.querySelector(`[data-finance="${CSS.escape(branchId)}"]`);
  if (!branch || !card) return;
  const totals = financeTotals([branch]);
  branch.months.forEach((month, index) => {
    const income = monthIncome(month);
    const expense = monthExpense(month);
    const profit = income - expense;
    // Ячейка есть и в таблице, и в мобильной карточке месяца — обновляем обе.
    const set = (kind, value, colored) => {
      card.querySelectorAll(`[data-derived="${kind}"][data-index="${index}"]`).forEach((cell) => {
        cell.textContent = income || expense ? money(value) : "—";
        if (colored) cell.style.color = profit < 0 ? "var(--minus)" : profit > 0 ? "var(--plus)" : "inherit";
      });
    };
    set("income", income);
    set("expense", expense);
    set("profit", profit, true);
  });
  FINANCE_FIELDS.forEach((field) => {
    const cell = card.querySelector(`[data-total="${field.key}"]`);
    const value = totals.byIncome[field.key] ?? totals.byExpense[field.key];
    if (cell) cell.textContent = value ? money(value) : "—";
  });
  card.querySelector('[data-total="income"]').textContent = money(totals.income);
  card.querySelector('[data-total="expense"]').textContent = money(totals.expense);
  const profitCell = card.querySelector('[data-total="profit"]');
  profitCell.textContent = money(totals.profit);
  profitCell.style.color = totals.profit < 0 ? "var(--minus)" : "var(--plus)";
  card.querySelector("[data-finance-title]").textContent = `Прибыль ${money(totals.profit)}`;
}

/* --- вид: абонементы и расписание ---------------------------------------- */

function coachName(id) {
  if (!id) return "—";
  const coach = STATE.data.coaches.find((c) => c.id === id);
  return coach ? coach.name : "—";
}

function viewSubscriptions() {
  const types = STATE.data.subscriptionTypes;
  const coaches = STATE.data.coaches;
  const editable = isOwner();
  const groups = [...STATE.data.groups].sort(
    (a, b) => Math.min(...a.weekdays, 7) - Math.min(...b.weekdays, 7) || (a.time || "").localeCompare(b.time || "")
  );
  // Администратор смотрит справочники, но не меняет их: ни цен, ни расписания.
  const rowAttr = (key, id, archived) =>
    ` class="${[editable ? "clickable" : "", archived ? "is-archived" : ""].filter(Boolean).join(" ")}"${editable ? ` data-${key}-id="${id}"` : ""}`;
  const addButton = (attr, label) => (editable ? `<button class="btn btn--outline btn--sm" type="button" ${attr}>${ICON.plus}${label}</button>` : "");
  const head = (title, button) => `<div class="card__head"><div><h2>${title}</h2></div>${button}</div>`;
  const classesLabel = (t) => (t.classes_count ? `${t.classes_count}` : "безлимит");
  const daysChips = (g) =>
    `<span class="days-chips">${WEEKDAY_SHORT.map((d, i) => `<span class="${g.weekdays.includes(i) ? "on" : ""}">${d}</span>`).join("")}</span>`;

  // --- абонементы: статус не показываем, бейдж только у архивных ---
  const typesCard = `<section class="card">
    ${head("Абонементы", addButton("data-add-type", "Тариф"))}
    ${
      types.length
        ? `<div class="list only-mobile">${types
            .map((t) =>
              listRow({
                attrs: editable ? ` data-type-id="${t.id}"` : "",
                title: `${esc(t.name)}${t.active ? "" : ` ${badge("", "в архиве")}`}`,
                sub: esc([t.classes_count ? `${t.classes_count} ${plural(t.classes_count, "занятие", "занятия", "занятий")}` : "безлимит", termLabel(t) !== "—" ? termLabel(t) : ""].filter(Boolean).join(", ")),
                side: rowMeta(t.price ? esc(money(t.price)) : "—"),
                chevron: editable,
                muted: !t.active,
              })
            )
            .join("")}</div>
      <div class="table-wrap only-desktop"><table>
        <thead><tr><th>Название</th><th class="right">Занятий</th><th>Срок</th><th class="right">Цена</th></tr></thead>
        <tbody>${types
          .map(
            (t) => `<tr${rowAttr("type", t.id, !t.active)}>
              <td><span class="cell-strong">${esc(t.name)}</span>${t.active ? "" : ` ${badge("", "в архиве")}`}</td>
              <td class="right num${t.classes_count ? "" : " muted"}">${classesLabel(t)}</td>
              <td>${esc(termLabel(t))}</td>
              <td class="right num cell-strong">${t.price ? money(t.price) : "—"}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table></div>`
        : emptyRow("Пока нет ни одного абонемента", "Добавьте тариф — он появится в карточке ученика.", "", true)
    }
  </section>`;

  // --- расписание: дни чипами, время крупно, пустой зал — пробел в данных ---
  const hallCell = (g) => (g.is_individual ? `<span class="faint">—</span>` : g.hall ? `${esc(g.hall)} зал` : badge("warning", "не указан"));
  const coachCell = (g) =>
    g.is_individual ? `<span class="muted">у каждого занятия свой</span>` : g.coach_id ? esc(coachName(g.coach_id)) : `<span class="muted">не назначен</span>`;
  const scheduleCard = `<section class="card">
    ${head("Расписание", addButton("data-add-group", "Группа"))}
    ${
      groups.length
        ? `<div class="list only-mobile">${groups
            .map((g) =>
              listRow({
                attrs: editable ? ` data-group-id="${g.id}"` : "",
                title: `${esc(g.direction)}${g.active ? "" : ` ${badge("", "в архиве")}`}`,
                sub: esc(
                  g.is_individual
                    ? "тренер у каждого занятия свой"
                    : [g.weekdays.map((w) => WEEKDAY_SHORT[w]).join(", "), g.time, g.coach_id ? coachName(g.coach_id) : "тренер не назначен"].filter(Boolean).join(", ")
                ),
                side: !g.is_individual && !g.hall ? badge("warning", "зал не указан") : "",
                chevron: editable,
                muted: !g.active,
              })
            )
            .join("")}</div>
      <div class="table-wrap only-desktop"><table>
        <thead><tr><th>Группа</th>${multiBranch() ? "<th>Филиал</th>" : ""}<th>Дни</th><th>Время</th><th>Зал</th><th>Тренер</th></tr></thead>
        <tbody>${groups
          .map(
            (g) => `<tr${rowAttr("group", g.id, !g.active)}>
              <td><span class="cell-strong">${esc(g.direction)}</span>${g.active ? "" : ` ${badge("", "в архиве")}`}</td>
              ${multiBranch() ? `<td>${esc(branchName(g.branch_id))}</td>` : ""}
              <td>${daysChips(g)}</td>
              <td class="time-cell${g.time ? "" : " faint"}">${esc(g.time || "—")}</td>
              <td>${hallCell(g)}</td>
              <td>${coachCell(g)}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table></div>`
        : emptyRow("Расписание пустое", "Добавьте группы — они появятся в «Посещаемости».", "", true)
    }
  </section>`;

  if (!editable) return typesCard + scheduleCard;

  // --- сотрудники ---
  const payLine = (c) => {
    const parts = [];
    if (c.rate) parts.push(`${money(c.rate)} / ${rateUnit(c.rate_type)}`);
    if (c.individual_share) parts.push(`индив. ${c.individual_share}%`);
    return parts.join(", ");
  };
  const coachesCard = `<section class="card">
    ${head("Сотрудники", addButton("data-add-coach", "Сотрудник"))}
    ${
      coaches.length
        ? `<div class="list only-mobile">${coaches
            .map((c) => {
              const own = groups.filter((g) => g.coach_id === c.id && !g.is_individual);
              return listRow({
                attrs: ` data-coach-id="${c.id}"`,
                lead: avatar(c.name, !c.active),
                title: `${esc(c.name)}${c.active ? "" : ` ${badge("", "в архиве")}`}`,
                sub: esc([c.role || "Тренер", payLine(c) || "ставка не задана", own.length ? `${own.length} ${plural(own.length, "группа", "группы", "групп")}` : ""].filter(Boolean).join(", ")),
                muted: !c.active,
              });
            })
            .join("")}</div>
      <div class="table-wrap only-desktop"><table>
        <thead><tr><th>Сотрудник</th><th>Должность</th><th>Оплата</th><th>Группы</th></tr></thead>
        <tbody>${coaches
          .map((c) => {
            const own = groups.filter((g) => g.coach_id === c.id && !g.is_individual);
            return `<tr${rowAttr("coach", c.id, !c.active)}>
              <td><span class="cell-who">${avatar(c.name, !c.active)}<span><span class="cell-strong">${esc(c.name)}</span><span class="cell-sub${c.phone ? "" : " is-faint"}">${esc(
              c.phone || "телефон не указан"
            )}</span></span></span></td>
              <td>${esc(c.role || "Тренер")}${c.active ? "" : ` ${badge("", "в архиве")}`}</td>
              <td class="num">${payLine(c) ? esc(payLine(c)) : `<span class="muted">не задана</span>`}</td>
              <td>${own.length ? esc(own.map((g) => g.direction).join(", ")) : `<span class="faint">—</span>`}</td>
            </tr>`;
          })
          .join("")}</tbody>
      </table></div>`
        : emptyRow("Пока нет ни одного сотрудника", "Добавьте тренеров и администраторов — по ним считается зарплата.", "", true)
    }
  </section>`;

  // --- доступ к панели ---
  const users = STATE.data.users || [];
  const accessCard = `<section class="card">
    ${head("Доступ к панели", addButton("data-add-user", "Доступ"))}
    <div class="list only-mobile">${users
      .map((u) =>
        listRow({
          attrs: ` data-user-id="${u.id}"`,
          lead: avatar(u.name, !u.active),
          title: `${esc(u.name)}${u.id === currentUser().id ? ` ${badge("brand", "это вы")}` : ""}`,
          sub: esc([u.login, u.roleTitle, u.lastLogin ? `вход ${u.lastLogin}` : "ещё не входил"].join(", ")),
          side: u.active ? "" : badge("", "отключён"),
          muted: !u.active,
        })
      )
      .join("")}</div>
    <div class="table-wrap only-desktop"><table>
      <thead><tr><th>Кто</th><th>Логин</th><th>Права</th><th>Последний вход</th></tr></thead>
      <tbody>${users
        .map(
          (u) => `<tr${rowAttr("user", u.id, !u.active)}>
            <td><span class="cell-who">${avatar(u.name, !u.active)}<span class="cell-strong">${esc(u.name)}</span>${u.id === currentUser().id ? badge("brand", "это вы") : ""}${u.active ? "" : badge("", "отключён")}</span></td>
            <td class="num">${esc(u.login)}</td>
            <td>${esc(u.roleTitle)}<span class="cell-sub">${u.role === "owner" ? "видит всё" : "без зарплат и финансов"}</span></td>
            <td class="num${u.lastLogin ? "" : " muted"}">${esc(u.lastLogin || "ещё не входил")}</td>
          </tr>`
        )
        .join("")}</tbody>
    </table></div>
    <p class="bars__note">Администратор ведёт посещаемость, учеников и оплаты. Зарплаты, финансы, справочники, удаление записей и экспорт остаются у владельца.</p>
  </section>`;

  return typesCard + scheduleCard + coachesCard + accessCard;
}

/* --- вид: посещаемость ---------------------------------------------------- */

function sessionRoster(group) {
  const branch = STATE.data.branches.find((b) => b.id === group.branch_id);
  const map = new Map();
  // У индивидуальных занятий постоянного состава нет: показываем только тех, кого отметили.
  if (!group.is_individual) {
    (branch ? branch.students : []).forEach((s) => {
      if (studentHasDirection(s, group.direction)) map.set(s.id, s);
    });
  }
  const marks = (STATE.attendanceMarks || {})[group.id] || {};
  Object.keys(marks).forEach((sid) => {
    const id = +sid;
    if (!map.has(id)) {
      const s = findStudentById(id);
      if (s) map.set(id, s);
    }
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function hallLabel(hall) {
  return hall ? `${hall} зал` : "Зал не указан";
}

/* Индивидуальное занятие: кто провёл и сколько стоило. Пока занятие не
   отмечено, выбор живёт здесь; при отметке уходит в базу вместе с ней. */
const individualKey = (groupId, studentId) => `${groupId}:${studentId}`;

function individualState(groupId, studentId) {
  const saved = ((STATE.attendanceMarks || {})[groupId] || {})[studentId] || {};
  const draft = STATE.individualDraft[individualKey(groupId, studentId)] || {};
  const student = findStudentById(studentId) || {};
  return {
    coachId: draft.coachId ?? saved.coach_id ?? student.lastIndividualCoach ?? null,
    price: draft.price ?? saved.price ?? student.lessonPrice ?? null,
  };
}

function individualControls(group, student) {
  const { coachId, price } = individualState(group.id, student.id);
  const key = individualKey(group.id, student.id);
  const coaches = STATE.data.coaches.filter((c) => c.role === "Тренер" && (c.active || c.id === coachId));
  return `<span class="attend__ind">
    <select data-ind-coach="${key}" title="Кто провёл занятие">
      <option value="">— тренер —</option>
      ${coaches
        .map((c) => `<option value="${c.id}"${c.id === coachId ? " selected" : ""}>${esc(c.name)}</option>`)
        .join("")}
    </select>
    <input type="text" inputmode="numeric" data-ind-price="${key}" title="Стоимость занятия"
           value="${price === null || price === undefined ? "" : nf.format(price)}" placeholder="цена, ₽">
  </span>`;
}

function sessionProgress(group) {
  const marks = (STATE.attendanceMarks || {})[group.id] || {};
  const roster = sessionRoster(group);
  const marked = roster.filter((s) => marks[s.id]).length;
  return { roster, marked, total: roster.length };
}

async function markAllPresent(groupId) {
  const group = STATE.data.groups.find((g) => g.id === groupId);
  if (!group) return;
  const roster = sessionRoster(group);
  const marks = STATE.attendanceMarks[groupId] || {};
  // Только неотмеченных: «Не пришёл» и «Разовое» уже кто-то проставил руками,
  // а у разового ещё и отдельная оплата записана.
  const targets = roster.filter((s) => !(marks[s.id] || {}).status);
  if (!targets.length) return;
  await Promise.all(
    targets.map((s) => act("attendance.mark", { group_id: groupId, student_id: s.id, date: STATE.attendanceDate, status: "present" }))
  );
  await loadAttendanceMarks();
  toast(`Отмечено пришедших: ${targets.length}`);
  render();
}

function attendanceSessionCard(group) {
  const marks = (STATE.attendanceMarks || {})[group.id] || {};
  const { roster, marked, total } = sessionProgress(group);
  const branch = STATE.data.branches.find((b) => b.id === group.branch_id);
  const rosterIds = new Set(roster.map((s) => s.id));
  const addable = (branch ? branch.students : []).filter((s) => !rosterIds.has(s.id));
  const expanded = STATE.attendanceExpanded.has(group.id);
  const state = classState(group, STATE.attendanceDate);

  let body = "";
  if (expanded) {
    const counts = { present: 0, absent: 0, dropin: 0 };
    roster.forEach((s) => {
      const st = (marks[s.id] || {}).status;
      if (st in counts) counts[st] += 1;
    });
    const unmarked = roster.filter((s) => !(marks[s.id] || {}).status).length;

    // «Все пришли» — главное действие: отметить всех, потом поправить исключения.
    const bar =
      roster.length && !group.is_individual
        ? `<div class="body-bar">
            ${
              unmarked
                ? `<button class="btn btn--primary btn--sm" type="button" data-mark-all="${group.id}">${ICON.check}Все пришли</button>`
                : `<span class="small muted">Все отмечены</span>`
            }
            <span class="tally">
              ${badge("success", `Пришли ${counts.present}`)}
              ${badge("danger", `Не пришли ${counts.absent}`)}
              ${badge("brand", `Разовое ${counts.dropin}`)}
            </span>
          </div>`
        : "";

    const rows = roster.length
      ? roster
          .map((s) => {
            const mark = (marks[s.id] || {}).status || "";
            const guest = !studentHasDirection(s, group.direction);
            const type = subscriptionType(s);
            const plan = type ? (isUnlimited(type) ? "Безлимит" : `${type.classes_count} ${plural(type.classes_count, "занятие", "занятия", "занятий")}, осталось ${s.remaining ?? "—"}`) : "Без абонемента";
            const until = s.until && type && isUnlimited(type) ? `, до ${fmtDate(s.until).slice(0, 5)}` : "";
            const attention = attentionOf(s);
            const soon =
              attention && attention.cls === "warning" ? badge("warning", attention.text.startsWith("истекает") ? "скоро истекает" : attention.text) : attention ? badge(attention.cls, attention.text) : "";
            return `<div class="attend__row" data-v="${mark}">
              <span class="attend__who">
                <b>${esc(s.name)}</b>
                <span>${esc(plan + until)}${guest ? " · гость" : ""}${soon}</span>
              </span>
              ${group.is_individual ? individualControls(group, s) : ""}
              <span class="attend__toggle" role="group" aria-label="Отметка: ${esc(s.name)}">
                <button type="button" class="seg-btn${mark === "present" ? " is-present" : ""}" aria-pressed="${mark === "present"}" data-mark="present" data-group="${group.id}" data-student="${s.id}">Пришёл</button>
                <button type="button" class="seg-btn${mark === "absent" ? " is-absent" : ""}" aria-pressed="${mark === "absent"}" data-mark="absent" data-group="${group.id}" data-student="${s.id}">Не пришёл</button>
                ${
                  group.is_individual
                    ? ""
                    : `<button type="button" class="seg-btn${mark === "dropin" ? " is-dropin" : ""}" aria-pressed="${mark === "dropin"}" data-mark="dropin" data-group="${group.id}" data-student="${s.id}" title="Пришёл разово, не по абонементу — оплата запишется сразу">Разовое</button>`
                }
              </span>
            </div>`;
          })
          .join("")
      : `<p class="attend__empty">${
          group.is_individual
            ? "Занятий пока нет. Выберите ученика ниже — запишем занятие."
            : `В базе нет учеников с направлением «${esc(group.direction)}» — добавьте вручную ниже.`
        }</p>`;

    const addControl = addable.length
      ? `<div class="attend__add-wrap"><select class="attend__add" data-add-student="${group.id}" aria-label="Добавить ученика в занятие">
          <option value="">+ Добавить ученика в занятие</option>
          ${addable.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}
        </select></div>`
      : "";

    body = `<div class="attend">${bar}${rows}${addControl}</div>`;
  }

  // Слева — время крупно: по нему ищут занятие глазами.
  const meta = group.is_individual
    ? `${hallLabel(group.hall)}, тренер у каждого занятия свой`
    : [group.hall ? `${group.hall} зал` : "Зал не указан", group.coach_id ? coachName(group.coach_id) : "тренер не назначен"].join(", ");
  const branchNote = STATE.branch === "all" && multiBranch() ? `${branchName(group.branch_id)}, ` : "";
  const tag = state === "now" ? badge("brand", "идёт сейчас") : group.is_individual ? badge("", "весь день") : "";
  const side = total
    ? `<span class="progress${marked === total ? " is-done" : ""}"><span style="width:${Math.round((marked / total) * 100)}%"></span></span>
       <span class="session__count${marked === total ? " is-done" : ""}">${marked}/${total}</span>`
    : `<span class="caption muted">${group.is_individual ? "нет записей" : "нет учеников"}</span>`;

  return `<section class="card session${expanded ? " is-expanded" : ""}${state === "now" ? " is-now" : ""}" data-group-card="${group.id}">
    <div class="session__head" data-toggle-group="${group.id}" role="button" aria-expanded="${expanded}">
      <span class="session__time${group.time ? "" : " dim"}">${esc(group.time || "—")}</span>
      <span class="session__main">
        <span class="session__title"><b>${esc(group.direction)}</b>${tag}</span>
        <span class="session__sub">${esc(branchNote + meta)}</span>
      </span>
      <span class="session__side">${side}<span class="attend__chevron" aria-hidden="true"></span></span>
    </div>
    ${body}
  </section>`;
}

/* Быстрая запись индивидуального занятия: тренер и ученик договорились сами,
   без места в расписании — просто выбираем, кто с кем и почём, отмечаем. */
function openIndividualLessonModal() {
  const branches = branchesInScope();
  const defaultBranch = STATE.branch !== "all" ? STATE.branch : branches[0].id;
  const studentsOf = (branchId) =>
    [...(STATE.data.branches.find((b) => b.id === branchId)?.students || [])].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const coaches = STATE.data.coaches.filter((c) => c.role === "Тренер" && c.active);

  const renderOptions = (branchId) => {
    const students = studentsOf(branchId);
    return students.length
      ? students.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")
      : `<option value="">— ${multiBranch() ? "в этом филиале " : ""}пока нет учеников —</option>`;
  };

  openModal(
    `<form class="modal modal--narrow" id="individualForm">
      <div class="modal__head">
        <div><p class="eyebrow">Посещаемость</p><h2>Индивидуальное занятие</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        ${
          branches.length > 1
            ? `<label class="field span-2"><span>Филиал</span><select name="branch">${branches
                .map((b) => `<option value="${esc(b.id)}"${b.id === defaultBranch ? " selected" : ""}>${esc(b.name)}</option>`)
                .join("")}</select></label>`
            : `<input type="hidden" name="branch" value="${esc(defaultBranch)}">`
        }
        <label class="field span-2"><span>Ученик</span><select name="student_id" id="indStudentSelect">${renderOptions(defaultBranch)}</select></label>
        <label class="field"><span>Тренер</span><select name="coach_id">
          <option value="">— тренер —</option>
          ${coaches.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
        </select></label>
        <label class="field"><span>Цена занятия, ₽</span><input name="price" type="text" inputmode="numeric" placeholder="1500"></label>
        <p class="field-note span-2">Дата занятия — ${esc(fmtDate(STATE.attendanceDate))} (как в посещаемости выше). Занятие сразу отметится «Пришёл», а сумма попадёт в доход.</p>
      </div>
      <div class="modal__foot">
        <span class="modal__foot-right">
          <button class="btn" type="button" data-close>Отмена</button>
          <button class="btn btn--primary" type="submit">Отметить</button>
        </span>
      </div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));

      const applyDefaults = (studentId) => {
        const student = findStudentById(+studentId);
        const priceInput = form.querySelector('[name="price"]');
        const coachSelect = form.querySelector('[name="coach_id"]');
        if (student?.lessonPrice) priceInput.value = nf.format(student.lessonPrice);
        if (student?.lastIndividualCoach) coachSelect.value = student.lastIndividualCoach;
      };

      const branchSelect = form.querySelector('[name="branch"]');
      const studentSelect = form.querySelector("#indStudentSelect");
      branchSelect?.addEventListener("change", () => {
        studentSelect.innerHTML = renderOptions(branchSelect.value);
        applyDefaults(studentSelect.value);
      });
      studentSelect.addEventListener("change", () => applyDefaults(studentSelect.value));
      applyDefaults(studentSelect.value);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const branchId = data.branch;
        const studentId = +data.student_id;
        const coachId = data.coach_id ? +data.coach_id : null;
        const price = num(data.price);
        if (!studentId) {
          toast("Выберите ученика", "error");
          return;
        }
        if (!coachId) {
          toast("Выберите тренера, который провёл занятие", "error");
          return;
        }
        const group = STATE.data.groups.find((g) => g.is_individual && g.branch_id === branchId);
        if (!group) {
          toast("Не нашлось группы «Индивидуальные» — обратитесь к владельцу панели", "error");
          return;
        }
        closeModal();
        STATE.individualDraft[individualKey(group.id, studentId)] = { coachId, price };
        const ok = await act("attendance.mark", {
          group_id: group.id,
          student_id: studentId,
          date: STATE.attendanceDate,
          status: "present",
          coach_id: coachId,
          lesson_price: price,
        });
        if (ok) {
          await recordIndividualPayment(studentId, group, coachId, price);
          STATE.attendanceExtra.add(group.id);
          STATE.attendanceExpanded.add(group.id);
          await loadAttendanceMarks();
          render();
        }
      });
    }
  );
}

/* Какие занятия показать на выбранный день: по расписанию, уже отмеченные
   и добавленные «вне расписания». Остальные — в списке «Вне расписания». */
function attendanceGroups() {
  const date = STATE.attendanceDate;
  const weekday = isoWeekday(date);
  const branchIds = new Set(branchesInScope().map((b) => b.id));
  const allGroups = STATE.data.groups.filter((g) => g.active && branchIds.has(g.branch_id));
  const marks = STATE.attendanceMarks || {};
  const shown = allGroups.filter(
    (g) => g.weekdays.includes(weekday) || Object.keys(marks[g.id] || {}).length > 0 || STATE.attendanceExtra.has(g.id)
  );
  return { allGroups, shown, hidden: allGroups.filter((g) => !shown.includes(g)) };
}

// Второстепенные действия раздела — outline-кнопки (в шапке на широком экране).
function attendanceActions() {
  const { hidden } = attendanceGroups();
  return `<button class="btn btn--outline" type="button" data-add-individual>${ICON.plus}Индивидуальное</button>
    ${
      hidden.length
        ? `<select class="select-outline" data-extra-group aria-label="Занятие вне расписания">
            <option value="">+ Вне расписания</option>
            ${hidden
              .map((g) => `<option value="${g.id}">${esc(g.direction)}${multiBranch() ? " · " + esc(branchName(g.branch_id)) : ""}${g.time ? " · " + esc(g.time) : ""}</option>`)
              .join("")}
          </select>`
        : ""
    }`;
}

function viewAttendance() {
  const date = STATE.attendanceDate;
  const weekday = isoWeekday(date);
  const isToday = date === isoToday();
  const { allGroups, shown } = attendanceGroups();

  // Идущее сейчас занятие раскрыто сразу — один раз за день, дальше решает человек.
  STATE.attendanceAutoOpened = STATE.attendanceAutoOpened || new Set();
  if (isToday && !STATE.attendanceAutoOpened.has(date)) {
    shown.filter((g) => classState(g, date) === "now").forEach((g) => STATE.attendanceExpanded.add(g.id));
    STATE.attendanceAutoOpened.add(date);
  }

  const dayProgress = shown.reduce(
    (acc, g) => {
      const p = sessionProgress(g);
      acc.marked += p.marked;
      acc.total += p.total;
      return acc;
    },
    { marked: 0, total: 0 }
  );
  const share = dayProgress.total ? Math.round((dayProgress.marked / dayProgress.total) * 100) : 0;
  const parts = isoParts(date);

  // Дата: «‹ [Среда, 23 сентября] ›». Нажатие на дату — системный календарь
  // (поле лежит поверх подписи невидимым). Справа — прогресс отметок дня.
  const toolbar = `<div class="day-toolbar">
      <button class="icon-btn" data-shift-day="-1" type="button" aria-label="Предыдущий день">${ICON.left}</button>
      <label class="date-btn">${ICON.calendar}<span>${esc(`${STATE.data.weekdays[weekday]}, ${parts ? parts.d + " " + MONTHS_GEN[parts.m - 1] : ""}`)}</span>
        <input type="date" id="attendDate" value="${esc(date)}" aria-label="Выбрать дату"></label>
      <button class="icon-btn" data-shift-day="1" type="button" aria-label="Следующий день">${ICON.right}</button>
      ${isToday ? "" : `<button class="btn btn--sm" data-shift-day="0" type="button">Сегодня</button>`}
      ${
        dayProgress.total
          ? `<div class="day-progress">Отмечено <b>${dayProgress.marked}</b> из ${dayProgress.total}
              <span class="progress${share === 100 ? " is-done" : ""}"><span style="width:${share}%"></span></span></div>`
          : ""
      }
    </div>
    <div class="day-actions only-mobile">${attendanceActions()}</div>`;

  if (!shown.length) {
    return `${toolbar}<section class="card">${emptyRow(
      "На этот день групп нет",
      allGroups.length ? "Выберите занятие в «Вне расписания» или загляните в «Справочники»." : "Сначала добавьте группы в «Справочниках».",
      "",
      true
    )}</section>`;
  }

  // Индивидуальные — в начале (их время — «весь день»), дальше по времени.
  const sorted = [...shown].sort((a, b) => (a.is_individual ? -1 : b.is_individual ? 1 : (a.time || "99").localeCompare(b.time || "99")));
  return `${toolbar}<div class="sessions">${sorted.map(attendanceSessionCard).join("")}</div>`;
}

/* --- вид: зарплаты ------------------------------------------------------- */

/* Столбец «Индивидуальные»: сколько занятий и сколько за них вышло. */
function individualCell(row) {
  if (!row.individualLessons) return "—";
  if (!row.individual_share) {
    return `<span style="color:var(--warn)">${row.individualLessons} зан.<span class="cell-sub">процент не задан</span></span>`;
  }
  return `${money(row.individualPay)}<span class="cell-sub">${row.individualLessons} зан. · ${row.individual_share}%</span>`;
}

/* Подпись под именем: где человек заработал эти деньги. При одном филиале
   ответ очевиден, а сами числа уже есть в столбцах «Занятий»/«Посещений». */
function salaryBranchNote(row) {
  if (!multiBranch()) return "";
  const load = row.rate_type === "per_student" ? row.visitsByBranch : row.sessionsByBranch;
  const parts = Object.entries(load || {})
    .filter(([, n]) => n)
    .map(([b, n]) => `${branchName(b)}: ${n}`);
  Object.entries(row.individualByBranch || {})
    .filter(([, n]) => n)
    .forEach(([b, n]) => parts.push(`${branchName(b)}: ${n} индив.`));
  return parts.length ? `<span class="cell-sub">${esc(parts.join(" · "))}</span>` : "";
}

function viewSalaries() {
  const data = STATE.salaries;
  if (!data) return `<div class="card"><div class="empty">Загружаю…</div></div>`;

  const rows = data.rows;
  const coaches = rows.filter((r) => r.role === "Тренер");
  const admins = rows.filter((r) => r.role !== "Тренер");
  const unpaid = data.total - data.totalPaid;

  const now = new Date();
  const isCurrent = STATE.salaryYear === now.getFullYear() && STATE.salaryMonth === now.getMonth() + 1;
  const nav = `<div class="day-toolbar">
      <button class="icon-btn" data-salary-shift="-1" type="button" aria-label="Предыдущий месяц">${ICON.left}</button>
      <span class="date-btn">${ICON.calendar}<span>${esc(data.label)}</span></span>
      <button class="icon-btn" data-salary-shift="1" type="button" aria-label="Следующий месяц">${ICON.right}</button>
      ${isCurrent ? "" : `<button class="btn btn--sm" data-salary-shift="0" type="button">Текущий месяц</button>`}
    </div>`;

  if (!rows.length) {
    return `${nav}<section class="card">${emptyRow("Нет сотрудников", "Добавьте их в «Справочниках» — зарплата посчитается сама.", "", true)}</section>`;
  }

  const kpi = summaryCard([
    { label: "Начислено", value: moneyHtml(data.total) },
    { label: "Выплачено", value: moneyHtml(data.totalPaid), cls: data.totalPaid ? "is-plus" : "" },
    { label: "Осталось", value: moneyHtml(unpaid), cls: unpaid > 0 ? "is-minus" : "" },
  ]);

  // Телефон: сотрудник — строка «ставка и нагрузка», справа сумма и выплачено ли.
  const load = (r) => {
    if (r.rate_type === "monthly") return r.rate ? `оклад ${money(r.rate)}` : "оклад не задан";
    const rate = r.rate ? `${money(r.rate)}/${rateUnitShort(r.rate_type)}` : "ставка не задана";
    const amount = r.rate_type === "per_student" ? `${r.visits} ${plural(r.visits, "посещение", "посещения", "посещений")}` : `${r.sessions} ${plural(r.sessions, "занятие", "занятия", "занятий")}`;
    const ind = r.individualLessons ? `, ${r.individualLessons} индив.` : "";
    return `${rate}, ${amount}${ind}`;
  };
  const mobileList = (list) =>
    list
      .map((r) =>
        listRow({
          attrs: ` data-salary-id="${r.id}"`,
          lead: avatar(r.name),
          title: esc(r.name),
          sub: esc(load(r)),
          side: rowMeta(esc(money(r.total)), r.paid ? "выплачено" : r.total ? "не выплачено" : "", r.paid ? "is-plus" : "is-warn"),
        })
      )
      .join("");

  const table = (title, list) =>
    list.length
      ? `<section class="card">
      <div class="card__head"><div><p class="eyebrow">${esc(title)}</p><h2>${money(
          list.reduce((s, r) => s + r.total, 0)
        )} за месяц</h2></div></div>
      <div class="list only-mobile">${mobileList(list)}</div>
      <div class="table-wrap only-desktop"><table>
        <thead><tr>
          <th>Сотрудник</th><th class="right">Занятий</th><th class="right">Посещений</th><th class="right">Ставка</th>
          <th class="right">Индивидуальные</th><th class="right">Начислено</th><th class="right">Премия</th>
          <th class="right">Итого</th><th>Выплата</th><th></th>
        </tr></thead>
        <tbody>${list
          .map(
            (r) => `<tr class="clickable" data-salary-id="${r.id}">
          <td>
            <span class="cell-strong">${esc(r.name)}</span>
            ${salaryBranchNote(r)}
          </td>
          <td class="right num">${r.rate_type === "monthly" ? "—" : r.sessions}</td>
          <td class="right num">${r.rate_type === "monthly" ? "—" : r.visits}</td>
          <td class="right num">${r.rate ? `${money(r.rate)}/${rateUnitShort(r.rate_type)}` : "—"}</td>
          <td class="right num">${individualCell(r)}</td>
          <td class="right num">${r.override !== null && r.override !== undefined ? `${money(r.override)}<span class="cell-sub">вручную</span>` : money(r.computed)}</td>
          <td class="right num">${r.bonus ? money(r.bonus) : "—"}</td>
          <td class="right num cell-strong">${money(r.total)}</td>
          <td>${r.paid ? badge("success", "выплачено") : r.total ? badge("warning", "не выплачено") : ""}</td>
          <td class="right"><span class="row-actions"><button class="icon-btn" title="Изменить">✎</button></span></td>
        </tr>`
          )
          .join("")}</tbody>
      </table></div>
    </section>`
      : "";

  const missing = coaches.filter((r) => r.individualLessons && !r.individual_share);
  const warn = missing.length
    ? `<div class="banner"><span>Не задан процент за индивидуальные занятия: <b>${missing
        .map((r) => esc(r.name))
        .join(", ")}</b> — проведённые занятия пока не оплачиваются. Укажите процент в «Справочники» → «Сотрудники».</span></div>`
    : "";

  const hint = infoBlock(
    "Как считается зарплата",
    `<ul>
      <li>Ставка за ученика — ставка × число отметок «Пришёл». Пропуски не оплачиваются.</li>
      <li>Ставка за занятие — ставка × проведённые занятия.</li>
      <li>Оклад начисляется целиком за прошедший и текущий месяц.</li>
      <li>Индивидуальные занятия считаются отдельно: тренер получает свой процент от стоимости каждого.</li>
      <li>Нажмите на сотрудника, чтобы поставить премию, задать сумму вручную или отметить выплату.</li>
    </ul>`
  );

  return nav + kpi + warn + hint + table("Тренеры", coaches) + table("Администраторы", admins);
}

/* --- модальные окна ----------------------------------------------------- */

const overlay = document.getElementById("overlay");

/* Окно на широком экране и «шторка» на телефоне — одно и то же окно, просто
   с разными повадками. Появление и уход ведёт ios.js пружиной: шторку можно
   стянуть пальцем, отпустить на полпути и она вернётся, продолжив движение
   руки, а не начав новую анимацию с нуля. */

function closeModal(velocity) {
  UI.dismiss(
    overlay,
    () => {
      overlay.hidden = true;
      overlay.innerHTML = "";
    },
    { velocity: typeof velocity === "number" ? velocity : undefined }
  );
}

function openModal(html, onMount) {
  // Поверх уезжающего окна открывают новое (подтверждения) — доводить старое
  // до конца незачем, иначе его «уборка» сотрёт только что открытое.
  UI.cancelDismiss(overlay);
  overlay.innerHTML = html;
  overlay.hidden = false;
  overlay.querySelector("[data-close]")?.addEventListener("click", () => closeModal());
  if (onMount) onMount(overlay.firstElementChild);
  UI.present(overlay, { onClose: (velocity) => closeModal(velocity) });
  // На телефоне фокус в поле сразу поднимает клавиатуру и закрывает половину
  // шторки, пока та ещё едет. Поле человек выберет сам.
  if (!UI.isPhone()) overlay.querySelector("input, select, textarea")?.focus();
}

overlay.addEventListener("mousedown", (event) => {
  if (event.target === overlay) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !overlay.hidden) closeModal();
  if (event.key === "/" && overlay.hidden && document.activeElement === document.body) {
    const search = document.getElementById("searchInput");
    if (search) {
      event.preventDefault();
      search.focus();
    }
  }
});

const datalist = (id, values) =>
  `<datalist id="${id}">${[...new Set(values.filter(Boolean))].sort().map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist>`;

function subscriptionTypeOptions(selectedId) {
  const options = STATE.data.subscriptionTypes
    .map(
      (t) =>
        `<option value="${t.id}"${String(t.id) === String(selectedId || "") ? " selected" : ""}>${esc(t.name)}${
          t.classes_count ? ` (${t.classes_count})` : " (безлимит)"
        }${t.active ? "" : " · скрыт"}</option>`
    )
    .join("");
  return `<option value="">— не выбран —</option>${options}`;
}

function studentPayments(studentId) {
  return (STATE.data.payments || []).filter((p) => p.student_id === studentId);
}

function subscriptionTypeName(id) {
  const type = (STATE.data.subscriptionTypes || []).find((t) => t.id === id);
  return type ? type.name : null;
}

/* Платёж сам по себе группу не хранит — «Разовое» и «Индивидуальное» из
   посещаемости кладут её в примечание, а для обычной покупки абонемента
   группа — это просто текущие направления ученика. */
function paymentGroupLabel(payment, student) {
  if (payment.note?.startsWith("Разовое") && payment.note.includes(" · ")) {
    return payment.note.split(" · ")[1];
  }
  if (payment.note?.startsWith("Индивидуальное")) {
    return "Индивидуальные";
  }
  return studentDirectionLabel(student) || "—";
}

function openStudentModal(id) {
  const editing = id !== null && id !== undefined;
  const student = editing
    ? findStudentById(id)
    : {
        name: "",
        phone: "",
        direction: "",
        directions: [],
        start: "",
        subscription_type_id: null,
        price: null,
        cycle_start: "",
        until: "",
        status: "Активен",
        source: "",
        note: "",
      };
  const everyone = STATE.data.branches.flatMap((b) => b.students);
  const defaultBranch = editing ? student._branch || student.branch_id : STATE.branch !== "all" ? STATE.branch : STATE.data.branches[0].id;
  const currentDirections = studentDirections(student);
  // Список направлений — из реальных групп: только они что-то значат для
  // посещаемости. Направление, которого уже нет в расписании (группу
  // переименовали или удалили), не теряем — дописываем отдельной строкой.
  const scheduleDirections = [...new Set(STATE.data.groups.filter((g) => !g.is_individual).map((g) => g.direction))].sort((a, b) =>
    a.localeCompare(b, "ru")
  );
  const orphanDirections = currentDirections.filter(
    (d) => !scheduleDirections.some((sd) => sd.toLowerCase() === d.toLowerCase())
  );

  openModal(
    `<form class="modal" id="studentForm">
      <div class="modal__head">
        <div>
          <p class="eyebrow">${editing ? "Карточка ученика" : "Новая запись"}</p>
          <h2>${editing ? esc(student.name) : "Добавить ученика"}</h2>
        </div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        ${
          editing && renewalPlan(student)
            ? `<div class="field span-2 renew-row" data-renew-row>
                <span class="renew-row__text" data-renew-text>${esc(renewalStatus(student))}</span>
                <button class="btn btn--sm btn--primary" type="button" data-renew>Продлить</button>
              </div>`
            : ""
        }
        <label class="field span-2"><span>ФИО</span><input name="name" type="text" required value="${esc(student.name)}" placeholder="Иванова Анна Сергеевна"></label>
        <label class="field${multiBranch() ? "" : " span-2"}"><span>Телефон</span><input name="phone" type="text" value="${esc(student.phone)}" placeholder="+7 900 000-00-00"></label>
        ${branchField("branch", defaultBranch)}
        <div class="field span-2"><span>Направления</span>
          <details class="direction-picker" id="directionPicker">
            <summary class="direction-picker__summary">${
              currentDirections.length ? esc(currentDirections.join(", ")) : "Выбрать направления"
            }</summary>
            <div class="direction-picker__list">
              ${
                scheduleDirections.length || orphanDirections.length
                  ? [...scheduleDirections, ...orphanDirections]
                      .map(
                        (d) => `<label>
                  <input type="checkbox" data-direction-option value="${esc(d)}"${
                          currentDirections.some((cd) => cd.toLowerCase() === d.toLowerCase()) ? " checked" : ""
                        }>
                  ${esc(d)}${orphanDirections.includes(d) ? ` <small>— нет в расписании</small>` : ""}
                </label>`
                      )
                      .join("")
                  : `<span class="check-list__empty">Сначала добавьте группы в «Справочники» → «Расписание»</span>`
              }
            </div>
          </details>
        </div>
        <label class="field"><span>Дата начала занятий</span><input name="start" type="date" value="${esc(student.start || "")}"></label>
        <label class="field"><span>Вид абонемента</span><select name="subscription_type_id">${subscriptionTypeOptions(student.subscription_type_id)}</select></label>
        <label class="field"><span>Стоимость, ₽</span><input name="price" type="text" inputmode="numeric" value="${
          student.price === null || student.price === undefined ? "" : nf.format(student.price)
        }" placeholder="4 500"></label>
        <div class="field"><span>Начало абонемента</span>
          <span class="inline-group">
            <input name="cycle_start" type="date" value="${esc(student.cycle_start || "")}" aria-label="Начало абонемента">
            <button class="btn" type="button" data-today-cycle>Сегодня</button>
          </span>
        </div>
        <label class="field"><span>Действует до</span><input name="until" type="date" value="${esc(student.until || "")}"></label>
        <label class="field"><span>Статус</span><select name="status">${STATE.data.statuses
          .map((s) => `<option value="${esc(s)}"${s === student.status ? " selected" : ""}>${esc(s)}</option>`)
          .join("")}</select></label>
        ${
          editing && student.subscription_type_id
            ? (() => {
                const r = student.remaining;
                const severity = r === null || r === undefined ? "" : r <= 0 ? " remaining-banner--danger" : r <= 2 ? " remaining-banner--warn" : "";
                return `<div class="field span-2 remaining-banner${severity}">
                  <span>Осталось занятий сейчас</span>
                  <b>${esc(remainingLabel(student))}</b>
                </div>`;
              })()
            : ""
        }
        ${
          editing && studentPayments(id).length
            ? `<div class="field span-2"><span>Платежи и абонементы</span>
                <div class="pay-table">
                  <div class="pay-table__row pay-table__row--head">
                    <span>Дата</span><span>Группа</span><span>Абонемент</span><span></span>
                  </div>
                  ${studentPayments(id)
                    .map((p) => {
                      const planName = subscriptionTypeName(p.subscription_type_id);
                      return `<div class="pay-table__row">
                        <span>${esc(fmtDate(p.payment_date))}</span>
                        <span title="${esc(paymentGroupLabel(p, student))}">${esc(paymentGroupLabel(p, student))}</span>
                        <span class="pay-table__plan" title="${esc(planName || p.note || "")}">${
                        planName ? `<small>${esc(planName)}</small>` : ""
                      }<b>${money(p.amount)}</b></span>
                        <span>${isOwner() ? `<button class="icon-btn icon-btn--danger" type="button" data-del-payment="${p.id}" title="Удалить платёж">✕</button>` : ""}</span>
                      </div>`;
                    })
                    .join("")}
                </div>
              </div>`
            : ""
        }
        <label class="field span-2"><span>Рекламный источник</span><select name="source">
          <option value=""${!student.source ? " selected" : ""}>Не указан</option>
          ${SOURCE_OPTIONS.map((s) => `<option value="${esc(s)}"${student.source === s ? " selected" : ""}>${esc(s)}</option>`).join("")}
          ${
            student.source && !SOURCE_OPTIONS.includes(student.source)
              ? `<option value="${esc(student.source)}" selected>${esc(student.source)}</option>`
              : ""
          }
        </select></label>
        <label class="field span-2"><span>Примечание</span><textarea name="note" placeholder="Что важно помнить об этом ученике">${esc(student.note)}</textarea></label>
      </div>
      <div class="modal__foot">
        ${editing && isOwner() ? '<button class="btn btn--danger" type="button" data-delete-student>Удалить</button>' : ""}
        <span class="modal__foot-right">
          <button class="btn" type="button" data-close>Отмена</button>
          <button class="btn btn--primary" type="submit">${editing ? "Сохранить" : "Добавить"}</button>
        </span>
      </div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      form.querySelector("[data-delete-student]")?.addEventListener("click", () => confirmDeleteStudent(id));

      form.querySelectorAll("[data-del-payment]").forEach((button) =>
        button.addEventListener("click", async () => {
          closeModal();
          if (await act("payment.delete", { id: +button.dataset.delPayment }, "Платёж удалён")) {
            render();
            openStudentModal(id);
          }
        })
      );

      const directionSummary = form.querySelector(".direction-picker__summary");
      form.querySelectorAll("[data-direction-option]").forEach((checkbox) =>
        checkbox.addEventListener("change", () => {
          const chosen = [...form.querySelectorAll("[data-direction-option]:checked")].map((el) => el.value);
          directionSummary.textContent = chosen.length ? chosen.join(", ") : "Выбрать направления";
        })
      );

      const typeSelect = form.querySelector('[name="subscription_type_id"]');
      const cycleInput = form.querySelector('[name="cycle_start"]');
      const untilInput = form.querySelector('[name="until"]');
      const priceInput = form.querySelector('[name="price"]');
      // «Действует до» следует за началом абонемента: поменяли начало или
      // вид — дата окончания пересчиталась. Раньше она оставалась прежней,
      // если поле уже было заполнено, и получался абонемент «с 15.10 по 15.10».
      // Поправить окончание руками можно и после — это пересчёт не отменит,
      // пока снова не тронули начало или вид.
      const suggestUntil = () => {
        const type = STATE.data.subscriptionTypes.find((t) => String(t.id) === typeSelect.value);
        const end = termEndIso(cycleInput.value, type);
        if (end) untilInput.value = end;
      };
      typeSelect.addEventListener("change", () => {
        const type = STATE.data.subscriptionTypes.find((t) => String(t.id) === typeSelect.value);
        // Смена вида абонемента — явное действие: подставляем его цену, даже
        // если в поле уже стояла сумма от прежнего абонемента.
        if (type && type.price) priceInput.value = nf.format(type.price);
        suggestUntil();
      });
      cycleInput.addEventListener("change", suggestUntil);
      form.querySelector("[data-today-cycle]").addEventListener("click", () => {
        cycleInput.value = isoToday();
        suggestUntil();
      });

      // «Продлить» только заполняет поля и показывает, что будет. Записывает
      // «Сохранить»: это деньги, и одно случайное касание не должно их
      // провести. Считаем всегда от исходной карточки, поэтому повторное
      // нажатие ничего не сдвигает дальше.
      form.querySelector("[data-renew]")?.addEventListener("click", (event) => {
        const plan = renewalPlan(student);
        if (!plan) return;
        typeSelect.value = String(plan.type.id);
        cycleInput.value = plan.start;
        untilInput.value = plan.until;
        if (plan.price) priceInput.value = nf.format(plan.price);
        const statusSelect = form.querySelector('[name="status"]');
        if (statusSelect) statusSelect.value = "Продлил";

        const row = form.querySelector("[data-renew-row]");
        row.classList.add("is-ready");
        form.querySelector("[data-renew-text]").textContent =
          `Новый абонемент: ${fmtDate(plan.start)} — ${plan.until ? fmtDate(plan.until) : "срок укажите сами"}` +
          (plan.price ? ` · оплата ${money(plan.price)}` : " · укажите стоимость");
        event.currentTarget.hidden = true;
        const submit = form.querySelector('button[type="submit"]');
        submit.textContent = plan.price ? `Продлить · ${money(plan.price)}` : "Продлить";
        UI.haptic(8);
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const directions = [...form.querySelectorAll("[data-direction-option]:checked")].map((el) => el.value);
        const payload = {
          name: data.name.trim(),
          phone: data.phone.trim(),
          direction: directions[0] || "",
          directions,
          start: data.start,
          subscription_type_id: data.subscription_type_id ? +data.subscription_type_id : null,
          price: num(data.price),
          cycle_start: data.cycle_start,
          until: data.until,
          status: data.status,
          source: data.source.trim(),
          note: data.note.trim(),
        };
        if (!payload.name) return;
        // Оплата пишется сама, когда ученику реально присвоили абонемент —
        // то есть при создании, при смене вида абонемента или при новом
        // цикле (дата начала абонемента изменилась). Правка одной только
        // цены без смены вида/даты — это исправление записи, не новая продажа.
        const isNewAssignment =
          Boolean(payload.subscription_type_id) &&
          Boolean(payload.price) &&
          (!editing ||
            payload.subscription_type_id !== student.subscription_type_id ||
            payload.cycle_start !== (student.cycle_start || ""));
        closeModal();
        const ok = editing
          ? await act("student.update", { id, target: data.branch, student: payload }, "Изменения сохранены")
          : await act("student.create", { branch: data.branch, student: payload }, "Ученик добавлен");
        if (ok && isNewAssignment) {
          const target = editing
            ? id
            : (STATE.data.branches.find((b) => b.id === data.branch).students.find((s) => s.name === payload.name) || {}).id;
          if (target) {
            await act(
              "payment.create",
              {
                student_id: target,
                amount: payload.price,
                payment_date: payload.cycle_start || isoToday(),
                subscription_type_id: payload.subscription_type_id,
              },
              `Оплата ${money(payload.price)} записана`
            );
          }
        }
        if (ok) render();
      });
    }
  );
}

function confirmDeleteStudent(id) {
  const student = findStudentById(id);
  openModal(
    `<div class="modal confirm">
      <div class="modal__head"><div><p class="eyebrow">Удаление</p><h2>Удалить ученика?</h2></div></div>
      <div class="modal__body">Запись «${esc(student.name)}» будет удалена из базы. Историю посещений этого ученика тоже удалим.</div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--danger" type="button" data-confirm>Удалить</button>
      </span></div>
    </div>`,
    (modal) => {
      modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      modal.querySelector("[data-confirm]").addEventListener("click", async () => {
        closeModal();
        if (await act("student.delete", { id }, "Ученик удалён")) render();
      });
    }
  );
}

function confirmDeleteMonth(branchId, index) {
  const branch = STATE.data.branches.find((b) => b.id === branchId);
  const month = branch.months[index];
  openModal(
    `<div class="modal confirm">
      <div class="modal__head"><div><p class="eyebrow">Удаление</p><h2>Удалить месяц?</h2></div></div>
      <div class="modal__body">Строка «${esc(month.label)}» и все внесённые в неё суммы удалятся${multiBranch() ? ` из филиала «${esc(branch.name)}»` : ""}.</div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--danger" type="button" data-confirm>Удалить</button>
      </span></div>
    </div>`,
    (modal) => {
      modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      modal.querySelector("[data-confirm]").addEventListener("click", async () => {
        closeModal();
        if (await act("finance.delete_month", { branch: branchId, id: month.id }, "Месяц удалён")) render();
      });
    }
  );
}

function openSubtypeModal(id) {
  const editing = id !== null && id !== undefined;
  const type = editing
    ? STATE.data.subscriptionTypes.find((t) => t.id === id)
    : { name: "", classes_count: "", validity_days: null, validity_months: 1, price: null, active: 1 };
  const termUnit = type.validity_months ? "months" : "days";
  const termValue = type.validity_months ?? type.validity_days ?? "";
  openModal(
    `<form class="modal" id="subtypeForm">
      <div class="modal__head">
        <div><p class="eyebrow">${editing ? "Вид абонемента" : "Новый вид абонемента"}</p><h2>${editing ? esc(type.name) : "Добавить"}</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        <label class="field span-2"><span>Название</span><input name="name" type="text" required value="${esc(type.name)}" placeholder="8 занятий"></label>
        <label class="field"><span>Занятий (пусто — безлимит)</span><input name="classes_count" type="text" inputmode="numeric" value="${type.classes_count ?? ""}" placeholder="8"></label>
        <label class="field"><span>Срок действия</span>
          <span class="inline-group">
            <input name="term" type="text" inputmode="numeric" value="${esc(termValue)}" placeholder="1">
            <select name="term_unit" class="inline-group__unit">
              <option value="months"${termUnit === "months" ? " selected" : ""}>мес.</option>
              <option value="days"${termUnit === "days" ? " selected" : ""}>дн.</option>
            </select>
          </span>
        </label>
        <label class="field"><span>Цена, ₽</span><input name="price" type="text" inputmode="numeric" value="${type.price ?? ""}" placeholder="4500"></label>
        <label class="field field--toggle span-2">
          <input name="active" type="checkbox" ${type.active ? "checked" : ""}>
          <span>Показывать при выборе абонемента у ученика</span>
        </label>
        ${
          editing
            ? `<p class="field-note span-2">
                Если поменяли срок действия — «Действует до» у уже добавленных учеников сам не пересчитывается,
                нажмите «Пересчитать даты у учеников» ниже.
              </p>`
            : ""
        }
      </div>
      <div class="modal__foot">
        ${editing ? '<button class="btn btn--danger" type="button" data-delete-type>Удалить</button>' : ""}
        <span class="modal__foot-right">
          ${editing ? '<button class="btn" type="button" data-recalc-type>Пересчитать даты у учеников</button>' : ""}
          <button class="btn" type="button" data-close>Отмена</button>
          <button class="btn btn--primary" type="submit">${editing ? "Сохранить" : "Добавить"}</button>
        </span>
      </div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      form.querySelector("[data-delete-type]")?.addEventListener("click", () => confirmDeleteSubtype(id));
      form.querySelector("[data-recalc-type]")?.addEventListener("click", () => confirmRecalcUntil(id));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = {
          name: data.name.trim(),
          classes_count: data.classes_count.trim() ? +data.classes_count : null,
          validity_days: data.term_unit === "days" && data.term.trim() ? +data.term : null,
          validity_months: data.term_unit === "months" && data.term.trim() ? +data.term : null,
          price: num(data.price),
          active: form.querySelector('[name="active"]').checked,
        };
        if (!payload.name) return;
        closeModal();
        const ok = editing
          ? await act("subtype.update", { id, ...payload }, "Вид абонемента обновлён")
          : await act("subtype.create", payload, "Вид абонемента добавлен");
        if (ok) render();
      });
    }
  );
}

async function recalcUntil(id) {
  closeModal();
  const ok = await act("subtype.recalc_until", { id });
  if (ok) {
    const count = STATE.data.recalcCount ?? 0;
    toast(count ? `Обновлено дат «Действует до»: ${count}` : "Нет учеников с датой начала абонемента — обновлять нечего");
    render();
  }
}

function confirmRecalcUntil(id) {
  const type = STATE.data.subscriptionTypes.find((t) => t.id === id);
  openModal(
    `<div class="modal confirm">
      <div class="modal__head"><div><p class="eyebrow">Пересчёт дат</p><h2>Пересчитать «Действует до»?</h2></div></div>
      <div class="modal__body">У всех учеников с абонементом «${esc(type.name)}» дата «Действует до» будет пересчитана как дата начала абонемента + ${esc(
      termLabel(type)
    )}. Даты, введённые вручную, будут перезаписаны.</div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--primary" type="button" data-confirm>Пересчитать</button>
      </span></div>
    </div>`,
    (modal) => {
      modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      modal.querySelector("[data-confirm]").addEventListener("click", () => recalcUntil(id));
    }
  );
}

function confirmDeleteSubtype(id) {
  const type = STATE.data.subscriptionTypes.find((t) => t.id === id);
  // Показываем, скольких учеников это заденет: удалять тариф, на котором
  // сидит полгруппы, — совсем не то же самое, что убрать неиспользуемый.
  const affected = STATE.data.branches
    .flatMap((b) => b.students)
    .filter((s) => s.subscription_type_id === id);
  const warning = affected.length
    ? `<b>Сейчас на этом абонементе ${affected.length} ${plural(affected.length, "ученик", "ученика", "учеников")}:</b>
       ${esc(affected.slice(0, 8).map((s) => s.name).join(", "))}${affected.length > 8 ? " и другие" : ""}.
       Счётчик занятий перестанет считаться, пока не выберете другой вид абонемента.`
    : "На этом абонементе сейчас никого нет — удаление ни на кого не повлияет.";
  openModal(
    `<div class="modal confirm">
      <div class="modal__head"><div><p class="eyebrow">Удаление</p><h2>Удалить вид абонемента?</h2></div></div>
      <div class="modal__body">«${esc(type.name)}» будет удалён.<br><br>${warning}</div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--danger" type="button" data-confirm>Удалить</button>
      </span></div>
    </div>`,
    (modal) => {
      modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      modal.querySelector("[data-confirm]").addEventListener("click", async () => {
        closeModal();
        if (await act("subtype.delete", { id }, "Вид абонемента удалён")) render();
      });
    }
  );
}

function coachOptions(selectedId) {
  const options = STATE.data.coaches
    .map(
      (c) =>
        `<option value="${c.id}"${String(c.id) === String(selectedId || "") ? " selected" : ""}>${esc(c.name)}${c.active ? "" : " · скрыт"}</option>`
    )
    .join("");
  return `<option value="">— не назначен —</option>${options}`;
}

function groupLabel(g) {
  const days = g.weekdays.map((w) => WEEKDAY_SHORT[w]).join("/");
  return `${g.direction}${multiBranch() ? ` · ${branchName(g.branch_id)}` : ""} · ${days} ${g.time || ""}`.trim();
}

function openCoachModal(id) {
  const editing = id !== null && id !== undefined;
  const coach = editing
    ? STATE.data.coaches.find((c) => c.id === id)
    : { name: "", phone: "", note: "", role: "Тренер", rate_type: "per_student", rate: null, branch_id: null, hired_from: isoToday(), active: 1 };
  const groups = [...STATE.data.groups].sort((a, b) => a.direction.localeCompare(b.direction, "ru"));

  openModal(
    `<form class="modal" id="coachForm">
      <div class="modal__head">
        <div><p class="eyebrow">${editing ? "Тренер" : "Новый тренер"}</p><h2>${editing ? esc(coach.name) : "Добавить"}</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        <label class="field"><span>Имя</span><input name="name" type="text" required value="${esc(coach.name)}" placeholder="Иванова Анна"></label>
        <label class="field"><span>Телефон</span><input name="phone" type="text" value="${esc(coach.phone)}" placeholder="+7 900 000-00-00"></label>
        <label class="field"><span>Должность</span><select name="role">${STATE.data.roles
          .map((r) => `<option value="${esc(r)}"${coach.role === r ? " selected" : ""}>${esc(r)}</option>`)
          .join("")}</select></label>
        <label class="field"><span>Оплата</span><select name="rate_type">
          <option value="per_student"${coach.rate_type === "per_student" ? " selected" : ""}>Ставка за ученика на занятии</option>
          <option value="per_class"${coach.rate_type === "per_class" ? " selected" : ""}>Ставка за занятие</option>
          <option value="monthly"${coach.rate_type === "monthly" ? " selected" : ""}>Оклад в месяц</option>
        </select></label>
        <label class="field"><span>Сумма, ₽</span><input name="rate" type="text" inputmode="numeric" value="${
          coach.rate === null || coach.rate === undefined ? "" : nf.format(coach.rate)
        }" placeholder="130"><small class="field__hint">за ученика — платим за каждого, кто отмечен «Пришёл»</small></label>
        <label class="field"><span>Индивидуальные, % от занятия</span>
          <input name="individual_share" type="text" inputmode="numeric" value="${
            coach.individual_share === null || coach.individual_share === undefined ? "" : coach.individual_share
          }" placeholder="40">
          <small class="field__hint">доля тренера от стоимости индивидуального занятия; пусто — не ведёт их</small></label>
        <label class="field"><span>Работает с</span><input name="hired_from" type="date" value="${esc(coach.hired_from || "")}"></label>
        ${branchField("branch", coach.branch_id, "Филиал (для оклада)", `<option value="">— не закреплён —</option>`)}
        <div class="field span-2"><span>Группы</span>
          <span class="check-list">
            ${
              groups.length
                ? groups
                    .map(
                      (g) => `<label class="check">
                <input type="checkbox" name="group_${g.id}"${editing && g.coach_id === coach.id ? " checked" : ""}>
                ${esc(groupLabel(g))}
              </label>`
                    )
                    .join("")
                : `<span class="check-list__empty">Пока нет ни одной группы — сначала добавьте расписание</span>`
            }
          </span>
        </div>
        <label class="field span-2"><span>Примечание</span><textarea name="note" placeholder="Что важно помнить">${esc(coach.note)}</textarea></label>
        <label class="field field--toggle span-2">
          <input name="active" type="checkbox" ${coach.active ? "checked" : ""}>
          <span>Показывать при назначении на группу</span>
        </label>
      </div>
      <div class="modal__foot">
        ${editing ? '<button class="btn btn--danger" type="button" data-delete-coach>Удалить</button>' : ""}
        <span class="modal__foot-right">
          <button class="btn" type="button" data-close>Отмена</button>
          <button class="btn btn--primary" type="submit">${editing ? "Сохранить" : "Добавить"}</button>
        </span>
      </div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      form.querySelector("[data-delete-coach]")?.addEventListener("click", () => confirmDeleteCoach(id));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const groupIds = groups.filter((g) => form.querySelector(`[name="group_${g.id}"]`)?.checked).map((g) => g.id);
        const payload = {
          name: data.name.trim(),
          phone: data.phone.trim(),
          note: data.note.trim(),
          role: data.role,
          rate_type: data.rate_type,
          rate: num(data.rate),
          individual_share: num(data.individual_share),
          branch: data.branch || null,
          hired_from: data.hired_from || "",
          active: form.querySelector('[name="active"]').checked,
          groupIds,
        };
        if (!payload.name) return;
        closeModal();
        const ok = editing
          ? await act("coach.update", { id, ...payload }, "Тренер обновлён")
          : await act("coach.create", payload, "Тренер добавлен");
        if (ok) render();
      });
    }
  );
}

function confirmDeleteCoach(id) {
  const coach = STATE.data.coaches.find((c) => c.id === id);
  openModal(
    `<div class="modal confirm">
      <div class="modal__head"><div><p class="eyebrow">Удаление</p><h2>Удалить тренера?</h2></div></div>
      <div class="modal__body">«${esc(coach.name)}» будет удалён. В группах, где он назначен, тренер станет «не назначен».</div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--danger" type="button" data-confirm>Удалить</button>
      </span></div>
    </div>`,
    (modal) => {
      modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      modal.querySelector("[data-confirm]").addEventListener("click", async () => {
        closeModal();
        if (await act("coach.delete", { id }, "Тренер удалён")) render();
      });
    }
  );
}

function openSalaryModal(coachId) {
  const row = STATE.salaries.rows.find((r) => r.id === coachId);
  if (!row) return;
  const data = STATE.salaries;

  openModal(
    `<form class="modal" id="salaryForm">
      <div class="modal__head">
        <div><p class="eyebrow">Зарплата · ${esc(data.label)}</p><h2>${esc(row.name)}</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        <p class="field-note field-note--calc span-2">
          ${
            row.rate_type === "monthly"
              ? `Оклад ${money(row.rate || 0)} в месяц.`
              : row.rate_type === "per_student"
              ? `Групповых занятий проведено: <b>${row.sessions}</b>, на них отмечено пришедших: <b>${row.visits}</b> × ${money(
                  row.rate || 0
                )} = <b>${money(row.groupPay)}</b>.`
              : `Проведено групповых занятий: <b>${row.sessions}</b> × ${money(row.rate || 0)} = <b>${money(row.groupPay)}</b>.`
          }
          ${
            row.individualLessons
              ? `<br>Индивидуальных занятий: <b>${row.individualLessons}</b> на сумму <b>${money(row.individualRevenue)}</b>${
                  row.individual_share
                    ? ` × ${row.individual_share}% = <b>${money(row.individualPay)}</b>.`
                    : ` — <span class="is-warn">процент за индивидуальные не задан, они не оплачены</span>.`
                }<br>Итого по расчёту: <b>${money(row.computed)}</b>.`
              : ""
          }
        </p>
        <label class="field"><span>Сумма вручную, ₽</span><input name="override" type="text" inputmode="numeric" value="${
          row.override === null || row.override === undefined ? "" : nf.format(row.override)
        }" placeholder="оставьте пустым — по расчёту"></label>
        <label class="field"><span>Премия, ₽</span><input name="bonus" type="text" inputmode="numeric" value="${
          row.bonus ? nf.format(row.bonus) : ""
        }" placeholder="0"></label>
        <label class="field span-2"><span>Примечание</span><input name="note" type="text" value="${esc(row.entryNote)}" placeholder="За что премия, что учесть"></label>
        <label class="field field--toggle span-2">
          <input name="paid" type="checkbox" ${row.paid ? "checked" : ""}>
          <span>Зарплата выплачена</span>
        </label>
      </div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--primary" type="submit">Сохранить</button>
      </span></div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form).entries());
        closeModal();
        const ok = await act(
          "salary.update",
          {
            coach_id: coachId,
            year: data.year,
            month: data.month,
            override: num(values.override),
            bonus: num(values.bonus),
            paid: form.querySelector('[name="paid"]').checked,
            note: values.note.trim(),
          },
          "Зарплата сохранена"
        );
        if (ok) {
          await loadSalaries();
          render();
        }
      });
    }
  );
}

function openGroupModal(id) {
  const editing = id !== null && id !== undefined;
  const group = editing
    ? STATE.data.groups.find((g) => g.id === id)
    : { branch_id: STATE.branch !== "all" ? STATE.branch : STATE.data.branches[0].id, direction: "", weekdays: [], time: "", hall: "", coach_id: null, active: 1 };
  const directions = STATE.data.branches.flatMap((b) => b.students.flatMap(studentDirections)).concat(DIRECTION_HINTS);

  openModal(
    `<form class="modal" id="groupForm">
      <div class="modal__head">
        <div><p class="eyebrow">${editing ? "Группа в расписании" : "Новая группа"}</p><h2>${editing ? esc(group.direction) : "Добавить группу"}</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        ${branchField("branch", group.branch_id)}
        <label class="field"><span>Время</span><input name="time" type="time" value="${esc(group.time)}"></label>
        <label class="field"><span>Зал</span><select name="hall">
          <option value="">— не указан —</option>
          ${HALLS.map((h) => `<option value="${esc(h)}"${group.hall === h ? " selected" : ""}>${esc(h)}</option>`).join("")}
        </select></label>
        <label class="field span-2"><span>Направление</span><input name="direction" type="text" list="dl-group-direction" required value="${esc(group.direction)}" placeholder="Хип-хоп"></label>
        <label class="field span-2"><span>Тренер</span><select name="coach_id">${coachOptions(group.coach_id)}</select></label>
        <div class="field span-2"><span>Дни недели</span>
          <span class="daychips">
            ${WEEKDAY_SHORT.map(
              (label, i) => `<label class="daychip">
                <input type="checkbox" name="weekday_${i}"${group.weekdays.includes(i) ? " checked" : ""} aria-label="${esc(STATE.data.weekdays[i])}">${label}
              </label>`
            ).join("")}
          </span>
        </div>
        <label class="field field--toggle span-2">
          <input name="is_individual" type="checkbox" ${group.is_individual ? "checked" : ""}>
          <span>Индивидуальные занятия (состав не постоянный, учеников добавляете вручную)</span>
        </label>
        <label class="field field--toggle span-2">
          <input name="active" type="checkbox" ${group.active ? "checked" : ""}>
          <span>Группа активна (показывать в «Посещаемости»)</span>
        </label>
        ${datalist("dl-group-direction", directions)}
      </div>
      <div class="modal__foot">
        ${editing ? '<button class="btn btn--danger" type="button" data-delete-group>Удалить</button>' : ""}
        <span class="modal__foot-right">
          <button class="btn" type="button" data-close>Отмена</button>
          <button class="btn btn--primary" type="submit">${editing ? "Сохранить" : "Добавить"}</button>
        </span>
      </div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      form.querySelector("[data-delete-group]")?.addEventListener("click", () => confirmDeleteGroup(id));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const weekdays = WEEKDAY_SHORT.map((_, i) => i).filter((i) => form.querySelector(`[name="weekday_${i}"]`).checked);
        const payload = {
          branch: data.branch,
          direction: data.direction.trim(),
          weekdays,
          time: data.time,
          hall: data.hall,
          coach_id: data.coach_id ? +data.coach_id : null,
          is_individual: form.querySelector('[name="is_individual"]').checked,
          active: form.querySelector('[name="active"]').checked,
        };
        if (!payload.direction || !weekdays.length) {
          toast("Укажите направление и хотя бы один день недели", "error");
          return;
        }
        closeModal();
        const ok = editing
          ? await act("group.update", { id, ...payload }, "Группа обновлена")
          : await act("group.create", payload, "Группа добавлена");
        if (ok) render();
      });
    }
  );
}

function confirmDeleteGroup(id) {
  const group = STATE.data.groups.find((g) => g.id === id);
  openModal(
    `<div class="modal confirm">
      <div class="modal__head"><div><p class="eyebrow">Удаление</p><h2>Удалить группу?</h2></div></div>
      <div class="modal__body">«${esc(group.direction)}» (${group.weekdays.map((w) => WEEKDAY_SHORT[w]).join(", ")}, ${esc(
      group.time || "без времени"
    )}) будет удалена из расписания вместе с историей посещаемости по этой группе.</div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--danger" type="button" data-confirm>Удалить</button>
      </span></div>
    </div>`,
    (modal) => {
      modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      modal.querySelector("[data-confirm]").addEventListener("click", async () => {
        closeModal();
        if (await act("group.delete", { id }, "Группа удалена")) render();
      });
    }
  );
}

/* --- отрисовка ---------------------------------------------------------- */

/* --- доступ: кто входит в панель ---------------------------------------- */

function openUserModal(id) {
  const editing = id !== null && id !== undefined;
  const user = editing
    ? (STATE.data.users || []).find((u) => u.id === id)
    : { name: "", login: "", role: "admin", active: true };
  const self = editing && user.id === currentUser().id;

  openModal(
    `<form class="modal" id="userForm">
      <div class="modal__head">
        <div><p class="eyebrow">${editing ? "Доступ" : "Новый доступ"}</p><h2>${editing ? esc(user.name) : "Кого пускаем"}</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        <label class="field span-2"><span>Имя</span><input name="name" type="text" required value="${esc(user.name)}" placeholder="Алина, администратор на Ирбитской"></label>
        <label class="field"><span>Логин</span><input name="login" type="text" required autocapitalize="off" value="${esc(user.login)}" placeholder="anna">
          <small class="field__hint">латиницей, без пробелов</small></label>
        <label class="field"><span>Права</span><select name="user_role"${self ? " disabled" : ""}>
          ${(STATE.data.userRoles || [])
            .map((r) => `<option value="${esc(r.id)}"${r.id === user.role ? " selected" : ""}>${esc(r.title)}</option>`)
            .join("")}
        </select>
          <small class="field__hint">${
            self ? "свои права менять нельзя" : "администратор не видит зарплат и финансов"
          }</small></label>
        <label class="field span-2"><span>${editing ? "Новый пароль" : "Пароль"}</span>
          <input name="password" type="password" autocomplete="new-password" ${editing ? "" : "required"} placeholder="${
      editing ? "оставьте пустым, чтобы не менять" : "не короче 6 символов"
    }">
          ${editing ? `<small class="field__hint">заполните, если человек забыл пароль — он сразу сменится</small>` : ""}
        </label>
        <label class="field field--toggle span-2">
          <input name="active" type="checkbox"${user.active ? " checked" : ""}${self ? " disabled" : ""}>
          <span>Доступ работает<small>выключите, когда человек уволился — записи и история останутся</small></span>
        </label>
      </div>
      <div class="modal__foot">
        ${editing && !self ? '<button class="btn btn--danger" type="button" data-delete-user>Удалить</button>' : ""}
        <span class="modal__foot-right">
          <button class="btn" type="button" data-close>Отмена</button>
          <button class="btn btn--primary" type="submit">${editing ? "Сохранить" : "Дать доступ"}</button>
        </span>
      </div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      form.querySelector("[data-delete-user]")?.addEventListener("click", async () => {
        closeModal();
        if (await act("user.delete", { id }, "Доступ удалён")) render();
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = {
          name: (data.name || "").trim(),
          login: (data.login || "").trim(),
          user_role: self ? user.role : data.user_role,
          password: data.password || "",
          active: self ? true : form.querySelector('[name="active"]').checked,
        };
        closeModal();
        const ok = editing
          ? await act("user.update", { id, ...payload }, "Доступ изменён")
          : await act("user.create", payload, "Доступ выдан");
        if (ok) render();
      });
    }
  );
}

function openPasswordModal() {
  openModal(
    `<form class="modal modal--narrow" id="passwordForm">
      <div class="modal__head">
        <div><p class="eyebrow">${esc(currentUser().name || "")}</p><h2>Смена пароля</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        <label class="field span-2"><span>Текущий пароль</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="field span-2"><span>Новый пароль</span><input name="password" type="password" autocomplete="new-password" required placeholder="не короче 6 символов"></label>
        <label class="field span-2"><span>Ещё раз новый</span><input name="repeat" type="password" autocomplete="new-password" required></label>
      </div>
      <div class="modal__foot"><span class="modal__foot-right">
        <button class="btn" type="button" data-close>Отмена</button>
        <button class="btn btn--primary" type="submit">Сменить</button>
      </span></div>
    </form>`,
    (form) => {
      form.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        if (data.password !== data.repeat) {
          toast("Новые пароли не совпадают", "error");
          return;
        }
        closeModal();
        if (await act("account.password", { current: data.current, password: data.password }, "Пароль изменён")) render();
      });
    }
  );
}

// Подпись под заголовком — не капс-надзаголовок, а полезный контекст.
const VIEWS = {
  dashboard: {
    title: "Сводка",
    subtitle: () => {
      const p = isoParts(isoToday());
      return `${STATE.data.weekdays[isoWeekday(isoToday())]}, ${p.d} ${MONTHS_GEN[p.m - 1]}`;
    },
    render: viewDashboard,
  },
  attendance: { title: "Посещаемость", subtitle: () => "Отметьте, кто пришёл на занятия", render: viewAttendance, actions: () => attendanceActions() },
  students: { title: "Ученики", subtitle: () => `${allStudents().length} в базе`, render: viewStudents },
  finance: { title: "Финансы", subtitle: () => "Доходы, расходы и прибыль по месяцам", render: viewFinance },
  salaries: { title: "Зарплаты", subtitle: () => "Начисления и выплаты сотрудникам", render: viewSalaries },
  subscriptions: {
    title: "Справочники",
    subtitle: () => (isOwner() ? "Абонементы, расписание, сотрудники и доступ" : "Абонементы и расписание"),
    render: viewSubscriptions,
  },
};

function renderBranchFilter() {
  const buttons = [{ id: "all", name: "Все филиалы" }].concat(STATE.data.branches);
  document.getElementById("branchFilter").innerHTML = buttons
    .map((branch) => `<button type="button" data-branch="${esc(branch.id)}"${STATE.branch === branch.id ? ' class="is-active"' : ""}>${esc(branch.name)}</button>`)
    .join("") +
    // На телефоне вместо кнопок — выпадающий список: три филиала в строку не влезают.
    `<select class="branch-select" aria-label="Филиал">${buttons
      .map((branch) => `<option value="${esc(branch.id)}"${STATE.branch === branch.id ? " selected" : ""}>${esc(branch.name)}</option>`)
      .join("")}</select>`;
}

/* На узком экране таблица разворачивается в карточки: каждая ячейка получает
   подпись из своего заголовка, чтобы строка читалась без горизонтальной
   прокрутки. Финансы не трогаем — там сетка «месяцы × статьи» осмысленна
   только целиком, её листают вбок. */
function labelTableCells(root) {
  root.querySelectorAll("table").forEach((table) => {
    if (table.closest("[data-finance]")) return;
    const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    if (!heads.length) return;
    table.classList.add("stacked");
    table.querySelectorAll("tbody tr").forEach((row) => {
      [...row.children].forEach((cell, index) => {
        if (heads[index]) cell.dataset.label = heads[index];
        // Строки без значения на телефоне только шумят: в карточке
        // «Действует до —» не несёт ничего, на широком экране прочерк уместен.
        const text = cell.textContent.replace(/[—\s]/g, "");
        if (index > 0 && !text && !cell.querySelector("button, input, select")) cell.dataset.blank = "1";
      });
    });
  });
}

// Демо-стенд: входа нет, вместо «Выйти» — переключение владелец ↔ администратор.
let DEMO = false;
function switchDemoRole() {
  const next = isOwner() ? "admin" : "owner";
  document.cookie = `plyaski_demo_role=${next}; path=/; max-age=31536000; SameSite=Lax`;
  location.reload();
}
const demoSwitchLabel = () => (isOwner() ? "Вид администратора" : "Вид владельца");

function renderWho() {
  const user = currentUser();
  if (DEMO) {
    document.getElementById("passwordBtn").hidden = true;
    document.getElementById("logoutBtn").textContent = demoSwitchLabel();
  }
  const who = document.getElementById("who");
  who.hidden = !user.login;
  document.getElementById("whoName").textContent = user.name || user.login || "";
  who.dataset.initial = initials(user.name || user.login).slice(0, 1);
  // Если человек так и назван «Владелец» — не повторять это дважды.
  document.getElementById("whoRole").textContent = user.name === user.roleTitle ? user.login : user.roleTitle || "";
}

function render() {
  if (!isOwner() && OWNER_VIEWS.has(STATE.view)) STATE.view = "attendance";
  const view = VIEWS[STATE.view];
  document.getElementById("viewTitle").textContent = view.title;
  document.getElementById("viewEyebrow").textContent = view.subtitle();
  document.getElementById("viewActions").innerHTML = view.actions ? view.actions() : "";
  document.querySelectorAll("#nav .nav__item").forEach((item) => {
    item.hidden = !isOwner() && OWNER_VIEWS.has(item.dataset.view);
    item.classList.toggle("is-active", item.dataset.view === STATE.view);
  });

  const primary = document.getElementById("primaryAction");
  primary.hidden = STATE.view !== "students" && STATE.view !== "dashboard";

  // Нижние вкладки на телефоне. Зарплаты и справочники живут во вкладке «Ещё».
  document.querySelectorAll("#tabbar .tab[data-view]").forEach((tab) => {
    tab.hidden = !isOwner() && OWNER_VIEWS.has(tab.dataset.view);
    tab.classList.toggle("is-active", tab.dataset.view === STATE.view);
  });
  document.querySelector("#tabbar [data-tab-more]").classList.toggle("is-active", MORE_VIEWS.has(STATE.view));

  document.getElementById("branchFilter").hidden = !multiBranch() || STATE.view === "subscriptions" || STATE.view === "salaries";
  document.getElementById("exportBtn").hidden = !isOwner();
  renderWho();

  // Пока владелец не сменил пароль по умолчанию — панель об этом напоминает.
  const banner = currentUser().mustChangePassword
    ? `<div class="banner"><span>Вход всё ещё по паролю по умолчанию. Смените его, прежде чем давать доступ другим.</span>
        <button class="btn btn--sm" id="bannerPassword" type="button">Сменить пароль</button></div>`
    : "";

  renderBranchFilter();
  const host = document.getElementById("view");
  host.innerHTML = banner + view.render();
  labelTableCells(host);
  document.getElementById("dbNote").textContent = `База обновлена ${STATE.data.updated}`;
  const exportNote = document.getElementById("exportNote");
  exportNote.hidden = !isOwner();
  exportNote.textContent = STATE.data.exportFile ? `Экспорт: ${STATE.data.exportUpdated}` : "Экспорт ещё не делался";
}

/* --- события ------------------------------------------------------------ */

function openView(view) {
  if (!VIEWS[view] || (!isOwner() && OWNER_VIEWS.has(view))) view = "attendance";
  STATE.view = view;
  if (location.hash.slice(1) !== view) location.hash = view;
  if ((view === "attendance" || view === "dashboard") && STATE.attendanceMarksDate !== STATE.attendanceDate) {
    render();
    loadAttendanceMarks().then(render);
  } else if (view === "salaries") {
    render();
    loadSalaries().then(render);
  } else {
    render();
  }
}

/* --- меню на телефоне ---------------------------------------------------- */

const navScrim = document.getElementById("navScrim");

function setMenu(open) {
  document.body.classList.toggle("nav-open", open);
  navScrim.hidden = !open;
  document.getElementById("menuBtn").setAttribute("aria-expanded", String(open));
}

document.getElementById("menuBtn").addEventListener("click", () => setMenu(!document.body.classList.contains("nav-open")));

/* --- вкладки на телефоне -------------------------------------------------- */

const MORE_VIEWS = new Set(["salaries", "subscriptions"]);

document.getElementById("tabbar").addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  if (tab.hasAttribute("data-tab-more")) {
    openMoreSheet();
    return;
  }
  // Повторное нажатие на открытую вкладку — наверх, как в приложениях iPhone.
  if (tab.dataset.view === STATE.view) {
    scrollTo({ top: 0, behavior: UI.reduceMotion.matches ? "auto" : "smooth" });
    return;
  }
  openView(tab.dataset.view);
  scrollTo(0, 0);
});

const MENU_ICONS = {
  salaries: `<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/></svg>`,
  subscriptions: `<svg viewBox="0 0 24 24"><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5"/><path d="M5 19.5v-15M5 19.5A1.5 1.5 0 0 0 6.5 21H19"/><path d="M9 7.5h6M9 11h6"/></svg>`,
  password: `<svg viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>`,
  export: `<svg viewBox="0 0 24 24"><path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4.5 16v2.5A2 2 0 0 0 6.5 20.5h11a2 2 0 0 0 2-2V16"/></svg>`,
  users: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 20c0-3.4 2.8-6 6.2-6s6.2 2.6 6.2 6"/><circle cx="17" cy="8.5" r="2.4"/><path d="M15.5 14.2c2.9.3 5 2.7 5 5.8"/></svg>`,
  logout: `<svg viewBox="0 0 24 24"><path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h9.5"/></svg>`,
};

/* «Ещё»: редкие разделы и всё, что касается входа. Сделано шторкой, а не
   отдельным экраном: открыл, выбрал, она уехала. */
function openMoreSheet() {
  const user = currentUser();
  const item = (key, label, attrs, extra = "") =>
    `<button class="menu-item${extra}" type="button" ${attrs}>${MENU_ICONS[key]}<span>${esc(label)}</span>${
      extra.includes("danger") ? "" : chev
    }</button>`;
  const views = [isOwner() ? ["salaries", "Зарплаты"] : null, ["subscriptions", "Справочники"]].filter(Boolean);
  openModal(
    `<div class="modal menu-sheet">
      <div class="modal__head">
        <div><h2>Ещё</h2></div>
        <button class="icon-btn" type="button" data-close aria-label="Закрыть">✕</button>
      </div>
      <div class="modal__body">
        <div class="menu-group">${views
          .map(([view, label]) => item(view, label, `data-menu-view="${view}"`, STATE.view === view ? " is-active" : ""))
          .join("")}</div>
        <div class="menu-group">
          <div class="menu-who">${avatar(user.name || user.login)}<span><b>${esc(user.name || user.login || "")}</b><span>${esc(
      user.roleTitle || ""
    )} · ${esc(user.login || "")}</span></span></div>
        </div>
        <div class="menu-group">
          ${DEMO ? "" : item("password", "Сменить пароль", "data-menu-action=\"password\"")}
          ${isOwner() ? item("export", "Экспорт в Excel", "data-menu-action=\"export\"") : ""}
          ${DEMO
            ? item("users", demoSwitchLabel(), "data-menu-action=\"logout\"")
            : item("logout", "Выйти", "data-menu-action=\"logout\"", " menu-item--danger")}
        </div>
        <p class="menu-note">${esc(`База обновлена ${STATE.data.updated}`)}</p>
      </div>
    </div>`,
    (sheet) => {
      sheet.querySelectorAll("[data-menu-view]").forEach((button) =>
        button.addEventListener("click", () => {
          closeModal();
          openView(button.dataset.menuView);
          scrollTo(0, 0);
        })
      );
      sheet.querySelectorAll("[data-menu-action]").forEach((button) =>
        button.addEventListener("click", () => {
          const action = button.dataset.menuAction;
          closeModal();
          // Те же действия, что у кнопок бокового меню на широком экране.
          if (action === "password") openPasswordModal();
          else if (action === "export") document.getElementById("exportBtn").click();
          else if (action === "logout") document.getElementById("logoutBtn").click();
        })
      );
    }
  );
}
navScrim.addEventListener("click", () => setMenu(false));

document.getElementById("nav").addEventListener("click", (event) => {
  const button = event.target.closest(".nav__item");
  if (button) {
    setMenu(false);
    openView(button.dataset.view);
  }
});

addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (view && view !== STATE.view) openView(view);
});

document.getElementById("branchFilter").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  STATE.branch = button.dataset.branch;
  render();
});
document.getElementById("branchFilter").addEventListener("change", (event) => {
  if (!event.target.matches(".branch-select")) return;
  STATE.branch = event.target.value;
  render();
});

document.getElementById("primaryAction").addEventListener("click", () => openStudentModal(null));

document.getElementById("exportBtn").addEventListener("click", async () => {
  // Панель может работать на сервере, поэтому отчёт скачивается в браузер,
  // а не просто кладётся в папку рядом.
  const button = document.getElementById("exportBtn");
  button.disabled = true;
  try {
    const response = checkSession(await fetch("/api/export.xlsx"));
    if (!response.ok) throw new Error((await response.json()).error || "Не удалось собрать отчёт");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "Экспорт для Excel.xlsx";
    link.click();
    URL.revokeObjectURL(url);
    toast("Отчёт скачан");
    await loadState();
    render();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

// Слушаем всю рабочую область: кнопки раздела живут и в шапке, и в содержимом.
const viewRoot = document.querySelector(".main");

viewRoot.addEventListener("click", (event) => {
  const sortHead = event.target.closest("th.sortable");
  if (sortHead) {
    const key = sortHead.dataset.sort;
    STATE.sort = STATE.sort.key === key ? { key, dir: -STATE.sort.dir } : { key, dir: 1 };
    render();
    return;
  }

  const addMonth = event.target.closest("[data-add-month]");
  if (addMonth) {
    act("finance.add_month", { branch: addMonth.dataset.addMonth }, "Месяц добавлен").then((ok) => ok && render());
    return;
  }

  const attention = event.target.closest("[data-attention]");
  if (attention) {
    STATE.attention = attention.dataset.attention === "1";
    render();
    return;
  }

  const deleteMonth = event.target.closest("[data-delete-month]");
  if (deleteMonth) {
    const branchId = deleteMonth.closest("[data-finance]").dataset.finance;
    confirmDeleteMonth(branchId, +deleteMonth.dataset.deleteMonth);
    return;
  }

  const toggleGroup = event.target.closest("[data-toggle-group]");
  if (toggleGroup && !event.target.closest("button, select, input")) {
    const gid = +toggleGroup.dataset.toggleGroup;
    if (STATE.attendanceExpanded.has(gid)) STATE.attendanceExpanded.delete(gid);
    else STATE.attendanceExpanded.add(gid);
    render();
    return;
  }

  const markAll = event.target.closest("[data-mark-all]");
  if (markAll) {
    markAllPresent(+markAll.dataset.markAll);
    return;
  }

  const markBtn = event.target.closest("[data-mark]");
  if (markBtn) {
    const groupId = +markBtn.dataset.group;
    const studentId = +markBtn.dataset.student;
    const wanted = markBtn.dataset.mark;
    const current = ((STATE.attendanceMarks[groupId] || {})[studentId] || {}).status || null;
    markAttendance(groupId, studentId, current === wanted ? null : wanted);
    return;
  }

  const shiftDay = event.target.closest("[data-shift-day]");
  if (shiftDay) {
    const delta = +shiftDay.dataset.shiftDay;
    setAttendanceDate(delta === 0 ? isoToday() : addDaysIso(STATE.attendanceDate, delta));
    return;
  }

  const addType = event.target.closest("[data-add-type]");
  if (addType) {
    openSubtypeModal(null);
    return;
  }
  const typeRow = event.target.closest("[data-type-id]");
  if (typeRow) {
    openSubtypeModal(+typeRow.dataset.typeId);
    return;
  }

  const addGroup = event.target.closest("[data-add-group]");
  if (addGroup) {
    openGroupModal(null);
    return;
  }
  const groupRow = event.target.closest("[data-group-id]");
  if (groupRow) {
    openGroupModal(+groupRow.dataset.groupId);
    return;
  }

  const salaryShift = event.target.closest("[data-salary-shift]");
  if (salaryShift) {
    const delta = +salaryShift.dataset.salaryShift;
    const now = new Date();
    if (delta === 0) setSalaryMonth(now.getFullYear(), now.getMonth() + 1);
    else setSalaryMonth(STATE.salaryYear, STATE.salaryMonth + delta);
    return;
  }
  const salaryRow = event.target.closest("[data-salary-id]");
  if (salaryRow) {
    openSalaryModal(+salaryRow.dataset.salaryId);
    return;
  }

  if (event.target.closest("#bannerPassword")) {
    openPasswordModal();
    return;
  }

  const addUser = event.target.closest("[data-add-user]");
  if (addUser) {
    openUserModal(null);
    return;
  }
  const userRow = event.target.closest("[data-user-id]");
  if (userRow) {
    openUserModal(+userRow.dataset.userId);
    return;
  }

  const addCoach = event.target.closest("[data-add-coach]");
  if (addCoach) {
    openCoachModal(null);
    return;
  }

  const addIndividual = event.target.closest("[data-add-individual]");
  if (addIndividual) {
    openIndividualLessonModal();
    return;
  }
  const coachRow = event.target.closest("[data-coach-id]");
  if (coachRow) {
    openCoachModal(+coachRow.dataset.coachId);
    return;
  }

  const go = event.target.closest("[data-go]");
  if (go) {
    openView(go.dataset.go);
    scrollTo(0, 0);
    return;
  }

  // Занятие в блоке «Сегодня» — сразу в посещаемость, с раскрытой группой.
  const todayRow = event.target.closest("[data-today-group]");
  if (todayRow) {
    STATE.attendanceExpanded.add(+todayRow.dataset.todayGroup);
    if (STATE.attendanceDate !== isoToday()) {
      STATE.attendanceDate = isoToday();
      STATE.attendanceMarksDate = null;
    }
    openView("attendance");
    scrollTo(0, 0);
    return;
  }

  // Строка ученика в мобильном списке и в «Сводке» — сразу в карточку.
  // Кнопка «Позвонить» внутри строки звонит, а не открывает карточку.
  if (event.target.closest("a[href^='tel:']")) return;
  const studentRow = event.target.closest("[data-student-id]");
  if (studentRow) {
    openStudentModal(+studentRow.dataset.studentId);
    return;
  }

  const row = event.target.closest("tr[data-branch]");
  if (!row) return;
  const id = +row.dataset.id;
  if (event.target.closest("[data-delete]")) confirmDeleteStudent(id);
  else openStudentModal(id);
});

viewRoot.addEventListener("input", (event) => {
  if (event.target.id === "searchInput") {
    STATE.search = event.target.value;
    const caret = event.target.selectionStart;
    render();
    const input = document.getElementById("searchInput");
    input.focus();
    input.setSelectionRange(caret, caret);
  }
});

viewRoot.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.id === "statusFilter") {
    STATE.status = target.value;
    render();
    return;
  }
  if (target.id === "activityFilter") {
    STATE.activity = target.value;
    render();
    return;
  }
  if (target.id === "directionFilter") {
    STATE.direction = target.value;
    render();
    return;
  }
  if (target.id === "attendDate") {
    setAttendanceDate(target.value);
    return;
  }
  if (target.matches("[data-extra-group]")) {
    const id = +target.value;
    if (id) {
      STATE.attendanceExtra.add(id);
      render();
    }
    return;
  }
  if (target.matches("[data-ind-coach]") || target.matches("[data-ind-price]")) {
    const isCoach = target.matches("[data-ind-coach]");
    const key = isCoach ? target.dataset.indCoach : target.dataset.indPrice;
    const [groupId, studentId] = key.split(":").map(Number);
    const draft = STATE.individualDraft[key] || {};
    const current = individualState(groupId, studentId);
    STATE.individualDraft[key] = isCoach
      ? { ...draft, coachId: target.value ? +target.value : null }
      : { ...draft, price: num(target.value) };
    // Занятие уже отмечено — правка тренера или цены сразу уходит в базу.
    const saved = ((STATE.attendanceMarks || {})[groupId] || {})[studentId];
    if (saved && saved.status) {
      const next = individualState(groupId, studentId);
      if (!next.coachId) {
        STATE.individualDraft[key] = { ...STATE.individualDraft[key], coachId: current.coachId };
        toast("У занятия должен быть тренер", "error");
        render();
        return;
      }
      await markAttendance(groupId, studentId, saved.status);
    } else {
      render();
    }
    return;
  }

  if (target.matches("[data-add-student]")) {
    const groupId = +target.dataset.addStudent;
    const studentId = +target.value;
    target.value = "";
    if (studentId) markAttendance(groupId, studentId, "present");
    return;
  }
  if (target.classList.contains("fin-input")) {
    const { branch, id, index, field } = target.dataset;
    const value = num(target.value);
    const month = STATE.data.branches.find((b) => b.id === branch).months[+index];
    month[field] = value;
    target.value = value === null ? "" : nf.format(value);
    refreshFinanceDerived(branch);
    const ok = await act("finance.update", { branch, id: +id, field, value });
    if (ok) {
      target.classList.add("is-saved");
      setTimeout(() => target.classList.remove("is-saved"), 800);
    }
  }
});

viewRoot.addEventListener("keydown", (event) => {
  if (event.target.classList.contains("fin-input") && event.key === "Enter") {
    event.preventDefault();
    event.target.blur();
  }
});

/* --- тема: у панели одна, тёмная ------------------------------------------ */

document.documentElement.dataset.theme = "dark";
try {
  localStorage.removeItem("plyaski-theme");
} catch (error) {
  /* хранилище недоступно — не страшно */
}

/* --- вход и старт ------------------------------------------------------- */

const gate = document.getElementById("gate");
const appShell = document.getElementById("app");
const gateError = document.getElementById("gateError");

function showGate(message) {
  appShell.hidden = true;
  gate.hidden = false;
  closeModal();
  gateError.textContent = message || "";
  gateError.hidden = !message;
  document.querySelector("#loginForm [name=login]").focus();
}

async function startApp() {
  await loadState();
  if (!isOwner() && OWNER_VIEWS.has(STATE.view)) STATE.view = "attendance";
  if (STATE.view === "attendance" || STATE.view === "dashboard") await loadAttendanceMarks();
  else if (STATE.view === "salaries") await loadSalaries();
  gate.hidden = true;
  appShell.hidden = false;
  render();
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: form.login.value.trim(), password: form.password.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось войти");
    gateError.hidden = true;
    form.reset();
    await startApp();
  } catch (error) {
    gateError.textContent = error.message;
    gateError.hidden = false;
    form.password.value = "";
    form.password.focus();
  } finally {
    button.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  if (DEMO) return switchDemoRole();
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.reload();
});

document.getElementById("passwordBtn").addEventListener("click", () => openPasswordModal());

STATE.attendanceDate = isoToday();
STATE.salaryYear = new Date().getFullYear();
STATE.salaryMonth = new Date().getMonth() + 1;

if (VIEWS[location.hash.slice(1)]) STATE.view = location.hash.slice(1);

fetch("/api/me")
  .then(async (response) => {
    if (!response.ok) return showGate();
    DEMO = Boolean((await response.json()).demo);
    return startApp();
  })
  .catch((error) => {
    if (!gate.hidden) return; // сессия закончилась — уже показан экран входа
    document.getElementById("view").innerHTML = `<div class="card"><div class="empty"><b>Не удалось открыть базу</b>${esc(error.message)}</div></div>`;
    appShell.hidden = false;
  });
