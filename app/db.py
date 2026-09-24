# -*- coding: utf-8 -*-
"""Хранилище студии «Пляски» на SQLite.

Источник истины — файл data/plyaski.sqlite3. При первом запуске (если базы ещё
нет) сюда переносятся данные из старого .xlsx, если он лежит рядом с папкой
app. Дальше xlsx уже не читается панелью — только используется как шаблон
для кнопки «Экспорт в Excel» (см. xlsx_io.export_to_xlsx).
"""

import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from datetime import datetime, date, timedelta

import xlsx_io

APP_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(APP_DIR)
DATA_DIR = os.path.join(ROOT_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "plyaski.sqlite3")
BACKUP_DIR = os.path.join(ROOT_DIR, "backups")

STATUSES = ["Активен", "Продлил", "Ушёл"]
WEEKDAYS = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]
ROLES = ["Тренер", "Администратор"]
# Способы оплаты труда: за посещение (ставка × пришедшие), за занятие, оклад.
RATE_TYPES = ["per_student", "per_class", "monthly"]
# Признак «ходит / затих / ушёл» считается по последнему посещению.
QUIET_AFTER_DAYS = 14
LOST_AFTER_DAYS = 45
ACTIVITY = ["Ходит", "Затих", "Пропал", "Не начал"]
MONTHS_RU = xlsx_io.MONTHS_RU
FINANCE_FIELDS = [f for f, _ in xlsx_io.FINANCE_COLUMNS]
# Эти статьи панель знает сама — по платежам учеников и начисленным зарплатам.
# Руками их не вводят: в финансах они всегда равны тому, что посчитано, и
# меняются сразу, как только записали оплату или отметили занятие. Руками
# ведутся только аренда, реклама, мерч и прочее.
AUTO_FINANCE_FIELDS = ("income_subs", "expense_coaches", "expense_admins")

# --- доступ ---------------------------------------------------------------
# Владелец видит всё. Администратор ведёт ежедневную работу, но не видит
# денег студии в целом: ни зарплат и ставок, ни финансов по месяцам.
USER_ROLES = ["owner", "admin"]
ROLE_TITLES = {"owner": "Владелец", "admin": "Администратор"}
ADMIN_ACTIONS = {
    "attendance.mark",     # отметить, кто пришёл
    "student.create",      # завести ученика
    "student.update",      # править карточку, продлевать абонемент
    "payment.create",      # записать оплату
    "account.password",    # сменить себе пароль
}
DEFAULT_OWNER_LOGIN = "dilyara"
DEFAULT_OWNER_PASSWORD = "plyaski2026"
MIN_PASSWORD = 6
PBKDF2_ROUNDS = 200000


class AccessDenied(Exception):
    """Действие недоступно для этой роли."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscription_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    classes_count INTEGER,
    validity_days INTEGER,
    validity_months INTEGER,  -- если задан, срок — календарные месяцы (15.09 → 15.10), дни не смотрим
    price REAL,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT '',
    join_date TEXT NOT NULL DEFAULT '',
    subscription_type_id INTEGER REFERENCES subscription_types(id) ON DELETE SET NULL,
    price REAL,
    cycle_start TEXT NOT NULL DEFAULT '',
    until_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Активен',
    source TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS student_directions (
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (student_id, direction)
);

CREATE TABLE IF NOT EXISTS coaches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'Тренер',
    rate_type TEXT NOT NULL DEFAULT 'per_class',
    rate REAL,
    -- Доля тренера от стоимости индивидуального занятия, в процентах.
    individual_share REAL,
    branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
    hired_from TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS class_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    weekdays TEXT NOT NULL DEFAULT '',
    time TEXT NOT NULL DEFAULT '',
    hall TEXT NOT NULL DEFAULT '',
    coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
    is_individual INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    subscription_type_id INTEGER REFERENCES subscription_types(id) ON DELETE SET NULL,
    amount REAL NOT NULL,
    payment_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS salary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coach_id INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    bonus REAL,
    override REAL,
    paid INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE(coach_id, year, month)
);

CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES class_groups(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    session_date TEXT NOT NULL,
    status TEXT NOT NULL,
    marked_at TEXT NOT NULL,
    -- Только для индивидуальных занятий: кто провёл и сколько занятие стоило.
    -- Цена запоминается в момент отметки, чтобы прошлые зарплаты не менялись,
    -- если ученику потом сменят абонемент.
    coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL,
    lesson_price REAL,
    UNIQUE(group_id, student_id, session_date)
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'admin',
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT '',
    last_login TEXT NOT NULL DEFAULT '',
    must_change_password INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT '',
    expires_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    income_subs REAL,
    income_rent REAL,
    expense_rent REAL,
    expense_coaches REAL,
    expense_admins REAL,
    expense_ads REAL,
    expense_merch REAL,
    expense_other REAL,
    UNIQUE(branch_id, year, month)
);
"""


def get_conn():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def ensure_db():
    is_new = not os.path.exists(DB_PATH)
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
    _migrate_group_weekdays(conn)
    _migrate_group_coach(conn)
    _migrate_group_hall(conn)
    _migrate_add_columns(conn)
    _migrate_validity_months(conn)
    _migrate_student_directions(conn)
    _migrate_individual_attendance(conn)
    _ensure_individual_groups(conn)
    _ensure_owner(conn)
    if is_new:
        _migrate_from_xlsx(conn)
    conn.close()


def _migrate_add_columns(conn):
    """Добавляет колонки, появившиеся позже, в уже существующую базу."""
    additions = {
        "class_groups": [("is_individual", "INTEGER NOT NULL DEFAULT 0")],
        "coaches": [
            ("role", "TEXT NOT NULL DEFAULT 'Тренер'"),
            ("rate_type", "TEXT NOT NULL DEFAULT 'per_class'"),
            ("rate", "REAL"),
            ("individual_share", "REAL"),
            ("branch_id", "TEXT REFERENCES branches(id) ON DELETE SET NULL"),
            ("hired_from", "TEXT NOT NULL DEFAULT ''"),
        ],
        "attendance": [
            ("coach_id", "INTEGER REFERENCES coaches(id) ON DELETE SET NULL"),
            ("lesson_price", "REAL"),
        ],
    }
    changed = False
    for table, columns in additions.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, ddl in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
                changed = True
    if changed:
        conn.commit()


def _migrate_validity_months(conn):
    """Срок абонемента календарными месяцами. В школе абонемент «на месяц»
    живёт с 15-го по 15-е, а «30 дней» уползали: 15.10 → 14.11 → 14.12 → 13.01.
    Срок, кратный 30 дням, всегда и означал месяцы — переводим его один раз,
    в момент появления колонки. Короткие (14 дней у разового и пробного)
    остаются в днях. Даты у уже записанных учеников не трогаем."""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(subscription_types)").fetchall()}
    if "validity_months" in existing:
        return
    conn.execute("ALTER TABLE subscription_types ADD COLUMN validity_months INTEGER")
    conn.execute(
        """UPDATE subscription_types
           SET validity_months = validity_days / 30, validity_days = NULL
           WHERE validity_days > 0 AND validity_days % 30 = 0"""
    )
    conn.commit()


def add_months(day, months):
    """15.10 + 1 месяц = 15.11. Если такого числа в месяце нет — последнее:
    31.01 + 1 месяц = 28.02 (29.02 в високосный)."""
    index = day.month - 1 + months
    year, month = day.year + index // 12, index % 12 + 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day.day, last))


def term_end(start, validity_days, validity_months):
    """Дата «Действует до» по началу абонемента и сроку его вида, или None."""
    if validity_months:
        return add_months(start, validity_months)
    if validity_days:
        return start + timedelta(days=validity_days)
    return None


def _migrate_student_directions(conn):
    """Переносит старое одиночное направление в таблицу связей.

    Колонку students.direction сохраняем как первое направление для
    совместимости с прежними экспортами и резервными копиями.
    """
    conn.execute(
        """INSERT OR IGNORE INTO student_directions (student_id, direction, sort_order)
           SELECT id, trim(direction), 0 FROM students WHERE trim(direction) <> ''"""
    )
    conn.commit()


def _lesson_price(conn, student_id):
    """Во сколько ученику обходится одно занятие — по его абонементу.
    Своя цена ученика важнее цены вида абонемента (скидки). Безлимит цены
    за занятие не даёт — тогда сумму вписывают руками."""
    row = conn.execute(
        """SELECT s.price AS own, t.price AS plan_price, t.classes_count AS classes
           FROM students s LEFT JOIN subscription_types t ON t.id = s.subscription_type_id
           WHERE s.id = ?""",
        (student_id,),
    ).fetchone()
    if not row:
        return None
    total = row["own"] if row["own"] is not None else row["plan_price"]
    if total is None or not row["classes"]:
        return None
    return round(total / row["classes"], 2)


def _migrate_individual_attendance(conn):
    """Раньше индивидуальные занятия числились за тренером псевдогруппы
    «Индивидуальные». Переносим их на этого же тренера уже в саму отметку и
    проставляем стоимость — иначе прошлые занятия остались бы ничьими."""
    rows = conn.execute(
        """SELECT a.id, a.student_id, g.coach_id
           FROM attendance a JOIN class_groups g ON g.id = a.group_id
           WHERE g.is_individual = 1 AND a.coach_id IS NULL"""
    ).fetchall()
    if not rows:
        return
    for row in rows:
        conn.execute(
            "UPDATE attendance SET coach_id=?, lesson_price=? WHERE id=?",
            (row["coach_id"], _lesson_price(conn, row["student_id"]), row["id"]),
        )
    conn.commit()


def _ensure_individual_groups(conn):
    """У каждого филиала должна быть псевдогруппа «Индивидуальные» — иначе
    индивидуальное занятие некуда записать. Заводим её сами, а не ждём, пока
    владелец создаст вручную (это единственное действие в group.create,
    недоступное администратору, а отмечать индивидуальные должен именно он)."""
    branches = [r["id"] for r in conn.execute("SELECT id FROM branches")]
    existing = {r["branch_id"] for r in conn.execute("SELECT branch_id FROM class_groups WHERE is_individual=1")}
    for branch_id in branches:
        if branch_id in existing:
            continue
        conn.execute(
            """INSERT INTO class_groups (branch_id, direction, weekdays, time, hall, coach_id, is_individual, active)
               VALUES (?, 'Индивидуальные', '0,1,2,3,4,5,6', '', '', NULL, 1, 1)""",
            (branch_id,),
        )
    conn.commit()


def _migrate_group_weekdays(conn):
    """Старая схема: одно занятие = один день недели (weekday INTEGER).
    Новая: одно занятие может идти в несколько дней (weekdays TEXT, "1,3")."""
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(class_groups)").fetchall()]
    if "weekday" in cols and "weekdays" not in cols:
        conn.execute("ALTER TABLE class_groups ADD COLUMN weekdays TEXT NOT NULL DEFAULT ''")
        conn.execute("UPDATE class_groups SET weekdays = CAST(weekday AS TEXT)")
        conn.execute("ALTER TABLE class_groups DROP COLUMN weekday")
        conn.commit()


def _migrate_group_coach(conn):
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(class_groups)").fetchall()]
    if "coach_id" not in cols:
        conn.execute("ALTER TABLE class_groups ADD COLUMN coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL")
        conn.commit()


def _migrate_group_hall(conn):
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(class_groups)").fetchall()]
    if "hall" not in cols:
        conn.execute("ALTER TABLE class_groups ADD COLUMN hall TEXT NOT NULL DEFAULT ''")
        conn.commit()


# --- вход в панель: пользователи и пароли ---------------------------------

def hash_password(password, salt=None, rounds=PBKDF2_ROUNDS):
    """Пароль в базе не хранится — только необратимый отпечаток PBKDF2."""
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), bytes.fromhex(salt), rounds)
    return f"pbkdf2_sha256${rounds}${salt}${digest.hex()}"


def check_password(password, stored):
    parts = str(stored or "").split("$")
    if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
        return False
    _, rounds, salt, digest = parts
    try:
        check = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), bytes.fromhex(salt), int(rounds))
    except ValueError:
        return False
    return hmac.compare_digest(check.hex(), digest)


def _user_json(row):
    return {
        "id": row["id"],
        "login": row["login"],
        "name": row["name"] or row["login"],
        "role": row["role"],
        "roleTitle": ROLE_TITLES.get(row["role"], row["role"]),
        "active": bool(row["active"]),
        "lastLogin": row["last_login"],
        "mustChangePassword": bool(row["must_change_password"]),
    }


def _ensure_owner(conn):
    """Пустая база пользователей — заводим владельца с паролем по умолчанию."""
    if conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]:
        return
    conn.execute(
        """INSERT INTO users (login, name, role, password_hash, active, created_at, must_change_password)
           VALUES (?, 'Владелец', 'owner', ?, 1, ?, 1)""",
        (DEFAULT_OWNER_LOGIN, hash_password(DEFAULT_OWNER_PASSWORD), datetime.now().strftime("%Y-%m-%d")),
    )
    conn.commit()


def owner_password_is_default():
    """Владелец ещё не менял пароль — панель напомнит об этом."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT must_change_password FROM users WHERE login=? COLLATE NOCASE", (DEFAULT_OWNER_LOGIN,)).fetchone()
        return bool(row and row["must_change_password"])
    finally:
        conn.close()


def authenticate(login, password):
    """Логин и пароль верны и доступ не отключён — возвращаем пользователя."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE login=? COLLATE NOCASE", (_clean_text(login),)).fetchone()
        if not row or not row["active"] or not check_password(password, row["password_hash"]):
            return None
        conn.execute(
            "UPDATE users SET last_login=? WHERE id=?",
            (datetime.now().strftime("%d.%m.%Y %H:%M"), row["id"]),
        )
        conn.commit()
        return _user_json(row)
    finally:
        conn.close()


def get_user(user_id):
    """Свежие данные пользователя — проверяются на каждом запросе."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
        return _user_json(row) if row and row["active"] else None
    finally:
        conn.close()


def list_users(conn):
    return [_user_json(r) for r in conn.execute("SELECT * FROM users ORDER BY role, login COLLATE NOCASE")]


# --- сессии: кто уже вошёл ------------------------------------------------
# Хранятся в базе, а не в памяти сервера: после перезапуска панели (обновление,
# перезагрузка сервера) люди остаются внутри и не вводят пароль заново.

def create_session(user_id, ttl_seconds):
    token = secrets.token_urlsafe(32)
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, int(user_id), datetime.now().strftime("%Y-%m-%d %H:%M"), time.time() + ttl_seconds),
        )
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
        conn.commit()
        return token
    finally:
        conn.close()


def session_user(token, ttl_seconds):
    """Пользователь по токену из cookie. Права читаются из базы каждый раз,
    поэтому отключение доступа действует сразу же."""
    if not token:
        return None
    conn = get_conn()
    try:
        row = conn.execute(
            """SELECT s.expires_at, u.* FROM sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.token = ?""",
            (token,),
        ).fetchone()
        now = time.time()
        if not row or row["expires_at"] < now or not row["active"]:
            if row:
                conn.execute("DELETE FROM sessions WHERE token=?", (token,))
                conn.commit()
            return None
        # Продлеваем не чаще раза в час, чтобы не писать в базу на каждом клике.
        if row["expires_at"] - now < ttl_seconds - 3600:
            conn.execute("UPDATE sessions SET expires_at=? WHERE token=?", (now + ttl_seconds, token))
            conn.commit()
        return _user_json(row)
    finally:
        conn.close()


def drop_session(token):
    if not token:
        return
    conn = get_conn()
    try:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        conn.commit()
    finally:
        conn.close()


def drop_user_sessions(user_id):
    """Сменили пароль или отключили доступ — все входы этого человека закрыты."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (int(user_id),))
        conn.commit()
    finally:
        conn.close()


# --- автоматические копии базы -------------------------------------------

def backup_db(keep=30):
    """Копия базы на сегодня в backups/. Одна в день, старые убираются."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    path = os.path.join(BACKUP_DIR, datetime.now().strftime("%Y-%m-%d") + "_auto.sqlite3")
    if os.path.exists(path):
        return None
    source = get_conn()
    target = sqlite3.connect(path)
    try:
        with target:
            source.backup(target)  # согласованная копия, даже если в базу пишут
    finally:
        target.close()
        source.close()
    old = sorted(f for f in os.listdir(BACKUP_DIR) if f.endswith("_auto.sqlite3"))
    for name in old[:-keep] if len(old) > keep else []:
        os.remove(os.path.join(BACKUP_DIR, name))
    return path


def _check_password_rules(password):
    if len(str(password or "")) < MIN_PASSWORD:
        raise ValueError(f"Пароль должен быть не короче {MIN_PASSWORD} символов")


def _check_login_free(conn, login, exclude_id=None):
    if not login:
        raise ValueError("Укажите логин")
    if " " in login:
        raise ValueError("В логине не должно быть пробелов")
    row = conn.execute(
        "SELECT id FROM users WHERE login=? COLLATE NOCASE AND id IS NOT ?", (login, exclude_id)
    ).fetchone()
    if row:
        raise ValueError("Такой логин уже занят")


def _active_owners(conn, exclude_id=None):
    return conn.execute(
        "SELECT COUNT(*) AS c FROM users WHERE role='owner' AND active=1 AND id IS NOT ?", (exclude_id,)
    ).fetchone()["c"]


# --- миграция из старого xlsx (один раз, при первом запуске) --------------

def _migrate_from_xlsx(conn):
    source = xlsx_io.read_source_for_migration()
    if not source:
        return
    plan_prices = {}
    for idx, branch in enumerate(source["branches"]):
        conn.execute(
            "INSERT OR IGNORE INTO branches (id, name, sort_order) VALUES (?, ?, ?)",
            (branch["id"], branch["name"], idx),
        )
        for student in branch["students"]:
            plan = (student.get("plan") or "").strip()
            if plan and plan not in plan_prices and student.get("price"):
                plan_prices[plan] = student["price"]

    type_ids = {}
    for plan_name, price in sorted(plan_prices.items()):
        cur = conn.execute(
            "INSERT INTO subscription_types (name, classes_count, validity_days, price, active) "
            "VALUES (?, NULL, 30, ?, 1)",
            (plan_name, price),
        )
        type_ids[plan_name] = cur.lastrowid
    # Абонементы без известной цены (или без записей ученика с ценой) — тоже заводим типы.
    all_plans = set()
    for branch in source["branches"]:
        for student in branch["students"]:
            plan = (student.get("plan") or "").strip()
            if plan:
                all_plans.add(plan)
    for plan_name in sorted(all_plans - set(type_ids)):
        cur = conn.execute(
            "INSERT INTO subscription_types (name, classes_count, validity_days, price, active) "
            "VALUES (?, NULL, 30, NULL, 1)",
            (plan_name,),
        )
        type_ids[plan_name] = cur.lastrowid

    for branch in source["branches"]:
        for student in branch["students"]:
            plan = (student.get("plan") or "").strip()
            join_iso = xlsx_io.parse_ru_date(student.get("start"))
            until_iso = xlsx_io.parse_ru_date(student.get("until"))
            conn.execute(
                """INSERT INTO students
                   (branch_id, name, phone, direction, join_date, subscription_type_id,
                    price, cycle_start, until_date, status, source, note)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    branch["id"],
                    student.get("name") or "",
                    student.get("phone") or "",
                    student.get("direction") or "",
                    join_iso,
                    type_ids.get(plan),
                    student.get("price"),
                    join_iso,
                    until_iso,
                    student.get("status") or STATUSES[0],
                    student.get("source") or "",
                    student.get("note") or "",
                ),
            )
        for month in branch["months"]:
            parsed = xlsx_io.month_to_year_month(month.get("label"))
            if not parsed:
                continue
            year, mon = parsed
            values = [month.get(f) for f in FINANCE_FIELDS]
            conn.execute(
                f"""INSERT OR IGNORE INTO finance_entries
                    (branch_id, year, month, {", ".join(FINANCE_FIELDS)})
                    VALUES (?, ?, ?, {", ".join(["?"] * len(FINANCE_FIELDS))})""",
                [branch["id"], year, mon] + values,
            )
    conn.commit()


# --- чтение ------------------------------------------------------------

def compute_remaining(conn, student_row):
    if not student_row["subscription_type_id"]:
        return None
    type_row = conn.execute(
        "SELECT classes_count FROM subscription_types WHERE id=?",
        (student_row["subscription_type_id"],),
    ).fetchone()
    if not type_row or type_row["classes_count"] is None:
        return None
    cycle_start = student_row["cycle_start"] or "0000-00-00"
    count = conn.execute(
        "SELECT COUNT(*) AS c FROM attendance WHERE student_id=? AND status='present' AND session_date>=?",
        (student_row["id"], cycle_start),
    ).fetchone()["c"]
    return type_row["classes_count"] - count


def _parse_year_month(iso_date):
    """«2026-06-15» -> (2026, 6). Пустая или битая строка -> None."""
    try:
        d = datetime.strptime(str(iso_date)[:10], "%Y-%m-%d")
    except (ValueError, TypeError):
        return None
    return (d.year, d.month)


def _sessions_by_coach_month(conn):
    """{(coach_id, branch_id, год, месяц): проведено групповых занятий}.
    Занятие считается проведённым, если на эту дату у группы есть хоть одна отметка.
    Индивидуальные сюда не входят — они считаются отдельно, процентом."""
    rows = conn.execute(
        """
        SELECT g.coach_id AS coach_id, g.branch_id AS branch_id,
               CAST(strftime('%Y', a.session_date) AS INTEGER) AS y,
               CAST(strftime('%m', a.session_date) AS INTEGER) AS m,
               COUNT(DISTINCT a.group_id || '|' || a.session_date) AS sessions
        FROM attendance a
        JOIN class_groups g ON a.group_id = g.id
        WHERE g.coach_id IS NOT NULL AND g.is_individual = 0
        GROUP BY g.coach_id, g.branch_id, y, m
        """
    ).fetchall()
    return {(r["coach_id"], r["branch_id"], r["y"], r["m"]): r["sessions"] for r in rows}


def _visits_by_coach_month(conn):
    """{(coach_id, branch_id, год, месяц): посещений групповых занятий}.
    Одно посещение — один ученик, отмеченный «Пришёл» или «Разовое» на занятии
    этого тренера: тренер проводит занятие одинаково, независимо от того,
    списывается визит с абонемента ученика или оплачен отдельно."""
    rows = conn.execute(
        """
        SELECT g.coach_id AS coach_id, g.branch_id AS branch_id,
               CAST(strftime('%Y', a.session_date) AS INTEGER) AS y,
               CAST(strftime('%m', a.session_date) AS INTEGER) AS m,
               COUNT(*) AS visits
        FROM attendance a
        JOIN class_groups g ON a.group_id = g.id
        WHERE g.coach_id IS NOT NULL AND g.is_individual = 0 AND a.status IN ('present', 'dropin')
        GROUP BY g.coach_id, g.branch_id, y, m
        """
    ).fetchall()
    return {(r["coach_id"], r["branch_id"], r["y"], r["m"]): r["visits"] for r in rows}


def _individual_by_coach_month(conn):
    """{(coach_id, branch_id, год, месяц): (сколько занятий, на какую сумму)}.
    Тренер закреплён за самой отметкой: одно индивидуальное занятие может
    провести любой тренер, независимо от того, чья это группа в расписании."""
    rows = conn.execute(
        """
        SELECT a.coach_id AS coach_id, g.branch_id AS branch_id,
               CAST(strftime('%Y', a.session_date) AS INTEGER) AS y,
               CAST(strftime('%m', a.session_date) AS INTEGER) AS m,
               COUNT(*) AS lessons, SUM(COALESCE(a.lesson_price, 0)) AS revenue
        FROM attendance a
        JOIN class_groups g ON a.group_id = g.id
        WHERE g.is_individual = 1 AND a.coach_id IS NOT NULL AND a.status = 'present'
        GROUP BY a.coach_id, g.branch_id, y, m
        """
    ).fetchall()
    return {(r["coach_id"], r["branch_id"], r["y"], r["m"]): (r["lessons"], r["revenue"] or 0) for r in rows}


def _salary_context(conn):
    return {
        "coaches": [dict(r) for r in conn.execute("SELECT * FROM coaches ORDER BY name COLLATE NOCASE")],
        "sessions": _sessions_by_coach_month(conn),
        "visits": _visits_by_coach_month(conn),
        "individual": _individual_by_coach_month(conn),
        "entries": {
            (r["coach_id"], r["year"], r["month"]): dict(r)
            for r in conn.execute("SELECT * FROM salary_entries")
        },
        "branches": [r["id"] for r in conn.execute("SELECT id FROM branches ORDER BY sort_order, name")],
    }


def compute_salaries(conn, year, month, ctx=None):
    """Начисления по сотрудникам за месяц с разбивкой по филиалам.

    Групповые занятия. Ставка за посещение: ставка × количество отметок «Пришёл».
    Ставка за занятие: количество проведённых занятий × ставка. Оклад: сумма
    целиком на закреплённый филиал.

    Индивидуальные занятия считаются отдельно и прибавляются к любому из
    способов: тренер получает свой процент от стоимости каждого проведённого
    занятия. Поэтому один тренер спокойно ведёт и группы, и индивидуальные.

    Ручная сумма (override) заменяет расчётную, премия прибавляется сверху.
    """
    ctx = ctx or _salary_context(conn)
    now = datetime.now()
    is_future = (year, month) > (now.year, now.month)
    out = []
    for coach in ctx["coaches"]:
        by_branch = {b: ctx["sessions"].get((coach["id"], b, year, month), 0) for b in ctx["branches"]}
        visits_by_branch = {b: ctx["visits"].get((coach["id"], b, year, month), 0) for b in ctx["branches"]}
        total_sessions = sum(by_branch.values())
        total_visits = sum(visits_by_branch.values())
        rate = coach["rate"] or 0
        # Оклад — только за отработанные месяцы: не раньше даты приёма и не в будущем.
        # Дата приёма не указана — считаем с текущего месяца, чтобы не выдумывать расходы задним числом.
        if coach["rate_type"] == "monthly":
            hired = _parse_year_month(coach["hired_from"]) or (now.year, now.month)
            group_pay = 0 if (is_future or (year, month) < hired) else rate
        elif coach["rate_type"] == "per_student":
            group_pay = rate * total_visits
        else:
            group_pay = rate * total_sessions

        # Индивидуальные: процент от стоимости каждого проведённого занятия.
        share = (coach["individual_share"] or 0) / 100
        ind_by_branch = {}
        ind_pay_by_branch = {}
        ind_lessons = ind_revenue = 0
        for b in ctx["branches"]:
            lessons, revenue = ctx["individual"].get((coach["id"], b, year, month), (0, 0))
            ind_by_branch[b] = lessons
            ind_pay_by_branch[b] = revenue * share
            ind_lessons += lessons
            ind_revenue += revenue
        individual_pay = ind_revenue * share
        computed = group_pay + individual_pay

        entry = ctx["entries"].get((coach["id"], year, month), {})
        override = entry.get("override")
        bonus = entry.get("bonus") or 0
        total = (computed if override is None else override) + bonus

        # Расход делится между филиалами по тому, где человек эти деньги заработал:
        # групповые — по нагрузке, индивидуальные — по месту проведения занятия.
        earned = dict(ind_pay_by_branch)
        shares = visits_by_branch if coach["rate_type"] == "per_student" else by_branch
        shares_total = sum(shares.values())
        if coach["rate_type"] == "monthly":
            home = coach["branch_id"] or (ctx["branches"][0] if ctx["branches"] else None)
            if home:
                earned[home] = earned.get(home, 0) + group_pay
        elif shares_total:
            for b, n in shares.items():
                if n:
                    earned[b] = earned.get(b, 0) + group_pay * n / shares_total

        # Премия и ручная сумма раскладываются в той же пропорции, что и заработок.
        earned_total = sum(earned.values())
        dist = {}
        if earned_total:
            for b, amount in earned.items():
                if amount:
                    dist[b] = total * amount / earned_total
        elif total:
            home = coach["branch_id"] or (ctx["branches"][0] if ctx["branches"] else None)
            if home:
                dist[home] = total

        out.append(
            {
                **coach,
                "sessions": total_sessions,
                "sessionsByBranch": by_branch,
                "visits": total_visits,
                "visitsByBranch": visits_by_branch,
                "groupPay": group_pay,
                "individualLessons": ind_lessons,
                "individualByBranch": ind_by_branch,
                "individualRevenue": round(ind_revenue, 2),
                "individualPay": round(individual_pay, 2),
                "computed": computed,
                "override": override,
                "bonus": bonus,
                "total": total,
                "paid": bool(entry.get("paid")),
                "entryNote": entry.get("note") or "",
                "byBranch": dist,
            }
        )
    return out


def finance_facts(conn):
    """Фактические суммы из платежей и зарплат: {(филиал, год, месяц): {поле: сумма}}."""
    facts = {}
    for r in conn.execute(
        """
        SELECT branch_id,
               CAST(strftime('%Y', payment_date) AS INTEGER) AS y,
               CAST(strftime('%m', payment_date) AS INTEGER) AS m,
               SUM(amount) AS total
        FROM payments GROUP BY branch_id, y, m
        """
    ):
        facts.setdefault((r["branch_id"], r["y"], r["m"]), {})["income_subs"] = r["total"]

    ctx = _salary_context(conn)
    months = {(r["year"], r["month"]) for r in conn.execute("SELECT DISTINCT year, month FROM finance_entries")}
    months |= {(k[2], k[3]) for k in ctx["sessions"]}
    for year, month in months:
        for row in compute_salaries(conn, year, month, ctx):
            field = "expense_coaches" if row["role"] == "Тренер" else "expense_admins"
            for branch_id, amount in row["byBranch"].items():
                if amount:
                    slot = facts.setdefault((branch_id, year, month), {})
                    slot[field] = slot.get(field, 0) + amount
    return facts


def _ensure_fact_months(conn, facts):
    """Месяц, в котором были платежи или начислены зарплаты, появляется в
    финансах сам. Иначе деньги лежат в базе, а на экран их вывести некуда.
    Возвращает True, если что-то добавили."""
    before = conn.total_changes
    for (branch_id, year, month), values in facts.items():
        if any(values.values()):
            conn.execute(
                "INSERT OR IGNORE INTO finance_entries (branch_id, year, month) VALUES (?, ?, ?)",
                (branch_id, year, month),
            )
    if conn.total_changes == before:
        return False
    conn.commit()
    return True


def _last_individual_coach(conn):
    """{ученик: тренер последнего индивидуального занятия} — чтобы при записи
    нового занятия тренер подставлялся сам."""
    return {
        r["student_id"]: r["coach_id"]
        for r in conn.execute(
            """SELECT a.student_id, a.coach_id, MAX(a.session_date)
               FROM attendance a JOIN class_groups g ON g.id = a.group_id
               WHERE g.is_individual = 1 AND a.coach_id IS NOT NULL
               GROUP BY a.student_id"""
        )
    }


def _student_history(conn):
    """Посещения и платежи по каждому ученику — одним запросом, без обхода по одному."""
    visits = {
        r["student_id"]: (r["n"], r["last"])
        for r in conn.execute(
            "SELECT student_id, COUNT(*) n, MAX(session_date) last "
            "FROM attendance WHERE status IN ('present', 'dropin') GROUP BY student_id"
        )
    }
    payments = {
        r["student_id"]: (r["n"], r["total"])
        for r in conn.execute("SELECT student_id, COUNT(*) n, SUM(amount) total FROM payments GROUP BY student_id")
    }
    return visits, payments, _last_individual_coach(conn)


def _activity(manual_status, last_visit, today):
    """Ходит ли человек на самом деле — по отметкам посещаемости, а не по ручной пометке."""
    if not last_visit:
        return "Не начал", None
    try:
        days = (today - datetime.strptime(last_visit, "%Y-%m-%d").date()).days
    except ValueError:
        return "Не начал", None
    if manual_status == "Ушёл" or days >= LOST_AFTER_DAYS:
        return "Пропал", days
    if days >= QUIET_AFTER_DAYS:
        return "Затих", days
    return "Ходит", days


def _student_json(
    conn, row, type_names, visits=None, payments=None, today=None,
    last_coach=None, directions=None,
):
    d = dict(row)
    own_directions = list((directions or {}).get(row["id"], []))
    if not own_directions and d.get("direction"):
        own_directions = [d["direction"]]
    d["directions"] = own_directions
    d["direction"] = ", ".join(own_directions)
    d["start"] = d.pop("join_date")
    d["until"] = d.pop("until_date")
    d["plan"] = type_names.get(d["subscription_type_id"], "") if d["subscription_type_id"] else ""
    d["remaining"] = compute_remaining(conn, row)
    d["lessonPrice"] = _lesson_price(conn, row["id"])  # подставится в индивидуальное занятие

    visit_count, last_visit = (visits or {}).get(row["id"], (0, None))
    pay_count, paid_total = (payments or {}).get(row["id"], (0, 0))
    d["visits"] = visit_count
    d["lastVisit"] = last_visit
    d["paymentsCount"] = pay_count
    d["paidTotal"] = round(paid_total or 0, 2)
    d["renewed"] = pay_count >= 2  # второй платёж = человек продлил на самом деле
    d["activity"], d["daysSinceVisit"] = _activity(d["status"], last_visit, today or date.today())
    d["lastIndividualCoach"] = (last_coach or {}).get(row["id"])
    return d


def read_state(user=None):
    """Данные для интерфейса. Администратору не отдаём ни ставок, ни финансов —
    их нет в ответе сервера, а не просто спрятаны в интерфейсе."""
    is_owner = (user or {}).get("role", "owner") == "owner"
    conn = get_conn()
    try:
        if user and user.get("id"):
            fresh = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            if fresh:
                user = _user_json(fresh)
                is_owner = user["role"] == "owner"
        branches = [dict(r) for r in conn.execute("SELECT * FROM branches ORDER BY sort_order, name")]
        types = [dict(r) for r in conn.execute("SELECT * FROM subscription_types ORDER BY name")]
        type_names = {t["id"]: t["name"] for t in types}
        coaches = [dict(r) for r in conn.execute("SELECT * FROM coaches ORDER BY name COLLATE NOCASE")]
        if not is_owner:
            hidden = ("rate", "rate_type", "individual_share", "hired_from", "note")
            coaches = [{k: v for k, v in c.items() if k not in hidden} for c in coaches]
        groups = []
        for r in conn.execute("SELECT * FROM class_groups ORDER BY weekdays, time"):
            g = dict(r)
            g["weekdays"] = [int(x) for x in g["weekdays"].split(",") if x != ""]
            groups.append(g)

        student_directions = {}
        for r in conn.execute(
            """SELECT student_id, direction FROM student_directions
               ORDER BY student_id, sort_order, direction COLLATE NOCASE"""
        ):
            student_directions.setdefault(r["student_id"], []).append(r["direction"])

        payments = [
            dict(r)
            for r in conn.execute(
                """SELECT p.*, s.name AS student_name FROM payments p
                   LEFT JOIN students s ON p.student_id = s.id
                   ORDER BY p.payment_date DESC, p.id DESC"""
            )
        ]
        facts = finance_facts(conn) if is_owner else {}
        # Зарплаты считаются по месяцам, которые уже есть в финансах, поэтому
        # для только что появившегося месяца пересчитываем ещё раз.
        if is_owner and _ensure_fact_months(conn, facts):
            facts = finance_facts(conn)
        visits, pay_map, last_coach = _student_history(conn)
        today = date.today()

        result_branches = []
        for branch in branches:
            student_rows = conn.execute(
                "SELECT * FROM students WHERE branch_id=? ORDER BY name COLLATE NOCASE", (branch["id"],)
            ).fetchall()
            students = [
                _student_json(
                    conn, r, type_names, visits, pay_map, today, last_coach,
                    student_directions,
                )
                for r in student_rows
            ]

            month_rows = (
                conn.execute(
                    "SELECT * FROM finance_entries WHERE branch_id=? ORDER BY year, month", (branch["id"],)
                ).fetchall()
                if is_owner
                else []
            )
            months = []
            for m in month_rows:
                md = dict(m)
                md["label"] = f"{MONTHS_RU[md['month'] - 1]} {md['year']}"
                fact = facts.get((branch["id"], md["year"], md["month"]), {})
                for field in AUTO_FINANCE_FIELDS:
                    value = round(fact.get(field, 0), 2) or None
                    md[field] = value
                    md[f"fact_{field}"] = value
                months.append(md)

            result_branches.append({**branch, "students": students, "months": months})

        export_exists = os.path.exists(xlsx_io.EXPORT_PATH)
        export_updated = (
            datetime.fromtimestamp(os.path.getmtime(xlsx_io.EXPORT_PATH)).strftime("%d.%m.%Y %H:%M")
            if export_exists
            else None
        )
        return {
            "updated": datetime.now().strftime("%d.%m.%Y %H:%M"),
            "statuses": STATUSES,
            "weekdays": WEEKDAYS,
            "branches": result_branches,
            "subscriptionTypes": types,
            "coaches": coaches,
            "groups": groups,
            "payments": payments,
            "roles": ROLES,
            "activities": ACTIVITY,
            "quietAfterDays": QUIET_AFTER_DAYS,
            "exportFile": xlsx_io.EXPORT_FILENAME if export_exists else None,
            "exportUpdated": export_updated,
            "user": user,
            "users": list_users(conn) if is_owner else [],
            "userRoles": [{"id": r, "title": ROLE_TITLES[r]} for r in USER_ROLES],
        }
    finally:
        conn.close()


def read_salaries(year, month):
    conn = get_conn()
    try:
        rows = compute_salaries(conn, year, month)
        return {
            "year": year,
            "month": month,
            "label": f"{MONTHS_RU[month - 1]} {year}",
            "rows": rows,
            "total": round(sum(r["total"] for r in rows), 2),
            "totalPaid": round(sum(r["total"] for r in rows if r["paid"]), 2),
        }
    finally:
        conn.close()


def read_attendance_marks(date_str):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT group_id, student_id, status, coach_id, lesson_price FROM attendance WHERE session_date=?",
            (date_str,),
        ).fetchall()
        marks = {}
        for r in rows:
            marks.setdefault(str(r["group_id"]), {})[str(r["student_id"])] = {
                "status": r["status"],
                "coach_id": r["coach_id"],
                "price": r["lesson_price"],
            }
        return marks
    finally:
        conn.close()


# --- запись --------------------------------------------------------------

def _clean_text(value):
    return str(value or "").strip()


def _clean_directions(payload):
    raw = payload.get("directions")
    if raw is None:
        raw = [payload.get("direction")]
    elif isinstance(raw, str):
        raw = raw.split(",")
    result = []
    seen = set()
    for value in raw:
        direction = _clean_text(value)
        key = direction.casefold()
        if direction and key not in seen:
            seen.add(key)
            result.append(direction)
    return result


def _clean_share(value):
    """Доля тренера за индивидуальное занятие: 0–100 процентов или ничего."""
    if value in (None, ""):
        return None
    try:
        share = float(value)
    except (TypeError, ValueError):
        raise ValueError("Процент за индивидуальные укажите числом")
    if not 0 <= share <= 100:
        raise ValueError("Процент за индивидуальные должен быть от 0 до 100")
    return share


def _clean_term(payload):
    """(дни, месяцы) — задан ровно один из них, второй None."""
    months = payload.get("validity_months")
    if months not in (None, ""):
        return None, int(months)
    days = payload.get("validity_days")
    return (int(days) if days not in (None, "") else None), None


def _clean_student_payload(payload):
    directions = _clean_directions(payload)
    return {
        "name": _clean_text(payload.get("name")),
        "phone": _clean_text(payload.get("phone")),
        "direction": directions[0] if directions else "",
        "directions": directions,
        "join_date": _clean_text(payload.get("start")),
        "subscription_type_id": payload.get("subscription_type_id") or None,
        "price": payload.get("price"),
        "cycle_start": _clean_text(payload.get("cycle_start")),
        "until_date": _clean_text(payload.get("until")),
        "status": payload.get("status") if payload.get("status") in STATUSES else STATUSES[0],
        "source": _clean_text(payload.get("source")),
        "note": _clean_text(payload.get("note")),
    }


def _sync_student_directions(conn, student_id, directions):
    conn.execute("DELETE FROM student_directions WHERE student_id=?", (student_id,))
    conn.executemany(
        """INSERT INTO student_directions (student_id, direction, sort_order)
           VALUES (?, ?, ?)""",
        [(student_id, direction, index) for index, direction in enumerate(directions)],
    )


def _assign_coach_groups(conn, coach_id, group_ids):
    """Синхронизирует привязку тренера к группам расписания по списку id групп."""
    conn.execute("UPDATE class_groups SET coach_id = NULL WHERE coach_id = ?", (coach_id,))
    group_ids = [int(g) for g in group_ids]
    if group_ids:
        placeholders = ",".join("?" * len(group_ids))
        conn.execute(
            f"UPDATE class_groups SET coach_id = ? WHERE id IN ({placeholders})",
            [coach_id] + group_ids,
        )


def next_year_month(branch_id, conn):
    row = conn.execute(
        "SELECT year, month FROM finance_entries WHERE branch_id=? ORDER BY year DESC, month DESC LIMIT 1",
        (branch_id,),
    ).fetchone()
    if not row:
        now = datetime.now()
        return now.year, now.month
    year, month = row["year"], row["month"]
    month += 1
    if month > 12:
        month, year = 1, year + 1
    return year, month


def apply_action(action, payload, user=None):
    role = (user or {}).get("role", "owner")
    if role != "owner" and action not in ADMIN_ACTIONS:
        raise AccessDenied("Это может делать только владелец панели")
    conn = get_conn()
    try:
        if action == "student.create":
            student = _clean_student_payload(payload["student"])
            if not student["name"]:
                raise ValueError("Укажите имя ученика")
            cur = conn.execute(
                """INSERT INTO students
                   (branch_id, name, phone, direction, join_date, subscription_type_id,
                    price, cycle_start, until_date, status, source, note)
                   VALUES (:branch_id, :name, :phone, :direction, :join_date, :subscription_type_id,
                           :price, :cycle_start, :until_date, :status, :source, :note)""",
                {**student, "branch_id": payload["branch"]},
            )
            _sync_student_directions(conn, cur.lastrowid, student["directions"])

        elif action == "student.update":
            student = _clean_student_payload(payload["student"])
            if not student["name"]:
                raise ValueError("Укажите имя ученика")
            target_branch = payload.get("target") or payload["branch"]
            student_id = int(payload["id"])
            existing = conn.execute("SELECT id FROM students WHERE id=?", (student_id,)).fetchone()
            if not existing:
                raise KeyError("Запись не найдена")
            conn.execute(
                """UPDATE students SET
                     branch_id=:branch_id, name=:name, phone=:phone, direction=:direction,
                     join_date=:join_date, subscription_type_id=:subscription_type_id, price=:price,
                     cycle_start=:cycle_start, until_date=:until_date, status=:status,
                     source=:source, note=:note
                   WHERE id=:id""",
                {**student, "branch_id": target_branch, "id": student_id},
            )
            _sync_student_directions(conn, student_id, student["directions"])

        elif action == "student.delete":
            conn.execute("DELETE FROM students WHERE id=?", (int(payload["id"]),))

        elif action == "subtype.create":
            conn.execute(
                "INSERT INTO subscription_types (name, classes_count, validity_days, validity_months, price, active) "
                "VALUES (?, ?, ?, ?, ?, 1)",
                (
                    _clean_text(payload.get("name")) or "Без названия",
                    payload.get("classes_count"),
                    *_clean_term(payload),
                    payload.get("price"),
                ),
            )

        elif action == "subtype.update":
            conn.execute(
                "UPDATE subscription_types SET name=?, classes_count=?, validity_days=?, validity_months=?, "
                "price=?, active=? WHERE id=?",
                (
                    _clean_text(payload.get("name")) or "Без названия",
                    payload.get("classes_count"),
                    *_clean_term(payload),
                    payload.get("price"),
                    1 if payload.get("active", True) else 0,
                    int(payload["id"]),
                ),
            )

        elif action == "subtype.delete":
            conn.execute("UPDATE students SET subscription_type_id=NULL WHERE subscription_type_id=?", (int(payload["id"]),))
            conn.execute("DELETE FROM subscription_types WHERE id=?", (int(payload["id"]),))

        elif action == "subtype.recalc_until":
            type_id = int(payload["id"])
            type_row = conn.execute(
                "SELECT validity_days, validity_months FROM subscription_types WHERE id=?", (type_id,)
            ).fetchone()
            if not type_row:
                raise KeyError("Вид абонемента не найден")
            if not type_row["validity_days"] and not type_row["validity_months"]:
                raise ValueError("У этого вида абонемента не задан срок действия")
            rows = conn.execute(
                "SELECT id, cycle_start FROM students WHERE subscription_type_id=? AND cycle_start<>''",
                (type_id,),
            ).fetchall()
            updated = 0
            for row in rows:
                try:
                    cycle_start = datetime.strptime(row["cycle_start"], "%Y-%m-%d").date()
                except ValueError:
                    continue
                until = term_end(cycle_start, type_row["validity_days"], type_row["validity_months"])
                conn.execute(
                    "UPDATE students SET until_date=? WHERE id=?",
                    (until.strftime("%Y-%m-%d"), row["id"]),
                )
                updated += 1
            conn.commit()
            result = read_state(user)
            result["recalcCount"] = updated
            return result

        elif action == "group.create":
            weekdays = ",".join(str(int(w)) for w in payload.get("weekdays") or [])
            if not weekdays:
                raise ValueError("Выберите хотя бы один день недели")
            conn.execute(
                """INSERT INTO class_groups (branch_id, direction, weekdays, time, hall, coach_id, is_individual, active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    payload["branch"],
                    _clean_text(payload.get("direction")),
                    weekdays,
                    _clean_text(payload.get("time")),
                    _clean_text(payload.get("hall")),
                    payload.get("coach_id") or None,
                    1 if payload.get("is_individual") else 0,
                ),
            )

        elif action == "group.update":
            weekdays = ",".join(str(int(w)) for w in payload.get("weekdays") or [])
            if not weekdays:
                raise ValueError("Выберите хотя бы один день недели")
            conn.execute(
                """UPDATE class_groups SET branch_id=?, direction=?, weekdays=?, time=?, hall=?,
                     coach_id=?, is_individual=?, active=? WHERE id=?""",
                (
                    payload["branch"],
                    _clean_text(payload.get("direction")),
                    weekdays,
                    _clean_text(payload.get("time")),
                    _clean_text(payload.get("hall")),
                    payload.get("coach_id") or None,
                    1 if payload.get("is_individual") else 0,
                    1 if payload.get("active", True) else 0,
                    int(payload["id"]),
                ),
            )

        elif action == "group.delete":
            conn.execute("DELETE FROM class_groups WHERE id=?", (int(payload["id"]),))

        elif action == "coach.create":
            cur = conn.execute(
                """INSERT INTO coaches
                     (name, phone, note, role, rate_type, rate, individual_share, branch_id, hired_from, active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    _clean_text(payload.get("name")) or "Без имени",
                    _clean_text(payload.get("phone")),
                    _clean_text(payload.get("note")),
                    payload.get("role") if payload.get("role") in ROLES else ROLES[0],
                    payload.get("rate_type") if payload.get("rate_type") in RATE_TYPES else RATE_TYPES[0],
                    payload.get("rate"),
                    _clean_share(payload.get("individual_share")),
                    payload.get("branch") or None,
                    _clean_text(payload.get("hired_from")),
                ),
            )
            _assign_coach_groups(conn, cur.lastrowid, payload.get("groupIds") or [])

        elif action == "coach.update":
            coach_id = int(payload["id"])
            conn.execute(
                """UPDATE coaches SET name=?, phone=?, note=?, role=?, rate_type=?, rate=?,
                     individual_share=?, branch_id=?, hired_from=?, active=? WHERE id=?""",
                (
                    _clean_text(payload.get("name")) or "Без имени",
                    _clean_text(payload.get("phone")),
                    _clean_text(payload.get("note")),
                    payload.get("role") if payload.get("role") in ROLES else ROLES[0],
                    payload.get("rate_type") if payload.get("rate_type") in RATE_TYPES else RATE_TYPES[0],
                    payload.get("rate"),
                    _clean_share(payload.get("individual_share")),
                    payload.get("branch") or None,
                    _clean_text(payload.get("hired_from")),
                    1 if payload.get("active", True) else 0,
                    coach_id,
                ),
            )
            _assign_coach_groups(conn, coach_id, payload.get("groupIds") or [])

        elif action == "coach.delete":
            conn.execute("DELETE FROM coaches WHERE id=?", (int(payload["id"]),))

        elif action == "payment.create":
            amount = payload.get("amount")
            if amount in (None, "") or float(amount) <= 0:
                raise ValueError("Укажите сумму платежа")
            student_id = int(payload["student_id"])
            row = conn.execute("SELECT branch_id, subscription_type_id FROM students WHERE id=?", (student_id,)).fetchone()
            if not row:
                raise KeyError("Ученик не найден")
            conn.execute(
                """INSERT INTO payments (student_id, branch_id, subscription_type_id, amount, payment_date, note)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    student_id,
                    row["branch_id"],
                    payload.get("subscription_type_id") or row["subscription_type_id"],
                    float(amount),
                    _clean_text(payload.get("payment_date")) or datetime.now().strftime("%Y-%m-%d"),
                    _clean_text(payload.get("note")),
                ),
            )

        elif action == "payment.delete":
            conn.execute("DELETE FROM payments WHERE id=?", (int(payload["id"]),))

        elif action == "salary.update":
            coach_id = int(payload["coach_id"])
            year, month = int(payload["year"]), int(payload["month"])
            conn.execute(
                """INSERT INTO salary_entries (coach_id, year, month, bonus, override, paid, note)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(coach_id, year, month) DO UPDATE SET
                     bonus=excluded.bonus, override=excluded.override,
                     paid=excluded.paid, note=excluded.note""",
                (
                    coach_id,
                    year,
                    month,
                    payload.get("bonus"),
                    payload.get("override"),
                    1 if payload.get("paid") else 0,
                    _clean_text(payload.get("note")),
                ),
            )

        elif action == "finance.recalc":
            branch_id = payload["branch"]
            conn.commit()
            facts = finance_facts(conn)
            # Месяц, в котором были платежи или занятия, но строки в финансах ещё нет,
            # иначе эти деньги нигде не видны.
            existing = {
                (r["year"], r["month"])
                for r in conn.execute("SELECT year, month FROM finance_entries WHERE branch_id=?", (branch_id,))
            }
            for (fact_branch, year, month) in facts:
                if fact_branch == branch_id and (year, month) not in existing:
                    conn.execute(
                        "INSERT OR IGNORE INTO finance_entries (branch_id, year, month) VALUES (?, ?, ?)",
                        (branch_id, year, month),
                    )
            rows = conn.execute(
                "SELECT id, year, month FROM finance_entries WHERE branch_id=?", (branch_id,)
            ).fetchall()
            updated = 0
            for row in rows:
                fact = facts.get((branch_id, row["year"], row["month"]), {})
                conn.execute(
                    """UPDATE finance_entries
                       SET income_subs=?, expense_coaches=?, expense_admins=?
                       WHERE id=?""",
                    (
                        round(fact.get("income_subs", 0), 2) or None,
                        round(fact.get("expense_coaches", 0), 2) or None,
                        round(fact.get("expense_admins", 0), 2) or None,
                        row["id"],
                    ),
                )
                updated += 1
            conn.commit()
            result = read_state(user)
            result["recalcCount"] = updated
            return result

        elif action == "attendance.mark":
            group_id = int(payload["group_id"])
            student_id = int(payload["student_id"])
            session_date = payload["date"]
            status = payload.get("status")
            group = conn.execute("SELECT is_individual FROM class_groups WHERE id=?", (group_id,)).fetchone()
            if not group:
                raise KeyError("Занятие не найдено")
            if not status:
                conn.execute(
                    "DELETE FROM attendance WHERE group_id=? AND student_id=? AND session_date=?",
                    (group_id, student_id, session_date),
                )
            elif not group["is_individual"]:
                conn.execute(
                    """INSERT INTO attendance (group_id, student_id, session_date, status, marked_at)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(group_id, student_id, session_date)
                       DO UPDATE SET status=excluded.status, marked_at=excluded.marked_at""",
                    (group_id, student_id, session_date, status, datetime.now().isoformat(timespec="seconds")),
                )
            else:
                # Индивидуальное занятие. Без тренера его не записать: иначе
                # непонятно, кому платить, и деньги потерялись бы молча.
                coach_id = payload.get("coach_id")
                if not coach_id:
                    raise ValueError("Выберите тренера, который провёл занятие")
                price = payload.get("lesson_price")
                if price in (None, ""):
                    price = _lesson_price(conn, student_id)
                conn.execute(
                    """INSERT INTO attendance
                         (group_id, student_id, session_date, status, marked_at, coach_id, lesson_price)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(group_id, student_id, session_date)
                       DO UPDATE SET status=excluded.status, marked_at=excluded.marked_at,
                                     coach_id=excluded.coach_id, lesson_price=excluded.lesson_price""",
                    (
                        group_id,
                        student_id,
                        session_date,
                        status,
                        datetime.now().isoformat(timespec="seconds"),
                        int(coach_id),
                        float(price) if price not in (None, "") else None,
                    ),
                )

        elif action == "finance.update":
            branch_id = payload["branch"]
            entry_id = int(payload["id"])
            field = payload["field"]
            if field not in FINANCE_FIELDS:
                raise KeyError(f"Неизвестное поле: {field}")
            if field in AUTO_FINANCE_FIELDS:
                raise ValueError("Эта статья считается сама — по платежам учеников и зарплатам")
            row = conn.execute(
                "SELECT id FROM finance_entries WHERE id=? AND branch_id=?", (entry_id, branch_id)
            ).fetchone()
            if not row:
                raise KeyError("Запись не найдена")
            conn.execute(f"UPDATE finance_entries SET {field}=? WHERE id=?", (payload.get("value"), entry_id))

        elif action == "finance.add_month":
            branch_id = payload["branch"]
            year, month = next_year_month(branch_id, conn)
            conn.execute(
                "INSERT OR IGNORE INTO finance_entries (branch_id, year, month) VALUES (?, ?, ?)",
                (branch_id, year, month),
            )

        elif action == "finance.delete_month":
            conn.execute("DELETE FROM finance_entries WHERE id=? AND branch_id=?", (int(payload["id"]), payload["branch"]))

        elif action == "user.create":
            login = _clean_text(payload.get("login")).lower()
            _check_login_free(conn, login)
            _check_password_rules(payload.get("password"))
            new_role = payload.get("user_role") if payload.get("user_role") in USER_ROLES else "admin"
            conn.execute(
                """INSERT INTO users (login, name, role, password_hash, active, created_at, must_change_password)
                   VALUES (?, ?, ?, ?, 1, ?, 0)""",
                (
                    login,
                    _clean_text(payload.get("name")) or login,
                    new_role,
                    hash_password(payload.get("password")),
                    datetime.now().strftime("%Y-%m-%d"),
                ),
            )

        elif action == "user.update":
            target_id = int(payload["id"])
            target = conn.execute("SELECT * FROM users WHERE id=?", (target_id,)).fetchone()
            if not target:
                raise KeyError("Пользователь не найден")
            login = _clean_text(payload.get("login")).lower()
            _check_login_free(conn, login, target_id)
            new_role = payload.get("user_role") if payload.get("user_role") in USER_ROLES else target["role"]
            active = 1 if payload.get("active", True) else 0
            # Себе доступ не забираем — иначе в панель будет не войти.
            if target_id == (user or {}).get("id") and (new_role != "owner" or not active):
                raise ValueError("Нельзя забрать доступ у самого себя")
            if target["role"] == "owner" and (new_role != "owner" or not active) and not _active_owners(conn, target_id):
                raise ValueError("Это последний владелец — сначала назначьте другого")
            conn.execute(
                "UPDATE users SET login=?, name=?, role=?, active=? WHERE id=?",
                (login, _clean_text(payload.get("name")) or login, new_role, active, target_id),
            )
            if _clean_text(payload.get("password")):
                _check_password_rules(payload.get("password"))
                conn.execute(
                    "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?",
                    (hash_password(payload.get("password")), target_id),
                )
                # Пароль сменили за человека — все его открытые входы закрываем.
                if target_id != (user or {}).get("id"):
                    conn.execute("DELETE FROM sessions WHERE user_id=?", (target_id,))

        elif action == "user.delete":
            target_id = int(payload["id"])
            if target_id == (user or {}).get("id"):
                raise ValueError("Нельзя удалить самого себя")
            target = conn.execute("SELECT role FROM users WHERE id=?", (target_id,)).fetchone()
            if target and target["role"] == "owner" and not _active_owners(conn, target_id):
                raise ValueError("Это последний владелец — сначала назначьте другого")
            conn.execute("DELETE FROM users WHERE id=?", (target_id,))

        elif action == "account.password":
            me = conn.execute("SELECT * FROM users WHERE id=?", ((user or {}).get("id"),)).fetchone()
            if not me:
                raise KeyError("Пользователь не найден")
            if not check_password(payload.get("current"), me["password_hash"]):
                raise ValueError("Текущий пароль указан неверно")
            _check_password_rules(payload.get("password"))
            conn.execute(
                "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?",
                (hash_password(payload.get("password")), me["id"]),
            )

        elif action == "system.export_xlsx":
            conn.commit()
            data = read_state()
            xlsx_io.export_to_xlsx(data)
            return read_state(user)

        else:
            raise KeyError(f"Неизвестное действие: {action}")

        conn.commit()
    finally:
        conn.close()
    return read_state(user)
