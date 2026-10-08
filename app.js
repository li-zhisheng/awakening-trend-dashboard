(() => {
  'use strict';

  let DATA = null;
  let PAPER = null;
  let stockMarketState = null;
  let stockPage = 1;
  const pageSize = 80;
  const charts = new Map();
  const stockDetailCache = new Map();
  const stockDailyCache = new Map();
  const stockMinuteCache = new Map();
  const stockLiveCache = new Map();
  const staticHost = location.hostname.endsWith('.github.io');
  const signalColors = {
    strongLong: '#ef6666',
    weakLong: '#ef6666',
    strongShort: '#3fc28b',
    weakShort: '#3fc28b',
  };
  const minuteClocks = [
    ...Array.from({ length: 24 }, (_, index) => {
      const total = 9 * 60 + 35 + index * 5;
      return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
    }),
    ...Array.from({ length: 24 }, (_, index) => {
      const total = 13 * 60 + index * 5;
      return index === 23
        ? '1500'
        : `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
    }),
  ];

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
  const clock = (value) => /^\d{4}$/.test(String(value || ''))
    ? `${String(value).slice(0, 2)}:${String(value).slice(2)}`
    : String(value || '—');
  const tone = (value) => Number(value) > 0
    ? 'up' : Number(value) < 0 ? 'down' : 'neutral';
  const isLongSignal = direction =>
    Number(direction) === 1 || direction === 'LONG';
  const signalLabel = (direction, strength) => {
    const long = isLongSignal(direction);
    return strength === 'weak'
      ? (long ? '涨' : '跌')
      : (long ? '多' : '空');
  };
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

  function movingAverage(values, period) {
    let sum = 0;
    return values.map((value, index) => {
      sum += Number(value);
      if (index >= period) sum -= Number(values[index - period]);
      return index >= period - 1
        ? Number((sum / period).toFixed(4))
        : null;
    });
  }

  function renderHeader() {
    $('#generated-at').textContent = `数据生成 ${dt(DATA.generated_at)}`;
    const health = DATA.trend_validation || DATA.paper?.health || {};
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
      ? `${day.date} · ${day.mode === 'live_shadow'
        ? `盘中实时影子 · 更新 ${dt(day.updated_at)}`
        : '交易日样本'}`
      : value ? `${value} · 无交易日样本` : '暂无样本';

    const evaluation = day?.evaluation || {};
    $('#candidate-kpis').innerHTML = [
      kpi('当日待定票', `${num(day?.candidate_count || 0)} 只`,
        `多 ${num(day?.strong_candidate_count || 0)} · 涨 ${num(day?.weak_candidate_count || 0)}`),
      kpi('早盘首次多头', `${num(day?.early_signal_count || 0)} 只`,
        '信号时间不晚于 10:00'),
      kpi('信号批次', `${num(day?.batch_count || 0)} 批`,
        '同一5分钟横向比较'),
      kpi('完整事后样本', `${num(evaluation.complete_count || 0)} 只`,
        day?.mode === 'live_shadow'
          ? '盘中名单尚无事后收益'
          : `未成交 ${num(evaluation.unfilled_count || 0)} · 截尾 ${num(evaluation.censored_count || 0)}`),
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
      live_pending: '盘中观察',
    };
    $('#candidate-table').innerHTML = `<thead><tr>
      <th>信号时间</th><th>代码</th><th>名称</th><th>行业/板块</th><th>信号</th><th>画像分</th>
      <th>5日波动排名</th><th>20日波动排名</th><th>位置压力排名</th>
      <th>信号时涨幅</th><th>验证状态</th><th>最终收益</th>
      <th>最大浮盈</th><th>最大浮亏</th>
    </tr></thead><tbody>${rows.length ? rows.map(item => {
      const selection = item.selection;
      const outcome = item.evaluation || {};
      return `<tr><td>${esc(selection.signal_time)}</td>
        <td><button class="stock-link candidate-stock-link" data-code="${esc(selection.code)}">${esc(selection.code)}</button></td>
        <td>${esc(selection.name)}</td>
        <td>${esc(selection.industry || '—')}</td>
        <td class="up">${signalLabel(1, selection.strength)}</td>
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

  async function loadStockDetail(code) {
    if (!stockDetailCache.has(code)) {
      const value = await loadFirst([
        `details/${code.slice(0, 2)}/${code}.json`,
      ]);
      if (value.code !== code) {
        throw new Error('个股账户明细不完整');
      }
      stockDetailCache.set(code, value);
    }
    return stockDetailCache.get(code);
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
      const live = await loadStockLive(code);
      if (live?.days?.length) {
        const bars = value.bars.slice();
        const liveSignals = [];
        for (const day of live.days) {
          if (!day.points?.length) continue;
          const prices = day.points.map(point => Number(point[1]));
          const volume = day.points.reduce(
            (total, point) => total + Number(point[2] || 0), 0);
          const exact = live.daily_bar?.date === day.date
            ? live.daily_bar : null;
          const row = exact ? [
            day.date, Number(exact.open), Number(exact.high),
            Number(exact.low), Number(exact.close),
            Number(exact.volume),
          ] : [
            day.date, prices[0], Math.max(...prices),
            Math.min(...prices), prices.at(-1), volume,
          ];
          const index = bars.findIndex(bar => bar[0] === day.date);
          if (index >= 0) bars[index] = row;
          else bars.push(row);
          for (const mark of day.marks || []) {
            liveSignals.push({
              date: day.date, time: mark[0],
              direction: Number(mark[1]), strength: mark[2],
              probability: Number(mark[3]), price: Number(mark[4]),
            });
          }
        }
        bars.sort((left, right) => left[0].localeCompare(right[0]));
        value.bars = bars;
        value.liveSignals = liveSignals;
      }
      stockDailyCache.set(code, value);
    }
    return stockDailyCache.get(code);
  }

  async function loadStockLive(code) {
    if (!stockLiveCache.has(code)) {
      try {
        const value = await loadFirst(staticHost ? [
          `live/${code.slice(0, 2)}/${code}.json`,
        ] : [
          `/api/live-stock?code=${encodeURIComponent(code)}`,
          `live/${code.slice(0, 2)}/${code}.json`,
        ]);
        if (
          value.schema !== 'awakening-trend-live-stock-v1'
          || value.code !== code
          || !Array.isArray(value.days)
        ) {
          throw new Error('实时行情数据不完整');
        }
        stockLiveCache.set(code, value);
      } catch (_error) {
        stockLiveCache.set(code, null);
      }
    }
    return stockLiveCache.get(code);
  }

  async function loadStockMinutes(code) {
    if (!stockMinuteCache.has(code)) {
      const value = await loadFirst([
        `minutes/${code.slice(0, 2)}/${code}.json`,
      ]);
      if (![
        'awakening-trend-all-day-minutes-v2',
        'awakening-trend-all-day-minutes-v3',
        'awakening-trend-all-day-minutes-v4',
      ].includes(value.schema) || value.code !== code
        || !Array.isArray(value.days)) {
        throw new Error('分时数据不完整');
      }
      const days = value.days.map(day => {
        const legacy = value.schema.endsWith('-v2');
        const [date, previousClose] = day;
        const clocks = minuteClocks;
        const deltas = day[2];
        const volumes = day[3];
        const averageDeltas = legacy ? null : day[5];
        const marks = day[4];
        if (
          !Array.isArray(clocks)
          || !Array.isArray(deltas)
          || !Array.isArray(volumes)
          || deltas.length !== clocks.length
          || volumes.length !== clocks.length
          || (
            averageDeltas != null
            && (
              !Array.isArray(averageDeltas)
              || averageDeltas.length !== clocks.length
            )
          )
        ) {
          throw new Error(`分时数据不完整: ${date}`);
        }
        let scaledPrice = 0;
        let scaledAverage = 0;
        const points = deltas.map((delta, index) => {
          scaledPrice = index === 0
            ? Number(delta)
            : scaledPrice + Number(delta);
          if (averageDeltas) {
            scaledAverage = index === 0
              ? Number(averageDeltas[index])
              : scaledAverage + Number(averageDeltas[index]);
          }
          return [
            clocks[index],
            scaledPrice / 10000,
            Number(volumes[index]),
            null,
            averageDeltas ? scaledAverage / 10000 : null,
          ];
        });
        return [
          date, previousClose, points, marks || [],
          'BaoStock 历史5分钟价量数据',
          legacy ? '5分钟' : '5分钟', null,
        ];
      });
      const live = await loadStockLive(code);
      if (live) {
        try {
          for (const day of live.days || []) {
            const normalized = [
              day.date, Number(day.previous_close),
              day.points || [], day.marks || [],
              day.source || '腾讯/新浪批量实时快照',
              day.frequency || '约1分钟真实快照',
              day.auction || null,
            ];
            const index = days.findIndex(item => item[0] === day.date);
            if (index >= 0) days[index] = normalized;
            else days.push(normalized);
          }
          days.sort((left, right) => left[0].localeCompare(right[0]));
        } catch (_error) {
          // Historical data remains available when the live store is empty.
        }
      }
      stockMinuteCache.set(code, { ...value, days });
    }
    return stockMinuteCache.get(code);
  }

  function renderStockAccountDetail(row) {
    const months = row.monthly || [];
    $('#stock-monthly').innerHTML = `<thead><tr><th>月份</th><th>月收益</th><th>累计收益</th><th>已实现</th><th>交易</th><th>月末</th></tr></thead>
      <tbody>${months.length ? months.map(item => `<tr><td>${esc(item.month)}</td>
      <td class="${tone(item.return)}">${pct(item.return)}</td><td class="${tone(item.cumulative_return)}">${pct(item.cumulative_return)}</td>
      <td>${pct(item.realized_return)}</td><td>${num(item.realized_trades)}</td><td>${item.holding_end ? '持仓' : '现金'}</td></tr>`).join('') : emptyRow(6)}</tbody>`;
    const executions = row.executions || [];
    $('#stock-executions').innerHTML = `<thead><tr><th>日期</th><th>时间</th><th>方向</th><th>价格</th><th>来源</th></tr></thead>
      <tbody>${executions.length ? executions.slice().reverse().map(item => `<tr>
      <td>${esc(item[0])}</td><td>${esc(clock(item[1]))}</td><td class="${item[2] > 0 ? 'up' : 'down'}">${item[2] > 0 ? '多头买入' : '空头卖出'}</td>
      <td>${num(item[3], 2)}</td><td>${esc(item[4])}</td></tr>`).join('') : emptyRow(5)}</tbody>`;
  }

  function stockDailyMarks(daily) {
    const build = (rows, strength) => (rows || []).map(item => {
      const index = Number(item[0]);
      const direction = Number(item[1]);
      const probability = Number(item[2]);
      const bar = daily.bars[index];
      if (!bar || ![1, -1].includes(direction)) return null;
      const long = direction === 1;
      const strong = strength === 'strong';
      const label = signalLabel(direction, strength);
      const color = long
        ? (strong ? signalColors.strongLong : signalColors.weakLong)
        : (strong ? signalColors.strongShort : signalColors.weakShort);
      return {
        name: label,
        direction,
        strength,
        coord: [index, long ? Number(bar[3]) : Number(bar[2])],
        value: label,
        symbol: 'circle',
        symbolSize: strong ? 28 : 22,
        symbolOffset: [0, long ? '68%' : '-68%'],
        itemStyle: {
          color,
          borderColor: '#101619',
          borderWidth: strong ? 2 : 1,
          opacity: strong ? 1 : .9,
        },
        label: {
          show: true,
          color: '#ffffff',
          fontSize: strong ? 11 : 9,
          fontWeight: 700,
          formatter: label,
        },
        probability,
      };
    }).filter(Boolean);
    const result = [
      ...build(daily.signals, 'strong'),
      ...build(daily.filtered_signals, 'weak'),
    ];
    const dates = daily.bars.map(row => row[0]);
    for (const signal of daily.liveSignals || []) {
      const index = dates.indexOf(signal.date);
      if (index < 0) continue;
      const bar = daily.bars[index];
      const long = signal.direction === 1;
      const strong = signal.strength === 'strong';
      const label = signalLabel(signal.direction, signal.strength);
      result.push({
        name: `盘中首${label}`,
        direction: signal.direction,
        strength: signal.strength,
        coord: [index, long ? Number(bar[3]) : Number(bar[2])],
        value: label,
        symbol: 'diamond',
        symbolSize: 22,
        itemStyle: {
          color: long
            ? (strong ? signalColors.strongLong : signalColors.weakLong)
            : (strong ? signalColors.strongShort : signalColors.weakShort),
          borderColor: '#101619', borderWidth: 2,
        },
        label: {
          show: true, color: '#ffffff', fontSize: 9,
          fontWeight: 700, formatter: label,
        },
      });
    }
    const existingLongDates = new Set(
      result.filter(mark => Number(mark.direction) === 1)
        .map(mark => dates[mark.coord[0]]));
    for (const day of candidateDays()) {
      for (const item of day.candidates || []) {
        const selection = item.selection || {};
        if (
          selection.code !== stockMarketState?.code
          || existingLongDates.has(day.date)
        ) continue;
        const index = dates.indexOf(day.date);
        if (index < 0) continue;
        const bar = daily.bars[index];
        const strong = selection.strength === 'strong';
        const label = signalLabel(1, selection.strength);
        result.push({
          name: `待定${label}`,
          direction: 1,
          strength: selection.strength,
          coord: [index, Number(bar[3])],
          value: label,
          symbol: 'pin',
          symbolSize: 28,
          symbolOffset: [0, '60%'],
          itemStyle: {
            color: strong
              ? signalColors.strongLong : signalColors.weakLong,
            borderColor: '#101619', borderWidth: 1,
          },
          label: {
            show: true, color: '#ffffff', fontSize: 9,
            fontWeight: 700, formatter: label,
          },
        });
        existingLongDates.add(day.date);
      }
    }
    return result;
  }

  function renderStockDaily() {
    const state = stockMarketState;
    if (!state?.daily) return;
    const daily = state.daily;
    const bars = daily.bars;
    const dates = bars.map(row => row[0]);
    const closes = bars.map(row => Number(row[4]));
    const ma5 = movingAverage(closes, 5);
    const ma10 = movingAverage(closes, 10);
    const ma20 = movingAverage(closes, 20);
    const marks = stockDailyMarks(daily);
    const start = Math.max(0, 100 - (80 / bars.length) * 100);
    const instance = chart('stock-detail-chart', {
      animation: false,
      legend: {
        top: 2, right: 12,
        data: ['MA5', 'MA10', 'MA20'],
        textStyle: { color: '#94a3a8' },
      },
      tooltip: {
        trigger: 'axis', confine: true,
        formatter: items => {
          const index = items[0]?.dataIndex;
          const row = bars[index];
          if (!row) return '暂无数据';
          const averages = [
            ['MA5', ma5[index]],
            ['MA10', ma10[index]],
            ['MA20', ma20[index]],
          ].filter(item => item[1] != null)
            .map(item => `${item[0]} ${num(item[1], 2)}`)
            .join('　');
          return `${esc(row[0])}<br>开 ${num(row[1], 3)}　收 ${num(row[4], 3)}`
            + `<br>高 ${num(row[2], 3)}　低 ${num(row[3], 3)}`
            + (averages ? `<br>${averages}` : '')
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
          name: 'MA5', type: 'line', data: ma5,
          showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.4, color: '#e5b94f' },
          itemStyle: { color: '#e5b94f' },
        },
        {
          name: 'MA10', type: 'line', data: ma10,
          showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.4, color: '#55c5c7' },
          itemStyle: { color: '#55c5c7' },
        },
        {
          name: 'MA20', type: 'line', data: ma20,
          showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.4, color: '#c084fc' },
          itemStyle: { color: '#c084fc' },
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
      if (
        params.componentType !== 'series'
        || params.seriesType !== 'candlestick'
        || params.seriesName !== '日K'
      ) return;
      const day = dates[params.dataIndex];
      if (!day) return;
      state.date = day;
      $('#stock-minute-date').value = day;
      setStockMarketView('minute');
    });
    const strong = marks.filter(mark =>
      mark.strength === 'strong').length;
    const weak = marks.length - strong;
    $('#stock-market-status').textContent =
      `前复权日K ${bars[0][0]} 至 ${bars.at(-1)[0]} · 多/空 ${strong} · 涨/跌 ${weak} · 点击任意K线查看当天分时`;
  }

  function renderStockMinute() {
    const state = stockMarketState;
    const day = state?.minuteByDate.get(state.date);
    if (!state || !day) {
      $('#stock-market-status').textContent =
        '该交易日没有可用的历史分时';
      charts.get('stock-detail-chart')?.clear();
      return;
    }
    const [
      date, previousClose, minutePoints, rawMarks,
      source, frequency, auction,
    ] = day;
    const auctionPoints = (auction?.points || [])
      .filter(point =>
        Number.isFinite(Number(point.qfq_price))
        && Number(point.qfq_price) > 0)
      .map(point => {
        const match = String(point.quote_at || '').match(
          /T(\d{2}):(\d{2}):(\d{2})/);
        return [
          match ? `${match[1]}${match[2]}${match[3]}` : '',
          Number(point.qfq_price), 0, null, null, true,
          Number(point.matched_amount_cny || 0),
        ];
      }).filter(point => point[0]);
    const auctionCount = auctionPoints.length;
    const points = [...auctionPoints, ...minutePoints];
    const times = points.map(point =>
      `${point[0].slice(0, 2)}:${point[0].slice(2, 4)}`
      + (point[0].length > 4 ? `:${point[0].slice(4, 6)}` : ''));
    const prices = points.map(point => Number(point[1]));
    const regularPrices = points.map((point, index) =>
      index < auctionCount ? null : Number(point[1]));
    const auctionPrices = points.map((point, index) =>
      index < auctionCount ? Number(point[1]) : null);
    const volumes = points.map(point => Number(point[2]));
    const amounts = points.map(point =>
      point[3] == null ? null : Number(point[3]));
    let cumulativeVolume = 0;
    let cumulativeAmount = 0;
    const averagePrices = points.map((point, index) => {
      if (index < auctionCount) return null;
      if (point[4] != null && Number.isFinite(Number(point[4]))) {
        return Number(point[4]);
      }
      if (amounts[index] == null) return null;
      cumulativeVolume += Math.max(0, volumes[index]);
      cumulativeAmount += Math.max(0, amounts[index]);
      return cumulativeVolume > 0
        ? cumulativeAmount / cumulativeVolume : null;
    });
    const hasAverage = averagePrices.some(value =>
      Number.isFinite(value));
    const hasVolume = volumes.some(value => value > 0);
    const marks = [...(rawMarks || [])];
    if (!marks.some(mark => Number(mark[1]) === 1)) {
      const candidate = candidateDays()
        .find(item => item.date === date)?.candidates
        ?.find(item => item.selection?.code === state.code);
      if (candidate) {
        const selection = candidate.selection;
        let index = points.findIndex(
          point => point[0] === selection.signal_time);
        if (index < 0) {
          index = points.findIndex(
            point => point[0] > selection.signal_time);
        }
        if (index >= 0) {
          marks.push([
            points[index][0], 1, selection.strength,
            selection.retention_probability, prices[index],
          ]);
        }
      }
    }
    const span = Math.max(
      previousClose * 0.003,
      ...prices.map(price => Math.abs(price - previousClose)),
    ) * 1.12;
    const markPoints = marks.map(mark => {
      const time = clock(mark[0]);
      const index = times.indexOf(time);
      const long = Number(mark[1]) === 1;
      const weak = mark[2] === 'weak';
      const label = signalLabel(mark[1], mark[2]);
      const price = Number(mark[4]);
      const change = (price / previousClose - 1) * 100;
      const color = long
        ? (weak ? signalColors.weakLong : signalColors.strongLong)
        : (weak ? signalColors.weakShort : signalColors.strongShort);
      const changeText =
        `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      return {
        name: label,
        coord: [index, price],
        value: `${label} ${changeText}`,
        symbol: 'circle',
        symbolSize: weak ? 12 : 16,
        symbolOffset: [0, long ? '-55%' : '55%'],
        itemStyle: {
          color,
          borderColor: '#101619',
          borderWidth: weak ? 1 : 2,
        },
        label: {
          show: true,
          position: long ? 'top' : 'bottom',
          distance: weak ? 16 : 22,
          color,
          backgroundColor: 'rgba(13,17,20,.92)',
          borderColor: color,
          borderWidth: 1,
          borderRadius: 3,
          padding: [3, 5],
          fontSize: weak ? 9 : 10,
          lineHeight: 14,
          fontWeight: 700,
          formatter: `${label} ${changeText}\n${price.toFixed(2)}`,
        },
      };
    });
    const ticks = (index, value) =>
      index === 0 || index === times.length - 1
      || ['10:30', '11:30', '14:00', '15:00'].includes(value);
    const legend = ['价格'];
    if (auctionCount) legend.push('竞价走势');
    if (hasAverage) legend.push('当日均价');
    if (hasVolume) legend.push('成交量');
    const instance = chart('stock-detail-chart', {
      animation: false,
      legend: {
        top: 2, right: 12,
        data: legend,
        textStyle: { color: '#94a3a8' },
      },
      tooltip: {
        trigger: 'axis', confine: true,
        formatter: items => {
          const price = items.find(item => item.seriesName === '价格');
          const auctionPrice = items.find(
            item => item.seriesName === '竞价走势');
          const volume = items.find(
            item => item.seriesName === '成交量');
          const dataIndex = price?.dataIndex
            ?? auctionPrice?.dataIndex ?? volume?.dataIndex;
          if (dataIndex == null) return '';
          const currentPrice = Number(
            price?.value ?? auctionPrice?.value
            ?? prices[dataIndex]);
          const change = (
            currentPrice / previousClose - 1
          ) * 100;
          const averages = items
            .filter(item => item.seriesName === '当日均价')
            .map(item =>
              `${item.seriesName} ${num(item.value, 2)}`)
            .join('　');
          const time = price?.axisValue
            || volume?.axisValue || times[dataIndex];
          return `${date} ${time}<br>价格 ${num(currentPrice, 2)}`
            + `<br>涨跌幅 ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
            + (averages ? `<br>${averages}` : '')
            + (points[dataIndex]?.[5]
              ? `<br>竞价匹配额 ${cny(points[dataIndex][6])}`
              : '')
            + (volume
              && dataIndex >= auctionCount
              ? `<br>分钟成交量 ${num(volumes[dataIndex])} 股`
              : '');
        },
      },
      grid: hasVolume ? [
        { left: 58, right: 18, top: 82, height: '46%' },
        { left: 58, right: 18, top: '76%', height: '11%' },
      ] : [
        { left: 58, right: 18, top: 82, bottom: 48 },
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
        ...(hasVolume ? [{
          ...axisBase(), type: 'category', gridIndex: 1,
          data: times, boundaryGap: true,
          axisLabel: { show: false },
        }] : []),
      ],
      yAxis: [
        {
          ...axisBase(), type: 'value',
          min: Math.max(0.01, previousClose - span),
          max: previousClose + span,
          axisLabel: {
            formatter: value => {
              const change = (
                Number(value) / previousClose - 1
              ) * 100;
              const normalized = Math.abs(change) < .005
                ? 0 : change;
              return `${normalized > 0 ? '+' : ''}${normalized.toFixed(2)}%`;
            },
          },
        },
        ...(hasVolume ? [{
          ...axisBase(), type: 'value', gridIndex: 1,
          axisLabel: { show: false },
        }] : []),
      ],
      series: [
        {
          name: '价格', type: 'line', data: regularPrices,
          showSymbol: false, connectNulls: false,
          lineStyle: { width: 2, color: '#78a8e8' },
          itemStyle: { color: '#78a8e8' },
          areaStyle: { color: 'rgba(120,168,232,.08)' },
          labelLayout: { moveOverlap: 'shiftY' },
          markPoint: { data: markPoints },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { type: 'dashed', color: '#e5b94f' },
            label: {
              show: true, position: 'start',
              color: '#e5b94f',
              formatter: '0.00%',
            },
            data: [{ yAxis: Number(previousClose) }],
          },
        },
        ...(auctionCount ? [{
          name: '竞价走势', type: 'line', data: auctionPrices,
          showSymbol: true, symbolSize: 7, connectNulls: false,
          lineStyle: {
            width: 1.8, type: 'dashed', color: '#e5b94f',
          },
          itemStyle: { color: '#e5b94f' },
        }] : []),
        ...(hasAverage ? [{
          name: '当日均价', type: 'line', data: averagePrices,
          showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.3, color: '#e5b94f' },
          itemStyle: { color: '#e5b94f' },
        }] : []),
        ...(hasVolume ? [{
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
        }] : []),
      ],
    });
    instance?.off('click');
    const labels = marks.map(mark => {
      return `${clock(mark[0])} ${signalLabel(mark[1], mark[2])}`;
    });
    $('#stock-market-status').textContent =
      `${date} 前复权${frequency || '分时'} · ${source || '历史行情'} · 昨收 ${num(previousClose, 3)}`
      + (auctionCount
        ? ` · 竞价 ${auctionCount} 点`
        : auction?.status === 'not_in_watch_pool'
          ? ' · 未纳入竞价观察池'
          : '')
      + (labels.length ? ` · ${labels.join(' · ')}` : '');
  }

  function syncStockMinuteNavigation() {
    const state = stockMarketState;
    const dates = state
      ? [...state.minuteByDate.keys()].sort()
      : [];
    const index = dates.indexOf(state?.date);
    $('#stock-minute-prev').disabled = index <= 0;
    $('#stock-minute-next').disabled =
      index < 0 || index >= dates.length - 1;
  }

  function moveStockMinuteDate(offset) {
    const state = stockMarketState;
    if (!state) return;
    const dates = [...state.minuteByDate.keys()].sort();
    const index = dates.indexOf(state.date);
    const target = dates[index + offset];
    if (!target) return;
    state.date = target;
    $('#stock-minute-date').value = target;
    renderStockMinute();
    syncStockMinuteNavigation();
  }

  async function ensureStockMinutes(state) {
    if (state.minute) return true;
    if (!state.minutePromise) {
      state.minutePromise = loadStockMinutes(state.code);
    }
    try {
      const minute = await state.minutePromise;
      if (stockMarketState !== state) return false;
      state.minute = minute;
      state.minuteByDate = new Map(
        minute.days.map(day => [day[0], day]));
      const dates = [...state.minuteByDate.keys()].sort();
      state.date = state.date || dates.at(-1) || '';
      $('#stock-minute-date').innerHTML = dates.map(day =>
        `<option value="${esc(day)}">${esc(day)}</option>`).join('');
      $('#stock-minute-date').value = state.date;
      syncStockMinuteNavigation();
      if (!dates.length) {
        $('#stock-market-status').textContent =
          '该股票没有可用的历史分时';
      }
      return Boolean(dates.length);
    } catch (_error) {
      if (stockMarketState === state) {
        $('#stock-market-status').textContent =
          '该股票没有可用的历史分时';
      }
      return false;
    } finally {
      state.minutePromise = null;
    }
  }

  async function setStockMarketView(view) {
    const state = stockMarketState;
    if (!state || !['daily', 'minute'].includes(view)) return;
    state.view = view;
    for (const name of ['daily', 'minute']) {
      const button = $(`#stock-${name}-tab`);
      const active = name === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    $('#stock-minute-nav').hidden = view !== 'minute';
    if (view === 'daily') {
      renderStockDaily();
    } else {
      if (!state.minute) {
        $('#stock-market-status').textContent =
          '正在读取历史分时';
      }
      if (!(state.minute || await ensureStockMinutes(state))) return;
      if (stockMarketState !== state || state.view !== 'minute') return;
      renderStockMinute();
      syncStockMinuteNavigation();
    }
    charts.get('stock-detail-chart')?.resize();
    requestAnimationFrame(() =>
      charts.get('stock-detail-chart')?.resize());
  }

  async function openStock(code) {
    const row = (DATA.stock_summary || []).find(
      item => item.code === code);
    if (!row) return;
    $('#stock-dialog-title').textContent = `${row.code} ${row.name}`;
    $('#stock-dialog-meta').textContent =
      `年度收益 ${pct(row.annual_return)} · 闭环 ${num(row.closed_trades)} 笔 · 胜率 ${pct(row.win_rate)}`;
    $('#stock-monthly').innerHTML =
      `<tbody>${emptyRow(6, '正在读取账户明细')}</tbody>`;
    $('#stock-executions').innerHTML =
      `<tbody>${emptyRow(5, '正在读取成交明细')}</tbody>`;
    stockMarketState = {
      code, name: row.name, daily: null, minute: null,
      minutePromise: null, minuteByDate: new Map(),
      view: 'daily', date: '',
    };
    $('#stock-market-status').textContent = '正在读取日K';
    $('#stock-minute-date').innerHTML = '';
    $('#stock-minute-nav').hidden = true;
    syncStockMinuteNavigation();
    $('#stock-minute-tab').disabled = false;
    $('#stock-dialog').showModal();
    charts.get('stock-detail-chart')?.clear();
    const state = stockMarketState;
    loadStockDetail(code).then(detail => {
      if (stockMarketState === state) {
        renderStockAccountDetail(detail);
      }
    }).catch(() => {
      if (stockMarketState === state) {
        $('#stock-monthly').innerHTML =
          `<tbody>${emptyRow(6, '账户明细暂不可用')}</tbody>`;
        $('#stock-executions').innerHTML =
          `<tbody>${emptyRow(5, '成交明细暂不可用')}</tbody>`;
      }
    });
    try {
      state.daily = await loadStockDaily(code);
    } catch (_error) {
      if (stockMarketState !== state) return;
      $('#stock-market-status').textContent =
        '日K数据不可用；可尝试查看历史分时';
      return;
    }
    if (stockMarketState === state) setStockMarketView('daily');
  }

  function renderPaper() {
    const summary = PAPER?.summary || DATA.paper?.summary || {};
    const live = DATA.trend_live || {};
    const validation = DATA.trend_validation || {};
    $('#paper-kpis').innerHTML = [
      kpi('独立账户', num(summary.account_count), cny(summary.initial_capital)),
      kpi('已实现盈亏', cny(summary.realized_pnl), '', tone(summary.realized_pnl)),
      kpi('浮动盈亏', cny(summary.unrealized_pnl), '', tone(summary.unrealized_pnl)),
      kpi('净盈亏', cny(summary.net_pnl), '', tone(summary.net_pnl)),
      kpi('持仓', `${num(summary.holding_count)} 只`, `待卖 ${num(summary.pending_exit_count)}`),
      kpi('模拟成交', `${num(summary.fill_count)} 笔`, '不连接券商'),
      kpi('目标池采集覆盖', pct(
        validation.target_coverage ?? live.coverage),
      `${num(
        validation.target_valid_count ?? live.valid_count
      )} / ${num(
        validation.target_universe_count ?? live.universe_count
      )} 只`),
      kpi('首次多空信号', `${num(validation.first_signal_count)} 条`,
        `首批 ${dt(validation.first_batch_quote_at)}`),
    ].join('');
    const health = validation.status
      ? validation : DATA.paper?.health || {};
    $('#paper-status').textContent = health.status || '—';
    $('#paper-snapshot').textContent = dt(
      validation.generated_at
      || PAPER?.last_snapshot_at
      || DATA.paper?.last_snapshot_at);
    $('#paper-next-day').textContent = health.next_trading_day || '—';
    $('#paper-contract').textContent = PAPER?.contract || DATA.paper?.contract || '—';
    const firstBatch = validation.first_batch || [];
    const firstStatus = $('#validation-first-status');
    firstStatus.textContent = firstBatch.length
      ? `${num(firstBatch.length)} 只` : '等待首批';
    firstStatus.className = `status ${firstBatch.length ? 'ok' : 'bad'}`;
    $('#validation-first-table').innerHTML = `<thead><tr>
      <th>源时间</th><th>代码</th><th>名称</th><th>行业/板块</th>
      <th>信号</th><th>源报价</th><th>前收盘</th>
      <th>涨跌幅</th><th>来源</th>
    </tr></thead><tbody>${firstBatch.length ? firstBatch.map(row => {
      const long = Number(row.direction) === 1;
      return `<tr><td>${esc(dt(row.quote_at))}</td>
        <td>${esc(row.code)}</td><td>${esc(row.name)}</td>
        <td>${esc(row.industry || '—')}</td>
        <td class="${long ? 'up' : 'down'}">${signalLabel(row.direction, row.strength)}</td>
        <td>${num(row.price, 2)}</td><td>${num(row.previous_close, 2)}</td>
        <td class="${tone(row.change)}">${pct(row.change)}</td>
        <td>${row.source === 'tencent' ? '腾讯' : esc(row.source)}</td></tr>`;
    }).join('') : emptyRow(9, '尚未形成今日首批信号')}</tbody>`;
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
    $('#paper-signals').innerHTML = `<thead><tr><th>时间</th><th>股票</th><th>信号</th><th>状态</th><th>原因</th></tr></thead>
      <tbody>${signals.length ? signals.map(row => `<tr><td>${dt(row.observed_at)}</td><td>${esc(row.code)}</td>
      <td class="${row.direction === 'LONG' ? 'up' : 'down'}">${signalLabel(row.direction, row.strength)}</td>
      <td>${esc(row.status)}</td><td>${esc(row.reason)}</td></tr>`).join('') : emptyRow(5)}</tbody>`;
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
    const announcements = research.winner_announcements || {};
    const announcementStable = announcements.status === 'stable_increment';
    const validation = DATA.paper_validation || {};
    $('#research-kpis').innerHTML = [
      kpi('提前空点配对改善', pct(early.paired_improvement), `${num(early.stocks)} 只股票`, tone(early.paired_improvement)),
      kpi('提前空点胜率', pct(early.early_trade_win_rate), `原空点 ${pct(early.base_trade_win_rate)}`),
      kpi('赢家画像大涨股', num(staged.return_winner_count), `V2 ${num(compare.return_winner_count)}`),
      kpi('最大浮盈赢家', num(staged.mfe_winner_count), `V2 ${num(compare.mfe_winner_count)}`),
      kpi('全量收益赢家', num(commonality.sample?.return_winners), `${num(commonality.sample?.events)} 条可成交样本`),
      kpi('板块补充召回', pct(capitalUnion.return_winner_recall), `原规则 ${pct(currentRule.return_winner_recall)}`),
      kpi('下一开盘代理收益', pct(entry.next_bar_open_price?.mean_daily_return), '全样本每日 Top5'),
      kpi('官方公告增量', announcementStable ? '稳定' : '不稳定',
        `${num(announcements.sample?.events_with_30d_announcement)} 条候选有近30日公告`,
        announcementStable ? 'up' : 'down'),
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
    const announcementSplits = ['validation', 'heldout', 'final_short_holdout'];
    const announcementRows = announcementSplits.map(key => {
      const delta = announcements.increment?.[key] || {};
      const rule = announcements.announcement_rules?.[key]?.announcement_count_30d || {};
      return `<tr><td>${esc(commonLabels[key] || key)}</td>
        <td class="${tone(delta.average_precision)}">${pct(delta.average_precision)}</td>
        <td class="${tone(delta.roc_auc)}">${num(delta.roc_auc, 4)}</td>
        <td class="${tone(delta.precision_at_5pct)}">${pct(delta.precision_at_5pct)}</td>
        <td>${num(rule.samples)}</td><td>${pct(rule.precision)}</td><td>${pct(rule.recall)}</td></tr>`;
    }).join('');
    $('#announcement-status').textContent = announcementStable ? '稳定增量' : '研究未通过';
    $('#announcement-status').className = `status ${announcementStable ? 'ok' : 'bad'}`;
    $('#announcement-table').innerHTML = `<thead><tr><th>样本</th><th>AP 增量</th><th>AUC 增量</th>
      <th>Top 5% 命中增量</th><th>近30日公告候选</th><th>公告规则命中</th>
      <th>公告规则召回</th></tr></thead><tbody>${announcementRows}</tbody>`;
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
      ['待定票信号分类', DATA.daily_candidates?.contract?.signal_strength],
      ['待定票未来收益参与', DATA.daily_candidates?.contract?.outcomes_used_for_selection ? '是' : '否'],
      ['候选账户基线', DATA.candidate_account_comparison?.contract?.baseline_entry],
      ['候选账户成交', DATA.candidate_account_comparison?.contract?.fill],
      ['跌信号退出', DATA.candidate_account_comparison?.contract?.weak_short_exit_included ? '已包含' : '未包含'],
      ['历史收益契约', DATA.history?.return_contract],
      ['实盘模拟契约', DATA.paper?.contract],
      ['分钟引擎', DATA.intraday_replay?.engine_version],
      ['触发价格口径', DATA.intraday_replay?.price_contract],
      ['个股图表', `前复权日K + ${num(DATA.chart_assets?.minute_day_count)} 个交易日5分钟分时`],
    ];
    $('#contract-list').innerHTML = items.map(([label, value]) =>
      `<div class="definition"><span>${esc(label)}</span><strong>${esc(value || '—')}</strong></div>`).join('');
    const labels = {
      backtest: '历史回测', weak_compare: '强弱信号比较',
      triggers: '分钟触发', paper: '模拟账本',
      paper_health: '模拟心跳', paper_validation: '分钟验收',
      trend_live: '实时扫描', trend_validation: '实盘验证证据',
      early_exit: '提前空点',
      winner_profile: '赢家画像', winner_commonality: '大涨股共性',
      winner_announcements: '官方公告增量',
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
    $('#stock-minute-prev').addEventListener(
      'click', () => moveStockMinuteDate(-1));
    $('#stock-minute-next').addEventListener(
      'click', () => moveStockMinuteDate(1));
    $('#stock-minute-date').addEventListener('change', event => {
      if (!stockMarketState) return;
      stockMarketState.date = event.target.value;
      renderStockMinute();
      syncStockMinuteNavigation();
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
