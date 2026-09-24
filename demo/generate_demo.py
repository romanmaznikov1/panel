# -*- coding: utf-8 -*-
"""Демо-стенд панели для студии «Пляски» (Екатеринбург).

Создаёт с нуля plyaski/data/plyaski.sqlite3 с правдоподобной историей за
последние ~7 месяцев: три студии, педагоги, группы по расписанию, ученики,
пробные занятия, абонементы и продления, отметки посещаемости, разовые и
индивидуальные занятия, зарплаты и расходы по месяцам.

Все люди, телефоны и суммы (кроме цен абонементов с сайта) — вымышленные.

Запуск (из папки plyaski):
    python3 demo/generate_demo.py
Повторный запуск пересоздаёт базу и «сдвигает» историю к сегодняшнему дню —
удобно перед показом, чтобы вчерашние занятия были отмечены, а сегодняшние нет.
"""

import os
import random
import sys
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "app"))
import db  # noqa: E402

random.seed(2706)

TODAY = date.today()
END = TODAY - timedelta(days=1)                 # отмечено всё по вчерашний день
START = (TODAY.replace(day=1) - timedelta(days=170)).replace(day=1)  # ~7 месяцев истории

# --- справочники -------------------------------------------------------------

BRANCHES = [
    ("Ирбитская", "Ирбитская 13"),
    ("Уральская", "Уральская 5"),
    ("Космонавтов", "Космонавтов 9А"),
]

# name, classes, validity_days, validity_months, price
PLANS = [
    ("4 занятия", 4, None, 1, 3900),
    ("8 занятий", 8, None, 1, 5900),
    ("12 занятий", 12, None, 1, 6900),
    ("Пробное занятие", 1, 14, None, 0),
    ("Разовое занятие", 1, 14, None, 800),
    ("Индивидуальные · 1 занятие", 1, None, 1, 2000),
    # Взрослое направление: пробное 490 ₽ — с сайта, цены абонементов — примерные.
    ("Взрослые · пробное", 1, 14, None, 490),
    ("Взрослые · 4 занятия", 4, None, 1, 2900),
    ("Взрослые · 8 занятий", 8, None, 1, 4600),
    ("Взрослые · 12 занятий", 12, None, 1, 5900),
]

# name, role, rate_type, rate, individual_share, branch, hired_from, phone
COACHES = [
    ("Жимердей Александра", "Тренер", "per_student", 200, 50, "Ирбитская", "2024-09-01", "+7 912 245-18-33"),
    ("Шипкова Юлия", "Тренер", "per_class", 650, 50, "Ирбитская", "2024-09-01", "+7 922 413-60-72"),
    ("Заболотных Кристина", "Тренер", "per_student", 200, 50, "Уральская", "2025-01-15", "+7 950 206-91-45"),
    ("Клюсова Дарья", "Тренер", "per_class", 600, 50, "Космонавтов", "2025-09-01", "+7 919 638-27-10"),
    ("Сафина Гульнара", "Тренер", "per_class", 700, None, "Ирбитская", "2025-09-01", "+7 912 870-44-19"),
    ("Ковалёва Анастасия", "Тренер", "per_student", 250, None, "Уральская", "2025-10-01", "+7 904 318-52-67"),
    ("Мингазова Алина", "Администратор", "monthly", 30000, None, "Ирбитская", "2025-09-01", "+7 982 609-65-17"),
    ("Лаптева Софья", "Администратор", "monthly", 25000, None, "Уральская", "2025-09-01", "+7 908 912-40-36"),
]
KIDS_COACHES = ["Жимердей Александра", "Шипкова Юлия", "Заболотных Кристина", "Клюсова Дарья"]

# branch, direction, weekdays (0=Пн), time, hall, coach, adult, base size
GROUPS = [
    ("Ирбитская", "Детский танец 3–4 года", "0,2", "11:00", "Основной", "Шипкова Юлия", False, 9),
    ("Ирбитская", "Ритмика 3–4 года", "1,3", "17:30", "Малый", "Шипкова Юлия", False, 8),
    ("Ирбитская", "Эстрадный танец 5–7 лет", "0,2", "17:30", "Основной", "Жимердей Александра", False, 12),
    ("Ирбитская", "Современный танец 8–10 лет", "0,2", "18:30", "Основной", "Жимердей Александра", False, 11),
    ("Ирбитская", "Классический танец 5–8 лет", "1,3", "18:30", "Основной", "Шипкова Юлия", False, 9),
    ("Ирбитская", "Эстрадный танец 11–14 лет", "1,3", "19:30", "Основной", "Жимердей Александра", False, 10),
    ("Ирбитская", "Растяжка", "0,2", "20:00", "Малый", "Сафина Гульнара", True, 8),
    ("Ирбитская", "Пилатес", "1,3", "10:00", "Основной", "Сафина Гульнара", True, 7),
    ("Ирбитская", "Женские танцы", "1,3", "20:30", "Малый", "Ковалёва Анастасия", True, 8),
    ("Ирбитская", "Кардио", "5", "10:00", "Основной", "Ковалёва Анастасия", True, 7),
    ("Уральская", "Детский танец 3–4 года", "1,3", "11:00", "Основной", "Заболотных Кристина", False, 8),
    ("Уральская", "Эстрадный танец 5–7 лет", "1,3", "17:30", "Основной", "Заболотных Кристина", False, 11),
    ("Уральская", "Современный танец 8–10 лет", "1,3", "18:30", "Основной", "Клюсова Дарья", False, 10),
    ("Уральская", "Базовая акробатика 6–9 лет", "0,2", "17:30", "Основной", "Клюсова Дарья", False, 9),
    ("Уральская", "ОФП и растяжка 7–12 лет", "5", "12:00", "Основной", "Шипкова Юлия", False, 8),
    ("Уральская", "Здоровая спина", "1,3", "19:30", "Основной", "Сафина Гульнара", True, 7),
    ("Уральская", "Силовая", "0,2", "19:30", "Основной", "Ковалёва Анастасия", True, 7),
    ("Уральская", "Растяжка", "5", "11:00", "Малый", "Сафина Гульнара", True, 7),
    ("Уральская", "Женские танцы", "4", "19:30", "Основной", "Ковалёва Анастасия", True, 6),
    ("Космонавтов", "Детский танец 3–4 года", "0,2", "11:00", "Основной", "Клюсова Дарья", False, 8),
    ("Космонавтов", "Ритмика 3–4 года", "1,4", "17:30", "Основной", "Клюсова Дарья", False, 7),
    ("Космонавтов", "Эстрадный танец 5–7 лет", "0,2", "17:30", "Основной", "Заболотных Кристина", False, 11),
    ("Космонавтов", "Современный танец 8–10 лет", "1,4", "18:30", "Основной", "Жимердей Александра", False, 9),
]

# Сезон детской студии: весной полные группы, летом дачи и лагеря, в сентябре набор.
# Масштаб наполняемости: подобран так, чтобы три студии вместе приносили
# в среднем около 500 тыс. ₽ в месяц.
SIZE_SCALE = 0.56

SEASON_SIZE = {1: 0.95, 2: 1.0, 3: 1.0, 4: 1.0, 5: 0.95, 6: 0.75, 7: 0.55, 8: 0.7, 9: 1.15, 10: 1.1, 11: 1.05, 12: 1.0}
SEASON_ATTEND = {6: 0.85, 7: 0.75, 8: 0.85}
SEASON_RENEW = {5: 0.84, 6: 0.76, 7: 0.7, 8: 0.86, 9: 0.94}
SEASON_TRIALS = {6: 0.5, 7: 0.35, 8: 1.6, 9: 3.5}

SOURCES = [
    ("Сарафанное радио", 26), ("Вконтакте", 18), ("Чат ЖК", 16), ("Увидели студию в ЖК", 12),
    ("Яндекс Карты", 9), ("2gis", 6), ("Листовки в детском саду", 7), ("Сайт", 4), ("Telegram", 2),
]

GIRLS = ["Амина", "Алсу", "Камила", "Эвелина", "София", "Милана", "Ева", "Алиса", "Дарина", "Ясмина",
         "Аделина", "Ралина", "Самира", "Злата", "Варвара", "Василиса", "Вероника", "Полина", "Арина",
         "Мария", "Анастасия", "Виктория", "Азалия", "Айлин", "Лейсан", "Эмилия", "Сафия", "Малика",
         "Кира", "Ульяна", "Таисия", "Мирослава", "Элина", "Ариана", "Зарина", "Диана", "Алёна", "Ксения"]
BOYS = ["Тимур", "Артём", "Марсель", "Карим", "Амир", "Даниил", "Эмиль"]
WOMEN = ["Алина", "Гульнара", "Эльвира", "Резеда", "Ольга", "Екатерина", "Лилия", "Айгуль", "Светлана",
         "Юлия", "Ирина", "Наиля", "Татьяна", "Альбина", "Римма", "Марина", "Гузель", "Наталья"]
MOMS = ["Лилия", "Алина", "Гульназ", "Эльмира", "Анна", "Регина", "Айгуль", "Ольга", "Динара", "Чулпан",
        "Елена", "Рамиля", "Юлия", "Ляйсан", "Екатерина"]
SURNAMES_F = ["Гарипова", "Хабибуллина", "Сафиуллина", "Галиева", "Иванова", "Петрова", "Шарипова",
              "Закирова", "Нуриева", "Миннахметова", "Валиева", "Смирнова", "Кузнецова", "Мухаметова",
              "Ахметова", "Фаттахова", "Садыкова", "Зиннатуллина", "Хасанова", "Каримова", "Морозова",
              "Волкова", "Абдуллина", "Исмагилова", "Гильмутдинова", "Сабирова", "Латыпова", "Федорова",
              "Николаева", "Мингалиева", "Юсупова", "Габдрахманова", "Соколова", "Тимофеева", "Хайруллина"]

used_names = set()


def person(adult=False, boy=False):
    for _ in range(200):
        surname = random.choice(SURNAMES_F)
        if boy:
            first, surname = random.choice(BOYS), surname[:-1]
        else:
            first = random.choice(WOMEN if adult else GIRLS)
        name = f"{first} {surname}"
        if name not in used_names:
            used_names.add(name)
            return name, surname
    raise RuntimeError("закончились имена")


def phone():
    return f"+7 9{random.choice(['12','22','50','82','04','08','19','53'])} {random.randint(100,999)}-{random.randint(10,99)}-{random.randint(10,99)}"


def weighted(pairs):
    total = sum(w for _, w in pairs)
    x = random.uniform(0, total)
    for value, w in pairs:
        x -= w
        if x <= 0:
            return value
    return pairs[-1][0]


def daterange(a, b):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


def iso(d):
    return d.isoformat()


# --- база --------------------------------------------------------------------

def build():
    if os.path.exists(db.DB_PATH):
        os.remove(db.DB_PATH)
    for suffix in ("-wal", "-shm", "-journal"):
        if os.path.exists(db.DB_PATH + suffix):
            os.remove(db.DB_PATH + suffix)
    conn = db.get_conn()
    conn.executescript(db.SCHEMA)
    conn.commit()
    db._migrate_add_columns(conn)
    db._migrate_validity_months(conn)

    for i, (bid, name) in enumerate(BRANCHES):
        conn.execute("INSERT INTO branches (id, name, sort_order) VALUES (?, ?, ?)", (bid, name, i))

    plan_ids = {}
    for name, classes, vd, vm, price in PLANS:
        cur = conn.execute(
            "INSERT INTO subscription_types (name, classes_count, validity_days, validity_months, price, active) VALUES (?,?,?,?,?,1)",
            (name, classes, vd, vm, price),
        )
        plan_ids[name] = cur.lastrowid
    plan_by_id = {plan_ids[p[0]]: p for p in PLANS}

    coach_ids = {}
    for name, role, rtype, rate, share, branch, hired, ph in COACHES:
        note = "Администратор студий, ведёт запись и оплаты" if role == "Администратор" else ""
        cur = conn.execute(
            """INSERT INTO coaches (name, phone, note, role, rate_type, rate, individual_share, branch_id, hired_from, active)
               VALUES (?,?,?,?,?,?,?,?,?,1)""",
            (name, ph, note, role, rtype, rate, share, branch, hired),
        )
        coach_ids[name] = cur.lastrowid

    groups = []
    for branch, direction, wd, tm, hall, coach, adult, size in GROUPS:
        cur = conn.execute(
            "INSERT INTO class_groups (branch_id, direction, weekdays, time, hall, coach_id, is_individual, active) VALUES (?,?,?,?,?,?,0,1)",
            (branch, direction, wd, tm, hall, coach_ids[coach]),
        )
        groups.append({
            "id": cur.lastrowid, "branch": branch, "direction": direction,
            "days": {int(x) for x in wd.split(",")}, "adult": adult, "size": size * SIZE_SCALE, "coach": coach,
        })
    db._ensure_individual_groups(conn)
    ind_group = {r["branch_id"]: r["id"] for r in conn.execute("SELECT id, branch_id FROM class_groups WHERE is_individual=1")}

    # --- ученики и их жизнь по дням -------------------------------------------
    students = []  # dict со всем состоянием

    def new_student(group, day, initial=False):
        adult = group["adult"]
        boy = (not adult) and random.random() < 0.08
        name, surname = person(adult=adult, boy=boy)
        dirs = [group]
        if random.random() < (0.18 if adult else 0.14):
            others = [g for g in groups if g["branch"] == group["branch"] and g["adult"] == adult and g is not group]
            if others:
                dirs.append(random.choice(others))
        note = ""
        if not adult:
            note = f"Мама — {random.choice(MOMS)}"
            if random.random() < 0.12:
                note += ". Аллергия на пыль, без акробатики на полу" if random.random() < 0.3 else ". Забирает бабушка"
        elif random.random() < 0.15:
            note = random.choice(["Протрузия L5 — без скручиваний", "После родов, 6 мес.", "Хочет утренние группы",
                                  "Пришла с подругой", "Колено — без прыжков"])
        st = {
            "name": name, "surname": surname, "branch": group["branch"], "groups": dirs, "adult": adult,
            "phone": phone(), "source": weighted(SOURCES) if random.random() < 0.9 else "",
            "note": note, "attend": random.uniform(0.72, 0.96), "loyal": random.uniform(-0.12, 0.1),
            "join": day, "state": "trial", "plan": None, "cycle_start": None, "until": None,
            "used": 0, "payments": [], "status": "Активен", "own_price": None, "trial_done": False,
            "gone_on": None, "renewals": 0,
        }
        if initial:
            # Пришли ещё до начала истории: сразу с абонементом, дата старта — чуть позже.
            st["join"] = START - timedelta(days=random.randint(20, 420))
            st["state"] = "wait"
            st["wait_until"] = START + timedelta(days=random.randint(0, 27))
            st["trial_done"] = True
        if not adult and random.random() < 0.1:
            st["own_price_factor"] = 0.9  # второй ребёнок в семье
            st["note"] = (st["note"] + ". " if st["note"] else "") + "Скидка 10% — ходит сестра"
        students.append(st)
        return st

    def pick_plan(st):
        per_week = sum(len(g["days"]) for g in st["groups"])
        if st["adult"]:
            if per_week >= 2:
                return weighted([("Взрослые · 8 занятий", 60), ("Взрослые · 12 занятий", 15), ("Взрослые · 4 занятия", 25)])
            return weighted([("Взрослые · 4 занятия", 75), ("Взрослые · 8 занятий", 25)])
        if per_week >= 4:
            return weighted([("12 занятий", 6), ("8 занятий", 4)])
        if per_week >= 2:
            return weighted([("8 занятий", 62), ("4 занятия", 20), ("12 занятий", 18)])
        return weighted([("4 занятия", 80), ("8 занятий", 20)])

    def start_cycle(st, day, renewal):
        plan = st["plan"] if (renewal and random.random() < 0.8) else pick_plan(st)
        name, classes, vd, vm, price = next(p for p in PLANS if p[0] == plan)
        amount = price
        if st.get("own_price_factor"):
            amount = round(price * st["own_price_factor"])
            st["own_price"] = amount
        st["plan"] = plan
        st["cycle_start"] = day
        st["until"] = db.term_end(day, vd, vm)
        st["used"] = 0
        st["state"] = "active"
        note = "Продление" if renewal else ""
        if random.random() < 0.06:
            note = (note + ", " if note else "") + "перевод на карту"
        st["payments"].append((day, amount, plan_ids[plan], note))
        if renewal:
            st["renewals"] += 1

    attendance = []   # (group_id, student_id_idx, date, status, coach_id, price)
    session_days = set()

    def active_count(group, day):
        return sum(1 for s in students if group in s["groups"] and s["state"] in ("active", "trial", "decide", "wait"))

    # стартовый состав
    for g in groups:
        for _ in range(round(g["size"] * SEASON_SIZE[START.month] * random.uniform(0.85, 1.05))):
            new_student(g, START, initial=True)

    # индивидуальные ученики — готовятся к конкурсам
    individuals = []
    for _ in range(7):
        branch = random.choice(BRANCHES)[0]
        name, surname = person()
        coach = random.choice(KIDS_COACHES)
        individuals.append({
            "name": name, "branch": branch, "coach": coach, "phone": phone(),
            "weekday": random.choice([4, 5, 6]), "from": START + timedelta(days=random.randint(0, 120)),
            "note": f"Мама — {random.choice(MOMS)}. Сольный номер к конкурсу, педагог {coach.split()[1]}",
            "lessons": [],
        })

    dropin_pool = []  # взрослые, которые ходят разово

    for day in daterange(START, END):
        wd = day.weekday()
        m = day.month
        # новые пробные
        for g in groups:
            if wd not in g["days"]:
                continue
            target = g["size"] * SEASON_SIZE[m]
            gap = target - active_count(g, day)
            p = 0.07 * SEASON_TRIALS.get(m, 1.0) + max(0, gap) * 0.05 * SEASON_TRIALS.get(m, 1.0)
            if random.random() < p:
                new_student(g, day)
        for st in students:
            if st["state"] in ("gone", "left_trial"):
                continue
            todays = [g for g in st["groups"] if wd in g["days"]]
            if st["state"] == "wait":
                if day >= st["wait_until"] and todays:
                    start_cycle(st, day, renewal=False)
                else:
                    continue
            if st["state"] == "decide":
                if not todays:
                    continue
                renew_p = SEASON_RENEW.get(m, 0.88) + st["loyal"]
                if random.random() < renew_p:
                    start_cycle(st, day, renewal=True)
                else:
                    st["state"] = "gone"
                    st["gone_on"] = day
                    continue
            for g in todays:
                if st["state"] == "trial":
                    if day < st["join"]:
                        continue
                    attendance.append((g["id"], st, day, "present", None, None))
                    session_days.add((g["id"], day))
                    st["trial_date"] = day
                    st["trial_done"] = True
                    if st["adult"]:  # у взрослых первое занятие платное — 490 ₽
                        trial = next(p for p in PLANS if p[0] == "Взрослые · пробное")
                        st["payments"].append((day, trial[4], plan_ids[trial[0]], "Первое занятие"))
                    conv = {6: 0.5, 7: 0.45, 9: 0.78}.get(m, 0.66)
                    if random.random() < conv:
                        st["state"] = "wait"
                        st["wait_until"] = day + timedelta(days=random.randint(1, 5))
                    else:
                        st["state"] = "left_trial"
                        st["gone_on"] = day
                    break
                if st["state"] != "active":
                    break
                if day > st["until"] or st["used"] >= next(p for p in PLANS if p[0] == st["plan"])[1]:
                    st["state"] = "decide"
                    break
                p = st["attend"] * SEASON_ATTEND.get(m, 1.0)
                if random.random() < p:
                    attendance.append((g["id"], st, day, "present", None, None))
                    st["used"] += 1
                    session_days.add((g["id"], day))
                elif random.random() < 0.55:
                    attendance.append((g["id"], st, day, "absent", None, None))
            if st["state"] == "active":
                cls = next(p for p in PLANS if p[0] == st["plan"])[1]
                if st["used"] >= cls or day >= st["until"]:
                    st["state"] = "decide"

        # разовые визиты взрослых
        for g in groups:
            if g["adult"] and wd in g["days"] and random.random() < 0.22:
                if dropin_pool and random.random() < 0.6:
                    guest = random.choice(dropin_pool)
                    if guest["branch"] != g["branch"]:
                        continue
                else:
                    name, surname = person(adult=True)
                    guest = {"name": name, "branch": g["branch"], "phone": phone(), "visits": [], "dropin": True,
                             "source": weighted(SOURCES), "direction": g}
                    dropin_pool.append(guest)
                guest["visits"].append((g, day))

        # индивидуальные
        for ind in individuals:
            if day >= ind["from"] and wd == ind["weekday"] and random.random() < (0.55 if m in (7, 8) else 0.85):
                ind["lessons"].append(day)

    # --- запись в базу ---------------------------------------------------------
    def insert_student(branch, name, ph, dirs, join, plan_id, price, cycle, until, status, source, note):
        cur = conn.execute(
            """INSERT INTO students (branch_id, name, phone, direction, join_date, subscription_type_id, price,
                                     cycle_start, until_date, status, source, note)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (branch, name, ph, dirs[0] if dirs else "", iso(join), plan_id, price, cycle, until, status, source, note),
        )
        sid = cur.lastrowid
        for i, d in enumerate(dirs):
            conn.execute("INSERT INTO student_directions (student_id, direction, sort_order) VALUES (?,?,?)", (sid, d, i))
        return sid

    def marked(day):
        return datetime.combine(day, datetime.min.time()).replace(hour=random.randint(11, 20), minute=random.randint(0, 59)).isoformat(timespec="seconds")

    for st in students:
        dirs = [g["direction"] for g in st["groups"]]
        if st["plan"]:
            plan_id = plan_ids[st["plan"]]
            cycle, until = iso(st["cycle_start"]), iso(st["until"])
        else:
            plan_id = plan_ids["Взрослые · пробное" if st["adult"] else "Пробное занятие"]
            td = st.get("trial_date") or st["join"]
            cycle, until = iso(td), iso(td + timedelta(days=14))
        status = "Активен"
        if st["state"] in ("gone", "left_trial"):
            # Давно ушедших админ уже отметил. Свежие (последние 3 недели) ещё
            # числятся активными — их панель и подсветит: «Затих», «Абонемент на исходе».
            recent = (END - st["gone_on"]).days <= 21
            status = "Активен" if recent and random.random() < 0.8 else "Ушёл"
            if st["state"] == "gone" and random.random() < 0.3:
                st["note"] = (st["note"] + ". " if st["note"] else "") + random.choice(
                    ["Уехали на лето", "Перешли в спорт. гимнастику", "Далеко возить", "Вернутся в сентябре?"])
        elif st["renewals"] >= 1 and random.random() < 0.6:
            status = "Продлил"
        join = st["join"] if st["plan"] or st.get("trial_date") else st["join"]
        if not st["plan"] and not st.get("trial_date"):
            # записался на пробное, но ещё не дошёл — пусть висит как «Не начал»
            pass
        st["id"] = insert_student(st["branch"], st["name"], st["phone"], dirs, st.get("trial_date") or join,
                                  plan_id, st["own_price"], cycle, until, status, st["source"], st["note"])
        for day, amount, pid, note in st["payments"]:
            conn.execute(
                "INSERT INTO payments (student_id, branch_id, subscription_type_id, amount, payment_date, note) VALUES (?,?,?,?,?,?)",
                (st["id"], st["branch"], pid, amount, iso(day), note),
            )

    for gid, st, day, status, coach_id, price in attendance:
        conn.execute(
            "INSERT OR IGNORE INTO attendance (group_id, student_id, session_date, status, marked_at) VALUES (?,?,?,?,?)",
            (gid, st["id"], iso(day), status, marked(day)),
        )

    dropin_price = next(p for p in PLANS if p[0] == "Разовое занятие")[4]
    for guest in dropin_pool:
        first_g, first_day = guest["visits"][0]
        last_day = guest["visits"][-1][1]
        sid = insert_student(guest["branch"], guest["name"], guest["phone"], [], first_day,
                             plan_ids["Разовое занятие"], None, iso(last_day), iso(last_day + timedelta(days=14)),
                             "Активен", guest["source"], "Ходит разово, без абонемента")
        for g, day in guest["visits"]:
            conn.execute(
                "INSERT OR IGNORE INTO attendance (group_id, student_id, session_date, status, marked_at) VALUES (?,?,?,?,?)",
                (g["id"], sid, iso(day), "dropin", marked(day)),
            )
            conn.execute(
                "INSERT INTO payments (student_id, branch_id, subscription_type_id, amount, payment_date, note) VALUES (?,?,?,?,?,?)",
                (sid, guest["branch"], plan_ids["Разовое занятие"], dropin_price, iso(day), f"Разовое посещение · {g['direction']}"),
            )

    ind_price = next(p for p in PLANS if p[0] == "Индивидуальные · 1 занятие")[4]
    for ind in individuals:
        if not ind["lessons"]:
            continue
        last = ind["lessons"][-1]
        sid = insert_student(ind["branch"], ind["name"], ind["phone"], [], ind["lessons"][0],
                             plan_ids["Индивидуальные · 1 занятие"], None, iso(last), iso(db.add_months(last, 1)),
                             "Активен", "Сарафанное радио", ind["note"])
        for day in ind["lessons"]:
            conn.execute(
                """INSERT INTO attendance (group_id, student_id, session_date, status, marked_at, coach_id, lesson_price)
                   VALUES (?,?,?,?,?,?,?)""",
                (ind_group[ind["branch"]], sid, iso(day), "present", marked(day), coach_ids[ind["coach"]], ind_price),
            )
            conn.execute(
                "INSERT INTO payments (student_id, branch_id, subscription_type_id, amount, payment_date, note) VALUES (?,?,?,?,?,?)",
                (sid, ind["branch"], None, ind_price, iso(day), f"Индивидуальное занятие · {ind['coach']}"),
            )

    # --- зарплаты: прошлые месяцы выплачены, текущий — нет ----------------------
    months = []
    d = START
    while d <= END:
        if (d.year, d.month) not in months:
            months.append((d.year, d.month))
        d += timedelta(days=1)
    for (y, mo) in months:
        current = (y, mo) == (TODAY.year, TODAY.month)
        for name, cid in coach_ids.items():
            bonus, note = None, ""
            if mo == 5 and name in ("Жимердей Александра", "Шипкова Юлия", "Заболотных Кристина"):
                bonus, note = 5000, "Премия за отчётный концерт"
            if mo == 9 and name == "Мингазова Алина":
                bonus, note = 3000, "Премия за сентябрьский набор"
            conn.execute(
                "INSERT INTO salary_entries (coach_id, year, month, bonus, override, paid, note) VALUES (?,?,?,?,?,?,?)",
                (cid, y, mo, bonus, None, 0 if current else 1, note),
            )

    # --- ручные статьи финансов: аренда, реклама, костюмы, прочее ---------------
    rent = {"Ирбитская": 62000, "Уральская": 52000, "Космонавтов": 45000}
    for (y, mo) in months:
        current = (y, mo) == (TODAY.year, TODAY.month)
        for bid, _ in BRANCHES:
            ads = random.choice([2500, 3000, 4000, 5000])
            if mo in (8, 9):
                ads += 5000  # сентябрьский набор: таргет ВК + листовки
            merch = 0
            if mo == 5:
                merch = random.choice([9000, 12000, 15000])    # костюмы к отчётному концерту
            elif mo in (3, 4, 10, 11):
                merch = random.choice([0, 0, 3500, 5000])        # взносы за конкурсы
            other = random.choice([5500, 6400, 7200, 8300])    # коммуналка, уборка, вода, коврики, CRM
            income_rent = random.choice([None, None, 3000, 4500]) if bid == "Ирбитская" else None
            if current:
                other = round(other * TODAY.day / 30)
            conn.execute(
                """INSERT INTO finance_entries (branch_id, year, month, income_rent, expense_rent, expense_ads, expense_merch, expense_other)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (bid, y, mo, income_rent, rent[bid], ads, merch or None, other),
            )

    # --- пользователи панели -----------------------------------------------------
    now = datetime.now().strftime("%Y-%m-%d")
    conn.execute(
        "INSERT INTO users (login, name, role, password_hash, active, created_at, must_change_password) VALUES (?,?,?,?,1,?,0)",
        ("dilyara", "Диляра", "owner", db.hash_password("plyaski2026"), now),
    )
    conn.execute(
        "INSERT INTO users (login, name, role, password_hash, active, created_at, must_change_password) VALUES (?,?,?,?,1,?,0)",
        ("admin", "Алина, администратор", "admin", db.hash_password("admin2026"), now),
    )
    conn.commit()

    c = lambda q: conn.execute(q).fetchone()[0]
    print(f"История: {START} — {END}")
    print(f"Учеников в базе: {c('SELECT COUNT(*) FROM students')}")
    print(f"Отметок посещаемости: {c('SELECT COUNT(*) FROM attendance')}")
    print(f"Платежей: {c('SELECT COUNT(*) FROM payments')} на {c('SELECT SUM(amount) FROM payments'):,.0f} ₽".replace(",", " "))
    for row in conn.execute("SELECT substr(payment_date,1,7) m, SUM(amount) s, COUNT(*) n FROM payments GROUP BY m"):
        print(f"  {row['m']}: {row['s']:>9,.0f} ₽  ({row['n']} оплат)".replace(",", " "))
    conn.close()


if __name__ == "__main__":
    build()
