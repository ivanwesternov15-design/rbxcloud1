# AGENTS.md

## Deploy rules (важно)

Перед каждым пушем/деплоем обязательно обновлять версию деплоя:

1. `server.py` → `BUILD_VERSION` (строка ~55). Формат: `YYYYMMDD-<краткое-описание>-<номер>`.
   Пример: `20260803-rebalance-reset-1`.
2. `index.html` → параметры кэш-бастера `?v=` для всех скриптов
   (`/js/api.js`, `/js/auth.js`, `/js/app.js`) — выставить то же значение, что в `BUILD_VERSION`.

Только после этого коммитить и пушить. В логе при старте сервера выводится
`[ДЕПЛОЙ] Обновление принято. Текущая версия: <BUILD_VERSION>`.

## Проверки после изменений

- Python: `py -m py_compile server.py`
- JS: `node --check js/app.js`, inline-скрипт `admin.html` (извлечь `<script>` и проверить)

## Прочее

- `data/users.json` и бэкапы `data/users_backup_before_reset.json` загитнорены.
- Push на GitHub — только по явной команде пользователя («запушь на гит»).
