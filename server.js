const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = __dirname;
const DEFAULT_DATA_FILE = path.join(ROOT, 'data', 'records.json');
const CSV_FIELDS = [
  'testerName',
  'phone',
  'brand',
  'model',
  'os',
  'browser',
  'status',
  'loginResult',
  'issue',
  'solution',
  'networkSummary',
  'targetUrl',
  'userAgent',
  'screen',
  'language',
  'timezone',
  'notes',
  'createdAt',
  'updatedAt',
];

function createApp(options = {}) {
  const dataFile = options.dataFile || DEFAULT_DATA_FILE;
  const allowedLoadHosts = options.allowedLoadHosts || getAllowedLoadHosts();

  return http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, { dataFile, allowedLoadHosts });
    } catch (error) {
      sendJson(res, 500, { error: '服务器内部错误', detail: error.message });
    }
  });
}

async function routeRequest(req, res, context) {
  const { dataFile, allowedLoadHosts } = context;
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/records' && req.method === 'GET') {
    const records = await readRecords(dataFile);
    sendJson(res, 200, { records: filterRecords(records, url.searchParams) });
    return;
  }

  if (pathname === '/api/records' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJson(body);
    const record = normalizeRecord(payload);
    const records = await readRecords(dataFile);
    records.unshift(record);
    await writeRecords(dataFile, records);
    sendJson(res, 201, { record });
    return;
  }

  const recordMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
  if (recordMatch && req.method === 'PUT') {
    const body = await readBody(req);
    const patch = parseJson(body);
    const records = await readRecords(dataFile);
    const index = records.findIndex((record) => record.id === recordMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { error: '记录不存在' });
      return;
    }
    records[index] = normalizePatch(records[index], patch);
    await writeRecords(dataFile, records);
    sendJson(res, 200, { record: records[index] });
    return;
  }

  if (recordMatch && req.method === 'DELETE') {
    const records = await readRecords(dataFile);
    const nextRecords = records.filter((record) => record.id !== recordMatch[1]);
    await writeRecords(dataFile, nextRecords);
    sendJson(res, 200, { deleted: records.length - nextRecords.length });
    return;
  }

  if (pathname === '/api/records/export' && req.method === 'GET') {
    const records = await readRecords(dataFile);
    sendText(res, 200, recordsToCsv(records), 'text/csv; charset=utf-8', {
      'content-disposition': 'attachment; filename="phone-test-records.csv"',
    });
    return;
  }

  if (pathname === '/api/records/import' && req.method === 'POST') {
    const csv = await readBody(req);
    const importedRecords = csvToRecords(csv);
    const records = await readRecords(dataFile);
    const now = new Date().toISOString();
    const normalized = importedRecords.map((record) =>
      normalizeRecord({
        ...record,
        createdAt: record.createdAt || now,
        updatedAt: record.updatedAt || now,
      }),
    );
    await writeRecords(dataFile, [...normalized, ...records]);
    sendJson(res, 200, { imported: normalized.length });
    return;
  }

  if (pathname === '/api/load-test' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJson(body);
    const target = normalizeTargetUrl(payload.target);
    if (!target.ok) {
      sendJson(res, 400, { error: target.error });
      return;
    }
    if (!allowedLoadHosts.has(target.url.hostname)) {
      sendJson(res, 403, {
        error: `目标 ${target.url.hostname} 不在允许压测名单中`,
        allowedHosts: [...allowedLoadHosts],
      });
      return;
    }

    const result = await runLoadTest({
      targetUrl: target.url,
      serverInfo: clean(payload.serverInfo),
      durationSeconds: clampNumber(payload.durationSeconds, 1, 60, 10),
      concurrency: clampNumber(payload.concurrency, 1, 50, 5),
      timeoutMs: 5000,
    });
    sendJson(res, 200, result);
    return;
  }

  if (pathname === '/api/concurrency-test' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJson(body);
    const target = normalizeTargetUrl(payload.target);
    if (!target.ok) {
      sendJson(res, 400, { error: target.error });
      return;
    }
    if (!allowedLoadHosts.has(target.url.hostname)) {
      sendJson(res, 403, {
        error: `目标 ${target.url.hostname} 不在允许压测名单中`,
        allowedHosts: [...allowedLoadHosts],
      });
      return;
    }

    const result = await runConcurrencyTest({
      targetUrl: target.url,
      serverInfo: clean(payload.serverInfo),
      totalRequests: clampNumber(payload.totalRequests, 1, 1000, 100),
      concurrency: clampNumber(payload.concurrency, 1, 100, 10),
      timeoutMs: 5000,
    });
    sendJson(res, 200, result);
    return;
  }

  await serveStatic(pathname, res);
}

function getAllowedLoadHosts() {
  const configured = clean(process.env.LOAD_TEST_ALLOWED_HOSTS);
  const hosts = configured ? configured.split(',') : ['42.192.109.248', '127.0.0.1', 'localhost'];
  return new Set(hosts.map((host) => host.trim()).filter(Boolean));
}

function normalizeTargetUrl(value) {
  const raw = clean(value);
  if (!raw) return { ok: false, error: '请填写压测目标 IP 或 URL' };

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { ok: false, error: '压测目标只支持 HTTP 或 HTTPS' };
    }
    if (!url.pathname) url.pathname = '/';
    return { ok: true, url };
  } catch {
    return { ok: false, error: '压测目标格式不正确' };
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

async function runLoadTest({ targetUrl, serverInfo, durationSeconds, concurrency, timeoutMs }) {
  const startedAtMs = Date.now();
  const deadline = startedAtMs + durationSeconds * 1000;
  const samples = [];
  const statusCounts = {};
  const errorCounts = {};

  async function worker() {
    while (Date.now() < deadline) {
      const result = await requestOnce(targetUrl, timeoutMs);
      samples.push(result);
      if (result.statusCode) {
        const key = String(result.statusCode);
        statusCounts[key] = (statusCounts[key] || 0) + 1;
      }
      if (result.error) {
        errorCounts[result.error] = (errorCounts[result.error] || 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const endedAtMs = Date.now();
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const totalRequests = samples.length;
  const successfulRequests = samples.filter((sample) => sample.ok).length;
  const failedRequests = totalRequests - successfulRequests;
  const elapsedSeconds = Math.max((endedAtMs - startedAtMs) / 1000, 0.001);

  return {
    mode: 'duration-load-test',
    target: {
      url: targetUrl.toString(),
      host: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'),
      path: `${targetUrl.pathname}${targetUrl.search}`,
    },
    serverInfo,
    limits: { durationSeconds, concurrency, timeoutMs },
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    summary: {
      totalRequests,
      successfulRequests,
      failedRequests,
      requestsPerSecond: round(totalRequests / elapsedSeconds),
      averageLatencyMs: round(average(latencies)),
      minLatencyMs: latencies[0] || 0,
      maxLatencyMs: latencies[latencies.length - 1] || 0,
      p95LatencyMs: percentile(latencies, 0.95),
      statusCounts,
      errorCounts,
    },
  };
}

async function runConcurrencyTest({ targetUrl, serverInfo, totalRequests, concurrency, timeoutMs }) {
  const startedAtMs = Date.now();
  const samples = [];
  const statusCounts = {};
  const errorCounts = {};
  let issuedRequests = 0;

  async function worker() {
    while (issuedRequests < totalRequests) {
      issuedRequests += 1;
      const result = await requestOnce(targetUrl, timeoutMs);
      samples.push(result);
      if (result.statusCode) {
        const key = String(result.statusCode);
        statusCounts[key] = (statusCounts[key] || 0) + 1;
      }
      if (result.error) {
        errorCounts[result.error] = (errorCounts[result.error] || 0) + 1;
      }
    }
  }

  const workerCount = Math.min(concurrency, totalRequests);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const endedAtMs = Date.now();
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const successfulRequests = samples.filter((sample) => sample.ok).length;
  const failedRequests = samples.length - successfulRequests;
  const elapsedMs = Math.max(endedAtMs - startedAtMs, 1);

  return {
    mode: 'fixed-request-concurrency',
    target: {
      url: targetUrl.toString(),
      host: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80'),
      path: `${targetUrl.pathname}${targetUrl.search}`,
    },
    serverInfo,
    limits: { totalRequests, concurrency: workerCount, timeoutMs },
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    summary: {
      totalRequests: samples.length,
      successfulRequests,
      failedRequests,
      elapsedMs,
      requestsPerSecond: round(samples.length / (elapsedMs / 1000)),
      averageLatencyMs: round(average(latencies)),
      minLatencyMs: latencies[0] || 0,
      maxLatencyMs: latencies[latencies.length - 1] || 0,
      p95LatencyMs: percentile(latencies, 0.95),
      statusCounts,
      errorCounts,
    },
  };
}

function requestOnce(targetUrl, timeoutMs) {
  const startedAt = Date.now();
  const client = targetUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = client.request(
      targetUrl,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'user-agent': 'phone-test-collector-load-test/1.0',
          connection: 'close',
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          const latencyMs = Date.now() - startedAt;
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 500,
            statusCode: response.statusCode,
            latencyMs,
          });
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      resolve({
        ok: false,
        error: error.message || 'request_error',
        latencyMs: Date.now() - startedAt,
      });
    });
    req.end();
  });
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return values[index];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function readRecords(dataFile) {
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeRecords(dataFile, records) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fs.rename(tempFile, dataFile);
}

function normalizeRecord(payload) {
  const now = new Date().toISOString();
  return {
    id: payload.id || crypto.randomUUID(),
    testerName: clean(payload.testerName),
    phone: clean(payload.phone),
    brand: clean(payload.brand),
    model: clean(payload.model),
    os: clean(payload.os),
    browser: clean(payload.browser),
    status: clean(payload.status) || 'open',
    loginResult: clean(payload.loginResult),
    issue: clean(payload.issue),
    solution: clean(payload.solution),
    networkSummary: clean(payload.networkSummary),
    targetUrl: clean(payload.targetUrl),
    userAgent: clean(payload.userAgent),
    screen: clean(payload.screen),
    language: clean(payload.language),
    timezone: clean(payload.timezone),
    notes: clean(payload.notes),
    diagnostics: payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {},
    createdAt: clean(payload.createdAt) || now,
    updatedAt: clean(payload.updatedAt) || now,
  };
}

function normalizePatch(record, patch) {
  const allowed = new Set([...CSV_FIELDS, 'diagnostics']);
  const next = { ...record };
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key) || key === 'createdAt') continue;
    next[key] = key === 'diagnostics' && typeof value === 'object' ? value : clean(value);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

function filterRecords(records, params) {
  const query = clean(params.get('query')).toLowerCase();
  const status = clean(params.get('status')).toLowerCase();
  const brand = clean(params.get('brand')).toLowerCase();
  const os = clean(params.get('os')).toLowerCase();
  const browser = clean(params.get('browser')).toLowerCase();

  return records.filter((record) => {
    const text = Object.values(record)
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    return (
      (!query || text.includes(query)) &&
      (!status || clean(record.status).toLowerCase() === status) &&
      (!brand || clean(record.brand).toLowerCase().includes(brand)) &&
      (!os || clean(record.os).toLowerCase().includes(os)) &&
      (!browser || clean(record.browser).toLowerCase().includes(browser))
    );
  });
}

function recordsToCsv(records) {
  const lines = [CSV_FIELDS.join(',')];
  for (const record of records) {
    lines.push(CSV_FIELDS.map((field) => csvEscape(record[field])).join(','));
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

function csvToRecords(csv) {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ''));
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => clean(header));
  return rows.slice(1).filter((row) => row.some(Boolean)).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index] || '';
    });
    return record;
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted && char === '"' && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvEscape(value) {
  const text = clean(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function parseJson(body) {
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return {};
  }
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) throw new Error('请求体过大');
  }
  return body;
}

async function serveStatic(pathname, res) {
  const publicPath = pathname === '/' ? '/test.html' : pathname === '/admin' ? '/admin.html' : pathname;
  const resolved = path.normalize(path.join(ROOT, publicPath));
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendText(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }

  try {
    const content = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return;
    }
    throw error;
  }
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function sendText(res, status, text, contentType, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': contentType, ...extraHeaders });
  res.end(text);
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 80);
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`Phone test collector listening on http://0.0.0.0:${port}`);
  });
}
