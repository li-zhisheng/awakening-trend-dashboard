(() => {
  'use strict';

  let DATA = null;
  let PAPER = null;
  let stockMarketState = null;
  let stockPage = 1;
  let monthlyStrategy = 'original';
  let dailyReturnMonth = '';
  const pageSize = 80;
  const charts = new Map();
  const stockDetailCache = new Map();
  const stockDailyCache = new Map();
  const stockSignalMarkCache = new Map();
  const stockMinuteCache = new Map();
  const stockLiveCache = new Map();
  const staticHost = location.hostname.endsWith('.github.io');
  const signalColors = {
    strongLong: '#ef6666',
    weakLong: '#ef6666',
    strongShort: '#3fc28b',
    weakShort: '#3fc28b',
  };
  const $ = (selector) => document.querySelector(selector);
  const dataPaths = (api, file) => (
    staticHost ? [`${file}?t=${Date.now()}`] : [api, file]
  );
  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const pct = (value, digits = 2) => Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(digits)}%` : '—';
  const optionalPct = (value, digits = 2) =>
    value === null || value === undefined ? '—' : pct(value, digits);
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
  const ymd = (value) => String(value || '—').replace(
    /^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const clock = (value) => /^\d{3,4}$/.test(String(value || ''))
    ? `${String(value).padStart(4, '0').slice(0, 2)}:${
      String(value).padStart(4, '0').slice(2)}`
    : String(value || '—');
  const industryName = value =>
    String(value || '').replace(/^[A-Z]\d{2}/, '').trim() || '—';
  const tone = (value) => Number(value) > 0
    ? 'up' : Number(value) < 0 ? 'down' : 'neutral';
  const stockSymbol = code => {
    const value = String(code || '');
    if (!/^\d{6}$/.test(value)) return '';
    return `${value.startsWith('6') ? 'sh' : 'sz'}${value}`;
  };
  const stockLink = (code, label, extraClass = '') =>
    `<button class="stock-link ${extraClass}" data-code="${esc(code)}">${esc(label)}</button>`;
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
        const immutableArchive = (
          path.includes('/awakening-minute-archive')
          && path.endsWith('.json.gz')
        );
        const response = await fetch(path, {
          cache: immutableArchive ? 'force-cache' : 'no-store',
        });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        if (!path.endsWith('.gz')) return await response.json();
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
          return JSON.parse(new TextDecoder().decode(bytes));
        }
        if (typeof DecompressionStream !== 'function') {
          throw new Error('浏览器不支持gzip分钟归档');
        }
        const stream = new Blob([bytes]).stream()
          .pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).json();
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

  function resizeVisibleCharts() {
    charts.forEach((instance, id) => {
      const node = document.getElementById(id);
      if (!node || node.clientWidth <= 0 || node.clientHeight <= 0) return;
      instance.resize({
        width: node.clientWidth,
        height: node.clientHeight,
      });
    });
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

  function minuteVolumeDirections(
    prices, previousClose, auctionCount = 0,
  ) {
    let reference = Number(previousClose);
    return prices.map((value, index) => {
      if (index < auctionCount) return 0;
      const current = Number(value);
      const direction = current > reference
        ? 1 : current < reference ? -1 : 0;
      reference = current;
      return direction;
    });
  }

  function minuteVolumeLabel(direction) {
    return direction > 0
      ? '上涨成交量' : direction < 0 ? '下跌成交量' : '平盘成交量';
  }

  function minuteVolumeColor(direction) {
    return direction > 0
      ? 'rgba(239,102,102,.72)'
      : direction < 0
        ? 'rgba(63,194,139,.72)'
        : 'rgba(148,163,168,.48)';
  }

  function renderHeader() {
    $('#generated-at').textContent = `数据生成 ${dt(DATA.generated_at)}`;
    const health = DATA.paper?.health || DATA.trend_validation || {};
    const status = health.status || 'unknown';
    $('#live-state').textContent = status === 'ready'
      ? '盘中就绪' : status === 'waiting_market' ? '等待开市' : status;
  }

  function renderMonthlyOverview() {
    const original = monthlyStrategy === 'original';
    const originalMonthly = DATA.history.monthly || [];
    const v6Monthly = DATA.v6_monthly?.monthly || [];
    const months = original ? originalMonthly : v6Monthly;
    const strategy = DATA.v6_monthly?.strategy || {};
    const v6Summary = DATA.v6_monthly?.summary || {};
    $('#monthly-chart-note').textContent = original
      ? '盘后确认信号的1分钟回放 · 存在未来信息偏差，收益仅供历史研究'
      : `现役V6全程1分钟 · 固定当前模型反推 · ${num(strategy.slots)}槽`;
    $('#monthly-nav-note').textContent = original
      ? '原始多空一分钟逐月复合路径'
      : 'V6四槽连续净值 · 期末净值包含未平仓浮盈';
    $('#monthly-table-note').textContent = original
      ? '盘后确认信号回放 · 规则卖出和月末持仓 · 非实盘收益'
      : `固定模型反推，非历史实盘 · 已平仓 ${cny(v6Summary.realized_pnl)}`
        + ` · 标记收益 ${pct(v6Summary.annual_return)}`;
    chart('monthly-chart', {
      animation: false,
      tooltip: { trigger: 'axis', valueFormatter: (v) => pct(v) },
      legend: {
        data: original ? ['原始多空（1分钟）'] : ['V6策略'],
        textStyle: { color: '#aab8bd' },
      },
      grid: { left: 52, right: 18, top: 44, bottom: 36 },
      xAxis: {
        ...axisBase(), type: 'category',
        data: months.map(x => x.month.slice(5)),
      },
      yAxis: {
        ...axisBase(), type: 'value',
        axisLabel: { formatter: v => `${(v * 100).toFixed(0)}%` },
      },
      series: original ? [{
        name: '原始多空（1分钟）', type: 'bar',
        data: originalMonthly.map(x => x.return),
        itemStyle: { color: '#55c5c7' },
      }] : [{
        name: 'V6策略', type: 'bar',
        data: v6Monthly.map(x => x.return),
        itemStyle: { color: '#ef6666' },
      }],
    });
    chart('nav-chart', {
      animation: false,
      tooltip: { trigger: 'axis' },
      grid: { left: 52, right: 18, top: 26, bottom: 36 },
      xAxis: {
        ...axisBase(), type: 'category',
        data: months.map(x => x.month.slice(5)),
      },
      yAxis: {
        ...axisBase(), type: 'value',
        axisLabel: { formatter: v => v.toFixed(2) },
      },
      series: [{
        name: '累计净值', type: 'line', smooth: false,
        data: months.map(x => x.nav),
        lineStyle: { color: '#e5b94f', width: 2 },
        itemStyle: { color: '#e5b94f' },
        areaStyle: { color: 'rgba(229,185,79,.08)' },
      }],
    });
    if (!original) {
      $('#monthly-table').innerHTML = `<thead><tr>
        <th>月份</th><th>V6月收益</th><th>累计收益</th><th>月盈亏</th>
        <th>买入</th><th>卖出</th><th>多点</th><th>空点</th><th>月末持仓</th>
      </tr></thead><tbody>${v6Monthly.map(row => `<tr>
        <td>${esc(row.month)}</td>
        <td class="${tone(row.return)}">${pct(row.return)}</td>
        <td class="${tone(row.cumulative_return)}">${pct(row.cumulative_return)}</td>
        <td class="${tone(row.profit_cny)}">${cny(row.profit_cny)}</td>
        <td>${num(row.buys)}</td><td>${num(row.sells)}</td>
        <td>${num(row.long_signals)}</td><td>${num(row.short_signals)}</td>
        <td>${num(row.holdings_end)}</td></tr>`).join('')}</tbody>`;
      $('#daily-return-panel').hidden = true;
      return;
    }
    $('#daily-return-panel').hidden = false;
    $('#monthly-table').innerHTML = `<thead><tr>
      <th>月份</th><th>月收益</th><th>累计收益</th><th>月盈亏</th>
      <th>买入</th><th>卖出</th><th>规则卖出</th>
      <th>多头信号</th><th>空头信号</th><th>月末持仓</th>
    </tr></thead><tbody>${originalMonthly.map(row => {
      return `<tr><td>${esc(row.month)}</td>
        <td class="${tone(row.return)}">${pct(row.return)}</td>
        <td class="${tone(row.cumulative_return)}">${pct(row.cumulative_return)}</td>
        <td class="${tone(row.profit_cny)}">${cny(row.profit_cny)}</td>
        <td>${num(row.buys)}</td><td>${num(row.sells)}</td>
        <td>${num(row.rule_sells)}</td>
        <td>${num(row.long_signals)}</td><td>${num(row.short_signals)}</td>
        <td>${num(row.holdings_end)}</td></tr>`;
    }).join('')}</tbody>`;
    renderDailyReturns();
  }

  function renderDailyReturns() {
    const rows = DATA.history.daily || [];
    const months = [...new Set(rows.map(row => row.month))].sort();
    if (!months.includes(dailyReturnMonth)) {
      dailyReturnMonth = months.at(-1) || '';
    }
    const select = $('#daily-return-month');
    select.innerHTML = months.map(month =>
      `<option value="${esc(month)}">${esc(month)}</option>`).join('');
    select.value = dailyReturnMonth;
    const selected = rows.filter(row => row.month === dailyReturnMonth);
    $('#daily-return-table').innerHTML = `<thead><tr>
      <th>交易日</th><th>当日盈亏</th><th>累计收益</th><th>当日盈亏金额</th>
      <th>买入</th><th>卖出</th><th>规则卖出</th>
      <th>多头信号</th><th>空头信号</th><th>收盘持仓</th>
    </tr></thead><tbody>${selected.length ? selected.map(row => `<tr>
      <td>${esc(row.date)}</td>
      <td class="${tone(row.return)}">${pct(row.return)}</td>
      <td class="${tone(row.cumulative_return)}">${pct(row.cumulative_return)}</td>
      <td class="${tone(row.profit_cny)}">${cny(row.profit_cny)}</td>
      <td>${num(row.buys)}</td><td>${num(row.sells)}</td>
      <td>${num(row.rule_sells)}</td>
      <td>${num(row.long_signals)}</td><td>${num(row.short_signals)}</td>
      <td>${num(row.holdings_end)}</td></tr>`).join('')
      : emptyRow(10, '暂无交易日明细')}</tbody>`;
  }

  function renderOverview() {
    const history = DATA.history;
    const summary = history.summary || {};
    const paper = DATA.paper?.summary || {};
    $('#overview-kpis').innerHTML = [
      kpi('原始策略年度收益', pct(summary.annual_return),
        `${num(summary.closed_trades)} 笔闭环交易`, tone(summary.annual_return)),
      kpi('规则卖出', num(summary.rule_sell_count),
        '14:56判定 · 15:00尾盘竞价'),
      kpi('闭环胜率', pct(summary.win_rate),
        '真实1分钟下一分钟成交'),
      kpi('主板股票', num(history.universe_count),
        `非 ST · 分钟触发完整 ${num(DATA.intraday_replay?.complete_count)}`),
      kpi('实时模拟净盈亏', cny(paper.net_pnl),
        `${num(paper.fill_count)} 笔成交`, tone(paper.net_pnl)),
      kpi('当前持仓', `${num(paper.holding_count)} 只`,
        `待卖 ${num(paper.pending_exit_count)} 只`),
    ].join('');

    renderMonthlyOverview();
  }

  function isV502Selection() {
    return DATA.final_selection?.schema
      === "awakening-return500-v502-primary-v1";
  }

  function renderCandidates() {
    const payload = DATA.final_selection || {};
    if (!isV502Selection()) {
      throw new Error("V502 primary strategy payload required");
    }
    const summary = payload.summary || {};
    const audit = payload.audit || {};
    const periods = summary.periods || {};
    const doubleCost = summary.double_cost_periods || {};
    const highEntry = summary.minute_high_entry_periods || {};
    document.querySelector("#candidate-kpis").innerHTML = [
      kpi("2024 收益", pct(periods["2024"]?.return),
        "回撤 " + pct(periods["2024"]?.maximum_drawdown),
        tone(periods["2024"]?.return)),
      kpi("2025 收益", pct(periods["2025"]?.return),
        "回撤 " + pct(periods["2025"]?.maximum_drawdown),
        tone(periods["2025"]?.return)),
      kpi("2026 收益", pct(periods["2026"]?.return),
        "回撤 " + pct(periods["2026"]?.maximum_drawdown),
        tone(periods["2026"]?.return)),
      kpi("2026 双成本", pct(doubleCost["2026"]?.return),
        "成本压力测试", tone(doubleCost["2026"]?.return)),
      kpi("2026 分钟最高价", pct(highEntry["2026"]?.return),
        "成交价压力测试", tone(highEntry["2026"]?.return)),
      kpi("真实资金", "未放行",
        "去头股或最佳日后稳健门槛未通过"),
    ].join("");
    const strategy = payload.strategy || {};
    document.querySelector("#selection-strategy").textContent =
      strategy.operational_identity || "—";
    document.querySelector("#selection-information-end").textContent =
      strategy.information_end || "—";
    document.querySelector("#selection-training-window").textContent =
      strategy.execution || "—";
    document.querySelector("#selection-coverage").textContent =
      "2024–2025 开发选择 · 2026 只读验证 · 收益与回撤已锁定";
    document.querySelector("#selection-integrity").textContent =
      audit.metrics_exactly_frozen
        ? "因果链与收益回撤已锁定" : "V502 基线漂移";
    document.querySelector("#selection-integrity").className =
      "status " + (audit.metrics_exactly_frozen ? "ok" : "bad");
    document.querySelector("#candidate-hash").textContent =
      "V502 展示哈希 " + (audit.result_sha256 || "—");
    renderSelectionTable();
  }

  function filteredSelections() {
    const year = document.querySelector("#selection-year").value;
    const result = document.querySelector("#selection-result").value;
    const query = document.querySelector(
      "#selection-search"
    ).value.trim().toLowerCase();
    return (DATA.final_selection?.rows || []).filter(row => {
      if (year !== "all" && String(row.year) !== year) return false;
      if (result === "profit" && !(row.net_return > 0)) return false;
      if (result === "loss" && !(row.net_return <= 0)) return false;
      if (
        query
        && !`${row.code}${row.name}`.toLowerCase().includes(query)
      ) return false;
      return true;
    });
  }

  function renderSelectionTable() {
    const rows = filteredSelections();
    document.querySelector("#selection-count").textContent =
      `显示 ${num(rows.length)} / ${
        num(DATA.final_selection?.rows?.length || 0)} 笔`;
    const reasons = {
      weakness: "早盘走弱",
      trailing: "回撤退出",
      trend_break: "趋势破坏",
      maximum_hold: "最长持有",
      unresolved_exit_total_loss: "未能退出",
    };
    document.querySelector("#candidate-table").innerHTML = `<thead><tr>
      <th>入场日</th><th>股票</th><th>排名 / 仓位</th>
      <th>09:35 涨幅 / 位置 / 路径</th>
      <th>09:36 涨幅 / 位置 / 路径</th>
      <th>09:37 买入价 / 涨跌幅</th>
      <th>退出 / 持有</th><th>退出原因</th>
      <th>卖出价 / 当日涨跌幅</th><th>实际净收益</th>
    </tr></thead><tbody>${rows.length ? rows.map(row => {
      const reason = String(row.exit_reason || "").split("+")
        .map(value => reasons[value] || value).join(" / ");
      const flags = [
        row.top_security ? "头部贡献" : "",
        row.best_day ? "最佳日" : "",
      ].filter(Boolean).join(" · ");
      return `<tr>
        <td>${esc(row.day)}</td>
        <td><button class="stock-link candidate-stock-link"
          data-code="${esc(row.code)}" data-date="${esc(row.day)}"
          type="button">${esc(row.code)}</button><br>${esc(row.name)}</td>
        <td>Top${num(row.candidate_rank)} / ${pct(row.weight)}</td>
        <td class="${tone(row.signal_return)}">${pct(row.signal_return)}
          / ${num(row.range_position, 2)}
          / ${num(row.path_efficiency, 2)}</td>
        <td class="${tone(row.confirmation_return)}">${pct(row.confirmation_return)}
          / ${num(row.confirmation_range_position, 2)}
          / ${num(row.confirmation_path_efficiency, 2)}</td>
        <td>${num(row.entry_price, 2)}
          / <span class="${tone(row.entry_return)}">${pct(row.entry_return)}</span></td>
        <td>${esc(row.exit_day)} 09:36
          / ${num(row.hold_days)}日</td>
        <td>${esc(reason)}${flags ? `<br>${esc(flags)}` : ""}</td>
        <td>${num(row.exit_price, 2)}
          / <span class="${tone(row.exit_day_return)}">${pct(row.exit_day_return)}</span></td>
        <td class="${tone(row.net_return)}">${pct(row.net_return)}</td>
      </tr>`;
    }).join("") : emptyRow(10, "当前筛选条件没有交易")}</tbody>`;
    document.querySelectorAll(".candidate-stock-link").forEach(button => {
      button.addEventListener("click", () =>
        openStock(button.dataset.code, button.dataset.date));
    });
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

  async function loadStockSignalMarks(code) {
    if (!stockSignalMarkCache.has(code)) {
      const value = await loadFirst([
        `signal-marks/${code.slice(0, 2)}/${code}.json`,
      ]);
      if (
        value.schema !== 'awakening-trend-signal-marks-v1'
        || value.code !== code
        || !Array.isArray(value.marks)
      ) {
        throw new Error('历史信号分钟定位不完整');
      }
      stockSignalMarkCache.set(code, value);
    }
    return stockSignalMarkCache.get(code);
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
      const signalMarks = await loadStockSignalMarks(code);
      value.intradayMarks = signalMarks.marks;
      const live = await loadStockLive(code);
      if (live) {
        const bars = value.bars.slice();
        const liveSignals = [];
        const recentDaily = Array.isArray(live.daily_bars)
          ? live.daily_bars.filter(row =>
            Array.isArray(row) && row.length >= 6)
          : [];
        if (
          live.daily_bar?.date
          && !recentDaily.some(row => row[0] === live.daily_bar.date)
        ) {
          recentDaily.push([
            live.daily_bar.date,
            Number(live.daily_bar.open),
            Number(live.daily_bar.high),
            Number(live.daily_bar.low),
            Number(live.daily_bar.close),
            Number(live.daily_bar.volume),
          ]);
        }
        for (const row of recentDaily) {
          const normalized = [
            String(row[0]), ...row.slice(1, 6).map(Number),
          ];
          if (normalized.slice(1).some(item => !Number.isFinite(item))) {
            continue;
          }
          const index = bars.findIndex(
            bar => bar[0] === normalized[0]);
          if (index >= 0) bars[index] = normalized;
          else bars.push(normalized);
        }
        const dailyByDate = new Map(
          recentDaily.map(row => [String(row[0]), row]));
        for (const day of live.days || []) {
          if (!day.points?.length) continue;
          const prices = day.points.map(point => Number(point[1]));
          const volume = day.points.reduce(
            (total, point) => total + Number(point[2] || 0), 0);
          const exact = dailyByDate.get(day.date);
          const row = exact ? [
            day.date, ...exact.slice(1, 6).map(Number),
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

  function dailyMinuteContext(daily, date) {
    const bars = daily?.bars || [];
    const index = bars.findIndex(row =>
      String(row[0]).replaceAll('-', '') === date);
    const candidate = stockCandidateForDate(daily?.code, date);
    const candidatePreviousClose = NaN;
    if (index < 0) {
      return {
        close: null,
        previousClose: (
          Number.isFinite(candidatePreviousClose)
          && candidatePreviousClose > 0
        ) ? candidatePreviousClose : null,
      };
    }
    return {
      close: Number(bars[index][4]),
      previousClose: index > 0
        ? Number(bars[index - 1][4])
        : (
          Number.isFinite(candidatePreviousClose)
          && candidatePreviousClose > 0
        ) ? candidatePreviousClose : Number(daily.prior_close),
    };
  }

  function stockCandidateForDate(code, date) {
    const normalized = String(date || '').replace(
      /^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    return selectionRows().find(
      row => row.day === normalized && row.code === code) || null;
  }

  function intradayMarksForDate(daily, date) {
    const normalized = String(date || '').replace(
      /^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    return (daily?.intradayMarks || [])
      .filter(mark => mark[0] === normalized)
      .map(mark => [
        String(mark[1]), Number(mark[2]), mark[3],
        Number(mark[4]), Number(mark[5]),
      ]);
  }

  function parseTencentMinuteRows(
    rawRows, date, daily, rawPreviousClose = null,
  ) {
    const unique = new Map();
    for (const raw of rawRows || []) {
      if (typeof raw !== 'string') continue;
      const [time, rawPrice, rawVolume, rawAmount] =
        raw.trim().split(/\s+/);
      const regular = /^\d{4}$/.test(time) && (
        ('0930' <= time && time <= '1130')
        || ('1300' <= time && time <= '1500')
      );
      const price = Number(rawPrice);
      const cumulativeHands = Number(rawVolume);
      const cumulativeAmount = Number(rawAmount);
      if (
        !regular || !Number.isFinite(price) || price <= 0
        || !Number.isFinite(cumulativeHands) || cumulativeHands < 0
      ) continue;
      unique.set(time, {
        time, price, cumulativeHands,
        cumulativeAmount: Number.isFinite(cumulativeAmount)
          ? cumulativeAmount : null,
      });
    }
    const rows = [...unique.values()].sort(
      (left, right) => left.time.localeCompare(right.time));
    if (!rows.length) throw new Error('腾讯分钟行情无有效数据');
    const context = dailyMinuteContext(daily, date);
    const factor = Number.isFinite(context.close) && context.close > 0
      ? context.close / rows.at(-1).price : 1;
    const previousClose = (
      Number.isFinite(context.previousClose)
      && context.previousClose > 0
    ) ? context.previousClose : Number(rawPreviousClose) * factor;
    if (!Number.isFinite(previousClose) || previousClose <= 0) {
      throw new Error('腾讯分钟行情缺少前收盘');
    }
    let previousHands = 0;
    let previousAmount = 0;
    const points = rows.map(row => {
      if (
        row.cumulativeHands < previousHands
        || (
          row.cumulativeAmount != null
          && row.cumulativeAmount < previousAmount
        )
      ) {
        throw new Error('腾讯分钟累计成交量异常');
      }
      const volume = (row.cumulativeHands - previousHands) * 100;
      const amount = row.cumulativeAmount == null
        ? null : row.cumulativeAmount - previousAmount;
      previousHands = row.cumulativeHands;
      if (row.cumulativeAmount != null) {
        previousAmount = row.cumulativeAmount;
      }
      const average = (
        row.cumulativeAmount != null && row.cumulativeHands > 0
      ) ? row.cumulativeAmount / (row.cumulativeHands * 100) * factor
        : null;
      return [
        row.time, row.price * factor, volume, amount, average,
      ];
    });
    return [
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
      previousClose, points, intradayMarksForDate(daily, date),
      '腾讯在线分钟价量',
      '1分钟', null,
    ];
  }

  function parseTencentMinutePayloads(
    currentPayload, historyPayload, symbol, daily,
  ) {
    const result = [];
    const historyDays = historyPayload?.data?.[symbol]?.data;
    if (historyPayload?.code === 0 && Array.isArray(historyDays)) {
      for (const day of historyDays) {
        const date = String(day?.date || '');
        if (/^\d{8}$/.test(date) && Array.isArray(day.data)) {
          try {
            result.push(parseTencentMinuteRows(
              day.data, date, daily));
          } catch (_error) {
            // One malformed day must not discard other valid minute days.
          }
        }
      }
    }
    const current = currentPayload?.data?.[symbol];
    const currentDate = String(current?.data?.date || '');
    const quote = current?.qt?.[symbol];
    if (
      currentPayload?.code === 0
      && /^\d{8}$/.test(currentDate)
      && Array.isArray(current?.data?.data)
      && Array.isArray(quote)
    ) {
      try {
        const day = parseTencentMinuteRows(
          current.data.data, currentDate, daily, Number(quote[4]));
        const index = result.findIndex(item => item[0] === day[0]);
        if (index >= 0) result[index] = day;
        else result.push(day);
      } catch (_error) {
        // Valid historical minute days can still be used.
      }
    }
    return result;
  }

  function parseArchivedMinute(payload, code, date, daily) {
    const compact = String(date || '').replaceAll('-', '');
    if (payload?.schema === 'awakening-minute-archive-month-v1') {
      if (
        payload.code !== code
        || payload.month !== compact.slice(0, 6)
      ) {
        throw new Error('SuperMind月度分钟归档不匹配');
      }
      payload = (payload.days || []).find(day => day.date === compact);
    }
    if (
      payload?.schema !== 'awakening-minute-archive-stock-v1'
      || payload.code !== code
      || payload.date !== compact
      || payload.frequency !== '1m'
      || !Array.isArray(payload.points)
      || payload.points.length < 200
    ) {
      throw new Error('SuperMind分钟归档不完整');
    }
    const context = dailyMinuteContext(daily, compact);
    const rawClose = Number(payload.points.at(-1)?.[4]);
    if (
      !Number.isFinite(context.previousClose)
      || context.previousClose <= 0
      || !Number.isFinite(rawClose)
      || rawClose <= 0
    ) {
      throw new Error('SuperMind分钟归档缺少日K复权基准');
    }
    const factor = (
      Number.isFinite(context.close) && context.close > 0
    ) ? context.close / rawClose : 1;
    let cumulativeVolume = 0;
    let cumulativeAmount = 0;
    const points = payload.points.map(row => {
      const time = String(row?.[0] || '');
      const close = Number(row?.[4]);
      const volume = Number(row?.[5]);
      const amount = Number(row?.[6]);
      if (
        !/^\d{4}$/.test(time)
        || !Number.isFinite(close) || close <= 0
        || !Number.isFinite(volume) || volume < 0
        || !Number.isFinite(amount) || amount < 0
      ) return null;
      cumulativeVolume += volume;
      cumulativeAmount += amount;
      return [
        time, close * factor, volume, amount,
        cumulativeVolume > 0
          ? cumulativeAmount / cumulativeVolume * factor : null,
      ];
    }).filter(Boolean);
    if (points.length < 200) {
      throw new Error('SuperMind分钟归档有效分钟不足');
    }
    return [
      `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`,
      context.previousClose, points,
      intradayMarksForDate(daily, compact),
      'SuperMind真实1分钟统一归档', '1分钟', null,
    ];
  }

  async function loadArchivedMinute(code, date, daily) {
    const compact = String(date || '').replaceAll('-', '');
    const month = compact.slice(0, 6);
    const routed = DATA.minute_archive?.month_base_urls?.[month];
    const base = String(
      routed || DATA.minute_archive?.base_url || ''
    ).replace(/\/+$/, '');
    if (!base || !/^\d{8}$/.test(compact)) return null;
    const payload = await loadFirst([
      `${base}/months/${month}/${code.slice(0, 2)}/${code}.json.gz`,
      `${base}/days/${compact}/${code.slice(0, 2)}/${code}.json.gz`,
      `${base}/days/${compact}/${code.slice(0, 2)}/${code}.json`,
    ]);
    return parseArchivedMinute(payload, code, date, daily);
  }

  async function loadTencentMinutes(code, daily) {
    const symbol = stockSymbol(code);
    if (!symbol) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const suffix = `&_=${Date.now()}`;
    const urls = [
      `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}${suffix}`,
      `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${symbol}${suffix}`,
    ];
    let results;
    try {
      results = await Promise.allSettled(urls.map(async url => {
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: 'omit', cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }));
    } finally {
      clearTimeout(timeout);
    }
    const current = results[0].status === 'fulfilled'
      ? results[0].value : null;
    const history = results[1].status === 'fulfilled'
      ? results[1].value : null;
    return parseTencentMinutePayloads(
      current, history, symbol, daily);
  }

  async function loadStockMinutes(code, daily, requestedDate = '') {
    if (!stockMinuteCache.has(code)) {
      stockMinuteCache.set(code, {
        code,
        schema: 'awakening-trend-online-minutes-v1',
        days: [],
        onlineLoaded: false,
      });
    }
    const result = stockMinuteCache.get(code);
    const upsert = day => {
      const index = result.days.findIndex(item => item[0] === day[0]);
      if (index >= 0) result.days[index] = day;
      else result.days.push(day);
      result.days.sort((left, right) =>
        left[0].localeCompare(right[0]));
    };
    if (requestedDate) {
      try {
        const archived = await loadArchivedMinute(
          code, requestedDate, daily);
        if (archived) upsert(archived);
      } catch (_error) {
        // The requested stock day may legitimately be outside archive scope.
      }
      if (result.days.some(day => day[0] === requestedDate)) {
        return result;
      }
    }
    if (!result.onlineLoaded) {
      result.onlineLoaded = true;
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
            upsert(normalized);
          }
        } catch (_error) {
          // Tencent/Sina persisted snapshots remain optional.
        }
      }
      try {
        for (const online of await loadTencentMinutes(code, daily)) {
          const persisted = result.days.find(
            item => item[0] === online[0]);
          if (persisted?.[3]?.length) {
            online[3] = persisted[3];
          }
          online[6] = persisted?.[6] || null;
          upsert(online);
        }
      } catch (_error) {
        // Persisted Tencent/Sina one-minute evidence remains available.
      }
    }
    if (!result.days.length) throw new Error('分时数据暂不可用');
    return result;
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

  function stockDailyWindow(dates, selectedDate, visibleBars = 80) {
    const selectedIndex = dates.indexOf(selectedDate);
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
      start: dates.length
        ? (startIndex / dates.length) * 100 : 0,
      end: dates.length
        ? ((endIndex + 1) / dates.length) * 100 : 100,
    };
  }

  const stockDailyJumpSeries = '分时跳转热区';

  function stockDailyJumpIndex(params) {
    if (!params) return -1;
    if (params.componentType === 'markPoint') {
      const index = Number(params.data?.coord?.[0]);
      return Number.isInteger(index) ? index : -1;
    }
    if (
      params.componentType !== 'series'
      || ![
        '日K', 'MA5', 'MA10', 'MA20', '成交量',
        stockDailyJumpSeries,
      ].includes(params.seriesName)
    ) return -1;
    const index = Number(params.dataIndex);
    return Number.isInteger(index) ? index : -1;
  }

  function stockDailyPixelIndex(instance, event, count) {
    const x = Number(event?.offsetX ?? event?.event?.zrX);
    const y = Number(event?.offsetY ?? event?.event?.zrY);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !instance) return -1;
    const gridIndex = instance.containPixel(
      { gridIndex: 0 }, [x, y],
    ) ? 0 : instance.containPixel(
      { gridIndex: 1 }, [x, y],
    ) ? 1 : -1;
    if (gridIndex < 0) return -1;
    const values = instance.convertFromPixel(
      { gridIndex }, [x, y]);
    const index = Math.round(Number(values?.[0]));
    return Number.isInteger(index) && index >= 0 && index < count
      ? index : -1;
  }

  function clearStockDailyPointer(instance, state) {
    const handlers = state?.dailyPointerHandlers;
    if (!instance || !handlers) return;
    const renderer = instance.getZr();
    renderer.off('click', handlers.click);
    renderer.off('mousemove', handlers.mousemove);
    renderer.off('globalout', handlers.globalout);
    state.dailyPointerHandlers = null;
    state.dailyHoverIndex = -1;
  }

  function stockDailyJumpOverlay(closes) {
    return {
      name: stockDailyJumpSeries,
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
          style: {
            fill: 'rgba(85,197,199,.001)',
          },
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

  function stockDailyMarks(daily) {
    const makeMark = (
      index, direction, strength, probability, name = '',
      kind = 'formula_signal', price = null,
    ) => {
      const bar = daily.bars[index];
      if (!bar || ![1, -1].includes(Number(direction))) return null;
      const long = Number(direction) === 1;
      const strong = strength === 'strong';
      const strategyBuy = kind === 'strategy_buy';
      const finalSelection = kind === 'final_selection';
      const label = finalSelection
        ? '选股' : strategyBuy ? '买点' : signalLabel(direction, strength);
      const color = strategyBuy
        ? '#ef6666'
        : finalSelection
          ? '#e5b94f'
        : long
        ? (strong ? signalColors.strongLong : signalColors.weakLong)
        : (strong ? signalColors.strongShort : signalColors.weakShort);
      const markerPrice = (
        strategyBuy && Number.isFinite(Number(price))
      ) ? Number(price) : long ? Number(bar[3]) : Number(bar[2]);
      return {
        name: name || label,
        direction: Number(direction),
        strength,
        kind,
        coord: [index, markerPrice],
        value: label,
        symbol: strategyBuy ? 'diamond' : 'circle',
        symbolSize: strategyBuy ? 30 : 36,
        symbolOffset: [
          0, strategyBuy ? '-82%' : long ? '72%' : '-72%',
        ],
        itemStyle: {
          color,
          borderColor: '#101619',
          borderWidth: 3,
          opacity: 1,
        },
        label: {
          show: true,
          color: '#ffffff',
          fontSize: 12,
          lineHeight: 16,
          fontWeight: 700,
          formatter: label,
        },
        probability,
      };
    };
    const build = (rows, strength) => (rows || []).map(item => {
      const index = Number(item[0]);
      const direction = Number(item[1]);
      const probability = Number(item[2]);
      return makeMark(index, direction, strength, probability);
    }).filter(Boolean);
    const result = [
      ...build(daily.signals, 'strong'),
      ...build(daily.filtered_signals, 'weak'),
    ];
    const dates = daily.bars.map(row => row[0]);
    for (const signal of daily.liveSignals || []) {
      const index = dates.indexOf(signal.date);
      if (index < 0) continue;
      const label = signalLabel(signal.direction, signal.strength);
      const mark = makeMark(
        index, signal.direction, signal.strength,
        signal.probability, `盘中首${label}`);
      if (mark) result.push(mark);
    }
    const existingLongDates = new Set(
      result.filter(mark => Number(mark.direction) === 1)
        .map(mark => dates[mark.coord[0]]));
    for (const selection of selectionRows()) {
      if (selection.code !== stockMarketState?.code) continue;
      const index = dates.indexOf(selection.day);
      if (index < 0 || existingLongDates.has(selection.day)) continue;
      const mark = makeMark(
        index, 1, 'strong', selection.normalized_margin,
        '策略选股', 'final_selection');
      if (mark) result.push(mark);
      existingLongDates.add(selection.day);
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
    const { start, end } = stockDailyWindow(
      dates, state.date);
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
          return `${esc(row[0])}<br>开 ${num(row[1], 2)}　收 ${num(row[4], 2)}`
            + `<br>高 ${num(row[2], 2)}　低 ${num(row[3], 2)}`
            + (averages ? `<br>${averages}` : '')
            + `<br>成交量 ${num(row[5])}`
            + '<br><span style="color:#55c5c7;font-weight:700">'
            + '点击查看该日分时</span>';
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
          ...axisBase(), type: 'category', data: dates,
          boundaryGap: true, axisLabel: { show: false },
          axisPointer: {
            show: true,
            type: 'shadow',
            label: { show: false },
            shadowStyle: { color: 'rgba(85,197,199,.10)' },
          },
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
        { type: 'inside', xAxisIndex: [0, 1], start, end },
        {
          type: 'slider', xAxisIndex: [0, 1],
          height: 18, bottom: 2, start, end,
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
        stockDailyJumpOverlay(closes),
      ],
    });
    clearStockDailyPointer(instance, state);
    instance?.off('click');
    instance?.off('mouseover');
    instance?.off('mouseout');
    const signalMarks = marks.filter(mark =>
      mark.kind !== 'strategy_buy');
    const strong = signalMarks.filter(mark =>
      mark.strength === 'strong').length;
    const weak = signalMarks.length - strong;
    const buys = marks.length - signalMarks.length;
    const dailyStatus =
      `前复权日K ${bars[0][0]} 至 ${bars.at(-1)[0]} · 强信号 ${strong} · 弱信号 ${weak} · 策略买点 ${buys} · 点击K线查看对应日期分时（仅真实1分钟留存日可用）`;
    $('#stock-market-status').textContent = dailyStatus;
    if (!instance) return;
    const renderer = instance.getZr();
    const setHover = index => {
      if (index === state.dailyHoverIndex) return;
      if (state.dailyHoverIndex >= 0) {
        instance.dispatchAction({
          type: 'downplay',
          seriesName: stockDailyJumpSeries,
          dataIndex: state.dailyHoverIndex,
        });
      }
      state.dailyHoverIndex = index;
      if (index >= 0) {
        instance.dispatchAction({
          type: 'highlight',
          seriesName: stockDailyJumpSeries,
          dataIndex: index,
        });
        renderer.setCursorStyle('pointer');
        $('#stock-market-status').textContent =
          `${dates[index]} · 可跳转真实1分钟分时`;
      } else {
        renderer.setCursorStyle('default');
        $('#stock-market-status').textContent = dailyStatus;
      }
    };
    const handlers = {
      click: event => {
        const index = stockDailyPixelIndex(
          instance, event, dates.length);
        const day = dates[index];
        if (day) openStockMinuteDate(day);
      },
      mousemove: event => setHover(stockDailyPixelIndex(
        instance, event, dates.length)),
      globalout: () => setHover(-1),
    };
    state.dailyPointerHandlers = handlers;
    state.dailyHoverIndex = -1;
    renderer.on('click', handlers.click);
    renderer.on('mousemove', handlers.mousemove);
    renderer.on('globalout', handlers.globalout);
  }

  function renderStockMinute() {
    const state = stockMarketState;
    const day = state?.minuteByDate.get(state.date);
    if (!state || !day) {
      $('#stock-market-status').textContent =
        '该交易日没有腾讯/新浪1分钟数据';
      const instance = charts.get('stock-detail-chart');
      clearStockDailyPointer(instance, state);
      instance?.clear();
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
    const volumeDirections = minuteVolumeDirections(
      prices, previousClose, auctionCount);
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
    const candidate = stockCandidateForDate(state.code, date);
    const marks = [...(rawMarks || [])];
    if (candidate) {
      const signalTime = '0935';
      const existingLong = marks.findIndex(mark =>
        Number(mark[1]) === 1
        && mark[0] === signalTime);
      if (existingLong >= 0) {
        marks[existingLong] = [
          ...marks[existingLong].slice(0, 5), 'first_long'];
      } else {
        let signalIndex = points.findIndex(
          point => point[0] === signalTime);
        if (signalIndex < 0) {
          signalIndex = points.findIndex(
            point => point[0] > signalTime);
        }
        if (signalIndex >= 0) {
          marks.push([
            points[signalIndex][0], 1, 'strong',
            candidate.normalized_margin,
            prices[signalIndex],
            'final_selection',
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
      if (index < 0) return null;
      const long = Number(mark[1]) === 1;
      const weak = mark[2] === 'weak';
      const kind = mark[5] || 'formula_signal';
      const firstLong = kind === 'first_long';
      const strategyBuy = kind === 'strategy_buy';
      const finalSelection = kind === 'final_selection';
      const label = (
        finalSelection ? '策略选股'
        : firstLong ? '首次多'
        : strategyBuy ? '买点'
        : signalLabel(mark[1], mark[2]));
      const price = Number(mark[4]);
      const change = (price / previousClose - 1) * 100;
      const color = finalSelection
        ? '#e5b94f'
        : firstLong
        ? '#e5b94f'
        : strategyBuy
          ? '#ef6666'
          : long
        ? (weak ? signalColors.weakLong : signalColors.strongLong)
        : (weak ? signalColors.weakShort : signalColors.strongShort);
      const changeText =
        `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      return {
        name: label,
        coord: [index, price],
        value: `${label} ${changeText}`,
        symbol: strategyBuy ? 'diamond' : 'circle',
        symbolSize: strategyBuy ? 20 : firstLong ? 17 : weak ? 12 : 16,
        symbolOffset: [
          0,
          strategyBuy ? '55%' : long ? '-55%' : '55%',
        ],
        itemStyle: {
          color,
          borderColor: '#101619',
          borderWidth: strategyBuy || firstLong ? 2 : weak ? 1 : 2,
        },
        label: {
          show: true,
          position: strategyBuy ? 'bottom' : long ? 'top' : 'bottom',
          distance: strategyBuy || firstLong ? 22 : weak ? 16 : 22,
          color,
          backgroundColor: 'rgba(13,17,20,.92)',
          borderColor: color,
          borderWidth: 1,
          borderRadius: 3,
          padding: [3, 5],
          fontSize: strategyBuy || firstLong ? 10 : weak ? 9 : 10,
          lineHeight: 14,
          fontWeight: 700,
          formatter: (
            `${label} ${time}\n`
            + `¥${price.toFixed(2)} ${changeText}`),
        },
      };
    }).filter(Boolean);
    const ticks = (index, value) =>
      index === 0 || index === times.length - 1
      || ['10:30', '11:30', '14:00', '15:00'].includes(value);
    const legend = ['价格'];
    if (auctionCount) legend.push('竞价走势');
    if (hasAverage) legend.push('当日均价');
    if (hasVolume) legend.push('方向成交量');
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
            item => item.seriesName === '方向成交量');
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
              ? `<br>${minuteVolumeLabel(
                volumeDirections[dataIndex])} ${num(
                volumes[dataIndex])} 股`
              : '');
        },
      },
      grid: hasVolume ? [
        { left: 58, right: 18, top: 82, height: '44%' },
        { left: 58, right: 18, top: '69%', height: '20%' },
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
          name: '方向成交量', type: 'bar',
          xAxisIndex: 1, yAxisIndex: 1,
          barCategoryGap: '5%', barMinHeight: 1,
          data: volumes.map((value, index) => ({
            value,
            itemStyle: {
              color: minuteVolumeColor(
                volumeDirections[index]),
            },
          })),
        }] : []),
      ],
    });
    clearStockDailyPointer(instance, state);
    instance?.off('click');
    instance?.off('mouseover');
    instance?.off('mouseout');
    const labels = marks.map(mark => {
      const kind = mark[5] || 'formula_signal';
      const label = (
        kind === 'first_long' ? '首次多'
        : kind === 'strategy_buy' ? '买点'
        : signalLabel(mark[1], mark[2]));
      return `${clock(mark[0])} ${label}`;
    });
    $('#stock-market-status').textContent =
      `${date} 前复权${frequency || '分时'} · ${source || '历史行情'} · 昨收 ${num(previousClose, 2)}`
      + (auctionCount
        ? ` · 竞价 ${auctionCount} 点`
        : auction?.status === 'not_in_watch_pool'
          ? ' · 未纳入竞价观察池'
          : '')
      + (candidate ? ' · 黄=首次多 · 红=策略买点' : '')
      + (labels.length ? ` · ${labels.join(' · ')}` : '');
  }

  function stockMinuteDates(state) {
    const startDate = String(state?.minuteStartDate || '');
    const followupDates = startDate
      ? (state?.daily?.bars || [])
        .map(row => String(row?.[0] || ''))
        .filter(day => day >= startDate)
      : [];
    return [...new Set([
      ...(state ? [...state.minuteByDate.keys()] : []),
      ...((state?.daily?.intradayMarks || []).map(mark => mark[0])),
      ...followupDates,
    ])].sort();
  }

  function renderStockMinuteDateOptions(state) {
    const dates = stockMinuteDates(state);
    const signalDates = new Set(
      (state?.daily?.intradayMarks || []).map(mark => mark[0]));
    $('#stock-minute-date').innerHTML = dates.map(day =>
      `<option value="${esc(day)}">${esc(day)}${
        state.minuteByDate.has(day)
          ? '' : signalDates.has(day) ? ' · 信号日' : ' · 待加载'
      }</option>`).join('');
    $('#stock-minute-date').value = state.date;
    return dates;
  }

  function syncStockMinuteNavigation() {
    const state = stockMarketState;
    const dates = stockMinuteDates(state);
    const index = dates.indexOf(state?.date);
    $('#stock-minute-prev').disabled = index <= 0;
    $('#stock-minute-next').disabled =
      index < 0 || index >= dates.length - 1;
  }

  async function moveStockMinuteDate(offset) {
    const state = stockMarketState;
    if (!state) return;
    const dates = stockMinuteDates(state);
    const index = dates.indexOf(state.date);
    const target = dates[index + offset];
    if (!target) return;
    await openStockMinuteDate(target);
  }

  async function ensureStockMinutes(state, requestedDate = '') {
    if (
      state.minute
      && (!requestedDate || state.minuteByDate.has(requestedDate))
    ) return true;
    const requestKey = requestedDate || '__online__';
    if (!state.minutePromises.has(requestKey)) {
      state.minutePromises.set(
        requestKey,
        loadStockMinutes(state.code, state.daily, requestedDate),
      );
    }
    const promise = state.minutePromises.get(requestKey);
    try {
      const minute = await promise;
      if (stockMarketState !== state) return false;
      state.minute = minute;
      state.minuteByDate = new Map(
        minute.days.map(day => [day[0], day]));
      const loadedDates = [...state.minuteByDate.keys()].sort();
      if (!state.minuteByDate.has(state.date)) {
        state.date = loadedDates.at(-1) || '';
      }
      renderStockMinuteDateOptions(state);
      syncStockMinuteNavigation();
      if (!loadedDates.length) {
        $('#stock-market-status').textContent =
          '该股票没有统一归档或腾讯/新浪1分钟数据';
      }
      return Boolean(loadedDates.length);
    } catch (_error) {
      if (stockMarketState === state) {
        $('#stock-market-status').textContent =
          '该股票没有统一归档或腾讯/新浪1分钟数据';
      }
      return false;
    } finally {
      if (state.minutePromises.get(requestKey) === promise) {
        state.minutePromises.delete(requestKey);
      }
    }
  }

  async function openStockMinuteDate(date) {
    const state = stockMarketState;
    if (!state || !date) return;
    state.requestedMinuteDate = date;
    $('#stock-market-status').textContent =
      `正在核对 ${date} 的统一SuperMind 1分钟归档`;
    if (!await ensureStockMinutes(state, date)) return;
    if (
      stockMarketState !== state
      || state.requestedMinuteDate !== date
    ) return;
    if (!state.minuteByDate.has(date)) {
      $('#stock-market-status').textContent =
        `${date} 没有统一归档的真实1分钟数据，已保留日K`;
      return;
    }
    state.date = date;
    renderStockMinuteDateOptions(state);
    await setStockMarketView('minute');
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
          '正在读取统一SuperMind 1分钟归档或腾讯/新浪行情';
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

  async function openStock(code, requestedDate = '') {
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
    const chartInstance = charts.get('stock-detail-chart');
    clearStockDailyPointer(chartInstance, stockMarketState);
    stockMarketState = {
      code, name: row.name, daily: null, minute: null,
      minutePromises: new Map(), minuteByDate: new Map(),
      requestedMinuteDate: '', minuteStartDate: requestedDate,
      view: 'daily', date: requestedDate,
    };
    $('#stock-market-status').textContent = '正在读取日K';
    $('#stock-minute-date').innerHTML = '';
    $('#stock-minute-nav').hidden = true;
    syncStockMinuteNavigation();
    $('#stock-minute-tab').disabled = false;
    $('#stock-dialog').showModal();
    chartInstance?.clear();
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
        '日K数据不可用；可尝试查看腾讯/新浪1分钟行情';
      return;
    }
    if (stockMarketState !== state) return;
    await setStockMarketView('daily');
    if (requestedDate && stockMarketState === state) {
      await openStockMinuteDate(requestedDate);
    }
  }

  function renderPaper() {
    const summary = PAPER?.summary || DATA.paper?.summary || {};
    const slotSummary = DATA.v6_slot_shadow?.summary || {};
    const morningSummary = DATA.v6_morning_shadow?.summary || {};
    const cutoffSummary =
      DATA.v6_entry_cutoff_shadow?.summary || {};
    const live = DATA.trend_live || {};
    const validation = DATA.trend_validation || {};
    $('#paper-kpis').innerHTML = [
      kpi('独立账户', num(summary.account_count), cny(summary.initial_capital)),
      kpi('已实现盈亏', cny(summary.realized_pnl), '', tone(summary.realized_pnl)),
      kpi('浮动盈亏', cny(summary.unrealized_pnl), '', tone(summary.unrealized_pnl)),
      kpi('净盈亏', cny(summary.net_pnl), '', tone(summary.net_pnl)),
      kpi('持仓', `${num(summary.holding_count)} 只`, `待卖 ${num(summary.pending_exit_count)}`),
      kpi('模拟成交', `${num(summary.fill_count)} 笔`, '不连接券商'),
      kpi('V6四槽基线', cny(slotSummary.net_pnl),
        `净值 ${cny(slotSummary.equity)}`,
        tone(slotSummary.net_pnl)),
      kpi('基线槽位',
        `${num(slotSummary.holding_count)} / 4 持仓`,
        `待买 ${num(slotSummary.pending_entry_count)} · 待卖 ${num(slotSummary.pending_exit_count)}`),
      kpi('09:40规则挑战', cny(morningSummary.net_pnl),
        `净值 ${cny(morningSummary.equity)}`,
        tone(morningSummary.net_pnl)),
      kpi('挑战账本槽位',
        `${num(morningSummary.holding_count)} / 4 持仓`,
        `待买 ${num(morningSummary.pending_entry_count)} · 待卖 ${num(morningSummary.pending_exit_count)}`),
      kpi('11:00截止挑战', cny(cutoffSummary.net_pnl),
        `净值 ${cny(cutoffSummary.equity)}`,
        tone(cutoffSummary.net_pnl)),
      kpi('截止挑战槽位',
        `${num(cutoffSummary.holding_count)} / 4 持仓`,
        `待买 ${num(cutoffSummary.pending_entry_count)} · 待卖 ${num(cutoffSummary.pending_exit_count)}`),
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
    const health = DATA.paper?.health || validation;
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
        <td>${stockLink(row.code, row.code, 'paper-stock-link')}</td>
        <td>${stockLink(row.code, row.name, 'paper-stock-link')}</td>
        <td>${esc(industryName(row.industry))}</td>
        <td class="${long ? 'up' : 'down'}">${signalLabel(row.direction, row.strength)}</td>
        <td>${num(row.price, 2)}</td><td>${num(row.previous_close, 2)}</td>
        <td class="${tone(row.change)}">${pct(row.change)}</td>
        <td>${row.source === 'tencent' ? '腾讯' : esc(row.source)}</td></tr>`;
    }).join('') : emptyRow(9, '尚未形成今日首批信号')}</tbody>`;
    const accounts = (PAPER?.stocks || []).filter(row =>
      row.quantity || row.status !== 'cash' || row.net_pnl);
    const defaultExitRuleLabel = (
      PAPER?.exit_policy?.[0]?.label
      || DATA.paper?.exit_policy?.[0]?.label
      || '—'
    );
    $('#paper-stocks').innerHTML = `<thead><tr><th>代码</th><th>名称</th><th>状态</th><th>规则</th><th>数量</th><th>标记价</th><th>市值</th><th>浮动盈亏</th><th>净盈亏</th></tr></thead>
      <tbody>${accounts.length ? accounts.map(row => `<tr><td>${stockLink(row.code, row.code, 'paper-stock-link')}</td><td>${stockLink(row.code, row.name, 'paper-stock-link')}</td><td>${esc(row.status)}</td>
      <td>${esc(row.exit_rule || defaultExitRuleLabel)}</td>
      <td>${num(row.quantity)}</td><td>${num(row.mark_price, 2)}</td><td>${cny(row.market_value)}</td>
      <td class="${tone(row.unrealized_pnl)}">${cny(row.unrealized_pnl)}</td><td class="${tone(row.net_pnl)}">${cny(row.net_pnl)}</td></tr>`).join('') : emptyRow(9, '当前无持仓或异常账户')}</tbody>`;
    const fills = PAPER?.recent_fills || [];
    $('#paper-fills').innerHTML = `<thead><tr><th>时间</th><th>股票</th><th>方向</th><th>规则</th><th>价格</th><th>数量</th><th>盈亏</th></tr></thead>
      <tbody>${fills.length ? fills.map(row => `<tr><td>${dt(row.quote_at)}</td><td>${stockLink(row.code, `${row.code} ${row.name || ''}`.trim(), 'paper-stock-link')}</td>
      <td class="${row.side === 'buy' ? 'up' : 'down'}">${row.side === 'buy' ? '买入' : '卖出'}</td><td>${esc(row.rule_label || (row.side === 'sell' ? '空点卖出' : '多点买入'))}</td><td>${num(row.price, 2)}</td><td>${num(row.quantity)}</td>
      <td class="${tone(row.pnl)}">${cny(row.pnl)}</td></tr>`).join('') : emptyRow(7)}</tbody>`;
    const signals = PAPER?.recent_signals || [];
    $('#paper-signals').innerHTML = `<thead><tr><th>时间</th><th>股票</th><th>信号</th><th>规则</th><th>状态</th><th>原因</th></tr></thead>
      <tbody>${signals.length ? signals.map(row => `<tr><td>${dt(row.observed_at)}</td><td>${stockLink(row.code, `${row.code} ${row.name || ''}`.trim(), 'paper-stock-link')}</td>
      <td class="${row.direction === 'LONG' ? 'up' : 'down'}">${signalLabel(row.direction, row.strength)}</td>
      <td>${esc(row.rule_label || (row.direction === 'SHORT' ? '空点卖出' : '多点买入'))}</td>
      <td>${esc(row.status)}</td><td>${esc(row.reason)}</td></tr>`).join('') : emptyRow(6)}</tbody>`;
    document.querySelectorAll('.paper-stock-link').forEach(button => {
      button.addEventListener(
        'click', () => openStock(button.dataset.code));
    });
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
    const opportunity = research.opportunity_risk || {};
    const opportunityHeldout =
      opportunity.results?.heldout?.selected || {};
    const opportunityBase =
      opportunity.results?.heldout?.all_candidates || {};
    const quality = research.signal_quality || {};
    const qualityAcceptance = quality.acceptance || {};
    const qualitySelection = research.quality_selection || {};
    const selectionAcceptance = qualitySelection.acceptance || {};
    const heldoutSelection =
      qualitySelection.results?.heldout?.selected || {};
    const septemberSelection =
      qualitySelection.results?.september_5d?.selected || {};
    const secondExit = research.second_entry_exit || {};
    const v6Exit = research.v6_exit || {};
    const v6Shadow = v6Exit.selection?.posthoc_shadow_candidate;
    const v6BaselineFull =
      v6Exit.full_period?.raw_short_v6?.portfolio || {};
    const v6ShadowFull =
      v6Exit.full_period?.[v6Shadow]?.portfolio || {};
    const secondRule = secondExit.second_entry?.selected;
    const secondHeldout =
      secondExit.second_entry?.results?.heldout?.[secondRule] || {};
    const qualityHeldout =
      secondExit.high_mfe_commonality
        ?.episode_quality_results?.heldout || {};
    const exitAccepted = Boolean(secondExit.early_exit?.accepted);
    const validation = DATA.paper_validation || {};
    $('#research-kpis').innerHTML = [
      kpi('全天首次多头', num(quality.sample?.events),
        '早盘、上午后段、下午、尾盘全部覆盖'),
      kpi('低风险稳定样本',
        num(quality.sample?.eligible_stable_events),
        '首次涨幅≤5%且当时稳定性通过'),
      kpi('风险门验收',
        qualityAcceptance.risk_filter_passed ? '通过' : '未通过',
        '验证、留出、短留出均需降低浮亏',
        qualityAcceptance.risk_filter_passed ? 'up' : 'down'),
      kpi('收益推荐验收',
        qualityAcceptance.model_return_passed ? '通过' : '未通过',
        '三个未来区间净收益均需为正',
        qualityAcceptance.model_return_passed ? 'up' : 'down'),
      kpi('优质多头点估计',
        selectionAcceptance.point_estimates_passed ? '通过' : '未通过',
        '验证、7月、8月、9月固定5日',
        selectionAcceptance.point_estimates_passed ? 'up' : 'down'),
      kpi('影子统计置信',
        selectionAcceptance.statistical_confidence_passed ? '通过' : '不足',
        '各期日度Bootstrap 95%下界需大于0',
        selectionAcceptance.statistical_confidence_passed ? 'up' : 'down'),
      kpi('7-8月预算净收益',
        pct(heldoutSelection.budget_slot_net_return),
        `${num(heldoutSelection.selected)} 只 · 未入选槽位留现金`,
        tone(heldoutSelection.budget_slot_net_return)),
      kpi('9月固定5日净收益',
        pct(septemberSelection.budget_slot_net_return),
        `${num(septemberSelection.selected)} 只 · 非20日截断口径`,
        tone(septemberSelection.budget_slot_net_return)),
      kpi('二次结构覆盖',
        pct(secondHeldout.coverage),
        '7-8月完整持仓区间'),
      kpi('二次结构浮盈',
        pct(secondHeldout.first_entry_mean_mfe_when_present),
        `无二次结构 ${pct(secondHeldout.first_entry_mean_mfe_when_absent)}`,
        'up'),
      kpi('利润保护验收',
        exitAccepted ? '通过' : '仅影子',
        '无规则同时通过训练与全部样本外',
        exitAccepted ? 'up' : 'down'),
      kpi('V6研究资金收益',
        pct(v6BaselineFull.period_return),
        `-3%止损影子 ${pct(v6ShadowFull.period_return)}`,
        tone(v6BaselineFull.period_return)),
      kpi('提前空点配对改善', pct(early.paired_improvement), `${num(early.stocks)} 只股票`, tone(early.paired_improvement)),
      kpi('提前空点胜率', pct(early.early_trade_win_rate), `原空点 ${pct(early.base_trade_win_rate)}`),
      kpi('赢家画像大涨股', num(staged.return_winner_count), `V2 ${num(compare.return_winner_count)}`),
      kpi('最大浮盈赢家', num(staged.mfe_winner_count), `V2 ${num(compare.mfe_winner_count)}`),
      kpi('机会风险倍数',
        num(opportunityHeldout.opportunity_risk_multiple, 2),
        `7-8月全多头 ${num(opportunityBase.opportunity_risk_multiple, 2)}`),
      kpi('高机会可买样本',
        num(opportunityHeldout.entry_eligible_count),
        '机会识别与买入资格分离'),
      kpi('全量收益赢家', num(commonality.sample?.return_winners), `${num(commonality.sample?.events)} 条可成交样本`),
      kpi('板块补充召回', pct(capitalUnion.return_winner_recall), `原规则 ${pct(currentRule.return_winner_recall)}`),
      kpi('下一开盘代理收益', pct(entry.next_bar_open_price?.mean_daily_return), '全样本每日 Top5'),
      kpi('官方公告增量', announcementStable ? '稳定' : '不稳定',
        `${num(announcements.sample?.events_with_30d_announcement)} 条候选有近30日公告`,
        announcementStable ? 'up' : 'down'),
      kpi('分钟会计验收', validation.status === 'passed' ? '通过' : '待验收', `${num(validation.snapshots)} 个快照`),
    ].join('');

    const qualitySplits = [
      ['validation', '5-6月验证'],
      ['heldout', '7-8月留出'],
      ['final_short_holdout', '9月短留出'],
    ];
    const qualityRows = qualitySplits.map(([key, label]) => {
      const all = quality.profiles?.[key]?.all || {};
      const guarded =
        quality.profiles?.[key]?.buyable_and_stable || {};
      const selected = quality.model?.results?.[key] || {};
      return `<tr><td>${esc(label)}</td>
        <td class="${tone(all.slot_mean_net_return)}">${pct(all.slot_mean_net_return)}</td>
        <td class="${tone(guarded.slot_mean_net_return)}">${pct(guarded.slot_mean_net_return)}</td>
        <td>${pct(guarded.fill_rate)}</td>
        <td class="down">${pct(guarded.loss_5_rate)}</td>
        <td class="${tone(selected.slot_mean_net_return)}">${pct(selected.slot_mean_net_return)}</td>
        <td>${num(selected.events)}</td>
        <td class="down">${pct(selected.loss_5_rate)}</td></tr>`;
    }).join('');
    $('#quality-status').textContent =
      qualityAcceptance.buy_control_passed
        ? '可控制买入'
        : qualityAcceptance.risk_filter_passed
          ? '仅风险门通过'
          : '研究未通过';
    $('#quality-status').className =
      `status ${qualityAcceptance.buy_control_passed ? 'ok' : 'bad'}`;
    $('#quality-table').innerHTML = `<thead><tr>
      <th>时间外样本</th><th>全信号槽位收益</th><th>风险门后槽位收益</th>
      <th>风险门成交率</th><th>风险门浮亏≥5%</th>
      <th>精选模型槽位收益</th><th>精选数</th><th>精选浮亏≥5%</th>
      </tr></thead><tbody>${qualityRows || emptyRow(8)}</tbody>`;

    const selectionSplits = [
      ['validation', '5-6月验证'],
      ['july', '7月留出'],
      ['august', '8月留出'],
      ['september_5d', '9月固定5日'],
    ];
    const selectionRows = selectionSplits.map(([key, label]) => {
      const row =
        qualitySelection.results?.[key]?.selected || {};
      const ci = row.budget_slot_net_return_ci95 || [];
      return `<tr><td>${esc(label)}</td>
        <td>${num(row.selected)}</td>
        <td>${pct(row.execution_rate)}</td>
        <td>${pct(row.outcome_resolution_rate)}</td>
        <td class="${tone(row.budget_slot_net_return)}">${pct(row.budget_slot_net_return)}</td>
        <td class="${tone(ci[0])}">${pct(ci[0])} ～ ${pct(ci[1])}</td>
        <td class="${tone(row.profit_per_100k_daily_budget)}">${cny(row.profit_per_100k_daily_budget)}</td>
        <td>${pct(row.filled_win_rate)}</td>
        <td class="up">${pct(row.mean_max_floating_profit)}</td>
        <td class="down">${pct(row.mean_max_floating_loss)}</td>
        <td class="down">${pct(row.loss_5_rate)}</td></tr>`;
    }).join('');
    $('#quality-selection-status').textContent =
      selectionAcceptance.buy_control_passed
        ? '可控制买入'
        : selectionAcceptance.point_estimates_passed
          ? '仅影子，未控制买入'
          : '研究未通过';
    $('#quality-selection-status').className =
      `status ${selectionAcceptance.buy_control_passed ? 'ok' : 'bad'}`;
    $('#quality-selection-table').innerHTML = `<thead><tr>
      <th>时间外样本</th><th>入选</th><th>执行率</th><th>结果完整率</th>
      <th>每日预算净收益</th><th>日度95%区间</th>
      <th>每10万累计实际盈亏</th><th>成交胜率</th>
      <th>最大浮盈</th><th>最大浮亏</th><th>浮亏≥5%</th>
      </tr></thead><tbody>${selectionRows || emptyRow(11)}</tbody>`;

    const bandLabels = {
      open: '09:30–10:00',
      late_morning: '10:00–11:30',
      afternoon: '13:00–14:30',
      late_session: '14:30–14:55',
    };
    const bandRows = Object.entries(bandLabels).map(([band, label]) => {
      const cells = qualitySplits.map(([key]) =>
        quality.profiles?.[key]?.[`buyable_stable_${band}`] || {});
      return `<tr><td>${esc(label)}</td>${cells.map(cell =>
        `<td class="${tone(cell.slot_mean_net_return)}">${pct(cell.slot_mean_net_return)}</td>
         <td class="down">${pct(cell.loss_5_rate)}</td>
         <td>${pct(cell.fill_rate)}</td>`).join('')}</tr>`;
    }).join('');
    $('#quality-band-table').innerHTML = `<thead><tr>
      <th rowspan="2">首次信号时段</th>
      <th colspan="3">5-6月验证</th><th colspan="3">7-8月留出</th>
      <th colspan="3">9月短留出</th></tr><tr>
      <th>收益</th><th>浮亏≥5%</th><th>成交率</th>
      <th>收益</th><th>浮亏≥5%</th><th>成交率</th>
      <th>收益</th><th>浮亏≥5%</th><th>成交率</th>
      </tr></thead><tbody>${bandRows || emptyRow(10)}</tbody>`;

    const secondSplits = [
      ['validation', '5-6月验证'],
      ['heldout', '7-8月留出'],
      ['final_short_holdout', '9月短留出'],
    ];
    const secondRows = secondSplits.map(([key, label]) => {
      const row =
        secondExit.second_entry?.results?.[key]?.[secondRule] || {};
      const qualityRow =
        secondExit.high_mfe_commonality
          ?.episode_quality_results?.[key] || {};
      return `<tr><td>${esc(label)}</td>
        <td>${pct(row.coverage)}</td>
        <td class="up">${pct(row.first_entry_mean_mfe_when_present)}</td>
        <td>${pct(row.first_entry_mean_mfe_when_absent)}</td>
        <td class="${tone(row.second_entry_mean_return)}">${pct(row.second_entry_mean_return)}</td>
        <td class="${tone(row.mean_waiting_delta_vs_first_entry)}">${pct(row.mean_waiting_delta_vs_first_entry)}</td>
        <td>${pct(qualityRow.mfe_20_rate)}</td>
        <td>${num(qualityRow.mfe_20_lift, 2)}×</td>
        <td class="${tone(qualityRow.mean_return)}">${pct(qualityRow.mean_return)}</td></tr>`;
    }).join('');
    $('#second-entry-table').innerHTML = `<thead><tr>
      <th>样本</th><th>二次结构覆盖</th><th>有二次结构最大浮盈</th>
      <th>无二次结构最大浮盈</th><th>二次入场收益</th>
      <th>等待相对首次入场</th><th>优质规则浮盈≥20%</th>
      <th>浮盈命中提升</th><th>优质规则最终收益</th>
      </tr></thead><tbody>${secondRows || emptyRow(9)}</tbody>`;

    const exitLabels = {
      limit_streak2_break_after_1430: '连续两板后断板',
      failed_limit_after_1430: '涨停炸板未回封',
      trail_10_5: '浮盈10%后回撤5%',
      trail_15_5: '浮盈15%后回撤5%',
      price_volume_high15: '15日价量同步新高',
      price_volume_high20: '20日价量同步新高',
      fast_ema3_after_profit5: '浮盈5%后FAST下穿EMA3',
    };
    const exitRows = Object.entries(exitLabels).map(([key, label]) => {
      const cells = ['train', ...secondSplits.map(item => item[0])].map(
        split => secondExit.early_exit?.results?.[split]?.[key] || {});
      const heldout = cells[2];
      return `<tr><td>${esc(label)}</td>
        ${cells.map(cell => {
          const delta = Number(cell.candidate_mean_return)
            - Number(cell.baseline_mean_return);
          return `<td class="${tone(delta)}">${pct(delta)}</td>`;
        }).join('')}
        <td>${num(heldout.activated)}</td>
        <td>${key === secondExit.early_exit?.recent_shadow_candidate
          ? '近期影子候选' : '对照研究'}</td></tr>`;
    }).join('');
    $('#second-exit-status').textContent =
      exitAccepted ? '通过正式门槛' : '仅影子，不控制卖出';
    $('#second-exit-status').className =
      `status ${exitAccepted ? 'ok' : 'bad'}`;
    $('#profit-exit-table').innerHTML = `<thead><tr>
      <th>提前卖出规则</th><th>1-4月</th><th>5-6月</th>
      <th>7-8月</th><th>9月</th><th>7-8月触发</th><th>结论</th>
      </tr></thead><tbody>${exitRows || emptyRow(7)}</tbody>`;

    const v6Splits = [
      ['train', '1-4月训练'],
      ['validation', '5-6月验证'],
      ['heldout', '7-8月留出'],
      ['final_holdout', '9月最终留出'],
    ];
    const v6Rows = v6Splits.map(([key, label]) => {
      const base =
        v6Exit.results?.[key]?.raw_short_v6?.portfolio || {};
      const shadow =
        v6Exit.results?.[key]?.[v6Shadow]?.portfolio || {};
      const delta = Number(shadow.period_return)
        - Number(base.period_return);
      return `<tr><td>${esc(label)}</td>
        <td class="${tone(base.period_return)}">${pct(base.period_return)}</td>
        <td class="${tone(shadow.period_return)}">${pct(shadow.period_return)}</td>
        <td class="${tone(delta)}">${pct(delta)}</td>
        <td class="down">${pct(base.max_drawdown)}</td>
        <td class="down">${pct(shadow.max_drawdown)}</td>
        <td>${num(shadow.exit_reasons?.hard_stop)}</td>
        <td>${num(shadow.executed_entries)}</td></tr>`;
    });
    if (v6Shadow) {
      const delta = Number(v6ShadowFull.period_return)
        - Number(v6BaselineFull.period_return);
      v6Rows.push(`<tr><td>1-9月连续曲线</td>
        <td class="${tone(v6BaselineFull.period_return)}">${pct(v6BaselineFull.period_return)}</td>
        <td class="${tone(v6ShadowFull.period_return)}">${pct(v6ShadowFull.period_return)}</td>
        <td class="${tone(delta)}">${pct(delta)}</td>
        <td class="down">${pct(v6BaselineFull.max_drawdown)}</td>
        <td class="down">${pct(v6ShadowFull.max_drawdown)}</td>
        <td>${num(v6ShadowFull.exit_reasons?.hard_stop)}</td>
        <td>${num(v6ShadowFull.executed_entries)}</td></tr>`);
    }
    $('#v6-exit-status').textContent =
      v6Exit.selection?.accepted
        ? '通过，待前瞻确认' : '事后影子，不控制卖出';
    $('#v6-exit-status').className =
      `status ${v6Exit.selection?.accepted ? 'ok' : 'bad'}`;
    $('#v6-exit-table').innerHTML = `<thead><tr>
      <th>时间区间</th><th>原始空点收益</th><th>-3%止损影子</th>
      <th>收益增量</th><th>原始最大回撤</th><th>影子最大回撤</th>
      <th>止损触发</th><th>实际开仓</th>
      </tr></thead><tbody>${v6Rows.join('') || emptyRow(8)}</tbody>`;

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
      ['冻结选股策略',
        DATA.final_selection?.strategy?.operational_identity],
      ['选股信息截止',
        DATA.final_selection?.strategy?.information_end],
      ['收益回撤冻结',
        DATA.final_selection?.audit?.metrics_exactly_frozen
          ? '已锁定' : '异常'],
      ['全天风险门', DATA.research?.signal_quality?.entry_contract?.guard],
      ['全天风险门成交', DATA.research?.signal_quality?.entry_contract?.fill],
      ['收益模型控制买入',
        DATA.research?.signal_quality?.acceptance?.buy_control_passed
          ? '已通过' : '未通过，只展示研究结果'],
      ['优质多头影子风险门',
        DATA.research?.quality_selection?.method?.guard],
      ['优质多头影子排序',
        DATA.research?.quality_selection?.method?.score],
      ['优质多头控制买入',
        DATA.research?.quality_selection?.acceptance?.buy_control_passed
          ? '已通过' : '未通过，仅影子排名'],
      ['历史收益契约', DATA.history?.return_contract],
      ['实盘模拟契约', DATA.paper?.contract],
      ['分钟引擎', DATA.intraday_replay?.engine_version],
      ['触发价格口径', DATA.intraday_replay?.price_contract],
      ['个股图表', '前复权日K + 统一SuperMind历史1分钟归档（腾讯/新浪近期行情兜底）'],
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
      entry_price: '入场价格',
      opportunity_risk: '机会风险研究',
      signal_quality: '全天信号质量',
      quality_selection: '优质多头影子筛选',
      winner_shadow: '即时影子',
      candidate_history: 'v6历史机会',
      strategy_hub: 'V502主策略中心',
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
    resizeVisibleCharts();
  }

  function bind() {
    document.querySelectorAll('.view-tabs button').forEach(button =>
      button.addEventListener('click', () => activateView(button.dataset.view)));
    ['stock-search', 'stock-return-filter', 'stock-sort'].forEach(id =>
      document.getElementById(id).addEventListener('input', () => {
        stockPage = 1; renderStocks();
      }));
    $('#monthly-strategy').addEventListener('change', event => {
      monthlyStrategy = event.target.value;
      renderMonthlyOverview();
    });
    $('#daily-return-month').addEventListener('change', event => {
      dailyReturnMonth = event.target.value;
      renderDailyReturns();
    });
    $('#stock-prev').addEventListener('click', () => { stockPage -= 1; renderStocks(); });
    $('#stock-next').addEventListener('click', () => { stockPage += 1; renderStocks(); });
    [
      "selection-year", "selection-result", "selection-search",
    ].forEach(id => document.getElementById(id).addEventListener(
      "input", renderSelectionTable));
    $('#stock-daily-tab').addEventListener(
      'click', () => setStockMarketView('daily'));
    $('#stock-minute-tab').addEventListener(
      'click', () => setStockMarketView('minute'));
    $('#stock-minute-prev').addEventListener(
      'click', () => moveStockMinuteDate(-1));
    $('#stock-minute-next').addEventListener(
      'click', () => moveStockMinuteDate(1));
    $('#stock-minute-date').addEventListener(
      'change', event => openStockMinuteDate(event.target.value));
    $('#stock-dialog-close').addEventListener('click', () => $('#stock-dialog').close());
    $('#stock-dialog').addEventListener('close', () => {
      const instance = charts.get('stock-detail-chart');
      clearStockDailyPointer(instance, stockMarketState);
      stockMarketState = null;
      instance?.off('click');
      instance?.off('mouseover');
      instance?.off('mouseout');
    });
    $('#refresh').addEventListener('click', () => location.reload());
    window.addEventListener('resize', resizeVisibleCharts);
  }

  async function boot() {
    try {
      [DATA, PAPER] = await Promise.all([
        loadFirst(dataPaths('api/data', 'data.json')),
        loadFirst(dataPaths('api/paper', 'paper.json')),
      ]);
      if (
        !DATA.final_selection
        && !staticHost
      ) {
        DATA = await loadFirst([`data.json?t=${Date.now()}`]);
      }
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
