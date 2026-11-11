#!/usr/bin/env node
/**
 * API 比价雷达 · 命令行助手（零依赖）
 *
 *   node tools/fetch-prices.mjs fetch <url> [--vendor 名称] [--out 文件] [--json]
 *   node tools/fetch-prices.mjs bill  <文件|-> [--currency USD|CNY]
 *
 * 复用 index.html 里的 CORE 逻辑（适配器：内嵌 JSON / ratio_config / HTML 表格 / 文本表格），
 * 因此命令行和网页端永远同一套算法。
 */
import fs from 'node:fs';
import dns from 'node:dns';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const coreSrc = html.match(/\/\*CORE-START\*\/([\s\S]*?)\/\*CORE-END\*\//);
if (!coreSrc) { console.error('找不到 CORE 段，index.html 被改坏了？'); process.exit(1); }
const CORE = new Function(coreSrc[1] + '\n return CORE;')();

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const rest = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[k] = next; i++; } else flags[k] = true;
  } else rest.push(a);
}

const toTSV = (rows) => {
  const head = ['平台', '模型', '输入', '缓存', '输出', '高峰输入', '高峰缓存', '高峰输出', '备注'];
  const body = rows.map((r) => [
    r.vendor || '', r.model,
    r.off.miss == null ? '' : r.off.miss,
    r.off.hit == null ? '' : r.off.hit,
    r.off.out == null ? '' : r.off.out,
    r.peak ? r.peak.miss : '', r.peak ? r.peak.hit : '', r.peak ? r.peak.out : '',
    r.note || ''
  ].join('\t'));
  return [head.join('\t')].concat(body).join('\n');
};

if (cmd === 'fetch') {
  const target = rest[0];
  if (!target) { console.error('用法: fetch <url> [--vendor 名称] [--out 文件] [--json]'); process.exit(1); }
  // 有些站在 undici 下会走 IPv6 超时，强制 IPv4 优先；再失败就用系统 curl 兜底
  try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
  let text = null;
  try {
    const resp = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 price-radar' }, redirect: 'follow' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
    text = await resp.text();
  } catch (e) {
    console.error('内置 fetch 失败（' + e.message + '），改用 curl 兜底…');
    try {
      text = execFileSync('curl', ['-sL', '--max-time', '40', '-A', 'Mozilla/5.0 price-radar', target], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e2) {
      console.error('curl 也失败: ' + e2.message);
      process.exit(2);
    }
  }
  if (!text || !text.trim()) { console.error('拿到空内容'); process.exit(2); }
  const vendor = flags.vendor || (() => { try { return new URL(target).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const result = CORE.extractFromText(text, { vendor });
  console.error('适配器：' + (result.kind || '未识别') + ' · 解析 ' + result.rows.length + ' 条' + (flags.group ? ' · 分组倍率 ' + flags.group : ''));
  result.warnings.forEach((w) => console.error('! ' + w));
  if (!result.rows.length) process.exit(3);

  const rows = result.rows.map((r) => Object.assign({}, r, { multiplier: flags.group ? Number(flags.group) : r.multiplier }));
  const out = flags.json
    ? JSON.stringify({ version: 1, fx: 7.1, peakShare: 0.6,
        workload: { miss: 553, hit: 92928, out: 1320 },
        refs: [],
        vendors: [{ id: 'v-' + vendor.replace(/[^a-z0-9]/gi, ''), name: vendor, currency: 'USD', cnyPerUnit: 7.1, multiplier: flags.group ? Number(flags.group) : 1, note: '由 ' + target + ' 抓取' }],
        quotes: rows.map((r, i) => ({ id: 'q' + i, vendorId: 'v-' + vendor.replace(/[^a-z0-9]/gi, ''), model: r.model, off: r.off, peak: r.peak || undefined, note: r.note })) }, null, 2)
    : toTSV(rows);

  if (flags.out) { fs.writeFileSync(flags.out, out, 'utf8'); console.error('已写入 ' + flags.out); }
  else console.log(out);
  process.exit(0);
}

if (cmd === 'bill') {
  const src = rest[0];
  if (!src) { console.error('用法: bill <文件|-> [--currency USD|CNY]'); process.exit(1); }
  const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const res = CORE.analyzeBill(text);
  res.warnings.forEach((w) => console.error('! ' + w));
  if (!res.summary) { console.error('没有可用数据'); process.exit(3); }
  const s = res.summary;
  console.log('请求数 ' + s.requests + ' · 扣费合计 ' + s.chargeSum.toFixed(6) + ' · 均值 ' + s.avgCharge.toFixed(6) + ' · 缓存占输入 ' + (s.cacheRatio * 100).toFixed(1) + '%');
  console.log('');
  console.log(['分组', '样本', '未命中/百万', '命中/百万', '输出/百万', '命中÷输入', '残差'].join('\t'));
  res.groups.forEach((g) => {
    const ratio = g.miss > 0 ? (g.hit / g.miss) : null;
    console.log([g.label, g.n, g.miss.toFixed(4), g.hit.toFixed(4), g.out.toFixed(4),
      ratio == null ? '-' : (ratio * 100).toFixed(1) + '%', g.rms.toExponential(2)].join('\t'));
  });
  process.exit(0);
}

console.error('用法:\n  node tools/fetch-prices.mjs fetch <url> [--vendor 名称] [--out 文件] [--json]\n  node tools/fetch-prices.mjs bill <文件|->');
process.exit(1);
