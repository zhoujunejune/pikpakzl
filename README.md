# 突破20%即可 · Cloudflare Workers Free 独立影子模型

基于 **Cloudflare Workers + SQLite Durable Objects + Alarms**，无需常驻服务器，也不需要额外创建 D1。代码完全独立、只读，**不触碰 Railway 生产 V2 / 实盘下单**。

## 逻辑

- 每个5分钟轮次的 T+6.25 秒安排 Durable Object Alarm，调用 Binance 公共 REST API：1m / 5m K线（含未完成的当前K线最新价格）。
- 使用已经完整收盘的历史 1m / 5m K线计算 RSI(14)、MACD(12,26,9)、20根1m/12根5m高低位及价格区间位置。
- 收到当前轮次的两种K线且在 T+8 秒前返回，就冻结 UP/DOWN。超时、451/429 或缺失记录为 DATA_GAP，不伪造信号。
- 初始样本使用历史目标5分钟K线的开盘价进行**代理训练**；与实时 T+6.25秒观测分布不同，需以后续独立前瞻统计验证。
- 最少100样本才能训练 L2 逻辑回归，时间顺序训练/验证隔离一轮；验证不优于基线则保持基线。每20个已结算前瞻样本重新训练。
- 严格区分实时前瞻统计与历史训练准确率。结算用现货K线涨跌代理，**不是 Binance Prediction 官方结算**。
- Durable Object `storage` 持久化权重/前瞻结果，`GET /status` 返回统计与可见故障；`GET /latest` 返回最新影子方向，`GET /health` 启用并返回健康状态。

## Cloudflare 部署

需拥有 Cloudflare 账户和 Workers 权限（只需免费版）；首次部署必须由有权限的会话执行。**当前聊天没有 Cloudflare 部署接口，此文件尚未部署。**

在目录执行 `npx wrangler deploy`。首次访问 `https://breakout20-shadow.<subdomain>.workers.dev/status` 会激活唯一 Durable Object 的周期 Alarm。Cloudflare 不保证 Alarms 秒级严格准时，容错场景可能晚到达；如晚于8秒即记录超时。

### 必须核实

1. 账户免费额度、Durable Objects 是否可用，是否出现 Workers CPU/请求数量限制。
2. 从 Cloudflare 网络访问 Binance 市场数据能否返回200，而不是451/429。
3. `/status` 的 1m/5m 数据与真实行情一致；至少观察20轮及时率/数据缺口/前瞻准确率。
4. 不部署覆盖已有 `zl-fast8-adaptive-shadow` Worker。
