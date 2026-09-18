// globe.js — T05: 진앙 좌표를 인터랙티브 3D 지구본으로 표시
// Three.js(ESM)는 CDN에서 로드하지만, 지구본 텍스처 이미지는 외부 CDN 의존을 없애기 위해
// 저장소에 직접 포함된 자체 호스팅 이미지(./assets/earth-texture.jpg)를 사용한다.
// (남은 문제 보완: 텍스처 서버 장애가 곧 T05-T08 폴백을 상시 유발하던 구조를 제거)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const EARTH_TEXTURE_URL = './assets/earth-texture.jpg';
const GLOBE_RADIUS = 5;
const MIN_DISTANCE = 7;   // 확대 한계 (T05-T06)
const MAX_DISTANCE = 20;  // 축소 한계 (T05-T07)

let scene, camera, renderer, controls, globeMesh, markerMesh, container;
let animId = null;

function latLonToVector3(lat, lon, radius) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function onResize() {
  if (!container || !camera || !renderer) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  animId = requestAnimationFrame(animate);
  controls.update(); // damping에 필요
  renderer.render(scene, camera);
}

/**
 * 지구본 초기화. containerEl: 캔버스를 넣을 div. 실패 시 onError 콜백 호출(대체 안내 표시용, T05-T08).
 */
export function initGlobe(containerEl, onError) {
  container = containerEl;
  const w = container.clientWidth || 300;
  const h = container.clientHeight || 300;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.z = 12;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = MIN_DISTANCE; // T05-T06
  controls.maxDistance = MAX_DISTANCE; // T05-T07
  controls.enablePan = false;
  controls.rotateSpeed = 0.6;
  // 모바일 터치 입력: 한 손가락 드래그=회전, 두 손가락 오므리기/벌리기=확대/축소 (OrbitControls 기본 동작)
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.position.set(5, 3, 5);
  scene.add(sun);

  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 48, 48);
  const loader = new THREE.TextureLoader();
  loader.load(
    EARTH_TEXTURE_URL,
    (texture) => {
      const material = new THREE.MeshPhongMaterial({ map: texture });
      globeMesh = new THREE.Mesh(geometry, material);
      scene.add(globeMesh);
      addMarkerPlaceholder();
    },
    undefined,
    (err) => {
      // 텍스처 로드 실패 — 캔버스 대신 대체 안내를 보여주도록 상위에 알림 (T05-T08)
      console.error('[globe] texture load failed', err);
      if (typeof onError === 'function') onError();
    }
  );

  window.addEventListener('resize', onResize);
  animate();

  // 자동화 테스트 전용 훅 — 프로덕션 동작에는 영향 없음, 내부 상태 읽기 전용 노출
  // (tests/t05-automated.spec.mjs가 카메라 거리/마커 좌표/컨트롤 한계값을 검증하는 데 사용)
  if (typeof window !== 'undefined') {
    window.__T05_DEBUG__ = {
      getState: () => ({
        cameraDistance: camera.position.distanceTo(controls.target),
        minDistance: controls.minDistance,
        maxDistance: controls.maxDistance,
        markerVisible: markerMesh ? markerMesh.visible : false,
        markerPosition: markerMesh ? markerMesh.position.toArray() : null,
        azimuthalAngle: controls.getAzimuthalAngle(),
      }),
    };
  }
}

function addMarkerPlaceholder() {
  const markerGeo = new THREE.SphereGeometry(0.12, 16, 16);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
  markerMesh = new THREE.Mesh(markerGeo, markerMat);
  markerMesh.visible = false;
  globeMesh.add(markerMesh); // globe의 자식으로 붙여야 회전에 같이 따라감
}

/**
 * 진앙 좌표로 마커 위치 갱신 (T05-T02)
 */
export function setMarker(lat, lon) {
  if (!markerMesh) return;
  const pos = latLonToVector3(lat, lon, GLOBE_RADIUS + 0.05);
  markerMesh.position.copy(pos);
  markerMesh.visible = true;
}

export function destroyGlobe() {
  if (animId) cancelAnimationFrame(animId);
  window.removeEventListener('resize', onResize);
  if (renderer) renderer.dispose();
}
