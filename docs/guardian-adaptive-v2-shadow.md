# GUARDIAN 自适应退出 V2（独立影子版）

目标：验证动态止盈止损能否改善费用后收益，而不是宣称“更智能就一定更赚钱”。

## 安全边界

- **只读影子**：V2 不调用币安买卖 API；不改 risk-worker.mjs、risk-runner.mjs、其他机器人、跟随开关或现有双边风控。
- **不替换实盘**：现有 V1 仍是默认风控，V2 只计算假设退出点。
- **数据来源**：只接收已登记的 GUARDIAN 订单对应的 tokenId、轮次及历史 SELL Quote。每条报价必须有 quoteId、时间、可卖出 amountOut、明确的 feeAmount 和 slippageBufferAmount；缺失即拒绝。
- **性能不能臆测**：报价回放不等于真实成交，必须结合交易所实际 SELL 成交、费用、官方结算和样本外验证。

## 候选动态规则（尚未验证收益）

1. **绝对最大亏损 10%**：行情波动再大，也不放宽至超过该幅度；真实执行仍有滑点、无法保证价格。
2. 最近20秒至少8个有效报价、跨度至少5秒才自适应，否则回退现有规则。
3. SELL报价相邻跳动的中位幅度 <=0.3%：止损6%，移动止盈回撤2.5个百分点；0.3%至1%：止损8%，回撤4个百分点；>1%：止损10%，回撤5个百分点。
4. 距到期45秒以内止损上限8%，25秒以内6%；12秒内亏损则发出假设退出信号。均是影子判断，不执行卖单。
5. 数据断流、超时、费用不明、跨轮次、未来报价、非本模型订单：拒绝出自适应结论。

## 运行

单元测试：node --test railway-diagnostic/guardian-adaptive-exit-v2.test.mjs

回放历史证据：node railway-diagnostic/guardian-adaptive-replay-v2.mjs /path/to/guardian-quotes.json

JSON顶层为数组，成员包含 model、round、tokenId、orderId、cost、quotes。quotes各行要求字段：source、side、quoteId、tokenId、round、at、expireAt、amountOut、feeAmount、slippageBufferAmount。

终端仅汇总，不打印订单或钱包标识。无历史样本时显示零样本，不推断出赚钱能力。

## 升级前必要证据

需要有足够真实订单和同轮次历史SELL报价；按时间切割样本外检验；对比费用后净收益、最大回撤、成功卖出率；补足超时、重复卖单、重启恢复和小额实盘闭环。没有证据则继续保持原风控，绝不删除安全门槛。
