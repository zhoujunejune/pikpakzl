import unittest
from unittest.mock import patch
import bot

class EnginePacingTests(unittest.TestCase):
    def test_successful_cycle_waits_before_polling_again(self):
        self.assertEqual(bot.MODE,"paper")
        with patch.object(bot,"API") as api_type, \
             patch.object(bot,"load",return_value={"balance":200}), \
             patch.object(bot,"tick") as tick, \
             patch.object(bot.time,"sleep",side_effect=StopIteration("test stop")) as wait:
            with self.assertRaises(StopIteration):
                bot.main()
            tick.assert_called_once()
            wait.assert_called_once_with(bot.LOOP_SECONDS)

if __name__=="__main__":
    unittest.main()
