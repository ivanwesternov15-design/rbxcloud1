import hashlib
import hmac
import json
import time
import unittest
from urllib.parse import urlencode

from server import check_telegram_webapp_auth


BOT_TOKEN = "123456789:telegram-test-token"


def signed_init_data(**overrides):
    params = {
        "auth_date": str(int(time.time())),
        "query_id": "AAHdF6IQAAAAAN0XohDhrOrc",
        "signature": "test-signature+with/symbols=",
        "user": json.dumps(
            {"id": 123456789, "first_name": "Test", "username": "test_user"},
            separators=(",", ":"),
        ),
    }
    params.update(overrides)
    check_string = "\n".join(f"{key}={value}" for key, value in sorted(params.items()))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    params["hash"] = hmac.new(
        secret_key, check_string.encode(), hashlib.sha256
    ).hexdigest()
    return urlencode(params)


class TelegramWebAppAuthTests(unittest.TestCase):
    def test_accepts_valid_init_data_with_signature(self):
        self.assertTrue(check_telegram_webapp_auth(signed_init_data(), BOT_TOKEN))

    def test_rejects_tampered_init_data(self):
        init_data = signed_init_data().replace("test_user", "attacker")
        self.assertFalse(check_telegram_webapp_auth(init_data, BOT_TOKEN))

    def test_rejects_expired_init_data(self):
        init_data = signed_init_data(auth_date=str(int(time.time()) - 86401))
        self.assertFalse(check_telegram_webapp_auth(init_data, BOT_TOKEN))


if __name__ == "__main__":
    unittest.main()
