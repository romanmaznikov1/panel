# -*- coding: utf-8 -*-
"""Локальный сервер учёта студии «Пляски».

Источник данных — файл data/plyaski.sqlite3 (см. db.py). При первом запуске,
если базы ещё нет, а рядом с папкой app лежит .xlsx — данные переносятся
из него один раз. Дальше xlsx используется только как шаблон для кнопки
«Экспорт в Excel».
"""

import http.cookies
import json
import os
import sys
import threading
import time
import urllib.parse
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

# Часовой пояс задаём явно: арендованные серверы обычно живут по Гринвичу, и
# тогда занятие в 21:30 попало бы во вчерашний день, а зарплата — не в тот месяц.
os.environ.setdefault("TZ", "Asia/Yekaterinburg")
if hasattr(time, "tzset"):
    time.tzset()

sys.path.insert(0, APP_DIR)

import db  # noqa: E402
import xlsx_io  # noqa: E402

LOCK = threading.RLock()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".woff2": "font/woff2",
}

COOKIE_NAME = "plyaski_session"
SESSION_TTL = 180 * 24 * 3600  # полгода, чтобы не спрашивать пароль заново на телефоне

# Защита от подбора: после пяти промахов подряд вход отдыхает 15 минут.
# Считаем по паре «логин + компьютер, откуда стучатся»: иначе злоумышленник
# мог бы намеренно запирать владельцу вход, перебирая его логин со стороны.
MAX_ATTEMPTS = 5
LOCKOUT = 15 * 60
ATTEMPTS = {}  # (логин, адрес) -> (сколько промахов, время последнего)

# Панель открыта из интернета: PUBLIC=1 в systemd-юните. Включает cookie
# только-по-HTTPS и запрещает работу с паролем по умолчанию.
PUBLIC = os.environ.get("PUBLIC") == "1"

# Демо-стенд: DEMO=1. Панель открывается без логина и пароля — сразу под
# владельцем. Cookie DEMO_ROLE_COOKIE=admin переключает на вид администратора.
# Управление доступом и паролями в демо отключено, чтобы никто не закрыл
# стенд для остальных.
# Это репозиторий демо-стенда, поэтому режим включён по умолчанию; DEMO=0 — обычный вход.
DEMO = os.environ.get("DEMO", "1") == "1"
DEMO_ROLE_COOKIE = "plyaski_demo_role"


class Handler(BaseHTTPRequestHandler):
    server_version = "PlyaskiOps"

    def log_message(self, fmt, *args):  # тише в консоли
        pass

    def _send(self, code, body, content_type="application/json; charset=utf-8", cookie=None, cache="no-store"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, payload, cookie=None):
        self._send(code, json.dumps(payload, ensure_ascii=False), cookie=cookie)

    # --- вход ------------------------------------------------------------

    def _token(self):
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie") or "")
        except http.cookies.CookieError:
            return None
        return jar[COOKIE_NAME].value if COOKIE_NAME in jar else None

    def _user(self):
        """Кто прислал запрос. Права читаются из базы каждый раз — если доступ
        отключили или сменили роль, это действует сразу."""
        with LOCK:
            user = db.session_user(self._token(), SESSION_TTL)
            if not user and DEMO:
                role = "admin" if self._demo_role() == "admin" else "owner"
                user = db.first_user(role)
            return user

    def _demo_role(self):
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie") or "")
        except http.cookies.CookieError:
            return None
        return jar[DEMO_ROLE_COOKIE].value if DEMO_ROLE_COOKIE in jar else None

    def _over_https(self):
        return PUBLIC or self.headers.get("X-Forwarded-Proto") == "https"

    def _cookie(self, token=None):
        """Cookie входа. За HTTPS добавляем Secure — тогда браузер не отправит
        её по незашифрованному соединению."""
        parts = [f"{COOKIE_NAME}={token or ''}", "Path=/", "HttpOnly", "SameSite=Lax"]
        parts.append(f"Max-Age={SESSION_TTL}" if token else "Max-Age=0")
        if self._over_https():
            parts.append("Secure")
        return "; ".join(parts)

    def _client(self):
        forwarded = self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",")[0].strip() or self.client_address[0]

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return None

    def _locked_for(self, key):
        """Сколько секунд с этого компьютера ещё нельзя пробовать войти."""
        misses, last = ATTEMPTS.get(key, (0, 0))
        if misses < MAX_ATTEMPTS:
            return 0
        left = LOCKOUT - (time.time() - last)
        if left <= 0:
            ATTEMPTS.pop(key, None)
            return 0
        return int(left)

    def _login(self):
        payload = self._body()
        if payload is None:
            self._json(400, {"error": "Некорректный запрос"})
            return
        login = str(payload.get("login") or "").strip().lower()
        key = (login, self._client())
        left = self._locked_for(key)
        if left:
            self._json(429, {"error": f"Слишком много попыток. Повторите через {left // 60 + 1} мин."})
            return
        with LOCK:
            user = db.authenticate(login, payload.get("password"))
        if not user:
            misses = ATTEMPTS.get(key, (0, 0))[0] + 1
            ATTEMPTS[key] = (misses, time.time())
            print(f"  неудачный вход: {login or '—'} с адреса {self._client()} (попытка {misses})")
            time.sleep(0.7)
            self._json(401, {"error": "Неверный логин или пароль"})
            return
        ATTEMPTS.pop(key, None)
        with LOCK:
            token = db.create_session(user["id"], SESSION_TTL)
        self._json(200, {"user": user}, cookie=self._cookie(token))

    def _logout(self):
        with LOCK:
            db.drop_session(self._token())
        self._json(200, {"ok": True}, cookie=self._cookie(None))

    def do_GET(self):
        path, _, query = self.path.partition("?")
        user = self._user() if path.startswith("/api/") else None
        if path.startswith("/api/") and not user:
            self._json(401, {"error": "Нужно войти в панель"})
            return
        if path == "/api/me":
            self._json(200, {"user": user, "demo": DEMO})
            return
        if path == "/api/state":
            with LOCK:
                try:
                    self._json(200, db.read_state(user))
                except Exception as exc:  # noqa: BLE001
                    self._json(500, {"error": str(exc)})
            return
        if path == "/api/salaries":
            if user["role"] != "owner":
                self._json(403, {"error": "Зарплаты видит только владелец"})
                return
            params = dict(pair.split("=", 1) for pair in query.split("&") if "=" in pair)
            now = datetime.now()
            with LOCK:
                try:
                    year = int(params.get("year") or now.year)
                    month = int(params.get("month") or now.month)
                    self._json(200, db.read_salaries(year, month))
                except Exception as exc:  # noqa: BLE001
                    self._json(500, {"error": str(exc)})
            return
        if path == "/api/export.xlsx":
            # Свежий отчёт отдаём файлом в браузер: когда панель на сервере,
            # положить его «рядом с панелью» уже недостаточно.
            if user["role"] != "owner":
                self._json(403, {"error": "Экспорт доступен только владельцу"})
                return
            with LOCK:
                try:
                    xlsx_io.export_to_xlsx(db.read_state())
                    with open(xlsx_io.EXPORT_PATH, "rb") as handle:
                        data = handle.read()
                except Exception as exc:  # noqa: BLE001
                    self._json(500, {"error": f"Не удалось собрать отчёт: {exc}"})
                    return
            name = urllib.parse.quote(xlsx_io.EXPORT_FILENAME)
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{name}")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/attendance":
            params = dict(pair.split("=", 1) for pair in query.split("&") if "=" in pair)
            date = params.get("date", "")
            with LOCK:
                try:
                    self._json(200, {"date": date, "marks": db.read_attendance_marks(date)})
                except Exception as exc:  # noqa: BLE001
                    self._json(500, {"error": str(exc)})
            return
        name = "index.html" if path == "/" else path.lstrip("/")
        target = os.path.normpath(os.path.join(STATIC_DIR, name))
        if not target.startswith(STATIC_DIR) or not os.path.isfile(target):
            self._json(404, {"error": "not found"})
            return
        ext = os.path.splitext(target)[1]
        # Шрифты не меняются — пусть телефон скачает их один раз, а не при
        # каждом открытии панели. Всё остальное по-прежнему без кэша: так
        # правки панели видны сразу.
        cache = "public, max-age=31536000, immutable" if ext == ".woff2" else "no-store"
        with open(target, "rb") as handle:
            self._send(200, handle.read(), CONTENT_TYPES.get(ext, "application/octet-stream"), cache=cache)

    def do_POST(self):
        if self.path == "/api/login":
            self._login()
            return
        if self.path == "/api/logout":
            self._logout()
            return
        if self.path != "/api/action":
            self._json(404, {"error": "not found"})
            return
        user = self._user()
        if not user:
            self._json(401, {"error": "Нужно войти в панель"})
            return
        payload = self._body()
        if payload is None:
            self._json(400, {"error": "Некорректный запрос"})
            return
        if DEMO and str(payload.get("action") or "").startswith(("user.", "account.")):
            self._json(403, {"error": "В демо пароли и доступы не меняются"})
            return
        with LOCK:
            try:
                self._json(200, db.apply_action(payload.get("action"), payload, user))
            except db.AccessDenied as exc:
                self._json(403, {"error": str(exc)})
            except (IndexError, KeyError) as exc:
                message = exc.args[0] if exc.args else ""
                self._json(409, {"error": str(message) or "Запись изменилась — панель обновлена, повторите действие"})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except FileNotFoundError as exc:
                self._json(404, {"error": str(exc)})
            except PermissionError:
                self._json(423, {"error": "Файл занят другой программой — закройте его и повторите"})
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": f"Не удалось сохранить: {exc}"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def daily_backup():
    """Копия базы раз в сутки — чтобы потеря сервера не была потерей данных."""
    try:
        path = db.backup_db()
        if path:
            print(f"  копия базы: {os.path.basename(path)}")
    except Exception as exc:  # noqa: BLE001
        print(f"  не удалось сделать копию базы: {exc}")
    timer = threading.Timer(24 * 3600, daily_backup)
    timer.daemon = True
    timer.start()


def main():
    db.ensure_db()
    port = int(os.environ.get("PORT", "8777"))
    # По умолчанию панель доступна только с этого компьютера. HOST=0.0.0.0
    # открывает её для локальной сети — например, для стойки администратора.
    host = os.environ.get("HOST", "127.0.0.1")
    exposed = PUBLIC or host != "127.0.0.1"

    # Наружу — только со своим паролем. Иначе панель откроется любому, кто
    # прочитает эту инструкцию.
    if exposed and db.owner_password_is_default():
        print("\n  Панель не запущена: у владельца всё ещё пароль по умолчанию.")
        print("  Откройте панель локально, смените пароль и повторите.\n")
        raise SystemExit(1)

    daily_backup()
    url = f"http://127.0.0.1:{port}/"
    httpd = Server((host, port), Handler)
    print("\n  Студия «Пляски» — панель учёта")
    print(f"  Открыто: {url}")
    print(f"  База:    {db.DB_PATH}")
    print(f"  Время:   {datetime.now().strftime('%d.%m.%Y %H:%M')} ({os.environ.get('TZ')})")
    source = xlsx_io.source_workbook_path()
    if source:
        print(f"  Шаблон для экспорта: {source}")
    if db.owner_password_is_default():
        print(f"\n  Первый вход: логин {db.DEFAULT_OWNER_LOGIN}, пароль {db.DEFAULT_OWNER_PASSWORD}")
        print("  Смените пароль в панели: «Справочники» → «Доступ».")
    if DEMO:
        print("\n  Демо-режим: вход без логина и пароля, сразу вид владельца.")
    elif exposed:
        print("\n  Панель доступна не только с этого компьютера — вход только по логину и паролю.")
    print("\n  Чтобы закрыть панель — нажмите Ctrl+C в этом окне.\n")
    if not exposed:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Панель закрыта. Данные сохранены в базе.\n")


if __name__ == "__main__":
    main()
