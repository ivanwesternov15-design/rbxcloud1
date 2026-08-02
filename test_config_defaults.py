import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class ConfigDefaultsTests(unittest.TestCase):
    def test_owner_telegram_id_is_admin(self):
        self.assertTrue(server.is_admin_telegram_id("8414792453"))
        self.assertFalse(server.is_admin_telegram_id("123456789"))

    def test_old_empty_game_config_receives_required_defaults(self):
        with tempfile.TemporaryDirectory() as data_dir:
            Path(data_dir, "config.json").write_text(
                json.dumps({"game": {}, "levels": [], "upgrades": {}}),
                encoding="utf-8",
            )
            with patch.object(server, "DATA_DIR", data_dir):
                config = server.load_config()

        self.assertEqual(config["game"]["energy_per_click"], 1)
        self.assertEqual(config["game"]["base_click_reward"], 1)
        self.assertEqual(config["game"]["base_max_energy"], 1000)
        self.assertEqual(server.get_upgrade_effect(config, "click_power"), 1)

    def test_saved_values_override_defaults(self):
        with tempfile.TemporaryDirectory() as data_dir:
            Path(data_dir, "config.json").write_text(
                json.dumps({"game": {"energy_per_click": 7}}),
                encoding="utf-8",
            )
            with patch.object(server, "DATA_DIR", data_dir):
                config = server.load_config()

        self.assertEqual(config["game"]["energy_per_click"], 7)
        self.assertEqual(config["game"]["base_click_reward"], 1)

    def test_empty_volume_uses_shipped_catalogs(self):
        with tempfile.TemporaryDirectory() as data_dir, tempfile.TemporaryDirectory() as defaults_dir:
            Path(data_dir, "config.json").write_text(
                json.dumps({"game": {}, "levels": [], "upgrades": {}, "boosts": []}),
                encoding="utf-8",
            )
            for filename in ("backgrounds.json", "cases.json", "tasks.json"):
                Path(data_dir, filename).write_text("[]", encoding="utf-8")

            Path(defaults_dir, "config.json").write_text(
                json.dumps({
                    "game": {"energy_per_click": 2},
                    "levels": [{"level": 1, "coins_needed": 0, "bonus": 1}],
                    "upgrades": {"click_power": {"effect_per_level": 4}},
                    "boosts": [{"id": "coins_x2"}],
                }),
                encoding="utf-8",
            )
            Path(defaults_dir, "backgrounds.json").write_text('[{"id":"blue"}]', encoding="utf-8")
            Path(defaults_dir, "cases.json").write_text('[{"id":"starter"}]', encoding="utf-8")
            Path(defaults_dir, "tasks.json").write_text('[{"id":"join"}]', encoding="utf-8")

            with patch.object(server, "DATA_DIR", data_dir), patch.object(server, "DEFAULT_DATA_DIR", defaults_dir):
                config = server.load_config()
                backgrounds = server.load_backgrounds()
                cases = server.load_cases()
                tasks = server.load_tasks()

        self.assertEqual(config["game"]["energy_per_click"], 2)
        self.assertEqual(config["levels"][0]["level"], 1)
        self.assertEqual(config["upgrades"]["click_power"]["effect_per_level"], 4)
        self.assertEqual(config["boosts"][0]["id"], "coins_x2")
        self.assertEqual(backgrounds[0]["id"], "blue")
        self.assertEqual(cases[0]["id"], "starter")
        self.assertEqual(tasks[0]["id"], "join")


if __name__ == "__main__":
    unittest.main()
