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
const viewToast = document.getElementById("view-toast");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const NIGHT = 0x0a1020;
const scene = new THREE.Scene();
scene.background = new THREE.Color(NIGHT);
scene.fog = new THREE.FogExp2(NIGHT, 0.008);

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

scene.add(new THREE.HemisphereLight(0x4a5d82, 0x1a120c, 0.55));

const moon = new THREE.DirectionalLight(0xb8c8ef, 0.65);
moon.position.set(-16, 26, -8);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.camera.left = -40;
moon.shadow.camera.right = 40;
moon.shadow.camera.top = 40;
moon.shadow.camera.bottom = -40;
moon.shadow.bias = -0.00025;
scene.add(moon);

const frontSpot = new THREE.SpotLight(0xffc078, 48, 60, Math.PI / 4, 0.45, 1.2);
scene.add(frontSpot);
scene.add(frontSpot.target);

const topFocus = new THREE.SpotLight(0xffe0b0, 36, 55, Math.PI / 3.2, 0.5, 1.1);
scene.add(topFocus);
scene.add(topFocus.target);

const entranceGlow = new THREE.PointLight(0xff9a3c, 28, 40, 1.6);
scene.add(entranceGlow);
const stageGlow = new THREE.PointLight(0xffb45a, 40, 45, 1.5);
scene.add(stageGlow);
const interiorFill = new THREE.PointLight(0xffd8a8, 26, 40, 1.4);
scene.add(interiorFill);

let modelRoot = null;
let screenTarget = new THREE.Vector3(0, 2.8, -10);
let mode = "theater";
let autoOrbit = true;
let cameraTween = null;
let selectedSeatName = null;
let highlightMat = null;
let modelReady = false;

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

function animateCameraTo(pos, target, duration = 1100) {
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
      if (t >= 1) cameraTween = null;
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
  defaultTarget.y = center.y + size.y * 0.08;
  defaultCam.set(
    center.x + distance * 0.55,
    center.y + distance * 0.38,
    center.z + distance * 0.7
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
  frontSpot.position.set(center.x, center.y + size.y * 0.9, center.z + size.z * 0.85);
  frontSpot.target.position.set(center.x, center.y + size.y * 0.2, center.z);
  frontSpot.target.updateMatrixWorld();

  topFocus.position.set(center.x, center.y + size.y * 1.6, center.z + size.z * 0.1);
  topFocus.target.position.set(center.x, center.y, center.z);
  topFocus.target.updateMatrixWorld();

  entranceGlow.position.set(center.x, center.y + size.y * 0.35, center.z + size.z * 0.45);
  stageGlow.position.set(center.x, center.y + size.y * 0.45, center.z - size.z * 0.35);
  interiorFill.position.set(center.x, center.y + size.y * 0.55, center.z);
}

function addLampPointLights(root) {
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    if (!child.isMesh) return;
    const n = (child.name || "").toLowerCase();
    if (!n.includes("lamp_head") && !n.includes("bollard")) return;
    const world = new THREE.Vector3();
    child.getWorldPosition(world);
    const isLamp = n.includes("lamp_head");
    const light = new THREE.PointLight(
      isLamp ? 0xffe0b0 : 0xffc078,
      isLamp ? 6 : 2.5,
      isLamp ? 14 : 8,
      1.8
    );
    light.position.copy(world);
    light.position.y += 0.2;
    scene.add(light);
  });
}

function makeScreenMovieTexture() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext("2d");
  const draw = (t) => {
    const g = ctx.createLinearGradient(0, 0, 1024, 512);
    g.addColorStop(0, "#1a0a2e");
    g.addColorStop(0.5, "#4a1d6e");
    g.addColorStop(1, "#0d2137");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.fillStyle = "rgba(232,165,75,0.95)";
    ctx.font = "bold 70px Bebas Neue, Impact, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("NOW SHOWING", 512, 190);
    ctx.fillStyle = "#f2e8d5";
    ctx.font = "600 46px Instrument Sans, sans-serif";
    ctx.fillText("Night Reel", 512, 270);
    ctx.fillStyle = "rgba(242,232,213,0.55)";
    ctx.font = "26px Instrument Sans, sans-serif";
    ctx.fillText("Your seat preview", 512, 330);
    ctx.globalAlpha = 0.1;
    for (let i = 0; i < 8; i++) {
      const x = ((t * 50 + i * 130) % 1200) - 80;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x, 0, 16, 512);
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
    // Prefer the named node once (group or mesh)
    if (seats.has(child.name)) return;
    seats.set(child.name, {
      obj: child,
      row: parsed.row,
      index: parsed.index,
      col: 0,
      price: priceForRow(parsed.row),
    });
  });

  // Sort each row left→right by world X
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
        mat.color.setRGB(0.05, 0.14, 0.06);
      } else if (name.includes("pavement") || name.includes("boundary")) {
        mat.color.multiplyScalar(0.7);
      } else if (name.includes("road") && !name.includes("line")) {
        mat.color.setRGB(0.04, 0.04, 0.05);
      }

      if (
        name.includes("lamp") ||
        name.includes("bollard") ||
        name.includes("aisle") ||
        name.includes("sign")
      ) {
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 1, 4.5);
        if (mat.emissive && mat.emissive.getHex() === 0) mat.emissive.copy(mat.color);
      } else if (name.includes("screen")) {
        mat.map = screenTex;
        mat.emissiveMap = screenTex;
        mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = 1.6;
        mat.color.setHex(0xffffff);
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

function cameraFromSeat(seatName, instant = false) {
  const seat = seats.get(seatName);
  if (!seat) return;

  seat.obj.updateWorldMatrix(true, false);
  const seatPos = new THREE.Vector3();
  seat.obj.getWorldPosition(seatPos);

  // Sit in the seat, eyes toward the screen
  const eye = seatPos.clone().add(new THREE.Vector3(0, 1.25, 0));
  const toScreen = screenTarget.clone().sub(eye);
  if (toScreen.lengthSq() < 0.001) toScreen.set(0, 0, -1);
  toScreen.normalize();

  // Camera slightly behind eye so we see over the seat back toward screen
  const camPos = eye.clone().addScaledVector(toScreen, -0.55);
  camPos.y = Math.max(camPos.y, seatPos.y + 1.15);

  const lookAt = screenTarget.clone();

  highlightSeat(seatName);
  if (instant) snapCameraTo(camPos, lookAt);
  else animateCameraTo(camPos, lookAt, 1000);

  controls.minDistance = 0.15;
  controls.maxDistance = 8;

  previewCard.hidden = false;
  viewToast.hidden = false;
  previewSeat.textContent = `Row ${seat.row + 1} · Seat ${seat.col + 1}`;
  previewNote.textContent =
    "This is the movie screen from your seat. Drag to look left/right.";
  previewPrice.textContent = formatInr(seat.price);

  seatMapEl.querySelectorAll(".seat-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.seat === seatName);
  });
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
      // Center aisle gap
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
      btn.title = `Row ${row + 1} Seat ${(seat?.col ?? i) + 1} · ${formatInr(seat?.price ?? 0)}`;
      if (TAKEN.has(name)) {
        btn.classList.add("is-taken");
      } else {
        btn.addEventListener("click", () => cameraFromSeat(name));
      }
      seatsEl.appendChild(btn);
    });

    rowEl.appendChild(label);
    rowEl.appendChild(seatsEl);
    seatMapEl.appendChild(rowEl);
  }
}

function pickDefaultSeat() {
  // Prefer middle row, center seat
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
    interiorFill.intensity = 34;
    stageGlow.intensity = 55;
    camera.fov = 55;
    camera.updateProjectionMatrix();

    const pick = pickDefaultSeat();
    if (pick) {
      // Instant jump inside so user never stays on exterior
      cameraFromSeat(pick, true);
    }
  } else {
    clearSeatHighlight();
    selectedSeatName = null;
    previewCard.hidden = true;
    viewToast.hidden = true;
    interiorFill.intensity = 26;
    stageGlow.intensity = 40;
    camera.fov = 50;
    camera.updateProjectionMatrix();
    controls.maxDistance = 80;
    animateCameraTo(defaultCam.clone(), defaultTarget.clone(), 1200);
    autoOrbit = true;
    btnAuto.setAttribute("aria-pressed", "true");
  }
}

const ASSET_VERSION = "book2";
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
    addLampPointLights(modelRoot);

    const fitted = fitCameraToObject(modelRoot);
    aimFocusLights(fitted.center, fitted.size);
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
  if (!selectedSeatName) return;
  const seat = seats.get(selectedSeatName);
  alert(
    `Seat reserved!\n\nRow ${seat.row + 1} · Seat ${seat.col + 1}\n${formatInr(seat.price)}\n\n(Demo booking)`
  );
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
