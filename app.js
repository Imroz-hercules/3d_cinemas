import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import Lenis from "lenis";

/**
 * Theater screen media.
 * - type "mp4": progressive file (good up to ~50–100MB if encoded for web)
 * - type "hls": adaptive streaming for large/long trailers (needs .m3u8 + segments)
 *
 * For a big future trailer, re-encode + package as HLS, then set:
 *   src: "./textures/trailers/hercules/master.m3u8", type: "hls"
 */
const SCREEN_MEDIA = {
  src: "./textures/Hercules.mp4",
  type: "mp4", // "mp4" | "hls"
};

const canvas = document.getElementById("theater-canvas");
const loaderEl = document.getElementById("loader");
const progressBar = document.getElementById("progress-bar");
const loaderText = document.getElementById("loader-text");
const btnAuto = document.getElementById("btn-auto");
const tabTheater = document.getElementById("tab-theater");
const tabBooking = document.getElementById("tab-booking");
const bookingPanel = document.getElementById("booking-panel");
const bookingPanelContent = document.getElementById("booking-panel-content");
const seatMapEl = document.getElementById("seat-map");
const previewCard = document.getElementById("preview-card");
const previewSeat = document.getElementById("preview-seat");
const previewNote = document.getElementById("preview-note");
const previewPrice = document.getElementById("preview-price");
const btnConfirm = document.getElementById("btn-confirm");
const btnRefocus = document.getElementById("btn-refocus");
const viewToast = document.getElementById("view-toast");
const viewToastText = document.getElementById("view-toast-text");
const cameraStatus = document.getElementById("camera-status");
const cameraStatusText = document.getElementById("camera-status-text");
const availFree = document.getElementById("avail-free");
const availTaken = document.getElementById("avail-taken");
const stepPick = document.getElementById("step-pick");
const stepView = document.getElementById("step-view");
const stepBook = document.getElementById("step-book");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
// Cap DPR — high-DPI + VideoTexture uploads is a common stutter source
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// Dark cyan night plate — matches the Visual Booking UI theme
const NIGHT = 0x050d10;
const scene = new THREE.Scene();
scene.background = new THREE.Color(NIGHT);
scene.fog = new THREE.FogExp2(NIGHT, 0.012);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.05,
  500
);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.045;
controls.rotateSpeed = 0.72;
controls.zoomSpeed = 0.85;
controls.panSpeed = 0.7;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.25;
controls.maxDistance = 80;
controls.target.set(0, 1.2, 0);

// Smooth booking-panel scroll (Lenis). 3D camera uses OrbitControls damping.
let bookingLenis = null;

function initBookingLenis() {
  if (bookingLenis || !bookingPanel || !bookingPanelContent) return;
  bookingLenis = new Lenis({
    wrapper: bookingPanel,
    content: bookingPanelContent,
    duration: 1.1,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    touchMultiplier: 1.2,
  });
}

function destroyBookingLenis() {
  if (!bookingLenis) return;
  bookingLenis.destroy();
  bookingLenis = null;
}

// Very low ambient so lamp washes + screen dominate
const hemi = new THREE.HemisphereLight(0x1a2238, 0x080604, 0.12);
scene.add(hemi);

const moon = new THREE.DirectionalLight(0x6a7aaa, 0.18);
moon.position.set(-18, 28, -6);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.camera.left = -40;
moon.shadow.camera.right = 40;
moon.shadow.camera.top = 40;
moon.shadow.camera.bottom = -40;
moon.shadow.bias = -0.00025;
scene.add(moon);

// Soft entrance key (kept low — wall lamps do most exterior work)
const frontSpot = new THREE.SpotLight(0xffc078, 12, 55, Math.PI / 5, 0.55, 1.4);
scene.add(frontSpot);
scene.add(frontSpot.target);

const topFocus = new THREE.SpotLight(0xc8d4ef, 4, 50, Math.PI / 3.5, 0.7, 1.3);
scene.add(topFocus);
scene.add(topFocus.target);

const entranceGlow = new THREE.PointLight(0xff9a3c, 8, 28, 2);
scene.add(entranceGlow);

// Screen spill into the house (primary interior light)
const screenGlow = new THREE.PointLight(0xfff4e8, 55, 32, 1.35);
scene.add(screenGlow);

const screenSpot = new THREE.SpotLight(0xffffff, 90, 42, Math.PI / 2.6, 0.55, 1.15);
scene.add(screenSpot);
scene.add(screenSpot.target);

// Mild warm fill over seats (boosted slightly in booking mode)
const interiorFill = new THREE.PointLight(0xffd2a8, 6, 28, 1.8);
scene.add(interiorFill);

/** @type {THREE.Light[]} */
const practicalLights = [];

/** Cinema realism layer — curtains, exit lights, video-tinted spill */
const cinema = {
  curtains: { left: null, right: null, leftRest: null, rightRest: null },
  curtainAnim: null,
  exitLights: [],
  seatAccentLight: null,
  sampleCanvas: null,
  sampleCtx: null,
  lastGlowSample: 0,
  curtainOpenOffset: 2.6,
  proceduralGroup: null,
  usesProceduralFallback: false,
};

let modelRoot = null;
let screenTarget = new THREE.Vector3(0, 2.8, -10);
let mode = "theater";
let autoOrbit = true;
let cameraTween = null;
let selectedSeatName = null;
let highlightMat = null;
let modelReady = false;
let isFlyingToSeat = false;
/** Starting orbit distance — zoom-out stops here; zoom-in still works */
let homeDistance = 28;

const defaultCam = new THREE.Vector3(18, 10, 22);
const defaultTarget = new THREE.Vector3(0, 1.5, 0);
const enterCam = new THREE.Vector3(0, 3.2, 14);
const enterTarget = new THREE.Vector3(0, 2.2, -2);

/** @type {Map<string, {obj: THREE.Object3D, row: number, index: number, col: number, price: number}>} */
const seats = new Map();
/** @type {Map<number, string[]>} */
const seatsByRow = new Map();

const TAKEN = new Set([
  "Seat_r1_5",
  "Seat_r1_6",
  "Seat_r3_20",
  "Seat_r4_40",
  "Seat_r5_55",
  "Seat_r6_70",
  "Seat_r7_90",
  "Seat_r8_120",
]);

function priceForRow(row) {
  if (row <= 2) return 200;
  if (row <= 6) return 280;
  return 180;
}

function parseSeatName(name) {
  const m = /^Seat_r(\d+)_(\d+)$/i.exec(name || "");
  if (!m) return null;
  return { row: Number(m[1]), index: Number(m[2]) };
}

function formatInr(n) {
  return `₹${n}`;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function setBookingSteps(phase) {
  // phase: "pick" | "flying" | "preview"
  stepPick.classList.toggle("is-active", phase === "pick");
  stepPick.classList.toggle("is-done", phase !== "pick");
  stepView.classList.toggle(
    "is-active",
    phase === "flying" || phase === "preview"
  );
  stepView.classList.toggle("is-done", phase === "preview");
  stepBook.classList.toggle("is-active", phase === "preview");
  stepBook.classList.remove("is-done");
}

function setFlightUi(active, seatLabel = "") {
  isFlyingToSeat = active;
  if (active) {
    cameraStatus.hidden = false;
    cameraStatusText.textContent = seatLabel
      ? `Flying to ${seatLabel}…`
      : "Flying to your seat…";
    viewToast.hidden = false;
    viewToastText.textContent = seatLabel
      ? `Moving camera to ${seatLabel}`
      : "Flying to your seat…";
    setBookingSteps("flying");
  } else {
    cameraStatus.hidden = true;
  }
}

function animateCameraTo(pos, target, duration = 1100, onDone) {
  const fromPos = camera.position.clone();
  const fromTarget = controls.target.clone();
  const start = performance.now();
  autoOrbit = false;
  btnAuto.setAttribute("aria-pressed", "false");

  cameraTween = {
    update(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = easeInOutCubic(t);
      camera.position.lerpVectors(fromPos, pos, e);
      controls.target.lerpVectors(fromTarget, target, e);
      controls.update();
      if (t >= 1) {
        cameraTween = null;
        if (onDone) onDone();
      }
    },
  };
}

/**
 * Cinematic fly: rise / approach seat from behind, then settle into seated POV.
 * Smooth 3-segment lerp through approach → mid → final.
 */
function animateCameraPath(waypoints, duration, onDone) {
  const start = performance.now();
  autoOrbit = false;
  btnAuto.setAttribute("aria-pressed", "false");
  controls.enabled = false;

  cameraTween = {
    update(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = easeInOutCubic(t);

      // 3 equal segments across 4 waypoints
      const segs = waypoints.length - 1;
      const scaled = e * segs;
      const i = Math.min(Math.floor(scaled), segs - 1);
      const local = easeOutCubic(scaled - i);
      const a = waypoints[i];
      const b = waypoints[i + 1];

      camera.position.lerpVectors(a.pos, b.pos, local);
      controls.target.lerpVectors(a.target, b.target, local);
      controls.update();

      if (t >= 1) {
        const last = waypoints[waypoints.length - 1];
        camera.position.copy(last.pos);
        controls.target.copy(last.target);
        controls.update();
        cameraTween = null;
        controls.enabled = true;
        if (onDone) onDone();
      }
    },
  };
}

function snapCameraTo(pos, target) {
  cameraTween = null;
  camera.position.copy(pos);
  controls.target.copy(target);
  controls.update();
}

function isRoofObject(obj) {
  // Keep Blender roof visible — U-shaped lid + cove rim (do not hide for orbit view)
  return false;
}

function meshMaterialKey(meshName, matName) {
  return `${(meshName || "").toLowerCase()} ${(matName || "").toLowerCase()}`;
}

function isSeatHighlightMesh(meshName, matName) {
  const key = meshMaterialKey(meshName, matName);
  if (/armrest|cup|holder|sticker|label|frame|metal|rail/.test(key)) return false;
  return /seat_fabric|seat_r\d|seat_back|seat_cushion/.test(key);
}

/** Tune materials for new cinema props from Blender */
function applyCinemaMaterialRules(mat, meshName) {
  const key = meshMaterialKey(meshName, mat.name);

  if (/speaker|subwoofer|lcr/.test(key)) {
    mat.color.setRGB(0.04, 0.04, 0.045);
    mat.roughness = 0.88;
    mat.metalness = 0.08;
    return;
  }
  if (/handrail|rail_|chrome|mat_metal|mat_chrome/.test(key)) {
    mat.color.setRGB(0.55, 0.56, 0.58);
    mat.roughness = 0.32;
    mat.metalness = 0.88;
    return;
  }
  if (/carpet|runner|mat_carpet|aisle_runner/.test(key)) {
    mat.color.setRGB(0.12, 0.08, 0.07);
    mat.roughness = 0.98;
    mat.metalness = 0;
    return;
  }
  if (/exit|emergency|mat_exit/.test(key)) {
    mat.emissive = mat.emissive || new THREE.Color();
    mat.emissive.setRGB(0.15, 0.95, 0.35);
    mat.emissiveIntensity = 4.2;
    mat.color.setRGB(0.08, 0.55, 0.22);
    return;
  }
  if (/armrest|cup|holder|mat_armrest|mat_cup|mat_plastic/.test(key)) {
    mat.color.setRGB(0.07, 0.07, 0.075);
    mat.roughness = 0.78;
    mat.metalness = 0.05;
    return;
  }
  if (/mask|masking|mat_mask|screen_mask/.test(key)) {
    mat.color.setRGB(0.015, 0.015, 0.018);
    mat.roughness = 0.96;
    mat.metalness = 0;
    return;
  }
  if (/acoustic|baffle|panel|mat_acoustic|mat_fabric/.test(key)) {
    mat.color.setRGB(0.82, 0.8, 0.78);
    mat.roughness = 0.94;
    mat.metalness = 0;
    return;
  }
  if (/soffit|mat_soffit/.test(key)) {
    mat.color.setRGB(0.02, 0.02, 0.025);
    mat.roughness = 0.9;
    return;
  }
  if (/roof|mat_roof|roof_lid|roof_top/.test(key) && !/cove/.test(key)) {
    mat.color.setRGB(0.04, 0.04, 0.05);
    mat.roughness = 0.92;
    mat.metalness = 0.02;
    return;
  }
  if (/cove|mat_cove|roof_cove/.test(key)) {
    mat.emissive = mat.emissive || new THREE.Color();
    mat.emissive.setRGB(1, 1, 1);
    mat.emissiveIntensity = 5.5;
    mat.color.setRGB(0.95, 0.95, 0.98);
    mat.roughness = 0.35;
    return;
  }
  if (/stage_lip|lip/.test(key)) {
    mat.color.setRGB(0.03, 0.03, 0.035);
    mat.roughness = 0.85;
    return;
  }
  if (/perfor|grille/.test(key)) {
    mat.color.setRGB(0.025, 0.025, 0.03);
    mat.roughness = 0.92;
    mat.metalness = 0.15;
    return;
  }
  if (/sticker|seat_label|row_label/.test(key)) {
    mat.emissive = mat.emissive || new THREE.Color();
    mat.emissive.setRGB(0.35, 0.35, 0.38);
    mat.emissiveIntensity = 0.6;
    mat.color.setRGB(0.75, 0.75, 0.78);
    return;
  }
  if (/curtain/.test(key)) {
    mat.color.setRGB(0.28, 0.04, 0.06);
    mat.roughness = 0.92;
    mat.metalness = 0;
  }
}

function applyHomeZoomLimits() {
  controls.maxDistance = homeDistance;
  controls.minDistance = Math.max(0.4, homeDistance * 0.06);
}

/** Prefer building meshes so roads/grass don't pull framing off-center */
function getTheaterFocusBox(object) {
  const box = new THREE.Box3();
  let found = false;
  const focusNames = /^(Wall_Shell|Wall_Front|Screen_|Stage|Floor_|Seat_)/i;

  object.traverse((child) => {
    if (!child.isMesh) return;
    if (!focusNames.test(child.name || "")) return;
    box.expandByObject(child);
    found = true;
  });

  if (!found) box.setFromObject(object);
  return box;
}

function isMobileView() {
  return window.innerWidth <= 720 || window.innerHeight / window.innerWidth > 1.15;
}

function fitCameraToObject(object) {
  const box = getTheaterFocusBox(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const mobile = isMobileView();
  // Portrait phones need more distance + higher angle so the house clears UI chrome
  const distance = maxDim * (mobile ? 2.05 : 1.35);

  // Look slightly lower on mobile so the building sits in the upper half of the frame
  defaultTarget.set(
    center.x,
    center.y + size.y * (mobile ? -0.04 : 0.04),
    center.z
  );

  defaultCam.set(
    center.x + distance * (mobile ? 0.52 : 0.5),
    center.y + distance * (mobile ? 0.68 : 0.48),
    center.z + distance * (mobile ? 0.62 : 0.52)
  );

  enterTarget.set(center.x, center.y + size.y * 0.12, center.z - size.z * 0.02);
  enterCam.set(
    center.x,
    center.y + size.y * (mobile ? 0.55 : 0.4),
    center.z + size.z * (mobile ? 0.28 : 0.18)
  );

  homeDistance = defaultCam.distanceTo(defaultTarget);
  applyHomeZoomLimits();

  camera.fov = mobile ? 56 : 50;
  camera.updateProjectionMatrix();

  camera.position.copy(defaultCam);
  controls.target.copy(defaultTarget);
  controls.update();
  return { size, center, maxDim };
}

function aimFocusLights(center, size) {
  frontSpot.position.set(center.x, center.y + size.y * 0.55, center.z + size.z * 0.72);
  frontSpot.target.position.set(center.x, center.y + size.y * 0.15, center.z + size.z * 0.15);
  frontSpot.target.updateMatrixWorld();

  topFocus.position.set(center.x, center.y + size.y * 1.4, center.z + size.z * 0.05);
  topFocus.target.position.set(center.x, center.y + size.y * 0.05, center.z - size.z * 0.1);
  topFocus.target.updateMatrixWorld();

  entranceGlow.position.set(center.x, center.y + size.y * 0.28, center.z + size.z * 0.42);
  interiorFill.position.set(center.x, center.y + size.y * 0.35, center.z - size.z * 0.05);
}

function aimScreenLights() {
  // Keep spill lights in front of the screen (toward seats), not on the surface
  // — a light sitting on the mesh looks like a white hot-spot when video is black/loading
  screenGlow.position.set(screenTarget.x, screenTarget.y, screenTarget.z - 1.8);
  screenSpot.position.set(screenTarget.x, screenTarget.y, screenTarget.z - 0.9);
  screenSpot.target.position.set(0, 1.4, -12);
  screenSpot.target.updateMatrixWorld();
}

/**
 * Cinematic practicals matching the Blender lighting view:
 * - Warm SpotLights from each Lamp_Head washing up the brick shell
 * - Small cool PointLights on aisle markers
 * - Soft bollard pools along the ring
 */
function addPracticalLights(root) {
  root.updateMatrixWorld(true);

  // Clear previous practicals (hot reload / re-init safety)
  for (const light of practicalLights) {
    scene.remove(light);
    if (light.target) scene.remove(light.target);
    light.dispose?.();
  }
  practicalLights.length = 0;

  const theaterCore = new THREE.Vector3(0, 2.2, -10);

  root.traverse((child) => {
    if (!child.isMesh) return;
    const n = (child.name || "").toLowerCase();
    const world = new THREE.Vector3();
    child.getWorldPosition(world);

    if (n.startsWith("lamp_head")) {
      // Local warm bulb at the fixture
      const bulb = new THREE.PointLight(0xffd7a0, 3.2, 7, 2.2);
      bulb.position.copy(world);
      scene.add(bulb);
      practicalLights.push(bulb);

      // Wall-wash cone aimed at the brick shell (up + slightly inward)
      const toCore = theaterCore.clone().sub(world);
      toCore.y = 0;
      if (toCore.lengthSq() < 0.001) toCore.set(0, 0, 1);
      toCore.normalize();

      const washTarget = world
        .clone()
        .addScaledVector(toCore, 2.8)
        .add(new THREE.Vector3(0, 3.4, 0));

      const wash = new THREE.SpotLight(
        0xffb15a,
        55,
        18,
        Math.PI / 5.5,
        0.42,
        1.35
      );
      wash.position.copy(world);
      wash.position.y += 0.05;
      wash.target.position.copy(washTarget);
      scene.add(wash);
      scene.add(wash.target);
      wash.target.updateMatrixWorld();
      practicalLights.push(wash);
      return;
    }

    if (n.startsWith("aislelight")) {
      const aisle = new THREE.PointLight(0xf2f6ff, 2.4, 3.2, 2.4);
      aisle.position.copy(world);
      aisle.position.y += 0.08;
      scene.add(aisle);
      practicalLights.push(aisle);
      return;
    }

    if (n.includes("step_light") || n.includes("aisle_led") || n.includes("stage_lip")) {
      const step = new THREE.PointLight(0xffc890, 0.85, 2.2, 2.2);
      step.position.copy(world);
      step.position.y += 0.04;
      scene.add(step);
      practicalLights.push(step);
      return;
    }

    if (n.startsWith("roof_cove") || n.startsWith("cove_")) {
      const cove = new THREE.PointLight(0xfff8f0, 2.8, 5, 2);
      cove.position.copy(world);
      scene.add(cove);
      practicalLights.push(cove);
      return;
    }

    // Every other bollard — soft ground pools without flooding the scene
    if (n.startsWith("bollard")) {
      const idx = Number((child.name.match(/\.(\d+)$/) || [])[1] || 0);
      if (idx % 2 === 1) return;
      const pool = new THREE.PointLight(0xffc078, 1.1, 4.5, 2.5);
      pool.position.copy(world);
      pool.position.y += 0.55;
      scene.add(pool);
      practicalLights.push(pool);
    }
  });

  console.log(`[3D Theater] Practical lights: ${practicalLights.length}`);
}

function collectCinemaLayer(root) {
  cinema.curtains.left = root.getObjectByName("Curtain_Left");
  cinema.curtains.right = root.getObjectByName("Curtain_Right");

  if (cinema.curtains.left) {
    cinema.curtains.leftRest = cinema.curtains.left.position.clone();
  }
  if (cinema.curtains.right) {
    cinema.curtains.rightRest = cinema.curtains.right.position.clone();
  }

  // Estimate open travel from screen width if curtains exist
  const screen = root.getObjectByName("Screen_Surface");
  if (screen && cinema.curtains.leftRest) {
    const box = new THREE.Box3().setFromObject(screen);
    const size = box.getSize(new THREE.Vector3());
    cinema.curtainOpenOffset = Math.max(2.2, size.x * 0.38);
  }

  setupExitLights(root);

  if (!cinema.seatAccentLight) {
    cinema.seatAccentLight = new THREE.PointLight(0x2ec4c6, 0, 2.8, 2);
    scene.add(cinema.seatAccentLight);
  }

  const found = {
    curtains: !!(cinema.curtains.left && cinema.curtains.right),
    exitLights: cinema.exitLights.length,
  };
  console.log("[3D Theater] Cinema layer:", found);
}

function hasCinemaProp(root, pattern) {
  let found = false;
  root.traverse((obj) => {
    if (found || obj.name === "Procedural_Cinema") return;
    if (pattern.test(obj.name || "")) found = true;
  });
  return found;
}

/**
 * Sample outer top ring from Wall_Shell so the roof follows the curved walls.
 */
function sampleWallTopRing(shellMesh, yBand = 0.22) {
  shellMesh.updateWorldMatrix(true, false);
  const posAttr = shellMesh.geometry.getAttribute("position");
  const v = new THREE.Vector3();
  let maxY = -Infinity;

  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(shellMesh.matrixWorld);
    if (v.y > maxY) maxY = v.y;
  }

  const minY = maxY - yBand;
  const deduped = new Map();
  for (let i = 0; i < posAttr.count; i++) {
    v.fromBufferAttribute(posAttr, i).applyMatrix4(shellMesh.matrixWorld);
    if (v.y < minY) continue;
    const key = `${Math.round(v.x * 24)}_${Math.round(v.z * 24)}`;
    if (!deduped.has(key)) deduped.set(key, new THREE.Vector3(v.x, v.y, v.z));
  }

  const points = [...deduped.values()];
  if (points.length < 8) return { roofY: maxY, arc: [], centerX: 0, centerZ: 0 };

  let cx = 0;
  let cz = 0;
  for (const p of points) {
    cx += p.x;
    cz += p.z;
  }
  cx /= points.length;
  cz /= points.length;

  const tagged = points
    .map((p) => ({ p, a: Math.atan2(p.z - cz, p.x - cx) }))
    .sort((a, b) => a.a - b.a);

  // Largest angular gap = front opening — only roof the wall arc, not a chord across the U
  const n = tagged.length;
  let maxGap = -1;
  let openAt = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let gap = tagged[j].a - tagged[i].a;
    if (j === 0) gap += Math.PI * 2;
    if (gap > maxGap) {
      maxGap = gap;
      openAt = j;
    }
  }

  const target = 40;
  const step = Math.max(1, Math.floor(n / target));
  const arc = [];
  for (let i = 0; i < n - 1; i++) {
    const idx = (openAt + i) % n;
    if (i % step === 0) arc.push(tagged[idx].p);
  }
  if (arc.length && arc[arc.length - 1] !== tagged[(openAt + n - 2) % n].p) {
    arc.push(tagged[(openAt + n - 2) % n].p);
  }

  return { roofY: maxY, arc, centerX: cx, centerZ: cz };
}

function addRingSegment(addMesh, mat, p0, p1, roofY, thick, depth, name) {
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dz) || 0.01;
  const midX = (p0.x + p1.x) / 2;
  const midZ = (p0.z + p1.z) / 2;
  const mesh = addMesh(
    new THREE.BoxGeometry(len, thick, depth),
    mat,
    midX,
    roofY,
    midZ,
    1,
    1,
    1,
    name
  );
  mesh.rotation.y = Math.atan2(dx, dz);
  return mesh;
}

/**
 * Roof ring aligned to Wall_Shell curve + Wall_Front lip (Blender U-lid look).
 */
function buildProceduralRoof(root, addMesh) {
  const roofMat = new THREE.MeshStandardMaterial({
    color: 0x060608,
    roughness: 0.93,
    metalness: 0.02,
  });
  const coveMat = new THREE.MeshStandardMaterial({
    color: 0xf8f8fc,
    emissive: 0xffffff,
    emissiveIntensity: 5.5,
    roughness: 0.35,
  });

  const shell = root.getObjectByName("Wall_Shell");
  const frontWall = root.getObjectByName("Wall_Front");
  const thick = 0.18;
  const depth = 1.05;
  let shellRoofY = null;

  if (shell?.isMesh) {
    const { roofY, arc, centerX, centerZ } = sampleWallTopRing(shell);
    shellRoofY = roofY;

    for (let i = 0; i < arc.length - 1; i++) {
      addRingSegment(
        addMesh,
        roofMat,
        arc[i],
        arc[i + 1],
        roofY + thick / 2,
        thick,
        depth,
        `Roof_Shell_${i}`
      );
    }

    const coveY = roofY - 0.04;
    const inset = 0.82;
    for (let i = 0; i < arc.length - 1; i++) {
      const p0 = arc[i];
      const p1 = arc[i + 1];
      const i0 = new THREE.Vector3(
        p0.x + (centerX - p0.x) * inset,
        p0.y,
        p0.z + (centerZ - p0.z) * inset
      );
      const i1 = new THREE.Vector3(
        p1.x + (centerX - p1.x) * inset,
        p1.y,
        p1.z + (centerZ - p1.z) * inset
      );
      addRingSegment(
        addMesh,
        coveMat,
        i0,
        i1,
        coveY,
        0.08,
        0.07,
        `Cove_Shell_${i}`
      );
    }
  }

  if (frontWall?.isMesh) {
    frontWall.updateWorldMatrix(true, false);
    const fb = new THREE.Box3().setFromObject(frontWall);
    const fs = fb.getSize(new THREE.Vector3());
    const fc = fb.getCenter(new THREE.Vector3());
    const lipY = (shellRoofY ?? fb.max.y) + thick / 2;
    const lipW = fs.x * 0.34;

    addMesh(
      new THREE.BoxGeometry(lipW, thick, depth),
      roofMat,
      fc.x - fs.x * 0.33,
      lipY,
      fc.z,
      1,
      1,
      1,
      "Roof_Front_L"
    );
    addMesh(
      new THREE.BoxGeometry(lipW, thick, depth),
      roofMat,
      fc.x + fs.x * 0.33,
      lipY,
      fc.z,
      1,
      1,
      1,
      "Roof_Front_R"
    );

    const coveY = lipY - thick / 2 - 0.04;
    addMesh(
      new THREE.BoxGeometry(lipW * 0.85, 0.08, 0.07),
      coveMat,
      fc.x - fs.x * 0.33,
      coveY,
      fc.z - 0.45,
      1,
      1,
      1,
      "Cove_Front_L"
    );
    addMesh(
      new THREE.BoxGeometry(lipW * 0.85, 0.08, 0.07),
      coveMat,
      fc.x + fs.x * 0.33,
      coveY,
      fc.z - 0.45,
      1,
      1,
      1,
      "Cove_Front_R"
    );
  }

  if (!shell?.isMesh && !frontWall?.isMesh) {
    const box = getTheaterFocusBox(root);
    buildProceduralRoofFallback(
      box.getCenter(new THREE.Vector3()),
      box.getSize(new THREE.Vector3()),
      addMesh,
      roofMat,
      coveMat
    );
  }
}

/** Rectangular fallback — back at min Z, front at max Z */
function buildProceduralRoofFallback(center, size, addMesh, roofMat, coveMat) {
  const roofY = center.y + size.y * 0.47;
  const thick = 0.2;
  const frame = Math.max(1.05, size.x * 0.11);
  const outerW = size.x * 0.9;
  const outerD = size.z * 0.86;
  const backZ = center.z - outerD / 2;
  const frontZ = center.z + outerD / 2;
  const halfW = outerW / 2;

  addMesh(
    new THREE.BoxGeometry(outerW, thick, frame),
    roofMat,
    center.x,
    roofY,
    backZ + frame / 2,
    1,
    1,
    1,
    "Roof_Back"
  );
  const sideLen = outerD - frame * 1.6;
  addMesh(
    new THREE.BoxGeometry(frame, thick, sideLen),
    roofMat,
    center.x - halfW + frame / 2,
    roofY,
    center.z,
    1,
    1,
    1,
    "Roof_Left"
  );
  addMesh(
    new THREE.BoxGeometry(frame, thick, sideLen),
    roofMat,
    center.x + halfW - frame / 2,
    roofY,
    center.z,
    1,
    1,
    1,
    "Roof_Right"
  );
  const frontLipW = outerW * 0.34;
  addMesh(
    new THREE.BoxGeometry(frontLipW, thick, frame),
    roofMat,
    center.x - halfW + frontLipW / 2,
    roofY,
    frontZ - frame / 2,
    1,
    1,
    1,
    "Roof_Front_L"
  );
  addMesh(
    new THREE.BoxGeometry(frontLipW, thick, frame),
    roofMat,
    center.x + halfW - frontLipW / 2,
    roofY,
    frontZ - frame / 2,
    1,
    1,
    1,
    "Roof_Front_R"
  );
}

/**
 * When 3d_theater.glb is stale (not re-exported from Blender), add cinema props in code
 * so the site still shows speakers, handrails, EXIT signs, masking, etc.
 */
function buildProceduralCinemaLayer(root) {
  if (cinema.proceduralGroup) {
    root.remove(cinema.proceduralGroup);
    cinema.proceduralGroup.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => m?.dispose?.());
    });
    cinema.proceduralGroup = null;
  }

  const needs = {
    roof: !hasCinemaProp(root, /^roof_|roof_lid|roof_top|roof_frame/i),
    speakers: !hasCinemaProp(root, /speaker|subwoofer|lcr/i),
    handrails: !hasCinemaProp(root, /handrail|rail_/i),
    exits: !hasCinemaProp(root, /^exit/i),
    carpet: !hasCinemaProp(root, /carpet|runner/i),
    mask: !hasCinemaProp(root, /screen_mask|mask/i),
  };

  if (!Object.values(needs).some(Boolean)) {
    cinema.usesProceduralFallback = false;
    console.log("[3D Theater] GLB includes cinema props — procedural layer skipped");
    return;
  }

  cinema.usesProceduralFallback = true;
  console.warn(
    "[3D Theater] Using procedural cinema props — re-export 3d_theater.glb from Blender to use your updated model"
  );

  const box = getTheaterFocusBox(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const screen = root.getObjectByName("Screen_Surface");
  const screenBox = screen
    ? new THREE.Box3().setFromObject(screen)
    : box.clone();
  const screenCenter = screenBox.getCenter(new THREE.Vector3());
  const screenSize = screenBox.getSize(new THREE.Vector3());

  const group = new THREE.Group();
  group.name = "Procedural_Cinema";

  const speakerMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0c,
    roughness: 0.88,
    metalness: 0.08,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x8a8d92,
    roughness: 0.32,
    metalness: 0.88,
  });
  const carpetMat = new THREE.MeshStandardMaterial({
    color: 0x1a100e,
    roughness: 0.98,
    metalness: 0,
  });
  const exitMat = new THREE.MeshStandardMaterial({
    color: 0x0e6630,
    emissive: 0x22ee66,
    emissiveIntensity: 3.8,
    roughness: 0.6,
  });
  const maskMat = new THREE.MeshStandardMaterial({
    color: 0x020203,
    roughness: 0.96,
    metalness: 0,
  });
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0xd4d0cc,
    roughness: 0.94,
    metalness: 0,
  });

  const addMesh = (geo, mat, x, y, z, sx = 1, sy = 1, sz = 1, name = "") => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    m.receiveShadow = true;
    if (name) m.name = name;
    group.add(m);
    return m;
  };

  // --- Screen black masking ---
  if (needs.mask && screenSize.x > 0) {
    const t = 0.14;
    const pad = 0.22;
    const sx = screenSize.x + pad * 2;
    const sy = screenSize.y + pad * 2;
    const sz = screenSize.z + 0.08;
    const sc = screenCenter;
    addMesh(
      new THREE.BoxGeometry(1, 1, 1),
      maskMat,
      sc.x,
      sc.y + sy / 2 + t / 2,
      sc.z - 0.04,
      sx, t, sz,
      "Screen_Mask_Top"
    );
    addMesh(
      new THREE.BoxGeometry(1, 1, 1),
      maskMat,
      sc.x,
      sc.y - sy / 2 - t / 2,
      sc.z - 0.04,
      sx, t, sz,
      "Screen_Mask_Bottom"
    );
    addMesh(
      new THREE.BoxGeometry(1, 1, 1),
      maskMat,
      sc.x - sx / 2 - t / 2,
      sc.y,
      sc.z - 0.04,
      t, sy, sz,
      "Screen_Mask_Left"
    );
    addMesh(
      new THREE.BoxGeometry(1, 1, 1),
      maskMat,
      sc.x + sx / 2 + t / 2,
      sc.y,
      sc.z - 0.04,
      t, sy, sz,
      "Screen_Mask_Right"
    );
  }

  // --- LCR + wall speakers ---
  if (needs.speakers) {
    const frontZ = screenCenter.z + 0.35;
    const lcrY = center.y - size.y * 0.12;

    for (const [name, x, y, h] of [
      ["Speaker_LCR_L", screenCenter.x - screenSize.x * 0.38, lcrY, 0.55],
      ["Speaker_LCR_C", screenCenter.x, lcrY - 0.15, 0.45],
      ["Speaker_LCR_R", screenCenter.x + screenSize.x * 0.38, lcrY, 0.55],
    ]) {
      addMesh(new THREE.BoxGeometry(0.55, 0.45, 0.28), speakerMat, x, y, frontZ, 1, 1, 1, name);
    }

    const wallX = size.x * 0.42;
    const wallZs = [
      center.z - size.z * 0.28,
      center.z - size.z * 0.05,
      center.z + size.z * 0.18,
    ];
    for (let i = 0; i < wallZs.length; i++) {
      const z = wallZs[i];
      const h = 1.6 + (i % 2) * 0.3;
      addMesh(
        new THREE.BoxGeometry(0.38, h, 0.32),
        speakerMat,
        center.x - wallX,
        center.y + h * 0.45,
        z,
        1, 1, 1,
        `Speaker_Wall_L_${i}`
      );
      addMesh(
        new THREE.BoxGeometry(0.38, h, 0.32),
        speakerMat,
        center.x + wallX,
        center.y + h * 0.45,
        z,
        1, 1, 1,
        `Speaker_Wall_R_${i}`
      );
    }
  }

  // --- EXIT signs (rear corners) ---
  if (needs.exits) {
    const exitY = center.y + size.y * 0.55;
    const exitZ = center.z + size.z * 0.38;
    for (const [name, x] of [
      ["Exit_Left", center.x - size.x * 0.38],
      ["Exit_Right", center.x + size.x * 0.38],
    ]) {
      addMesh(new THREE.BoxGeometry(0.65, 0.22, 0.06), exitMat, x, exitY, exitZ, 1, 1, 1, name);
    }
  }

  // --- Aisle carpet + handrails ---
  const aisleX = center.x;
  const frontZ = center.z - size.z * 0.38;
  const backZ = center.z + size.z * 0.32;
  const midZ = (frontZ + backZ) * 0.5;

  if (needs.carpet) {
    addMesh(
      new THREE.BoxGeometry(0.95, 0.02, Math.abs(backZ - frontZ)),
      carpetMat,
      aisleX,
      center.y + 0.06,
      (frontZ + backZ) / 2,
      1, 1, 1,
      "Aisle_Runner_Center"
    );
    addMesh(
      new THREE.BoxGeometry(size.x * 0.55, 0.02, 0.85),
      carpetMat,
      center.x,
      center.y + 0.06,
      midZ,
      1, 1, 1,
      "Aisle_Runner_Cross"
    );
  }

  if (needs.handrails) {
    const postGeo = new THREE.CylinderGeometry(0.035, 0.04, 1, 8);
    const railLen = Math.abs(backZ - frontZ);
    const railY = center.y + 0.82;

    addMesh(
      new THREE.BoxGeometry(0.05, 0.05, railLen),
      metalMat,
      aisleX - 0.48,
      railY,
      (frontZ + backZ) / 2,
      1, 1, 1,
      "Handrail_Center_L"
    );
    addMesh(
      new THREE.BoxGeometry(0.05, 0.05, railLen),
      metalMat,
      aisleX + 0.48,
      railY,
      (frontZ + backZ) / 2,
      1, 1, 1,
      "Handrail_Center_R"
    );

    for (let z = frontZ; z <= backZ; z += 1.8) {
      addMesh(postGeo, metalMat, aisleX - 0.48, railY - 0.4, z, 1, 0.8, 1, "Handrail_Post");
      addMesh(postGeo, metalMat, aisleX + 0.48, railY - 0.4, z, 1, 0.8, 1, "Handrail_Post");
    }

    addMesh(
      new THREE.BoxGeometry(size.x * 0.5, 0.05, 0.05),
      metalMat,
      center.x,
      railY,
      midZ,
      1, 1, 1,
      "Handrail_Cross"
    );
  }

  // --- Acoustic panels on curved walls ---
  if (needs.speakers) {
    const panelCount = 5;
    for (let i = 0; i < panelCount; i++) {
      const t = i / (panelCount - 1);
      const z = frontZ + (backZ - frontZ) * t * 0.85;
      const xOff = size.x * 0.36;
      addMesh(
        new THREE.BoxGeometry(0.06, 1.1, 0.55),
        panelMat,
        center.x - xOff,
        center.y + 0.9,
        z,
        1, 1, 1,
        `Acoustic_Panel_L_${i}`
      );
      addMesh(
        new THREE.BoxGeometry(0.06, 1.1, 0.55),
        panelMat,
        center.x + xOff,
        center.y + 0.9,
        z,
        1, 1, 1,
        `Acoustic_Panel_R_${i}`
      );
    }
  }

  // --- Blender-style U roof + cove rim ---
  if (needs.roof) {
    buildProceduralRoof(root, addMesh);
  }

  root.add(group);
  cinema.proceduralGroup = group;
  setupExitLights(root);
  if (needs.roof) setupCoveLights(root);
}

function setupCoveLights(root) {
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh) return;
    const n = (child.name || "").toLowerCase();
    if (!n.startsWith("cove_") && !n.startsWith("roof_cove")) return;

    const world = new THREE.Vector3();
    child.getWorldPosition(world);
    const cove = new THREE.PointLight(0xfff8f0, 2.4, 4.5, 2);
    cove.position.copy(world);
    scene.add(cove);
    practicalLights.push(cove);
  });
}

function setupExitLights(root) {
  for (const light of cinema.exitLights) {
    scene.remove(light);
    light.dispose?.();
  }
  cinema.exitLights.length = 0;

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh) return;
    const n = (child.name || "").toLowerCase();
    if (!/^exit/.test(n) && !n.includes("exit_sign") && !n.includes("emergency")) return;

    const world = new THREE.Vector3();
    child.getWorldPosition(world);
    const glow = new THREE.PointLight(0x44ff88, 1.4, 5.5, 2);
    glow.position.copy(world);
    glow.position.y += 0.12;
    scene.add(glow);
    cinema.exitLights.push(glow);
  });
}

function animateCurtains(open, duration = 1400) {
  const { left, right, leftRest, rightRest } = cinema.curtains;
  if (!left || !right || !leftRest || !rightRest) return;

  const offset = cinema.curtainOpenOffset;
  const endL = leftRest.clone().add(new THREE.Vector3(-offset, 0, 0));
  const endR = rightRest.clone().add(new THREE.Vector3(offset, 0, 0));

  cinema.curtainAnim = {
    start: performance.now(),
    duration,
    left,
    right,
    fromL: left.position.clone(),
    fromR: right.position.clone(),
    toL: open ? endL : leftRest.clone(),
    toR: open ? endR : rightRest.clone(),
  };
}

function updateCurtainAnim(now) {
  const anim = cinema.curtainAnim;
  if (!anim) return;

  const t = Math.min(1, (now - anim.start) / anim.duration);
  const e = easeInOutCubic(t);
  anim.left.position.lerpVectors(anim.fromL, anim.toL, e);
  anim.right.position.lerpVectors(anim.fromR, anim.toR, e);

  if (t >= 1) cinema.curtainAnim = null;
}

function ensureGlowSampler() {
  if (cinema.sampleCanvas) return;
  cinema.sampleCanvas = document.createElement("canvas");
  cinema.sampleCanvas.width = 16;
  cinema.sampleCanvas.height = 9;
  cinema.sampleCtx = cinema.sampleCanvas.getContext("2d", {
    willReadFrequently: true,
  });
}

/** Tint screen spill from trailer color — sells the interior lighting */
function updateScreenGlowFromVideo(now) {
  if (now - cinema.lastGlowSample < 180) return;
  cinema.lastGlowSample = now;

  const tex = scene.userData.screenTex;
  const video = tex?.userData?.video;
  if (!video || video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) {
    return;
  }

  ensureGlowSampler();
  const { sampleCtx, sampleCanvas } = cinema;
  sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
  const { data } = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);

  let r = 0;
  let g = 0;
  let b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  r /= n;
  g /= n;
  b /= n;

  const tint = new THREE.Color(r / 255, g / 255, b / 255);
  tint.lerp(new THREE.Color(0xfff4e8), 0.32);
  screenGlow.color.copy(tint);
  screenSpot.color.copy(tint);

  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const bookingBoost = mode === "booking" ? 1.22 : 1;
  const baseGlow = mode === "booking" ? 70 : 55;
  const baseSpot = mode === "booking" ? 110 : 90;
  screenGlow.intensity = baseGlow * (0.52 + lum * 0.95) * bookingBoost;
  screenSpot.intensity = baseSpot * (0.48 + lum * 1.15) * bookingBoost;
}

function makeScreenMovieTexture() {
  const video = document.createElement("video");
  // Same-origin local MP4: do not set crossOrigin (breaks WebGL video textures)
  video.loop = true;
  video.muted = true;
  video.defaultMuted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("muted", "");
  video.disablePictureInPicture = true;
  // Some browsers only decode reliably when the element is in the DOM
  video.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;";
  document.body.appendChild(video);

  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.format = THREE.RGBAFormat;
  tex.generateMipmaps = false;
  tex.flipY = true;
  tex.userData.video = video;
  tex.userData.hls = null;

  // Use Three's VideoTexture.update, lightly throttled for high-refresh displays
  const baseUpdate = tex.update.bind(tex);
  let lastUpload = 0;
  tex.update = function throttledVideoUpdate() {
    if (video.readyState < video.HAVE_CURRENT_DATA || video.paused) return;
    const now = performance.now();
    if (now - lastUpload < 16) return;
    lastUpload = now;
    baseUpdate();
  };

  video.addEventListener("error", () => {
    const err = video.error;
    console.error(
      "[3D Theater] Screen video failed:",
      err?.message || err?.code || err,
      SCREEN_MEDIA.src
    );
  });

  video.addEventListener("loadeddata", () => {
    tex.needsUpdate = true;
    console.log(
      "[3D Theater] Screen video loaded",
      video.videoWidth,
      "x",
      video.videoHeight
    );
  });

  const tryPlay = () => {
    video.muted = true;
    const p = video.play();
    if (p && typeof p.catch === "function") {
      p.then(() => {
        tex.needsUpdate = true;
        console.log("[3D Theater] Screen video playing");
      }).catch((err) => {
        console.warn(
          "[3D Theater] Autoplay blocked — click/drag to start",
          err?.message || err
        );
      });
    }
  };

  const unlock = () => {
    video.muted = true;
    video.play().then(() => {
      tex.needsUpdate = true;
    }).catch(() => {});
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) video.pause();
    else tryPlay();
  });

  attachScreenSource(video, tex).then(() => {
    tryPlay();
    video.addEventListener("canplay", tryPlay, { once: true });
  });

  return tex;
}

/**
 * Attach progressive MP4 or HLS (for large future trailers).
 */
async function attachScreenSource(video, tex) {
  const { src, type } = SCREEN_MEDIA;

  if (type === "hls" || /\.m3u8($|\?)/i.test(src)) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.load();
      return;
    }
    try {
      const { default: Hls } = await import(
        "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.mjs"
      );
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 20,
          maxMaxBufferLength: 40,
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        tex.userData.hls = hls;
        return;
      }
    } catch (err) {
      console.warn("[3D Theater] HLS load failed, falling back to src", err);
    }
  }

  const bust = src.includes("?") ? "&" : "?";
  video.src = `${src}${bust}v=vid3`;
  video.load();
}

function ensureScreenVideoPlaying() {
  const tex = scene.userData.screenTex;
  const video = tex?.userData?.video;
  if (!video) return;
  video.muted = true;
  if (video.paused || video.ended) {
    video.play().then(() => {
      tex.needsUpdate = true;
    }).catch(() => {});
  } else {
    tex.needsUpdate = true;
  }
}

/** Force Screen_Surface to use a dedicated live video material */
function applyVideoToScreenMesh(root, screenTex) {
  const screen = root.getObjectByName("Screen_Surface");
  if (!screen || !screen.isMesh) {
    console.warn("[3D Theater] Screen_Surface mesh not found");
    return;
  }

  // GLB screen has no UVs (POSITION+NORMAL only) — video can't map without them
  ensurePlanarUVs(screen);

  screen.material = new THREE.MeshBasicMaterial({
    name: "Mat_Screen_Video",
    map: screenTex,
    color: 0xffffff,
    toneMapped: false, // keep trailer bright under ACES
    side: THREE.DoubleSide,
  });
  screen.castShadow = false;
  screen.receiveShadow = false;
  screen.renderOrder = 2;
  // Nudge toward seats so it sits in front of the frame/wall
  screen.position.z -= 0.02;
  console.log("[3D Theater] Video material applied to Screen_Surface");
}

/** Build 0–1 UVs from local X/Y bounds (screen faces the seats on XY). */
function ensurePlanarUVs(mesh) {
  const geom = mesh.geometry;
  if (!geom) return;

  if (geom.getAttribute("uv")) {
    console.log("[3D Theater] Screen already has UVs");
    return;
  }

  const pos = geom.getAttribute("position");
  if (!pos) return;

  geom.computeBoundingBox();
  const box = geom.boundingBox;
  const dx = box.max.x - box.min.x || 1;
  const dy = box.max.y - box.min.y || 1;
  const dz = box.max.z - box.min.z || 1;

  // Pick the two largest axes as the screen plane (handles any orientation)
  const axes = [
    { axis: "x", size: dx },
    { axis: "y", size: dy },
    { axis: "z", size: dz },
  ].sort((a, b) => b.size - a.size);
  const uAxis = axes[0].axis;
  const vAxis = axes[1].axis;
  const uMin = box.min[uAxis];
  const vMin = box.min[vAxis];
  const uSize = axes[0].size;
  const vSize = axes[1].size;

  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const u =
      uAxis === "x" ? pos.getX(i) : uAxis === "y" ? pos.getY(i) : pos.getZ(i);
    const v =
      vAxis === "x" ? pos.getX(i) : vAxis === "y" ? pos.getY(i) : pos.getZ(i);
    // 180° UV rotate: fixes upside-down + mirrored mapping from the seats
    uvs[i * 2] = 1 - (u - uMin) / uSize;
    uvs[i * 2 + 1] = (v - vMin) / vSize;
  }

  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.attributes.uv.needsUpdate = true;
  console.log(
    `[3D Theater] Generated screen UVs on ${uAxis}/${vAxis} (${pos.count} verts)`
  );
}

function collectSeats(root) {
  seats.clear();
  seatsByRow.clear();
  root.updateMatrixWorld(true);

  root.traverse((child) => {
    const parsed = parseSeatName(child.name);
    if (!parsed) return;
    if (seats.has(child.name)) return;
    seats.set(child.name, {
      obj: child,
      row: parsed.row,
      index: parsed.index,
      col: 0,
      price: priceForRow(parsed.row),
    });
  });

  const rowMap = new Map();
  for (const [name, seat] of seats) {
    if (!rowMap.has(seat.row)) rowMap.set(seat.row, []);
    const p = new THREE.Vector3();
    seat.obj.getWorldPosition(p);
    rowMap.get(seat.row).push({ name, seat, x: p.x });
  }

  for (const [row, list] of rowMap) {
    list.sort((a, b) => a.x - b.x);
    const names = [];
    list.forEach(({ name, seat }, col) => {
      seat.col = col;
      names.push(name);
    });
    seatsByRow.set(row, names);
  }

  console.log(`[3D Theater] Seats indexed: ${seats.size}, rows: ${seatsByRow.size}`);
}

function applyMaterials(root) {
  const screenTex = makeScreenMovieTexture();
  scene.userData.screenTex = screenTex;

  root.traverse((child) => {
    if (isRoofObject(child)) {
      child.visible = false;
      return;
    }
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    if (!child.material) return;

    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
      const name = (mat.name || "").toLowerCase();
      const meshName = child.name || "";

      applyCinemaMaterialRules(mat, meshName);

      if (name.includes("grass") || name.includes("hedge")) {
        mat.color.setRGB(0.03, 0.08, 0.04);
        mat.roughness = 1;
      } else if (name.includes("pavement") || name.includes("boundary")) {
        mat.color.multiplyScalar(0.55);
        mat.roughness = 0.95;
      } else if (name.includes("road") && !name.includes("line")) {
        mat.color.setRGB(0.03, 0.03, 0.035);
      } else if (name.includes("floor")) {
        mat.color.setRGB(0.06, 0.06, 0.07);
        mat.roughness = 0.92;
      } else if (name.includes("brick") || name.includes("wall")) {
        // Keep brick readable under warm washes
        mat.roughness = Math.min(mat.roughness ?? 0.9, 0.88);
        if (name.includes("brick_out") || name.includes("brick_front")) {
          mat.color.multiplyScalar(0.92);
        }
      } else if (name.includes("seat_fabric")) {
        mat.color.setRGB(0.45, 0.08, 0.08);
        mat.roughness = 0.85;
      } else if (name.includes("curtain")) {
        mat.color.setRGB(0.25, 0.04, 0.05);
        mat.roughness = 0.9;
      }

      if (name.includes("lamp_glow")) {
        mat.emissive = mat.emissive || new THREE.Color();
        mat.emissive.setHex(0xffc078);
        mat.emissiveIntensity = 6.5;
        mat.color.setHex(0xffe0b0);
      } else if (name.includes("bollard")) {
        mat.emissive = mat.emissive || new THREE.Color();
        mat.emissive.setHex(0xffb45a);
        mat.emissiveIntensity = 3.2;
      } else if (name.includes("aisle")) {
        mat.emissive = mat.emissive || new THREE.Color();
        mat.emissive.setHex(0xf0f4ff);
        mat.emissiveIntensity = 8;
        mat.color.setHex(0xffffff);
      } else if (name.includes("sign")) {
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 1, 3.5);
        if (mat.emissive && mat.emissive.getHex() === 0) mat.emissive.copy(mat.color);
      } else if (/^mat_roof|roof/.test(name) && !/cove/.test(name)) {
        mat.color.setRGB(0.04, 0.04, 0.05);
        mat.roughness = 0.92;
      } else if (/cove|mat_cove/.test(name) || /^cove_/i.test(meshName)) {
        mat.emissive = mat.emissive || new THREE.Color();
        mat.emissive.setRGB(1, 1, 1);
        mat.emissiveIntensity = 5.5;
        mat.color.setRGB(0.95, 0.95, 0.98);
      } else if (/exit|emergency/.test(name) || /^exit/i.test(meshName)) {
        mat.emissive = mat.emissive || new THREE.Color();
        mat.emissive.setRGB(0.15, 0.95, 0.35);
        mat.emissiveIntensity = 4.2;
        mat.color.setRGB(0.08, 0.55, 0.22);
      } else if (name.includes("screen") && !name.includes("frame") && !name.includes("mask")) {
        mat.map = screenTex;
        mat.emissiveMap = screenTex;
        mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = 1.15;
        mat.color.setHex(0xffffff);
        mat.roughness = 0.45;
        mat.metalness = 0;
      } else if (name.includes("screen_frame")) {
        mat.color.setRGB(0.02, 0.02, 0.02);
        mat.roughness = 0.7;
      }
      mat.envMapIntensity = 0;
      mat.needsUpdate = true;
    }
  });

  applyVideoToScreenMesh(root, screenTex);
}

function updateScreenTarget(root) {
  const screen = root.getObjectByName("Screen_Surface");
  if (screen) {
    new THREE.Box3().setFromObject(screen).getCenter(screenTarget);
    return;
  }
  const stage = root.getObjectByName("Stage");
  if (stage) {
    new THREE.Box3().setFromObject(stage).getCenter(screenTarget);
    screenTarget.y += 2;
  }
}

function clearSeatHighlight() {
  if (!selectedSeatName) return;
  const prev = seats.get(selectedSeatName);
  if (!prev) return;
  prev.obj.traverse((c) => {
    if (!c.isMesh || !c.userData._origMats) return;
    c.material = c.userData._origMats;
    delete c.userData._origMats;
  });
  if (cinema.seatAccentLight) cinema.seatAccentLight.intensity = 0;
}

function highlightSeat(seatName) {
  clearSeatHighlight();
  selectedSeatName = seatName;
  const seat = seats.get(seatName);
  if (!seat) return;

  if (!highlightMat) {
    highlightMat = new THREE.MeshStandardMaterial({
      color: 0x2ec4c6,
      emissive: 0x2ec4c6,
      emissiveIntensity: 0.7,
      roughness: 0.5,
      metalness: 0.05,
    });
  }

  seat.obj.traverse((c) => {
    if (!c.isMesh) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    const matName = mats.map((m) => m?.name || "").join(" ");
    if (!isSeatHighlightMesh(c.name, matName)) return;
    c.userData._origMats = c.material;
    c.material = Array.isArray(c.material)
      ? c.material.map(() => highlightMat)
      : highlightMat;
  });

  if (cinema.seatAccentLight && mode === "booking") {
    seat.obj.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    seat.obj.getWorldPosition(p);
    cinema.seatAccentLight.position.set(p.x, p.y + 0.18, p.z);
    cinema.seatAccentLight.intensity = 1.6;
  }
}

/**
 * Seat POV matching the reference: sit behind the seat back,
 * eye-level, looking at the theater screen (not a hard cut to screen only).
 */
function getSeatCameraPose(seatName) {
  const seat = seats.get(seatName);
  if (!seat) return null;

  seat.obj.updateWorldMatrix(true, false);
  const seatPos = new THREE.Vector3();
  seat.obj.getWorldPosition(seatPos);

  // Direction from seat toward screen (horizontal)
  const toScreen = screenTarget.clone().sub(seatPos);
  toScreen.y = 0;
  if (toScreen.lengthSq() < 0.001) toScreen.set(0, 0, -1);
  toScreen.normalize();

  // Final camera: slightly behind seat, sitting eye height — see seat backs + framed screen
  const eyeHeight = 1.18;
  const behind = 0.95;
  const camPos = seatPos
    .clone()
    .addScaledVector(toScreen, -behind)
    .add(new THREE.Vector3(0, eyeHeight, 0));

  // Look at screen center, nudged down a bit so wall/seats frame the shot
  const lookAt = screenTarget.clone();
  lookAt.y -= 0.35;

  // Approach waypoint: higher and further back, looking at the seat first
  const approachPos = seatPos
    .clone()
    .addScaledVector(toScreen, -2.8)
    .add(new THREE.Vector3(0, 2.6, 0));
  const approachLook = seatPos.clone().add(new THREE.Vector3(0, 0.9, 0));

  // Mid waypoint: descend toward seat while swinging look toward screen
  const midPos = seatPos
    .clone()
    .addScaledVector(toScreen, -1.6)
    .add(new THREE.Vector3(0, 1.85, 0));
  const midLook = seatPos
    .clone()
    .lerp(screenTarget, 0.45)
    .add(new THREE.Vector3(0, 0.4, 0));

  return {
    seat,
    seatPos,
    final: { pos: camPos, target: lookAt },
    approach: { pos: approachPos, target: approachLook },
    mid: { pos: midPos, target: midLook },
  };
}

function updatePreviewCard(seat, flying) {
  previewCard.hidden = false;
  previewSeat.textContent = `Row ${seat.row + 1} · Seat ${seat.col + 1}`;
  previewPrice.textContent = formatInr(seat.price);
  if (flying) {
    previewNote.textContent =
      "Camera is moving to this seat — watch the 3D view settle on the screen.";
  } else {
    previewNote.textContent =
      "This is your eye-level view of the screen. Drag to look around.";
  }
}

function cameraFromSeat(seatName, options = {}) {
  const { instant = false, refocus = false } = options;
  const pose = getSeatCameraPose(seatName);
  if (!pose) return;

  const { seat, final, approach, mid } = pose;
  const label = `Row ${seat.row + 1} · Seat ${seat.col + 1}`;
  const sameSeat = selectedSeatName === seatName;

  highlightSeat(seatName);
  seatMapEl.querySelectorAll(".seat-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.seat === seatName);
  });

  controls.minDistance = 0.12;
  controls.maxDistance = 10;
  camera.fov = 58;
  camera.updateProjectionMatrix();

  updatePreviewCard(seat, !instant);

  if (instant) {
    snapCameraTo(final.pos, final.target);
    setFlightUi(false);
    viewToast.hidden = false;
    viewToastText.textContent = `Screen view from ${label}`;
    setBookingSteps("preview");
    return;
  }

  setFlightUi(true, label);

  const start = {
    pos: camera.position.clone(),
    target: controls.target.clone(),
  };

  // Same seat re-tap / refocus: shorter settle from current → final
  if (refocus || sameSeat) {
    animateCameraTo(final.pos, final.target, 900, () => {
      setFlightUi(false);
      viewToast.hidden = false;
      viewToastText.textContent = `Screen view from ${label}`;
      updatePreviewCard(seat, false);
      setBookingSteps("preview");
    });
    return;
  }

  // Full cinematic path: current → approach (behind seat) → mid → seated screen view
  animateCameraPath([start, approach, mid, final], 2600, () => {
    setFlightUi(false);
    viewToast.hidden = false;
    viewToastText.textContent = `Screen view from ${label}`;
    updatePreviewCard(seat, false);
    setBookingSteps("preview");
  });
}

function updateAvailability() {
  let free = 0;
  let taken = 0;
  for (const name of seats.keys()) {
    if (TAKEN.has(name)) taken += 1;
    else free += 1;
  }
  availFree.textContent = `${free} free`;
  availTaken.textContent = `${taken} taken`;
}

function renderSeatMap() {
  seatMapEl.innerHTML = "";
  const rows = [...seatsByRow.keys()].sort((a, b) => a - b);

  if (!rows.length) {
    seatMapEl.innerHTML =
      '<p style="color:var(--muted);font-size:0.85rem">No seats found in model.</p>';
    return;
  }

  for (const row of rows) {
    const names = seatsByRow.get(row) || [];
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const label = document.createElement("div");
    label.className = "seat-row-label";
    label.textContent = String(row + 1);

    const seatsEl = document.createElement("div");
    seatsEl.className = "seat-row-seats";

    const mid = Math.floor(names.length / 2);
    names.forEach((name, i) => {
      if (i === mid) {
        const gap = document.createElement("div");
        gap.className = "aisle";
        seatsEl.appendChild(gap);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seat-btn";
      btn.dataset.seat = name;
      const seat = seats.get(name);
      const seatNo = (seat?.col ?? i) + 1;
      btn.title = `Row ${row + 1} Seat ${seatNo} · ${formatInr(seat?.price ?? 0)}`;
      btn.setAttribute(
        "aria-label",
        `Row ${row + 1} Seat ${seatNo}${TAKEN.has(name) ? ", taken" : ""}`
      );
      if (TAKEN.has(name)) {
        btn.classList.add("is-taken");
        btn.disabled = true;
      } else {
        btn.addEventListener("click", () => {
          if (isFlyingToSeat && selectedSeatName === name) return;
          cameraFromSeat(name);
        });
      }
      seatsEl.appendChild(btn);
    });

    rowEl.appendChild(label);
    rowEl.appendChild(seatsEl);
    seatMapEl.appendChild(rowEl);
  }

  updateAvailability();
}

function pickDefaultSeat() {
  const rows = [...seatsByRow.keys()].sort((a, b) => a - b);
  if (!rows.length) return null;
  const midRow = rows[Math.floor(rows.length / 2)];
  const names = seatsByRow.get(midRow) || [];
  const center = names[Math.floor(names.length / 2)];
  if (center && !TAKEN.has(center)) return center;
  return names.find((n) => !TAKEN.has(n)) || names[0] || null;
}

function setMode(next) {
  if (!modelReady && next === "booking") {
    alert("Please wait — theater is still loading.");
    return;
  }

  mode = next;
  const booking = mode === "booking";
  document.body.classList.toggle("is-booking", booking);
  tabTheater.classList.toggle("is-active", !booking);
  tabBooking.classList.toggle("is-active", booking);
  tabTheater.setAttribute("aria-pressed", String(!booking));
  tabBooking.setAttribute("aria-pressed", String(booking));
  bookingPanel.hidden = !booking;

  if (booking) {
    autoOrbit = false;
    btnAuto.setAttribute("aria-pressed", "false");
    interiorFill.intensity = 10;
    animateCurtains(true, 1600);
    setBookingSteps("pick");
    previewCard.hidden = true;
    cameraStatus.hidden = true;
    ensureScreenVideoPlaying();
    requestAnimationFrame(() => {
      initBookingLenis();
      bookingLenis?.resize();
      bookingLenis?.scrollTo(0, { immediate: true });
    });

    const pick = pickDefaultSeat();
    if (pick) {
      // Smooth fly into the house to the default seat (no hard jump)
      cameraFromSeat(pick);
    }
  } else {
    destroyBookingLenis();
    clearSeatHighlight();
    selectedSeatName = null;
    previewCard.hidden = true;
    viewToast.hidden = true;
    cameraStatus.hidden = true;
    isFlyingToSeat = false;
    interiorFill.intensity = 6;
    animateCurtains(false, 1200);
    screenGlow.intensity = 55;
    screenSpot.intensity = 90;
    screenGlow.color.setHex(0xfff4e8);
    screenSpot.color.setHex(0xffffff);
    camera.fov = 50;
    camera.updateProjectionMatrix();
    applyHomeZoomLimits();
    controls.enabled = true;
    animateCameraTo(defaultCam.clone(), defaultTarget.clone(), 1400, () => {
      applyHomeZoomLimits();
    });
    autoOrbit = true;
    btnAuto.setAttribute("aria-pressed", "true");
  }
}

const ASSET_VERSION = "vid14";
const loader = new GLTFLoader();
loader.load(
  `./3d_theater.glb?v=${ASSET_VERSION}`,
  (gltf) => {
    modelRoot = gltf.scene;
    applyMaterials(modelRoot);
    scene.add(modelRoot);
    modelRoot.updateMatrixWorld(true);

    collectSeats(modelRoot);
    collectCinemaLayer(modelRoot);
    buildProceduralCinemaLayer(modelRoot);
    updateScreenTarget(modelRoot);
    addPracticalLights(modelRoot);
    setupCoveLights(modelRoot);

    const fitted = fitCameraToObject(modelRoot);
    aimFocusLights(fitted.center, fitted.size);
    aimScreenLights();
    renderSeatMap();
    modelReady = true;
    ensureScreenVideoPlaying();

    loaderText.textContent = "Ready";
    progressBar.style.width = "100%";
    setTimeout(() => loaderEl.classList.add("is-done"), 350);
  },
  (event) => {
    if (!event.total) return;
    const pct = Math.round((event.loaded / event.total) * 100);
    progressBar.style.width = `${pct}%`;
    loaderText.textContent = `Loading the house… ${pct}%`;
  },
  (error) => {
    console.error(error);
    loaderText.textContent = "Could not load the 3D model.";
  }
);

tabTheater.addEventListener("click", () => setMode("theater"));
tabBooking.addEventListener("click", () => {
  ensureScreenVideoPlaying();
  setMode("booking");
});

btnAuto.addEventListener("click", () => {
  if (mode === "booking") return;
  autoOrbit = !autoOrbit;
  btnAuto.setAttribute("aria-pressed", String(autoOrbit));
});

btnConfirm.addEventListener("click", () => {
  if (!selectedSeatName || isFlyingToSeat) return;
  const seat = seats.get(selectedSeatName);
  alert(
    `Seat reserved!\n\nRow ${seat.row + 1} · Seat ${seat.col + 1}\n${formatInr(seat.price)}\n\n(Demo booking)`
  );
});

btnRefocus.addEventListener("click", () => {
  if (!selectedSeatName || isFlyingToSeat) return;
  cameraFromSeat(selectedSeatName, { refocus: true });
});

controls.addEventListener("start", () => {
  ensureScreenVideoPlaying();
  if (mode === "theater") {
    autoOrbit = false;
    btnAuto.setAttribute("aria-pressed", "false");
  }
});

let resizeRaf = 0;
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  bookingLenis?.resize();

  // Re-frame home orbit when switching between mobile/desktop aspect
  if (!modelReady || mode !== "theater" || cameraTween || isFlyingToSeat) return;
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (!modelRoot || mode !== "theater") return;
    const wasOrbit = autoOrbit;
    fitCameraToObject(modelRoot);
    autoOrbit = wasOrbit;
    btnAuto.setAttribute("aria-pressed", String(wasOrbit));
  });
});

const _orbitOffset = new THREE.Vector3();
const _orbitSpherical = new THREE.Spherical();
const _orbitPos = new THREE.Vector3();

function tick(now) {
  requestAnimationFrame(tick);
  if (bookingLenis) bookingLenis.raf(now);
  if (cameraTween) cameraTween.update(now);
  updateCurtainAnim(now);
  if (modelReady) updateScreenGlowFromVideo(now);
  // Video GPU uploads are driven by requestVideoFrameCallback — not every rAF
  if (autoOrbit && mode === "theater" && modelRoot && !cameraTween) {
    _orbitOffset.copy(camera.position).sub(controls.target);
    _orbitSpherical.setFromVector3(_orbitOffset);
    _orbitSpherical.theta += 0.0012;
    _orbitSpherical.radius = Math.min(_orbitSpherical.radius, homeDistance);
    camera.position
      .copy(controls.target)
      .add(_orbitPos.setFromSpherical(_orbitSpherical));
  }
  controls.update();
  renderer.render(scene, camera);
}

requestAnimationFrame(tick);
