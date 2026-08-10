import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = document.getElementById("theater-canvas");
const loaderEl = document.getElementById("loader");
const progressBar = document.getElementById("progress-bar");
const loaderText = document.getElementById("loader-text");
const btnReset = document.getElementById("btn-reset");
const btnAuto = document.getElementById("btn-auto");
const btnEnter = document.getElementById("btn-enter");
const btnBookCta = document.getElementById("btn-book-cta");
const tabTheater = document.getElementById("tab-theater");
const tabBooking = document.getElementById("tab-booking");
const bookingPanel = document.getElementById("booking-panel");
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// Dark night plate — matches the Blender lighting reference
const NIGHT = 0x05070c;
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
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.25;
controls.maxDistance = 80;
controls.target.set(0, 1.2, 0);

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

let modelRoot = null;
let screenTarget = new THREE.Vector3(0, 2.8, -10);
let mode = "theater";
let autoOrbit = true;
let cameraTween = null;
let selectedSeatName = null;
let highlightMat = null;
let modelReady = false;
let isFlyingToSeat = false;

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
  const name = (obj.name || "").toLowerCase();
  if (name.includes("roof")) return true;
  if (!obj.isMesh || !obj.material) return false;
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  return mats.some((m) => m && /roof/i.test(m.name || ""));
}

function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = maxDim * 1.15;

  defaultTarget.copy(center);
  defaultTarget.y = center.y + size.y * 0.05;
  defaultTarget.z = center.z - size.z * 0.05;
  // Elevated night view that reads the wall washes + glowing screen
  defaultCam.set(
    center.x + distance * 0.42,
    center.y + distance * 0.48,
    center.z + distance * 0.55
  );
  enterTarget.set(center.x, center.y + size.y * 0.1, center.z - size.z * 0.05);
  enterCam.set(center.x, center.y + size.y * 0.42, center.z + size.z * 0.15);

  controls.maxDistance = maxDim * 2.8;
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
  screenGlow.position.copy(screenTarget);
  screenGlow.position.z -= 0.35;
  screenGlow.position.y += 0.15;

  // Cast bright screen light back over the seating bowl
  screenSpot.position.copy(screenTarget);
  screenSpot.position.z -= 0.2;
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

function makeScreenMovieTexture() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext("2d");
  const draw = (t) => {
    // Bright luminous screen like the Blender reference
    const g = ctx.createRadialGradient(512, 260, 40, 512, 260, 620);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.45, "#f7f3ea");
    g.addColorStop(0.85, "#e8dfd0");
    g.addColorStop(1, "#d4c8b4");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 512);

    ctx.fillStyle = "rgba(20, 14, 8, 0.22)";
    ctx.font = "bold 64px Bebas Neue, Impact, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("NOW SHOWING", 512, 210);
    ctx.font = "600 40px Instrument Sans, sans-serif";
    ctx.fillText("Night Reel", 512, 275);
    ctx.fillStyle = "rgba(20, 14, 8, 0.14)";
    ctx.font = "24px Instrument Sans, sans-serif";
    ctx.fillText("Your seat preview", 512, 330);

    // Soft scan shimmer
    ctx.globalAlpha = 0.04;
    for (let i = 0; i < 6; i++) {
      const x = ((t * 40 + i * 170) % 1200) - 80;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x, 0, 18, 512);
    }
    ctx.globalAlpha = 1;
  };
  draw(0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  let last = 0;
  tex.userData.update = (now) => {
    if (now - last < 90) return;
    last = now;
    draw(now * 0.001);
    tex.needsUpdate = true;
  };
  return tex;
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
      } else if (name.includes("screen") && !name.includes("frame")) {
        mat.map = screenTex;
        mat.emissiveMap = screenTex;
        mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = 2.8;
        mat.color.setHex(0xffffff);
        mat.roughness = 0.35;
        mat.metalness = 0;
      } else if (name.includes("screen_frame")) {
        mat.color.setRGB(0.02, 0.02, 0.02);
        mat.roughness = 0.7;
      }
      mat.envMapIntensity = 0;
      mat.needsUpdate = true;
    }
  });
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
}

function highlightSeat(seatName) {
  clearSeatHighlight();
  selectedSeatName = seatName;
  const seat = seats.get(seatName);
  if (!seat) return;

  if (!highlightMat) {
    highlightMat = new THREE.MeshStandardMaterial({
      color: 0xe8a54b,
      emissive: 0xe8a54b,
      emissiveIntensity: 0.7,
      roughness: 0.5,
      metalness: 0.05,
    });
  }

  seat.obj.traverse((c) => {
    if (!c.isMesh) return;
    c.userData._origMats = c.material;
    c.material = Array.isArray(c.material)
      ? c.material.map(() => highlightMat)
      : highlightMat;
  });
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
  animateCameraPath([start, approach, mid, final], 2200, () => {
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
    screenGlow.intensity = 70;
    screenSpot.intensity = 110;
    setBookingSteps("pick");
    previewCard.hidden = true;
    cameraStatus.hidden = true;

    const pick = pickDefaultSeat();
    if (pick) {
      // Smooth fly into the house to the default seat (no hard jump)
      cameraFromSeat(pick);
    }
  } else {
    clearSeatHighlight();
    selectedSeatName = null;
    previewCard.hidden = true;
    viewToast.hidden = true;
    cameraStatus.hidden = true;
    isFlyingToSeat = false;
    interiorFill.intensity = 6;
    screenGlow.intensity = 55;
    screenSpot.intensity = 90;
    camera.fov = 50;
    camera.updateProjectionMatrix();
    controls.maxDistance = 80;
    controls.enabled = true;
    animateCameraTo(defaultCam.clone(), defaultTarget.clone(), 1200);
    autoOrbit = true;
    btnAuto.setAttribute("aria-pressed", "true");
  }
}

const ASSET_VERSION = "light1";
const loader = new GLTFLoader();
loader.load(
  `./3d_theater.glb?v=${ASSET_VERSION}`,
  (gltf) => {
    modelRoot = gltf.scene;
    applyMaterials(modelRoot);
    scene.add(modelRoot);
    modelRoot.updateMatrixWorld(true);

    collectSeats(modelRoot);
    updateScreenTarget(modelRoot);
    addPracticalLights(modelRoot);

    const fitted = fitCameraToObject(modelRoot);
    aimFocusLights(fitted.center, fitted.size);
    aimScreenLights();
    renderSeatMap();
    modelReady = true;

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
tabBooking.addEventListener("click", () => setMode("booking"));
btnBookCta.addEventListener("click", () => setMode("booking"));

btnReset.addEventListener("click", () => {
  if (mode === "booking") return;
  animateCameraTo(defaultCam.clone(), defaultTarget.clone());
});

btnAuto.addEventListener("click", () => {
  if (mode === "booking") return;
  autoOrbit = !autoOrbit;
  btnAuto.setAttribute("aria-pressed", String(autoOrbit));
});

btnEnter.addEventListener("click", () => {
  animateCameraTo(enterCam.clone(), enterTarget.clone(), 1600);
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
  if (mode === "theater") {
    autoOrbit = false;
    btnAuto.setAttribute("aria-pressed", "false");
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function tick(now) {
  requestAnimationFrame(tick);
  if (cameraTween) cameraTween.update(now);
  if (scene.userData.screenTex?.userData.update) {
    scene.userData.screenTex.userData.update(now);
  }
  if (autoOrbit && mode === "theater" && modelRoot && !cameraTween) {
    const offset = camera.position.clone().sub(controls.target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta += 0.0018;
    camera.position
      .copy(controls.target)
      .add(new THREE.Vector3().setFromSpherical(sph));
    camera.lookAt(controls.target);
  }
  controls.update();
  renderer.render(scene, camera);
}

requestAnimationFrame(tick);
