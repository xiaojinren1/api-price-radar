import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');

function loadCore() {
  const m = html.match(/\/\*CORE-START\*\/([\s\S]*?)\/\*CORE-END\*\//);
  assert.ok(m, 'index.html 里找不到 CORE 标记');
  return new Function(m[1] + '\n return CORE;')();
}
function loadDefaultState() {
  const i = html.indexOf('const DEFAULT_STATE = {');
  assert.ok(i > 0, '找不到 DEFAULT_STATE');
  const j = html.indexOf('\n};', i);
  const src = html.slice(i, j + 3);
  return new Function(src + '\n return DEFAULT_STATE;')();
}

const C = loadCore();
const STATE = loadDefaultState();
let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
};
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' 期望 ' + b + ' 实得 ' + a);

console.log('\n[1] 数字与币种解析');
t('parseNumber 各种脏写法', () => {
  assert.equal(C.parseNumber('$0.018'), 0.018);
  assert.equal(C.parseNumber('¥1.5'), 1.5);
  assert.equal(C.parseNumber('1,320'), 1320);
  assert.equal(C.parseNumber('0.0004元'), 0.0004);
  assert.equal(C.parseNumber('1.5e-3'), 0.0015);
  assert.equal(C.parseNumber(''), null);
  assert.equal(C.parseNumber('abc'), null);
});
t('detectCurrency', () => {
  assert.equal(C.detectCurrency('$0.3'), 'USD');
  assert.equal(C.detectCurrency('2元'), 'CNY');
  assert.equal(C.detectCurrency('0.15'), null);
});

console.log('\n[2] 单元格价格解析');
t('输入/输出 双价格', () => {
  const p = C.parsePriceCell('$0.018 / $0.072');
  assert.equal(p.miss, 0.018); assert.equal(p.out, 0.072); assert.equal(p.hit, null); assert.equal(p.currency, 'USD');
});
t('未命中/命中/输出 三价格', () => {
  const p = C.parsePriceCell('0.15/0.003/0.6');
  assert.equal(p.miss, 0.15); assert.equal(p.hit, 0.003); assert.equal(p.out, 0.6);
});
t('带中文标签的单格', () => {
  const p = C.parsePriceCell('输入 $0.018 输出 $0.072');
  assert.equal(p.miss, 0.018); assert.equal(p.out, 0.072);
});
t('人民币元价', () => {
  const p = C.parsePriceCell('2元 / 8元');
  assert.equal(p.miss, 2); assert.equal(p.out, 8); assert.equal(p.currency, 'CNY');
});

console.log('\n[3] 表格粘贴解析');
t('制表符 + 表头 + 平台名沿用', () => {
  const text = ['平台\t模型\t输入\t缓存\t输出\t备注',
    'allrouter.cc\tdeepseek-v4.1-flash\t0.15\t0.003\t0.6\t列表价',
    '\tdeepseek-v4-pro\t0.66\t0.022\t1.98\t第二个模型',
    '0-0.pro\tdeepseek-v4.1-flash-1017\t$0.018 / $0.072\t\t\t平铺'].join('\n');
  const r = C.parseTable(text);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[1].vendor, 'allrouter.cc', '空平台应沿用上一行');
  assert.equal(r.rows[1].model, 'deepseek-v4-pro');
  assert.equal(r.rows[2].off.miss, 0.018);
  assert.equal(r.rows[2].off.out, 0.072);
  assert.equal(r.rows[0].off.hit, 0.003);
});
t('Markdown 表格', () => {
  const text = ['| 平台 | 模型 | 输入 | 输出 |', '|---|---|---|---|', '| zeekai | deepseek-v4.1-flash | 0.15 | 0.6 |'].join('\n');
  const r = C.parseTable(text);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].vendor, 'zeekai');
  assert.equal(r.rows[0].off.miss, 0.15);
});

console.log('\n[4] 平台计费表达式 / 内嵌 JSON / ratio_config');
t('billing_expr 分峰谷', () => {
  const tiers = C.parseBillingExpr('workday && h>=9 ? tier("peak", p * 0.3 + cr * 0.006 + c * 1.2) : tier("off_peak", p * 0.15 + cr * 0.003 + c * 0.6)');
  assert.equal(tiers.peak.miss, 0.3);
  assert.equal(tiers.peak.hit, 0.006);
  assert.equal(tiers.off_peak.out, 0.6);
});
t('页面内嵌 JSON（0-0.pro 形态）', () => {
  const snippet = 'var x = [{"model":"deepseek-v4.1-flash-1017","discount":0.06,"inputUsdPerM":"0.018","outputUsdPerM":"0.072"}];';
  const r = C.extractFromText(snippet, { vendor: '0-0.pro' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].vendor, '0-0.pro');
  assert.equal(r.rows[0].off.miss, 0.018);
  assert.equal(r.rows[0].off.out, 0.072);
});
t('ratio_config（allrouter 形态）', () => {
  const json = JSON.stringify({ success: true, data: {
    model_ratio: { 'deepseek-v4.1-flash': 0.15 },
    completion_ratio: { 'deepseek-v4.1-flash': 4 },
    cache_ratio: { 'deepseek-v4.1-flash': 0.02 },
    billing_expr: { 'deepseek-v4.1-flash': 'x ? tier("peak", p * 0.3 + cr * 0.006 + c * 1.2) : tier("off_peak", p * 0.15 + cr * 0.003 + c * 0.6)' }
  }});
  const r = C.extractFromText(json, { vendor: 'allrouter.cc' });
  const q = r.rows.find((x) => x.model === 'deepseek-v4.1-flash');
  assert.ok(q, '应解析出 deepseek-v4.1-flash');
  assert.equal(q.off.miss, 0.15);
  assert.equal(q.peak.miss, 0.3);
  assert.equal(q.off.hit, 0.003);
});
t('HTML 表格兜底', () => {
  const htmlTable = '<table><tr><td>平台</td><td>模型</td><td>输入</td><td>输出</td></tr><tr><td>zeekai</td><td>deepseek-v4.1-flash</td><td>0.15</td><td>0.6</td></tr></table>';
  const r = C.extractFromText(htmlTable, {});
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].off.miss, 0.15);
});

console.log('\n[3b] CSV 文件形态（BOM / 引号 / 分号）');
t('带 BOM 的表头', () => {
  const r = C.parseTable('\uFEFF平台,模型,输入,输出\nx.cc,y-model,0.1,0.2');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].vendor, 'x.cc');
});
t('引号里带逗号的字段不被切开', () => {
  const parts = C.splitRow('a,"b,c",d', ',');
  assert.deepEqual(parts, ['a', 'b,c', 'd']);
});
t('CSV 引号字段参与解析', () => {
  const r = C.parseTable('平台,模型,输入,缓存,输出,备注\nallrouter.cc,ds,0.15,0.003,0.6,"带,逗号的备注"');
  assert.equal(r.rows[0].note, '带,逗号的备注');
  assert.equal(r.rows[0].off.hit, 0.003);
});
t('分号分隔（欧洲版 Excel）', () => {
  const r = C.parseTable('平台;模型;输入;输出\nx;y;0.1;0.2');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].off.miss, 0.1);
});
t('账单 CSV 带引号字段', () => {
  const r = C.parseBill('模型,输入,缓存,输出,扣费,备注\nds,1000000,0,0,0.15,"原价,未打折"');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].charge, 0.15);
});

console.log('\n[5] 归一化计费（与手算对表）');
const res = C.evaluate(STATE);
const row = (vendor, model) => res.rows.find((r) => r.vendorId === vendor && r.model === model);

t('0-0.pro 平铺价：¥0.012622/请求', () => {
  const r = row('v-00', 'deepseek-v4.1-flash-1017');
  close(r.costCNY, 0.012622, 1e-6, '0-0.pro');
  close(r.discount, 1.0259, 0.001, '0-0.pro 折扣');
});
t('allrouter 峰谷混合 ×0.4 倍率（高峰占比 0.6）', () => {
  const r = row('v-allrouter', 'deepseek-v4.1-flash');
  close(r.prices.miss, (0.15 * 0.4 + 0.3 * 0.6) * 0.4, 1e-9, '混合后未命中价');
  close(r.prices.hit, (0.003 * 0.4 + 0.006 * 0.6) * 0.4, 1e-12, '混合后命中价');
  close(r.prices.out, (0.6 * 0.4 + 1.2 * 0.6) * 0.4, 1e-9, '混合后输出价');
});
t('高峰占比 0 时 allrouter 命中档', () => {
  const s0 = JSON.parse(JSON.stringify(STATE)); s0.peakShare = 0;
  const r0 = C.evaluate(s0).rows.find((x) => x.vendorId === 'v-allrouter' && x.model === 'deepseek-v4.1-flash');
  close(r0.costCNY, 0.0032769, 1e-5, 'allrouter 空闲');
});
t('zeekai ¥1=$1 杠杆：¥0.000173/请求', () => {
  const s0 = JSON.parse(JSON.stringify(STATE)); s0.peakShare = 0;
  const z = C.evaluate(s0).rows.find((x) => x.vendorId === 'v-zeekai');
  close(z.costCNY, 0.00017307, 1e-8, 'zeekai');
  close(z.leverage, 1, 1e-12, '充值杠杆');
});
t('官方空闲档：¥0.007692/请求', () => {
  const s0 = JSON.parse(JSON.stringify(STATE)); s0.peakShare = 0;
  const o = C.evaluate(s0).rows.find((x) => x.vendorId === 'v-official');
  close(o.costCNY, 0.0076917, 1e-6, '官方空闲');
});
t('排序：每组最便宜在首位', () => {
  res.byModel.forEach((g) => {
    for (let i = 1; i < g.rows.length; i++) assert.ok(g.rows[i - 1].costCNY <= g.rows[i].costCNY);
  });
});

console.log('\n[6] 账单反推');
t('solveBilling 还原已知单价', () => {
  const truth = { miss: 0.06, hit: 0.0012, out: 0.24 };
  const mk = (miss, hit, out) => ({ miss, hit, out, charge: miss * truth.miss / 1e6 + hit * truth.hit / 1e6 + out * truth.out / 1e6 });
  const rows = [mk(553, 92928, 1320), mk(1200, 50000, 800), mk(300, 200000, 2000), mk(900, 10000, 500)];
  const s = C.solveBilling(rows);
  close(s.miss, 0.06, 1e-9, 'miss'); close(s.hit, 0.0012, 1e-9, 'hit'); close(s.out, 0.24, 1e-9, 'out');
  assert.ok(s.rms < 1e-12, '残差应接近 0');
});
t('analyzeBill：识别「缓存不打折」', () => {
  const charge = (a, b, c) => ((a + b) * 0.1278 + c * 0.5112) / 1e6;
  const csv = ['时间,模型,输入,缓存,输出,扣费',
    '2026-11-11 10:00,ds,553,92928,1320,' + charge(553, 92928, 1320),
    '2026-11-11 10:05,ds,800,120000,2000,' + charge(800, 120000, 2000),
    '2026-11-11 10:09,ds,300,50000,900,' + charge(300, 50000, 900)].join('\n');
  const a = C.analyzeBill(csv);
  assert.equal(a.summary.requests, 3);
  const g = a.groups[0];
  close(g.hit / g.miss, 1, 0.05, '命中价≈输入价');
  assert.ok(a.warnings.some((w) => w.indexOf('缓存') >= 0), '应给出缓存判定');
});
t('账单 CSV 直接切分档', () => {
  const csv = ['模型,输入,缓存,输出,扣费,档位',
    'ds,1000000,0,0,0.15,off', 'ds,500000,0,0,0.075,off',
    'ds,1000000,0,0,0.3,peak', 'ds,500000,0,0,0.15,peak'].join('\n');
  const a = C.analyzeBill(csv);
  const off = a.groups.find((g) => g.label.indexOf('off') >= 0);
  const peak = a.groups.find((g) => g.label.indexOf('peak') >= 0);
  assert.ok(off && peak, '应分档求解');
  close(off.miss, 0.15, 1e-6, 'off 单价');
  close(peak.miss, 0.3, 1e-6, 'peak 单价');
});

console.log('\n通过 ' + pass + ' 项' + (process.exitCode ? '（有失败）'
 + '（有失败）' : ''));
