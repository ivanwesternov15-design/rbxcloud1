import http.server
import socketserver
import json
import os
import hashlib
import hmac
import time
import uuid
import threading
import re
import sys
from urllib.parse import urlparse, parse_qs, unquote

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
PORT = int(os.environ.get("PORT", "3000"))
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# Public base URL of the Mini App. Set BASE_URL in the BotHost env vars to your
# real HTTPS domain (e.g. https://clickerfarm.bothost.ru). Used in bot messages,
# logout and webhook setup.
BASE_URL = os.environ.get("BASE_URL", "https://bot-1785687837-1511-senku.bothost.tech")

# --- Color Logging ---
class Log:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN = "\033[96m"
    GRAY = "\033[90m"

def log_info(msg):
    print(f"{Log.CYAN}[ИНФО]{Log.RESET} {msg}", flush=True)

def log_ok(msg):
    print(f"{Log.GREEN}[ОК]{Log.RESET} {msg}", flush=True)

def log_warn(msg):
    print(f"{Log.YELLOW}[ПРЕДУПРЕЖДЕНИЕ]{Log.RESET} {msg}", flush=True)

def log_error(msg):
    print(f"{Log.RED}[ОШИБКА]{Log.RESET} {msg}", flush=True)

def log_success(msg):
    print(f"{Log.GREEN}[УСПЕХ]{Log.RESET} {msg}", flush=True)

def log_auth(msg):
    print(f"{Log.MAGENTA}[АВТОРИЗАЦИЯ]{Log.RESET} {msg}", flush=True)

def log_admin(msg):
    print(f"{Log.BLUE}[АДМИН]{Log.RESET} {msg}", flush=True)

def log_avatar(msg):
    print(f"{Log.CYAN}[АВАТАР]{Log.RESET} {msg}", flush=True)

def log_bot(msg):
    print(f"{Log.MAGENTA}[БОТ]{Log.RESET} {msg}", flush=True)

def log_request(msg):
    print(f"{Log.GRAY}[ЗАПРОС]{Log.RESET} {msg}", flush=True)

# File locks for thread safety
file_locks = {}
def get_lock(name):
    if name not in file_locks:
        file_locks[name] = threading.Lock()
    return file_locks[name]

# --- Server load tracking (admin "Нагрузка сервера") ---
LOAD_STATE = {"db_reads": 0, "db_writes": 0}
DB_OPS = {"reads": [], "writes": []}   # timestamps of recent db operations
REQUEST_LOG = []                        # [timestamp, duration_ms]
TOTAL_REQUESTS = 0
REQUEST_START_TIME = time.time()
_PROC_CPU_SAMPLE = {"t": 0.0, "cpu": None}
_SYS_CPU_SAMPLE = {"t": 0.0, "idle": None, "total": None}
_SYS_CPU_BASELINE = None

def _db_op(kind):
    now = time.time()
    lst = DB_OPS[kind]
    lst.append(now)
    cutoff = now - 60
    while lst and lst[0] < cutoff:
        lst.pop(0)
    if len(lst) > 20000:
        del lst[:len(lst) - 20000]

def _count_recent(lst, cutoff):
    n = 0
    for ts in lst:
        if ts >= cutoff:
            n += 1
    return n

# --- Data Load/Save ---
def load_json(filename):
    LOAD_STATE["db_reads"] = LOAD_STATE.get("db_reads", 0) + 1
    _db_op("reads")
    path = os.path.join(DATA_DIR, filename)
    if not os.path.exists(path):
        return {} if filename == "users.json" else []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except:
        return {} if filename == "users.json" else []

def save_json(filename, data):
    LOAD_STATE["db_writes"] = LOAD_STATE.get("db_writes", 0) + 1
    _db_op("writes")
    path = os.path.join(DATA_DIR, filename)
    with get_lock(filename):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

def load_config():
    return load_json("config.json")

def load_backgrounds():
    return load_json("backgrounds.json")

def load_cases():
    return load_json("cases.json")

def load_tasks():
    return load_json("tasks.json")

def load_vouchers():
    return load_json("vouchers.json")

def load_users():
    return load_json("users.json")

# --- Dashboard Stats ---
STATS_FILE = "stats.json"
ACTIVITY_LOG = {}  # date_str -> set of user_ids that logged in that day
ACTIVITY_LOG_HOURLY = {}  # hour_str -> set of user_ids that logged in that hour

def get_date_key(ts=None):
    ts = ts if ts is not None else time.time()
    return time.strftime("%Y-%m-%d", time.localtime(ts))

def get_hour_key(ts=None):
    ts = ts if ts is not None else time.time()
    return time.strftime("%Y-%m-%d %H", time.localtime(ts))

def record_login(user_id):
    """Track unique daily logins + unique hourly login counts for dashboard charts.

    A user is counted at most once per hour and once per day, so the numbers
    reflect real visitors and are not inflated by the frontend polling /api/user/get.
    """
    try:
        stats = load_json(STATS_FILE)
        if not isinstance(stats, dict):
            stats = {}
        stats.setdefault("logins_daily", {})
        stats.setdefault("logins_hourly", {})

        date_key = get_date_key()
        hour_key = get_hour_key()

        # Unique users per day (existing behavior)
        if date_key not in ACTIVITY_LOG:
            ACTIVITY_LOG[date_key] = set()
        activity_set = ACTIVITY_LOG[date_key]
        if str(user_id) not in activity_set:
            activity_set.add(str(user_id))
            stats["logins_daily"][date_key] = len(activity_set)

        # Unique users per hour
        if hour_key not in ACTIVITY_LOG_HOURLY:
            ACTIVITY_LOG_HOURLY[hour_key] = set()
        hour_activity = ACTIVITY_LOG_HOURLY[hour_key]
        if str(user_id) not in hour_activity:
            hour_activity.add(str(user_id))
            stats["logins_hourly"][hour_key] = len(hour_activity)

        # Per-user per-day and per-hour (unique within each period)
        uid = str(user_id)
        stats.setdefault("user_logins", {})
        stats.setdefault("user_logins_hourly", {})
        day_map = stats["user_logins"].setdefault(uid, {})
        if date_key not in day_map:
            day_map[date_key] = 1
        hour_map = stats["user_logins_hourly"].setdefault(uid, {})
        if hour_key not in hour_map:
            hour_map[hour_key] = 1

        save_json(STATS_FILE, stats)
    except Exception as e:
        log_error(f"Ошибка записи статистики: {e}")

def record_online_sample(count):
    """Track max online count per hour and per day for dashboard charts."""
    try:
        stats = load_json(STATS_FILE)
        if not isinstance(stats, dict):
            stats = {}
        stats.setdefault("online_hourly", {})
        stats.setdefault("online_daily", {})
        
        hour_key = get_hour_key()
        date_key = get_date_key()
        
        stats["online_hourly"][hour_key] = max(stats["online_hourly"].get(hour_key, 0), count)
        stats["online_daily"][date_key] = max(stats["online_daily"].get(date_key, 0), count)
        save_json(STATS_FILE, stats)
    except Exception as e:
        log_error(f"Ошибка записи онлайна: {e}")

def get_daily_logins():
    """Return list of (date, count) for the last 30 days."""
    stats = load_json(STATS_FILE) or {}
    logins = stats.get("logins_daily", {})
    result = []
    for i in range(29, -1, -1):
        date = time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400))
        result.append((date, logins.get(date, 0)))
    return result

def get_daily_online():
    stats = load_json(STATS_FILE) or {}
    online = stats.get("online_daily", {})
    result = []
    for i in range(29, -1, -1):
        date = time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400))
        result.append((date, online.get(date, 0)))
    return result

def get_hourly_logins():
    stats = load_json(STATS_FILE) or {}
    hourly = stats.get("logins_hourly", {})
    result = []
    now = time.time()
    for i in range(23, -1, -1):
        key = time.strftime("%Y-%m-%d %H", time.localtime(now - i * 3600))
        result.append((key, hourly.get(key, 0)))
    return result

def get_hourly_online():
    stats = load_json(STATS_FILE) or {}
    hourly = stats.get("online_hourly", {})
    result = []
    now = time.time()
    for i in range(23, -1, -1):
        key = time.strftime("%Y-%m-%d %H", time.localtime(now - i * 3600))
        result.append((key, hourly.get(key, 0)))
    return result

def _iter_dates(start_date, end_date):
    """Yield date strings (YYYY-MM-DD) inclusive from start to end."""
    from datetime import date, timedelta
    d = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    while d <= end:
        yield d.isoformat()
        d += timedelta(days=1)

def get_all_daily_logins():
    """All-time daily logins, spanning from the first user registration to today.

    Fills the gap before stats recording started: every registration counts as a
    login on that day (a new user necessarily logs in), and merges it with the
    recorded login stats.
    """
    stats = load_json(STATS_FILE) or {}
    logins = stats.get("logins_daily", {})
    users = load_users()

    reg_counts = {}
    for uid, u in users.items():
        ts = u.get("registered_at")
        if not ts:
            continue
        dk = time.strftime("%Y-%m-%d", time.localtime(ts))
        reg_counts[dk] = reg_counts.get(dk, 0) + 1

    # Earliest point: first registration OR earliest recorded stat, whichever is earlier
    all_dates = list(logins.keys()) + list(reg_counts.keys())
    today = get_date_key()
    if not all_dates:
        return [(today, 0)]
    start = min(all_dates)
    if start > today:
        start = today

    result = []
    for dk in _iter_dates(start, today):
        val = logins.get(dk, 0)
        if val < reg_counts.get(dk, 0):
            val = reg_counts.get(dk, 0)
        result.append((dk, val))
    return result

def get_all_daily_online():
    """All-time daily online (max online per day), spanning from the first
    recorded sample to today."""
    stats = load_json(STATS_FILE) or {}
    online = stats.get("online_daily", {})
    today = get_date_key()
    if not online:
        return [(today, 0)]
    start = min(online.keys())
    if start > today:
        start = today
    return [(dk, online.get(dk, 0)) for dk in _iter_dates(start, today)]

def get_all_hourly_logins():
    stats = load_json(STATS_FILE) or {}
    hourly = stats.get("logins_hourly", {})
    return sorted(hourly.items())

def get_all_hourly_online():
    stats = load_json(STATS_FILE) or {}
    hourly = stats.get("online_hourly", {})
    return sorted(hourly.items())

def get_user_daily_logins(user_id):
    stats = load_json(STATS_FILE) or {}
    ul = (stats.get("user_logins") or {}).get(str(user_id), {})
    result = []
    for i in range(29, -1, -1):
        date = time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400))
        result.append((date, ul.get(date, 0)))
    return result

def get_user_hourly_logins(user_id):
    stats = load_json(STATS_FILE) or {}
    ul = (stats.get("user_logins_hourly") or {}).get(str(user_id), {})
    result = []
    now = time.time()
    for i in range(23, -1, -1):
        key = time.strftime("%Y-%m-%d %H", time.localtime(now - i * 3600))
        result.append((key, ul.get(key, 0)))
    return result

# --- Telegram Auth ---
def check_telegram_auth(data, bot_token):
    data = data.copy()
    # parse_qs returns lists, extract scalars
    data = {k: (v[0] if isinstance(v, list) and len(v) > 0 else v) for k, v in data.items()}
    received_hash = data.pop("hash", None)
    if not received_hash:
        return False
    check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hashlib.sha256(bot_token.encode()).digest()
    computed_hash = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
    if computed_hash != received_hash:
        return False
    auth_date = int(data.get("auth_date", 0))
    if time.time() - auth_date > 86400:
        return False
    return True

def check_telegram_webapp_auth(init_data, bot_token):
    """Validate a Telegram Mini App `initData` string (WebApp HMAC-sha256)."""
    try:
        params = {}
        for part in init_data.split("&"):
            if "=" in part:
                k, v = part.split("=", 1)
                params[k] = unquote(v)
        received_hash = params.pop("hash", None)
        if not received_hash:
            return False
        check_string = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
        secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
        computed_hash = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
        if computed_hash != received_hash:
            return False
        auth_date = int(params.get("auth_date", 0))
        if time.time() - auth_date > 86400:
            return False
        return True
    except Exception:
        return False

def process_telegram_webapp_login(init_data):
    """Create/update the user from a validated Mini App initData, return (token, user_id)."""
    params = {}
    for part in init_data.split("&"):
        if "=" in part:
            k, v = part.split("=", 1)
            params[k] = unquote(v)
    try:
        user = json.loads(params.get("user", "{}"))
    except Exception:
        user = {}
    telegram_id = str(user.get("id", ""))
    if not telegram_id:
        return None, None

    user_data = {
        "id": telegram_id,
        "first_name": user.get("first_name", ""),
        "last_name": user.get("last_name", ""),
        "username": user.get("username", ""),
        "photo_url": user.get("photo_url", ""),
    }

    # Refresh the avatar in the background so fresh profile photos appear.
    threading.Thread(target=sync_avatar_from_telegram, args=(telegram_id,), daemon=True).start()

    users = load_users()
    if telegram_id in users:
        old = users[telegram_id]
        users[telegram_id]["first_name"] = user_data.get("first_name", old.get("first_name", ""))
        users[telegram_id]["last_name"] = user_data.get("last_name", old.get("last_name", ""))
        users[telegram_id]["username"] = user_data.get("username", old.get("username", ""))
    else:
        created = get_or_create_user(telegram_id, user_data)
        users[telegram_id] = created
        uname = user_data.get("username") or user_data.get("first_name") or telegram_id
        log_success(f"Новый пользователь зарегистрирован (Mini App): @{uname} (id: {telegram_id})")

    # Referral from start_param (ref_<id>)
    start_param = params.get("start_param", "")
    if start_param.startswith("ref_"):
        referrer_id = str(start_param[4:])
        if referrer_id and referrer_id != telegram_id:
            referrer = users.get(referrer_id, {})
            existing = referrer.get("referrals", [])
            new_user_data = users.get(telegram_id, {})
            if referrer and telegram_id not in existing and not new_user_data.get("referred_by"):
                config = load_config()
                bonus = config.get("game", {}).get("referral_bonus", 500)
                users[telegram_id]["coins"] = users[telegram_id].get("coins", 0) + bonus
                users[telegram_id]["total_earned"] = users[telegram_id].get("total_earned", 0) + bonus
                users[telegram_id]["referred_by"] = referrer_id

                ref_bonus = config.get("game", {}).get("referral_ref_bonus", 1500)
                users[referrer_id]["coins"] = users[referrer_id].get("coins", 0) + ref_bonus
                users[referrer_id]["total_earned"] = users[referrer_id].get("total_earned", 0) + ref_bonus
                users[referrer_id]["referrals"] = existing + [telegram_id]
                users[referrer_id]["referral_count"] = users[referrer_id].get("referral_count", 0) + 1
                users[referrer_id]["referral_active_count"] = users[referrer_id].get("referral_active_count", 0) + 1
                users[referrer_id]["referral_earned"] = users[referrer_id].get("referral_earned", 0) + ref_bonus

                PENDING_REFERRALS.pop(telegram_id, None)

    save_json("users.json", users)

    token = generate_token()
    set_session(token, telegram_id)
    return token, telegram_id

# --- Session Management ---
SESSIONS = {}  # token -> user_id
SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")
PENDING_REFERRALS = {}  # telegram_id -> referrer_id
ANTI_CHEAT = {}  # user_id -> last_click_time
LEADERBOARD_CACHE = {}  # sort -> (timestamp, payload)

def generate_token():
    return uuid.uuid4().hex + uuid.uuid4().hex

def load_sessions():
    """Load persisted sessions from disk so logins survive server restarts."""
    try:
        if os.path.exists(SESSIONS_FILE):
            with open(SESSIONS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    SESSIONS.update(data)
    except Exception as e:
        log_warn(f"Ошибка загрузки сессий: {e}")

def save_sessions():
    """Persist sessions to disk (so they survive server restarts)."""
    try:
        with get_lock("sessions.json"):
            with open(SESSIONS_FILE, "w", encoding="utf-8") as f:
                json.dump(SESSIONS, f, ensure_ascii=False)
    except Exception as e:
        log_warn(f"Ошибка сохранения сессий: {e}")

def set_session(token, user_id):
    SESSIONS[token] = user_id
    save_sessions()

def get_session_user(token):
    if token in SESSIONS:
        return SESSIONS[token]
    return None

# --- User Helpers ---
def get_or_create_user(telegram_id, user_data=None):
    users = load_users()
    telegram_id = str(telegram_id)
    config = load_config()
    
    if telegram_id not in users:
        users[telegram_id] = {
            "id": telegram_id,
            "first_name": (user_data or {}).get("first_name", ""),
            "last_name": (user_data or {}).get("last_name", ""),
            "username": (user_data or {}).get("username", ""),
            "photo_url": (user_data or {}).get("photo_url", ""),
            "photo_path": "",
            "registered_at": int(time.time()),
            "last_active": int(time.time()),
            "coins": 0,
            "total_earned": 0,
            "energy": config["game"]["base_max_energy"],
            "max_energy": config["game"]["base_max_energy"],
            "energy_regen": config["game"]["base_energy_regen"],
            "click_power": config["game"]["base_click_reward"],
            "passive_income": 0,
            "level": 1,
            "total_clicks": 0,
            "upgrades": {key: 0 for key in config.get("upgrades", {})},
            "last_passive": int(time.time()),
            "backgrounds": [],
            "active_background": None,
            "active_boosts": [],
            "referred_by": None,
            "referral_code": f"ref_{telegram_id}",
            "referrals": [],
            "referral_count": 0,
            "referral_active_count": 0,
            "referral_earned": 0,
            "completed_tasks": [],
            "cases_opened": 0,
            "exchange_count_today": 0,
            "exchange_history": [],
            "total_exchanged": 0,
            "last_daily": 0,
            "daily_streak": 0,
            "is_admin": False,
            "is_blocked": False,
            "suspicious_activity": [],
            "custom_title": "",
            "bio": "",
            "host": "",
            "music": "",
            "photo_file_id": "",
            "last_avatar_check": 0,
            "last_profile_check": 0
        }
        save_json("users.json", users)
    
    return users[telegram_id]

def save_user(telegram_id, user_data):
    users = load_users()
    users[str(telegram_id)] = user_data
    save_json("users.json", users)

def send_telegram_message(chat_id, text, parse_mode="HTML"):
    """Send a message via Telegram Bot API."""
    import urllib.request
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": parse_mode}).encode()
    try:
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5)
    except:
        pass

def sync_profile_from_telegram(telegram_id):
    """Fetch and update name/username/bio from Telegram in a background thread."""
    try:
        import urllib.request, json
        prof_req = urllib.request.Request(f"https://api.telegram.org/bot{BOT_TOKEN}/getChat?chat_id={telegram_id}")
        prof_resp = urllib.request.urlopen(prof_req, timeout=5)
        prof_data = json.loads(prof_resp.read().decode())
        if not prof_data.get("ok"):
            return
        chat = prof_data.get("result", {})
        users = load_users()
        user = users.get(str(telegram_id))
        if not user:
            return
        changed = False
        if chat.get("first_name") and chat.get("first_name") != user.get("first_name"):
            user["first_name"] = chat["first_name"]; changed = True
        if chat.get("last_name") != user.get("last_name"):
            user["last_name"] = chat.get("last_name", ""); changed = True
        if chat.get("username") and chat.get("username") != user.get("username"):
            user["username"] = chat["username"]; changed = True
        if chat.get("bio") and chat.get("bio") != user.get("bio"):
            user["bio"] = chat["bio"]; changed = True
        if changed:
            save_json("users.json", users)
    except Exception as e:
        log_warn(f"Ошибка синхронизации профиля {telegram_id}: {e}")

def sync_avatar_from_telegram(telegram_id):
    """Check for a changed Telegram photo and update it in a background thread."""
    try:
        import urllib.request, json
        photos_req = urllib.request.Request(f"https://api.telegram.org/bot{BOT_TOKEN}/getUserProfilePhotos?user_id={telegram_id}&limit=1&offset=0")
        photos_resp = urllib.request.urlopen(photos_req, timeout=5)
        photos_data = json.loads(photos_resp.read().decode())
        if photos_data.get("ok") and photos_data["result"]["total_count"] > 0:
            photo = photos_data["result"]["photos"][0][-1]
            file_id = photo["file_id"]
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("photo_file_id") == file_id:
                return
            file_req = urllib.request.Request(f"https://api.telegram.org/bot{BOT_TOKEN}/getFile?file_id={file_id}")
            file_resp = urllib.request.urlopen(file_req, timeout=5)
            file_data = json.loads(file_resp.read().decode())
            if not file_data.get("ok"):
                return
            file_path = file_data["result"]["file_path"]
            dl_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}"
            ext = os.path.splitext(file_path)[1] or ".jpg"
            photo_filename = f"avatar_{telegram_id}{ext}"
            local_photo = "assets/avatars/" + photo_filename
            full_local = os.path.join(os.path.dirname(os.path.abspath(__file__)), local_photo.replace("/", os.sep))
            os.makedirs(os.path.dirname(full_local), exist_ok=True)
            dl_resp = urllib.request.urlopen(dl_url, timeout=10)
            with open(full_local, "wb") as f:
                f.write(dl_resp.read())
            user["photo_path"] = local_photo
            user["photo_file_id"] = file_id
            for old_ext in [".jpg", ".png"]:
                if old_ext != ext:
                    old_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "avatars", f"avatar_{telegram_id}{old_ext}")
                    if os.path.exists(old_path):
                        try:
                            os.remove(old_path)
                        except:
                            pass
            save_json("users.json", users)
    except Exception as e:
        log_error(f"Ошибка обновления аватара для {telegram_id}: {e}")

def get_user_level(coins, config):
    levels = config.get("levels", [])
    current_level = 1
    for lvl in levels:
        if coins >= lvl["coins_needed"]:
            current_level = lvl["level"]
    return current_level

def get_upgrade_cost(upgrade_key, current_level, config):
    upgrade_def = config["upgrades"].get(upgrade_key, {})
    base_cost = upgrade_def.get("base_cost", 100)
    multiplier = upgrade_def.get("cost_multiplier", 1.5)
    return int(base_cost * (multiplier ** current_level))

def apply_background_bonus(user, backgrounds):
    active_bg_id = user.get("active_background")
    if not active_bg_id:
        return 0
    for bg in backgrounds:
        if bg["id"] == active_bg_id:
            return bg["bonus"]
    return 0

def calculate_boost_multiplier(user):
    multiplier = 1.0
    now = time.time()
    active = []
    for boost in user.get("active_boosts", []):
        if boost["expires_at"] > now:
            active.append(boost)
            if "coins_x" in boost.get("boost_id", ""):
                m = re.search(r'x(\d+)', boost["boost_id"])
                if m:
                    multiplier *= int(m.group(1))
    user["active_boosts"] = active
    return multiplier

def get_passive_income_per_sec(user, config, backgrounds=None):
    """Server-authoritative passive income per second (mirrors client formula)."""
    rate = user.get("passive_income", 0) or 0
    upgrades = config.get("upgrades", {})
    up = user.get("upgrades", {})
    passive_mult_def = upgrades.get("passive_mult", {})
    passive_mult = up.get("passive_mult", 0)
    rate = rate * (1 + passive_mult * passive_mult_def.get("effect_per_level", 4) / 100)
    profit_def = upgrades.get("profit_mult", {})
    profit = up.get("profit_mult", 0)
    rate = rate * (1 + profit * profit_def.get("effect_per_level", 2) / 100)
    level_mult = 1.0
    for lvl in config.get("levels", []):
        if user.get("total_earned", 0) >= lvl["coins_needed"]:
            level_mult = lvl["bonus"]
    rate = rate * level_mult
    if backgrounds is not None:
        rate = rate * (1 + apply_background_bonus(user, backgrounds) / 100)
    return rate

def accrue_passive_income(user, config, backgrounds=None):
    """Accrue offline/elapsed passive income + energy regen since last check."""
    now = time.time()
    last = user.get("last_passive", 0)
    if not last:
        user["last_passive"] = now
        return
    elapsed = now - last
    cap = config["game"].get("offline_cap_seconds", 28800)
    elapsed = min(elapsed, cap)
    if elapsed >= 1:
        rate = get_passive_income_per_sec(user, config, backgrounds)
        gained = int(rate * elapsed)
        if gained > 0:
            user["coins"] = user.get("coins", 0) + gained
            user["total_earned"] = user.get("total_earned", 0) + gained
        regen = user.get("energy_regen", 0) or 0
        if regen > 0:
            user["energy"] = min(user.get("energy", 0) + regen * elapsed, user.get("max_energy", 1000))
    user["last_passive"] = now

def check_anti_cheat(user):
    """Reject only genuinely abusive click rates.

    Uses a float click timestamp (last_click) so normal hold-to-click taps
    (80ms interval) are never flagged. A tap is only 'too fast' if it arrives
    < 50ms after the previous one (>20 clicks/sec), which human/mobile hold
    tapping cannot produce.
    """
    now = time.time()
    suspicious = user.get("suspicious_activity", [])
    suspicious = [s for s in suspicious if now - s["time"] < 600]
    user["suspicious_activity"] = suspicious
    recent_count = len(suspicious)
    if recent_count > 50:
        return False
    last_click = user.get("last_click", 0)
    if last_click and now - last_click < 0.05:
        suspicious.append({"time": now, "reason": "too_fast_click"})
        user["suspicious_activity"] = suspicious
        return False
    return True

def get_client_ip(handler):
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return handler.client_address[0]

# --- Server load metrics (std-lib only; psutil is not installed) ---

def _get_system_mem():
    """Return (total_mb, available_mb) or (None, None) on unsupported systems."""
    try:
        if sys.platform == "win32":
            import ctypes
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return stat.ullTotalPhys / 1048576.0, stat.ullAvailPhys / 1048576.0
    except Exception:
        pass
    return None, None

def _get_process_memory_mb():
    """Working-set size (MB) of the current process via psapi on Windows."""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes
            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]
            pmc = PROCESS_MEMORY_COUNTERS()
            pmc.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
                return pmc.WorkingSetSize / 1048576.0
    except Exception:
        pass
    return None

def _get_system_cpu_times():
    """Return (idle_sec, total_sec) for the whole system, or None."""
    try:
        if sys.platform == "win32":
            import ctypes
            class FILETIME(ctypes.Structure):
                _fields_ = [("dwLowDateTime", ctypes.c_ulong), ("dwHighDateTime", ctypes.c_ulong)]
            k32 = ctypes.windll.kernel32
            idle, kernel, user = FILETIME(), FILETIME(), FILETIME()
            if k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
                def to_sec(ft):
                    return (ft.dwHighDateTime << 32 | ft.dwLowDateTime) / 10000000.0
                return to_sec(idle), to_sec(kernel) + to_sec(user)
    except Exception:
        pass
    return None

def _system_cpu_pct():
    """System-wide CPU usage %. First call falls back to the average since boot."""
    global _SYS_CPU_BASELINE
    t = _get_system_cpu_times()
    if not t:
        return None
    idle, total = t
    now = time.time()
    if _SYS_CPU_BASELINE is None:
        _SYS_CPU_BASELINE = (idle, total, now)
    s = _SYS_CPU_SAMPLE
    if s["idle"] is not None and now - s["t"] >= 0.4:
        idle_d = idle - s["idle"]
        total_d = total - s["total"]
        s["idle"], s["total"], s["t"] = idle, total, now
        if total_d > 0:
            return round(max(0.0, min(100.0, (1 - idle_d / total_d) * 100)), 1)
    else:
        s["idle"], s["total"], s["t"] = idle, total, now
    b_idle, b_total, b_time = _SYS_CPU_BASELINE
    dt = now - b_time
    if dt > 1 and total - b_total > 0:
        return round(max(0.0, min(100.0, (1 - (idle - b_idle) / (total - b_total)) * 100)), 1)
    return None

def _process_cpu_pct():
    """CPU% used by this process. First call falls back to the average since start."""
    try:
        t = os.times()
        cur = t.user + t.system
    except Exception:
        return None
    cores = os.cpu_count() or 1
    now = time.time()
    s = _PROC_CPU_SAMPLE
    if s["cpu"] is not None and now - s["t"] >= 0.4:
        d_cpu = cur - s["cpu"]
        d_wall = now - s["t"]
        s["cpu"], s["t"] = cur, now
        if d_wall > 0:
            return round(max(0.0, (d_cpu / d_wall) * 100 * cores), 1)
    else:
        s["cpu"], s["t"] = cur, now
    uptime = now - REQUEST_START_TIME
    if uptime > 1:
        return round(max(0.0, (cur / uptime) * 100 * cores), 1)
    return None

def collect_server_load():
    """Aggregate real-time resource metrics for the admin dashboard."""
    now = time.time()
    users = {}
    online = 0
    try:
        users = load_users()
        online = sum(1 for u in users.values() if now - u.get("last_active", 0) < 60)
    except Exception:
        pass

    total_mb, avail_mb = _get_system_mem()
    proc_mb = _get_process_memory_mb()

    cutoff = now - 60
    recent = [r for r in REQUEST_LOG if r[0] >= cutoff]
    req_min = len(recent)
    avg_ms = round(sum(r[1] for r in recent) / len(recent), 1) if recent else 0

    users_file = os.path.join(DATA_DIR, "users.json")
    users_kb = 0
    try:
        users_kb = round(os.path.getsize(users_file) / 1024.0, 1)
    except Exception:
        pass

    ram_used_pct = None
    ram_used_mb = None
    if total_mb is not None and avail_mb is not None and total_mb > 0:
        ram_used_mb = total_mb - avail_mb
        ram_used_pct = round(ram_used_mb / total_mb * 100, 1)

    return {
        "cpu_process": _process_cpu_pct(),
        "cpu_system": _system_cpu_pct(),
        "cores": os.cpu_count() or 1,
        "ram_process_mb": round(proc_mb, 1) if proc_mb is not None else None,
        "ram_total_mb": round(total_mb, 1) if total_mb is not None else None,
        "ram_used_mb": round(ram_used_mb, 1) if ram_used_mb is not None else None,
        "ram_used_pct": ram_used_pct,
        "threads": threading.active_count(),
        "online": online,
        "users_total": len(users),
        "requests_total": TOTAL_REQUESTS,
        "requests_min": req_min,
        "avg_response_ms": avg_ms,
        "db_reads_min": _count_recent(DB_OPS["reads"], cutoff),
        "db_writes_min": _count_recent(DB_OPS["writes"], cutoff),
        "db_reads_total": LOAD_STATE["db_reads"],
        "db_writes_total": LOAD_STATE["db_writes"],
        "uptime_sec": int(now - REQUEST_START_TIME),
        "users_file_kb": users_kb,
    }

# --- Static File Serving ---
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

class GameHandler(http.server.BaseHTTPRequestHandler):
    
    def log_message(self, format, *args):
        msg = f"{self.address_string()} - {format % args}"
        code = str(format % args).split(" ")[-1]
        if code.startswith(("4", "5")):
            log_warn(f"Запрос с ошибкой: {format % args}")
    
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        query = {k: v[0] for k, v in query.items()}
        
        # API routes
        if path.startswith("/api/"):
            self.handle_api_get(path, query)
            return
        
        # Auth callback
        if path == "/auth/telegram/callback":
            self.handle_telegram_callback(query)
            return
        
        # Telegram logout helper
        if path == "/auth/telegram/logout":
            self.handle_telegram_logout()
            return
        
        # Static files
        self.serve_static(path)
    
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        
        # Telegram widget callback - URL-encoded form POST
        if path == "/auth/telegram/callback":
            import urllib.parse
            try:
                form_data = urllib.parse.parse_qs(body.decode("utf-8"))
            except:
                form_data = {}
            form_data = {k: (v[0] if isinstance(v, list) and len(v) > 0 else v) for k, v in form_data.items()}
            self.handle_telegram_callback(form_data)
            return
        
        try:
            data = json.loads(body) if body else {}
        except:
            data = {}
        
        if path == "/bot/webhook":
            self.handle_bot_webhook(data)
            return

        # Mini App login: validate initData, create session, return token as JSON.
        if path == "/api/auth/login":
            self.handle_webapp_login(data)
            return
        
        if path.startswith("/api/"):
            self.handle_api_post(path, data)
            return
        
        self.send_json(404, {"error": "Not found"})
    
    def do_OPTIONS(self):
        self.send_cors_headers()
        self.send_response(200)
        self.end_headers()
    
    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
    
    def send_json(self, status, data):
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
    
    def send_html(self, status, html):
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))
    
    def serve_static(self, path):
        if path == "" or path == "/":
            path = "/index.html"
        
        file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), path.lstrip("/"))
        file_path = os.path.normpath(file_path)
        
        # Security: prevent path traversal
        base_dir = os.path.normpath(os.path.dirname(os.path.abspath(__file__)))
        if not file_path.startswith(base_dir):
            self.send_response(403)
            self.end_headers()
            return
        
        if not os.path.exists(file_path) or os.path.isdir(file_path):
            self.send_response(404)
            self.send_cors_headers()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"404 Not Found")
            return
        
        ext = os.path.splitext(file_path)[1].lower()
        mime = MIME_TYPES.get(ext, "application/octet-stream")
        
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        
        with open(file_path, "rb") as f:
            self.wfile.write(f.read())
    
    # --- Bot Webhook Handler ---
    def handle_bot_webhook(self, data):
        try:
            message = data.get("message", {})
            chat_id = message.get("chat", {}).get("id")
            text = message.get("text", "")
            
            if not chat_id or not text:
                self.send_json(200, {"ok": True})
                return

            if text.startswith("/start"):
                log_bot(f"Получен /start от {chat_id}")
            else:
                log_bot(f"Сообщение от {chat_id}: {text[:40]}")
            
            # Process /start command
            if text.startswith("/start"):
                parts = text.split()
                if len(parts) > 1:
                    ref_code = parts[1].strip()
                    if ref_code.startswith("ref_"):
                        referrer_id = ref_code[4:]  # Remove "ref_" prefix
                        new_user_id = str(chat_id)
                        
                        users = load_users()
                        referrer = users.get(referrer_id)
                        new_user = users.get(new_user_id)
                        
                        # Grant reward immediately if referrer exists and new user not already referred
                        granted = False
                        if referrer and referrer_id != new_user_id:
                            existing = referrer.get("referrals", [])
                            if new_user_id not in existing and not (new_user or {}).get("referred_by"):
                                from_info = message.get("from", {})
                                new_user = get_or_create_user(new_user_id, {
                                    "first_name": from_info.get("first_name", ""),
                                    "last_name": from_info.get("last_name", ""),
                                    "username": from_info.get("username", ""),
                                })
                                users = load_users()
                                config = load_config()
                                bonus = config.get("game", {}).get("referral_bonus", 500)
                                users[new_user_id]["coins"] = users[new_user_id].get("coins", 0) + bonus
                                users[new_user_id]["total_earned"] = users[new_user_id].get("total_earned", 0) + bonus
                                users[new_user_id]["referred_by"] = referrer_id
                                
                                ref_bonus = config.get("game", {}).get("referral_ref_bonus", 1500)
                                users[referrer_id]["coins"] = users[referrer_id].get("coins", 0) + ref_bonus
                                users[referrer_id]["total_earned"] = users[referrer_id].get("total_earned", 0) + ref_bonus
                                users[referrer_id]["referrals"] = users[referrer_id].get("referrals", []) + [new_user_id]
                                users[referrer_id]["referral_count"] = users[referrer_id].get("referral_count", 0) + 1
                                users[referrer_id]["referral_active_count"] = users[referrer_id].get("referral_active_count", 0) + 1
                                users[referrer_id]["referral_earned"] = users[referrer_id].get("referral_earned", 0) + ref_bonus
                                
                                save_json("users.json", users)
                                PENDING_REFERRALS.pop(new_user_id, None)
                                granted = True
                                
                                ref_name = users[referrer_id].get("first_name") or users[referrer_id].get("username") or referrer_id
                                send_telegram_message(
                                    new_user_id,
                                    f"🎉 <b>Добро пожаловать!</b>\n\n"
                                    f"Ты перешел по реферальной ссылке <b>{ref_name}</b> и получил <b>+{bonus} монет</b>! 🚀\n\n"
f"👉 <a href='{BASE_URL}'>Открыть игру</a>"
                                )
                                send_telegram_message(
                                    referrer_id,
                                    f"🎉 Твой реферал @{new_user.get('username') or new_user.get('first_name') or new_user_id} присоединился!\n"
                                    f"Ты получил <b>+{ref_bonus} монет</b>! 💰"
                                )
                        
                        if not granted:
                            PENDING_REFERRALS[str(chat_id)] = referrer_id
                            welcome_text = (
                                f"🎉 <b>Добро пожаловать!</b>\n\n"
                                f"Ты перешел по реферальной ссылке! 🚀\n"
                                f"После авторизации в игре ты получишь бонус.\n\n"
                                f"👉 <a href='{BASE_URL}'>Открыть игру</a>"
                            )
                            send_telegram_message(chat_id, welcome_text)
                    else:
                        send_telegram_message(chat_id, "👋 <b>Добро пожаловать в игру!</b>\n\nПереходи по ссылке и начинай зарабатывать монеты!")
                else:
                    send_telegram_message(chat_id, "👋 <b>Добро пожаловать в игру!</b>\n\nПереходи по ссылке и начинай зарабатывать монеты!")
            
            self.send_json(200, {"ok": True})
        except Exception as e:
            log_error(f"Ошибка вебхука бота: {e}")
            self.send_json(200, {"ok": True})
    
    # --- Telegram Auth Handler ---
    def handle_telegram_callback(self, query):
        # parse_qs returns lists, extract scalars
        query = {k: (v[0] if isinstance(v, list) and len(v) > 0 else v) for k, v in query.items()}
        if not check_telegram_auth(query, BOT_TOKEN):
            self.send_html(403, "<h1>Ошибка авторизации</h1><p>Неверные данные Telegram</p>")
            return
        
        user_data = {
            "id": query["id"],
            "first_name": query.get("first_name", ""),
            "last_name": query.get("last_name", ""),
            "username": query.get("username", ""),
            "photo_url": query.get("photo_url", ""),
        }
        
        telegram_id = str(query["id"])
        
        # Handle photo caching
        photo_url = query.get("photo_url", "")
        photo_path = ""
        if photo_url:
            import urllib.request
            ext = ".jpg"
            photo_filename = f"avatar_{telegram_id}{ext}"
            photo_path = "assets/avatars/" + photo_filename
            full_photo_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), photo_path.replace("/", os.sep))
            os.makedirs(os.path.dirname(full_photo_path), exist_ok=True)
            try:
                img_resp = urllib.request.urlopen(photo_url, timeout=10)
                with open(full_photo_path, "wb") as f:
                    f.write(img_resp.read())
                user_data["photo_path"] = photo_path
            except:
                user_data["photo_path"] = ""
        
        # Fetch bio from Telegram
        telegram_bio = ""
        try:
            import urllib.request, json
            bio_req = urllib.request.Request(f"https://api.telegram.org/bot{BOT_TOKEN}/getChat?chat_id={telegram_id}")
            bio_resp = urllib.request.urlopen(bio_req, timeout=5)
            bio_data = json.loads(bio_resp.read().decode())
            if bio_data.get("ok"):
                chat = bio_data.get("result", {})
                telegram_bio = chat.get("bio", "")
        except:
            pass
        
        users = load_users()
        uname = user_data.get("username") or user_data.get("first_name") or telegram_id
        if telegram_id in users:
            log_auth(f"Вход пользователя @{uname} (id: {telegram_id})")
            old = users[telegram_id]
            if user_data.get("photo_path") and old.get("photo_path") and user_data["photo_path"] != old["photo_path"]:
                old_photo = os.path.join(os.path.dirname(os.path.abspath(__file__)), old["photo_path"])
                if os.path.exists(old_photo):
                    try:
                        os.remove(old_photo)
                    except:
                        pass
            users[telegram_id]["first_name"] = user_data.get("first_name", old.get("first_name", ""))
            users[telegram_id]["last_name"] = user_data.get("last_name", old.get("last_name", ""))
            users[telegram_id]["username"] = user_data.get("username", old.get("username", ""))
            if user_data.get("photo_path"):
                users[telegram_id]["photo_path"] = user_data["photo_path"]
            users[telegram_id]["photo_url"] = photo_url
            if telegram_bio:
                users[telegram_id]["bio"] = telegram_bio
        else:
            user = get_or_create_user(telegram_id, user_data)
            if user_data.get("photo_path"):
                user["photo_path"] = user_data["photo_path"]
            if telegram_bio:
                user["bio"] = telegram_bio
            users[telegram_id] = user
            log_success(f"Новый пользователь зарегистрирован: @{uname} (id: {telegram_id})")
        
        # Process pending referral if this is a new user
        if telegram_id in PENDING_REFERRALS:
            referrer_id = PENDING_REFERRALS[telegram_id]
            referrer = users.get(referrer_id, {})
            existing = referrer.get("referrals", [])
            new_user_data = users.get(telegram_id, {})
            if telegram_id not in existing and not new_user_data.get("referred_by"):
                del PENDING_REFERRALS[telegram_id]
                
                config = load_config()
                bonus = config.get("game", {}).get("referral_bonus", 500)
                users[telegram_id]["coins"] = users[telegram_id].get("coins", 0) + bonus
                users[telegram_id]["total_earned"] = users[telegram_id].get("total_earned", 0) + bonus
                users[telegram_id]["referred_by"] = referrer_id
                
                ref_bonus = config.get("game", {}).get("referral_ref_bonus", 1500)
                users[referrer_id]["coins"] = users[referrer_id].get("coins", 0) + ref_bonus
                users[referrer_id]["total_earned"] = users[referrer_id].get("total_earned", 0) + ref_bonus
                users[referrer_id]["referrals"] = existing + [telegram_id]
                users[referrer_id]["referral_count"] = users[referrer_id].get("referral_count", 0) + 1
                users[referrer_id]["referral_active_count"] = users[referrer_id].get("referral_active_count", 0) + 1
                users[referrer_id]["referral_earned"] = users[referrer_id].get("referral_earned", 0) + ref_bonus
                
                save_json("users.json", users)
                
                new_name = new_user_data.get("first_name") or new_user_data.get("username") or telegram_id
                send_telegram_message(
                    referrer_id,
                    f"🎉 Твой реферал @{new_name} присоединился!\n"
                    f"Ты получил <b>+{ref_bonus} монет</b>! 💰"
                )
        
        save_json("users.json", users)
        
        token = generate_token()
        set_session(token, telegram_id)
        
        redirect_html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Авторизация...</title>
            <style>
                body {{ background: #0B0F16; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: system-ui; margin: 0; }}
                .loader {{ width: 48px; height: 48px; border: 3px solid #2A3342; border-top-color: #4F8FFF; border-radius: 50%; animation: spin 1s linear infinite; }}
                @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
            </style>
        </head>
        <body>
            <div class="loader"></div>
            <script>
                localStorage.setItem('session_token', '{token}');
                localStorage.setItem('user_id', '{telegram_id}');
                localStorage.removeItem('force_relogin');
                window.location.href = '/';
            </script>
        </body>
        </html>
        """
        self.send_html(200, redirect_html)
    
    def handle_telegram_logout(self):
        origin = BASE_URL
        bot_id = BOT_TOKEN.split(":")[0] if ":" in BOT_TOKEN else "0"
        html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Выход...</title>
<style>
body{{background:#070a14;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui;flex-direction:column;gap:16px;margin:0}}
.loader{{width:40px;height:40px;border:3px solid #2a3342;border-top-color:#4F8FFF;border-radius:50%;animation:spin 1s linear infinite}}
@keyframes spin{{to{{transform:rotate(360deg)}}}}
p{{color:#8892b0;font-size:14px;text-align:center;max-width:320px;line-height:1.5}}
</style></head><body>
<div class="loader"></div>
<p>Очищаем сессию Telegram...</p>
<iframe src="https://oauth.telegram.org/auth?bot_id={bot_id}&origin={origin}&logout=1" style="width:0;height:0;border:0;position:absolute;visibility:hidden;"></iframe>
<script>
document.cookie.split(';').forEach(function(c){{ document.cookie=c.replace(/^ +/,'').replace(/=.*/,'=;expires='+new Date(0).toUTCString()+';path=/'); }});
try {{ localStorage.clear(); }} catch(e){{}}
try {{ sessionStorage.clear(); }} catch(e){{}}
setTimeout(function(){{ window.location.href = '/'; }}, 4000);
</script></body></html>"""
        self.send_html(200, html)
    
    def handle_webapp_login(self, data):
        init_data = data.get("init_data", "") or data.get("initData", "")
        if not init_data:
            self.send_json(400, {"error": "Нет данных авторизации Telegram"})
            return
        if not check_telegram_webapp_auth(init_data, BOT_TOKEN):
            self.send_json(403, {"error": "Неверная подпись данных Telegram"})
            return
        token, telegram_id = process_telegram_webapp_login(init_data)
        if not token:
            self.send_json(500, {"error": "Ошибка регистрации пользователя"})
            return
        log_auth(f"Mini App вход пользователя (id: {telegram_id})")
        self.send_json(200, {"success": True, "token": token, "user_id": telegram_id})

    # --- API GET Handler ---
    def handle_api_get(self, path, query):
        token = self.headers.get("Authorization", query.get("token", ""))
        telegram_id = get_session_user(token)
        
        if path == "/api/config":
            config = load_config()
            backgrounds = load_backgrounds()
            cases = load_cases()
            tasks = load_tasks()
            self.send_json(200, {
                "config": config,
                "backgrounds": backgrounds,
                "cases": cases,
                "tasks": tasks
            })
            return
        
        if path == "/api/user/get":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            users = load_users()
            user = users.get(str(telegram_id))
            if not user:
                self.send_json(404, {"error": "User not found"})
                return
            if user.get("is_blocked"):
                self.send_json(403, {"error": "User is blocked"})
                return
            
            # Auto-update profile data (name/username/bio) from Telegram (max once per hour, or forced)
            # Runs in a background thread so the single-threaded server is never blocked on network calls.
            now_ts = int(time.time())
            force_sync = query.get("force", "") == "1"
            last_profile_check = user.get("last_profile_check", 0)
            if force_sync or now_ts - last_profile_check > 3600:
                user["last_profile_check"] = now_ts
                threading.Thread(target=sync_profile_from_telegram, args=(str(telegram_id),), daemon=True).start()
            
            # Auto-update avatar from Telegram if photo changed (max once per hour)
            last_avatar_check = user.get("last_avatar_check", 0)
            if now_ts - last_avatar_check > 3600:
                user["last_avatar_check"] = now_ts
                threading.Thread(target=sync_avatar_from_telegram, args=(str(telegram_id),), daemon=True).start()
            
            user["last_active"] = int(time.time())
            config = load_config()
            backgrounds = load_backgrounds()
            accrue_passive_income(user, config, backgrounds)
            save_user(telegram_id, user)
            record_login(telegram_id)
            
            safe_user = {k: v for k, v in user.items() if k not in ["suspicious_activity"]}
            if safe_user.get("photo_path"):
                safe_user["photo_path"] = safe_user["photo_path"].replace("\\", "/")
            
            level_data = get_user_level(user["total_earned"], config)
            safe_user["calculated_level"] = level_data
            
            bg_bonus = apply_background_bonus(user, backgrounds)
            safe_user["background_bonus"] = bg_bonus
            
            boost_mult = calculate_boost_multiplier(user)
            safe_user["boost_multiplier"] = boost_mult
            
            safe_user["passive_income_rate"] = round(get_passive_income_per_sec(user, config, backgrounds), 2)
            
            self.send_json(200, {"user": safe_user})
            return
        
        if path == "/api/online":
            users = load_users()
            now = time.time()
            online = sum(1 for u in users.values() if now - u.get("last_active", 0) < 60)
            record_online_sample(online)
            self.send_json(200, {"online": online})
            return
        
        if path == "/api/leaderboard":
            sort_by = query.get("sort", "total_earned")
            
            cached = LEADERBOARD_CACHE.get(sort_by)
            if cached and time.time() - cached[0] < 10:
                self.send_json(200, {"leaderboard": cached[1]})
                return
            
            users = load_users()
            
            sorted_users = []
            for uid, u in users.items():
                if u.get("is_blocked"):
                    continue
                sorted_users.append({
                    "id": uid,
                    "username": u.get("username", u.get("first_name", "Unknown")),
                    "first_name": u.get("first_name", ""),
                    "photo_url": u.get("photo_url", ""),
                    "photo_path": (u.get("photo_path", "") or "").replace("\\", "/"),
                    "custom_title": u.get("custom_title", ""),
                    "is_admin": u.get("is_admin", False),
                    "total_earned": u.get("total_earned", 0),
                    "referral_count": u.get("referral_active_count", 0)
                })
            
            if sort_by == "referral_count":
                sorted_users.sort(key=lambda x: x["referral_count"], reverse=True)
            else:
                sorted_users.sort(key=lambda x: x["total_earned"], reverse=True)
            
            payload = sorted_users[:50]
            LEADERBOARD_CACHE[sort_by] = (time.time(), payload)
            self.send_json(200, {"leaderboard": payload})
            return
        
        if path == "/api/vouchers/available":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            config = load_config()
            exchange_rate = config["game"]["exchange_rate"]
            vouchers = load_vouchers()
            available = [v for v in vouchers if v["status"] == "available"]
            
            amounts = {}
            for v in available:
                amt = v["amount"]
                if amt not in amounts:
                    amounts[amt] = 0
                amounts[amt] += 1
            
            exchange_options = []
            for amt, count in sorted(amounts.items()):
                exchange_options.append({
                    "amount": amt,
                    "price_coins": amt * exchange_rate,
                    "available": count
                })
            
            self.send_json(200, {"options": exchange_options})
            return
        
        if path == "/api/user/vouchers":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            vouchers = load_vouchers()
            user_vouchers = [v for v in vouchers if v.get("claimed_by") == telegram_id]
            self.send_json(200, {"vouchers": user_vouchers})
            return

        if path == "/api/user/referral_info":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user:
                self.send_json(404, {"error": "User not found"})
                return
            
            config_data = load_config()
            bot_uname = config_data.get("bot_username", "YourBot")
            ref_link = f"https://t.me/{bot_uname}?start={user.get('referral_code', '')}"
            
            self.send_json(200, {
                "referral_code": user.get("referral_code", ""),
                "referral_link": ref_link,
                "referral_count": user.get("referral_count", 0),
                "referral_active_count": user.get("referral_active_count", 0),
                "referral_earned": user.get("referral_earned", 0),
                "referrals": user.get("referrals", []),
                "coins": user.get("coins", 0),
                "total_earned": user.get("total_earned", 0)
            })
            return
        
        self.send_json(404, {"error": "API not found"})
    
    # --- API POST Handler ---
    def handle_api_post(self, path, data):
        token = data.get("token", self.headers.get("Authorization", ""))
        telegram_id = get_session_user(token)
        
        if path == "/api/user/click":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("is_blocked"):
                self.send_json(403, {"error": "User not found or blocked"})
                return
            
            if not check_anti_cheat(user):
                self.send_json(429, {"error": "Слишком быстро! Подождите."})
                return
            
            config = load_config()
            backgrounds = load_backgrounds()
            accrue_passive_income(user, config, backgrounds)
            
            energy_per_click = config["game"]["energy_per_click"]
            import random
            
            # Batch mode: the client may send several queued taps at once so a
            # whole burst of clicks costs ONE file write instead of one per tap.
            batch_count = int(data.get("count", 1) or 1)
            batch_count = max(1, min(batch_count, 500))
            
            # Energy save check
            energy_save_level = user["upgrades"].get("energy_save", 0)
            energy_save_chance = min(energy_save_level * config["upgrades"]["energy_save"]["effect_per_level"], 60)
            
            # Pre-check energy budget so we can reject the whole batch up front
            est_energy_needed = energy_per_click * batch_count
            if user["energy"] < est_energy_needed:
                self.send_json(400, {"error": "Недостаточно энергии"})
                return
            
            # Calculate static reward components once (they don't change per tap)
            base_reward = config["game"]["base_click_reward"]
            click_power_level = user["upgrades"].get("click_power", 0)
            click_power_bonus = click_power_level * config["upgrades"]["click_power"]["effect_per_level"]
            
            surge_level = user["upgrades"].get("click_surge", 0)
            surge_mult = 1 + surge_level * config["upgrades"]["click_surge"]["effect_per_level"] / 100
            profit_level = user["upgrades"].get("profit_mult", 0)
            profit_mult = 1 + profit_level * config["upgrades"]["profit_mult"]["effect_per_level"] / 100
            
            level_mult = 1.0
            for lvl in config["levels"]:
                if user["total_earned"] >= lvl["coins_needed"]:
                    level_mult = lvl["bonus"]
            
            bg_bonus = apply_background_bonus(user, backgrounds)
            boost_mult = calculate_boost_multiplier(user)
            
            base_reward_per_click = base_reward + click_power_bonus
            base_reward_per_click = int(base_reward_per_click * surge_mult * profit_mult * level_mult * boost_mult * (1 + bg_bonus / 100))
            
            # Per-tap random chances
            lucky_level = user["upgrades"].get("lucky_click", 0)
            lucky_chance = min(lucky_level * config["upgrades"]["lucky_click"]["effect_per_level"], 50)
            combo_level = user["upgrades"].get("click_combo", 0)
            combo_chance = min(combo_level * config["upgrades"]["click_combo"]["effect_per_level"], 50)
            crit_level = user["upgrades"].get("crit_chance", 0)
            crit_chance = min(crit_level * config["upgrades"]["crit_chance"]["effect_per_level"], 45)
            crit_damage_level = user["upgrades"].get("crit_damage", 0)
            crit_mult = 3 + crit_damage_level * config["upgrades"]["crit_damage"]["effect_per_level"] / 100
            crit_mult = min(crit_mult, 6)
            leech_level = user["upgrades"].get("energy_leech", 0)
            leech_chance = min(leech_level * config["upgrades"]["energy_leech"]["effect_per_level"], 40)
            
            total_reward = 0
            total_clicks_added = 0
            last_is_lucky = False
            last_is_combo = False
            last_is_crit = False
            last_is_leech = False
            
            for _ in range(batch_count):
                reward = base_reward_per_click
                is_lucky = random.random() * 100 < lucky_chance
                if is_lucky:
                    reward *= 2
                is_combo = random.random() * 100 < combo_chance
                is_crit = random.random() * 100 < crit_chance
                if is_crit:
                    reward = int(reward * crit_mult)
                total_one = reward
                if is_combo:
                    total_one += reward
                # Energy save check (per tap, energy_cost may be 0 by luck)
                if random.random() * 100 < energy_save_chance:
                    energy_cost = 0
                else:
                    energy_cost = energy_per_click
                is_leech = energy_cost > 0 and random.random() * 100 < leech_chance
                user["energy"] -= energy_cost
                if is_leech:
                    user["energy"] = min(user["energy"] + energy_cost, user["max_energy"])
                total_reward += total_one
                total_clicks_added += 1 + (1 if is_combo else 0)
                last_is_lucky = is_lucky
                last_is_combo = is_combo
                last_is_crit = is_crit
                last_is_leech = is_leech
            
            user["coins"] += total_reward
            user["total_earned"] += total_reward
            user["total_clicks"] += total_clicks_added
            user["last_active"] = int(time.time())
            user["last_click"] = time.time()
            
            # Update level
            new_level = get_user_level(user["total_earned"], config)
            if new_level > user["level"]:
                user["level"] = new_level
            
            save_user(telegram_id, user)
            
            self.send_json(200, {
                "reward": total_reward,
                "count": batch_count,
                "coins": user["coins"],
                "energy": user["energy"],
                "total_clicks": user["total_clicks"],
                "total_earned": user["total_earned"],
                "level": user["level"],
                "is_lucky": last_is_lucky,
                "is_combo": last_is_combo,
                "is_crit": last_is_crit,
                "is_leech": last_is_leech,
                "boost_mult": boost_mult,
                "bg_bonus": bg_bonus
            })
            return
        
        if path == "/api/user/upgrade":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            upgrade_key = data.get("upgrade")
            if not upgrade_key:
                self.send_json(400, {"error": "Missing upgrade key"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("is_blocked"):
                self.send_json(403, {"error": "User not found or blocked"})
                return
            
            config = load_config()
            upgrade_def = config["upgrades"].get(upgrade_key)
            if not upgrade_def:
                self.send_json(400, {"error": "Invalid upgrade"})
                return
            
            current_level = user["upgrades"].get(upgrade_key, 0)
            if current_level >= upgrade_def["max_level"]:
                self.send_json(400, {"error": "Максимальный уровень достигнут"})
                return
            
            # Prerequisite check
            requires = upgrade_def.get("requires")
            if requires:
                for req_key, req_level in requires.items():
                    if user["upgrades"].get(req_key, 0) < req_level:
                        req_def = config["upgrades"].get(req_key, {})
                        req_name = req_def.get("name", req_key)
                        self.send_json(400, {"error": f"Нужно: {req_name} {req_level}+ уровня"})
                        return
            
            cost = get_upgrade_cost(upgrade_key, current_level, config)
            
            if user["coins"] < cost:
                self.send_json(400, {"error": "Недостаточно монет"})
                return
            
            user["coins"] -= cost
            user["upgrades"][upgrade_key] = current_level + 1
            
            # Apply upgrade effects
            effect = upgrade_def["effect_per_level"]
            if upgrade_key == "click_power":
                user["click_power"] = config["game"]["base_click_reward"] + (current_level + 1) * effect
            elif upgrade_key == "passive_income":
                user["passive_income"] = (current_level + 1) * effect
            elif upgrade_key == "max_energy":
                user["max_energy"] = config["game"]["base_max_energy"] + (current_level + 1) * effect
                user["energy"] = min(user["energy"], user["max_energy"])
            elif upgrade_key == "energy_regen":
                user["energy_regen"] = config["game"]["base_energy_regen"] + (current_level + 1) * effect
            # Multiplier-type upgrades (click_surge, crit_damage, energy_leech,
            # passive_mult, profit_mult) have no stored stat field - they are
            # read live from user["upgrades"] in click/passive calculations.
            
            user["last_active"] = int(time.time())
            save_user(telegram_id, user)
            
            self.send_json(200, {
                "coins": user["coins"],
                "upgrade_level": user["upgrades"][upgrade_key],
                "upgrade_key": upgrade_key
            })
            return
        
        if path == "/api/user/buy_background":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            bg_id = data.get("background_id")
            if not bg_id:
                self.send_json(400, {"error": "Missing background_id"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("is_blocked"):
                self.send_json(403, {"error": "User not found or blocked"})
                return
            
            backgrounds = load_backgrounds()
            bg = None
            for b in backgrounds:
                if b["id"] == bg_id:
                    bg = b
                    break
            
            if not bg:
                self.send_json(400, {"error": "Background not found"})
                return
            
            accrue_passive_income(user, load_config(), backgrounds)
            
            if bg_id in user.get("backgrounds", []):
                self.send_json(400, {"error": "Фон уже куплен"})
                return
            
            if user["coins"] < bg["price"]:
                self.send_json(400, {"error": "Недостаточно монет"})
                return
            
            user["coins"] -= bg["price"]
            user["backgrounds"].append(bg_id)
            user["last_active"] = int(time.time())
            save_user(telegram_id, user)
            
            self.send_json(200, {
                "coins": user["coins"],
                "backgrounds": user["backgrounds"]
            })
            return
        
        if path == "/api/user/select_background":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            bg_id = data.get("background_id")
            users = load_users()
            user = users.get(str(telegram_id))
            
            accrue_passive_income(user, load_config())
            
            if bg_id is None or bg_id == "":
                user["active_background"] = None
            else:
                if bg_id not in user.get("backgrounds", []):
                    self.send_json(400, {"error": "Фон не куплен"})
                    return
                user["active_background"] = bg_id
            
            user["last_active"] = int(time.time())
            save_user(telegram_id, user)
            
            self.send_json(200, {"active_background": user["active_background"]})
            return
        
        if path == "/api/user/buy_boost":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            boost_id = data.get("boost_id")
            if not boost_id:
                self.send_json(400, {"error": "Missing boost_id"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("is_blocked"):
                self.send_json(403, {"error": "User not found or blocked"})
                return
            
            config = load_config()
            accrue_passive_income(user, config)
            boost_def = None
            for b in config.get("boosts", []):
                if b["id"] == boost_id:
                    boost_def = b
                    break
            
            if not boost_def:
                self.send_json(400, {"error": "Boost not found"})
                return
            
            if user["coins"] < boost_def["price"]:
                self.send_json(400, {"error": "Недостаточно монет"})
                return
            
            user["coins"] -= boost_def["price"]
            
            if boost_id == "energy_full":
                user["energy"] = user["max_energy"]
            else:
                if "active_boosts" not in user:
                    user["active_boosts"] = []
                
                # Remove old boost of same type
                user["active_boosts"] = [b for b in user["active_boosts"] if b.get("boost_id") != boost_id]
                
                user["active_boosts"].append({
                    "boost_id": boost_id,
                    "started_at": time.time(),
                    "expires_at": time.time() + boost_def["duration"]
                })
            
            user["last_active"] = int(time.time())
            save_user(telegram_id, user)
            
            self.send_json(200, {
                "coins": user["coins"],
                "energy": user.get("energy"),
                "active_boosts": user.get("active_boosts", [])
            })
            return
        
        if path == "/api/user/open_case":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            case_id = data.get("case_id")
            if not case_id:
                self.send_json(400, {"error": "Missing case_id"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("is_blocked"):
                self.send_json(403, {"error": "User not found or blocked"})
                return
            
            cases = load_cases()
            case_def = None
            for c in cases:
                if c["id"] == case_id:
                    case_def = c
                    break
            
            if not case_def:
                self.send_json(400, {"error": "Case not found"})
                return
            
            accrue_passive_income(user, load_config(), load_backgrounds())
            
            if user["coins"] < case_def["price"]:
                self.send_json(400, {"error": "Недостаточно монет"})
                return
            
            user["coins"] -= case_def["price"]
            
            # Roll for reward
            import random
            items = case_def["items"]
            total_prob = sum(item["probability"] for item in items)
            roll = random.random() * total_prob
            
            cum_prob = 0
            chosen_item = items[0]
            for item in items:
                cum_prob += item["probability"]
                if roll <= cum_prob:
                    chosen_item = item
                    break
            
            reward_result = {"type": chosen_item["type"], "name": chosen_item["name"]}
            
            if chosen_item["type"] == "coins":
                amount = chosen_item["amount"]
                # Guaranteed minimum win floor
                min_win = case_def.get("min_win", 0)
                if min_win and amount < min_win:
                    amount = min_win
                    reward_result["name"] = f"{amount} монет"
                user["coins"] += amount
                user["total_earned"] += amount
                reward_result["amount"] = amount
            
            elif chosen_item["type"] == "boost":
                boost_id = chosen_item["boost_id"]
                duration = chosen_item.get("duration", 300)
                now = time.time()
                user["active_boosts"] = [b for b in user.get("active_boosts", []) if b.get("boost_id") != boost_id]
                user["active_boosts"].append({
                    "boost_id": boost_id,
                    "started_at": now,
                    "expires_at": now + duration
                })
                reward_result["boost_id"] = boost_id
                reward_result["duration"] = duration
            
            elif chosen_item["type"] == "energy":
                user["energy"] = min(user["energy"] + chosen_item["amount"], user["max_energy"])
                reward_result["amount"] = chosen_item["amount"]
            
            elif chosen_item["type"] == "background":
                bg_rarity = chosen_item.get("bg_rarity", "common")
                backgrounds = load_backgrounds()
                available_bgs = [b for b in backgrounds if b["rarity"] == bg_rarity and b["id"] not in user.get("backgrounds", [])]
                if available_bgs:
                    chosen_bg = random.choice(available_bgs)
                    user["backgrounds"].append(chosen_bg["id"])
                    reward_result["background_id"] = chosen_bg["id"]
                    reward_result["name"] = chosen_bg["name"]
                else:
                    coins_fallback = {"common": 200, "uncommon": 500, "rare": 1000, "epic": 3000, "legendary": 10000}
                    fallback = coins_fallback.get(bg_rarity, 500)
                    user["coins"] += fallback
                    user["total_earned"] += fallback
                    reward_result["type"] = "coins"
                    reward_result["name"] = f"{fallback} монет (фон не доступен)"
                    reward_result["amount"] = fallback
            
            user["cases_opened"] = user.get("cases_opened", 0) + 1
            user["last_active"] = int(time.time())
            save_user(telegram_id, user)
            
            self.send_json(200, {
                "reward": reward_result,
                "coins": user["coins"],
                "total_cases": user["cases_opened"]
            })
            return
        
        if path == "/api/user/complete_task":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            task_id = data.get("task_id")
            if not task_id:
                self.send_json(400, {"error": "Missing task_id"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("is_blocked"):
                self.send_json(403, {"error": "User not found or blocked"})
                return
            
            tasks = load_tasks()
            task_def = None
            for t in tasks:
                if t["id"] == task_id:
                    task_def = t
                    break
            
            if not task_def or not task_def.get("enabled", True):
                self.send_json(400, {"error": "Task not found or disabled"})
                return
            
            accrue_passive_income(user, load_config())
            
            if task_id in user.get("completed_tasks", []):
                self.send_json(400, {"error": "Задание уже выполнено"})
                return
            
            # Check task conditions
            can_complete = False
            if task_def["type"] == "telegram":
                can_complete = True  # User clicked the link, we trust they did it
            elif task_def["type"] == "referral":
                required = task_def.get("required_count", 1)
                can_complete = user.get("referral_count", 0) >= required
            elif task_def["type"] == "level":
                required = task_def.get("required_level", 3)
                can_complete = user["level"] >= required
            elif task_def["type"] == "clicks":
                required = task_def.get("required_count", 1000)
                can_complete = user["total_clicks"] >= required
            elif task_def["type"] == "earn":
                required = task_def.get("required_amount", 10000)
                can_complete = user["total_earned"] >= required
            elif task_def["type"] == "purchase_case":
                can_complete = user.get("cases_opened", 0) > 0
            elif task_def["type"] == "upgrade_count":
                required = task_def.get("required_count", 5)
                total_upgrades = sum(user["upgrades"].values())
                can_complete = total_upgrades >= required
            elif task_def["type"] == "daily":
                can_complete = True
            
            if not can_complete:
                self.send_json(400, {"error": "Условия не выполнены"})
                return
            
            if "completed_tasks" not in user:
                user["completed_tasks"] = []
            user["completed_tasks"].append(task_id)
            user["coins"] += task_def["reward"]
            user["total_earned"] += task_def["reward"]
            user["last_active"] = int(time.time())
            
            save_user(telegram_id, user)
            
            self.send_json(200, {
                "coins": user["coins"],
                "completed_tasks": user["completed_tasks"]
            })
            return
        
        if path == "/api/user/exchange":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            
            voucher_amount = data.get("amount")
            if not voucher_amount:
                self.send_json(400, {"error": "Missing amount"})
                return
            
            users = load_users()
            user = users.get(str(telegram_id))
            if not user or user.get("is_blocked"):
                self.send_json(403, {"error": "User not found or blocked"})
                return
            
            config = load_config()
            accrue_passive_income(user, config)
            exchange_rate = config["game"]["exchange_rate"]
            price_coins = voucher_amount * exchange_rate
            
            if user["coins"] < price_coins:
                self.send_json(400, {"error": "Недостаточно монет"})
                return
            
            # Daily limit check
            today = time.strftime("%Y-%m-%d")
            if user.get("exchange_date") != today:
                user["exchange_count_today"] = 0
                user["exchange_date"] = today
            
            max_per_day = config["game"].get("max_exchange_per_day", 5)
            if user.get("exchange_count_today", 0) >= max_per_day:
                self.send_json(400, {"error": f"Лимит обменов на сегодня ({max_per_day})"})
                return
            
            vouchers = load_vouchers()
            available = [v for v in vouchers if v["status"] == "available" and v["amount"] == voucher_amount]
            
            if not available:
                self.send_json(400, {"error": "Нет доступных ваучеров на эту сумму"})
                return
            
            voucher = available[0]
            voucher["status"] = "claimed"
            voucher["claimed_by"] = telegram_id
            voucher["claim_date"] = time.strftime("%Y-%m-%d %H:%M:%S")
            
            save_json("vouchers.json", vouchers)
            
            user["coins"] -= price_coins
            user["exchange_count_today"] = user.get("exchange_count_today", 0) + 1
            user["total_exchanged"] = user.get("total_exchanged", 0) + voucher_amount
            
            if "exchange_history" not in user:
                user["exchange_history"] = []
            user["exchange_history"].append({
                "voucher_id": voucher["id"],
                "code": voucher["code"],
                "amount": voucher_amount,
                "price_coins": price_coins,
                "date": voucher["claim_date"]
            })
            
            user["last_active"] = int(time.time())
            save_user(telegram_id, user)
            
            self.send_json(200, {
                "coins": user["coins"],
                "voucher_code": voucher["code"],
                "voucher_amount": voucher_amount,
                "total_exchanged": user["total_exchanged"],
                "exchange_count_today": user["exchange_count_today"]
            })
            return
        
        if path == "/api/admin/check":
            if not telegram_id:
                self.send_json(401, {"error": "Not authorized"})
                return
            users = load_users()
            user = users.get(str(telegram_id), {})
            self.send_json(200, {"is_admin": user.get("is_admin", False)})
            return
        
        # --- Admin API ---
        if path.startswith("/api/admin/"):
            users = load_users()
            user = users.get(str(telegram_id), {})
            if not user.get("is_admin"):
                log_warn(f"Попытка доступа к админке без прав: {telegram_id}")
                self.send_json(403, {"error": "Access denied"})
                return
            
            endpoint = path.replace("/api/admin/", "")
            
            if endpoint == "check":
                self.send_json(200, {"is_admin": user.get("is_admin", False)})
                return
            
            if endpoint == "users":
                all_users = []
                for uid, u in users.items():
                    base = os.path.dirname(os.path.abspath(__file__))
                    avatar_path = os.path.join(base, "assets", "avatars", f"avatar_{uid}.jpg")
                    avatar_png = os.path.join(base, "assets", "avatars", f"avatar_{uid}.png")
                    local_avatar = ""
                    if os.path.exists(avatar_path):
                        local_avatar = f"/assets/avatars/avatar_{uid}.jpg"
                    elif os.path.exists(avatar_png):
                        local_avatar = f"/assets/avatars/avatar_{uid}.png"
                    all_users.append({
                        "id": uid,
                        "username": u.get("username", ""),
                        "first_name": u.get("first_name", ""),
                        "coins": u.get("coins", 0),
                        "level": u.get("level", 1),
                        "total_earned": u.get("total_earned", 0),
                        "total_clicks": u.get("total_clicks", 0),
                        "referral_count": u.get("referral_count", 0),
                        "referral_active_count": u.get("referral_active_count", 0),
                        "referral_earned": u.get("referral_earned", 0),
                        "referred_by": u.get("referred_by", ""),
                        "is_blocked": u.get("is_blocked", False),
                        "is_admin": u.get("is_admin", False),
                        "registered_at": u.get("registered_at", 0),
                        "photo_url": local_avatar or u.get("photo_url", ""),
                        "custom_title": u.get("custom_title", "")
                    })
                self.send_json(200, {"users": all_users})
                return
            
            if endpoint == "toggle_block":
                target_id = data.get("user_id")
                if target_id and target_id in users:
                    users[target_id]["is_blocked"] = not users[target_id].get("is_blocked", False)
                    save_json("users.json", users)
                    action = "заблокирован" if users[target_id]["is_blocked"] else "разблокирован"
                    log_admin(f"Пользователь {target_id} {action} (админ: {telegram_id})")
                    self.send_json(200, {"success": True, "is_blocked": users[target_id]["is_blocked"]})
                    return
            
            if endpoint == "set_balance":
                target_id = data.get("user_id")
                new_balance = data.get("balance", 0)
                if target_id and target_id in users:
                    old_balance = users[target_id]["coins"]
                    diff = new_balance - old_balance
                    if diff > 0:
                        users[target_id]["total_earned"] += diff
                    users[target_id]["coins"] = new_balance
                    save_json("users.json", users)
                    log_admin(f"Баланс пользователя {target_id}: {old_balance} -> {new_balance} (админ: {telegram_id})")
                    self.send_json(200, {"success": True, "new_balance": new_balance})
                    return
            
            if endpoint == "set_user_fields":
                target_id = data.get("user_id")
                if target_id and target_id in users:
                    if "balance" in data:
                        new_balance = int(data.get("balance", 0))
                        old_balance = users[target_id].get("coins", 0)
                        if new_balance > old_balance:
                            users[target_id]["total_earned"] = users[target_id].get("total_earned", 0) + (new_balance - old_balance)
                        users[target_id]["coins"] = new_balance
                    if "level" in data:
                        users[target_id]["level"] = int(data.get("level", 1))
                    if "referral_count" in data:
                        users[target_id]["referral_count"] = int(data.get("referral_count", 0))
                    if "referral_active_count" in data:
                        users[target_id]["referral_active_count"] = int(data.get("referral_active_count", 0))
                    save_json("users.json", users)
                    log_admin(f"Обновлены поля пользователя {target_id} (админ: {telegram_id})")
                    self.send_json(200, {"success": True})
                    return
            
            if endpoint == "vouchers":
                vouchers = load_vouchers()
                self.send_json(200, {"vouchers": vouchers})
                return
            
            if endpoint == "add_voucher":
                vouchers = load_vouchers()
                code = data.get("code", f"RBX-{uuid.uuid4().hex[:8].upper()}")
                amount = data.get("amount", 10)
                new_id = f"V{len(vouchers) + 1:03d}"
                vouchers.append({
                    "id": new_id,
                    "code": code,
                    "amount": amount,
                    "status": "available",
                    "claimed_by": None,
                    "claim_date": None
                })
                save_json("vouchers.json", vouchers)
                self.send_json(200, {"success": True, "voucher": vouchers[-1]})
                return
            
            if endpoint == "delete_vouchers":
                voucher_ids = data.get("ids", [])
                vouchers = load_vouchers()
                original_count = len(vouchers)
                vouchers = [v for v in vouchers if v.get("id") not in voucher_ids]
                save_json("vouchers.json", vouchers)
                self.send_json(200, {"success": True, "deleted": original_count - len(vouchers)})
                return
            
            if endpoint == "add_vouchers_bulk":
                vouchers = load_vouchers()
                count = data.get("count", 10)
                amount = data.get("amount", 10)
                added = []
                for i in range(count):
                    new_id = f"V{len(vouchers) + 1:03d}"
                    code = f"RBX-{uuid.uuid4().hex[:8].upper()}"
                    vouchers.append({
                        "id": new_id,
                        "code": code,
                        "amount": amount,
                        "status": "available",
                        "claimed_by": None,
                        "claim_date": None
                    })
                    added.append({"id": new_id, "code": code})
                save_json("vouchers.json", vouchers)
                self.send_json(200, {"success": True, "added_count": count})
                return
            
            if endpoint == "update_config":
                new_config = data.get("config", {})
                current = load_config()
                # Merge game config
                if "game" in new_config:
                    for key, val in new_config["game"].items():
                        current["game"][key] = val
                if "levels" in new_config:
                    current["levels"] = new_config["levels"]
                if "upgrades" in new_config:
                    current["upgrades"] = new_config["upgrades"]
                if "boosts" in new_config:
                    current["boosts"] = new_config["boosts"]
                save_json("config.json", current)
                self.send_json(200, {"success": True})
                return
            
            if endpoint == "save_tasks":
                new_tasks = data.get("tasks", [])
                save_json("tasks.json", new_tasks)
                self.send_json(200, {"success": True})
                return
            
            if endpoint == "save_cases":
                new_cases = data.get("cases", [])
                save_json("cases.json", new_cases)
                self.send_json(200, {"success": True})
                return
            
            if endpoint == "save_backgrounds":
                new_bgs = data.get("backgrounds", [])
                save_json("backgrounds.json", new_bgs)
                self.send_json(200, {"success": True})
                return
            
            if endpoint == "list_titles":
                # Try multiple possible paths
                base = os.path.dirname(os.path.abspath(__file__))
                cwd = os.getcwd()
                possible = [
                    os.path.join(base, "assets", "title"),
                    os.path.join(cwd, "assets", "title"),
                    os.path.join(cwd, "..", "assets", "title")
                ]
                titles = []
                for d in possible:
                    if os.path.exists(d):
                        for f in sorted(os.listdir(d)):
                            if f.lower().endswith('.png') or f.lower().endswith('.jpg'):
                                titles.append(f)
                        break
                self.send_json(200, {"titles": titles})
                return
            
            if endpoint == "set_title":
                target_id = str(data.get("user_id", ""))
                title_file = data.get("title", "")
                if target_id and target_id in users:
                    users[target_id]["custom_title"] = title_file
                    save_json("users.json", users)
                    title_name = title_file if title_file else "нет титула"
                    log_admin(f"Титул пользователю {target_id}: {title_name} (админ: {telegram_id})")
                    self.send_json(200, {"success": True, "title": title_file})
                    return
                self.send_json(404, {"error": "User not found"})
                return
            
            if endpoint == "toggle_admin":
                target_id = str(data.get("user_id", ""))
                if target_id and target_id in users:
                    users[target_id]["is_admin"] = not users[target_id].get("is_admin", False)
                    save_json("users.json", users)
                    action = "назначен админом" if users[target_id]["is_admin"] else "снят с админа"
                    log_admin(f"Пользователь {target_id} {action} (админ: {telegram_id})")
                    self.send_json(200, {"success": True, "is_admin": users[target_id]["is_admin"]})
                    return
                self.send_json(404, {"error": "User not found"})
                return
            
            if endpoint == "stats":
                logins_daily = get_daily_logins()
                online_daily = get_daily_online()
                logins_hourly = get_hourly_logins()
                online_hourly = get_hourly_online()
                self.send_json(200, {
                    "logins_daily": logins_daily,
                    "online_daily": online_daily,
                    "logins_hourly": logins_hourly,
                    "online_hourly": online_hourly,
                    "logins_all": get_all_daily_logins(),
                    "online_all": get_all_daily_online()
                })
                return

            if endpoint == "server_load":
                self.send_json(200, collect_server_load())
                return

            if endpoint == "user_stats":
                target_id = data.get("user_id")
                if target_id and str(target_id) in users:
                    self.send_json(200, {
                        "logins_daily": get_user_daily_logins(target_id),
                        "logins_hourly": get_user_hourly_logins(target_id)
                    })
                    return
                self.send_json(404, {"error": "User not found"})
                return
                
            if endpoint == "online_count":
                now = time.time()
                online = sum(1 for u in users.values() if now - u.get("last_active", 0) < 60)
                record_online_sample(online)
                self.send_json(200, {"online": online, "total": len(users)})
                return
            
            if endpoint == "online_count_public":
                now = time.time()
                online = sum(1 for u in users.values() if now - u.get("last_active", 0) < 60)
                record_online_sample(online)
                self.send_json(200, {"online": online})
                return
            
            if endpoint == "set_webhook":
                import urllib.request, urllib.parse
                ngrok_url = data.get("url", BASE_URL)
                webhook_url = f"{ngrok_url}/bot/webhook"
                try:
                    post_data = urllib.parse.urlencode({"url": webhook_url}).encode()
                    req = urllib.request.Request(
                        f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook",
                        data=post_data,
                        headers={"Content-Type": "application/x-www-form-urlencoded"}
                    )
                    resp = urllib.request.urlopen(req, timeout=10)
                    result = json.loads(resp.read().decode())
                    if result.get("ok"):
                        send_telegram_message(str(telegram_id), '✅ Вебхук успешно установлен!')
                    self.send_json(200, {"success": result.get("ok", False), "result": result})
                except Exception as e:
                    self.send_json(500, {"error": str(e)})
                return
            
            self.send_json(404, {"error": "Admin endpoint not found"})
            return
        
        self.send_json(404, {"error": "API not found"})

# Run server
if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    load_sessions()
    
    # Ensure data files exist
    for fname in ["users.json", "vouchers.json", "config.json", "tasks.json", "cases.json", "backgrounds.json"]:
        path = os.path.join(DATA_DIR, fname)
        if not os.path.exists(path):
            if fname == "config.json":
                with open(path, "w", encoding="utf-8") as f:
                    json.dump({"game": {}, "levels": [], "upgrades": {}, "boosts": []}, f)
            elif fname == "users.json":
                with open(path, "w", encoding="utf-8") as f:
                    json.dump({}, f)
            else:
                with open(path, "w", encoding="utf-8") as f:
                    json.dump([], f)
    
    log_success(f"Сервер запущен на http://localhost:{PORT}")
    log_info("Откройте в браузере: http://localhost:" + str(PORT))
    log_info("Нажмите CTRL+C чтобы остановить сервер")
    print("")

    # Diagnostic: confirm the bot token is configured and reachable.
    if not BOT_TOKEN:
        log_error("BOT_TOKEN не задан! Добавьте переменную окружения BOT_TOKEN в панели BotHost.")
    else:
        try:
            import urllib.request
            me_req = urllib.request.Request(f"https://api.telegram.org/bot{BOT_TOKEN}/getMe")
            me_resp = urllib.request.urlopen(me_req, timeout=8)
            me_data = json.loads(me_resp.read().decode())
            if me_data.get("ok"):
                bot = me_data["result"]
                log_ok(f"Бот @{bot.get('username')} авторизован в Telegram.")
            else:
                log_error(f"Неверный BOT_TOKEN: {me_data}")
        except Exception as e:
            log_warn(f"Не удалось проверить токен бота: {e}")
    print("")
    
    def online_reporter():
        while True:
            time.sleep(300)
            try:
                users = load_users()
                now = time.time()
                online = sum(1 for u in users.values() if now - u.get("last_active", 0) < 60)
                log_info(f"Онлайн: {online} из {len(users)} пользователей")
            except:
                pass
    
    threading.Thread(target=online_reporter, daemon=True).start()
    
    with socketserver.TCPServer(("", PORT), GameHandler) as httpd:
        httpd.serve_forever()
