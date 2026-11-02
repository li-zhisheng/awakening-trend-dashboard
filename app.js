'use strict';

let DATA = null;
let MARKET_STATE = null;
let MARKET_CHART = null;
const CAPITAL_STORAGE_KEY = 'awakening.strongMomentum.initialCapital';

const $ = (selector) => document.querySelector(selector);
const pct = (value) => Number.isFinite(Number(value))
  ? `${(Number(value) * 100).toFixed(2)}%`
  : '--';
const money = (value) => Number.isFinite(Number(value))
  ? Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  : '--';
const tone = (value) => Number(value) > 0
  ? 'profit'
  : Number(value) < 0 ? 'loss' : '';
const shortHash = (value) => value ? `${value.slice(0, 12)}…${value.slice(-8)}` : '--';
const dateTime = (value) => {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false });
};
const dayText = (value) => {
  const digits = String(value || '').replaceAll('-', '');
  return /^\d{8}$/.test(digits)
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
    : String(value || '--');
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function kpi(label, value, note = '', className = '') {
  return `<article class="kpi"><span>${escapeHtml(label)}</span>` +
    `<strong class="${className}">${escapeHtml(value)}</strong>` +
    `<small>${escapeHtml(note)}</small></article>`;
}

function scaledAccount(initialCapital, account, referenceCapital) {
  const capital = Number(initialCapital);
  const reference = Number(referenceCapital);
  if (!Number.isFinite(capital) || capital <= 0
      || !Number.isFinite(reference) || reference <= 0) {
    return null;
  }
  const scale = capital / reference;
  const finalAssets = Number(account.estimated_liquidation_assets) * scale;
  return {
    initialCapital: capital,
    finalAssets,
    netProfit: finalAssets - capital,
    scale,
    annualReturns: Object.fromEntries(
      Object.entries(account.annual_returns).map(([year, row]) => [
        year,
        {
          ...row,
          start_nav: Number(row.start_nav) * scale,
          end_nav: Number(row.end_nav) * scale,
        },
      ]),
    ),
  };
}

function selectedCapital() {
  const input = $('#initial-capital');
  const capital = Number(input.value);
  if (!Number.isFinite(capital) || capital <= 0) {
    input.classList.add('invalid');
    return null;
  }
  input.classList.remove('invalid');
  return capital;
}

function renderAccount() {
  const strategy = DATA.strategy;
  const account = strategy.account_replay;
  const simulation = DATA.simulation;
  const scaled = scaledAccount(
    selectedCapital(),
    account,
    simulation.reference_initial_capital,
  );
  if (!scaled) return;
  $('#account-kpis').innerHTML = [
    kpi('初始本金', `¥${money(scaled.initialCapital)}`, simulation.start_day),
    kpi('最终资金', `¥${money(scaled.finalAssets)}`, dayText(account.latest_day), tone(scaled.netProfit)),
    kpi('累计净利润', `¥${money(scaled.netProfit)}`, '已扣冻结交易成本', tone(scaled.netProfit)),
    kpi('累计收益率', pct(account.total_return), '冻结持仓路径', tone(account.total_return)),
    kpi('最大回撤', pct(account.maximum_drawdown), '按日盯市', 'loss'),
  ].join('');

  $('#simulation-period').textContent =
    `${dayText(simulation.start_day)} - ${dayText(simulation.through_day)}`;
  $('#frozen-version').textContent = strategy.frozen_version;
  $('#execution-time').textContent = strategy.execution;
  $('#trade-count').textContent =
    `${account.entries}买 / ${account.exits}卖 / ${account.rotations}换仓`;
  $('#capital-contract').textContent = simulation.display_contract;

  $('#annual-table').innerHTML = `
    <thead><tr><th>年度</th><th>期初资产</th><th>期末资产</th><th>收益率</th></tr></thead>
    <tbody>${Object.entries(scaled.annualReturns).map(([year, row]) => `
      <tr><td>${year}</td><td>¥${money(row.start_nav)}</td>
      <td>¥${money(row.end_nav)}</td>
      <td class="${tone(row.return)}">${pct(row.return)}</td></tr>`).join('')}</tbody>`;

  const rules = [
    ['选股', strategy.selection_model],
    ['换仓', strategy.rotation_model],
    ['风险退出', '09:35弱势、趋势破坏或7%最大浮盈回撤'],
    ['仓位', `${strategy.position.slots} 个槽位，单股最多 ¥${money(strategy.position.maximum_position_notional)}`],
    ['换仓阈值', Number(strategy.rotation.threshold).toFixed(4)],
    ['亏损暂停', strategy.risk.loss_pause ? '启用' : '关闭'],
  ];
  $('#rule-list').innerHTML = rules.map(([key, value]) =>
    `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');

  const integrity = DATA.integrity;
  const verified = integrity.strict_causality_verified
    && integrity.next_minute_execution && integrity.t_plus_one;
  $('#integrity-state').textContent = verified ? '校验通过' : '校验异常';
  $('#integrity-state').className = `status ${verified ? 'ready' : 'error'}`;
  $('#integrity-grid').innerHTML = [
    ['协议', integrity.protocol_sha256],
    ['结果', integrity.result_sha256],
    ['候选轴', integrity.candidate_rows_sha256],
    ['看板数据', DATA.sha256],
  ].map(([key, value]) => `<div><span>${key}</span><code title="${value}">${shortHash(value)}</code></div>`).join('');
}

async function loadMarketAsset(path) {
  const response = await fetch(`${path}?v=${DATA.integrity.result_sha256}`, {
    cache: 'force-cache',
  });
  if (!response.ok) throw new Error(`行情数据 HTTP ${response.status}`);
  return response.json();
}

function marketChart() {
  if (!MARKET_CHART) {
    MARKET_CHART = echarts.init($('#stock-detail-chart'), null, {
      renderer: 'canvas',
    });
  }
  return MARKET_CHART;
}

function axisLabelDay(value) {
  const day = dayText(value);
  return day === '--' ? day : day.slice(5);
}

function axisBase() {
  return {
    axisLine: { lineStyle: { color: '#344149' } },
    axisLabel: { color: '#94a3a8' },
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

function stockDailyWindow(dates, selectedDate, visibleBars = 80) {
  const selectedIndex = dates.indexOf(String(selectedDate));
  const startIndex = selectedIndex >= 0
    ? Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(visibleBars / 2),
        Math.max(0, dates.length - visibleBars),
      ),
    )
    : Math.max(0, dates.length - visibleBars);
  const endIndex = Math.min(
    dates.length - 1, startIndex + visibleBars - 1);
  return {
    start: dates.length ? startIndex / dates.length * 100 : 0,
    end: dates.length ? (endIndex + 1) / dates.length * 100 : 100,
  };
}

function minuteVolumeDirections(prices, previousClose) {
  let reference = Number(previousClose);
  return prices.map(value => {
    const current = Number(value);
    const direction = current > reference
      ? 1 : current < reference ? -1 : 0;
    reference = current;
    return direction;
  });
}

function minuteVolumeColor(direction) {
  return direction > 0
    ? 'rgba(239,102,102,.72)'
    : direction < 0
      ? 'rgba(63,194,139,.72)'
      : 'rgba(148,163,168,.48)';
}

function minuteVolumeLabel(direction) {
  return direction > 0
    ? '上涨成交量' : direction < 0 ? '下跌成交量' : '平盘成交量';
}

function renderDailyMarket() {
  const { daily, row } = MARKET_STATE;
  const bars = daily.bars || [];
  const dates = bars.map(item => item[0]);
  const closes = bars.map(item => Number(item[4]));
  const ma5 = movingAverage(closes, 5);
  const ma10 = movingAverage(closes, 10);
  const ma20 = movingAverage(closes, 20);
  const { start, end } = stockDailyWindow(dates, row.day);
  const marks = (daily.selections || []).map(selection => {
    const index = dates.indexOf(String(selection.day));
    if (index < 0) return null;
    const selected = String(selection.day) === String(row.day);
    return {
      name: selected ? '买点' : '选股',
      coord: [index, Number(bars[index][3])],
      value: selected ? '买点' : '选股',
      symbol: selected ? 'diamond' : 'circle',
      symbolSize: selected ? 30 : 26,
      symbolOffset: [0, '72%'],
      itemStyle: {
        color: selected ? '#ef6666' : '#e5b94f',
        borderColor: '#101619',
        borderWidth: 3,
      },
      label: {
        show: true,
        color: '#fff',
        fontSize: 11,
        fontWeight: 700,
        formatter: selected ? '买点' : '选股',
      },
    };
  }).filter(Boolean);
  const chart = marketChart();
  chart.off('click');
  chart.setOption({
    animation: false,
    legend: {
      top: 2, right: 12,
      data: ['MA5', 'MA10', 'MA20'],
      textStyle: { color: '#94a3a8' },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: items => {
        const index = items[0]?.dataIndex;
        const item = bars[index];
        if (!item) return '暂无数据';
        const averages = [
          ['MA5', ma5[index]],
          ['MA10', ma10[index]],
          ['MA20', ma20[index]],
        ].filter(value => value[1] != null)
          .map(value => `${value[0]} ${Number(value[1]).toFixed(2)}`)
          .join('　');
        return `${dayText(item[0])}<br>开 ${Number(item[1]).toFixed(2)}　收 ${Number(item[4]).toFixed(2)}`
          + `<br>高 ${Number(item[2]).toFixed(2)}　低 ${Number(item[3]).toFixed(2)}`
          + (averages ? `<br>${averages}` : '')
          + `<br>成交额 ¥${money(item[5])}`;
      },
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      lineStyle: { color: '#55c5c7' },
    },
    grid: [
      { left: 58, right: 18, top: 42, height: '58%' },
      { left: 58, right: 18, top: '75%', height: '11%' },
    ],
    xAxis: [
      {
        ...axisBase(),
        type: 'category', data: dates,
        boundaryGap: true,
        axisLabel: { show: false },
      },
      {
        ...axisBase(),
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: true,
        axisLabel: {
          color: '#94a3a8',
          hideOverlap: true,
          formatter: axisLabelDay,
        },
      },
    ],
    yAxis: [
      {
        ...axisBase(),
        type: 'value', scale: true,
        axisLabel: { formatter: value => Number(value).toFixed(2) },
      },
      {
        ...axisBase(),
        type: 'value', scale: true,
        gridIndex: 1,
        axisLabel: {
          formatter: value => `${(value / 1e8).toFixed(1)}亿`,
        },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start, end },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        height: 18, bottom: 2, start, end,
        borderColor: '#344149',
        backgroundColor: '#101619',
        fillerColor: 'rgba(85,197,199,.12)',
        textStyle: { color: '#94a3a8' },
      },
    ],
    series: [
      {
        name: '日K',
        type: 'candlestick',
        data: bars.map(item => [item[1], item[4], item[3], item[2]]),
        itemStyle: {
          color: '#ef5b67',
          color0: '#39b980',
          borderColor: '#ef5b67',
          borderColor0: '#39b980',
        },
        markLine: {
          symbol: 'none',
          lineStyle: { color: '#e5b94f', type: 'dashed' },
          label: { color: '#e5b94f', formatter: '入选日' },
          data: [{ xAxis: String(row.day) }],
        },
        markPoint: { silent: true, data: marks },
      },
      {
        name: 'MA5', type: 'line', data: ma5,
        showSymbol: false,
        lineStyle: { width: 1.4, color: '#e5b94f' },
      },
      {
        name: 'MA10', type: 'line', data: ma10,
        showSymbol: false,
        lineStyle: { width: 1.4, color: '#55c5c7' },
      },
      {
        name: 'MA20', type: 'line', data: ma20,
        showSymbol: false,
        lineStyle: { width: 1.4, color: '#c084fc' },
      },
      {
        name: '成交额',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: bars.map(item => ({
          value: Number(item[5]),
          itemStyle: {
            color: Number(item[4]) >= Number(item[1])
              ? 'rgba(239,102,102,.55)'
              : 'rgba(63,194,139,.55)',
          },
        })),
      },
    ],
  }, true);
  chart.on('click', params => {
    const index = Number(params?.dataIndex);
    const day = dates[index];
    const selection = (daily.selections || []).find(
      item => String(item.day) === String(day));
    if (!selection) return;
    const selectedRow = DATA.candidate_rows.find(item =>
      item.code === row.code && String(item.day) === String(day));
    if (selectedRow) openCandidateMarket(selectedRow, 'minute');
  });
  $('#stock-market-status').textContent =
    `前复权日K ${dayText(bars[0][0])} 至 ${dayText(bars.at(-1)[0])}`
    + ` · ${bars.length} 个交易日 · MA5/MA10/MA20 · 点击入选K线查看分时`;
}

function renderMinuteMarket() {
  const { minute, row } = MARKET_STATE;
  const points = minute.points || [];
  const clocks = points.map(item => item[0]);
  const prices = points.map(item => Number(item[4]));
  const volumes = points.map(item => Number(item[5]));
  const amounts = points.map(item => Number(item[6]));
  const previousClose = Number(minute.previous_close);
  const directions = minuteVolumeDirections(prices, previousClose);
  let cumulativeVolume = 0;
  let cumulativeAmount = 0;
  const averages = points.map((_item, index) => {
    cumulativeVolume += Math.max(0, volumes[index]);
    cumulativeAmount += Math.max(0, amounts[index]);
    return cumulativeVolume > 0
      ? cumulativeAmount / cumulativeVolume : null;
  });
  const span = Math.max(
    previousClose * .003,
    ...prices.map(price => Math.abs(price - previousClose)),
  ) * 1.12;
  const confirmationClock = '0936';
  const entryClock = String(row.entry_clock).padStart(4, '0');
  const markPoints = [
    {
      name: '确认',
      clock: confirmationClock,
      price: prices[clocks.indexOf(confirmationClock)],
      color: '#e5b94f',
      symbol: 'circle',
    },
    {
      name: '买点',
      clock: entryClock,
      price: Number(row.entry_price),
      color: '#ef6666',
      symbol: 'diamond',
    },
  ].map(mark => {
    const index = clocks.indexOf(mark.clock);
    if (index < 0 || !Number.isFinite(mark.price)) return null;
    const change = (mark.price / previousClose - 1) * 100;
    return {
      name: mark.name,
      coord: [index, mark.price],
      value: mark.name,
      symbol: mark.symbol,
      symbolSize: mark.name === '买点' ? 22 : 18,
      symbolOffset: [0, '-55%'],
      itemStyle: {
        color: mark.color,
        borderColor: '#101619',
        borderWidth: 2,
      },
      label: {
        show: true,
        position: 'top',
        distance: 18,
        color: mark.color,
        backgroundColor: 'rgba(13,17,20,.92)',
        borderColor: mark.color,
        borderWidth: 1,
        borderRadius: 3,
        padding: [3, 5],
        fontWeight: 700,
        formatter: `${mark.name} ${mark.clock.slice(0, 2)}:${mark.clock.slice(2)}\n`
          + `¥${mark.price.toFixed(2)} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
      },
    };
  }).filter(Boolean);
  const chart = marketChart();
  chart.off('click');
  chart.setOption({
    animation: false,
    legend: {
      top: 2, right: 12,
      data: ['价格', '当日均价', '方向成交量'],
      textStyle: { color: '#94a3a8' },
    },
    tooltip: {
      trigger: 'axis', confine: true,
      formatter: items => {
        const index = items[0]?.dataIndex;
        if (index == null) return '';
        const change = (prices[index] / previousClose - 1) * 100;
        return `${dayText(minute.day)} ${clocks[index].slice(0, 2)}:${clocks[index].slice(2)}`
          + `<br>价格 ${prices[index].toFixed(2)}`
          + `<br>涨跌幅 ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
          + `<br>当日均价 ${averages[index]?.toFixed(2) || '--'}`
          + `<br>${minuteVolumeLabel(directions[index])} ${volumes[index].toLocaleString('zh-CN')} 股`;
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 58, right: 18, top: 82, height: '44%' },
      { left: 58, right: 18, top: '69%', height: '20%' },
    ],
    xAxis: [
      {
        ...axisBase(),
        type: 'category',
        data: clocks,
        boundaryGap: false,
        axisLabel: {
          color: '#94a3a8',
          interval: (_index, value) => (
            ['0931', '1030', '1130', '1301', '1400', '1500']
              .includes(value)
          ),
          formatter: value => `${value.slice(0, 2)}:${value.slice(2)}`,
        },
      },
      {
        ...axisBase(),
        type: 'category',
        gridIndex: 1,
        data: clocks,
        boundaryGap: true,
        axisLabel: { show: false },
      },
    ],
    yAxis: [
      {
        ...axisBase(),
        type: 'value',
        min: Math.max(.01, previousClose - span),
        max: previousClose + span,
        axisLabel: {
          formatter: value => {
            const change = (Number(value) / previousClose - 1) * 100;
            return `${change > 0 ? '+' : ''}${change.toFixed(2)}%`;
          },
        },
      },
      {
        ...axisBase(),
        type: 'value',
        gridIndex: 1,
        axisLabel: { show: false },
      },
    ],
    series: [
      {
        name: '价格',
        type: 'line',
        data: prices,
        showSymbol: false,
        lineStyle: { width: 2, color: '#78a8e8' },
        itemStyle: { color: '#78a8e8' },
        areaStyle: { color: 'rgba(120,168,232,.08)' },
        markPoint: { data: markPoints },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { type: 'dashed', color: '#e5b94f' },
          label: {
            show: true,
            position: 'start',
            color: '#e5b94f',
            formatter: '0.00%',
          },
          data: [{ yAxis: previousClose }],
        },
      },
      {
        name: '当日均价',
        type: 'line',
        data: averages,
        showSymbol: false,
        lineStyle: { width: 1.3, color: '#e5b94f' },
        itemStyle: { color: '#e5b94f' },
      },
      {
        name: '方向成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barCategoryGap: '5%',
        barMinHeight: 1,
        data: volumes.map((value, index) => ({
          value,
          itemStyle: { color: minuteVolumeColor(directions[index]) },
        })),
      },
    ],
  }, true);
  $('#stock-market-status').textContent =
    `${dayText(minute.day)} 前复权1分钟 · 昨收 ${previousClose.toFixed(2)}`
    + ` · ${points.length} 根 · 黄=确认 · 红=买点`;
}

function setMarketView(view) {
  if (!MARKET_STATE) return;
  MARKET_STATE.view = view;
  const daily = view === 'daily';
  $('#stock-daily-tab').classList.toggle('active', daily);
  $('#stock-minute-tab').classList.toggle('active', !daily);
  $('#stock-daily-tab').setAttribute('aria-selected', String(daily));
  $('#stock-minute-tab').setAttribute('aria-selected', String(!daily));
  if (daily) {
    if (MARKET_STATE.daily) renderDailyMarket();
  } else if (MARKET_STATE.minute) {
    renderMinuteMarket();
  }
  requestAnimationFrame(() => marketChart().resize());
}

async function openCandidateMarket(row, initialView = 'daily') {
  const day = String(row.day);
  MARKET_STATE = {
    row,
    daily: null,
    minute: null,
    view: initialView,
  };
  $('#stock-dialog-title').textContent = `${row.code} ${row.name}`;
  $('#stock-dialog-meta').textContent =
    `强势追涨 Top${row.candidate_rank} · ${row.candidate_status_reason}`;
  $('#detail-signal-day').textContent = dayText(day);
  $('#detail-entry').textContent =
    `${String(row.entry_clock).padStart(4, '0')} · ¥${Number(row.entry_price).toFixed(2)}`;
  $('#detail-exit').textContent =
    `${dayText(row.exit_day)} · ${String(row.exit_clock).padStart(4, '0')}`;
  $('#detail-return').textContent = pct(row.net_return);
  $('#detail-return').className = tone(row.net_return);
  $('#stock-market-status').textContent = '正在读取日K与分时';
  $('#stock-dialog').showModal();
  marketChart().clear();
  setMarketView(initialView);
  const state = MARKET_STATE;
  try {
    const [daily, minute] = await Promise.all([
      loadMarketAsset(
        `candidate-market/daily/${row.code.slice(0, 2)}/${row.code}.json`,
      ),
      loadMarketAsset(
        `candidate-market/minutes/${day}/${row.code.slice(0, 2)}/${row.code}.json`,
      ),
    ]);
    if (MARKET_STATE !== state) return;
    state.daily = daily;
    state.minute = minute;
    setMarketView(state.view);
  } catch (error) {
    if (MARKET_STATE === state) {
      $('#stock-market-status').textContent = `行情读取失败：${error.message}`;
    }
  }
}

function candidateRows() {
  const year = $('#candidate-year').value;
  const status = $('#candidate-status').value;
  const result = $('#candidate-result').value;
  const search = $('#candidate-search').value.trim().toLowerCase();
  return DATA.candidate_rows.filter((row) => {
    if (year !== 'all' && String(row.year) !== year) return false;
    if (status !== 'all' && row.candidate_status !== status) return false;
    if (result === 'profit' && Number(row.net_return) <= 0) return false;
    if (result === 'loss' && Number(row.net_return) >= 0) return false;
    return !search || `${row.code} ${row.name}`.toLowerCase().includes(search);
  });
}

function renderCandidates() {
  const counts = DATA.candidate_scope.counts;
  $('#candidate-kpis').innerHTML = [
    kpi('候选总数', String(counts.total), '完整每日 Top2 轴'),
    kpi('主账户交易', String(counts.primary_trade), '实际进入冻结账户'),
    kpi('观察候选', String(counts.observation_candidate), '持仓或暂停期间'),
    kpi('成交受限', String(counts.entry_unfillable), '容量或价格约束'),
  ].join('');
  const rows = candidateRows();
  $('#candidate-count').textContent = `${rows.length} / ${counts.total}`;
  const statusLabels = {
    primary_trade: '主账户交易',
    observation_candidate: '观察候选',
    entry_unfillable: '成交受限',
  };
  $('#candidate-table').innerHTML = `
    <thead><tr><th>日期</th><th>股票</th><th>排名</th><th>状态</th>
    <th>09:36确认</th><th>09:37入场</th><th>退出</th><th>持有</th><th>净收益</th></tr></thead>
    <tbody>${rows.map((row) => `
      <tr><td>${dayText(row.day)}</td><td>
      <button class="candidate-stock" type="button"
        data-code="${row.code}" data-day="${row.day}">
        <strong>${escapeHtml(row.name)}</strong><small>${row.code}</small>
      </button></td>
      <td>${row.candidate_rank}/${row.basket_size}</td>
      <td><span class="badge ${row.candidate_status}">${statusLabels[row.candidate_status] || row.candidate_status}</span></td>
      <td class="${tone(row.confirmation_return)}">${pct(row.confirmation_return)}</td>
      <td>¥${Number(row.entry_price).toFixed(2)}</td>
      <td>${row.exit_day} ${String(row.exit_clock).padStart(4, '0')}</td>
      <td>${row.hold_days}日</td><td class="${tone(row.net_return)}">${pct(row.net_return)}</td></tr>`).join('')}</tbody>`;
  $('#candidate-table').querySelectorAll('.candidate-stock').forEach(
    button => button.addEventListener('click', () => {
      const row = DATA.candidate_rows.find(item =>
        item.code === button.dataset.code
        && String(item.day) === button.dataset.day);
      if (row) openCandidateMarket(row);
    }),
  );
  const sync = DATA.selection_sync || {};
  $('#sync-state').textContent = sync.status === 'ready'
    ? `同步正常 · ${dateTime(sync.updated_at)}`
    : `同步状态：${sync.status || '不可用'}`;
  $('#sync-state').className = `status ${sync.status === 'ready' ? 'ready' : ''}`;
}

function bind() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-view]').forEach((item) =>
        item.classList.toggle('active', item === button));
      document.querySelectorAll('.view').forEach((view) =>
        view.classList.toggle('active', view.id === `view-${button.dataset.view}`));
    });
  });
  ['#candidate-year', '#candidate-status', '#candidate-result'].forEach((selector) =>
    $(selector).addEventListener('change', renderCandidates));
  $('#candidate-search').addEventListener('input', renderCandidates);
  $('#initial-capital').addEventListener('input', renderAccount);
  $('#initial-capital').addEventListener('change', () => {
    const capital = selectedCapital();
    if (capital) localStorage.setItem(CAPITAL_STORAGE_KEY, String(capital));
  });
  $('#capital-reset').addEventListener('click', () => {
    const capital = DATA.simulation.reference_initial_capital;
    $('#initial-capital').value = String(capital);
    localStorage.removeItem(CAPITAL_STORAGE_KEY);
    renderAccount();
  });
  $('#stock-daily-tab').addEventListener(
    'click', () => setMarketView('daily'));
  $('#stock-minute-tab').addEventListener(
    'click', () => setMarketView('minute'));
  $('#stock-dialog-close').addEventListener(
    'click', () => $('#stock-dialog').close());
  $('#stock-dialog').addEventListener('close', () => {
    MARKET_STATE = null;
    MARKET_CHART?.clear();
  });
  $('#refresh').addEventListener('click', () => location.reload());
  window.addEventListener('resize', () => MARKET_CHART?.resize());
}

async function start() {
  try {
    const response = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    DATA = await response.json();
    if (DATA.schema !== 'awakening-strong-momentum-chase-dashboard-v2') {
      throw new Error('数据版本不匹配');
    }
    $('#strategy-state').textContent = '唯一主策略 · 已冻结';
    $('#strategy-state').className = 'status ready';
    $('#generated-at').textContent = dateTime(DATA.generated_at);
    const savedCapital = Number(localStorage.getItem(CAPITAL_STORAGE_KEY));
    $('#initial-capital').value = String(
      Number.isFinite(savedCapital) && savedCapital > 0
        ? savedCapital : DATA.simulation.reference_initial_capital,
    );
    renderAccount();
    renderCandidates();
    bind();
  } catch (error) {
    $('#strategy-state').textContent = `读取失败：${error.message}`;
    $('#strategy-state').className = 'status error';
  }
}

start();
