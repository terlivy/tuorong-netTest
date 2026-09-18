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
