(() => {
  'use strict';

  let DATA = null;
  let PAPER = null;
  let STOCKS = null;
  let stockMarketState = null;
  let stockPage = 1;
  const pageSize = 80;
  const charts = new Map();
  const stockDailyCache = new Map();
  const stockMinuteCache = new Map();
  const staticHost = location.hostname.endsWith('.github.io');

  const $ = (selector) => document.querySelector(selector);
  const dataPaths = (api, file) => staticHost ? [file] : [api, file];
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
    if (!node || !window.echarts) return null;
    const instance = charts.get(id) || echarts.init(node);
    charts.set(id, instance);
    instance.setOption(option, true);
    return instance;
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

  function candidateDays() {
    return DATA.daily_candidates?.days || [];
  }

  function candidateOutcome(item, field) {
    const value = item.evaluation?.[field];
    return value === null || value === undefined ? '—' : pct(value);
  }

  function renderCandidateDate(value) {
    const days = candidateDays();
    const index = days.findIndex(day => day.date === value);
    const day = index >= 0 ? days[index] : null;
    const input = $('#candidate-date');
    input.value = value || '';
    $('#candidate-prev').disabled = index <= 0;
    $('#candidate-next').disabled = index < 0 || index >= days.length - 1;
    $('#candidate-date-status').textContent = day
      ? `${day.date} · 交易日样本`
      : value ? `${value} · 无交易日样本` : '暂无样本';

    const evaluation = day?.evaluation || {};
    $('#candidate-kpis').innerHTML = [
      kpi('当日待定票', `${num(day?.candidate_count || 0)} 只`,
        `强多 ${num(day?.strong_candidate_count || 0)} · 弱多 ${num(day?.weak_candidate_count || 0)}`),
      kpi('早盘首次多头', `${num(day?.early_signal_count || 0)} 只`,
        '信号时间不晚于 10:00'),
      kpi('信号批次', `${num(day?.batch_count || 0)} 批`,
        '同一5分钟横向比较'),
      kpi('完整事后样本', `${num(evaluation.complete_count || 0)} 只`,
        `未成交 ${num(evaluation.unfilled_count || 0)} · 截尾 ${num(evaluation.censored_count || 0)}`),
      kpi('最终收益≥10%', `${num(evaluation.return_winner_count || 0)} 只`,
        '仅作事后验证'),
      kpi('最大浮盈≥20%', `${num(evaluation.mfe_winner_count || 0)} 只`,
        '仅作事后验证'),
    ].join('');

    const rows = day?.candidates || [];
    const statusLabel = {
      complete: '验证完成',
      unfilled: '下一周期未成交',
      censored: '后续样本不足',
    };
    $('#candidate-table').innerHTML = `<thead><tr>
      <th>信号</th><th>代码</th><th>名称</th><th>强弱</th><th>画像分</th>
      <th>5日波动排名</th><th>20日波动排名</th><th>位置压力排名</th>
      <th>信号时涨幅</th><th>验证状态</th><th>最终收益</th>
      <th>最大浮盈</th><th>最大浮亏</th>
    </tr></thead><tbody>${rows.length ? rows.map(item => {
      const selection = item.selection;
      const outcome = item.evaluation || {};
      return `<tr><td>${esc(selection.signal_time)}</td>
        <td><button class="stock-link candidate-stock-link" data-code="${esc(selection.code)}">${esc(selection.code)}</button></td>
        <td>${esc(selection.name)}</td>
        <td class="neutral">${selection.strength === 'strong' ? '强多' : '弱多'}</td>
        <td>${num(selection.score, 3)}</td>
        <td>${pct(selection.volatility_5_rank, 0)}</td>
        <td>${pct(selection.volatility_20_rank, 0)}</td>
        <td>${pct(selection.location_pressure_rank, 0)}</td>
        <td class="${tone(selection.intraday_return)}">${pct(selection.intraday_return)}</td>
        <td>${esc(statusLabel[outcome.status] || outcome.status)}</td>
        <td class="${tone(outcome.return)}">${candidateOutcome(item, 'return')}</td>
        <td class="${tone(outcome.max_floating_profit)}">${candidateOutcome(item, 'max_floating_profit')}</td>
        <td class="${tone(outcome.max_floating_loss)}">${candidateOutcome(item, 'max_floating_loss')}</td></tr>`;
    }).join('') : emptyRow(13, day ? '当日没有股票通过高质量启动规则' : '该日期没有交易日样本')}</tbody>`;
    document.querySelectorAll('.candidate-stock-link').forEach(button => {
      button.addEventListener('click', () => openStock(button.dataset.code));
    });
  }

  function renderCandidates() {
    const payload = DATA.daily_candidates || {};
    const summary = payload.summary || {};
    const accounts = DATA.candidate_account_comparison || {};
    const baseline = accounts.baseline_early_raw || {};
    const candidate = accounts.high_quality_candidates || {};
    const strongCandidate = accounts.high_quality_strong_only || {};
    const allStrengthCandidate =
      accounts.high_quality_strong_plus_weak || candidate;
    const weakContribution = accounts.weak_long_contribution || {};
    const delta = accounts.delta || {};
    const formal = accounts.formal_all_signal_reference || {};
    const formalWeakDelta =
      DATA.weak_signal_comparison?.delta?.annual_return;
    const days = candidateDays();
    const input = $('#candidate-date');
    if (days.length) {
      input.min = days[0].date;
      input.max = days[days.length - 1].date;
    }
    $('#candidate-hash').textContent = payload.selection_sha256
      ? `${num(summary.trading_days)} 日 · ${num(summary.candidate_count)} 只 · 选择哈希 ${payload.selection_sha256.slice(0, 16)}`
      : '选择哈希 —';
    $('#candidate-account-baseline').textContent =
      pct(baseline.annual_return);
    $('#candidate-account-baseline').className =
      tone(baseline.annual_return);
    $('#candidate-account-return').textContent =
      pct(candidate.annual_return);
    $('#candidate-account-return').className =
      tone(candidate.annual_return);
    $('#candidate-account-delta').textContent =
      pct(delta.annual_return);
    $('#candidate-account-delta').className =
      tone(delta.annual_return);
    $('#candidate-formal-reference').textContent =
      `${pct(formal.annual_return)} · 不同口径`;
    $('#candidate-formal-reference').className =
      tone(formal.annual_return);
    $('#candidate-strong-return').textContent =
      pct(strongCandidate.annual_return, 4);
    $('#candidate-strong-return').className =
      tone(strongCandidate.annual_return);
    $('#candidate-all-strength-return').textContent =
      pct(allStrengthCandidate.annual_return, 4);
    $('#candidate-all-strength-return').className =
      tone(allStrengthCandidate.annual_return);
    $('#candidate-weak-delta').textContent =
      pct(weakContribution.annual_return, 4);
    $('#candidate-weak-delta').className =
      tone(weakContribution.annual_return);
    $('#candidate-formal-weak-delta').textContent =
      pct(formalWeakDelta);
    $('#candidate-formal-weak-delta').className =
      tone(formalWeakDelta);
    renderCandidateDate(days.at(-1)?.date || '');
  }

  function moveCandidateDate(offset) {
    const days = candidateDays();
    const index = days.findIndex(
      day => day.date === $('#candidate-date').value);
    const target = days[index + offset];
    if (target) renderCandidateDate(target.date);
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
    document.querySelectorAll('#stock-table .stock-link').forEach(button => {
      button.addEventListener('click', () => openStock(button.dataset.code));
    });
  }

  async function loadStocks() {
    if (!STOCKS) {
      STOCKS = await loadFirst(dataPaths('api/stocks', 'stocks.json'));
    }
    return STOCKS;
  }

  async function loadStockDaily(code) {
    if (!stockDailyCache.has(code)) {
      const value = await loadFirst([
        `stocks/${code.slice(0, 2)}/${code}.json`,
      ]);
      if (
        value.schema !== 'awakening-stock-daily-v1'
        || value.code !== code
        || !Array.isArray(value.bars)
        || !value.bars.length
      ) {
        throw new Error('日K数据不完整');
      }
      stockDailyCache.set(code, value);
    }
    return stockDailyCache.get(code);
  }

  async function loadStockMinutes(code) {
    if (!stockMinuteCache.has(code)) {
      const value = await loadFirst([
        `minutes/${code.slice(0, 2)}/${code}.json`,
      ]);
      if (
        value.schema !== 'awakening-trend-signal-minutes-v1'
        || value.code !== code
        || !Array.isArray(value.days)
      ) {
        throw new Error('分时数据不完整');
      }
      stockMinuteCache.set(code, value);
    }
    return stockMinuteCache.get(code);
  }

  function stockDailyMarks(daily) {
    const build = (rows, strength) => (rows || []).map(item => {
      const index = Number(item[0]);
      const direction = Number(item[1]);
      const probability = Number(item[2]);
      const bar = daily.bars[index];
      if (!bar || ![1, -1].includes(direction)) return null;
      const long = direction === 1;
      return {
        name: strength === 'strong'
          ? (long ? '强多' : '强空')
          : (long ? '弱多' : '弱空'),
        coord: [index, long ? Number(bar[3]) : Number(bar[2])],
        value: long ? '多' : '空',
        symbol: strength === 'strong' ? 'circle' : 'emptyCircle',
        symbolSize: strength === 'strong' ? 28 : 22,
        symbolOffset: [0, long ? '68%' : '-68%'],
        itemStyle: {
          color: long ? '#ef6666' : '#3fc28b',
          borderColor: '#101619',
          borderWidth: strength === 'strong' ? 2 : 1,
          opacity: strength === 'strong' ? 1 : 0.78,
        },
        label: {
          show: true,
          color: '#ffffff',
          fontSize: strength === 'strong' ? 11 : 9,
          fontWeight: 700,
          formatter: long ? '多' : '空',
        },
        probability,
      };
    }).filter(Boolean);
    return [
      ...build(daily.signals, 'strong'),
      ...build(daily.filtered_signals, 'weak'),
    ];
  }

  function renderStockDaily() {
    const state = stockMarketState;
    if (!state?.daily) return;
    const daily = state.daily;
    const bars = daily.bars;
    const dates = bars.map(row => row[0]);
    const marks = stockDailyMarks(daily);
    const start = Math.max(0, 100 - (80 / bars.length) * 100);
    const instance = chart('stock-detail-chart', {
      animation: false,
      legend: {
        top: 2, right: 12, data: ['日K', '成交量'],
        textStyle: { color: '#94a3a8' },
      },
      tooltip: {
        trigger: 'axis', confine: true,
        formatter: items => {
          const index = items[0]?.dataIndex;
          const row = bars[index];
          if (!row) return '暂无数据';
          return `${esc(row[0])}<br>开 ${num(row[1], 3)}　收 ${num(row[4], 3)}`
            + `<br>高 ${num(row[2], 3)}　低 ${num(row[3], 3)}`
            + `<br>成交量 ${num(row[5])}`;
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 58, right: 18, top: 42, height: '58%' },
        { left: 58, right: 18, top: '75%', height: '11%' },
      ],
      xAxis: [
        {
          ...axisBase(), type: 'category', data: dates,
          boundaryGap: true, axisLabel: { show: false },
        },
        {
          ...axisBase(), type: 'category', gridIndex: 1,
          data: dates, boundaryGap: true,
          axisLabel: {
            color: '#94a3a8', hideOverlap: true,
            formatter: value => value.slice(5),
          },
        },
      ],
      yAxis: [
        {
          ...axisBase(), type: 'value', scale: true,
          axisLabel: { formatter: value => Number(value).toFixed(2) },
        },
        {
          ...axisBase(), type: 'value', scale: true, gridIndex: 1,
          axisLabel: {
            formatter: value => value >= 1e8
              ? `${(value / 1e8).toFixed(1)}亿`
              : value >= 1e4 ? `${(value / 1e4).toFixed(0)}万` : value,
          },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start, end: 100 },
        {
          type: 'slider', xAxisIndex: [0, 1],
          height: 18, bottom: 2, start, end: 100,
          borderColor: '#344149',
          backgroundColor: '#101619',
          fillerColor: 'rgba(85,197,199,.12)',
          textStyle: { color: '#94a3a8' },
        },
      ],
      series: [
        {
          name: '日K', type: 'candlestick',
          data: bars.map(row => [
            Number(row[1]), Number(row[4]),
            Number(row[3]), Number(row[2]),
          ]),
          itemStyle: {
            color: '#ef6666', color0: '#3fc28b',
            borderColor: '#ef6666', borderColor0: '#3fc28b',
          },
          markPoint: { silent: true, data: marks },
        },
        {
          name: '成交量', type: 'bar',
          xAxisIndex: 1, yAxisIndex: 1,
          data: bars.map(row => ({
            value: Number(row[5]),
            itemStyle: {
              color: Number(row[4]) >= Number(row[1])
                ? 'rgba(239,102,102,.55)'
                : 'rgba(63,194,139,.55)',
            },
          })),
        },
      ],
    });
    instance?.off('click');
    instance?.on('click', params => {
      const day = dates[params.dataIndex];
      if (!day || !state.minuteByDate.has(day)) return;
      state.date = day;
      $('#stock-minute-date').value = day;
      setStockMarketView('minute');
    });
    const strong = marks.filter(mark =>
      mark.name.startsWith('强')).length;
    const weak = marks.length - strong;
    $('#stock-market-status').textContent =
      `前复权日K ${bars[0][0]} 至 ${bars.at(-1)[0]} · 强信号 ${strong} · 弱信号 ${weak} · 点击信号K线查看分时`;
  }

  function renderStockMinute() {
    const state = stockMarketState;
    const day = state?.minuteByDate.get(state.date);
    if (!state || !day) {
      $('#stock-market-status').textContent =
        '该股票没有可用的历史信号日分时';
      charts.get('stock-detail-chart')?.clear();
      return;
    }
    const [date, previousClose, points, marks] = day;
    const times = points.map(point =>
      `${point[0].slice(0, 2)}:${point[0].slice(2)}`);
    const prices = points.map(point => Number(point[1]));
    const volumes = points.map(point => Number(point[2]));
    const span = Math.max(
      previousClose * 0.003,
      ...prices.map(price => Math.abs(price - previousClose)),
    ) * 1.12;
    const markPoints = marks.map(mark => {
      const time = `${mark[0].slice(0, 2)}:${mark[0].slice(2)}`;
      const index = times.indexOf(time);
      const long = Number(mark[1]) === 1;
      const weak = mark[2] === 'weak';
      return {
        name: weak
          ? (long ? '弱多买入' : '弱空卖出')
          : (long ? '多头买入' : '空头卖出'),
        coord: [index, Number(mark[4])],
        value: weak
          ? (long ? '弱买' : '弱卖')
          : (long ? '买' : '卖'),
        symbol: weak ? 'circle' : 'pin',
        symbolSize: weak ? 32 : 42,
        symbolOffset: [0, long ? '-45%' : '45%'],
        itemStyle: {
          color: weak
            ? '#101619'
            : (long ? '#ef6666' : '#3fc28b'),
          borderColor: long ? '#ef6666' : '#3fc28b',
          borderWidth: 2,
        },
        label: {
          show: true,
          color: weak
            ? (long ? '#ef6666' : '#3fc28b')
            : '#ffffff',
          fontSize: weak ? 9 : 11, fontWeight: 700,
          formatter: weak
            ? (long ? '弱买' : '弱卖')
            : (long ? '买' : '卖'),
        },
      };
    });
    const ticks = index => [
      0, 11, 24, 35, 47,
    ].includes(index);
    chart('stock-detail-chart', {
      animation: false,
      tooltip: {
        trigger: 'axis', confine: true,
        formatter: items => {
          const price = items.find(item => item.seriesName === '价格');
          if (!price) return '暂无数据';
          const change = (
            Number(price.value) / previousClose - 1
          ) * 100;
          return `${date} ${price.axisValue}<br>价格 ${num(price.value, 4)}`
            + `<br>涨跌幅 ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        },
      },
      grid: [
        { left: 58, right: 18, top: 34, height: '60%' },
        { left: 58, right: 18, top: '76%', height: '11%' },
      ],
      xAxis: [
        {
          ...axisBase(), type: 'category', data: times,
          boundaryGap: false,
          axisLabel: {
            color: '#94a3a8',
            interval: ticks,
            formatter: value => value,
          },
        },
        {
          ...axisBase(), type: 'category', gridIndex: 1,
          data: times, boundaryGap: true,
          axisLabel: { show: false },
        },
      ],
      yAxis: [
        {
          ...axisBase(), type: 'value',
          min: Math.max(0.01, previousClose - span),
          max: previousClose + span,
          axisLabel: { formatter: value => Number(value).toFixed(2) },
        },
        {
          ...axisBase(), type: 'value', gridIndex: 1,
          axisLabel: { show: false },
        },
      ],
      series: [
        {
          name: '价格', type: 'line', data: prices,
          showSymbol: false, connectNulls: false,
          lineStyle: { width: 2, color: '#78a8e8' },
          itemStyle: { color: '#78a8e8' },
          areaStyle: { color: 'rgba(120,168,232,.08)' },
          markPoint: { data: markPoints },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { type: 'dashed', color: '#e5b94f' },
            label: {
              show: true, position: 'start',
              color: '#e5b94f',
              formatter: Number(previousClose).toFixed(2),
            },
            data: [{ yAxis: Number(previousClose) }],
          },
        },
        {
          name: '成交量', type: 'bar',
          xAxisIndex: 1, yAxisIndex: 1,
          data: volumes.map((value, index) => ({
            value,
            itemStyle: {
              color: prices[index] >= previousClose
                ? 'rgba(239,102,102,.52)'
                : 'rgba(63,194,139,.52)',
            },
          })),
        },
      ],
    });
    const labels = marks.map(mark => {
      const direction = Number(mark[1]) === 1 ? '多买入' : '空卖出';
      const strength = mark[2] === 'strong' ? '强' : '弱';
      return `${mark[0].slice(0, 2)}:${mark[0].slice(2)} ${strength}${direction}`;
    });
    $('#stock-market-status').textContent =
      `${date} 前复权5分钟 · 昨收 ${num(previousClose, 3)} · ${labels.join(' · ')}`;
  }

  function setStockMarketView(view) {
    const state = stockMarketState;
    if (!state || !['daily', 'minute'].includes(view)) return;
    state.view = view;
    for (const name of ['daily', 'minute']) {
      const button = $(`#stock-${name}-tab`);
      const active = name === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    $('#stock-minute-date-wrap').hidden = view !== 'minute';
    requestAnimationFrame(() => {
      if (view === 'daily') renderStockDaily();
      else renderStockMinute();
      charts.get('stock-detail-chart')?.resize();
    });
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
    stockMarketState = {
      code, name: row.name, daily: null, minute: null,
      minuteByDate: new Map(), view: 'daily', date: '',
    };
    $('#stock-market-status').textContent = '正在读取日K和信号日分时';
    $('#stock-minute-date').innerHTML = '';
    $('#stock-minute-date-wrap').hidden = true;
    $('#stock-minute-tab').disabled = true;
    $('#stock-dialog').showModal();
    charts.get('stock-detail-chart')?.clear();
    const state = stockMarketState;
    const [dailyResult, minuteResult] = await Promise.allSettled([
      loadStockDaily(code),
      loadStockMinutes(code),
    ]);
    if (stockMarketState !== state) return;
    if (dailyResult.status === 'fulfilled') {
      state.daily = dailyResult.value;
    }
    if (minuteResult.status === 'fulfilled') {
      state.minute = minuteResult.value;
      state.minuteByDate = new Map(
        state.minute.days.map(day => [day[0], day]));
      const dates = [...state.minuteByDate.keys()].sort();
      state.date = dates.at(-1) || '';
      $('#stock-minute-date').innerHTML = dates.map(date =>
        `<option value="${esc(date)}">${esc(date)}</option>`).join('');
      $('#stock-minute-date').value = state.date;
      $('#stock-minute-tab').disabled = !dates.length;
    } else {
      $('#stock-minute-tab').disabled = true;
    }
    if (!state.daily) {
      $('#stock-market-status').textContent =
        '日K数据不可用；该股票暂时无法绘图';
      return;
    }
    setStockMarketView('daily');
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
    const commonality = research.winner_commonality || {};
    const commonRules = commonality.rules?.all || {};
    const currentRule = commonRules.current_high_quality || {};
    const capitalUnion = commonRules.current_or_capital_confirmed || {};
    const validation = DATA.paper_validation || {};
    $('#research-kpis').innerHTML = [
      kpi('提前空点配对改善', pct(early.paired_improvement), `${num(early.stocks)} 只股票`, tone(early.paired_improvement)),
      kpi('提前空点胜率', pct(early.early_trade_win_rate), `原空点 ${pct(early.base_trade_win_rate)}`),
      kpi('赢家画像大涨股', num(staged.return_winner_count), `V2 ${num(compare.return_winner_count)}`),
      kpi('最大浮盈赢家', num(staged.mfe_winner_count), `V2 ${num(compare.mfe_winner_count)}`),
      kpi('全量收益赢家', num(commonality.sample?.return_winners), `${num(commonality.sample?.events)} 条可成交样本`),
      kpi('板块补充召回', pct(capitalUnion.return_winner_recall), `原规则 ${pct(currentRule.return_winner_recall)}`),
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
    const commonSplits = ['all', 'train', 'validation', 'heldout', 'final_short_holdout'];
    const commonLabels = {
      all: '全样本', train: '1-4月', validation: '5-6月',
      heldout: '7-8月', final_short_holdout: '9月',
    };
    const commonRows = commonSplits.map(key => {
      const rules = commonality.rules?.[key] || {};
      const current = rules.current_high_quality || {};
      const union = rules.current_or_capital_confirmed || {};
      const leader = commonality.factor_audit?.industry_leader_rank?.splits?.[key];
      const flow = commonality.factor_audit?.industry_net_inflow_proxy_cny?.splits?.[key];
      const ranking = commonality.ranking?.[key] || {};
      const technicalTop5 = ranking.onset_winner_profile_v1?.return_winner_count;
      const industryTop5 = ranking.winner_industry_20?.return_winner_count;
      return `<tr><td>${esc(commonLabels[key] || key)}</td>
        <td>${pct(current.return_winner_recall)}</td><td>${pct(union.return_winner_recall)}</td>
        <td>${num(union.incremental_return_winners_vs_current)}</td>
        <td>${pct(current.return_winner_precision)}</td><td>${pct(union.return_winner_precision)}</td>
        <td>${leader ? num(leader.return_winner_auc, 3) : '—'}</td>
        <td>${flow ? num(flow.return_winner_auc, 3) : '—'}</td>
        <td>${technicalTop5 == null ? '—' : `${num(technicalTop5)} / ${num(industryTop5)}`}</td></tr>`;
    }).join('');
    $('#commonality-table').innerHTML = `<thead><tr><th>样本</th><th>原召回</th><th>资金补充召回</th>
      <th>补回赢家</th><th>原精度</th><th>补充后精度</th><th>板块内领涨 AUC</th>
      <th>净流入代理 AUC</th><th>Top5 技术/板块</th></tr></thead><tbody>${commonRows}</tbody>`;
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
      ['每日待定票', DATA.daily_candidates?.contract?.selection],
      ['待定票强弱分类', DATA.daily_candidates?.contract?.signal_strength],
      ['待定票未来收益参与', DATA.daily_candidates?.contract?.outcomes_used_for_selection ? '是' : '否'],
      ['候选账户基线', DATA.candidate_account_comparison?.contract?.baseline_entry],
      ['候选账户成交', DATA.candidate_account_comparison?.contract?.fill],
      ['弱空退出', DATA.candidate_account_comparison?.contract?.weak_short_exit_included ? '已包含' : '未包含'],
      ['历史收益契约', DATA.history?.return_contract],
      ['实盘模拟契约', DATA.paper?.contract],
      ['分钟引擎', DATA.intraday_replay?.engine_version],
      ['触发价格口径', DATA.intraday_replay?.price_contract],
      ['个股图表', `前复权日K + ${num(DATA.chart_assets?.signal_day_count)} 个强弱信号日5分钟分时`],
    ];
    $('#contract-list').innerHTML = items.map(([label, value]) =>
      `<div class="definition"><span>${esc(label)}</span><strong>${esc(value || '—')}</strong></div>`).join('');
    const labels = {
      backtest: '历史回测', weak_compare: '强弱信号比较',
      triggers: '分钟触发', paper: '模拟账本',
      paper_health: '模拟心跳', paper_validation: '分钟验收',
      trend_live: '实时扫描', early_exit: '提前空点',
      winner_profile: '赢家画像', winner_commonality: '大涨股共性',
      winner_onset: '首次多头',
      entry_price: '入场价格', winner_shadow: '即时影子',
      daily_candidates: '每日待定票',
      candidate_accounts: '候选账户对照',
      chart_manifest: '个股图表资源',
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
    $('#candidate-date').addEventListener(
      'change', event => renderCandidateDate(event.target.value));
    $('#candidate-prev').addEventListener(
      'click', () => moveCandidateDate(-1));
    $('#candidate-next').addEventListener(
      'click', () => moveCandidateDate(1));
    $('#stock-daily-tab').addEventListener(
      'click', () => setStockMarketView('daily'));
    $('#stock-minute-tab').addEventListener(
      'click', () => setStockMarketView('minute'));
    $('#stock-minute-date').addEventListener('change', event => {
      if (!stockMarketState) return;
      stockMarketState.date = event.target.value;
      renderStockMinute();
    });
    $('#stock-dialog-close').addEventListener('click', () => $('#stock-dialog').close());
    $('#stock-dialog').addEventListener('close', () => {
      stockMarketState = null;
      charts.get('stock-detail-chart')?.off('click');
    });
    $('#refresh').addEventListener('click', () => location.reload());
    window.addEventListener('resize', () => charts.forEach(instance => instance.resize()));
  }

  async function boot() {
    try {
      [DATA, PAPER] = await Promise.all([
        loadFirst(dataPaths('api/data', 'data.json')),
        loadFirst(dataPaths('api/paper', 'paper.json')),
      ]);
      if (DATA.schema !== 'awakening-trend-dashboard-v1') {
        throw new Error('多空指标数据版本不兼容');
      }
      renderHeader();
      renderOverview();
      renderCandidates();
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
