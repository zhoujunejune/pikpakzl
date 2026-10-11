(function () {
  'use strict';
  // A standalone read-only renderer: it must never call POST or change trading/stop settings.
  const $ = id => document.getElementById(id);
  const show = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
  const fmt = value => Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 10) / 10) + '%' : '未知';
  const elapsed = value => {
    const when = Date.parse(value || '');
    if (!Number.isFinite(when)) return '尚无记录';
    const seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
    return seconds < 60 ? seconds + '秒前' : Math.floor(seconds / 60) + '分钟前';
  };
  let requestBusy = false;

  function render(data) {
    const card = $('realRiskStatusCard');
    if (!card) return;
    if (!data || !data.ok) {
      show('realRiskHeadline', '⚠ 风控状态无法验证');
      show('realRiskHealth', '监控接口不可用，请勿将开关显示当作真实保护。');
      show('realRiskDetails', '没有收到有效的风控状态。');
      show('realRiskUpdated', '状态更新时间：无法获取');
      card.style.borderColor = '#ee9d4b';
      return;
    }
    const tp = data.takeProfitEnabled === true;
    const sl = data.stopLossEnabled === true;
    show('realRiskTp', (tp ? '已开启 ' : '已关闭 ') + fmt(data.takeProfitPercent));
    show('realRiskSl', (sl ? '已开启 ' : '已关闭 ') + fmt(data.stopLossPercent));

    const h = data.workerHealth || {};
    const state = data.monitorState || 'UNVERIFIED';
    let headline, detail, border;
    if (state === 'DISABLED') {
      headline = '○ 自动止盈止损均关闭';
      detail = '风控开关处于关闭状态，当前不会执行自动止盈或止损。';
      border = '#69788f';
    } else if (state === 'SCANNING') {
      headline = '● 风控运行中 · 持仓扫描正常';
      detail = '进程在线且近期从交易所成功读取持仓；这不代表卖出报价或订单一定成功。';
      border = '#2ebf75';
    } else if (state === 'SCAN_UNVERIFIED') {
      headline = '⚠ 进程在线 · 持仓扫描未验证';
      detail = '未找到近30秒的成功持仓扫描记录，请检查交易所接口与风控日志。';
      border = '#ee9d4b';
    } else if (state === 'WORKER_UNVERIFIED') {
      headline = '⚠ 风控进程未验证';
      detail = '风控工作进程未启动、配置尚未加载，或工作进程心跳已中断。';
      border = '#ee9d4b';
    } else {
      headline = '⚠ 风控状态过期';
      detail = '主监控状态超过12秒未更新，无法确认自动止盈止损运行情况。';
      border = '#ee9d4b';
    }
    show('realRiskHeadline', headline);
    show('realRiskHealth', detail);
    card.style.borderColor = border;

    if (state === 'DISABLED') {
      show('realRiskScan', '未运行（开关已关）');
      show('realRiskQuote', '未运行（开关已关）');
    } else {
      show('realRiskScan', data.scanFresh
        ? '已扫描 ' + (h.positionsSeen == null ? '?' : h.positionsSeen) + ' 笔 · ' + elapsed(h.lastSuccessfulPositionsAt)
        : '尚未验证 · ' + elapsed(h.lastSuccessfulPositionsAt));
      show('realRiskQuote', h.lastQuoteAt
        ? '成功 ' + (h.quoteChecks ?? 0) + ' 次 · 最近 ' + elapsed(h.lastQuoteAt)
        : '尚无成功报价记录');
    }
    const messages = [];
    if (data.persistenceHealthy === false) messages.push('Redis 配置持久化异常');
    else if (data.persistedConfigFound === false) messages.push('配置尚未确认已写入 Redis');
    if (h.lastError) messages.push('最近异常：' + h.lastError + (h.lastErrorAt ? '（' + elapsed(h.lastErrorAt) + '）' : ''));
    if (h.quoteErrors) messages.push('当前进程累计报价失败：' + h.quoteErrors);
    if (h.lastSellEventAt) messages.push('最近风控卖单事件：' + (h.lastSellEvent || '-') + '（' + elapsed(h.lastSellEventAt) + '）；不等于已成交');
    show('realRiskDetails', (messages.length ? messages.join(' · ') + '。' : '暂未发现已记录的异常。') +
      ' 自动止盈止损是按 SELL Quote 检查，无法保证触发价或成交。');
    show('realRiskUpdated', '监控更新：' + elapsed(data.at) + ' · 交易所持仓：' + elapsed(h.lastSuccessfulPositionsAt));
  }

  async function refresh() {
    if (requestBusy || !$('realRiskStatusCard')) return;
    requestBusy = true;
    try {
      const controller = new AbortController();
      // Response may be slow during a deployment; never freeze the rest of the dashboard.
      const response = await fetch('/api/risk-runtime-status?ts=' + Date.now(), { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      render(await response.json());
    } catch (error) {
      render({ok:false});
    } finally {
      requestBusy = false;
    }
  }

  function boot() {
    if (!$('realRiskStatusCard')) return;
    refresh();
    setInterval(refresh, 5000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
