const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApp } = require('../server');

async function startTestServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-records-'));
  const dataFile = path.join(dir, 'records.json');
  const server = createApp({ dataFile });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('records can be created, queried, and updated', async () => {
  const app = await startTestServer();
  try {
    const createdResponse = await fetch(`${app.baseUrl}/api/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: '13800138000',
        brand: 'Huawei',
        os: 'Android',
        browser: 'Huawei Browser',
        issue: '验证码加载失败',
        loginResult: 'failed',
        solution: '',
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.record.phone, '13800138000');
    assert.ok(created.record.id);

    const listResponse = await fetch(`${app.baseUrl}/api/records?query=验证码&brand=Huawei`);
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json();
    assert.equal(list.records.length, 1);
    assert.equal(list.records[0].issue, '验证码加载失败');

    const updateResponse = await fetch(`${app.baseUrl}/api/records/${created.record.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'resolved',
        solution: '改用 Chrome 后可以登录',
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = await updateResponse.json();
    assert.equal(updated.record.status, 'resolved');
    assert.equal(updated.record.solution, '改用 Chrome 后可以登录');
  } finally {
    await app.close();
  }
});

test('records can be exported and imported as csv', async () => {
  const app = await startTestServer();
  try {
    await fetch(`${app.baseUrl}/api/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: '13900139000',
        brand: 'iPhone',
        os: 'iOS',
        browser: 'Safari',
        issue: '页面空白',
        status: 'open',
      }),
    });

    const exportResponse = await fetch(`${app.baseUrl}/api/records/export`);
    assert.equal(exportResponse.status, 200);
    const csv = await exportResponse.text();
    assert.match(csv, /phone,brand,model,os,browser,status,loginResult,issue,solution/);
    assert.match(csv, /13900139000/);

    const importResponse = await fetch(`${app.baseUrl}/api/records/import`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv' },
      body: 'phone,brand,os,browser,status,issue,solution\n13700137000,Vivo,Android,Vivo Browser,resolved,无法打开,切换网络',
    });
    assert.equal(importResponse.status, 200);
    const imported = await importResponse.json();
    assert.equal(imported.imported, 1);

    const listResponse = await fetch(`${app.baseUrl}/api/records?query=13700137000`);
    const list = await listResponse.json();
    assert.equal(list.records.length, 1);
    assert.equal(list.records[0].solution, '切换网络');
  } finally {
    await app.close();
  }
});

test('load test endpoint measures an allowed target', async () => {
  const target = await new Promise((resolve) => {
    const server = require('node:http').createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const { port } = target.address();
  const app = await startTestServer();

  try {
    const response = await fetch(`${app.baseUrl}/api/load-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: `http://127.0.0.1:${port}/health`,
        serverInfo: 'test target',
        durationSeconds: 1,
        concurrency: 2,
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.target.host, '127.0.0.1');
    assert.equal(result.serverInfo, 'test target');
    assert.ok(result.summary.totalRequests > 0);
    assert.ok(result.summary.requestsPerSecond > 0);
    assert.ok(result.summary.averageLatencyMs >= 0);
    assert.equal(result.summary.statusCounts['200'] > 0, true);
  } finally {
    await app.close();
    await new Promise((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
  }
});

test('load test endpoint rejects targets outside the allowed host list', async () => {
  const app = await startTestServer();
  try {
    const response = await fetch(`${app.baseUrl}/api/load-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'http://203.0.113.10/',
        durationSeconds: 1,
        concurrency: 1,
      }),
    });
    assert.equal(response.status, 403);
    const result = await response.json();
    assert.match(result.error, /不在允许压测名单/);
  } finally {
    await app.close();
  }
});

test('concurrency test endpoint runs a fixed request count', async () => {
  const target = await new Promise((resolve) => {
    const server = require('node:http').createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, 5);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const { port } = target.address();
  const app = await startTestServer();

  try {
    const response = await fetch(`${app.baseUrl}/api/concurrency-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: `http://127.0.0.1:${port}/api`,
        serverInfo: 'fixed concurrency target',
        totalRequests: 12,
        concurrency: 4,
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.mode, 'fixed-request-concurrency');
    assert.equal(result.summary.totalRequests, 12);
    assert.equal(result.summary.successfulRequests, 12);
    assert.ok(result.summary.elapsedMs >= 0);
    assert.ok(result.summary.requestsPerSecond > 0);
    assert.equal(result.limits.concurrency, 4);
  } finally {
    await app.close();
    await new Promise((resolve, reject) => target.close((error) => (error ? reject(error) : resolve())));
  }
});
