// tests/t05-automated.spec.mjs
// T05 고정 검사 10개(docs/t05-fixed-tests.md)를 실제 브라우저(Chromium, headless)에서
// 자동으로 재현·검증하는 스크립트. "육안 확인"이 아니라 실제 마우스 드래그/휠 이벤트,
// 터치 이벤트, 뷰포트 리사이즈, 네트워크 차단을 코드로 재현해 판정한다.
//
// 실행: node tests/t05-automated.spec.mjs
// 요구사항: npm 패키지 "playwright" (Chromium 브라우저 포함) 설치되어 있어야 함.
//   npm install -D playwright && npx playwright install chromium
//
// USGS 실시간 API는 매 실행마다 데이터가 달라 재현 불가능한 검사(T05-T02, T05-T09)가 되므로,
// 이 테스트는 fetch를 가로채 고정된 GeoJSON 응답으로 대체한다(page.route). 이는 결과의
// 결정성(같은 입력 → 같은 결과)을 위한 것으로, 실제 코드 경로(fetch → 파싱 → 마커 갱신 →
// 저장 스키마 구성)는 그대로 실행된다.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '..');
const PORT = 8177;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const MOCK_LAT = 35.68;   // 도쿄 부근 — 임의 고정 좌표(위도)
const MOCK_LON = 139.76;  // (경도)
const MOCK_MAG = 6.2;

const MOCK_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        mag: MOCK_MAG,
        magType: 'mww',
        place: '자동화 테스트용 임의 위치',
        time: Date.parse('2026-09-18T00:00:00Z'),
        tsunami: 0,
        url: 'https://example.invalid/detail',
      },
      geometry: { type: 'Point', coordinates: [MOCK_LON, MOCK_LAT, 10.0] },
    },
    {
      type: 'Feature',
      properties: { mag: 3.1, magType: 'ml', place: '보조 이벤트', time: Date.parse('2026-09-18T00:10:00Z'), tsunami: 0, url: 'https://example.invalid/2' },
      geometry: { type: 'Point', coordinates: [10, 10, 5] },
    },
  ],
};

// --- 기대 마커 위치를 인수인계 문서의 좌표 변환 공식과 "독립적으로" 재계산 ---
function expectedMarkerVector(lat, lon, radius) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

function approxEqual(a, b, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}

// ---------- 정적 파일 서버 ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(SITE_ROOT, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found: ' + urlPath); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? '🟢 PASS' : '🔴 FAIL'}  ${id} — ${detail}`);
}

async function withMockedLiveFetch(page) {
  await page.route('https://earthquake.usgs.gov/**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_GEOJSON) });
  });
}

async function main() {
  const server = await startServer();
  // PW_CHROMIUM 환경변수가 지정되어 있으면 그 경로를 쓰고, 없으면
  // `npx playwright install chromium`으로 설치된 Playwright 기본 브라우저를 사용한다.
  const launchOptions = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
  const browser = await chromium.launch(launchOptions);

  try {
    // ===================== T05-T01, T05-T02, T05-T03 =====================
    {
      const context = await browser.newContext({ viewport: { width: 800, height: 900 } });
      const page = await context.newPage();
      await withMockedLiveFetch(page);
      await page.goto(BASE_URL);
      await page.waitForFunction(() => window.__T05_DEBUG__ !== undefined, null, { timeout: 5000 });
      await page.waitForFunction(() => window.__T05_DEBUG__.getState().markerVisible === true, null, { timeout: 5000 });

      // T05-T01: 캔버스가 실제로 WebGL 컨텍스트로 렌더링되었는가
      const canvasInfo = await page.evaluate(() => {
        const c = document.querySelector('#globe-container canvas');
        if (!c) return null;
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        return { exists: true, hasGL: !!gl, w: c.width, h: c.height };
      });
      record('T05-T01', !!canvasInfo && canvasInfo.hasGL && canvasInfo.w > 0 && canvasInfo.h > 0,
        canvasInfo ? `canvas ${canvasInfo.w}x${canvasInfo.h}, webgl=${canvasInfo.hasGL}` : '캔버스 없음');

      // T05-T02: 마커 위치가 좌표 변환 공식과 일치하는가 (독립 재계산과 비교)
      const state = await page.evaluate(() => window.__T05_DEBUG__.getState());
      const expected = expectedMarkerVector(MOCK_LAT, MOCK_LON, 5.05);
      const posOk = state.markerVisible && state.markerPosition &&
        approxEqual(state.markerPosition[0], expected[0]) &&
        approxEqual(state.markerPosition[1], expected[1]) &&
        approxEqual(state.markerPosition[2], expected[2]);
      record('T05-T02', posOk, `marker=${JSON.stringify(state.markerPosition)} expected≈${JSON.stringify(expected.map(n => +n.toFixed(3)))}`);

      // T05-T03: 마우스로 100px 드래그하면 회전(azimuthalAngle 변화)하는가
      const canvasBox = await page.locator('#globe-container canvas').boundingBox();
      const beforeAngle = (await page.evaluate(() => window.__T05_DEBUG__.getState())).azimuthalAngle;
      const cx = canvasBox.x + canvasBox.width / 2;
      const cy = canvasBox.y + canvasBox.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 100, cy, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(150); // OrbitControls damping 반영 대기
      const afterAngle = (await page.evaluate(() => window.__T05_DEBUG__.getState())).azimuthalAngle;
      record('T05-T03', !approxEqual(beforeAngle, afterAngle, 0.001),
        `azimuthalAngle ${beforeAngle.toFixed(4)} → ${afterAngle.toFixed(4)}`);

      await context.close();
    }

    // ===================== T05-T04, T05-T05, T05-T06, T05-T07 =====================
    {
      const context = await browser.newContext({ viewport: { width: 800, height: 900 } });
      const page = await context.newPage();
      await withMockedLiveFetch(page);
      await page.goto(BASE_URL);
      await page.waitForFunction(() => window.__T05_DEBUG__ !== undefined, null, { timeout: 5000 });
      const canvasBox = await page.locator('#globe-container canvas').boundingBox();
      const cx = canvasBox.x + canvasBox.width / 2;
      const cy = canvasBox.y + canvasBox.height / 2;

      const d0 = (await page.evaluate(() => window.__T05_DEBUG__.getState())).cameraDistance;
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -100); // 위로 스크롤 = 확대(거리 감소)
      await page.waitForTimeout(150);
      const d1 = (await page.evaluate(() => window.__T05_DEBUG__.getState())).cameraDistance;
      record('T05-T04', d1 < d0, `distance ${d0.toFixed(2)} → ${d1.toFixed(2)} (감소해야 확대)`);

      await page.mouse.wheel(0, 100); // 아래로 스크롤 = 축소(거리 증가)
      await page.waitForTimeout(150);
      const d2 = (await page.evaluate(() => window.__T05_DEBUG__.getState())).cameraDistance;
      record('T05-T05', d2 > d1, `distance ${d1.toFixed(2)} → ${d2.toFixed(2)} (증가해야 축소)`);

      // T05-T06: 50회 연속 확대 → 최소 거리(7) 아래로 못 내려감
      for (let i = 0; i < 50; i++) await page.mouse.wheel(0, -200);
      await page.waitForTimeout(200);
      const stMin = await page.evaluate(() => window.__T05_DEBUG__.getState());
      record('T05-T06', stMin.cameraDistance >= stMin.minDistance - 0.05,
        `50회 확대 후 distance=${stMin.cameraDistance.toFixed(3)}, minDistance=${stMin.minDistance}`);

      // T05-T07: 50회 연속 축소 → 최대 거리(20) 위로 못 올라감
      for (let i = 0; i < 50; i++) await page.mouse.wheel(0, 200);
      await page.waitForTimeout(200);
      const stMax = await page.evaluate(() => window.__T05_DEBUG__.getState());
      record('T05-T07', stMax.cameraDistance <= stMax.maxDistance + 0.05,
        `50회 축소 후 distance=${stMax.cameraDistance.toFixed(3)}, maxDistance=${stMax.maxDistance}`);

      await context.close();
    }

    // ===================== T05-T08: 텍스처 로드 강제 실패 =====================
    {
      const context = await browser.newContext({ viewport: { width: 800, height: 900 } });
      const page = await context.newPage();
      await withMockedLiveFetch(page);
      // 지구본 텍스처 요청만 강제로 네트워크 차단
      await page.route('**/assets/earth-texture.jpg', (route) => route.abort('connectionrefused'));
      await page.goto(BASE_URL);
      await page.waitForFunction(() => {
        const fb = document.getElementById('globe-fallback');
        return fb && getComputedStyle(fb).display !== 'none';
      }, null, { timeout: 5000 });
      const liveValueVisible = await page.evaluate(() => document.getElementById('live-value').textContent);
      await page.waitForFunction((expected) => document.getElementById('live-value').textContent === expected, MOCK_MAG.toFixed(1), { timeout: 5000 });
      const finalLiveValue = await page.evaluate(() => document.getElementById('live-value').textContent);
      const containerHidden = await page.evaluate(() => getComputedStyle(document.getElementById('globe-container')).display === 'none');
      record('T05-T08', containerHidden && finalLiveValue === MOCK_MAG.toFixed(1),
        `fallback 표시됨=${containerHidden}, live-value=${finalLiveValue} (다른 값 정상 유지 확인)`);
      await context.close();
    }

    // ===================== T05-T09: 저장 스키마 9개 필드 =====================
    {
      const raw = fs.readFileSync(path.join(SITE_ROOT, 'data', 'daily-readings.json'), 'utf-8');
      const state = JSON.parse(raw);
      const expectedKeys = ['signal_id', 'normalized_value', 'unit', 'source_name', 'source_url', 'source_time', 'fetched_at', 'record_timezone', 'record_date'];
      const allOk = (state.daily_readings || []).every((row) => {
        const keys = Object.keys(row.reading || {});
        return keys.length === expectedKeys.length && expectedKeys.every((k) => keys.includes(k));
      });
      record('T05-T09', allOk, `daily-readings.json ${state.daily_readings.length}건 전부 9개 필드(추가 필드 없음) 확인`);
    }

    // ===================== T05-T10: 375px 반응형 =====================
    {
      const context = await browser.newContext({ viewport: { width: 375, height: 700 } });
      const page = await context.newPage();
      await withMockedLiveFetch(page);
      await page.goto(BASE_URL);
      await page.waitForFunction(() => window.__T05_DEBUG__ !== undefined, null, { timeout: 5000 });
      await page.waitForTimeout(200);
      const layout = await page.evaluate(() => {
        const card = document.querySelector('.card');
        const globe = document.getElementById('globe-container');
        const cardBox = card.getBoundingClientRect();
        const globeBox = globe.getBoundingClientRect();
        return { cardRight: cardBox.right, globeRight: globeBox.right, globeWidth: globeBox.width, viewportWidth: window.innerWidth };
      });
      const fitsInCard = layout.globeRight <= layout.cardRight + 1 && layout.globeWidth <= layout.viewportWidth;
      record('T05-T10', fitsInCard, `globe width=${layout.globeWidth.toFixed(0)}px, card right=${layout.cardRight.toFixed(0)}, globe right=${layout.globeRight.toFixed(0)} (viewport ${layout.viewportWidth}px)`);
      await context.close();
    }

    // ===================== 추가: 모바일 터치 드래그 / 핀치 줌 (남은 문제 보완) =====================
    // 실기기 검증을 완전히 대체하지는 못하지만, 코드가 터치 이벤트에 실제로 반응하는지를
    // CDP 수준의 합성 터치 이벤트로 확인한다. docs/t05-fixed-tests.md의 고정 10개 항목에는
    // 포함되지 않는 "남은 문제" 보완 검증이며, 별도 ID(T05-EXTRA-*)로 기록한다.
    {
      const context = await browser.newContext({ viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await withMockedLiveFetch(page);
      await page.goto(BASE_URL);
      await page.waitForFunction(() => window.__T05_DEBUG__ !== undefined, null, { timeout: 5000 });
      const canvasBox = await page.locator('#globe-container canvas').boundingBox();
      const cx = canvasBox.x + canvasBox.width / 2;
      const cy = canvasBox.y + canvasBox.height / 2;

      // 한 손가락 드래그 → 회전
      const beforeAngle = (await page.evaluate(() => window.__T05_DEBUG__.getState())).azimuthalAngle;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + 80, y: cy }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(150);
      const afterAngle = (await page.evaluate(() => window.__T05_DEBUG__.getState())).azimuthalAngle;
      record('T05-EXTRA-touch-rotate', !approxEqual(beforeAngle, afterAngle, 0.001),
        `(참고 항목) 터치 드래그 azimuthalAngle ${beforeAngle.toFixed(4)} → ${afterAngle.toFixed(4)}`);

      // 두 손가락 핀치 아웃(벌리기) → 확대(거리 감소)
      const dBefore = (await page.evaluate(() => window.__T05_DEBUG__.getState())).cameraDistance;
      const midY = cy;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 20, y: midY }, { x: cx + 20, y: midY }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 80, y: midY }, { x: cx + 80, y: midY }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(150);
      const dAfter = (await page.evaluate(() => window.__T05_DEBUG__.getState())).cameraDistance;
      record('T05-EXTRA-touch-pinch', dAfter < dBefore,
        `(참고 항목) 핀치 아웃 후 distance ${dBefore.toFixed(2)} → ${dAfter.toFixed(2)} (감소해야 확대)`);

      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  // ---------- 요약 및 리포트 파일 생성 ----------
  const fixedIds = results.filter((r) => r.id.startsWith('T05-T'));
  const passCount = fixedIds.filter((r) => r.pass).length;
  console.log(`\n=== 고정 검사 10개 결과: ${passCount}/${fixedIds.length} PASS ===`);

  const reportLines = [
    '# T05 자동화 테스트 실행 결과',
    '',
    `실행 시각: ${new Date().toISOString()}`,
    '',
    '실제 Chromium(headless)에서 마우스 드래그/휠/터치 이벤트, 네트워크 차단, 375px 리사이즈를',
    '코드로 재현해 자동 판정한 결과. (docs/t05-fixed-tests.md 기준)',
    '',
    '| ID | 결과 | 상세 |',
    '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.detail.replace(/\|/g, '\\|')} |`),
    '',
    `**고정 검사 10개: ${passCount}/${fixedIds.length} PASS**`,
    '',
    '(T05-EXTRA-* 두 항목은 고정 검사 10개에 포함되지 않는, "남은 문제"였던 모바일 터치',
    '드래그/핀치줌에 대한 참고 검증입니다. 실기기 테스트를 완전히 대체하지는 않습니다.)',
  ];
  fs.writeFileSync(path.join(SITE_ROOT, 'docs', 't05-automated-test-report.md'), reportLines.join('\n') + '\n');
  console.log('리포트 저장: docs/t05-automated-test-report.md');

  if (fixedIds.some((r) => !r.pass)) process.exitCode = 1;
}

main();
