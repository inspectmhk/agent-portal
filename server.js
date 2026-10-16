#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SAMPLE_PATH = path.join(ROOT, 'data', 'sample-agent.json');
const SPECTORA_ORIGIN = 'https://connect.spectora.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png'
};

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://cdn.spectora.com https://quickchart.io; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Frame-Options': 'DENY'
});

function loadEnvFile(filePath = path.join(ROOT, '.env'), env = process.env) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid .env line for ${filePath}`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[match[1]] === undefined) env[match[1]] = value;
  }
}

function validatedHttpsUrl(value, name) {
  if (!value) return value;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} must be a valid HTTPS URL`);
  return url.href;
}

function validatedColor(value, name) {
  if (!value) return value;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} must be a six-digit hex color`);
  return value.toLowerCase();
}

function validatedAssetPath(value, name) {
  if (!value) return value;
  if (!/^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..')) {
    throw new Error(`${name} must be a local /assets/ path without traversal`);
  }
  return value;
}

function validatedPositiveDecimalId(value, name) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${name} must be a positive decimal identifier`);
  return text;
}

function createConfig(env = process.env) {
  const mode = env.PORTAL_MODE || 'demo';
  if (!['demo', 'live'].includes(mode)) throw new Error('PORTAL_MODE must be either demo or live');
  if (mode === 'live') {
    const missing = ['SPECTORA_API_KEY', 'SPECTORA_COMPANY_ID', 'PORTAL_SIGNING_SECRET'].filter(name => !env[name]);
    if (missing.length) throw new Error('Live mode requires SPECTORA_API_KEY, SPECTORA_COMPANY_ID, and PORTAL_SIGNING_SECRET');
    if (Buffer.byteLength(env.PORTAL_SIGNING_SECRET, 'utf8') < 32) throw new Error('PORTAL_SIGNING_SECRET must be at least 32 bytes');
    validatedPositiveDecimalId(env.SPECTORA_COMPANY_ID, 'SPECTORA_COMPANY_ID');
  }
  const port = Number(env.PORT || 3005);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return {
    mode,
    port,
    apiKey: env.SPECTORA_API_KEY || '',
    companyId: mode === 'live' ? validatedPositiveDecimalId(env.SPECTORA_COMPANY_ID, 'SPECTORA_COMPANY_ID') : '',
    signingSecret: env.PORTAL_SIGNING_SECRET || '',
    upstreamTimeoutMs: boundedInteger(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 30_000),
    upstreamMaxBytes: boundedInteger(env.UPSTREAM_MAX_BYTES, DEFAULT_MAX_BYTES, 1024, 5_000_000),
    rateLimitMax: boundedInteger(env.RATE_LIMIT_MAX, 60, 1, 1000),
    rateLimitWindowMs: boundedInteger(env.RATE_LIMIT_WINDOW_MS, 60_000, 1000, 3_600_000),
    branding: {
      appName: 'Agent Portal',
      name: 'Mertz Inspections',
      tagline: 'Engineering-Minded Inspections',
      license: '#NACHI23080842',
      phone: '785.370.3004',
      website: validatedHttpsUrl('https://www.inspectmhk.com', 'COMPANY_WEBSITE'),
      bookingUrl: validatedHttpsUrl('https://www.inspectmhk.com/schedule-now', 'BOOKING_URL'),
      whatsappUrl: '/',
      brand: {
        primary: validatedColor(env.BRAND_PRIMARY_COLOR || '#D4AF37', 'BRAND_PRIMARY_COLOR'),
        accentText: validatedColor(env.BRAND_ACCENT_TEXT_COLOR || '#C8A251', 'BRAND_ACCENT_TEXT_COLOR'),
        ink: validatedColor(env.BRAND_INK_COLOR || '#FFFFFF', 'BRAND_INK_COLOR'),
        muted: validatedColor(env.BRAND_MUTED_COLOR || '#A0A0A8', 'BRAND_MUTED_COLOR'),
        surface: validatedColor(env.BRAND_SURFACE_COLOR || '#1A1A1E', 'BRAND_SURFACE_COLOR'),
        background: validatedColor(env.BRAND_BACKGROUND_COLOR || '#0B0B0B', 'BRAND_BACKGROUND_COLOR'),
        border: validatedColor(env.BRAND_BORDER_COLOR || '#2A2A30', 'BRAND_BORDER_COLOR'),
        success: validatedColor(env.BRAND_SUCCESS_COLOR || '#22C55E', 'BRAND_SUCCESS_COLOR'),
        focus: validatedColor(env.BRAND_FOCUS_COLOR || '#2563EB', 'BRAND_FOCUS_COLOR')
      }
    },
    demoAgent: {
      firstName: env.DEMO_AGENT_FIRST_NAME,
      lastName: env.DEMO_AGENT_LAST_NAME,
      agency: env.DEMO_AGENT_AGENCY,
      city: env.DEMO_AGENT_CITY,
      state: env.DEMO_AGENT_STATE,
      photoUrl: validatedAssetPath(env.DEMO_AGENT_PHOTO_PATH, 'DEMO_AGENT_PHOTO_PATH')
    },
    demoTier: {
      label: env.DEMO_TIER_LABEL
    }
  };
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Configuration value must be an integer from ${min} to ${max}`);
  return number;
}

function authError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

class UpstreamHttpError extends Error {
  constructor(upstreamStatus) {
    super(`Spectora API returned ${upstreamStatus}`);
    this.name = 'UpstreamHttpError';
    this.upstreamStatus = upstreamStatus;
  }
}

function signGrantPayload(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function createGrant(connectionId, secret, options = {}) {
  const validatedConnectionId = validatedPositiveDecimalId(connectionId, 'Spectora connection ID');
  if (Buffer.byteLength(secret || '', 'utf8') < 32) throw new Error('A signing secret of at least 32 bytes is required');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  
  // Default to 24 hours (86,400s). For 30 days, use 2592000.
  const ttlSeconds = options.ttlSeconds ?? 86400; 
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 2592000) {
    throw new Error('Grant TTL must be between 1 and 2592000 seconds');
  }

  const payload = Buffer.from(JSON.stringify({ v: 1, connectionId: validatedConnectionId, exp: now + ttlSeconds })).toString('base64url');
  return `${payload}.${signGrantPayload(payload, secret)}`;
}

function verifyGrant(grant, requestedConnectionId, secret, options = {}) {
  const fail = () => { throw authError('Invalid or expired portal grant'); };
  validatedPositiveDecimalId(requestedConnectionId, 'Spectora connection ID');
  if (typeof grant !== 'string') fail();
  const [payloadPart, signaturePart, extra] = grant.split('.');
  if (!payloadPart || !signaturePart || extra) fail();
  const expected = Buffer.from(signGrantPayload(payloadPart, secret));
  const supplied = Buffer.from(signaturePart);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) fail();
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')); } catch { fail(); }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (payload.v !== 1 || !/^[1-9][0-9]*$/.test(payload.connectionId) || !Number.isSafeInteger(payload.exp) || payload.exp <= now) fail();
  if (payload.connectionId !== requestedConnectionId) throw authError('Portal grant is not valid for this connection', 403);
  return payload;
}

function readSampleAgent() {
  return JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8'));
}

function applyCustomization(sample, branding, demoAgent, demoTier) {
  const company = { ...sample.company, brand: { ...sample.company.brand } };
  for (const [key, value] of Object.entries(branding)) {
    if (key === 'brand') {
      for (const [color, colorValue] of Object.entries(value)) if (colorValue) company.brand[color] = colorValue;
    } else if (value) {
      company[key] = value;
    }
  }
  const agent = { ...sample.agent };
  for (const [key, value] of Object.entries(demoAgent)) if (value) agent[key] = value;
  const tier = { ...sample.tier };
  for (const [key, value] of Object.entries(demoTier)) if (value) tier[key] = value;
  return { ...sample, company, agent, tier };
}

function headers(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function sendJson(res, status, payload) {
  res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
  res.end(JSON.stringify(payload));
}

function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  return match?.[1];
}

function assertCompanyScope(records, scope) {
  const expectedId = String(scope);
  for (const record of records) {
    const attrCompanyId = record?.attributes?.company_id != null ? String(record.attributes.company_id) : null;
    const relCompanyId = record?.relationships?.company?.data?.id != null ? String(record.relationships.company.data.id) : null;
    const actualId = attrCompanyId || relCompanyId;

    // Only strictly check if a company identifier is present on the record
    if (actualId && actualId !== expectedId) {
      throw authError('Upstream company scope mismatch', 403);
    }
  }
}

function assertRecordId(record, expectedId, label) {
  if (!record || String(record.id ?? '') !== expectedId) throw authError(`Upstream ${label} identifier mismatch`, 403);
}

function relationshipId(record, name, expectedType, allowNull = false) {
  const relationship = record?.relationships?.[name];
  if (!relationship || !Object.hasOwn(relationship, 'data')) throw authError(`Upstream ${name} relationship missing`, 403);
  if (relationship.data === null && allowNull) return null;
  if (!relationship.data || Array.isArray(relationship.data) || typeof relationship.data !== 'object') {
    throw authError(`Upstream ${name} relationship ambiguous`, 403);
  }
  const { id, type } = relationship.data;
  if (type !== expectedType) throw authError(`Upstream ${name} relationship type mismatch`, 403);
  if (typeof id !== 'string' || id === '') throw authError(`Upstream ${name} relationship identifier missing`, 403);
  return id;
}

function assertInspectionScope(records, companyId, connectionId) {
  for (const record of records) {
    if (Object.hasOwn(record?.attributes || {}, 'company_id') && record.attributes.company_id !== companyId) {
      throw authError('Upstream inspection company attribute mismatch', 403);
    }
    if (relationshipId(record, 'company', 'company') !== companyId) {
      throw authError('Upstream inspection company scope mismatch', 403);
    }
    // Spectora returns valid agent inspections based on query filters; connection IDs 
    // inside the relationship payload can differ from agent/contact portal IDs.
  }
}

function mapInspection(insp, included = []) {
  const attrs = (insp && insp.attributes) || {};
  let formattedDate = '';

  if (attrs.datetime) {
    const cleanDatetime = String(attrs.datetime).replace(/[\u2010-\u2015]/g, '-').trim();
    const parsed = new Date(cleanDatetime);
    if (!isNaN(parsed.getTime())) {
      formattedDate = parsed.toISOString().slice(0, 10);
    } else {
      formattedDate = cleanDatetime.slice(0, 10);
    }
  }

  // Get custom field IDs linked directly to this inspection
  const relFieldData = insp?.relationships?.custom_fields?.data || [];
  const linkedIds = new Set(
    Array.isArray(relFieldData) ? relFieldData.map(item => String(item.id)) : []
  );

  let isFinished = false;
  let foundFinishedField = false;
  let subcontractorSchedule = '';

  if (Array.isArray(included) && included.length > 0) {
    for (const item of included) {
      if (!item || item.type !== 'custom_field') continue;

      const itemId = String(item.id || '');
      // Match if this item ID is in the inspection's relationship list OR if linkedIds is unpopulated
      if (linkedIds.size > 0 && !linkedIds.has(itemId)) continue;

      const itemAttrs = item.attributes || {};
      const tplId = Number(itemAttrs.custom_field_template_id);
      const identifier = String(itemAttrs.identifier || '').toLowerCase();
      const name = String(itemAttrs.name || '').toLowerCase();

      // Finished Field Check
      if (
        tplId === 47540 ||
        identifier === 'finished' ||
        name === 'finished'
      ) {
        foundFinishedField = true;
        const val = itemAttrs.value;
        isFinished = val === '1' || val === 1 || val === true || val === 'true';
      }

      // Subcontractor Schedule Check (Template 54966)
      if (
        tplId === 54966 ||
        identifier === 'subcontractorschedule' ||
        name === 'subcontractor schedule'
      ) {
        if (itemAttrs.value) {
          subcontractorSchedule = String(itemAttrs.value).trim();
        }
      }
    }
  }

  if (!foundFinishedField) {
    isFinished = Boolean(attrs.published_at);
  }

  return {
    id: insp.id,
    date: formattedDate,
    rawDatetime: attrs.datetime || null,
    durationHours: Number(attrs.duration || 2),
    location: attrs.property_address || attrs.full_address || 'Location withheld',
    services: [attrs.service_names, attrs.service_add_on_names].filter(Boolean).join(' + '),
    inspector: attrs.inspector_name || '',
    status: attrs.canceled_at ? 'Canceled' : (attrs.published_at ? 'Report Published' : 'Scheduled'),
    published: Boolean(attrs.published_at),
    finished: isFinished,
    subcontractorSchedule: subcontractorSchedule
  };
}

function readUpstreamJson(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let exceeded = false;
    response.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        exceeded = true;
        reject(new Error('Spectora API response exceeded size limit'));
        response.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    response.on('end', () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Spectora API returned malformed JSON')); }
    });
    response.on('error', reject);
  });
}

function createHttpsUpstream(config, transport = https) {
  return endpoint => new Promise((resolve, reject) => {
    const url = new URL(endpoint, SPECTORA_ORIGIN);
    if (url.origin !== SPECTORA_ORIGIN) return reject(new Error('Unapproved upstream origin'));
    const request = transport.get(url, {
      headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
      timeout: config.upstreamTimeoutMs
    }, response => {
      if (response.statusCode < 200 || response.statusCode > 299) {
        response.resume();
        reject(new UpstreamHttpError(response.statusCode));
        return;
      }
      readUpstreamJson(response, config.upstreamMaxBytes).then(resolve, reject);
    });
    request.on('timeout', () => request.destroy(new Error('Spectora API timeout')));
    request.on('error', reject);
  });
}

function query(pathname, filters) {
  const params = new URLSearchParams(filters);
  return `${pathname}?${params.toString().replace(/%5B/g, '[').replace(/%5D/g, ']')}`;
}

function createRateLimiter(config, nowMs) {
  const buckets = new Map();
  return key => {
    const now = nowMs();
    if (buckets.size > 10_000) {
      for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
      if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + config.rateLimitWindowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    return bucket.count <= config.rateLimitMax;
  };
}

function loadStaticSnapshot(publicDir) {
  const rootStat = fs.lstatSync(publicDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Public root must be a real directory');
  const publicReal = fs.realpathSync(publicDir);
  const files = new Map();

  function visit(directory, relativeDirectory = '') {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const relative = path.join(relativeDirectory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Public tree contains a symlink or non-regular entry: ${relative}`);
      const real = fs.realpathSync(absolute);
      const containment = path.relative(publicReal, real);
      if (containment.startsWith('..') || path.isAbsolute(containment)) throw new Error(`Public tree entry escapes its root: ${relative}`);
      if (stat.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Public tree contains a symlink or non-regular entry: ${relative}`);
      const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error(`Public tree entry changed during startup: ${relative}`);
        }
        const key = `/${relative.split(path.sep).join('/')}`;
        const ext = path.extname(relative);
        files.set(key, Object.freeze({
          body: fs.readFileSync(descriptor),
          contentType: MIME_TYPES[ext] || 'application/octet-stream',
          cacheControl: ext === '.html' ? 'no-cache' : 'public, max-age=86400'
        }));
      } finally {
        fs.closeSync(descriptor);
      }
    }
  }

  visit(publicDir);
  return files;
}

function mapPublicStatusInspection(data, included) {
  if (!data) return null;
  const attrs = data.attributes || {};

  const rawDt = attrs.datetime || attrs.scheduled_at || attrs.date;
  let timeRangeFormatted = 'TBD';
  let badgeMonth = 'OCT';
  let badgeDay = '23';

  if (rawDt) {
    const dt = new Date(rawDt);
    if (!isNaN(dt.getTime())) {
      badgeMonth = dt.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
      badgeDay = dt.getDate();

      const startStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const endDt = new Date(dt.getTime() + 2 * 60 * 60 * 1000);
      const endStr = endDt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

      timeRangeFormatted = `${startStr} – ${endStr}`;
    }
  }

  // 1. Extract Finished Custom Field & Subcontractor Schedule
  let isFinished = false;
  let subSchedule = null;

  if (Array.isArray(included)) {
    for (const item of included) {
      if (item.type !== 'custom_field') continue;
      const a = item.attributes || {};
      const tplId = Number(a.custom_field_template_id);
      const name = String(a.name || '').toLowerCase();
      const identifier = String(a.identifier || '').toLowerCase();

      // Check Finished Field (Template 47540)
      if (tplId === 47540 || name === 'finished' || identifier === 'finished') {
        const val = a.value;
        isFinished = val === '1' || val === 1 || val === true || val === 'true';
      }

      // Check Subcontractor Schedule Field (Template 54966)
      if (tplId === 54966 || name === 'subcontractor schedule' || identifier === 'subcontractorschedule') {
        subSchedule = a.value || a.text_value;
      }
    }
  }

  // 2. Derive Live Overall Status
  let overallStatus = 'UPCOMING';
  const now = new Date();
  const inspDt = rawDt ? new Date(rawDt) : null;

  if (isFinished) {
    overallStatus = 'COMPLETE';
  } else if (inspDt && !isNaN(inspDt.getTime()) && now >= inspDt) {
    overallStatus = 'IN PROGRESS';
  } else {
    overallStatus = 'UPCOMING';
  }

  // Join primary service names and add-on service names explicitly
  const primaryServices = attrs.service_names || '';
  const addOnServices = attrs.service_add_on_names || '';
  const fullServices = [primaryServices, addOnServices].filter(Boolean).join(' + ');

  return {
    location: attrs.property_address || attrs.address || 'Inspection Property',
    services: fullServices || attrs.service_names || 'Home Inspection',
    timeRangeFormatted,
    badgeMonth,
    badgeDay,
    overallStatus,
    subcontractorSchedule: subSchedule
  };
}

function renderPublicStatusHtml(data, branding, currentUrl = '') {
  if (!data) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Inspection Not Found | ${branding.name}</title>
  <link rel="stylesheet" href="/status.css">
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
  <link rel="manifest" href="/site.webmanifest">
</head>
<body class="status-body">
  <div class="status-portal-shell">
    
    <div class="status-header">
      <div class="status-brand-left">
        <img src="/assets/M300.png" alt="${branding.name}" class="status-logo">
        <div>
          <div class="status-brand-title">${branding.name}</div>
          <div class="status-brand-sub">Engineering-Minded Inspections</div>
        </div>
      </div>
      <div class="status-pill">INSPECTION STATUS</div>
    </div>

    <div class="status-card">
      <div class="status-card-header">
        <div class="status-address-group">
          <div class="status-address">Inspection Schedule Not Found</div>
          <div class="status-services">The requested inspection link may be invalid or expired.</div>
        </div>
      </div>
    </div>

    <div class="status-footer">
      Questions? Contact ${branding.name} at ${branding.phone}
    </div>

  </div>
</body>
</html>`;
  }

  // Parse Subcontractor Schedule string
  const subItems = [];
  if (data.subcontractorSchedule) {
    const rawItems = data.subcontractorSchedule.split(/;|\n/).map(s => s.trim()).filter(Boolean);
    for (const item of rawItems) {
      const colonIdx = item.indexOf(':');
      if (colonIdx !== -1) {
        subItems.push({
          service: item.slice(0, colonIdx).trim(),
          scheduleStr: item.slice(colonIdx + 1).trim()
        });
      } else {
        subItems.push({ service: 'Subcontractor', scheduleStr: item });
      }
    }
  }

  const rowsHtml = [
    `<div class="status-row">
      <span class="status-dot"></span>
      <span class="status-label">Main Inspection:</span>
      <span class="status-val">${data.timeRangeFormatted}</span>
    </div>`
  ];

  for (const sub of subItems) {
    const valLower = sub.scheduleStr.toLowerCase();
    let valClass = 'status-val';
    if (valLower.includes('pending')) valClass = 'status-val-pending';
    else if (valLower.includes('complete')) valClass = 'status-val-complete';

    rowsHtml.push(`
      <div class="status-row">
        <span class="status-dot"></span>
        <span class="status-label">${sub.service}:</span>
        <span class="${valClass}">${sub.scheduleStr}</span>
      </div>
    `);
  }

  const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(currentUrl)}&size=150&margin=1&dark=D4AF37&light=0B0B0B`;

  const qrSectionHtml = `
    <div class="status-qr-container">
      <img src="${qrUrl}" alt="Scan to share inspection status" class="status-qr-img" width="120" height="120">
      <div class="status-qr-text">
        <div class="status-qr-title">Scan to Share Status</div>
        <div class="status-qr-sub">Provides live updates for Clients & Agents</div>
      </div>
    </div>
  `;

  let themeClass = 'status-theme-upcoming';
  if (data.overallStatus === 'IN PROGRESS') themeClass = 'status-theme-progress';
  else if (data.overallStatus === 'COMPLETE') themeClass = 'status-theme-complete';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Inspection Status: ${data.location} | ${branding.name}</title>
  <link rel="stylesheet" href="/status.css?1">
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/apple-touch-icon.png">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/assets/favicon-16x16.png">
  <link rel="manifest" href="/site.webmanifest">
</head>
<body class="status-body">
  <div class="status-portal-shell">
    
    <div class="status-header">
      <div class="status-brand-left">
        <img src="/assets/M300.png" alt="${branding.name}" class="status-logo">
        <div>
          <div class="status-brand-title">${branding.name}</div>
          <div class="status-brand-sub">Engineering-Minded Inspections</div>
        </div>
      </div>
      <button type="button" id="statusShareBtn" class="status-share-btn" aria-label="Share status page">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
          <polyline points="16 6 12 2 8 6"></polyline>
          <line x1="12" y1="2" x2="12" y2="15"></line>
        </svg>
      </button>
    </div>

    <div class="status-card">
      <div class="status-card-header">
        <div class="status-date-badge">
          <div class="status-date-month">${data.badgeMonth}</div>
          <div class="status-date-day">${data.badgeDay}</div>
        </div>
        <div class="status-address-group">
          <div class="status-address">${data.location}</div>
          <div class="status-pill ${themeClass}">
            <span class="status-pill-dot"></span>${data.overallStatus}
          </div>
          <div class="status-services">${data.services}</div>
        </div>
      </div>

      <div class="status-divider"></div>
      ${rowsHtml.join('')}
      <div class="status-divider"></div>
      ${qrSectionHtml}
    </div>

    <div class="status-footer">
      Questions? Contact ${branding.name} at ${branding.phone}
    </div>

  </div>
  <script src="/status.js" defer></script>
</body>
</html>`;
}

function createPortal(options = {}) {
  const config = createConfig(options.env || process.env);
  const staticFiles = loadStaticSnapshot(options.publicDir || PUBLIC_DIR);
  const nowSeconds = options.now || (() => Math.floor(Date.now() / 1000));
  const nowMs = options.nowMs || Date.now;
  const upstreamGet = options.upstreamGet || createHttpsUpstream(config);
  const log = options.log || (entry => process.stdout.write(`${JSON.stringify(entry)}\n`));
  const allowRequest = createRateLimiter(config, nowMs);

  async function getAgentPayload(connectionId) {
    const sample = applyCustomization(readSampleAgent(), config.branding, config.demoAgent, config.demoTier);
    if (config.mode === 'demo') return { ...sample, meta: { mode: 'demo' } };
    const scope = config.companyId;
    let connections;
    try {
      connections = await upstreamGet(`/v2/connections/${encodeURIComponent(connectionId)}`);
    } catch (error) {
      if (error instanceof UpstreamHttpError && error.upstreamStatus === 404) return null;
      throw error;
    }
    const connection = connections.data;
    assertRecordId(connection, connectionId, 'connection');
    assertCompanyScope([connection], scope);
    
    const stats = await upstreamGet(query('/v2/connection_stats', {
      'filter[id]': connectionId, 'page[size]': '1'
    }));
    if (!Array.isArray(stats.data)) throw authError('Upstream stats data missing', 403);

    const statRecord = stats.data[0] || {
      id: connectionId,
      type: 'connection_stat',
      attributes: {
        company_id: Number(scope),
        buying_inspections_count: 0,
        selling_inspections_count: 0,
        total_inspections_count: 0,
        first_inspection_date: null,
        last_inspection_date: null
      }
    };

    if (stats.data.length > 0) {
      assertRecordId(statRecord, connectionId, 'stats');
      assertCompanyScope([statRecord], scope);
    }
    
    const inspections = await upstreamGet(query('/v2/inspections', {
      'filter[connection_id]': connectionId, include: 'buying_agent,selling_agent,company,custom_fields', sort: '-datetime', 'page[size]': '50'
    }));
    if (!Array.isArray(inspections.data)) throw authError('Upstream inspections data missing', 403);
    assertInspectionScope(inspections.data, scope, connectionId);
    const attrs = connection.attributes || {};
    const statAttrs = statRecord.attributes || {};
    
    return {
      meta: { mode: 'live' },
      company: sample.company,
      agent: {
        firstName: attrs.first_name || '',
        lastName: attrs.last_name || '',
        agency: attrs.agency_name || '',
        city: attrs.city || '',
        state: attrs.state || '',
        photoUrl: attrs.image || attrs.thumb || sample.agent.photoUrl
      },
      stats: {
        totalInspections: Number(statAttrs.total_inspections_count || attrs.total_inspections_count || 0),
        buyingInspections: Number(statAttrs.buying_inspections_count || 0),
        sellingInspections: Number(statAttrs.selling_inspections_count || 0),
        firstInspection: statAttrs.first_inspection_date ? String(statAttrs.first_inspection_date).replace(/[\u2010-\u2015]/g, '-').slice(0, 10) : null,
        lastInspection: statAttrs.last_inspection_date ? String(statAttrs.last_inspection_date).replace(/[\u2010-\u2015]/g, '-').slice(0, 10) : null,
        overallCount: Number(statAttrs.overall_inspections_count || 0)
      },
      tier: sample.tier,
      inspections: (inspections.data || []).map(insp => mapInspection(insp, inspections.included || []))
    };
  }

  function sendStatic(res, pathname) {
    const requested = pathname === '/' || pathname.startsWith('/agent/') ? '/index.html' : pathname;
    let decoded;
    try { decoded = decodeURIComponent(requested); } catch { sendJson(res, 400, { error: 'Malformed URL' }); return; }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    const file = staticFiles.get(path.posix.normalize(decoded));
    if (!file) { sendJson(res, 404, { error: 'Not found' }); return; }
    res.writeHead(200, headers({
      'Content-Type': file.contentType,
      'Cache-Control': file.cacheControl
    }));
    res.end(file.body);
  }

  async function getPublicInspectionBySlug(slug, upstreamGet) {
    if (!slug || typeof slug !== 'string' || slug.length < 10) return null;

    try {
      // Query direct inspection endpoint: /v2/inspections/:slug
      const endpoint = query(`/v2/inspections/${slug}`, {
        'include': 'custom_fields'
      });

      const response = await upstreamGet(endpoint);
      
      // Direct endpoint returns the single object in response.data (or response.data[0])
      const inspection = Array.isArray(response.data) ? response.data[0] : response.data;
      if (!inspection) return null;

      return mapPublicStatusInspection(inspection, response.included || []);
    } catch (err) {
      return null;
    }
  }

  async function handleRequest(req, res) {
    const startedAt = nowMs();
    let pathname = '<malformed>';
    let status = 500;
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { sendJson(res, 400, { error: 'Malformed URL' }); status = 400; return; }
      pathname = url.pathname;

      const host = String(req.headers.host || '').toLowerCase();
      const isStatusSubdomain = host.startsWith('status.');
      const slugMatch = pathname.match(/^\/(?:status\/)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);

      // 1. PUBLIC STATUS ROUTE (status.inspectmhk.com or /status/:slug or /:slug)
      if (req.method === 'GET' && (isStatusSubdomain || slugMatch)) {
        const slug = slugMatch ? slugMatch[1] : pathname.slice(1).replace(/^status\//, '');
        
        if (slug) {
          const proto = req.headers['x-forwarded-proto'] || 'https';
          const currentUrl = `${proto}://${host}/${slug}`;

          const data = await getPublicInspectionBySlug(slug, upstreamGet);
          const html = renderPublicStatusHtml(data, config.branding, currentUrl);
          status = data ? 200 : 404;
          res.writeHead(status, headers({
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=60'
          }));
          res.end(html);
          return;
        }
      }

      // 2. HEALTH CHECK ROUTE
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { status: 'ok', service: 'spectora-agent-portal', mode: config.mode }); status = 200; return;
      }

      // 3. AGENT PORTAL API ROUTE
      if (req.method === 'GET' && pathname.startsWith('/api/agent/')) {
        const connectionId = pathname.slice('/api/agent/'.length).split('/')[0];
        if (!connectionId) { sendJson(res, 400, { error: 'Missing connection ID' }); status = 400; return; }
        if (config.mode === 'live') {
          let grant;
          try {
            validatedPositiveDecimalId(connectionId, 'Spectora connection ID');
            grant = bearerToken(req);
            verifyGrant(grant, connectionId, config.signingSecret, { now: nowSeconds() });
          }
          catch (error) { status = error.statusCode || 401; sendJson(res, status, { error: error.message }); return; }
          const key = crypto.createHash('sha256').update(`${grant}:${connectionId}`).digest('hex');
          if (!allowRequest(key)) { sendJson(res, 429, { error: 'Rate limit exceeded' }); status = 429; return; }
        }
        const payload = await getAgentPayload(connectionId);
        if (!payload) { sendJson(res, 404, { error: 'Agent not found' }); status = 404; return; }
        sendJson(res, 200, payload); status = 200; return;
      }

      // 4. STATIC FILES & SINGLE PAGE APP ROUTE
      if (req.method === 'GET') { sendStatic(res, pathname); status = res.statusCode || res.status || 200; return; }
      sendJson(res, 405, { error: 'Method not allowed' }); status = 405;
    } catch (error) {
      status = Number(error.statusCode) || 500;
      if (!res.headersSent) sendJson(res, status, { error: error.message || 'Internal server error' });
      else res.destroy?.();
    } finally {
      const route = pathname === '/api/health'
        ? '/api/health'
        : (pathname.startsWith('/api/agent/')
            ? '/api/agent/:id'
            : (pathname.startsWith('/agent/') ? '/agent/:id' : '/:static-or-not-found'));
      log({ method: req.method, route, status, durationMs: Math.max(0, nowMs() - startedAt) });
    }
  }

  return { config, handleRequest, getAgentPayload };
}

function createServer(portal) {
  const server = http.createServer((req, res) => {
    Promise.resolve(portal.handleRequest(req, res)).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      else res.destroy();
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

loadEnvFile();
const defaultPortal = createPortal({ log: () => {} });

if (require.main === module) {
  const portal = createPortal();
  const server = createServer(portal);
  server.listen(portal.config.port, () => console.log(`Agent Portal running at http://localhost:${portal.config.port} (${portal.config.mode} mode)`));
}

module.exports = {
  SECURITY_HEADERS,
  SPECTORA_ORIGIN,
  UpstreamHttpError,
  createConfig,
  createGrant,
  verifyGrant,
  createHttpsUpstream,
  readUpstreamJson,
  createPortal,
  createServer,
  handleRequest: defaultPortal.handleRequest,
  readSampleAgent,
  mapInspection,
  loadEnvFile
};
