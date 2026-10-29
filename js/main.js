import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPlant } from './plant.js';
import { createFlies } from './flies.js';
import { Spider } from './spider.js';

const root = document.documentElement;
const canvas = document.getElementById('scene');
const panel = document.getElementById('panel');
const panelBody = panel.querySelector('.panel-body');
const sections = [...panel.querySelectorAll('section[data-section]')];
const labelLayer = document.querySelector('.labels');
const hint = document.querySelector('.hint');
const mobileQuery = matchMedia('(max-width: 760px)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Each section's heading doubles as its leaf label
const SECTION_NAMES = Object.fromEntries(sections.map(s => [s.dataset.section, s.querySelector('h2').textContent.trim()]));
const HOME_TARGET = new THREE.Vector3(0, 1.35, 0);
const HOME_DIR = new THREE.Vector3(0, 1.4, 5.6).normalize();
// Orbit limits. Camera framing is clamped to the same range so the controls never snap.
const LIMITS = { minPolar: 0.6, maxPolar: 1.6, minAzimuth: -1.1, maxAzimuth: 1.1, minDistance: 1.2, maxDistance: 11 };

function webglAvailable() {
    try {
        const test = document.createElement('canvas');
        return !!(test.getContext('webgl2') || test.getContext('webgl'));
    } catch {
        return false;
    }
}

function showPlainPage() {
    root.classList.remove('loading-3d', 'has-3d');
}

if (webglAvailable()) {
    try {
        start();
    } catch (err) {
        console.error(err);
        showPlainPage();
    }
} else {
    showPlainPage();
}

function start() {
    root.classList.add('has-3d');

    // Renderer, camera and lights match dev/harness.js
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 60);
    const controls = new OrbitControls(camera, canvas);
    Object.assign(controls, {
        enableDamping: true,
        enablePan: false,
        rotateSpeed: 0.55,
        zoomSpeed: 0.6,
        minPolarAngle: LIMITS.minPolar,
        maxPolarAngle: LIMITS.maxPolar,
        minAzimuthAngle: LIMITS.minAzimuth,
        maxAzimuthAngle: LIMITS.maxAzimuth,
        minDistance: LIMITS.minDistance,
        maxDistance: LIMITS.maxDistance,
    });

    // Dusk jungle: soft green sky fill, warm key with shadows, cool rim from behind
    const hemi = new THREE.HemisphereLight(0xbfe3a8, 0x1b2a16, 0.9);
    const key = new THREE.DirectionalLight(0xffe2bd, 2.6);
    key.position.set(2.5, 4.5, 3);
    key.target.position.set(0, 1.2, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -2.4, right: 2.4, top: 2.4, bottom: -2.4, near: 0.5, far: 12 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    const rim = new THREE.DirectionalLight(0x9fcfff, 1.4);
    rim.position.set(-3, 2.5, -3);
    scene.add(hemi, key, key.target, rim);

    const plant = createPlant();
    scene.add(plant.group);
    const flies = createFlies({ scene, plant, count: 4 });
    const spider = new Spider({ scene, plant, flies, camera });

    // index.html decides which leaf opens which section (data-leaf on each <section>)
    plant.leaves.forEach(l => { l.section = null; });
    for (const s of sections) {
        const leaf = plant.leaves.find(l => String(l.id) === s.dataset.leaf);
        if (leaf) leaf.section = s.dataset.section;
    }
    const leafBySection = new Map(plant.leaves.filter(l => l.section).map(l => [l.section, l]));
    if (new URLSearchParams(location.search).has('debug')) window.site = { scene, camera, controls, plant, flies, spider };
    const _v = new THREE.Vector3();
    const _p = new THREE.Vector3();
    const _n = new THREE.Vector3();
    const _pos = new THREE.Vector3();
    const _target = new THREE.Vector3();
    const _sph = new THREE.Spherical();

    // ---------- Camera: framing, fly-to, and the shift that makes room for the sidebar ----------
    const cam = {
        fromPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(),
        toPos: new THREE.Vector3(), toTarget: new THREE.Vector3(),
        t: 1, duration: 1.4,
        shift: 0, shiftTo: 0,
    };
    const panelSize = { w: 0, h: 0 };
    let mobile = mobileQuery.matches;

    function homePose(pos, target) {
        const vHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const dist = Math.max(1.8 / vHalf, 1.45 / (vHalf * camera.aspect));
        target.copy(HOME_TARGET);
        return pos.copy(HOME_TARGET).addScaledVector(HOME_DIR, Math.min(dist, LIMITS.maxDistance));
    }

    function leafPose(leaf, pos, target) {
        leaf.surfacePoint(leaf.center.u, leaf.center.v, _p, _n);
        target.copy(_p).addScaledVector(_n, 0.06);
        // Look at the leaf's face, leaning toward the usual front view
        _v.copy(_n).multiplyScalar(0.5).addScaledVector(HOME_DIR, 0.5).normalize();
        _sph.setFromVector3(_v);
        _sph.phi = THREE.MathUtils.clamp(_sph.phi, LIMITS.minPolar + 0.05, LIMITS.maxPolar - 0.05);
        _sph.theta = THREE.MathUtils.clamp(_sph.theta, LIMITS.minAzimuth + 0.05, LIMITS.maxAzimuth - 0.05);
        _v.setFromSpherical(_sph);
        // Fit about 1.6 units (the leaf plus some of its neighbours) into the part of the
        // screen the sidebar leaves free
        const vHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const freeW = mobile ? 1 : 1 - panelSize.w / innerWidth;
        const freeH = mobile ? 1 - panelSize.h / innerHeight : 1;
        const dist = 1.6 / (2 * vHalf * Math.min(freeH, camera.aspect * freeW));
        return pos.copy(target).addScaledVector(_v, THREE.MathUtils.clamp(dist, 1.5, 6));
    }

    function flyTo(pos, target, duration = 1.4) {
        cam.fromPos.copy(camera.position);
        cam.fromTarget.copy(controls.target);
        cam.toPos.copy(pos);
        cam.toTarget.copy(target);
        cam.duration = reduceMotion ? 0.3 : duration;
        cam.t = 0;
        controls.enabled = false;
    }

    function reframe(duration) {
        const leaf = activeSection && leafBySection.get(activeSection);
        if (leaf) leafPose(leaf, _pos, _target);
        else homePose(_pos, _target);
        flyTo(_pos, _target, duration);
    }

    const ease = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

    function updateCamera(dt) {
        cam.shift += (cam.shiftTo - cam.shift) * (1 - Math.exp(-dt * 5));
        if (cam.t < 1) {
            cam.t = Math.min(1, cam.t + dt / cam.duration);
            const k = ease(cam.t);
            camera.position.lerpVectors(cam.fromPos, cam.toPos, k);
            controls.target.lerpVectors(cam.fromTarget, cam.toTarget, k);
            camera.lookAt(controls.target);
            if (cam.t >= 1) controls.enabled = true;
        } else {
            controls.update();
        }
        // Slide the rendered image so the focus point sits in the middle of the free area
        const sx = mobile ? 0 : (panelSize.w / 2) * cam.shift;
        const sy = mobile ? (panelSize.h / 2) * cam.shift : 0;
        if (sx > 0.5 || sy > 0.5) camera.setViewOffset(innerWidth, innerHeight, sx, sy, innerWidth, innerHeight);
        else if (camera.view?.enabled) camera.clearViewOffset();
    }

    function resize() {
        const w = innerWidth, h = innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.fov = camera.aspect < 0.8 ? 45 : 35;
        camera.updateProjectionMatrix();
        mobile = mobileQuery.matches;
        panelSize.w = panel.offsetWidth;
        panelSize.h = panel.offsetHeight;
    }
    resize();
    homePose(camera.position, controls.target);
    camera.lookAt(controls.target);

    // Start the spider on the decorative leaf nearest the camera, so it's in view right away
    scene.updateMatrixWorld(true);
    const startLeaf = plant.leaves
        .filter(l => !l.section)
        .map(l => ({ l, d: l.surfacePoint(l.center.u, l.center.v, _p, _n).distanceTo(camera.position) }))
        .sort((a, b) => a.d - b.d)[0]?.l ?? plant.leaves[0];
    spider.placeOn(startLeaf, startLeaf.center.u, startLeaf.center.v);
    spider.setRoaming(!reduceMotion);
    addEventListener('resize', () => {
        resize();
        reframe(0.4);
    });

    // ---------- Leaf labels (also the keyboard way in, in the same order as the sections) ----------
    const labels = sections.map(s => leafBySection.get(s.dataset.section)).filter(Boolean).map(leaf => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'leaf-label';
        el.textContent = SECTION_NAMES[leaf.section];
        el.addEventListener('click', () => navigate(leaf.section));
        el.addEventListener('pointerenter', () => setHover(leaf));
        el.addEventListener('pointerleave', () => setHover(null));
        el.addEventListener('focus', () => setHover(leaf));
        el.addEventListener('blur', () => setHover(null));
        labelLayer.appendChild(el);
        return { leaf, el };
    });

    function updateLabels() {
        for (const { leaf, el } of labels) {
            leaf.labelAnchor(_v).project(camera);
            const hidden = _v.z > 1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05;
            el.classList.toggle('is-hidden', hidden);
            if (hidden) continue;
            const x = ((_v.x + 1) / 2) * innerWidth;
            const y = ((1 - _v.y) / 2) * innerHeight;
            el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        }
    }

    // ---------- Hover glow ----------
    let hovered = null;
    let pendingLeaf = null;
    const glow = new Map(plant.leaves.map(l => [l, 0]));

    function setHover(leaf) {
        if (hovered === leaf) return;
        hovered = leaf;
        labels.forEach(l => l.el.classList.toggle('is-hover', l.leaf === leaf));
    }

    function setPending(leaf) {
        pendingLeaf = leaf;
        labels.forEach(l => l.el.classList.toggle('is-pending', l.leaf === leaf));
    }

    function updateGlow(dt) {
        const active = activeSection && leafBySection.get(activeSection);
        for (const [leaf, value] of glow) {
            const goal = leaf === hovered ? 1 : leaf === active || leaf === pendingLeaf ? 0.35 : 0;
            if (Math.abs(goal - value) < 0.002) continue;
            const next = value + (goal - value) * (1 - Math.exp(-dt * 10));
            glow.set(leaf, next);
            leaf.setHighlight(next);
        }
    }

    // ---------- Pointer: hover, gaze, clicks ----------
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pickables = [...spider.pickables, ...plant.pickables];
    const gaze = new THREE.Vector3();
    const pointer = { x: 0, y: 0, overCanvas: false, moved: false, down: null };

    function tagOf(object, key) {
        for (let o = object; o; o = o.parent) if (o.userData[key]) return o.userData[key];
        return null;
    }

    function pick(x, y) {
        ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        return raycaster.intersectObjects(pickables, true)[0] ?? null;
    }

    addEventListener('pointermove', e => {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
        pointer.overCanvas = e.target === canvas;
        pointer.moved = true;
    });
    document.addEventListener('mouseout', e => {
        if (e.relatedTarget) return;
        pointer.overCanvas = false;
        setHover(null);
        spider.setGaze(null);
    });

    function pointerFrame() {
        if (!pointer.moved) return;
        pointer.moved = false;
        const hit = pick(pointer.x, pointer.y);
        const leaf = hit && tagOf(hit.object, 'leaf');
        const onSpider = hit && tagOf(hit.object, 'spider');
        if (pointer.overCanvas) {
            setHover(leaf);
            canvas.style.cursor = leaf || onSpider ? 'pointer' : '';
        }
        // The spider watches the cursor
        if (hit) gaze.copy(hit.point);
        else gaze.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, camera.position.distanceTo(controls.target));
        spider.setGaze(gaze);
    }

    canvas.addEventListener('pointerdown', e => {
        pointer.down = { x: e.clientX, y: e.clientY, time: performance.now() };
        hint.classList.add('is-gone');
    });
    canvas.addEventListener('pointerup', e => {
        const down = pointer.down;
        pointer.down = null;
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.time > 700) return;
        const hit = pick(e.clientX, e.clientY);
        if (hit && tagOf(hit.object, 'spider')) return spider.poke();
        const leaf = hit && tagOf(hit.object, 'leaf');
        if (leaf?.section) return navigate(leaf.section);
        if (leaf) return visit(leaf);
        if (activeSection) goHome();
    });

    // ---------- Sections ----------
    let activeSection = null;
    let navId = 0;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function navigate(section, { push = true } = {}) {
        const leaf = leafBySection.get(section);
        if (!leaf) return;
        if (push && location.hash !== `#${section}`) history.pushState(null, '', `#${section}`);
        const id = ++navId;
        setPending(leaf);
        spider.setRoaming(false);
        leafPose(leaf, _pos, _target);
        flyTo(_pos, _target);
        let arrived = true;
        try {
            // The sidebar opens once the spider lands, with a safety net in case it gets held up
            arrived = await Promise.race([spider.goToLeaf(leaf), delay(3500).then(() => true)]);
        } catch (err) {
            console.error(err);
        }
        if (id !== navId || !arrived) return;
        setPending(null);
        openPanel(section);
    }

    // A leaf without a section: the spider just goes and sits there
    function visit(leaf) {
        if (activeSection) goHome();
        spider.goToLeaf(leaf).catch(err => console.error(err));
    }

    function goHome({ push = true } = {}) {
        navId++;
        setPending(null);
        if (push && location.hash) history.pushState(null, '', location.pathname + location.search);
        closePanel();
        homePose(_pos, _target);
        flyTo(_pos, _target, 1.2);
        spider.setRoaming(!reduceMotion);
    }

    function openPanel(section) {
        activeSection = section;
        sections.forEach(s => s.classList.toggle('is-active', s.dataset.section === section));
        root.classList.add('panel-open');
        panel.setAttribute('aria-label', SECTION_NAMES[section]);
        panelBody.scrollTop = 0;
        panelSize.w = panel.offsetWidth;
        panelSize.h = panel.offsetHeight;
        cam.shiftTo = 1;
        labels.forEach(l => {
            l.el.classList.toggle('is-active', l.leaf.section === section);
            if (l.leaf.section === section) l.el.setAttribute('aria-current', 'true');
            else l.el.removeAttribute('aria-current');
        });
        panel.focus({ preventScroll: true });
    }

    function closePanel() {
        activeSection = null;
        root.classList.remove('panel-open');
        cam.shiftTo = 0;
        labels.forEach(l => {
            l.el.classList.remove('is-active');
            l.el.removeAttribute('aria-current');
        });
    }

    panel.querySelector('.panel-close').addEventListener('click', () => goHome());
    addEventListener('keydown', e => {
        if (e.key === 'Escape' && activeSection) goHome();
    });
    addEventListener('popstate', () => {
        const section = location.hash.slice(1);
        if (leafBySection.has(section)) navigate(section, { push: false });
        else if (activeSection) goHome({ push: false });
    });

    // ---------- Frame loop ----------
    const clock = new THREE.Clock();
    let started = false;
    let t = 0;
    function frame(dt) {
        t += dt;
        try {
            plant.update(dt, t);
            flies.update(dt, t);
            spider.update(dt, t);
            updateCamera(dt);
            pointerFrame();
            updateGlow(dt);
            camera.updateMatrixWorld();
            updateLabels();
            renderer.render(scene, camera);
        } catch (err) {
            // A broken scene shouldn't hide the content: fall back to the plain page
            console.error(err);
            renderer.setAnimationLoop(null);
            showPlainPage();
            return;
        }

        if (!started) {
            started = true;
            root.classList.remove('loading-3d');
            const section = location.hash.slice(1);
            if (leafBySection.has(section)) setTimeout(() => navigate(section, { push: false }), 700);
        }
    }
    renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05)));
    // ?debug: step frames by hand, e.g. site.step(1 / 60, 90), when the tab isn't drawing
    if (window.site) window.site.step = (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) frame(dt); };
}
