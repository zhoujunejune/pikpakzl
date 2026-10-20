import importlib.util
import pathlib
import unittest
from unittest.mock import patch

p=pathlib.Path(__file__).with_name("nav_bridge.py")
spec=importlib.util.spec_from_file_location("nav_bridge_tested",p)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class NavigationTests(unittest.TestCase):
    def test_main_live_dashboard_retains_live_controls(self):
        html='<html><body><nav><a href="/dashboard/">合约机器人</a><a href="/prediction/">预测机器人</a><a href="/api-keys/">交易所 API 管理</a></nav><button id="live-toggle">开关</button></body></html>'
        out=m.decorate(html)
        self.assertIn('href="/futures-lab/"',out)
        self.assertIn('live-toggle',out)
        self.assertIn('href="/prediction/"',out)
        self.assertEqual(out.count('/futures-lab/'),1)
        self.assertEqual(m.decorate(out),out)
    def test_prediction_host_has_cross_origin_links(self):
        html='<html><body style="margin:0"><div><button>开始跟随</button><a href="/api-keys/">API</a></div></body></html>'
        out=m.decorate(html,prediction=True)
        self.assertIn(m.MAIN+'/futures-lab/',out)
        self.assertIn(m.MAIN+'/dashboard/',out)
        self.assertIn(m.PRED+'/',out)
        self.assertIn('开始跟随',out)
        self.assertEqual(m.decorate(out,prediction=True),out)
    def test_unexpected_html_is_rejected(self):
        with self.assertRaises(ValueError):m.decorate('invalid HTTP page')
        with self.assertRaises(ValueError):m.decorate('{}')
    def test_proxy_is_public_html_read_only(self):
        src=p.read_text()
        self.assertNotIn('/fapi/v1/order',src)
        self.assertNotIn('BINANCE_API_SECRET',src)
        self.assertNotIn('PATCH',src)
        self.assertIn('def do_POST(self):',src)
        self.assertEqual(m.PORT,13019)
        self.assertEqual(m.HOST,'127.0.0.1')
    def test_nav_bridge_never_follows_arbitrary_external_uri(self):
        self.assertEqual(m.FUTURES_HTML,'http://127.0.0.1:10000/dashboard/')
        self.assertEqual(m.PREDICTION_HTML,'http://127.0.0.1:13001/')
if __name__=="__main__":unittest.main()
