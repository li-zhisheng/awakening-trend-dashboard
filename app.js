'use strict';

let DATA = null;
let MARKET_STATE = null;
let MARKET_CHART = null;
const CAPITAL_STORAGE_KEY = 'awakening.strongMomentum.initialCapital';

const $ = (selector) => document.querySelector(selector);
const finiteNumber = (value) =>
  value !== null && value !== '' && Number.isFinite(Number(value));
const pct = (value) => finiteNumber(value)
  ? `${(Number(value) * 100).toFixed(2)}%`
  : '--';
const signedPct = (value) => finiteNumber(value)
  ? `${Number(value) > 0 ? '+' : ''}${(Number(value) * 100).toFixed(2)}%`
  : '--';
const buyGainLabel = value => `买 ${signedPct(value)}`;
const sellGainLabel = (value, simulated = false) =>
  `${simulated ? '模拟卖' : '卖'} ${signedPct(value)}`;
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
  const response = await fetch(
    `${path}?v=${encodeURIComponent(DATA.generated_at)}`,
    {
    cache: 'force-cache',
    },
  );
  if (!response.ok) throw new Error(`行情数据 HTTP ${response.status}`);
  return response.json();
}

async function loadCompressedAsset(path) {
  const response = await fetch(path, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`分钟归档 HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error('浏览器不支持gzip分钟归档');
  }
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

const compactDay = value => String(value || '').replaceAll('-', '');
const selectionEntryReturn = (selection, code) => {
  if (Number.isFinite(Number(selection?.entry_return))) {
    return Number(selection.entry_return);
  }
  return DATA.candidate_rows.find(item =>
    item.code === code
    && compactDay(item.day) === compactDay(selection?.day)
  )?.entry_return;
};
const selectionExitDayReturn = (selection, code) => {
  if (Number.isFinite(Number(selection?.exit_day_return))) {
    return Number(selection.exit_day_return);
  }
  return DATA.candidate_rows.find(item =>
    item.code === code
    && compactDay(item.day) === compactDay(selection?.day)
  )?.exit_day_return;
};
const signalLabel = (direction, strength) => {
  const long = Number(direction) === 1;
  return strength === 'weak'
    ? (long ? '涨' : '跌')
    : (long ? '多' : '空');
};
const entryTagClass = (tag) => {
  if (tag === '板块背离') return 'divergence';
  if (tag === '动态支撑未成交') return 'no-pullback';
  if (tag === '前日涨停' || tag === '前日触板') return 'limit-up';
  return '';
};
const entryTagsHtml = (row) => `
  <span class="entry-tags">${(row.entry_tags || []).map(tag =>
    `<span class="entry-tag ${entryTagClass(tag)}">${escapeHtml(tag)}</span>`
  ).join('')}</span>`;
const EXIT_REASON_LABELS = {
  weakness: '09:35弱势',
  trailing: '最大浮盈回撤',
  trend_break: '趋势破坏',
  maximum_hold: '持仓到期',
  unresolved_exit_total_loss: '退出失败·全损记账',
};
const EXIT_REASON_DETAILS = {
  weakness: '09:35当日跌幅≤-1.5%',
  trailing: '从持仓最高价回撤≥7%',
  trend_break: '09:35跌破动态MA5，且个股、市场同时为负',
  maximum_hold: '持仓达到8个交易日',
  unresolved_exit_total_loss: '无法完成退出，按全损记账',
};
const exitReasonText = (reason, detailed = false) => {
  const value = String(reason || '');
  if (!value) return '--';
  if (value === 'unresolved_exit_total_loss') {
    return (detailed ? EXIT_REASON_DETAILS : EXIT_REASON_LABELS)[value];
  }
  const labels = detailed ? EXIT_REASON_DETAILS : EXIT_REASON_LABELS;
  return value.split('+').map(item => labels[item] || item).join(' + ');
};

function roundPriceLimit(value) {
  return Math.floor((Number(value) + 1e-8) * 100 + .5) / 100;
}

function stockPriceLimitInfo(previousClose, name = '', prices = {}) {
  const reference = Number(previousClose);
  if (!Number.isFinite(reference) || reference <= 0) return null;
  const high = Number(prices.high);
  const low = Number(prices.low);
  const close = Number(prices.close);
  let rate = /(?:\*ST|ST)/i.test(String(name)) ? .05 : .10;
  const fivePercentUpper = roundPriceLimit(reference * 1.05);
  if (
    rate === .05
    && Number.isFinite(high)
    && high > fivePercentUpper + .0051
  ) {
    rate = .10;
  }
  const upper = roundPriceLimit(reference * (1 + rate));
  const lower = roundPriceLimit(reference * (1 - rate));
  const tolerance = .0051;
  if (
    (Number.isFinite(high) && high > upper + tolerance)
    || (Number.isFinite(low) && low < lower - tolerance)
  ) {
    return {
      rate: null,
      upper: null,
      lower: null,
      unlimited: true,
      hitUp: false,
      hitDown: false,
      closeUp: false,
      closeDown: false,
    };
  }
  return {
    rate,
    upper,
    lower,
    unlimited: false,
    hitUp: Number.isFinite(high) && high >= upper - tolerance,
    hitDown: Number.isFinite(low) && low <= lower + tolerance,
    closeUp: Number.isFinite(close) && close >= upper - tolerance,
    closeDown: Number.isFinite(close) && close <= lower + tolerance,
  };
}

function stockLimitLabel(info) {
  if (!info) return '';
  if (info.unlimited) return '无固定涨跌停价';
  if (info.closeUp) return '封涨停';
  if (info.closeDown) return '封跌停';
  if (info.hitUp && info.hitDown) return '盘中触及涨停和跌停';
  if (info.hitUp) return '盘中触及涨停';
  if (info.hitDown) return '盘中触及跌停';
  return '未触及涨跌停';
}

function renderStockLimitBand(info, day) {
  const node = $('#stock-limit-band');
  if (!info) {
    node.hidden = true;
    node.innerHTML = '';
    return;
  }
  if (info.unlimited) {
    node.hidden = false;
    node.innerHTML = `
      <span class="limit-date">${dayText(day)}</span>
      <span class="limit-touch">${stockLimitLabel(info)}</span>`;
    return;
  }
  const rate = `${(info.rate * 100).toFixed(0)}%`;
  const stateClass = (
    info.closeUp || info.hitUp ? 'up'
      : info.closeDown || info.hitDown ? 'down' : ''
  );
  node.hidden = false;
  node.innerHTML = `
    <span class="limit-date">${dayText(day)}</span>
    <span class="limit-chip up"><b>涨停</b>${info.upper.toFixed(2)}
      <small>+${rate}</small></span>
    <span class="limit-chip down"><b>跌停</b>${info.lower.toFixed(2)}
      <small>-${rate}</small></span>
    <span class="limit-touch ${stateClass}">${stockLimitLabel(info)}</span>`;
}

function dailyLimitInfo(daily, index) {
  const bar = daily?.bars?.[index];
  if (!bar || index <= 0) return null;
  return stockPriceLimitInfo(
    Number(daily.bars[index - 1][4]),
    daily.name,
    { high: bar[2], low: bar[3], close: bar[4] },
  );
}

function dailyLimitOverlay(limitInfos, closes) {
  const events = [];
  limitInfos.forEach((info, index) => {
    if (info?.hitUp) events.push([index, closes[index], 1]);
    if (info?.hitDown) events.push([index, closes[index], -1]);
  });
  return {
    name: '涨跌停高亮',
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    xAxisIndex: 0,
    yAxisIndex: 0,
    data: events,
    encode: { x: 0, y: 1 },
    tooltip: { show: false },
    silent: true,
    clip: true,
    z: 90,
    renderItem: (params, api) => {
      const center = api.coord([api.value(0), api.value(1)]);
      const direction = Number(api.value(2));
      const width = Math.max(5, Math.abs(api.size([1, 0])[0]) * .82);
      const height = 5;
      return {
        type: 'rect',
        shape: {
          x: center[0] - width / 2,
          y: direction > 0
            ? params.coordSys.y + 2
            : params.coordSys.y + params.coordSys.height - height - 2,
          width,
          height,
        },
        style: {
          fill: direction > 0 ? '#ef6666' : '#3fc28b',
        },
      };
    },
  };
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

function dailyJumpOverlay(closes) {
  return {
    name: '分时跳转热区',
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    xAxisIndex: 0,
    yAxisIndex: 0,
    data: closes.map((value, index) => [index, value]),
    encode: { x: 0, y: 1 },
    tooltip: { show: false },
    z: 100,
    silent: false,
    clip: true,
    renderItem: (params, api) => {
      const center = api.coord([api.value(0), api.value(1)]);
      const band = Math.max(5, Math.abs(api.size([1, 0])[0]) * .92);
      return {
        type: 'rect',
        shape: {
          x: center[0] - band / 2,
          y: params.coordSys.y,
          width: band,
          height: params.coordSys.height,
        },
        style: { fill: 'rgba(85,197,199,.001)' },
        emphasis: {
          style: {
            fill: 'rgba(85,197,199,.16)',
            stroke: '#55c5c7',
            lineWidth: 1,
          },
        },
        cursor: 'pointer',
      };
    },
  };
}

function dailyMarketMarks(daily) {
  const bars = daily.bars || [];
  const dates = bars.map(item => compactDay(item[0]));
  const makeMark = (
    day, direction, strength, kind, price, probability = null,
    clockValue = '', displayLabel = '',
  ) => {
    const index = dates.indexOf(compactDay(day));
    if (index < 0) return null;
    const long = Number(direction) === 1;
    const actualSell = kind === 'strategy_sell';
    const simulatedSell = kind === 'simulated_sell';
    const buy = kind === 'strategy_buy';
    const formula = kind === 'formula_signal';
    const label = displayLabel || (buy
      ? '买点'
      : actualSell ? '卖出'
      : simulatedSell ? '模拟卖出'
      : signalLabel(direction, strength));
    const color = actualSell
      ? '#3fc28b'
      : simulatedSell ? '#7cae9b'
      : buy ? '#ef6666'
      : long ? '#ef6666' : '#3fc28b';
    const execution = !formula;
    const markerPrice = Number.isFinite(Number(price))
      ? Number(price)
      : long ? Number(bars[index][3]) : Number(bars[index][2]);
    const clock = String(clockValue || '').padStart(4, '0');
    const probabilityText = probability !== null
      && probability !== ''
      && Number.isFinite(Number(probability))
      ? `<br>概率 ${(Number(probability) * 100).toFixed(1)}%` : '';
    return {
      name: label,
      kind,
      direction: Number(direction),
      strength,
      probability,
      coord: [index, markerPrice],
      value: label,
      symbol: execution
        ? (simulatedSell ? 'triangle' : 'diamond')
        : 'circle',
      symbolSize: execution ? 18 : strength === 'weak' ? 7 : 10,
      symbolOffset: [
        0,
        execution
          ? (long ? '-55%' : '55%')
          : 0,
      ],
      itemStyle: {
        color,
        borderColor: '#101619',
        borderWidth: execution ? 2 : 1,
      },
      label: {
        show: execution,
        color: '#fff',
        position: long ? 'top' : 'bottom',
        distance: 10,
        padding: [2, 4],
        backgroundColor: 'rgba(13,17,20,.92)',
        borderColor: color,
        borderWidth: 1,
        borderRadius: 3,
        fontSize: 9,
        fontWeight: 700,
        formatter: label,
      },
      tooltip: {
        formatter: `${label}${clockValue ? ` ${clock.slice(0, 2)}:${clock.slice(2)}` : ''}`
          + `<br>${dayText(day)} · ¥${markerPrice.toFixed(2)}`
          + probabilityText,
      },
    };
  };
  const marks = (daily.signal_marks || []).map(item =>
    makeMark(
      item[0], item[2], item[3],
      'formula_signal', item[5], item[4], item[1],
    )).filter(Boolean);
  const exitKeys = new Set();
  for (const selection of daily.selections || []) {
    const buy = makeMark(
      selection.day,
      1,
      'strong',
      'strategy_buy',
      selection.entry_price,
      null,
      selection.entry_clock,
      buyGainLabel(selectionEntryReturn(selection, daily.code)),
    );
    if (buy) marks.push(buy);
    const key = `${compactDay(selection.exit_day)}/${selection.exit_clock}`;
    if (exitKeys.has(key)) continue;
    const sell = makeMark(
      selection.exit_day,
      -1,
      'strong',
      selection.candidate_status === 'primary_trade'
        ? 'strategy_sell' : 'simulated_sell',
      selection.exit_price,
      null,
      selection.exit_clock,
      sellGainLabel(
        selectionExitDayReturn(selection, daily.code),
        selection.candidate_status !== 'primary_trade',
      ),
    );
    if (sell) marks.push(sell);
    exitKeys.add(key);
  }
  return marks;
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
  const marks = dailyMarketMarks(daily);
  const limitInfos = bars.map((_item, index) =>
    dailyLimitInfo(daily, index));
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
        const limit = limitInfos[index];
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
          + `<br>成交额 ¥${money(item[5])}`
          + (
            limit && !limit.unlimited
              ? `<br><span style="color:#ef6666">涨停 ${limit.upper.toFixed(2)}</span>　`
                + `<span style="color:#3fc28b">跌停 ${limit.lower.toFixed(2)}</span>`
                + `<br>${stockLimitLabel(limit)}`
              : ''
          );
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
      dailyLimitOverlay(limitInfos, closes),
      dailyJumpOverlay(closes),
    ],
  }, true);
  chart.on('click', params => {
    const index = Number(params?.dataIndex);
    const day = dates[index];
    if (day) openMarketDate(day);
  });
  const formulaMarks = marks.filter(mark =>
    mark.kind === 'formula_signal');
  const sellMarks = marks.filter(mark =>
    ['strategy_sell', 'simulated_sell'].includes(mark.kind));
  $('#stock-market-status').textContent =
    `前复权日K ${dayText(bars[0][0])} 至 ${dayText(bars.at(-1)[0])}`
    + ` · 多空 ${formulaMarks.length} · 卖点 ${sellMarks.length}`
    + ' · 点击任意K线查看对应分时';
  const selectedIndex = dates.indexOf(String(row.day));
  renderStockLimitBand(
    limitInfos[selectedIndex >= 0 ? selectedIndex : dates.length - 1],
    dates[selectedIndex >= 0 ? selectedIndex : dates.length - 1],
  );
}

function normalizedMinutePoints(minute) {
  const points = [...(minute.points || [])];
  if (!points.length) return points;
  const firstClock = String(points[0][0]).padStart(4, '0');
  if (firstClock > '0930') {
    const opening = Number(points[0][1]);
    points.unshift([
      '0930',
      opening,
      opening,
      opening,
      opening,
      0,
      0,
    ]);
  }
  return points;
}

function availableMinuteDates(state = MARKET_STATE) {
  if (!state?.daily) return [];
  const local = new Set();
  for (const selection of state.daily.selections || []) {
    local.add(compactDay(selection.day));
    local.add(compactDay(selection.exit_day));
  }
  return [
    ...new Set(
      (state.daily.bars || [])
        .map(item => compactDay(item[0]))
        .filter(day => day.startsWith('2026') || local.has(day)),
    ),
  ].sort();
}

function renderMinuteNavigation(state = MARKET_STATE) {
  const dates = availableMinuteDates(state);
  const current = compactDay(state?.minute?.day || state?.row?.day);
  $('#stock-minute-date').innerHTML = dates.map(day =>
    `<option value="${day}">${dayText(day)}</option>`).join('');
  $('#stock-minute-date').value = current;
  const index = dates.indexOf(current);
  $('#stock-minute-prev').disabled = index <= 0;
  $('#stock-minute-next').disabled =
    index < 0 || index >= dates.length - 1;
}

async function moveMinuteDate(offset) {
  const dates = availableMinuteDates();
  const current = compactDay(
    MARKET_STATE?.minute?.day || MARKET_STATE?.row?.day);
  const index = dates.indexOf(current);
  const target = dates[index + offset];
  if (target) await openMarketDate(target);
}

function minuteMarketMarks(minute) {
  const { row, daily } = MARKET_STATE;
  const day = compactDay(minute.day);
  const points = normalizedMinutePoints(minute);
  const clocks = points.map(item => String(item[0]).padStart(4, '0'));
  const previousClose = Number(minute.previous_close);
  const makeMark = (
    name, clockValue, direction, strength, price, kind,
  ) => {
    const clock = String(clockValue).padStart(4, '0');
    let index = clocks.indexOf(clock);
    if (index < 0) {
      index = clocks.findIndex(value => value > clock);
    }
    if (index < 0) return null;
    const long = Number(direction) === 1;
    const actualSell = kind === 'strategy_sell';
    const simulatedSell = kind === 'simulated_sell';
    const execution = [
      'strategy_buy', 'strategy_sell', 'simulated_sell',
    ].includes(kind);
    const labelled = execution || kind === 'confirmation';
    const markerPrice = Number.isFinite(Number(price))
      ? Number(price) : Number(points[index][4]);
    const label = name || (
      kind === 'strategy_buy' ? '买点'
      : actualSell ? '卖出'
      : simulatedSell ? '模拟卖出'
      : signalLabel(direction, strength)
    );
    const color = actualSell
      ? '#3fc28b'
      : simulatedSell ? '#7cae9b'
      : kind === 'confirmation' ? '#e5b94f'
      : long ? '#ef6666' : '#3fc28b';
    const change = (markerPrice / previousClose - 1) * 100;
    return {
      name: label,
      kind,
      coord: [index, markerPrice],
      value: label,
      symbol: execution
        ? (simulatedSell ? 'triangle' : 'diamond')
        : 'circle',
      symbolSize: execution
        ? 14 : kind === 'confirmation' ? 10
          : strength === 'weak' ? 6 : 8,
      symbolOffset: [
        0,
        execution
          ? (long ? '-35%' : '35%')
          : kind === 'confirmation' ? '35%' : 0,
      ],
      itemStyle: {
        color,
        borderColor: '#101619',
        borderWidth: 1,
      },
      label: {
        show: labelled,
        position: kind === 'confirmation'
          ? 'bottom' : long ? 'top' : 'bottom',
        distance: 10,
        color,
        backgroundColor: 'rgba(13,17,20,.92)',
        borderColor: color,
        borderWidth: 1,
        borderRadius: 3,
        padding: [2, 4],
        fontSize: 9,
        fontWeight: 700,
        formatter: [
          'strategy_buy',
          'strategy_sell',
          'simulated_sell',
        ].includes(kind)
          ? label
          : `${label} ${clock.slice(0, 2)}:${clock.slice(2)}`,
      },
      tooltip: {
        formatter: `${label} ${clock.slice(0, 2)}:${clock.slice(2)}`
          + `<br>¥${markerPrice.toFixed(2)}`
          + `<br>${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
      },
    };
  };
  const marks = (minute.signal_marks || []).map(item =>
    makeMark(
      '', item[1], item[2], item[3],
      item[5], 'formula_signal',
    )).filter(Boolean);
  for (const selection of daily.selections || []) {
    if (compactDay(selection.day) === day) {
      const confirmation = makeMark(
        '确认', '0936', 1, 'strong',
        null, 'confirmation',
      );
      const buy = makeMark(
        buyGainLabel(selectionEntryReturn(selection, row.code)),
        selection.entry_clock, 1, 'strong',
        selection.entry_price, 'strategy_buy',
      );
      if (confirmation) marks.push(confirmation);
      if (buy) marks.push(buy);
    }
    if (compactDay(selection.exit_day) === day) {
      const actual = selection.candidate_status === 'primary_trade';
      const sell = makeMark(
        sellGainLabel(
          selectionExitDayReturn(selection, row.code),
          !actual,
        ),
        selection.exit_clock,
        -1,
        'strong',
        selection.exit_price,
        actual ? 'strategy_sell' : 'simulated_sell',
      );
      if (sell) marks.push(sell);
    }
  }
  if (
    !marks.some(mark => mark.kind === 'strategy_buy')
    && compactDay(row.day) === day
  ) {
    const buy = makeMark(
      buyGainLabel(row.entry_return),
      row.entry_clock, 1, 'strong',
      row.entry_price, 'strategy_buy',
    );
    if (buy) marks.push(buy);
  }
  return marks;
}

async function loadMinuteForDay(day, state = MARKET_STATE) {
  const compact = compactDay(day);
  const code = state.row.code;
  try {
    return await loadMarketAsset(
      `candidate-market/minutes/${compact}/${code.slice(0, 2)}/${code}.json`,
    );
  } catch (localError) {
    if (!compact.startsWith('2026')) throw localError;
    const month = compact.slice(0, 6);
    const routed = DATA.minute_archive?.month_base_urls?.[month];
    const base = String(
      routed || DATA.minute_archive?.base_url || ''
    ).replace(/\/+$/, '');
    if (!base) throw localError;
    const payload = await loadCompressedAsset(
      `${base}/months/${month}/${code.slice(0, 2)}/${code}.json.gz`,
    );
    const values = payload.days || [payload];
    const source = values.find(item =>
      compactDay(item.date) === compact);
    if (!source) throw localError;
    const bars = state.daily.bars || [];
    const index = bars.findIndex(item => compactDay(item[0]) === compact);
    const previousClose = index > 0
      ? Number(bars[index - 1][4])
      : Number(source.previous_close);
    return {
      schema: 'awakening-strong-momentum-minute-v1',
      code,
      name: state.row.name,
      day: compact,
      previous_close: previousClose,
      points: source.points || [],
      signal_marks: (state.daily.signal_marks || []).filter(
        mark => compactDay(mark[0]) === compact),
    };
  }
}

async function openMarketDate(day) {
  const state = MARKET_STATE;
  if (!state) return;
  $('#stock-market-status').textContent =
    `正在读取 ${dayText(day)} 的真实1分钟`;
  try {
    const minute = await loadMinuteForDay(day, state);
    if (MARKET_STATE !== state) return;
    state.minute = minute;
    setMarketView('minute');
  } catch (_error) {
    if (MARKET_STATE === state) {
      $('#stock-market-status').textContent =
        `${dayText(day)} 暂无统一1分钟归档，日K保持可用`;
    }
  }
}

function renderMinuteMarket() {
  const { minute, row } = MARKET_STATE;
  const points = normalizedMinutePoints(minute);
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
  const markPoints = minuteMarketMarks(minute);
  const finitePrices = prices.filter(Number.isFinite);
  const limitInfo = stockPriceLimitInfo(
    previousClose,
    row.name,
    {
      high: finitePrices.length ? Math.max(...finitePrices) : null,
      low: finitePrices.length ? Math.min(...finitePrices) : null,
      close: finitePrices.at(-1),
    },
  );
  renderStockLimitBand(limitInfo, minute.day);
  const limitTolerance = .0051;
  const limitUpPrices = prices.map(price => (
    limitInfo && !limitInfo.unlimited
    && price >= limitInfo.upper - limitTolerance
      ? price : null
  ));
  const limitDownPrices = prices.map(price => (
    limitInfo && !limitInfo.unlimited
    && price <= limitInfo.lower + limitTolerance
      ? price : null
  ));
  const legend = ['价格', '当日均价'];
  if (limitInfo?.hitUp) legend.push('涨停区段');
  if (limitInfo?.hitDown) legend.push('跌停区段');
  legend.push('方向成交量');
  const chart = marketChart();
  chart.off('click');
  chart.setOption({
    animation: false,
    legend: {
      top: 2, right: 12,
      data: legend,
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
            ['0930', '1030', '1130', '1301', '1400', '1500']
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
          data: [
            { yAxis: previousClose },
            ...(
              limitInfo && !limitInfo.unlimited
                ? [{
                  yAxis: limitInfo.upper,
                  lineStyle: {
                    type: 'dashed',
                    color: '#ef6666',
                    width: 1.2,
                  },
                  label: {
                    show: true,
                    position: 'insideEndTop',
                    color: '#ef6666',
                    formatter: `涨停 +${(limitInfo.rate * 100).toFixed(0)}%`,
                  },
                }, {
                  yAxis: limitInfo.lower,
                  lineStyle: {
                    type: 'dashed',
                    color: '#3fc28b',
                    width: 1.2,
                  },
                  label: {
                    show: true,
                    position: 'insideEndBottom',
                    color: '#3fc28b',
                    formatter: `跌停 -${(limitInfo.rate * 100).toFixed(0)}%`,
                  },
                }]
                : []
            ),
          ],
        },
      },
      ...(
        limitInfo?.hitUp
          ? [{
            name: '涨停区段',
            type: 'line',
            data: limitUpPrices,
            showSymbol: true,
            symbol: 'circle',
            symbolSize: 5,
            connectNulls: false,
            lineStyle: { width: 5, color: '#ef6666' },
            itemStyle: { color: '#ef6666' },
            emphasis: { disabled: true },
            z: 12,
          }]
          : []
      ),
      ...(
        limitInfo?.hitDown
          ? [{
            name: '跌停区段',
            type: 'line',
            data: limitDownPrices,
            showSymbol: true,
            symbol: 'circle',
            symbolSize: 5,
            connectNulls: false,
            lineStyle: { width: 5, color: '#3fc28b' },
            itemStyle: { color: '#3fc28b' },
            emphasis: { disabled: true },
            z: 12,
          }]
          : []
      ),
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
    + ` · ${points.length} 点（含09:30开盘）`
    + (limitInfo && (limitInfo.hitUp || limitInfo.hitDown)
      ? ` · ${stockLimitLabel(limitInfo)}` : '')
    + ' · '
    + markPoints.map(mark => mark.name).join(' · ');
  renderMinuteNavigation();
}

function setMarketView(view) {
  if (!MARKET_STATE) return;
  MARKET_STATE.view = view;
  const daily = view === 'daily';
  $('#stock-daily-tab').classList.toggle('active', daily);
  $('#stock-minute-tab').classList.toggle('active', !daily);
  $('#stock-daily-tab').setAttribute('aria-selected', String(daily));
  $('#stock-minute-tab').setAttribute('aria-selected', String(!daily));
  $('#stock-minute-nav').hidden = daily;
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
    `强势追涨 Top${row.candidate_rank} · ${row.candidate_status_reason}`
    + ` · ${row.sector_name || '板块未映射'}`;
  $('#stock-entry-tags').innerHTML = entryTagsHtml(row);
  $('#detail-signal-day').textContent = dayText(day);
  $('#detail-entry').textContent =
    `${String(row.entry_clock).padStart(4, '0')} · ¥${Number(row.entry_price).toFixed(2)}`;
  $('#detail-exit').textContent =
    `${dayText(row.exit_day)} · ${String(row.exit_clock).padStart(4, '0')}`;
  $('#detail-exit-reason').textContent =
    exitReasonText(row.exit_reason, true);
  $('#detail-return').textContent = pct(row.net_return);
  $('#detail-return').className = tone(row.net_return);
  $('#detail-support').textContent = row.dynamic_support_touched
    ? `${String(row.dynamic_support_entry_clock).padStart(4, '0')} · ¥${Number(row.dynamic_support_price).toFixed(2)} · 低${pct(row.dynamic_support_discount)}`
    : [
        '动态支撑未成交',
        finiteNumber(row.maximum_pullback_discount)
          ? `最大回落 ${pct(row.maximum_pullback_discount)}`
          : '',
        row.maximum_pullback_clock
          ? String(row.maximum_pullback_clock).padStart(4, '0')
          : '',
      ].filter(Boolean).join(' · ');
  $('#detail-prior-day').textContent = [
    row.previous_day_closed_limit_up ? '涨停' : signedPct(row.previous_day_return),
    Number.isFinite(Number(row.previous_day_amount_ratio))
      ? `量比 ${Number(row.previous_day_amount_ratio).toFixed(2)}`
      : '',
  ].filter(Boolean).join(' · ');
  $('#stock-market-status').textContent = '正在读取日K与分时';
  $('#stock-minute-nav').hidden = true;
  $('#stock-minute-date').innerHTML = '';
  $('#stock-dialog').showModal();
  marketChart().clear();
  setMarketView(initialView);
  const state = MARKET_STATE;
  try {
    const [daily, minute] = await Promise.all([
      loadMarketAsset(
        `candidate-market/daily/${row.code.slice(0, 2)}/${row.code}.json`,
      ),
      loadMinuteForDay(day, state),
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
  const study = $('#candidate-study').value;
  const search = $('#candidate-search').value.trim().toLowerCase();
  return DATA.candidate_rows.filter((row) => {
    if (year !== 'all' && String(row.year) !== year) return false;
    if (status !== 'all' && row.candidate_status !== status) return false;
    if (result === 'profit' && Number(row.net_return) <= 0) return false;
    if (result === 'loss' && Number(row.net_return) >= 0) return false;
    if (study === 'sector_divergence' && !row.sector_divergence) return false;
    if (
      study === 'no_pullback'
      && !(row.dynamic_support_unfilled ?? row.no_pullback_opportunity)
    ) return false;
    if (
      study === 'divergence_no_pullback'
      && !(
        row.sector_divergence
        && (row.dynamic_support_unfilled ?? row.no_pullback_opportunity)
      )
    ) return false;
    if (
      study === 'previous_limit_up'
      && !row.previous_day_closed_limit_up
    ) return false;
    return !search || `${row.code} ${row.name}`.toLowerCase().includes(search);
  });
}

function renderStudySummary() {
  const selected = $('#candidate-study').value;
  const keys = {
    all: 'all',
    sector_divergence: 'sector_divergence',
    no_pullback: 'no_pullback',
    divergence_no_pullback: 'sector_divergence_no_pullback',
    previous_limit_up: 'previous_day_limit_up',
  };
  const node = DATA.entry_research?.groups?.[keys[selected]];
  if (!node) {
    $('#study-summary').innerHTML = '';
    return;
  }
  const sectors = (node.top_sectors || []).slice(0, 5)
    .map(item => `${item.name} ${item.count}`).join(' · ');
  $('#study-summary').innerHTML = [
    ['研究样本', String(node.count)],
    ['胜率', pct(node.win_rate)],
    ['中位净收益', signedPct(node.median_net_return)],
    ['平均市场涨幅', signedPct(node.mean_market_return_0935)],
    ['强势股占比', pct(node.mean_strong_ratio_0935)],
    ['板块背离率', pct(node.sector_divergence_rate)],
    ['前日涨停率', pct(node.previous_day_limit_up_rate)],
    [
      '前日成交活跃度',
      Number.isFinite(Number(node.mean_previous_day_amount_ratio))
        ? `${Number(node.mean_previous_day_amount_ratio).toFixed(2)}x`
        : '--',
    ],
    ['高频板块', sectors || '--', 'sector-list'],
  ].map(([label, value, className = '']) =>
    `<div class="${className}"><span>${escapeHtml(label)}</span>`
    + `<strong>${escapeHtml(value)}</strong></div>`).join('');
}

function renderCandidates() {
  const counts = DATA.candidate_scope.counts;
  const researchCounts = DATA.entry_research?.display_counts || {};
  $('#candidate-kpis').innerHTML = [
    kpi('候选总数', String(counts.total), '完整每日 Top2 轴'),
    kpi('主账户交易', String(counts.primary_trade), '实际进入冻结账户'),
    kpi('观察候选', String(counts.observation_candidate), '持仓或暂停期间'),
    kpi('板块背离', String(researchCounts.sector_divergence || 0), '09:36 个股/板块不同步'),
    kpi(
      '支撑未成交',
      String(researchCounts.no_pullback || 0),
      '虽有普通回落，10:00前未触动态支撑价',
    ),
    kpi('前日涨停', String(researchCounts.previous_day_limit_up || 0), '前一交易日收盘封板'),
  ].join('');
  const rows = candidateRows();
  renderStudySummary();
  $('#candidate-count').textContent = `${rows.length} / ${counts.total}`;
  const statusLabels = {
    primary_trade: '主账户交易',
    observation_candidate: '观察候选',
    entry_unfillable: '成交受限',
  };
  $('#candidate-table').innerHTML = `
    <thead><tr><th>日期</th><th>股票</th><th>排名</th><th>状态</th>
    <th>研究标签</th><th>市场 / 板块</th><th>09:36确认</th>
    <th>09:37入场</th><th>退出 / 原因</th><th>持有</th><th>净收益</th></tr></thead>
    <tbody>${rows.map((row) => `
      <tr><td>${dayText(row.day)}</td><td>
      <button class="candidate-stock" type="button"
        data-code="${row.code}" data-day="${row.day}">
        <strong>${escapeHtml(row.name)}</strong><small>${row.code}</small>
      </button></td>
      <td>${row.candidate_rank}/${row.basket_size}</td>
      <td><span class="badge ${row.candidate_status}">${statusLabels[row.candidate_status] || row.candidate_status}</span></td>
      <td>${entryTagsHtml(row)}</td>
      <td class="market-sector-cell">
        <strong>${escapeHtml(row.sector_name || '未映射板块')}</strong>
        <small>热度 ${pct(row.sector_heat_rank_0936)}
          · 板块 ${signedPct(row.sector_return_0936)}</small>
        <small>${escapeHtml(row.market_state_label || '')}
          · 市场 ${signedPct(row.market_mean)}</small>
      </td>
      <td class="${tone(row.confirmation_return)}">${pct(row.confirmation_return)}</td>
      <td class="candidate-entry ${tone(row.entry_return)}">
        <strong>${pct(row.entry_return)}</strong>
        <small>¥${Number(row.entry_price).toFixed(2)}</small>
      </td>
      <td class="candidate-exit">
        <strong>${dayText(row.exit_day)} ${String(row.exit_clock).padStart(4, '0')}</strong>
        <small title="${escapeHtml(exitReasonText(row.exit_reason, true))}">
          ${escapeHtml(exitReasonText(row.exit_reason))}
        </small>
      </td>
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
  ['#candidate-year', '#candidate-status', '#candidate-result', '#candidate-study'].forEach((selector) =>
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
    $('#stock-minute-nav').hidden = true;
    $('#stock-limit-band').hidden = true;
  });
  $('#stock-minute-prev').addEventListener(
    'click', () => moveMinuteDate(-1));
  $('#stock-minute-next').addEventListener(
    'click', () => moveMinuteDate(1));
  $('#stock-minute-date').addEventListener(
    'change', event => openMarketDate(event.target.value));
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
