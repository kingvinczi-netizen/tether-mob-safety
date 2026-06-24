/* ================================================================
   TETHER 3D — app.js  (water theme v2)
   Three.js r128 · GSAP 3.12.2 · ScrollTrigger
   ================================================================ */
'use strict';

(function () {

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Colour palette ─────────────────────────────────────────── */
const HEX = {
  ping:  0x4FD1C5,
  alarm: 0xFF5A4D,
  steel: 0x1B3A45,
  abyss: 0x060d10,
  mist:  0x7B96A0,
};
function hexAlpha(h, a) {
  return `rgba(${(h>>16)&0xff},${(h>>8)&0xff},${h&0xff},${a})`;
}

/* ── Crew ───────────────────────────────────────────────────── */
const CREW = [
  { id:'TB-01', name:'Tunde A.',    bat:84,  x:0.38, y:0.42, mob:false },
  { id:'TB-02', name:'Amaka O.',    bat:61,  x:0.55, y:0.52, mob:false },
  { id:'TB-03', name:'Seun K.',     bat:18,  x:0.30, y:0.60, mob:false },
  { id:'TB-04', name:'Blessing E.', bat:92,  x:0.63, y:0.33, mob:false },
  { id:'TB-05', name:'Femi D.',     bat:47,  x:0.48, y:0.67, mob:false },
];

const START_TIME = Date.now();
CREW.forEach((m, i) => {
  m._ts = new Date(START_TIME - (i + 1) * 20000 - Math.random() * 8000);
});

let mobActive  = false;
let mobSeconds = 0;
let mobGPS     = { lat: 24.1312, lon: 38.0521 };
const MOB_DRIFT = 0.0000009; // degrees/second ≈ 0.3 kts bearing ~214° SW
const blipDrift = CREW.map(() => ({ ox:0, oy:0, vx:0, vy:0 }));

/* ══════════════════════════════════════════════════════════════
   BACKGROUND SEA VIDEO — scrolling dives from surface → reef
   ══════════════════════════════════════════════════════════════ */
function setupBgVideo() {
  const v = document.getElementById('bg-video');
  if (!v) return;

  v.muted = true;
  v.playsInline = true;
  const tryPlay = () => { const p = v.play(); if (p) p.catch(() => {}); };
  tryPlay();
  /* Some browsers block autoplay until a gesture — prime on first interaction */
  window.addEventListener('pointerdown', tryPlay, { once: true });
  window.addEventListener('scroll',      tryPlay, { once: true, passive: true });

  if (REDUCED) { v.pause(); v.style.objectPosition = 'center 45%'; return; }

  /* Map page scroll → vertical crop: surface near the top → reef near the bottom */
  const TOP = 6, BOTTOM = 94;
  let target = 0, current = 0;
  function onScroll() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    target = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();
  current = target;

  (function pan() {
    requestAnimationFrame(pan);
    current += (target - current) * 0.09;
    v.style.objectPosition = `center ${(TOP + current * (BOTTOM - TOP)).toFixed(2)}%`;
  })();
}

/* Blood-water tint over the footage during an alarm */
function setAlarm(on) {
  const tint = document.getElementById('bg-tint');
  if (!tint) return;
  if (typeof gsap !== 'undefined') {
    gsap.to(tint, { opacity: on ? 1 : 0, duration: on ? 1.6 : 2.2, ease: 'power2.out' });
  } else {
    tint.style.opacity = on ? '1' : '0';
  }
}

/* ══════════════════════════════════════════════════════════════
   THREE.JS — GPU OCEAN  (legacy; definitions kept but no longer
   initialised — the sea video replaces the 3D background)
   ══════════════════════════════════════════════════════════════ */

const glCanvas = document.getElementById('gl-canvas');
let renderer, scene, camera, clock;
let oceanMesh, sonarSphere, ptSystem;
let lightPing, lightAlarm;
let cameraAngle = 0, cameraTargetY = 0;
let wUniforms; // exposed for GSAP tweens

/* ── Ocean vertex shader ───────────────────────────────────── */
const OCEAN_VERT = /* glsl */`
  uniform float uTime;
  varying float vH;   // wave height
  varying vec2  vUV;  // for caustics

  float wave(vec2 p, float freq, float spd, float amp) {
    return sin(p.x * freq + uTime * spd)
         * cos(p.y * freq * 0.85 + uTime * spd * 0.75) * amp;
  }

  void main() {
    vUV = uv;

    // Five wave layers — PlaneGeometry lies in XY, so use position.xy
    float e = wave(position.xy, 0.18, 0.40, 0.55)
            + wave(position.xy, 0.35, 0.70, 0.28)
            + wave(position.xy * 1.4, 0.55, 1.10, 0.14)
            + wave(position.xy * 0.6, 0.09, 0.25, 0.90)
            + wave(position.xy * 2.0, 0.80, 1.80, 0.06);

    vH = e;

    // Displace in object-space Z → becomes world Y after rotation.x = -PI/2
    vec3 p = position;
    p.z += e;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

/* ── Ocean fragment shader ─────────────────────────────────── */
const OCEAN_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uAlarm;  // 0 calm → 1 MOB

  varying float vH;
  varying vec2  vUV;

  // Domain-warped caustic web — the dancing net of light on real water.
  float caustic(vec2 uv) {
    vec2 p = uv * 7.0;
    float t = uTime * 0.55;
    // Warp the space a few times so the cells writhe like refracted light
    for (int i = 0; i < 3; i++) {
      float fi = float(i) + 1.0;
      p += vec2(
        sin(p.y * 1.5 + t * (0.9 / fi)),
        cos(p.x * 1.5 + t * (0.8 / fi))
      ) * (0.55 / fi);
    }
    float c = (sin(p.x) * sin(p.y)) * 0.5 + 0.5;
    return pow(c, 4.0);            // sharpen into bright threads
  }

  void main() {
    // Normalise wave height 0→1
    float h = clamp((vH + 1.8) / 3.6, 0.0, 1.0);

    // Base ocean — deep navy abyss → teal mid → bright cyan crest
    vec3 deep  = vec3(0.012, 0.066, 0.118);
    vec3 mid   = vec3(0.035, 0.205, 0.290);
    vec3 crest = vec3(0.120, 0.470, 0.510);
    vec3 col   = mix(deep, mid,   smoothstep(0.00, 0.62, h));
        col    = mix(col,  crest, smoothstep(0.55, 1.00, h));

    // Alarm → blood water
    vec3 alarmD = vec3(0.155, 0.024, 0.028);
    vec3 alarmC = vec3(0.400, 0.082, 0.065);
    col = mix(col, mix(alarmD, alarmC, h), uAlarm * 0.58);

    vec3 lightTint = mix(vec3(0.42, 0.92, 0.86), vec3(1.0, 0.46, 0.34), uAlarm);

    // Animated caustic light-web — two layers drifting opposite ways
    float ca = caustic(vUV * 1.0 + vec2(uTime * 0.012, uTime * 0.020));
    float cb = caustic(vUV * 1.7 - vec2(uTime * 0.018, uTime * 0.009));
    float caust = ca * 0.7 + cb * 0.4;
    // Brighter in the crests, present everywhere
    col += caust * lightTint * (0.10 + h * 0.32);

    // Foam at crests
    float foam = smoothstep(0.80, 1.00, h) * 0.28;
    col += foam * lightTint;

    // Travelling specular sparkle — tiny sun glints riding the surface
    float spk = pow(max(0.0, sin(vUV.x * 90.0 + uTime * 2.3)
                           * sin(vUV.y * 70.0 - uTime * 1.7)), 18.0);
    col += spk * smoothstep(0.45, 1.0, h) * lightTint * 0.9;

    // God-ray shafts — light raking across from the far side
    float shaftAng = (vUV.x - vUV.y) * 4.2 + uTime * 0.25;
    float shafts   = pow(max(0.0, sin(shaftAng)), 6.0);
    shafts        *= smoothstep(0.0, 0.7, vUV.y);   // strongest toward the horizon
    col += shafts * lightTint * (0.05 * (1.0 - uAlarm * 0.6));

    // Radial vignette — pool-of-light in deep water
    float vig = 1.0 - length(vUV - 0.5) * 1.12;
    col *= mix(0.40, 1.0, clamp(vig, 0.0, 1.0));

    // Edge fog
    float edge = length(vUV - 0.5) * 2.0;
    col = mix(col, vec3(0.020, 0.044, 0.060), smoothstep(0.72, 1.00, edge));

    gl_FragColor = vec4(col, 0.97);
  }
`;

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.88;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(HEX.abyss);
  scene.fog = new THREE.FogExp2(HEX.abyss, 0.034);

  clock = new THREE.Clock();

  camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 14, 24);
  camera.lookAt(0, 0, 0);

  /* Lights */
  scene.add(new THREE.AmbientLight(0x0a1f2a, 1.5));

  lightPing = new THREE.PointLight(HEX.ping, 3, 60);
  lightPing.position.set(0, 8, 0);
  scene.add(lightPing);

  lightAlarm = new THREE.PointLight(HEX.alarm, 0, 80);
  lightAlarm.position.set(0, 10, 0);
  scene.add(lightAlarm);

  const rim = new THREE.DirectionalLight(0x1a4a5a, 1.2);
  rim.position.set(-20, 20, -10);
  scene.add(rim);

  buildOcean();
  buildSonarSphere();
  buildParticles();
  buildGrid();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }, { passive: true });
}

function buildOcean() {
  wUniforms = {
    uTime:  { value: 0.0 },
    uAlarm: { value: 0.0 },
  };

  const geo = new THREE.PlaneGeometry(120, 120, 80, 80);
  const mat = new THREE.ShaderMaterial({
    uniforms:       wUniforms,
    vertexShader:   OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
    side:           THREE.FrontSide,
  });

  oceanMesh = new THREE.Mesh(geo, mat);
  oceanMesh.rotation.x = -Math.PI / 2;
  oceanMesh.position.y = -2;
  scene.add(oceanMesh);
}

function buildSonarSphere() {
  const group = new THREE.Group();

  /* Wireframe shell */
  const outerMat = new THREE.MeshBasicMaterial({
    color: HEX.ping, wireframe: true, transparent: true, opacity: 0.07,
  });
  group.add(new THREE.Mesh(new THREE.SphereGeometry(5, 32, 32), outerMat));

  /* Latitude rings */
  for (let i = 0; i < 5; i++) {
    const r = 5 * Math.sin((i + 1) * Math.PI / 6);
    const y = 5 * Math.cos((i + 1) * Math.PI / 6);
    const rMat = new THREE.MeshBasicMaterial({ color: HEX.ping, transparent: true, opacity: 0.20 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.012, 6, 80), rMat);
    ring.position.y = y;
    group.add(ring);
    if (i > 0) {
      const r2 = ring.clone(); r2.position.y = -y; group.add(r2);
    }
  }

  /* Sweep arm */
  const sweepArm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 5, 6),
    new THREE.MeshBasicMaterial({ color: HEX.ping, transparent: true, opacity: 0.92 })
  );
  sweepArm.position.y = 2.5;
  sweepArm.name = 'sweepArm';
  const pivot = new THREE.Group(); pivot.name = 'sweepPivot';
  pivot.add(sweepArm);
  group.add(pivot);

  /* Crew blips */
  CREW.forEach((m, i) => {
    const theta = (m.x - 0.5) * Math.PI;
    const phi   = (m.y - 0.5) * Math.PI * 0.8;
    const r = 4.6;
    const pos = new THREE.Vector3(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi) * 0.4,
      r * Math.sin(phi) * Math.sin(theta)
    );

    const blip = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 8, 8),
      new THREE.MeshBasicMaterial({ color: HEX.ping })
    );
    blip.position.copy(pos);
    blip.name = `blip-${i}`;
    group.add(blip);

    const pingRing = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.22, 16),
      new THREE.MeshBasicMaterial({ color: HEX.ping, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    pingRing.position.copy(pos);
    pingRing.lookAt(new THREE.Vector3(0, 0, 0));
    pingRing.name = `ping-${i}`;
    group.add(pingRing);
  });

  group.position.set(9, 4, -4);
  group.rotation.x = 0.15;
  group.name = 'sonarGroup';
  sonarSphere = group;
  scene.add(group);
}

function buildParticles() {
  const N   = 1400;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3]     = (Math.random() - 0.5) * 90;
    pos[i * 3 + 1] = Math.random() * 12 - 4;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  ptSystem = new THREE.Points(geo, new THREE.PointsMaterial({
    color: HEX.ping, size: 0.09, transparent: true, opacity: 0.40, sizeAttenuation: true,
  }));
  scene.add(ptSystem);
}

function buildGrid() {
  const g = new THREE.GridHelper(100, 30, HEX.steel, HEX.steel);
  g.position.y = -2.06;
  g.material.transparent = true;
  g.material.opacity = 0.10;
  scene.add(g);
}

/* ── Render loop ────────────────────────────────────────────── */
function renderLoop() {
  requestAnimationFrame(renderLoop);
  if (REDUCED) { renderer.render(scene, camera); return; }

  const t = clock.getElapsedTime();

  /* Ocean time */
  wUniforms.uTime.value = t;
  /* uAlarm driven by GSAP — no lerp needed here */

  /* Sonar sphere */
  if (sonarSphere) {
    sonarSphere.rotation.y = t * (mobActive ? 1.8 : 0.35);
    const pivot = sonarSphere.getObjectByName('sweepPivot');
    if (pivot) pivot.rotation.y = t * (mobActive ? 3.5 : 0.9);

    CREW.forEach((m, i) => {
      const blip = sonarSphere.getObjectByName(`blip-${i}`);
      const pRng = sonarSphere.getObjectByName(`ping-${i}`);
      if (!blip) return;

      blip.material.color.setHex(m.mob ? HEX.alarm : HEX.ping);
      if (pRng) {
        const sc = 1 + Math.sin(t * (m.mob ? 6 : 2) + i) * (m.mob ? 0.5 : 0.15);
        pRng.scale.setScalar(sc);
        pRng.material.color.setHex(m.mob ? HEX.alarm : HEX.ping);
        pRng.material.opacity = m.mob ? 0.75 : 0.25;
      }

      if (m.mob) {
        blip.position.x += 0.007;
        blip.position.z += 0.005;
      }
    });
  }

  /* Particles */
  if (ptSystem) {
    ptSystem.rotation.y = t * 0.012;
    ptSystem.material.color.setHex(mobActive ? HEX.alarm : HEX.ping);
    ptSystem.material.opacity = mobActive ? 0.22 : 0.40;
  }

  /* Lights breathe */
  if (lightPing)  lightPing.intensity  = mobActive ? 0.5 : 2 + Math.sin(t * 0.8) * 0.5;
  if (lightAlarm) lightAlarm.intensity += ((mobActive ? 4 + Math.sin(t * 3) * 1.5 : 0) - lightAlarm.intensity) * 0.04;

  /* Camera slow orbit */
  cameraAngle += 0.0004;
  camera.position.x = Math.sin(cameraAngle) * 7.2;
  camera.position.z = Math.cos(cameraAngle) * 24 + cameraTargetY;
  camera.lookAt(0, 2, 0);

  renderer.render(scene, camera);
}

/* ══════════════════════════════════════════════════════════════
   GSAP — ENTRANCE + SCROLL REVEALS
   ══════════════════════════════════════════════════════════════ */
function initAnimations() {
  if (typeof gsap === 'undefined') return;
  gsap.registerPlugin(ScrollTrigger);

  /* Hero stagger-in */
  gsap.timeline({ delay: 0.35 })
    .to('.hero-tag',     { opacity:1, y:0, duration:0.70, ease:'power3.out' })
    .to('.hero-title',   { opacity:1, y:0, duration:0.95, ease:'power3.out' }, '-=0.35')
    .to('.hero-sub',     { opacity:1, y:0, duration:0.80, ease:'power3.out' }, '-=0.55')
    .to('.hero-actions', { opacity:1, y:0, duration:0.70, ease:'power3.out' }, '-=0.45')
    .to('.hero-stats',   { opacity:1, y:0, duration:0.70, ease:'power3.out' }, '-=0.40')
    .to('.sonar-label',  { opacity:1,       duration:1.20, ease:'power2.out' }, '-=0.40')
    .to('#scroll-hint',  { opacity:0.65,    duration:0.80, ease:'power2.out' }, '-=0.50');

  /* Section reveals */
  document.querySelectorAll('.reveal').forEach(el => {
    const delay = parseFloat(el.dataset.delay || 0) / 1000;
    ScrollTrigger.create({
      trigger: el,
      start:   'top 86%',
      once:    true,
      onEnter() {
        gsap.to(el, { opacity:1, y:0, duration:0.75, delay, ease:'power3.out' });
      },
    });
  });

  /* Nav scroll glass */
  ScrollTrigger.create({
    start: 'top -80px',
    onUpdate(self) {
      document.getElementById('nav').classList.toggle('scrolled', self.progress > 0);
    },
  });

  /* Camera follows scroll on features section */
  ScrollTrigger.create({
    trigger: '#features',
    start:   'top bottom',
    end:     'bottom top',
    onUpdate(self) { cameraTargetY = self.progress * -8; },
  });

  /* Sonar coordinate ticker */
  setInterval(() => {
    const lat = (24 + (Math.random() - 0.5) * 0.01).toFixed(4);
    const lon = (38 + (Math.random() - 0.5) * 0.01).toFixed(4);
    const el = document.getElementById('sonar-coords');
    if (el) el.textContent = `${lat}°N  ${lon}°W`;
  }, 2200);
}

/* ══════════════════════════════════════════════════════════════
   ROSTER
   ══════════════════════════════════════════════════════════════ */
function fmtTime(d) { return d.toTimeString().slice(0, 8); }

function fmtMobTime(s) {
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const r = String(s % 60).padStart(2, '0');
  return `${m}:${r}`;
}

function hypoRisk(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 20) return { cls: '',          label: 'LOW RISK',      rem: 60 - m };
  if (m < 40) return { cls: 'hypo-mod',  label: 'MODERATE RISK', rem: 60 - m };
  return           { cls: 'hypo-high', label: 'HIGH RISK',     rem: Math.max(0, 60 - m) };
}

function renderRoster() {
  const list = document.getElementById('roster-list');
  if (!list) return;

  const elapsed = Date.now() - START_TIME;
  const aboard  = CREW.filter(m => !m.mob).length;
  document.getElementById('roster-count').textContent = `${aboard} / ${CREW.length} aboard`;

  list.innerHTML = CREW.map(m => {
    const isO  = m.mob;
    const isL  = m.bat < 25;
    const ts   = fmtTime(new Date(m._ts.getTime() + elapsed));
    const lowT = isL ? '<span class="low-tag">LOW</span>' : '';

    let det;
    if (isO) {
      const hypo   = hypoRisk(mobSeconds);
      const dist   = Math.round(5 + mobSeconds * 0.15);
      const cgETA  = Math.max(1, 18 - Math.floor(mobSeconds / 60));
      const latStr = mobGPS.lat.toFixed(4) + '°N';
      const lonStr = Math.abs(mobGPS.lon).toFixed(4) + '°W';
      det = `
        <div class="mob-stats">
          <div class="mob-stat t-mono">
            <span class="mob-stat-key">⏱ IN WATER</span>${fmtMobTime(mobSeconds)}
          </div>
          <div class="mob-stat t-mono">
            <span class="mob-stat-key">📍 POSITION</span>${latStr}&nbsp;&nbsp;${lonStr}
          </div>
          <div class="mob-stat t-mono">
            <span class="mob-stat-key">🧭 FROM VESSEL</span>214° SW · ${dist} m · 0.3 kts drift
          </div>
          <div class="mob-stat t-mono ${hypo.cls}">
            <span class="mob-stat-key">❄ HYPOTHERMIA</span>${hypo.label} · ~${hypo.rem} min to critical
          </div>
        </div>
        <div class="mob-detail visible">● Alert sent · GPS logged · Shore alerted<br>● Coast Guard ETA ~${cgETA} min</div>`;
    } else {
      det = '<div class="mob-detail"></div>';
    }

    return `
      <div class="crew-card${isO ? ' mob' : ''}">
        <div class="crew-top">
          <div>
            <div class="crew-name">${m.name}</div>
            <div class="crew-id t-mono">${m.id}</div>
          </div>
          <span class="pill${isO ? ' mob' : ''}">${isO ? 'OVERBOARD' : 'ABOARD'}</span>
        </div>
        <div class="bat-row">
          <span class="bat-pct t-mono">${m.bat}%</span>
          <div class="bat-track">
            <div class="bat-fill${isL ? ' low' : ''}" style="width:${m.bat}%"></div>
          </div>${lowT}
        </div>
        <span class="crew-ts t-mono mist">${isO ? 'LAST HEARD' : 'Last heard'} ${ts}</span>
        ${det}
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   2D MINI SONAR
   ══════════════════════════════════════════════════════════════ */
const miniCanvas = document.getElementById('mini-sonar');
let miniCtx, miniSize = 300, miniDPR = 1;
let miniAngle = 0;
const CALM_SPD  = (Math.PI * 2) / 480;
const ALARM_SPD = (Math.PI * 2) / 130;

function resizeMini() {
  const rect  = miniCanvas.getBoundingClientRect();
  miniDPR     = window.devicePixelRatio || 1;
  miniSize    = rect.width || 300;
  miniCanvas.width  = Math.round(miniSize * miniDPR);
  miniCanvas.height = Math.round(miniSize * miniDPR);
  miniCtx = miniCanvas.getContext('2d');
}

function miniLoop() {
  requestAnimationFrame(miniLoop);
  miniAngle += REDUCED ? 0 : (mobActive ? ALARM_SPD : CALM_SPD);
  drawMini();
}

function drawMini() {
  if (miniSize < 10) return;

  const ctx = miniCtx;
  const W   = miniCanvas.width;
  const H   = miniCanvas.height;
  const dpr = miniDPR;
  const cx  = W / 2, cy = H / 2;
  const R   = Math.min(W, H) * 0.46;

  ctx.clearRect(0, 0, W, H);

  /* Radial background glow */
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  bg.addColorStop(0, hexAlpha(mobActive ? HEX.alarm : HEX.ping, 0.08));
  bg.addColorStop(1, 'rgba(6,13,16,0)');
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = bg; ctx.fill();

  /* Grid rings */
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * i / 4, 0, Math.PI * 2);
    ctx.strokeStyle = hexAlpha(mobActive ? HEX.alarm : HEX.steel, mobActive ? 0.25 : 0.55);
    ctx.lineWidth   = dpr * 0.5;
    ctx.stroke();
  }

  /* Cross hairs */
  ctx.strokeStyle = hexAlpha(HEX.steel, 0.30);
  ctx.lineWidth   = dpr * 0.5;
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

  /* Sweep trail (20 sectors) */
  if (!REDUCED) {
    for (let i = 0; i < 22; i++) {
      const t0 = i / 22, t1 = (i + 1) / 22;
      const a0 = miniAngle - Math.PI * 0.38 * (1 - t0);
      const a1 = miniAngle - Math.PI * 0.38 * (1 - t1);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R - dpr, a0, a1);
      ctx.closePath();
      ctx.fillStyle = hexAlpha(mobActive ? HEX.alarm : HEX.ping, t0 * (mobActive ? 0.22 : 0.12));
      ctx.fill();
    }
  }

  /* Sweep line */
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(miniAngle) * R, cy + Math.sin(miniAngle) * R);
  ctx.strokeStyle = hexAlpha(mobActive ? HEX.alarm : HEX.ping, 0.92);
  ctx.lineWidth = dpr * 1.6;
  ctx.stroke();

  /* Crew blips */
  CREW.forEach((m, i) => {
    /* Update drift */
    const d = blipDrift[i];
    if (m.mob) {
      d.vx += (Math.random() - 0.40) * 0.16;
      d.vy += (Math.random() - 0.40) * 0.16;
    } else {
      d.vx += (Math.random() - 0.5) * 0.04;
      d.vy += (Math.random() - 0.5) * 0.04;
    }
    d.vx *= 0.88; d.vy *= 0.88;
    const cap = m.mob ? 38 : 5;
    d.ox = Math.max(-cap, Math.min(cap, d.ox + d.vx));
    d.oy = Math.max(-cap, Math.min(cap, d.oy + d.vy));

    const bx = cx + (m.x - 0.5) * 2 * R + d.ox;
    const by = cy + (m.y - 0.5) * 2 * R + d.oy;

    /* Sweep ping flash */
    let angDiff = ((miniAngle - Math.atan2(by - cy, bx - cx)) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    if (angDiff > Math.PI) angDiff = Math.PI * 2 - angDiff;
    const pa = Math.max(0, 1 - angDiff / (Math.PI * 0.22));
    if (pa > 0.01) {
      ctx.beginPath();
      ctx.arc(bx, by, dpr * (m.mob ? 14 : 8), 0, Math.PI * 2);
      ctx.strokeStyle = hexAlpha(m.mob ? HEX.alarm : HEX.ping, pa * (m.mob ? 0.9 : 0.5));
      ctx.lineWidth = dpr;
      ctx.stroke();
    }

    /* MOB alarm pulse */
    if (m.mob && !REDUCED) {
      const pr = 5 + Math.sin(Date.now() / 180) * 4;
      ctx.beginPath();
      ctx.arc(bx, by, dpr * pr, 0, Math.PI * 2);
      ctx.strokeStyle = hexAlpha(HEX.alarm, 0.8);
      ctx.lineWidth   = dpr * 2;
      ctx.stroke();
    }

    /* Core dot */
    ctx.beginPath();
    ctx.arc(bx, by, dpr * (m.mob ? 5 : 3.5), 0, Math.PI * 2);
    ctx.fillStyle = m.mob ? '#FF5A4D' : '#4FD1C5';
    ctx.fill();

    /* ID label */
    ctx.font      = `${dpr * 9}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = hexAlpha(m.mob ? HEX.alarm : HEX.mist, 0.80);
    ctx.fillText(m.id, bx + dpr * 5, by + dpr * 3);
  });
}

/* ══════════════════════════════════════════════════════════════
   MOB SIMULATION
   ══════════════════════════════════════════════════════════════ */
function updateStatus() {
  const tag = document.getElementById('hero-status');
  if (mobActive) {
    const dist = Math.round(5 + mobSeconds * 0.15);
    tag.textContent = `⚠ MAN OVERBOARD — Tunde A. · ${fmtMobTime(mobSeconds)} in water · ${dist} m astern`;
    tag.classList.add('alarm-tag');
  } else {
    tag.textContent = '● ALL CREW ABOARD';
    tag.classList.remove('alarm-tag');
  }
}

function triggerMOB() {
  if (mobActive) return;
  mobActive    = true;
  CREW[0].mob  = true;
  mobSeconds   = 0;
  mobGPS       = { lat: 24.1312, lon: 38.0521 };

  /* Sea video → blood-water tint */
  setAlarm(true);

  /* UI */
  document.getElementById('alarm-banner').classList.add('visible');
  document.getElementById('dash-panel').classList.add('alarm');
  document.getElementById('btn-mob').style.display = 'none';
  document.getElementById('btn-standdown').classList.add('visible');

  /* Flash alarm light */
  if (!REDUCED && lightAlarm) lightAlarm.intensity = 10;

  renderRoster();
  updateStatus();
}

function standDown() {
  if (!mobActive) return;
  mobActive   = false;
  mobSeconds  = 0;
  CREW[0].mob = false;
  blipDrift[0].ox = 0; blipDrift[0].oy = 0;
  blipDrift[0].vx = 0; blipDrift[0].vy = 0;

  /* Tint fades back out */
  setAlarm(false);

  /* Reset 3D blip position */
  if (sonarSphere) {
    const blip = sonarSphere.getObjectByName('blip-0');
    if (blip) {
      const m = CREW[0];
      const theta = (m.x - 0.5) * Math.PI;
      const phi   = (m.y - 0.5) * Math.PI * 0.8;
      const r = 4.6;
      blip.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi) * 0.4,
        r * Math.sin(phi) * Math.sin(theta)
      );
    }
  }

  /* UI */
  document.getElementById('alarm-banner').classList.remove('visible');
  document.getElementById('dash-panel').classList.remove('alarm');
  document.getElementById('btn-mob').style.display = '';
  document.getElementById('btn-standdown').classList.remove('visible');

  renderRoster();
  updateStatus();
}

/* ══════════════════════════════════════════════════════════════
   TICK — 1 Hz heartbeat (roster + MOB telemetry)
   ══════════════════════════════════════════════════════════════ */
function tick() {
  if (mobActive) {
    mobSeconds++;

    /* GPS drift — bearing 214° SW at ~0.3 kts */
    const bear = 214 * (Math.PI / 180);
    mobGPS.lat -= Math.cos(bear) * MOB_DRIFT + (Math.random() - 0.5) * MOB_DRIFT * 0.2;
    mobGPS.lon -= Math.sin(bear) * MOB_DRIFT + (Math.random() - 0.5) * MOB_DRIFT * 0.2;

    /* Live alarm banner text */
    const dist  = Math.round(5 + mobSeconds * 0.15);
    const cgETA = Math.max(1, 18 - Math.floor(mobSeconds / 60));
    const alarmEl = document.getElementById('alarm-text');
    if (alarmEl) {
      alarmEl.textContent =
        `MAN OVERBOARD — Tunde A. · ${fmtMobTime(mobSeconds)} in water · ${dist} m from vessel · Coast Guard ETA ~${cgETA} min`;
    }

    updateStatus();
  }
  renderRoster();
}

/* ══════════════════════════════════════════════════════════════
   MOB CINEMATIC — the "person falls overboard" replay
   ══════════════════════════════════════════════════════════════ */
const SVGNS = 'http://www.w3.org/2000/svg';
let cineTL = null;
let cineBeaconTween = null;
let cineOnContinue = null;

function el(id) { return document.getElementById(id); }

function startBeaconPulse() {
  stopBeaconPulse();
  cineBeaconTween = gsap.fromTo('.cine-beacon-pulse',
    { attr: { r: 8 }, opacity: 0.9 },
    { attr: { r: 40 }, opacity: 0, duration: 1.1, ease: 'power2.out', repeat: -1 });
}
function stopBeaconPulse() {
  if (cineBeaconTween) { cineBeaconTween.kill(); cineBeaconTween = null; }
}

function seedCaustics() {
  /* Faint wavy light bands drifting just under the surface */
  const g = document.querySelector('.cine-caustic');
  if (!g || g.childNodes.length) return;
  for (let i = 0; i < 5; i++) {
    const y = 460 + i * 42;
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', `M0,${y} Q300,${y - 14} 600,${y} T1200,${y}`);
    p.setAttribute('stroke', '#8af0e4');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('fill', 'none');
    p.setAttribute('opacity', (0.10 - i * 0.012).toFixed(3));
    g.appendChild(p);
    if (typeof gsap !== 'undefined' && !REDUCED) {
      gsap.to(p, { attr: { d: `M0,${y + 6} Q300,${y + 16} 600,${y + 4} T1200,${y + 8}` },
        duration: 3 + i * 0.4, repeat: -1, yoyo: true, ease: 'sine.inOut' });
    }
  }
}

function spawnDroplets() {
  const g = el('cine-droplets');
  if (!g) return;
  g.innerHTML = '';
  const drops = [];
  for (let i = 0; i < 16; i++) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', 430);
    c.setAttribute('cy', 434);
    c.setAttribute('r', 2 + Math.random() * 4);
    c.setAttribute('fill', i % 3 === 0 ? '#ffffff' : '#bdeee7');
    g.appendChild(c);
    drops.push(c);
  }
  return drops;
}

function resetCineScene() {
  if (typeof gsap === 'undefined') return;
  stopBeaconPulse();
  gsap.set('#cine-faller', { x: 360, y: 210, rotation: 0, opacity: 1, transformOrigin: '50% 50%' });
  gsap.set('#cine-splash', { opacity: 0 });
  gsap.set('#cine-beacon', { opacity: 0, scale: 1 });
  gsap.set('#cine-stamp',  { opacity: 0, scale: 1.4 });
  gsap.set('.cine-ripple', { attr: { r: 8 }, opacity: 0 });
  gsap.set('#cine-boat',   { y: 0 });
  gsap.set('#cine-actions', {});
  el('cine-actions').classList.remove('show');
  el('cine-caption').classList.remove('alarm');
  el('cine-clock').textContent = 'T+0.0s';
  el('cine-caption').textContent = 'Crew member at rail — TB-01 · Tunde A.';
}

function buildCineTimeline() {
  const drops = spawnDroplets();
  const clock = { t: 0 };
  const setCap = (txt, alarm) => {
    el('cine-caption').textContent = txt;
    el('cine-caption').classList.toggle('alarm', !!alarm);
  };

  const tl = gsap.timeline({
    onComplete() {
      el('cine-actions').classList.add('show');
    },
  });

  /* Running mission clock 0 → 3.4s */
  tl.to(clock, {
    t: 3.4, duration: 3.4, ease: 'none',
    onUpdate() { el('cine-clock').textContent = `T+${clock.t.toFixed(1)}s`; },
  }, 0);

  /* Gentle boat bob throughout */
  tl.to('#cine-boat', { y: 6, duration: 1.4, repeat: 3, yoyo: true, ease: 'sine.inOut' }, 0);

  /* Teeter at the rail */
  tl.to('#cine-faller', { rotation: -14, duration: 0.45, ease: 'sine.inOut' }, 0.35)
    .add(() => setCap('Loses balance at the rail…'), 0.55);

  /* THE FALL — gravity accelerates them down + outboard, tumbling */
  tl.to('#cine-faller', {
    x: 430, y: 432, rotation: 196, duration: 1.05, ease: 'power1.in',
  }, 0.85);

  /* IMPACT */
  tl.add(() => {
    setCap('Hits the water — band wetted, circuit closes.');
    gsap.set('#cine-splash', { opacity: 1 });
    /* ripples */
    gsap.fromTo('.cine-ripple',
      { attr: { r: 8 }, opacity: 0.9 },
      { attr: { r: 130 }, opacity: 0, duration: 1.6, ease: 'power2.out', stagger: 0.18, repeat: 1 });
    /* droplets burst */
    if (drops) drops.forEach((d, i) => {
      const ang = (-Math.PI) * (0.15 + Math.random() * 0.7);
      const spd = 40 + Math.random() * 90;
      gsap.fromTo(d, { x: 0, y: 0, opacity: 1 }, {
        x: Math.cos(ang) * spd, y: Math.sin(ang) * spd - 20,
        opacity: 0, duration: 0.7 + Math.random() * 0.4, ease: 'power2.out',
      });
      gsap.to(d, { y: '+=120', duration: 0.9, ease: 'power1.in', delay: 0.2 });
    });
    /* surface jolt */
    gsap.fromTo('#cine-surface', { attr: { d: 'M0,432 Q150,420 300,432 T600,432 T900,432 T1200,432 V470 H0 Z' },
      opacity: 1 },
      { attr: { d: 'M0,432 Q150,448 300,430 T600,440 T900,428 T1200,434 V470 H0 Z' },
        duration: 0.5, yoyo: true, repeat: 3, ease: 'sine.inOut' });
  }, 1.85);

  /* Submerge, then bob up to float */
  tl.to('#cine-faller', { y: 474, rotation: 250, opacity: 0.35, duration: 0.5, ease: 'power1.in' }, 1.95)
    .to('#cine-faller', { y: 452, opacity: 0.8, duration: 0.7, ease: 'power2.out' }, 2.45);

  /* Distress beacon + stamp.  The infinite pulse runs as its OWN tween so it
     never blocks the timeline from completing (which is what fires the buttons). */
  tl.to('#cine-beacon', { opacity: 1, duration: 0.3 }, 2.55)
    .call(() => {
      setCap('MAN OVERBOARD confirmed — alarm sounded, GPS marked, shore alerted.', true);
      startBeaconPulse();
    }, null, 2.6)
    .to('#cine-stamp', { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(2)' }, 2.6)
    .fromTo('#cine-stamp', { x: -6 }, { x: 6, duration: 0.06, repeat: 7, yoyo: true, ease: 'none' }, 2.6);

  return tl;
}

function playCinematic(onContinue) {
  cineOnContinue = onContinue || null;
  const overlay = el('mob-cine');
  if (!overlay) { if (onContinue) onContinue(); return; }

  /* Reduced motion or no GSAP — skip straight to the live dashboard MOB */
  if (REDUCED || typeof gsap === 'undefined') {
    if (onContinue) onContinue();
    return;
  }

  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  gsap.to(overlay, { opacity: 1, duration: 0.4, ease: 'power2.out' });

  seedCaustics();
  resetCineScene();
  if (cineTL) cineTL.kill();
  cineTL = buildCineTimeline();
}

function closeCinematic() {
  const overlay = el('mob-cine');
  if (!overlay) return;
  if (cineTL) cineTL.kill();
  stopBeaconPulse();
  gsap.to(overlay, {
    opacity: 0, duration: 0.35, ease: 'power2.in',
    onComplete() {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    },
  });
}

/* ══════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════ */
function boot() {
  setupBgVideo();

  resizeMini();
  miniLoop();
  window.addEventListener('resize', resizeMini, { passive: true });

  renderRoster();
  updateStatus();
  setInterval(tick, 1000);

  initAnimations();

  /* Dashboard "simulate" — play the fall replay, then arm the live dashboard */
  document.getElementById('btn-mob').addEventListener('click', () => {
    playCinematic(triggerMOB);
  });
  document.getElementById('btn-standdown').addEventListener('click', standDown);

  /* Hero "Activate Live Demo" — replay, then hand off to the dashboard */
  document.getElementById('btn-hero-demo').addEventListener('click', () => {
    playCinematic(() => {
      document.getElementById('dashboard').scrollIntoView({ behavior: 'smooth' });
      setTimeout(triggerMOB, 650);
    });
  });

  /* Cinematic controls */
  const cont = document.getElementById('cine-continue');
  const rep  = document.getElementById('cine-replay');
  if (cont) cont.addEventListener('click', () => {
    closeCinematic();
    if (cineOnContinue) cineOnContinue();
  });
  if (rep) rep.addEventListener('click', () => {
    resetCineScene();
    if (cineTL) cineTL.kill();
    cineTL = buildCineTimeline();
    document.getElementById('cine-actions').classList.remove('show');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
