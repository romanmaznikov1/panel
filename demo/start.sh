#!/bin/sh
# Запуск демо-стенда на Railway (или любом сервере).
# 1) собираем свежие демо-данные на сегодня;
# 2) каждую ночь в 04:00 по Екатеринбургу пересобираем их заново —
#    всё, что нажали на показе, стирается, вчерашние занятия отмечены;
# 3) запускаем панель на порту, который выдал хостинг.
export TZ=Asia/Yekaterinburg
cd "$(dirname "$0")/.."

python3 demo/generate_demo.py

(
  while true; do
    sleep "$(python3 -c 'from datetime import datetime, timedelta
n = datetime.now(); t = (n + timedelta(days=1)).replace(hour=4, minute=0, second=0, microsecond=0)
print(int((t - n).total_seconds()))')"
    python3 demo/generate_demo.py
  done
) &

export HOST=0.0.0.0
export PUBLIC=1
export DEMO=1   # без логина и пароля: сразу вид владельца
exec python3 app/server.py
