const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = __dirname;
const DEFAULT_DATA_FILE = path.join(ROOT, 'data', 'records.json');
const CSV_FIELDS = [
  'testerName',
  'phone',
  'manualLocation',
  'latitude',
  'longitude',
  'locationAccuracy',
  'locationAddress',
  'locationProvider',
  'locationError',
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
  'clientIp',
  'ispName',
  'ipAsn',
  'ipCountry',
  'ipRegion',
  'ipCity',
  'networkEffectiveType',
  'networkDownlink',
  'networkRtt',
  'networkType',
  'networkSaveData',
  'carrier',
  'networkClass',
  'notes',
  'createdAt',
  'updatedAt',
];

function createApp(options = {}) {
  const dataFile = options.dataFile || DEFAULT_DATA_FILE;

  return http.createServer((req, res) => {
    const start = Date.now();
    let logged = false;
    const logOnce = () => {
      if (logged) return;
      logged = true;
      writeAccessLog(req, res, Date.now() - start);
    };
    res.on('finish', logOnce);
    res.on('close', logOnce);
    routeRequest(req, res, { dataFile }).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: '服务器内部错误', detail: error.message });
      } else {
        try { res.end(); } catch (e) { /* socket already closed */ }
      }
    });
  });
}

async function routeRequest(req, res, context) {
  const { dataFile } = context;
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/records' && req.method === 'GET') {
    const page = clampNumber(url.searchParams.get('page'), 1, 100000, 1);
    const pageSize = clampNumber(url.searchParams.get('pageSize'), 1, 200, 20);
    const all = await readRecords(dataFile);
    const filtered = filterRecords(all, url.searchParams);
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const records = filtered.slice(start, start + pageSize);
    sendJson(res, 200, { records, total, page, pageSize });
    return;
  }

  if (pathname === '/api/records' && req.method === 'POST') {
    const body = await readBody(req);
    const payload = parseJson(body);
    const record = normalizeRecord(payload);
    const records = await readRecords(dataFile);
    records.unshift(record);
    await writeRecords(dataFile, records);
    logRecordEvent(req, 'create', record);
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
    logRecordEvent(req, 'update', records[index]);
    sendJson(res, 200, { record: records[index] });
    return;
  }

  if (recordMatch && req.method === 'DELETE') {
    const records = await readRecords(dataFile);
    const deletedRecord = records.find((record) => record.id === recordMatch[1]) || null;
    const nextRecords = records.filter((record) => record.id !== recordMatch[1]);
    await writeRecords(dataFile, nextRecords);
    logRecordEvent(req, 'delete', deletedRecord);
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
    normalized.forEach((record) => logRecordEvent(req, 'create', record));
    sendJson(res, 200, { imported: normalized.length });
    return;
  }

  if (pathname === '/api/network-info' && req.method === 'GET') {
    const ip = clientIpFor(req).replace(/^::ffff:/, '');
    const result = await lookupNetworkInfo(ip);
    sendJson(res, 200, { ip, ...result });
    return;
  }

  if (pathname === '/api/dns-check' && req.method === 'GET') {
    const domain = clean(url.searchParams.get('domain')).toLowerCase();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      sendJson(res, 400, { error: '域名格式不正确' });
      return;
    }
    const result = await resolveDomain(domain);
    sendJson(res, 200, { domain, ...result });
    return;
  }

  if (pathname === '/api/access/summary' && req.method === 'GET') {
    const days = clampNumber(url.searchParams.get('days'), 1, 365, 30);
    const page = clampNumber(url.searchParams.get('page'), 1, 10000, 1);
    const pageSize = clampNumber(url.searchParams.get('pageSize'), 1, 200, 30);
    const summary = await buildAccessSummary(days, { page, pageSize });
    sendJson(res, 200, summary);
    return;
  }

  if (pathname === '/api/records-events' && req.method === 'GET') {
    const days = clampNumber(url.searchParams.get('days'), 1, 365, 7);
    const page = clampNumber(url.searchParams.get('page'), 1, 10000, 1);
    const pageSize = clampNumber(url.searchParams.get('pageSize'), 1, 200, 30);
    const result = await buildRecordEventsLog({ days, page, pageSize });
    sendJson(res, 200, result);
    return;
  }

  if (pathname === '/api/reverse-geocode' && req.method === 'GET') {
    const lat = clean(url.searchParams.get('lat'));
    const lng = clean(url.searchParams.get('lng'));
    const key = clean(process.env.AMAP_KEY);
    if (!key) {
      sendJson(res, 503, { configured: false, error: 'AMAP_KEY 未配置' });
      return;
    }
    if (!isCoordinate(lat, 90) || !isCoordinate(lng, 180)) {
      sendJson(res, 400, { configured: true, error: '经纬度格式不正确' });
      return;
    }
    const result = await reverseGeocodeWithAmap({ lat, lng, key });
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  await serveStatic(pathname, res);
}

function isCoordinate(value, maxAbs) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maxAbs;
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function clientIpFor(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  const xReal = req.headers['x-real-ip'];
  if (xReal) return String(xReal).trim();
  return req.socket.remoteAddress || '';
}

const ACCESS_LOG_PREFIX = 'access-';
const ACCESS_LOG_EXT = '.jsonl';
const NETWORK_INFO_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const NETWORK_INFO_CACHE_MAX = 500;
const networkInfoCache = new Map(); // ip -> { result, expiresAt }

let accessLogStream = null;
let accessLogDate = '';

function getAccessLogStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== accessLogDate || !accessLogStream) {
    if (accessLogStream) {
      try { accessLogStream.end(); } catch (e) { /* ignore */ }
    }
    accessLogDate = today;
    accessLogStream = fs.createWriteStream(
      path.join(ROOT, 'data', `${ACCESS_LOG_PREFIX}${today}${ACCESS_LOG_EXT}`),
      { flags: 'a' },
    );
    accessLogStream.on('error', (error) => {
      console.error('access log write error', error.message);
    });
  }
  return accessLogStream;
}

const RECORD_EVENT_PREFIX = 'records-events-';
const RECORD_EVENT_EXT = '.jsonl';
let recordEventStream = null;
let recordEventDate = '';

function getRecordEventStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== recordEventDate || !recordEventStream) {
    if (recordEventStream) {
      try { recordEventStream.end(); } catch (e) { /* ignore */ }
    }
    recordEventDate = today;
    recordEventStream = fs.createWriteStream(
      path.join(ROOT, 'data', `${RECORD_EVENT_PREFIX}${today}${RECORD_EVENT_EXT}`),
      { flags: 'a' },
    );
    recordEventStream.on('error', (error) => {
      console.error('record event log write error', error.message);
    });
  }
  return recordEventStream;
}

function logRecordEvent(req, event, record) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const entry = {
      ts: new Date().toISOString(),
      event,
      ip: clientIpFor(req).replace(/^::ffff:/, ''),
      recordId: record && record.id ? record.id : null,
      snapshot: record || null,
    };
    const filename = path.join(ROOT, 'data', `${RECORD_EVENT_PREFIX}${today}${RECORD_EVENT_EXT}`);
    fs.appendFileSync(filename, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('record event log error', err.message);
  }
}

function writeAccessLog(req, res, durationMs) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: String(req.url || '').split('?')[0],
      status: res.statusCode,
      durationMs,
      ip: clientIpFor(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
    };
    const stream = getAccessLogStream();
    stream.write(JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('access log error', err.message);
  }
}

async function buildAccessSummary(days, { page = 1, pageSize = 30 } = {}) {
  const dataDir = path.join(ROOT, 'data');
  let files;
  try {
    files = await fsPromises.readdir(dataDir);
  } catch (err) {
    return { days: 0, total: 0, requestedDays: days, page, pageSize, daily: [] };
  }
  const cutoff = Date.now() - (days - 1) * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);

  const dailyMap = new Map();
  for (const name of files) {
    if (!name.startsWith(ACCESS_LOG_PREFIX) || !name.endsWith(ACCESS_LOG_EXT)) continue;
    const date = name.slice(ACCESS_LOG_PREFIX.length, -ACCESS_LOG_EXT.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoffDate) continue;
    let text;
    try {
      text = await fsPromises.readFile(path.join(dataDir, name), 'utf8');
    } catch (err) {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch (err) {
        continue;
      }
      const day = (entry.ts || '').slice(0, 10);
      if (day !== date) continue;
      let bucket = dailyMap.get(day);
      if (!bucket) {
        bucket = {
          date: day,
          total: 0,
          success2xx: 0,
          success3xx: 0,
          clientErrors: 0,
          serverErrors: 0,
          ips: new Set(),
          latencies: [],
          statusCounts: {},
          methodCounts: {},
          pathCounts: {},
        };
        dailyMap.set(day, bucket);
      }
      bucket.total += 1;
      const status = Number(entry.status) || 0;
      bucket.statusCounts[status] = (bucket.statusCounts[status] || 0) + 1;
      if (status >= 200 && status < 300) bucket.success2xx += 1;
      else if (status >= 300 && status < 400) bucket.success3xx += 1;
      else if (status >= 400 && status < 500) bucket.clientErrors += 1;
      else if (status >= 500) bucket.serverErrors += 1;
      if (entry.ip) bucket.ips.add(entry.ip);
      if (Number.isFinite(entry.durationMs)) bucket.latencies.push(entry.durationMs);
      const m = entry.method || 'GET';
      bucket.methodCounts[m] = (bucket.methodCounts[m] || 0) + 1;
      const p = entry.path || '';
      if (p) bucket.pathCounts[p] = (bucket.pathCounts[p] || 0) + 1;
    }
  }

  const sortedDaily = [...dailyMap.values()].sort((a, b) => b.date.localeCompare(a.date));
  const total = sortedDaily.length;
  const totalRequests = sortedDaily.reduce((s, d) => s + d.total, 0);
  const latest = sortedDaily[0] || null;
  const summary = {
    totalRequests,
    latestDate: latest ? latest.date : null,
    latestTotal: latest ? latest.total : 0,
    latestUniqueIps: latest ? latest.uniqueIps : 0,
    latestAvgLatencyMs: latest ? latest.averageLatencyMs : 0,
    latestErrorRate: latest ? latest.errorRate : 0,
  };
  const start = (page - 1) * pageSize;
  const paged = sortedDaily.slice(start, start + pageSize);
  const daily = paged.map((b) => {
    const latencies = b.latencies.sort((x, y) => x - y);
    const errors = b.serverErrors + b.clientErrors;
    const errorRate = b.total ? errors / b.total : 0;
    const topPaths = Object.entries(b.pathCounts)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([p, n]) => ({ path: p, count: n }));
    return {
      date: b.date,
      total: b.total,
      success2xx: b.success2xx,
      success3xx: b.success3xx,
      clientErrors: b.clientErrors,
      serverErrors: b.serverErrors,
      errorRate: Math.round(errorRate * 10000) / 10000,
      uniqueIps: b.ips.size,
      averageLatencyMs: latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0,
      p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0,
      maxLatencyMs: latencies.length ? latencies[latencies.length - 1] : 0,
      statusCounts: b.statusCounts,
      methodCounts: b.methodCounts,
      topPaths,
    };
  });

  return { days: paged.length, total: total, totalRequests, summary, requestedDays: days, page, pageSize, daily: paged };
}

async function buildRecordEventsLog({ days, page, pageSize }) {
  const dataDir = path.join(ROOT, 'data');
  let files = [];
  try {
    files = await fsPromises.readdir(dataDir);
  } catch (err) {
    return { total: 0, page, pageSize, days, events: [] };
  }
  const cutoff = Date.now() - (days - 1) * 86400000;
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);

  const allEvents = [];
  for (const name of files) {
    if (!name.startsWith(RECORD_EVENT_PREFIX) || !name.endsWith(RECORD_EVENT_EXT)) continue;
    const date = name.slice(RECORD_EVENT_PREFIX.length, -RECORD_EVENT_EXT.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoffDate) continue;
    let text;
    try {
      text = await fsPromises.readFile(path.join(dataDir, name), 'utf8');
    } catch (err) {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry.ts && entry.ts.slice(0, 10) === date) {
          allEvents.push(entry);
        }
      } catch (err) {
        // skip malformed lines
      }
    }
  }

  allEvents.sort((a, b) => b.ts.localeCompare(a.ts));
  const total = allEvents.length;
  const start = (page - 1) * pageSize;
  const events = allEvents.slice(start, start + pageSize);

  return { total, page, pageSize, days, events };
}

async function resolveDomain(domain) {
  const start = Date.now();
  return new Promise((resolve) => {
    dns.resolve4(domain, (err, addresses) => {
      const durationMs = Date.now() - start;
      if (err) {
        resolve({ ok: false, durationMs, error: err.code || err.message });
        return;
      }
      resolve({ ok: true, durationMs, ips: addresses });
    });
  });
}

async function lookupNetworkInfo(ip) {
  // 跳过本地 / 私有 IP — 反查无意义，也不进缓存
  if (!ip || ip === '127.0.0.1' || ip === '::1' || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    return { configured: false, error: '内网 IP，不参与反查' };
  }

  const cached = networkInfoCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const url = new URL(`https://ipwho.is/${encodeURIComponent(ip)}`);
  url.searchParams.set('fields', 'connection.isp,connection.org,connection.asn,country.name,region.name,city.name');
  const result = await new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: 4000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data || data.success === false) {
            resolve({ configured: true, error: (data && data.message) || '反查服务未返回有效结果' });
            return;
          }
          const conn = data.connection || {};
          const pickName = (v) => (v && typeof v === 'object' ? (v.name || '') : (v || ''));
          resolve({
            configured: true,
            ispName: conn.org || conn.isp || '',
            ipAsn: conn.asn ? String(conn.asn) : '',
            ipCountry: pickName(data.country),
            ipRegion: pickName(data.region),
            ipCity: pickName(data.city),
          });
        } catch (error) {
          resolve({ configured: true, error: `反查响应解析失败：${error.message}` });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      resolve({ configured: true, error: `反查请求失败：${error.message}` });
    });
    req.end();
  });

  // 只缓存成功结果（避免反复命中失败键）
  if (!result.error) {
    networkInfoCache.set(ip, { result, expiresAt: Date.now() + NETWORK_INFO_CACHE_TTL_MS });
    if (networkInfoCache.size > NETWORK_INFO_CACHE_MAX) {
      const now = Date.now();
      for (const [key, val] of networkInfoCache) {
        if (val.expiresAt <= now) networkInfoCache.delete(key);
      }
    }
  }
  return result;
}

function reverseGeocodeWithAmap({ lat, lng, key }) {
  const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
  url.searchParams.set('key', key);
  url.searchParams.set('location', `${lng},${lat}`);
  url.searchParams.set('extensions', 'base');
  url.searchParams.set('radius', '1000');
  url.searchParams.set('output', 'json');

  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.status !== '1') {
            resolve({
              ok: false,
              configured: true,
              error: data.info || '高德逆地理解析失败',
              rawStatus: data.status,
            });
            return;
          }
          const component = data.regeocode?.addressComponent || {};
          resolve({
            ok: true,
            configured: true,
            address: data.regeocode?.formatted_address || '',
            province: component.province || '',
            city: Array.isArray(component.city) ? '' : component.city || '',
            district: component.district || '',
          });
        } catch (error) {
          resolve({ ok: false, configured: true, error: error.message });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      resolve({ ok: false, configured: true, error: error.message });
    });
    req.end();
  });
}


async function readRecords(dataFile) {
  try {
    const raw = await fsPromises.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeRecords(dataFile, records) {
  await fsPromises.mkdir(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.tmp`;
  await fsPromises.writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await fsPromises.rename(tempFile, dataFile);
}

function normalizeRecord(payload) {
  const now = new Date().toISOString();
  return {
    id: payload.id || crypto.randomUUID(),
    testerName: clean(payload.testerName),
    phone: clean(payload.phone),
    manualLocation: clean(payload.manualLocation),
    latitude: clean(payload.latitude),
    longitude: clean(payload.longitude),
    locationAccuracy: clean(payload.locationAccuracy),
    locationAddress: clean(payload.locationAddress),
    locationProvider: clean(payload.locationProvider),
    locationError: clean(payload.locationError),
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
    clientIp: clean(payload.clientIp),
    ispName: clean(payload.ispName),
    ipAsn: clean(payload.ipAsn),
    ipCountry: clean(payload.ipCountry),
    ipRegion: clean(payload.ipRegion),
    ipCity: clean(payload.ipCity),
    networkEffectiveType: clean(payload.networkEffectiveType),
    networkDownlink: clean(payload.networkDownlink),
    networkRtt: clean(payload.networkRtt),
    networkType: clean(payload.networkType),
    networkSaveData: clean(payload.networkSaveData),
    carrier: clean(payload.carrier),
    networkClass: clean(payload.networkClass),
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
    const content = await fsPromises.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const type = ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.json'
        ? 'application/json; charset=utf-8'
        : 'application/octet-stream';
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
