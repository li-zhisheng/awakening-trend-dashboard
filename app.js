(() => {
  'use strict';

  let DATA = null;
  let PAPER = null;
  let STOCKS = null;
  let stockPage = 1;
  const pageSize = 80;
  const charts = new Map();

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const pct = (value, digits = 2) => Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(digits)}%` : '—';
  const num = (value, digits = 0) => Number.isFinite(Number(value))
    ? Number(value).toLocaleString('zh-CN', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    }) : '—';
  const cny = (value) => Number.isFinite(Number(value))
    ? `¥${Number(value).toLocaleString('zh-CN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })}` : '—';
  const dt = (value) => value
    ? String(value).replace('T', ' ').replace(/\+08:00$/, '') : '—';
  const tone = (value) => Number(value) > 0
    ? 'up' : Number(value) < 0 ? 'down' : 'neutral';
  const emptyRow = (columns, text = '暂无数据') =>
    `<tr><td class="empty" colspan="${columns}">${esc(text)}</td></tr>`;

  async function loadFirst(paths) {
    let error = null;
    for (const path of paths) {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        return await response.json();
      } catch (exc) {
        error = exc;
      }
    }
    throw error || new Error('数据读取失败');
  }

  function kpi(label, value, note = '', className = '') {
    return `<div class="kpi"><span>${esc(label)}</span>
      <strong class="${className}">${esc(value)}</strong>
      <small>${esc(note)}</small></div>`;
  }

  function chart(id, option) {
    const node = document.getElementById(id);
    if (!node || !window.echarts) return;
    const instance = charts.get(id) || echarts.init(node);
    charts.set(id, instance);
    instance.setOption(option, true);
  }

  function axisBase() {
    return {
      textStyle: { color: '#94a3a8' },
      axisLine: { lineStyle: { color: '#344149' } },
      splitLine: { lineStyle: { color: '#253036' } },
    };
  }

  function renderHeader() {
    $('#generated-at').textContent = `数据生成 ${dt(DATA.generated_at)}`;
    const health = DATA.paper?.health || {};
    const status = health.status || 'unknown';
    $('#live-state').textContent = status === 'ready'
      ? '盘中就绪' : status === 'waiting_market' ? '等待开市' : status;
  }

  function renderOverview() {
    const history = DATA.history;
    const summary = history.summary || {};
    const weak = DATA.weak_signal_comparison || {};
    const all = weak.strong_plus_weak || {};
    const delta = weak.delta || {};
    const paper = DATA.paper?.summary || {};
    $('#overview-kpis').innerHTML = [
      kpi('强信号年度收益', pct(summary.annual_return),
        `${num(summary.closed_trades)} 笔闭环交易`, tone(summary.annual_return)),
      kpi('强弱全部年度收益', pct(all.annual_return),
        `增量 ${pct(delta.annual_return)}`, tone(all.annual_return)),
      kpi('闭环胜率', pct(all.win_rate),
        `强信号 ${pct(summary.win_rate)}`),
      kpi('主板股票', num(history.universe_count),
        `非 ST · 分钟触发完整 ${num(DATA.intraday_replay?.complete_count)}`),
      kpi('实时模拟净盈亏', cny(paper.net_pnl),
        `${num(paper.fill_count)} 笔成交`, tone(paper.net_pnl)),
      kpi('当前持仓', `${num(paper.holding_count)} 只`,
        `待卖 ${num(paper.pending_exit_count)} 只`),
    ].join('');

    const strongMonthly = history.monthly || [];
    const weakMonthly = weak.monthly || [];
    chart('monthly-chart', {
      animation: false,
      tooltip: { trigger: 'axis', valueFormatter: (v) => pct(v) },
      legend: { data: ['强信号', '强弱全部'], textStyle: { color: '#aab8bd' } },
      grid: { left: 52, right: 18, top: 44, bottom: 36 },
      xAxis: { ...axisBase(), type: 'category', data: strongMonthly.map(x => x.month.slice(5)) },
      yAxis: { ...axisBase(), type: 'value', axisLabel: { formatter: v => `${(v * 100).toFixed(0)}%` } },
      series: [
        { name: '强信号', type: 'bar', data: strongMonthly.map(x => x.return), itemStyle: { color: '#78a8e8' } },
        { name: '强弱全部', type: 'bar', data: weakMonthly.map(x => x.strong_plus_weak_return), itemStyle: { color: '#55c5c7' } },
      ],
    });
    chart('nav-chart', {
      animation: false,
      tooltip: { trigger: 'axis' },
      grid: { left: 52, right: 18, top: 26, bottom: 36 },
      xAxis: { ...axisBase(), type: 'category', data: strongMonthly.map(x => x.month.slice(5)) },
      yAxis: { ...axisBase(), type: 'value', axisLabel: { formatter: v => v.toFixed(2) } },
      series: [{
        name: '累计净值', type: 'line', smooth: false,
        data: strongMonthly.map(x => x.nav),
        lineStyle: { color: '#e5b94f', width: 2 },
        itemStyle: { color: '#e5b94f' }, areaStyle: { color: 'rgba(229,185,79,.08)' },
      }],
    });
    $('#monthly-table').innerHTML = `<thead><tr>
      <th>月份</th><th>强信号收益</th><th>强弱全部</th><th>增量</th>
      <th>买入</th><th>卖出</th><th>多头信号</th><th>空头信号</th><th>月末持仓</th>
    </tr></thead><tbody>${strongMonthly.map((row, index) => {
      const compare = weakMonthly[index] || {};
      return `<tr><td>${esc(row.month)}</td>
        <td class="${tone(row.return)}">${pct(row.return)}</td>
        <td class="${tone(compare.strong_plus_weak_return)}">${pct(compare.strong_plus_weak_return)}</td>
        <td class="${tone(compare.delta)}">${pct(compare.delta)}</td>
        <td>${num(row.buys)}</td><td>${num(row.sells)}</td>
        <td>${num(row.long_signals)}</td><td>${num(row.short_signals)}</td>
        <td>${num(row.holdings_end)}</td></tr>`;
    }).join('')}</tbody>`;
  }

  function filteredStocks() {
    const query = $('#stock-search').value.trim().toLowerCase();
    const filter = $('#stock-return-filter').value;
    const sort = $('#stock-sort').value;
    let rows = (DATA.stock_summary || []).filter(row => {
      if (query && !`${row.code}${row.name}`.toLowerCase().includes(query)) return false;
      if (filter === 'profit' && !(row.annual_return > 0)) return false;
      if (filter === 'loss' && !(row.annual_return < 0)) return false;
      if (filter === 'holding' && !row.holding_end) return false;
      return true;
    });
    const sorters = {
      return_desc: (a, b) => b.annual_return - a.annual_return,
      return_asc: (a, b) => a.annual_return - b.annual_return,
      trades_desc: (a, b) => b.closed_trades - a.closed_trades,
      drawdown_asc: (a, b) => a.max_month_end_drawdown - b.max_month_end_drawdown,
    };
    rows.sort(sorters[sort]);
    return rows;
  }

  function renderStocks() {
    const rows = filteredStocks();
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    stockPage = Math.min(stockPage, pages);
    const visible = rows.slice((stockPage - 1) * pageSize, stockPage * pageSize);
    $('#stock-count').textContent = `共 ${num(rows.length)} 只`;
    $('#stock-page').textContent = `${stockPage} / ${pages}`;
    $('#stock-prev').disabled = stockPage <= 1;
    $('#stock-next').disabled = stockPage >= pages;
    $('#stock-table').innerHTML = `<thead><tr>
      <th>代码</th><th>名称</th><th>年度收益</th><th>最大浮亏</th>
      <th>闭环胜率</th><th>买入</th><th>卖出</th><th>闭环交易</th><th>期末状态</th>
    </tr></thead><tbody>${visible.length ? visible.map(row => `<tr>
      <td><button class="stock-link" data-code="${esc(row.code)}">${esc(row.code)}</button></td>
      <td>${esc(row.name)}</td><td class="${tone(row.annual_return)}">${pct(row.annual_return)}</td>
      <td class="down">${pct(row.max_month_end_drawdown)}</td><td>${pct(row.win_rate)}</td>
      <td>${num(row.buy_count)}</td><td>${num(row.sell_count)}</td><td>${num(row.closed_trades)}</td>
      <td>${row.holding_end ? '持仓' : '现金'}</td></tr>`).join('') : emptyRow(9)}</tbody>`;
    document.querySelectorAll('.stock-link').forEach(button => {
      button.addEventListener('click', () => openStock(button.dataset.code));
    });
  }

  async function loadStocks() {
    if (!STOCKS) STOCKS = await loadFirst(['api/stocks', 'stocks.json']);
    return STOCKS;
  }

  async function openStock(code) {
    const payload = await loadStocks();
    const row = (payload.stocks || []).find(item => item.code === code);
    if (!row) return;
    $('#stock-dialog-title').textContent = `${row.code} ${row.name}`;
    $('#stock-dialog-meta').textContent =
      `年度收益 ${pct(row.annual_return)} · 闭环 ${num(row.closed_trades)} 笔 · 胜率 ${pct(row.win_rate)}`;
    const months = row.monthly || [];
    $('#stock-monthly').innerHTML = `<thead><tr><th>月份</th><th>月收益</th><th>累计收益</th><th>已实现</th><th>交易</th><th>月末</th></tr></thead>
      <tbody>${months.map(item => `<tr><td>${esc(item.month)}</td>
      <td class="${tone(item.return)}">${pct(item.return)}</td><td class="${tone(item.cumulative_return)}">${pct(item.cumulative_return)}</td>
      <td>${pct(item.realized_return)}</td><td>${num(item.realized_trades)}</td><td>${item.holding_end ? '持仓' : '现金'}</td></tr>`).join('')}</tbody>`;
    const executions = row.executions || [];
    $('#stock-executions').innerHTML = `<thead><tr><th>日期</th><th>时间</th><th>方向</th><th>价格</th><th>来源</th></tr></thead>
      <tbody>${executions.length ? executions.slice().reverse().map(item => `<tr>
      <td>${esc(item[0])}</td><td>${esc(item[1])}</td><td class="${item[2] > 0 ? 'up' : 'down'}">${item[2] > 0 ? '多头买入' : '空头卖出'}</td>
      <td>${num(item[3], 4)}</td><td>${esc(item[4])}</td></tr>`).join('') : emptyRow(5)}</tbody>`;
    $('#stock-dialog').showModal();
    requestAnimationFrame(() => {
      chart('stock-detail-chart', {
        animation: false, tooltip: { trigger: 'axis' },
        grid: { left: 52, right: 18, top: 22, bottom: 34 },
        xAxis: { ...axisBase(), type: 'category', data: months.map(x => x.month.slice(5)) },
        yAxis: { ...axisBase(), type: 'value', axisLabel: { formatter: v => `${(v * 100).toFixed(0)}%` } },
        series: [{ type: 'bar', data: months.map(x => ({
          value: x.return, itemStyle: { color: x.return >= 0 ? '#ef6666' : '#3fc28b' },
        })) }],
      });
    });
  }

  function renderPaper() {
    const summary = PAPER?.summary || DATA.paper?.summary || {};
    $('#paper-kpis').innerHTML = [
      kpi('独立账户', num(summary.account_count), cny(summary.initial_capital)),
      kpi('已实现盈亏', cny(summary.realized_pnl), '', tone(summary.realized_pnl)),
      kpi('浮动盈亏', cny(summary.unrealized_pnl), '', tone(summary.unrealized_pnl)),
      kpi('净盈亏', cny(summary.net_pnl), '', tone(summary.net_pnl)),
      kpi('持仓', `${num(summary.holding_count)} 只`, `待卖 ${num(summary.pending_exit_count)}`),
      kpi('模拟成交', `${num(summary.fill_count)} 笔`, '不连接券商'),
    ].join('');
    const health = DATA.paper?.health || {};
    $('#paper-status').textContent = health.status || '—';
    $('#paper-snapshot').textContent = dt(PAPER?.last_snapshot_at || DATA.paper?.last_snapshot_at);
    $('#paper-next-day').textContent = health.next_trading_day || '—';
    $('#paper-contract').textContent = PAPER?.contract || DATA.paper?.contract || '—';
    const accounts = (PAPER?.stocks || []).filter(row =>
      row.quantity || row.status !== 'cash' || row.net_pnl);
    $('#paper-stocks').innerHTML = `<thead><tr><th>代码</th><th>名称</th><th>状态</th><th>数量</th><th>标记价</th><th>市值</th><th>浮动盈亏</th><th>净盈亏</th></tr></thead>
      <tbody>${accounts.length ? accounts.map(row => `<tr><td>${esc(row.code)}</td><td>${esc(row.name)}</td><td>${esc(row.status)}</td>
      <td>${num(row.quantity)}</td><td>${num(row.mark_price, 3)}</td><td>${cny(row.market_value)}</td>
      <td class="${tone(row.unrealized_pnl)}">${cny(row.unrealized_pnl)}</td><td class="${tone(row.net_pnl)}">${cny(row.net_pnl)}</td></tr>`).join('') : emptyRow(8, '当前无持仓或异常账户')}</tbody>`;
    const fills = PAPER?.recent_fills || [];
    $('#paper-fills').innerHTML = `<thead><tr><th>时间</th><th>股票</th><th>方向</th><th>价格</th><th>数量</th><th>盈亏</th></tr></thead>
      <tbody>${fills.length ? fills.map(row => `<tr><td>${dt(row.quote_at)}</td><td>${esc(row.code)} ${esc(row.name)}</td>
      <td class="${row.side === 'buy' ? 'up' : 'down'}">${row.side === 'buy' ? '买入' : '卖出'}</td><td>${num(row.price, 3)}</td><td>${num(row.quantity)}</td>
      <td class="${tone(row.pnl)}">${cny(row.pnl)}</td></tr>`).join('') : emptyRow(6)}</tbody>`;
    const signals = PAPER?.recent_signals || [];
    $('#paper-signals').innerHTML = `<thead><tr><th>时间</th><th>股票</th><th>方向</th><th>强度</th><th>状态</th><th>原因</th></tr></thead>
      <tbody>${signals.length ? signals.map(row => `<tr><td>${dt(row.observed_at)}</td><td>${esc(row.code)}</td>
      <td class="${row.direction === 'LONG' ? 'up' : 'down'}">${esc(row.direction)}</td><td>${esc(row.strength)}</td>
      <td>${esc(row.status)}</td><td>${esc(row.reason)}</td></tr>`).join('') : emptyRow(6)}</tbody>`;
  }

  function renderResearch() {
    const research = DATA.research || {};
    const early = research.early_exit?.full_descriptive || {};
    const onset = research.winner_onset || {};
    const staged = onset.results?.heldout?.staged_3_1_1?.onset_winner_profile_v1 || {};
    const compare = onset.results?.heldout?.staged_3_1_1?.v2_probability || {};
    const entry = research.entry_price?.results?.all_periods || {};
    const validation = DATA.paper_validation || {};
    $('#research-kpis').innerHTML = [
      kpi('提前空点配对改善', pct(early.paired_improvement), `${num(early.stocks)} 只股票`, tone(early.paired_improvement)),
      kpi('提前空点胜率', pct(early.early_trade_win_rate), `原空点 ${pct(early.base_trade_win_rate)}`),
      kpi('赢家画像大涨股', num(staged.return_winner_count), `V2 ${num(compare.return_winner_count)}`),
      kpi('最大浮盈赢家', num(staged.mfe_winner_count), `V2 ${num(compare.mfe_winner_count)}`),
      kpi('下一开盘代理收益', pct(entry.next_bar_open_price?.mean_daily_return), '全样本每日 Top5'),
      kpi('分钟会计验收', validation.status === 'passed' ? '通过' : '待验收', `${num(validation.snapshots)} 个快照`),
    ].join('');

    const entryLabels = ['信号收盘', '下一开盘', '下一收盘'];
    const entryValues = [
      entry.signal_close_price?.mean_daily_return,
      entry.next_bar_open_price?.mean_daily_return,
      entry.entry_price?.mean_daily_return,
    ];
    chart('entry-chart', {
      animation: false, tooltip: { trigger: 'axis', valueFormatter: v => pct(v) },
      grid: { left: 54, right: 18, top: 20, bottom: 42 },
      xAxis: { ...axisBase(), type: 'category', data: entryLabels },
      yAxis: { ...axisBase(), type: 'value', axisLabel: { formatter: v => `${(v * 100).toFixed(1)}%` } },
      series: [{ type: 'bar', data: entryValues.map((value, index) => ({
        value, itemStyle: { color: ['#78a8e8', '#55c5c7', '#e5b94f'][index] },
      })) }],
    });
    const months = early.monthly || [];
    chart('exit-chart', {
      animation: false, tooltip: { trigger: 'axis', valueFormatter: v => pct(v) },
      legend: { data: ['原空点', '提前预警'], textStyle: { color: '#aab8bd' } },
      grid: { left: 54, right: 18, top: 44, bottom: 34 },
      xAxis: { ...axisBase(), type: 'category', data: months.map(x => x.month.slice(5)) },
      yAxis: { ...axisBase(), type: 'value', axisLabel: { formatter: v => `${(v * 100).toFixed(0)}%` } },
      series: [
        { name: '原空点', type: 'line', data: months.map(x => x.base_return), itemStyle: { color: '#78a8e8' } },
        { name: '提前预警', type: 'line', data: months.map(x => x.early_return), itemStyle: { color: '#e5b94f' } },
      ],
    });
    const splitNames = {
      train: '1-4月', validation: '5-6月',
      heldout: '7-8月', final_short_holdout: '9月',
    };
    const winnerRows = Object.entries(onset.results || {}).map(([key, node]) => {
      const profile = node.staged_3_1_1?.onset_winner_profile_v1 || {};
      const base = node.staged_3_1_1?.v2_probability || {};
      return `<tr><td>${splitNames[key] || key}</td><td>${num(profile.return_winner_count)}</td>
        <td>${num(base.return_winner_count)}</td><td>${num(profile.mfe_winner_count)}</td>
        <td>${num(base.mfe_winner_count)}</td><td>${pct(profile.fill_rate)}</td>
        <td class="${tone(profile.mean_return)}">${pct(profile.mean_return)}</td></tr>`;
    }).join('');
    $('#winner-table').innerHTML = `<thead><tr><th>样本</th><th>画像收益赢家</th><th>V2收益赢家</th>
      <th>画像浮盈赢家</th><th>V2浮盈赢家</th><th>填单率</th><th>平均收益</th></tr></thead>
      <tbody>${winnerRows || emptyRow(7)}</tbody>`;
    $('#validation-detail').innerHTML = [
      ['状态', validation.status === 'passed' ? '通过' : '待验收'],
      ['数据源', validation.source],
      ['范围', (validation.range || []).join(' 至 ')],
      ['股票', (validation.codes || []).join('、')],
      ['观察数', num(validation.observations)],
      ['快照数', num(validation.snapshots)],
      ['限制', validation.limitation],
      ['检查项', (validation.checks || []).join('；')],
    ].map(([label, value]) => `<div class="definition"><span>${esc(label)}</span><strong>${esc(value || '—')}</strong></div>`).join('');
  }

  function renderContracts() {
    const contracts = DATA.contracts || {};
    const items = [
      ['历史正式触发', contracts.history_entry],
      ['推荐历史入场代理', contracts.recommended_history_entry],
      ['实时成交', contracts.live_entry],
      ['真实交易控制', contracts.live_controls_trading ? '已启用' : '未启用，只读模拟'],
      ['历史收益契约', DATA.history?.return_contract],
      ['实盘模拟契约', DATA.paper?.contract],
      ['分钟引擎', DATA.intraday_replay?.engine_version],
      ['触发价格口径', DATA.intraday_replay?.price_contract],
    ];
    $('#contract-list').innerHTML = items.map(([label, value]) =>
      `<div class="definition"><span>${esc(label)}</span><strong>${esc(value || '—')}</strong></div>`).join('');
    const labels = {
      backtest: '历史回测', weak_compare: '强弱信号比较',
      triggers: '分钟触发', paper: '模拟账本',
      paper_health: '模拟心跳', paper_validation: '分钟验收',
      trend_live: '实时扫描', early_exit: '提前空点',
      winner_profile: '赢家画像', winner_onset: '首次多头',
      entry_price: '入场价格', winner_shadow: '即时影子',
    };
    const rows = Object.entries(DATA.source_status || {}).map(([key, value]) =>
      `<tr><td>${esc(labels[key] || key)}</td><td class="${value.available ? 'neutral' : 'down'}">${value.available ? '可用' : '缺失'}</td>
      <td>${dt(value.updated_at)}</td><td>${num(value.bytes / 1024 / 1024, 2)} MB</td></tr>`).join('');
    $('#source-table').innerHTML = `<thead><tr><th>数据</th><th>状态</th><th>更新时间</th><th>体积</th></tr></thead>
      <tbody>${rows || emptyRow(4)}</tbody>`;
  }

  function activateView(name) {
    document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `view-${name}`));
    document.querySelectorAll('.view-tabs button').forEach(node => node.classList.toggle('active', node.dataset.view === name));
    requestAnimationFrame(() => charts.forEach(instance => instance.resize()));
  }

  function bind() {
    document.querySelectorAll('.view-tabs button').forEach(button =>
      button.addEventListener('click', () => activateView(button.dataset.view)));
    ['stock-search', 'stock-return-filter', 'stock-sort'].forEach(id =>
      document.getElementById(id).addEventListener('input', () => {
        stockPage = 1; renderStocks();
      }));
    $('#stock-prev').addEventListener('click', () => { stockPage -= 1; renderStocks(); });
    $('#stock-next').addEventListener('click', () => { stockPage += 1; renderStocks(); });
    $('#stock-dialog-close').addEventListener('click', () => $('#stock-dialog').close());
    $('#refresh').addEventListener('click', () => location.reload());
    window.addEventListener('resize', () => charts.forEach(instance => instance.resize()));
  }

  async function boot() {
    try {
      [DATA, PAPER] = await Promise.all([
        loadFirst(['api/data', 'data.json']),
        loadFirst(['api/paper', 'paper.json']),
      ]);
      if (DATA.schema !== 'awakening-trend-dashboard-v1') {
        throw new Error('多空指标数据版本不兼容');
      }
      renderHeader();
      renderOverview();
      renderStocks();
      renderPaper();
      renderResearch();
      renderContracts();
      bind();
    } catch (error) {
      document.querySelector('main').innerHTML =
        `<section class="panel warning-panel"><h2>数据加载失败</h2><p>${esc(error.message)}</p></section>`;
      $('#live-state').textContent = '加载失败';
    }
  }

  boot();
})();
