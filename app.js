import {
  resetEvaluationState, applySuccessfulReading, applyError, runFixture,
  comparisonFor, kstDate
} from './engine.js';
import { initGlobe, setMarker } from './globe.js';

const SIGNAL_ID = 'usgs-max-mag-24h';
const SOURCE_NAME = 'USGS Earthquake Hazards Program';
const LIVE_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const $ = (id) => document.getElementById(id);
const fmtKST = (iso) => iso ? new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium'
}).format(new Date(iso)) : '—';

// ---------- 표시 전용 부가정보 (저장 스키마 9개 필드와 무관 — 화면에만 표시) ----------
function renderExtraInfo(features) {
  // 오늘 전 세계 발생 건수
  $('live-count').textContent = `${features.length}건 (all_day.geojson 기준)`;

  // 쓰나미 경보 — 오늘 features 중 하나라도 tsunami 플래그가 1이면 발령으로 표시
  const tsunamiCount = features.filter((f) => f.properties?.tsunami === 1).length;
  const tsunamiEl = $('live-tsunami');
  if (tsunamiCount > 0) {
    tsunamiEl.textContent = `⚠️ 발령 ${tsunamiCount}건 있음`;
    tsunamiEl.style.color = '#d97706';
  } else {
    tsunamiEl.textContent = '없음';
    tsunamiEl.style.color = '';
  }

  // 최근 24시간 규모 상위 5건
  const top5 = features
    .filter((f) => typeof f.properties?.mag === 'number')
    .slice()
    .sort((a, b) => b.properties.mag - a.properties.mag)
    .slice(0, 5);
  const tbody = $('top5-tbody');
  tbody.innerHTML = '';
  top5.forEach((f) => {
    const p = f.properties;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.mag.toFixed(1)} ${p.magType || ''}</td>
      <td>${p.place || '—'}</td>
      <td>${fmtKST(new Date(p.time).toISOString())}</td>
      <td><a href="${p.url}" target="_blank" rel="noopener">상세</a></td>`;
    tbody.appendChild(tr);
  });
}

// ---------- ① 지금 이 순간 실시간 조회 (C03~C10) ----------
async function fetchLiveNow() {
  const statusEl = $('live-status');
  statusEl.textContent = '조회 중...';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(LIVE_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('인증 거절'), { code: 'auth' });
    if (res.status === 429) throw Object.assign(new Error('호출 제한'), { code: 'rate_limit' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'schema_error' });

    const body = await res.json();
    const features = Array.isArray(body.features) ? body.features : [];
    if (features.length === 0) throw Object.assign(new Error('features 비어있음'), { code: 'schema_error' });

    let top = features[0];
    for (const f of features) {
      if (typeof f.properties?.mag === 'number' && f.properties.mag > (top.properties?.mag ?? -Infinity)) top = f;
    }
    if (typeof top.properties?.mag !== 'number' || typeof top.properties?.time !== 'number') {
      throw Object.assign(new Error('필수 필드 누락'), { code: 'schema_error' });
    }

    // ---- 표시 전용 부가정보 (저장 데이터 9개 필드와 무관, daily-readings.json에는 영향 없음) ----
    renderExtraInfo(features);

    // ---- 3D 지구본 마커 갱신 (T05-T02, 표시 전용) ----
    const coords = top.geometry?.coordinates; // GeoJSON: [lon, lat, depth]
    if (Array.isArray(coords) && coords.length >= 2) {
      setMarker(coords[1], coords[0]);
    }

    const fetchedAt = new Date().toISOString();
    const reading = {
      signal_id: SIGNAL_ID,
      normalized_value: top.properties.mag,
      unit: top.properties.magType || 'Mw',
      source_name: SOURCE_NAME,
      source_url: LIVE_URL,
      source_time: new Date(top.properties.time).toISOString(),
      fetched_at: fetchedAt,
      record_timezone: 'Asia/Seoul',
      record_date: kstDate(fetchedAt)
    };

    $('live-value').textContent = reading.normalized_value.toFixed(1);
    $('live-unit').textContent = reading.unit;
    $('live-place').textContent = top.properties.place || '위치 정보 없음';
    $('live-source').innerHTML = `<a href="${reading.source_url}" target="_blank" rel="noopener">${reading.source_name}</a>`;
    $('live-source-time').textContent = fmtKST(reading.source_time);
    $('live-fetch-time').textContent = fmtKST(reading.fetched_at);
    $('live-tz').textContent = 'Asia/Seoul (KST)';
    statusEl.textContent = 'fresh / none';
    statusEl.className = 'badge fresh';
    return reading;
  } catch (err) {
    clearTimeout(timer);
    const code = err.name === 'AbortError' ? 'timeout' : (err.code || (err instanceof TypeError ? 'offline' : 'schema_error'));
    statusEl.textContent = `stale / ${code} (직전 정상값 유지)`;
    statusEl.className = 'badge stale';
    console.error('[live fetch error]', err);
    return null;
  }
}

// ---------- ② 실제 이틀치 일별 기록 (GitHub Actions가 커밋) (C20~C24) ----------
async function loadDailyHistory() {
  const tbody = $('history-tbody');
  const note = $('history-note');
  try {
    const res = await fetch('./data/daily-readings.json', { cache: 'no-store' });
    const state = await res.json();
    const rows = (state.daily_readings || []).slice().sort((a, b) => a.record_date.localeCompare(b.record_date));
    tbody.innerHTML = '';
    rows.forEach((row, i) => {
      const prev = rows[i - 1];
      const cmp = prev ? comparisonFor([prev], row) : { state: 'insufficient' };
      const deltaText = cmp.state === 'comparable'
        ? `${cmp.direction === 'increase' ? '+' : cmp.direction === 'decrease' ? '-' : '±'}${cmp.magnitude.toFixed(1)} ${cmp.unit}`
        : '기준 없음(첫 기록)';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.record_date}</td><td>${row.normalized_value.toFixed(1)} ${row.unit}</td>
        <td>${fmtKST(row.last_fetched_at)}</td><td>${deltaText}</td>`;
      tbody.appendChild(tr);
    });
    note.textContent = rows.length >= 2
      ? `서로 다른 KST 날짜 ${rows.length}건 보존됨 — 어제 대비 변화값은 저장된 두 값으로 재계산됨.`
      : `현재 ${rows.length}건 — GitHub Actions가 다음 KST 날짜에 자동 수집하면 대비값이 나타남.`;
  } catch (e) {
    note.textContent = '일별 기록을 불러오지 못했습니다 (data/daily-readings.json 확인 필요).';
  }
}

// ---------- ③ 합성 실패 5종 + 복구 재생 데모 (C12~C19) — 실제 데이터와 분리된 데모 상태 ----------
let demoState = resetEvaluationState();
const fixtureCache = {};
async function loadFixture(name) {
  if (fixtureCache[name]) return fixtureCache[name];
  const res = await fetch(`./fixtures/${name}.json`);
  const data = await res.json();
  fixtureCache[name] = data;
  return data;
}

function renderDemo() {
  $('demo-status').textContent = demoState.status ? `${demoState.status.freshness} / ${demoState.status.error_code}` : '—';
  $('demo-status').className = 'badge ' + (demoState.status?.freshness === 'fresh' ? 'fresh' : demoState.status ? 'stale' : '');
  $('demo-rows').textContent = String(demoState.daily_readings.length);
  const lastGood = demoState.daily_readings[demoState.daily_readings.length - 1];
  $('demo-lastgood').textContent = lastGood ? `${lastGood.normalized_value} ${lastGood.unit} (${lastGood.record_date})` : '—';
  $('demo-run').textContent = demoState.last_run ? JSON.stringify(demoState.last_run) : '—';
  $('btn-retry').style.display = demoState.status?.freshness === 'stale' ? 'inline-block' : 'none';
}

async function runBaseline() {
  demoState = resetEvaluationState();
  const d1a = await loadFixture('normal-d1-a');
  const d1b = await loadFixture('normal-d1-b');
  demoState = applySuccessfulReading(demoState, d1a.payload, { fixture_id: d1a.fixture_id, virtual_now: d1a.virtual_now });
  demoState = applySuccessfulReading(demoState, d1b.payload, { fixture_id: d1b.fixture_id, virtual_now: d1b.virtual_now });
}

async function runFullSuccess() {
  await runBaseline();
  const d2 = await loadFixture('normal-d2');
  demoState = applySuccessfulReading(demoState, d2.payload, { fixture_id: d2.fixture_id, virtual_now: d2.virtual_now });
  renderDemo();
}

async function runFailure(fixtureName) {
  await runBaseline();
  const fx = await loadFixture(fixtureName);
  demoState = runFixture(demoState, fx);
  renderDemo();
}

async function runRecover() {
  // 실패 상태가 아니면(예: 정상흐름만 재생했을 경우) 먼저 timeout으로 만든 뒤 복구를 보여줌
  if (demoState.status?.freshness !== 'stale') {
    const tf = await loadFixture('timeout');
    demoState = runFixture(demoState, tf);
    renderDemo();
    await new Promise((r) => setTimeout(r, 400));
  }
  const rec = await loadFixture('recover-d2');
  demoState = runFixture(demoState, rec);
  renderDemo();
}

function wireDemoButtons() {
  $('btn-success').addEventListener('click', runFullSuccess);
  $('btn-timeout').addEventListener('click', () => runFailure('timeout'));
  $('btn-auth').addEventListener('click', () => runFailure('auth-401'));
  $('btn-rate').addEventListener('click', () => runFailure('rate-429'));
  $('btn-offline').addEventListener('click', () => runFailure('offline'));
  $('btn-schema').addEventListener('click', () => runFailure('schema-break'));
  $('btn-retry').addEventListener('click', runRecover);
}

// ---------- init ----------
window.addEventListener('DOMContentLoaded', () => {
  const globeContainer = $('globe-container');
  if (globeContainer) {
    initGlobe(globeContainer, () => {
      // 텍스처 로드 실패 시(T05-T08): 캔버스는 숨기고 대체 안내만 표시. 다른 값은 그대로 유지됨.
      globeContainer.style.display = 'none';
      const fb = $('globe-fallback');
      if (fb) fb.style.display = 'block';
    });
  }
  fetchLiveNow();
  loadDailyHistory();
  wireDemoButtons();
  $('btn-refresh-live').addEventListener('click', fetchLiveNow);
});
