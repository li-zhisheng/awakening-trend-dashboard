'use strict';

let DATA = null;
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
      <tr><td>${row.day}</td><td><strong>${escapeHtml(row.name)}</strong><small>${row.code}</small></td>
      <td>${row.candidate_rank}/${row.basket_size}</td>
      <td><span class="badge ${row.candidate_status}">${statusLabels[row.candidate_status] || row.candidate_status}</span></td>
      <td class="${tone(row.confirmation_return)}">${pct(row.confirmation_return)}</td>
      <td>¥${Number(row.entry_price).toFixed(2)}</td>
      <td>${row.exit_day} ${String(row.exit_clock).padStart(4, '0')}</td>
      <td>${row.hold_days}日</td><td class="${tone(row.net_return)}">${pct(row.net_return)}</td></tr>`).join('')}</tbody>`;
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
  $('#refresh').addEventListener('click', () => location.reload());
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
