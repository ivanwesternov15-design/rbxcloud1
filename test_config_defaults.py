import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class ConfigDefaultsTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
