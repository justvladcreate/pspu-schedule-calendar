/**
 * Cloudflare Worker: push-уведомления об изменениях расписания ПГГПУ.
 *
 * Что делает:
 *   1. Хранит push-подписки и настройки (группы/преподаватели) в KV.
 *   2. По cron читает data/index.json, находит факультеты с новой
 *      версией и сравнивает data/faculties/<id>/data.json с
 *      data/faculties/<id>/old_data.json.
 *   3. Рассылает Web Push только тем, кто подписан на затронутые
 *      группы/преподавателей. Факультет не важен: подписка хранит
 *      только названия групп и ФИО.
 *
 * Обязательные биндинги (Settings → Variables and Secrets):
 *   PUSH_KV            — KV namespace
 *   VAPID_PRIVATE_KEY  — secret, base64url (32 байта, из generate-vapid-keys)
 *   VAPID_PUBLIC_KEY   — переменная, base64url (65 байт, uncompressed P-256)
 *   VAPID_SUBJECT      — переменная, например mailto:you@example.com
 *
 * Необязательные переменные:
 *   SITE_URL             — https://justvladcreate.github.io/pspu-schedule-calendar/
 *   SCHEDULE_INDEX_URL   — .../data/index.json
 *   SCHEDULE_DATA_URL    — .../data.json      (старый монолитный формат)
 *   SCHEDULE_OLD_DATA_URL— .../old_data.json  (старый монолитный формат)
 *
 * Cron Trigger: каждые 5 минут (см. выражение в комментарии ниже).
 * Выражение «5 * * * *» срабатывает раз в час в 5-ю минуту.
 *
 * Диагностика: GET /diag — покажет, видит ли воркер data.json и
 * old_data.json каждого факультета, и какие версии лежат в KV.
 */

// Cron в Cloudflare: */5 * * * *  (без пробела между * и /5).

const DEFAULT_SITE_URL =
  'https://justvladcreate.github.io/pspu-schedule-calendar/';
const DEFAULT_INDEX_URL = DEFAULT_SITE_URL + 'data/index.json';
const DEFAULT_DATA_URL = DEFAULT_SITE_URL + 'data.json';
const DEFAULT_OLD_DATA_URL = DEFAULT_SITE_URL + 'old_data.json';

const LAST_VERSION_KEY = 'state:last_version';
const FACULTY_VERSIONS_KEY = 'state:faculty_versions';
const SUB_PREFIX = 'sub:';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const enc = new TextEncoder();

/* ============================================================
 *  Утилиты
 * ============================================================ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function b64uEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64uDecode(value) {
  let str = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(String(value))),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function subscriptionKey(endpoint) {
  return SUB_PREFIX + (await sha256Hex(endpoint)).slice(0, 32);
}

function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function siteUrl(env) {
  const raw = String(env.SITE_URL || DEFAULT_SITE_URL).trim();
  return raw.endsWith('/') ? raw : raw + '/';
}

function changesUrl(env, version) {
  const url = new URL(siteUrl(env));
  url.searchParams.set('open', 'changes');
  if (version) url.searchParams.set('cv', version);
  return url.href;
}

function assetUrl(env, path) {
  return new URL(path, siteUrl(env)).href;
}

/* ============================================================
 *  Сравнение расписаний (та же логика, что в web/js/changes.js)
 * ============================================================ */

function normalizeKey(ev) {
  return [
    ev.faculty_id || '',
    ev.group || '',
    ev.weekday || '',
    ev.pair_number || '',
    ev.discipline || '',
    ev.subgroup || '',
  ].join('|');
}

function toEntry(ev) {
  return {
    key: normalizeKey(ev),
    event_id: ev.event_id,
    faculty_id: ev.faculty_id || '',
    faculty_name: ev.faculty_name || '',
    group: ev.group,
    weekday: ev.weekday,
    pair_number: ev.pair_number,
    time_start: ev.time_start,
    time_end: ev.time_end,
    discipline: ev.discipline,
    type: ev.type,
    subgroup: ev.subgroup,
    teachers: [...(ev.teachers || [])],
    dates: [...(ev.dates || [])],
    rooms: ev.rooms || '',
    comment: ev.comment || '',
    position: ev.position,
    is_past: ev.is_past || false,
    color: ev.color || '',
  };
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function toSet(arr) {
  return new Set(arr || []);
}

function roomsToSet(rooms) {
  return new Set(
    String(rooms || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function diffArray(oldArr, newArr) {
  const oldSet = new Set(oldArr);
  const newSet = new Set(newArr);
  return {
    onlyOld: oldArr.filter((x) => !newSet.has(x)),
    onlyNew: newArr.filter((x) => !oldSet.has(x)),
  };
}

function diffEntry(oldE, newE) {
  const fields = [];

  if (oldE.time_start !== newE.time_start) {
    fields.push({ name: 'time_start', old: oldE.time_start, new: newE.time_start });
  }
  if (oldE.time_end !== newE.time_end) {
    fields.push({ name: 'time_end', old: oldE.time_end, new: newE.time_end });
  }

  const oldT = [...toSet(oldE.teachers)];
  const newT = [...toSet(newE.teachers)];
  if (!setsEqual(new Set(oldT), new Set(newT))) {
    const { onlyOld, onlyNew } = diffArray(oldT, newT);
    fields.push({ name: 'teachers', old: oldT, new: newT, onlyOld, onlyNew });
  }

  const oldD = [...toSet(oldE.dates)];
  const newD = [...toSet(newE.dates)];
  if (!setsEqual(new Set(oldD), new Set(newD))) {
    const { onlyOld, onlyNew } = diffArray(oldD, newD);
    fields.push({ name: 'dates', old: oldD, new: newD, onlyOld, onlyNew });
  }

  const oldR = [...roomsToSet(oldE.rooms)];
  const newR = [...roomsToSet(newE.rooms)];
  if (!setsEqual(new Set(oldR), new Set(newR))) {
    const { onlyOld, onlyNew } = diffArray(oldR, newR);
    fields.push({ name: 'rooms', old: oldR, new: newR, onlyOld, onlyNew });
  }

  if ((oldE.comment || '') !== (newE.comment || '')) {
    fields.push({ name: 'comment', old: oldE.comment || '', new: newE.comment || '' });
  }

  return fields;
}

function compareEvents(oldEvents, newEvents) {
  const oldMap = new Map();
  for (const ev of oldEvents || []) {
    const entry = ev && ev.key ? ev : toEntry(ev);
    oldMap.set(entry.key, entry);
  }

  const newMap = new Map();
  for (const ev of newEvents || []) {
    const entry = toEntry(ev);
    newMap.set(entry.key, entry);
  }

  const changes = [];

  for (const [key, oldE] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({ type: 'removed', key, old: oldE, new: null });
    }
  }

  for (const [key, newE] of newMap) {
    if (!oldMap.has(key)) {
      changes.push({ type: 'added', key, old: null, new: newE });
    }
  }

  for (const [key, newE] of newMap) {
    const oldE = oldMap.get(key);
    if (!oldE) continue;
    const fields = diffEntry(oldE, newE);
    if (fields.length > 0) {
      changes.push({ type: 'changed', key, old: oldE, new: newE, fields });
    }
  }

  return changes;
}

/* ============================================================
 *  Фильтр по настройкам подписчика
 * ============================================================ */

function normalizePrefs(raw) {
  const groups = Array.isArray(raw?.groups)
    ? raw.groups.filter((x) => typeof x === 'string').slice(0, 500)
    : [];
  const teachers = Array.isArray(raw?.teachers)
    ? raw.teachers.filter((x) => typeof x === 'string').slice(0, 500)
    : [];

  return {
    all: !!raw?.all,
    groups: [...new Set(groups)],
    teachers: [...new Set(teachers)],
  };
}

function changeAudience(change) {
  const entries = [change.old, change.new].filter(Boolean);
  const groups = new Set();
  const teachers = new Set();

  for (const ev of entries) {
    if (ev.group !== undefined && ev.group !== null && ev.group !== '') {
      groups.add(String(ev.group));
    }
    for (const t of ev.teachers || []) teachers.add(String(t));
  }

  return { groups, teachers };
}

function matchesPrefs(prefs, audience) {
  if (prefs.all) return true;

  const groups = new Set((prefs.groups || []).map(String));
  const teachers = new Set((prefs.teachers || []).map(String));

  if (!groups.size && !teachers.size) return false;

  for (const g of audience.groups) if (groups.has(g)) return true;
  for (const t of audience.teachers) if (teachers.has(t)) return true;
  return false;
}

function isRelevantChange(change) {
  return [change.old, change.new].some((ev) => ev && ev.is_past !== true);
}

function changeSummary(changes) {
  if (changes.length === 1) {
    const change = changes[0];
    const ev = change.new || change.old;
    const action =
      { added: 'Добавлено', removed: 'Удалено', changed: 'Изменено' }[change.type] ||
      'Изменение';

    const where = [ev.faculty_name, ev.group, ev.weekday, ev.time_start]
      .filter((x) => x !== undefined && x !== null && x !== '')
      .join(' · ');
    const discipline = String(ev.discipline || '').trim();

    return `${action}: ${where}${discipline ? ' — ' + discipline : ''}`.slice(0, 180);
  }

  const groups = [
    ...new Set(
      changes
        .flatMap((ch) => [ch.old?.group, ch.new?.group])
        .filter((g) => g !== undefined && g !== null && g !== '')
        .map(String),
    ),
  ];

  const label = groups.length
    ? groups.slice(0, 3).join(', ') + (groups.length > 3 ? ' и др.' : '')
    : '';

  const n = changes.length;
  return `${label ? label + ' · ' : ''}${n} ${pluralRu(
    n,
    'изменение',
    'изменения',
    'изменений',
  )}`;
}

/* ============================================================
 *  Web Push: RFC 8291 (aes128gcm) + VAPID
 * ============================================================ */

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptPayload(payload, p256dh, auth) {
  const uaPublic = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);

  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );

  const ephemeralPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey),
  );

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaKey },
      ephemeral.privateKey,
      256,
    ),
  );

  const keyInfo = concatBytes(
    enc.encode('WebPush: info'),
    new Uint8Array([0]),
    uaPublic,
    ephemeralPublic,
  );
  const prk = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const plaintext = concatBytes(enc.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      aesKey,
      plaintext,
    ),
  );

  const header = new Uint8Array(16 + 4 + 1 + ephemeralPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = ephemeralPublic.length;
  header.set(ephemeralPublic, 21);

  return concatBytes(header, ciphertext);
}

async function vapidAuth(endpoint, env) {
  const publicKey = b64uDecode(env.VAPID_PUBLIC_KEY);
  const privateKey = b64uDecode(env.VAPID_PRIVATE_KEY);

  if (publicKey.length !== 65 || privateKey.length !== 32) {
    throw new Error('Некорректные VAPID ключи (ожидаются 65 и 32 байта)');
  }

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64uEncode(publicKey.slice(1, 33)),
    y: b64uEncode(publicKey.slice(33, 65)),
    d: b64uEncode(privateKey),
  };

  const signingKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const header = b64uEncode(
    enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  );
  const payload = b64uEncode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
      }),
    ),
  );

  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingKey,
      enc.encode(unsigned),
    ),
  );

  return {
    Authorization: `vapid t=${unsigned}.${b64uEncode(signature)}, k=${String(env.VAPID_PUBLIC_KEY).trim()}`,
  };
}

async function sendPush(subscription, notification, env) {
  const body = await encryptPayload(
    JSON.stringify(notification),
    subscription.keys.p256dh,
    subscription.keys.auth,
  );

  const auth = await vapidAuth(subscription.endpoint, env);

  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body,
  });
}

function buildNotification(env, changes, version) {
  return {
    title: 'Изменения в расписании',
    body: changeSummary(changes),
    icon: assetUrl(env, 'icons/icon-192.png'),
    badge: assetUrl(env, 'icons/icon-192.png'),
    tag: `schedule-${version}`,
    renotify: false,
    data: {
      url: changesUrl(env, version),
      version,
      count: changes.length,
    },
  };
}

/* ============================================================
 *  KV: подписки
 * ============================================================ */

async function listSubscriptions(env) {
  const subscriptions = [];
  let cursor;

  while (true) {
    const page = await env.PUSH_KV.list({ prefix: SUB_PREFIX, cursor });
    for (const key of page.keys) {
      const record = await env.PUSH_KV.get(key.name, 'json');
      if (record && record.endpoint) subscriptions.push({ ...record, kvKey: key.name });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  return subscriptions;
}

async function saveSubscription(env, subscription, prefs) {
  const key = await subscriptionKey(subscription.endpoint);
  const existing = await env.PUSH_KV.get(key, 'json');

  const record = {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    prefs: normalizePrefs(prefs),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await env.PUSH_KV.put(key, JSON.stringify(record));
  return record;
}

/* ============================================================
 *  Проверка обновлений и рассылка (cron)
 * ============================================================ */

async function fetchSchedule(url) {
  const bust = `${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const response = await fetch(url + bust, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

function facultyFileUrl(env, folder, { previous = false } = {}) {
  // В index.json у факультета есть folder: "faculties/<id>".
  // Папка факультета лежит рядом с index.json (data/faculties/<id>/),
  // поэтому разрешаем путь относительно самого index.json, а не корня сайта.
  const base = String(folder || '').replace(/^\/+|\/+$/g, '');
  const name = previous ? 'old_data.json' : 'data.json';
  const indexUrl = env.SCHEDULE_INDEX_URL || DEFAULT_INDEX_URL;
  return new URL(`${base}/${name}`, indexUrl).href;
}

/**
 * Новый формат: data/index.json + data/faculties/<id>.json.
 * Возвращает массив изменений (пустой, если ничего не поменялось).
 */
async function collectChangesFromIndex(env) {
  const indexUrl = env.SCHEDULE_INDEX_URL || DEFAULT_INDEX_URL;
  const index = await fetchSchedule(indexUrl);

  if (!index || !Array.isArray(index.faculties) || !index.generated_at) {
    return null;
  }

  const versions =
    (await env.PUSH_KV.get(FACULTY_VERSIONS_KEY, 'json')) || {};
  const nextVersions = { ...versions };
  const changes = [];
  let touched = 0;
  let pending = false;

  for (const faculty of index.faculties) {
    const version = faculty.generated_at || '';
    if (version && versions[faculty.id] === version) continue;

    // Версия ещё не обработана. Если сеть подведёт, pending останется
    // true и следующий cron попробует снова — иначе изменение потеряется.
    if (version) pending = true;

    const fresh = await fetchSchedule(
      facultyFileUrl(env, faculty.folder || `faculties/${faculty.id}`),
    ).catch((error) => {
      console.warn(`[push] ${faculty.id}: data.json недоступен:`, error.message);
      return null;
    });
    if (!fresh || !Array.isArray(fresh.events)) continue;

    let old = null;
    try {
      old = await fetchSchedule(
        facultyFileUrl(env, faculty.folder || `faculties/${faculty.id}`, { previous: true }),
      );
    } catch (error) {
      // 404 — это первая публикация, сравнивать не с чем.
      // Любая другая ошибка — временная, версию не фиксируем.
      if (!/HTTP 404/.test(error.message)) {
        console.warn(`[push] ${faculty.id}: old_data.json недоступен:`, error.message);
        continue;
      }
    }

    if (old && Array.isArray(old.events) && old.generated_at !== fresh.generated_at) {
      for (const change of compareEvents(old.events, fresh.events)) {
        if (!isRelevantChange(change)) continue;
        changes.push({
          ...change,
          faculty_id: faculty.id,
          faculty_name: faculty.short || faculty.name || '',
        });
      }
      touched++;
    }

    nextVersions[faculty.id] = fresh.generated_at || version;
  }

  // KV обновляет вызывающий код только после успешной обработки.
  return {
    changes,
    version: index.generated_at,
    touched,
    pending,
    versions: nextVersions,
  };
}

/** Старый формат (data.json + old_data.json) — запасной путь. */
async function collectChangesFromLegacy(env) {
  const dataUrl = env.SCHEDULE_DATA_URL || DEFAULT_DATA_URL;
  const oldUrl = env.SCHEDULE_OLD_DATA_URL || DEFAULT_OLD_DATA_URL;

  const [data, oldData] = await Promise.all([
    fetchSchedule(dataUrl),
    fetchSchedule(oldUrl),
  ]);

  if (!data || !Array.isArray(data.events) || !data.generated_at) {
    return null;
  }

  const changes =
    oldData &&
    Array.isArray(oldData.events) &&
    oldData.generated_at &&
    oldData.generated_at !== data.generated_at
      ? compareEvents(oldData.events, data.events).filter(isRelevantChange)
      : [];

  return { changes, version: data.generated_at, touched: 0, pending: false };
}

async function checkForChanges(env) {
  let result = null;

  try {
    result = await collectChangesFromIndex(env);
  } catch (error) {
    console.warn('[push] index.json недоступен:', error.message);
  }

  if (!result) {
    try {
      result = await collectChangesFromLegacy(env);
    } catch (error) {
      console.error('[push] данные недоступны:', error.message);
      return;
    }
  }

  if (!result) {
    console.warn('[push] нет данных — пропуск');
    return;
  }

  const lastVersion = await env.PUSH_KV.get(LAST_VERSION_KEY);
  const { changes, version, touched, pending, versions } = result;

  // Раньше здесь был только lastVersion === version. Если один факультет
  // не скачался, его версия не сохранялась, а lastVersion уже ставился —
  // и изменение терялось навсегда. Теперь pending заставляет повторить.
  if (lastVersion === version && !pending) return;

  if (changes.length === 0) {
    if (versions) {
      await env.PUSH_KV.put(FACULTY_VERSIONS_KEY, JSON.stringify(versions));
    }
    await env.PUSH_KV.put(LAST_VERSION_KEY, version);
    console.log(
      `[push] версия ${version}: изменений нет` +
        (touched ? `, обновлено факультетов ${touched}` : ''),
    );
    return;
  }

  const subscriptions = await listSubscriptions(env);
  let sent = 0;

  for (const subscription of subscriptions) {
    const audienceChanges = [];
    for (const change of changes) {
      if (matchesPrefs(subscription.prefs || {}, changeAudience(change))) {
        audienceChanges.push(change);
      }
    }

    if (audienceChanges.length === 0) continue;

    try {
      const response = await sendPush(
        subscription,
        buildNotification(env, audienceChanges, version),
        env,
      );

      if (response.status === 404 || response.status === 410) {
        await env.PUSH_KV.delete(subscription.kvKey);
      } else if (!response.ok) {
        console.warn(
          `[push] ${response.status} для ${subscription.endpoint.slice(0, 60)}…`,
        );
      } else {
        sent++;
      }
    } catch (error) {
      console.error('[push] send failed:', error);
    }
  }

  if (versions) {
    await env.PUSH_KV.put(FACULTY_VERSIONS_KEY, JSON.stringify(versions));
  }
  await env.PUSH_KV.put(LAST_VERSION_KEY, version);
  console.log(
    `[push] версия ${version}: изменений ${changes.length}, ` +
      `факультетов ${touched}, подписок ${subscriptions.length}, отправлено ${sent}`,
  );
}

/* ============================================================
 *  HTTP API
 * ============================================================ */

async function handleSubscribe(request, env) {
  const body = await request.json().catch(() => null);
  const subscription = body?.subscription;

  if (
    !subscription ||
    typeof subscription.endpoint !== 'string' ||
    !subscription.endpoint.startsWith('https://') ||
    !subscription.keys?.p256dh ||
    !subscription.keys?.auth
  ) {
    return json({ ok: false, error: 'invalid_subscription' }, 400);
  }

  await saveSubscription(env, subscription, body.prefs);
  return json({ ok: true });
}

async function handleUnsubscribe(request, env) {
  const body = await request.json().catch(() => null);
  const endpoint = body?.endpoint;

  if (typeof endpoint !== 'string' || !endpoint) {
    return json({ ok: false, error: 'invalid_endpoint' }, 400);
  }

  await env.PUSH_KV.delete(await subscriptionKey(endpoint));
  return json({ ok: true });
}

async function handleTest(request, env) {
  const body = await request.json().catch(() => null);
  const endpoint = body?.endpoint;

  if (typeof endpoint !== 'string' || !endpoint) {
    return json({ ok: false, error: 'invalid_endpoint' }, 400);
  }

  const key = await subscriptionKey(endpoint);
  const subscription = await env.PUSH_KV.get(key, 'json');

  if (!subscription) {
    return json({ ok: false, error: 'not_subscribed' }, 404);
  }

  const notification = {
    title: 'Проверка уведомлений',
    body: 'Всё работает! Теперь вы будете получать изменения расписания.',
    icon: assetUrl(env, 'icons/icon-192.png'),
    badge: assetUrl(env, 'icons/icon-192.png'),
    tag: 'schedule-test',
    data: { url: siteUrl(env), test: true },
  };

  try {
    const response = await sendPush(subscription, notification, env);

    if (response.status === 404 || response.status === 410) {
      await env.PUSH_KV.delete(key);
      return json({ ok: false, error: 'subscription_expired' }, 410);
    }
    if (!response.ok) {
      return json({ ok: false, error: `push_${response.status}` }, 502);
    }

    return json({ ok: true });
  } catch (error) {
    console.error('[push] test failed:', error);
    return json({ ok: false, error: 'push_failed' }, 500);
  }
}

async function handleDiag(env) {
  const indexUrl = env.SCHEDULE_INDEX_URL || DEFAULT_INDEX_URL;

  const report = {
    ok: true,
    service: 'pspu-push-worker',
    mode: 'per-faculty',
    indexUrl,
    lastVersion: null,
    versions: {},
    indexGeneratedAt: null,
    faculties: [],
  };

  try {
    report.lastVersion = await env.PUSH_KV.get(LAST_VERSION_KEY);
    report.versions =
      (await env.PUSH_KV.get(FACULTY_VERSIONS_KEY, 'json')) || {};
  } catch (error) {
    report.kvError = error.message;
  }

  let index;
  try {
    index = await fetchSchedule(indexUrl);
  } catch (error) {
    report.ok = false;
    report.indexError = error.message;
    return json(report, 502);
  }

  report.indexGeneratedAt = index?.generated_at || null;

  const faculties = Array.isArray(index?.faculties) ? index.faculties : [];
  report.faculties = await Promise.all(
    faculties.map(async (faculty) => {
      const folder = faculty.folder || `faculties/${faculty.id}`;
      const entry = {
        id: faculty.id,
        generated_at: faculty.generated_at || '',
        cached_version: report.versions[faculty.id] || null,
      };

      try {
        const fresh = await fetchSchedule(facultyFileUrl(env, folder));
        entry.data = {
          ok: true,
          generated_at: fresh.generated_at || '',
          events: Array.isArray(fresh.events) ? fresh.events.length : 0,
        };
      } catch (error) {
        entry.data = { ok: false, error: error.message };
      }

      try {
        const old = await fetchSchedule(
          facultyFileUrl(env, folder, { previous: true }),
        );
        entry.old_data = {
          ok: true,
          generated_at: old.generated_at || '',
          events: Array.isArray(old.events) ? old.events.length : 0,
        };
      } catch (error) {
        entry.old_data = { ok: false, error: error.message };
      }

      return entry;
    }),
  );

  return json(report);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({
          ok: true,
          service: 'pspu-push-worker',
          mode: 'per-faculty',
          build: '2026-10-29-per-faculty-v2',
          indexUrl: env.SCHEDULE_INDEX_URL || DEFAULT_INDEX_URL,
          vapidPublicKey: String(env.VAPID_PUBLIC_KEY || '').trim() || null,
          endpoints: ['/subscribe', '/unsubscribe', '/test', '/diag'],
        });
      }

      if (url.pathname === '/diag' && request.method === 'GET') {
        return await handleDiag(env);
      }

      if (url.pathname === '/subscribe' && request.method === 'POST') {
        return await handleSubscribe(request, env);
      }

      if (url.pathname === '/unsubscribe' && request.method === 'POST') {
        return await handleUnsubscribe(request, env);
      }

      if (url.pathname === '/test' && request.method === 'POST') {
        return await handleTest(request, env);
      }

      return json({ ok: false, error: 'not_found' }, 404);
    } catch (error) {
      console.error('[push] request failed:', error);
      return json({ ok: false, error: 'internal_error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForChanges(env));
  },
};
