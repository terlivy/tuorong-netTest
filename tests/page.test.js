const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');

test('mobile page delays network diagnostics until submit', async () => {
  const html = await fs.readFile('test.html', 'utf8');

  assert.equal(html.includes('<h2>自动采集信息</h2>'), false);
  assert.match(html, /<section[^>]*id="diagnostics-section"[^>]*hidden/);
  assert.match(html, /<h2>网络诊断结果<\/h2>/);

  const loadHandler = html.match(/window\.addEventListener\('load', \(\) => \{([\s\S]*?)\n    \}\);/);
  assert.ok(loadHandler);
  assert.equal(loadHandler[1].includes('testConnect('), false);
});

test('mobile page alerts based on target site connectivity after submit', async () => {
  const html = await fs.readFile('test.html', 'utf8');

  assert.match(html, /const \[[\s\S]*targetResult[\s\S]*\] = await Promise\.all/);
  assert.match(html, /targetResult\.ok/);
  assert.match(html, /alert\('成功/);
  assert.match(html, /alert\('已记录问题，技术服务会加急处理/);
});

test('mobile page keeps technical diagnosis fields in admin only', async () => {
  const html = await fs.readFile('test.html', 'utf8');

  assert.equal(html.includes('id="login-result"'), false);
  assert.equal(html.includes('id="issue"'), false);
  assert.equal(html.includes('id="notes"'), false);
  assert.equal(html.includes('for="login-result"'), false);
  assert.equal(html.includes('for="issue"'), false);
  assert.equal(html.includes('for="notes"'), false);
  assert.match(html, /reportData\.loginResult = targetResult\.ok \? 'success' : 'failed'/);
  assert.match(html, /reportData\.status = targetResult\.ok \? 'resolved' : 'open'/);
});
