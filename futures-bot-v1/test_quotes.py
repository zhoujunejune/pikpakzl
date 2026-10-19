import unittest
from unittest.mock import patch
import quotes

class QuoteTests(unittest.TestCase):
    def setUp(self):
        self.o=patch.object(quotes,"VALUES",{})
        self.e=patch.object(quotes,"ERROR",None)
        self.o.start();self.e.start()
    def tearDown(self):
        self.o.stop();self.e.stop()
    def test_both_mark_prices(self):
        data=[{"symbol":"BTCUSDT","markPrice":"120000.25","time":1000000},
              {"symbol":"ETHUSDT","markPrice":"4400.01","time":1000000}]
        self.assertEqual(quotes.ingest(data,now=1000),2)
        snap=quotes.current(now=1010)
        self.assertEqual(snap["symbols"]["BTCUSDT"]["price"],120000.25)
        self.assertFalse(snap["symbols"]["ETHUSDT"]["stale"])
    def test_missing_timestamp_or_bad_values_not_live(self):
        self.assertEqual(quotes.ingest([{"symbol":"BTCUSDT","markPrice":"1"}],now=1000),0)
        self.assertIsNone(quotes.current(now=1000)["symbols"]["BTCUSDT"]["price"])
        self.assertEqual(quotes.ingest([{"symbol":"BTCUSDT","markPrice":"nan","time":1000000}],now=1000),0)
    def test_outdated_price_is_labeled_stale(self):
        quotes.ingest([{"symbol":"BTCUSDT","markPrice":"101","time":1000000}],now=1000)
        self.assertTrue(quotes.current(now=1050)["symbols"]["BTCUSDT"]["stale"])
        self.assertEqual(quotes.current(now=1050)["symbols"]["BTCUSDT"]["ageSeconds"],50)
    def test_reject_stale_exchange_response(self):
        self.assertEqual(quotes.ingest([{"symbol":"BTCUSDT","markPrice":"100","time":500000}],now=1000),0)
    def test_worker_restriction_stops_polling(self):
        class FakeAPI:
            def __init__(self):self.calls=0
            def call(self,*args):
                self.calls+=1
                raise RuntimeError("Exchange refused request HTTP 451")
        fake=FakeAPI()
        with patch("bot.API",return_value=fake):
            import threading
            quotes.run_quotes(lambda:True,threading.Event())
        self.assertEqual(fake.calls,1)
        self.assertEqual(quotes.current()["error"],"exchange_access_restricted")

if __name__=="__main__":
    unittest.main()
