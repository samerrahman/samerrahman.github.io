// Flies and fireflies for the dusk jungle scene (Fly API: dev/CONTRACT.md).
// Low-poly, flat-shaded flies wander around the plant with darting, noise-steered flight,
// hover above leaves, land, groom and take off again, and can be held, eaten and released by
// the spider. Fireflies are soft additive glows that drift and blink. All procedural: three
// instanced meshes for the flies (body, front legs, wings) and one Points object.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const R_MAX = 1.6, Y_MIN = 0.4, Y_MAX = 2.8;   // flight volume: cylinder around the plant axis
const LEG_H = 0.0105;                           // body origin above a surface when standing
const SPAWN_X = 3.4;                            // respawns fly in from the left or right edge
const FIREFLY_COUNT = 14;

// Small flat palette (sRGB)
const COL = {
    head: 0x434955, thorax: 0x4d5461, abdomen: 0x383d47, band: 0x5c6371,
    eye: 0xd8402c, leg: 0x24272d, wing: 0xe4f5f1, glow: 0xc9f064,
};

const clamp = THREE.MathUtils.clamp;
const rand = (a, b) => a + Math.random() * (b - a);
const smooth = x => x * x * (3 - 2 * x);
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);   // frame-rate independent lerp factor
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ONE = new THREE.Vector3(1, 1, 1);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

// Scratch objects for the hot paths (no per-frame allocations)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Vector3();
const _h = new THREE.Vector3(), _s = new THREE.Vector3(), _w = new THREE.Vector3();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

// ---------------------------------------------------------------------------------------------
// Fly model. Fly-local axes: +X towards the head, +Y up (back), +Z to the fly's right.
// Body about 0.05 long. Flat shaded, one solid palette colour per facet.

const LEG_ROOT = [new THREE.Vector3(0.0095, -0.0048, -0.003), new THREE.Vector3(0.0095, -0.0048, 0.003)];
const WING_ROOT = [new THREE.Vector3(0.0045, 0.0085, -0.0026), new THREE.Vector3(0.0045, 0.0085, 0.0026)];

function ellipsoid(rx, ry, rz, w, h, alongX) {
    const g = new THREE.SphereGeometry(1, w, h);
    if (alongX) g.rotateZ(-Math.PI / 2);   // poles on the body axis, rings become stripes
    return g.scale(rx, ry, rz);
}

// Non-indexed with one colour per triangle (picked from its centroid), so facets read as solid
function facets(geo, colorOf) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.deleteAttribute('uv');
    const p = g.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
    for (let i = 0; i < p.count; i += 3) {
        const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
        const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
        const z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
        c.set(colorOf(x, y, z));
        for (let k = 0; k < 3; k++) c.toArray(col, (i + k) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
}

// Thin three-sided prism through a polyline: a low-poly leg, 6 triangles per segment
function limb(points, r) {
    const pos = [], a = new THREE.Vector3(), b = new THREE.Vector3();
    const dir = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const A = [0, 1, 2].map(() => new THREE.Vector3()), B = A.map(() => new THREE.Vector3());
    for (let i = 0; i < points.length - 1; i++) {
        a.fromArray(points[i]);
        b.fromArray(points[i + 1]);
        dir.subVectors(b, a).normalize();
        e1.crossVectors(dir, Math.abs(dir.y) < 0.9 ? UP : X_AXIS).normalize();
        e2.crossVectors(dir, e1);
        for (let k = 0; k < 3; k++) {
            const t = k / 3 * Math.PI * 2, cs = Math.cos(t) * r, sn = Math.sin(t) * r;
            A[k].copy(a).addScaledVector(e1, cs).addScaledVector(e2, sn);
            B[k].copy(b).addScaledVector(e1, cs * 0.75).addScaledVector(e2, sn * 0.75);   // taper
        }
        for (let k = 0; k < 3; k++) {   // outward winding
            const k2 = (k + 1) % 3;
            for (const v of [A[k], B[k2], B[k], A[k], A[k2], B[k2]]) pos.push(v.x, v.y, v.z);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
}

function bodyGeometry() {
    const parts = [];
    // Chunky round thorax, lighter on top
    parts.push(facets(ellipsoid(0.0105, 0.0095, 0.0095, 7, 5).translate(0.004, 0.0015, 0),
        (x, y) => (y > 0.006 ? COL.band : COL.thorax)));
    // Short abdomen, tapered towards the tip, striped by its rings
    const abd = ellipsoid(0.0125, 0.0082, 0.0092, 7, 6, true);
    const p = abd.attributes.position;
    for (let i = 0; i < p.count; i++) {
        const back = clamp(-p.getX(i) / 0.0125, 0, 1), k = 1 - 0.3 * back * back;
        p.setXYZ(i, p.getX(i), p.getY(i) * k * (p.getY(i) < 0 ? 0.85 : 1), p.getZ(i) * k);
    }
    abd.translate(-0.0135, 0, 0);
    parts.push(facets(abd, x => {
        const ring = Math.floor(Math.acos(clamp((x + 0.0135) / 0.0125, -1, 1)) / (Math.PI / 6));
        return ring % 2 && ring < 5 ? COL.band : COL.abdomen;
    }));
    // Big head with two faceted red eyes
    parts.push(facets(ellipsoid(0.0065, 0.0072, 0.0085, 6, 4).translate(0.0172, 0.001, 0), () => COL.head));
    for (const s of [-1, 1]) {
        const eye = new THREE.IcosahedronGeometry(1, 0).scale(0.0052, 0.0063, 0.0046);
        eye.rotateY(s * 0.35).translate(0.0185, 0.0025, s * 0.0055);
        parts.push(facets(eye, () => COL.eye));
    }
    // Middle and hind legs (the front pair is animated separately)
    const legs = [
        [[0.004, -0.0058, 0.004], [0.005, -0.001, 0.0135], [0.003, -0.0105, 0.021]],
        [[-0.002, -0.0058, 0.0035], [-0.009, -0.0015, 0.0125], [-0.016, -0.0105, 0.017]],
    ];
    for (const leg of legs) {
        for (const s of [-1, 1]) {
            parts.push(facets(limb(leg.map(([x, y, z]) => [x, y, z * s]), 0.0009), () => COL.leg));
        }
    }
    return mergeGeometries(parts);
}

// Front leg drawn in its own vertical plane from the hip at the origin, pointing along +X
function frontLegGeometry() {
    return facets(limb([[0, 0, 0], [0.0068, 0.003, 0], [0.0145, -0.0057, 0]], 0.0009), () => COL.leg);
}

// Flat wing in the XZ plane: span along +X from the hinge, leading edge towards +Z
function wingGeometry() {
    const s = [[0, 0], [0.011, 0.0034], [0.026, 0.003], [0.0325, -0.0015], [0.022, -0.008], [0.007, -0.0058]];
    const pos = [];
    for (let i = 1; i < s.length - 1; i++) pos.push(0, 0, 0, s[i][0], 0, s[i][1], s[i + 1][0], 0, s[i + 1][1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
}

// Soft round glow for the fireflies
function glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.07, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.22, 'rgba(255,255,255,0.3)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.09)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------------------------
// Leaves as obstacles. Each leaf is split into three patches along the midrib. A patch frame
// follows the leaf (refreshed every frame from surfacePoint) and a box is fitted once in that
// frame, so flies can tell when they are about to fly through a blade.

class LeafInfo {
    constructor(leaf) {
        const v3 = k => Array.from({ length: k }, () => new THREE.Vector3());
        this.leaf = leaf;
        this.P = v3(4); this.N = v3(4);                                    // midrib at u = 0, 1/3, 2/3, 1
        this.C = v3(3); this.M = v3(3); this.S = v3(3); this.Nn = v3(3);   // patch centre and axes
        this.box = new Float32Array(18);   // per patch: along, across, height (min, max)
        this.len = 1;                      // midrib length, world units
        this.refresh();
        this.fit();
    }

    refresh() {
        const { leaf, P, N, C, M, S, Nn } = this;
        for (let k = 0; k < 4; k++) leaf.surfacePoint(k / 3, 0, P[k], N[k]);
        for (let k = 0; k < 3; k++) {
            C[k].addVectors(P[k], P[k + 1]).multiplyScalar(0.5);
            M[k].subVectors(P[k + 1], P[k]).normalize();
            Nn[k].addVectors(N[k], N[k + 1]);
            Nn[k].addScaledVector(M[k], -Nn[k].dot(M[k])).normalize();
            S[k].crossVectors(M[k], Nn[k]);
        }
    }

    fit() {
        const b = this.box;
        for (let k = 0; k < 3; k++) {
            const o = k * 6;
            b[o] = b[o + 2] = b[o + 4] = Infinity;
            b[o + 1] = b[o + 3] = b[o + 5] = -Infinity;
            for (let i = 0; i <= 6; i++) {
                for (let j = 0; j <= 8; j++) {
                    this.leaf.surfacePoint((k + i / 6) / 3, j / 4 - 1, _a, _n).sub(this.C[k]);
                    const x = _a.dot(this.M[k]), y = _a.dot(this.S[k]), z = _a.dot(this.Nn[k]);
                    b[o] = Math.min(b[o], x); b[o + 1] = Math.max(b[o + 1], x);
                    b[o + 2] = Math.min(b[o + 2], y); b[o + 3] = Math.max(b[o + 3], y);
                    b[o + 4] = Math.min(b[o + 4], z); b[o + 5] = Math.max(b[o + 5], z);
                }
            }
        }
        const P = this.P;
        this.len = P[0].distanceTo(P[1]) + P[1].distanceTo(P[2]) + P[2].distanceTo(P[3]);
    }

    // Is p inside a patch box grown by the margins? → +1 above the blade, -1 below, 0 clear
    hit(p, mAB, mH, outN) {
        const b = this.box;
        for (let k = 0; k < 3; k++) {
            const o = k * 6;
            _h.subVectors(p, this.C[k]);
            const x = _h.dot(this.M[k]);
            if (x < b[o] - mAB || x > b[o + 1] + mAB) continue;
            const y = _h.dot(this.S[k]);
            if (y < b[o + 2] - mAB || y > b[o + 3] + mAB) continue;
            const z = _h.dot(this.Nn[k]);
            if (z < b[o + 4] - mH || z > b[o + 5] + mH) continue;
            outN.copy(this.Nn[k]);
            const side = z >= (b[o + 4] + b[o + 5]) * 0.5 ? 1 : -1;
            hitGap = Math.max(0, side > 0 ? z - b[o + 5] : b[o + 4] - z);   // clearance to the blade
            return side;
        }
        return 0;
    }
}
let hitGap = 0;   // set by LeafInfo.hit

// ---------------------------------------------------------------------------------------------
// One fly. Internal modes map onto the public state:
//   wander, approach, flee, launch, enter → 'flying'    hover, descend → 'hovering'
//   landed → 'landed'    held (also while being eaten) → 'caught'    gone → 'gone'
const STATE = {
    wander: 'flying', approach: 'flying', flee: 'flying', launch: 'flying', enter: 'flying',
    hover: 'hovering', descend: 'hovering', landed: 'landed', held: 'caught', gone: 'gone',
};

class Fly {
    constructor(sys, index) {
        this.sys = sys;
        this.index = index;
        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.state = 'flying';
        this.leaf = null;                        // leaf it hovers over or stands on, else null
        this.quaternion = new THREE.Quaternion();
        this.size = rand(0.92, 1.08);
        this.scale = 1;                          // shrinks while eaten, grows in after a respawn

        this._mode = 'wander';
        this._modeT = 0;
        this._modeDur = rand(1, 4);
        this._heading = new THREE.Vector3();     // where the wander steering wants to go
        this._des = new THREE.Vector3();         // desired velocity this frame
        this._fwd = new THREE.Vector3(1, 0, 0);  // smoothed body forward
        this._acc = new THREE.Vector3();         // smoothed acceleration, for banking
        this._pv = new THREE.Vector3();          // last velocity
        this._prev = new THREE.Vector3();        // last position
        this._target = new THREE.Vector3();
        this._off = new THREE.Vector3();         // hover dart offset
        this._ln = new THREE.Vector3(0, 1, 0);   // leaf normal under the fly
        this._hp = new THREE.Vector3();          // last holder sample
        this._hpOk = false;
        this._speed = 0.8;
        this._saccadeIn = rand(0.2, 1);
        this._dartT = 0;
        this._goal = 'hover';                    // what an approach ends in: 'hover' | 'land'
        this._info = null;                       // LeafInfo of the target or current leaf
        this._u = 0.5; this._v = 0;              // leaf coordinates while hovering or landed
        this._hoverH = 0.25;
        this._dartIn = 0;
        this._yaw = 0;                           // facing: on a leaf (from +u towards +v) or hovering
        this._tilt = 0;                          // grooming posture
        this._act = 'idle'; this._actT = 0; this._actDur = 1;
        this._wu = 0; this._wv = 0;              // walk target
        this._skip = null; this._skipT = 0;      // leaf the avoidance ignores for a moment
        this._getPos = null;
        this._heldT = 0;
        this._heldQ = new THREE.Quaternion();
        this._eating = false; this._eatT = 0; this._eatDur = 1.5;
        this._respawnIn = 0;
        this._grow = 1;
        this._spread = 1;                        // wings: 0 folded, 1 flapping
        this._flap = rand(0, 6.3);               // wing beat phase
        this._flapHz = rand(14, 17);
        this._legs = new Float32Array(6);        // front legs: yaw, pitch, roll (left, right)
        this._ph = new Float32Array(9);          // noise frequencies and phases
        for (let i = 0; i < 9; i += 3) {
            this._ph[i] = rand(0.7, 1.4);
            this._ph[i + 1] = rand(0, 6.3);
            this._ph[i + 2] = rand(0, 6.3);
        }
        const a = rand(0, Math.PI * 2), r = rand(0.6, 1.3);
        this.position.set(Math.sin(a) * r, rand(0.9, 2.4), Math.cos(a) * r);
        this._heading.set(rand(-1, 1), rand(-0.3, 0.3), rand(-1, 1)).normalize();
        this.velocity.copy(this._heading).multiplyScalar(0.6);
        this._prev.copy(this.position);
        this._orient(0, 0, true);
    }

    // ---- Fly API (called by the spider) ----

    // Caught: stop moving on its own and follow getPos(out) every frame, wings stop. Any state.
    hold(getPos) {
        const wasGone = this._mode === 'gone';
        this._getPos = typeof getPos === 'function' ? getPos : null;
        this._hpOk = false;
        if (this._mode !== 'held') {
            this._eating = false;
            this._eatT = 0;
            this._heldT = 0;
            this._heldQ.copy(this.quaternion);
            this._setMode('held');
        }
        if (wasGone) { this._grow = 1; this.scale = 1; }
        this._follow();   // snap to the holder right away
    }

    // Got away: resume flying and flee (away from `from` when given)
    release(from) {
        if (this._mode === 'gone') return;
        if (this._mode !== 'held') { this.startle(from); return; }
        this._getPos = null;
        this._eating = false;
        this._grow = 1;
        this.scale = 1;
        if (from && from.isVector3) _d.subVectors(this.position, from);
        else _d.set(this.position.x, 0.6, this.position.z);   // out from the plant and up
        this._flee(_d);
    }

    // Shrink and vanish over `duration` s, then respawn from the scene edge 4–8 s later
    eat(duration = 1.5) {
        if (this._mode === 'gone') return;
        if (this._mode !== 'held') this.hold(null);   // eaten where it is
        this._eating = true;
        this._eatDur = Math.max(0.05, Number(duration) || 1.5);
    }

    // Flee away from a point (a random direction when none is given)
    startle(from) {
        if (this._mode === 'held' || this._mode === 'gone') return;
        if (from && from.isVector3) _d.subVectors(this.position, from);
        else _d.set(rand(-1, 1), rand(0.2, 1), rand(-1, 1));
        this._flee(_d);
    }

    // ---- internals ----

    _noise(c, t) {   // smooth noise in about [-1, 1], one channel per c
        const p = this._ph, k = (c % 3) * 3;
        t += c * 13.7;
        return 0.55 * Math.sin(t * p[k] + p[k + 1]) + 0.3 * Math.sin(t * p[k] * 2.31 + p[k + 2])
            + 0.15 * Math.sin(t * p[k] * 5.17 + p[k + 1] * 2);
    }

    _setMode(mode, dur = 0) {
        this._mode = mode;
        this._modeT = 0;
        this._modeDur = dur;
        this.state = STATE[mode];
        this.leaf = (this.state === 'hovering' || this.state === 'landed') && this._info ? this._info.leaf : null;
    }

    _flee(dir) {
        if (dir.lengthSq() < 1e-8) dir.set(rand(-1, 1), 0.5, rand(-1, 1));
        dir.normalize();
        dir.x += rand(-0.3, 0.3);
        dir.y += rand(0.15, 0.45);
        dir.z += rand(-0.3, 0.3);
        dir.normalize();
        if (this._mode === 'landed' || this._mode === 'descend') {
            const up = dir.dot(this._ln);   // push off the leaf, never into it
            if (up < 0.35) dir.addScaledVector(this._ln, 0.35 - up).normalize();
            this._skip = this._info ? this._info.leaf : null;
            this._skipT = 0.5;
        }
        this._heading.copy(dir);
        this.velocity.addScaledVector(dir, 1.1);
        this._speed = rand(1.8, 2.3);
        this._setMode('flee', rand(0.45, 0.8));
    }

    update(dt, t) {
        this._prev.copy(this.position);
        if (this._skipT > 0 && (this._skipT -= dt) <= 0) this._skip = null;
        this._modeT += dt;
        if (this._mode === 'gone') {
            if ((this._respawnIn -= dt) <= 0) this._respawn();
            return;
        }
        if (this._mode === 'held') this._updateHeld(dt, t);
        else if (this._mode === 'landed') this._updateLanded(dt, t);
        else this._updateFlight(dt, t);
        if (this._mode === 'gone') return;
        if (this._mode !== 'held') {
            if (this._grow < 1) this._grow = Math.min(1, this._grow + dt / 0.5);
            this.scale = smooth(this._grow);
        }
        if ((this._mode === 'held' || this._mode === 'landed') && dt > 0) {
            this.velocity.subVectors(this.position, this._prev).divideScalar(dt);
        }
        this._animate(dt, t);
    }

    _updateFlight(dt, t) {
        const p = this.position, v = this.velocity, des = this._des;
        let tau = 0.2, max = 1.5, bound = 1;
        switch (this._mode) {
            case 'wander': tau = this._wander(dt, t); break;
            case 'approach': tau = this._approach(t); break;
            case 'hover': tau = this._hover(dt, t); bound = 0; break;
            case 'descend': tau = this._descend(); bound = 0; break;
            case 'enter': tau = this._enter(t); bound = 0; break;
            case 'flee':
                des.copy(this._heading).multiplyScalar(this._speed);
                tau = 0.06; max = 2.6; bound = 0.35;
                if (this._modeT > this._modeDur) this._startWander(false);
                break;
            default:   // launch: spring up off the leaf
                des.copy(this._heading).multiplyScalar(0.9);
                tau = 0.05;
                if (this._modeT > this._modeDur) this._startWander(false);
        }
        if (this._mode === 'landed') return;   // touched down this frame
        if (bound) this._bounds(des, bound);
        v.lerp(des, damp(dt, tau));
        this._avoid(dt);
        const sp = v.length();
        if (sp > max) v.multiplyScalar(max / sp);
        p.addScaledVector(v, dt);
        if (p.y < 0.15) { p.y = 0.15; if (v.y < 0) v.y = 0; }
        this._orient(dt, t, false);
    }

    // Noise-steered flight with sudden darts in a new direction every second or so
    _wander(dt, t) {
        const h = this._heading, p = this.position;
        this._dartT -= dt;
        if ((this._saccadeIn -= dt) <= 0) this._saccade();
        const out = h.x * p.x + h.z * p.z > 0 && p.x * p.x + p.z * p.z > (R_MAX * 0.8) ** 2;
        if ((out || (p.y < Y_MIN + 0.2 && h.y < 0) || (p.y > Y_MAX - 0.2 && h.y > 0)) && this._dartT < -0.25) {
            this._saccade(true);   // turn back at the edge of the volume, in a smooth arc
        }
        const yaw = this._noise(0, t * 0.9) * 1.6 * dt, c = Math.cos(yaw), s = Math.sin(yaw), x = h.x;
        h.x = x * c + h.z * s;
        h.z = -x * s + h.z * c;
        h.y += (this._noise(1, t * 0.7) * 0.4 - h.y) * damp(dt, 0.6);
        h.normalize();
        const boost = this._dartT > 0 ? 1.45 : 1;
        this._des.copy(h).multiplyScalar(this._speed * boost * (1 + 0.15 * this._noise(2, t * 1.7)));
        if (this._modeT > this._modeDur) this._pickGoal();
        return this._dartT > 0 ? 0.09 : 0.24;
    }

    // Sudden change of direction, biased back towards the plant when far out
    _saccade(edge = false) {
        const h = this._heading, p = this.position;
        const turn = rand(0.5, 2) * (Math.random() < 0.5 ? -1 : 1);
        const c = Math.cos(turn), s = Math.sin(turn), x = h.x;
        h.x = x * c + h.z * s;
        h.z = -x * s + h.z * c;
        h.y = rand(-0.45, 0.45);
        h.normalize();
        const r = Math.hypot(p.x, p.z);
        _a.set(rand(-0.4, 0.4) - p.x, rand(1.2, 2.1) - p.y, rand(-0.4, 0.4) - p.z).normalize();
        const w = 0.85 * smooth(clamp((r - 0.6) / 0.9, 0, 1)) + (p.y < Y_MIN + 0.4 || p.y > Y_MAX - 0.4 ? 0.35 : 0);
        h.lerp(_a, Math.min(w, 0.9));
        if (h.lengthSq() < 1e-6) h.copy(_a);
        h.normalize();
        this._speed = rand(0.45, 1.05);
        this._dartT = edge ? -0.01 : rand(0.12, 0.22);   // a quick dart, or a plain turn at the edge
        this._saccadeIn = rand(0.35, 1.7);
    }

    // Soft walls of the flight cylinder
    _bounds(des, k) {
        const p = this.position, r = Math.hypot(p.x, p.z), r0 = R_MAX - 0.4;
        if (r > r0) {
            const f = k * 2.2 * ((r - r0) / 0.4) ** 2 / r;
            des.x -= p.x * f;
            des.z -= p.z * f;
        }
        if (p.y < Y_MIN + 0.3) des.y += k * 2 * ((Y_MIN + 0.3 - p.y) / 0.3) ** 2;
        else if (p.y > Y_MAX - 0.3) des.y -= k * 2 * ((p.y - Y_MAX + 0.3) / 0.3) ** 2;
    }

    // Don't fly through leaf blades: inside a zone around each blade, turn the heading away and
    // brake the motion into the blade harder the closer it gets, so the path bends smoothly
    _avoid(dt) {
        const zone = 0.1;
        const side = this.sys.hit(this.position, 0.025, zone, this._skip, _n);
        if (!side) return;
        const q = 1 - clamp(hitGap / zone, 0, 1);   // 0 at the edge of the zone, 1 at the blade
        const v = this.velocity, vn = v.dot(_n);
        if (vn * side < 0) v.addScaledVector(_n, -vn * (hitGap < 0.012 ? 1 : Math.min(1, q * q * dt * 50)));
        v.addScaledVector(_n, side * 4 * q * dt);
        const h = this._heading, hn = h.dot(_n);
        if (hn * side < 0) h.addScaledVector(_n, -2 * hn).normalize();
    }

    // What next: keep wandering, hover above a leaf, or land on one (with a clear path to it)
    _pickGoal() {
        this._modeT = 0;
        this._modeDur = rand(2.5, 6);
        const infos = this.sys.infos, roll = Math.random();
        if (!infos.length || roll > 0.8) return;
        const goal = roll < 0.42 ? 'hover' : 'land';
        let best = null, bestD = Infinity, bu = 0, bv = 0, bh = 0;
        for (let k = 0; k < 4; k++) {
            const info = infos[(Math.random() * infos.length) | 0];
            const uv = info.leaf.clampUV(rand(0.2, 0.82), rand(-0.65, 0.65));
            const hgt = goal === 'hover' ? rand(0.15, 0.4) : 0.12;
            info.leaf.surfacePoint(uv.u, uv.v, _t, _n);
            if (_n.y < 0.2) continue;   // too steep, or the underside
            _t.addScaledVector(_n, hgt);
            if (_t.y < Y_MIN || _t.y > Y_MAX) continue;
            const d = _t.distanceToSquared(this.position);
            if (d >= bestD || this.sys.blocked(this.position, _t, info.leaf)) continue;
            best = info; bestD = d; bu = uv.u; bv = uv.v; bh = hgt;
        }
        if (!best) return;
        this._info = best;
        this._u = bu;
        this._v = bv;
        this._hoverH = bh;
        this._goal = goal;
        this._setMode('approach', 7);
    }

    // Hover spot, or the point just above the landing spot; rides along with the leaf
    _goalPoint(out) {
        this._info.leaf.surfacePoint(this._u, this._v, out, this._ln);
        return out.addScaledVector(this._ln, this._goal === 'hover' ? this._hoverH : 0.12);
    }

    _approach(t) {
        const T = this._goalPoint(this._target);
        const d = _a.subVectors(T, this.position), dist = d.length();
        const sp = Math.min(this._speed * 1.1 + 0.2, 0.15 + dist * 2.4);
        this._des.copy(d).multiplyScalar(sp / Math.max(dist, 1e-5));
        const w = Math.min(1, dist * 3) * 0.18;   // lazy wobble while still far away
        this._des.x += this._noise(3, t * 2.2) * w;
        this._des.y += this._noise(4, t * 2) * w * 0.6;
        this._des.z += this._noise(5, t * 2.4) * w;
        if (dist > 1e-4) this._heading.copy(d).divideScalar(dist);
        if (dist < 0.25) { this._skip = this._info.leaf; this._skipT = 0.3; }
        if (dist < 0.03) {
            if (this._goal === 'hover') this._startHover();
            else this._startDescend();
        } else if (this._modeT > this._modeDur) this._startWander(true);
        return 0.16;
    }

    _startHover() {
        this._setMode('hover', rand(1.2, 3.5));
        this._off.set(0, 0, 0);
        this._dartIn = rand(0.3, 1);
        this._yaw = Math.atan2(this._fwd.x, this._fwd.z);
    }

    // Hold station above the leaf with a little bob, darting sideways now and then
    _hover(dt, t) {
        const T = this._goalPoint(this._target);
        this._skip = this._info.leaf;
        this._skipT = 0.3;
        if ((this._dartIn -= dt) <= 0) {
            this._off.set(rand(-1, 1), rand(-0.4, 0.4), rand(-1, 1)).setLength(rand(0.02, 0.07));
            this._yaw += rand(-1.3, 1.3);
            this._dartIn = rand(0.5, 1.4);
        }
        T.add(this._off);
        T.x += this._noise(3, t * 1.6) * 0.008;
        T.y += this._noise(4, t * 2.1) * 0.012;
        T.z += this._noise(5, t * 1.8) * 0.008;
        this._des.subVectors(T, this.position).multiplyScalar(6);
        if (this._modeT > this._modeDur) {
            if (Math.random() < 0.45) this._startDescend();
            else this._leave();
        }
        return 0.08;
    }

    _leave() {
        this._heading.set(rand(-1, 1), 0, rand(-1, 1)).normalize().addScaledVector(this._ln, 0.6).normalize();
        this._startWander(false);
        this._dartT = 0.18;
        this._speed = rand(0.7, 1.1);
    }

    _startWander(dart) {
        this._setMode('wander', rand(2.5, 6));
        if (dart) this._saccade();
        else { this._saccadeIn = rand(0.3, 1.2); this._speed = rand(0.5, 1); }
    }

    _startDescend() {
        this._goal = 'land';
        this._setMode('descend', 3);
    }

    // Settle down onto the landing spot
    _descend() {
        const info = this._info;
        info.leaf.surfacePoint(this._u, this._v, _a, this._ln).addScaledVector(this._ln, LEG_H * this.size);
        this._skip = info.leaf;
        this._skipT = 0.3;
        const d = _b.subVectors(_a, this.position), dist = d.length();
        if (dist < 0.004 || this._modeT > this._modeDur) { this._touchDown(); return 0.1; }
        this._des.copy(d).multiplyScalar(Math.min(0.45, 0.04 + dist * 3.5) / dist);
        return 0.1;
    }

    _touchDown() {
        this._setMode('landed', rand(3, 8));
        this._frame(_a, _n, _b, _c);
        this._yaw = Math.atan2(this._fwd.dot(_c), this._fwd.dot(_b));
        this.position.copy(_a).addScaledVector(_n, LEG_H * this.size);
        this.velocity.set(0, 0, 0);
        this._act = 'idle';
        this._actT = 0;
        this._actDur = rand(0.3, 0.7);
    }

    // Surface point and normal under (u, v), plus the tangents along +u and +v
    _frame(pos, n, tu, tv) {
        const info = this._info;
        info.leaf.surfacePoint(this._u, this._v, pos, n);
        const M = info.M[clamp(Math.floor(this._u * 3), 0, 2)];
        tu.copy(M).addScaledVector(n, -M.dot(n)).normalize();
        tv.crossVectors(tu, n);
        this._ln.copy(n);
        return pos;
    }

    // Standing on a leaf: idle, rub the front legs, clean the head, walk a few steps
    _updateLanded(dt, t) {
        const info = this._info, leaf = info.leaf;
        this._actT += dt;
        if (this._act === 'walk') {
            const W = Math.max(leaf.widthAt(this._u), 0.02);
            const du = (this._wu - this._u) * info.len, dv = (this._wv - this._v) * W;
            const dist = Math.hypot(du, dv), turn = wrap(Math.atan2(dv, du) - this._yaw);
            this._yaw += clamp(turn, -7 * dt, 7 * dt);
            const step = 0.075 * (0.6 + 0.4 * Math.sin(t * 14)) * dt;   // stop-go gait
            if (dist <= step) { this._u = this._wu; this._v = this._wv; this._nextAct(); }
            else if (this._actT > 3) this._nextAct();
            else if (Math.abs(turn) < 0.5) {
                this._u += du / dist * step / info.len;
                this._v += dv / dist * step / W;
            }
        } else if (this._actT > this._actDur) {
            if (this._modeT > this._modeDur) { this._takeOff(); return; }
            this._nextAct();
        }
        const tilt = this._act === 'head' ? -0.14 : this._act === 'rub' ? 0.1 : 0;
        this._tilt += (tilt - this._tilt) * damp(dt, 0.15);
        // ride along with the leaf as it sways and bounces
        this._frame(_a, _n, _b, _c);
        this.position.copy(_a).addScaledVector(_n, LEG_H * this.size);
        _d.copy(_b).multiplyScalar(Math.cos(this._yaw)).addScaledVector(_c, Math.sin(this._yaw));
        _t.crossVectors(_d, _n);
        this.quaternion.setFromRotationMatrix(_m.makeBasis(_d, _n, _t)).multiply(_q.setFromAxisAngle(Z_AXIS, this._tilt));
        // a hard bounce of the leaf (say the spider landing on it) scares it off
        if (dt > 0 && this._modeT > 0.3 && this.position.distanceTo(this._prev) > 0.8 * dt) this.startle();
    }

    _nextAct() {
        this._actT = 0;
        const r = Math.random();
        if (r < 0.3) { this._act = 'rub'; this._actDur = rand(1, 2.4); }
        else if (r < 0.5) { this._act = 'head'; this._actDur = rand(0.8, 1.8); }
        else if (r < 0.75) {   // a few steps somewhere new, inside the walkable region
            const leaf = this._info.leaf, a = this._yaw + rand(-1.6, 1.6), d = rand(0.03, 0.1);
            const W = Math.max(leaf.widthAt(this._u), 0.02);
            const uv = leaf.clampUV(this._u + Math.cos(a) * d / this._info.len, this._v + Math.sin(a) * d / W);
            this._wu = uv.u;
            this._wv = uv.v;
            this._act = 'walk';
        } else { this._act = 'idle'; this._actDur = rand(0.4, 1.2); }
    }

    _takeOff() {
        this._frame(_a, _n, _b, _c);
        _d.copy(_b).multiplyScalar(Math.cos(this._yaw)).addScaledVector(_c, Math.sin(this._yaw));
        this._heading.copy(_n).multiplyScalar(0.8).addScaledVector(_d, 0.6).normalize();
        this.velocity.copy(this._heading).multiplyScalar(0.5);
        this._skip = this._info.leaf;
        this._skipT = 0.6;
        this._setMode('launch', 0.25);
    }

    // Start-up: put the fly straight down on a leaf
    _placeOn(info, u, v) {
        const uv = info.leaf.clampUV(u, v);
        this._info = info;
        this._u = uv.u;
        this._v = uv.v;
        this._yaw = rand(-Math.PI, Math.PI);
        this._setMode('landed', rand(4, 9));
        this._act = 'idle';
        this._actT = 0;
        this._actDur = rand(0.5, 1.5);
        this._spread = 0;
        this._legs.set([0.7, 0, 0, 0.7, 0, 0]);
        this._updateLanded(0, 0);
        this._prev.copy(this.position);
    }

    // Fly in from the left or right edge of the scene
    _respawn() {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.position.set(side * SPAWN_X, rand(1, 2.4), rand(-1.5, 1));
        this._target.set(rand(-0.6, 0.6), rand(1, 2.3), rand(-0.6, 0.6));
        this._heading.subVectors(this._target, this.position).normalize();
        this.velocity.copy(this._heading).multiplyScalar(0.9);
        this._prev.copy(this.position);
        this._getPos = null;
        this._eating = false;
        this._grow = 0;
        this.scale = 0;
        this._info = null;
        this._setMode('enter', 8);
        this._orient(0, 0, true);
    }

    _enter(t) {
        const p = this.position, d = _a.subVectors(this._target, p), dist = Math.max(d.length(), 1e-5);
        this._des.copy(d).divideScalar(dist);
        this._des.y += this._noise(4, t * 2) * 0.15;
        this._heading.copy(d).divideScalar(dist);
        if (p.x * p.x + p.z * p.z < (R_MAX * 0.8) ** 2 || dist < 0.2 || this._modeT > this._modeDur) this._startWander(false);
        return 0.25;
    }

    // Move to the holder. The spider updates after the flies, so its last position is a frame
    // old: predict one frame ahead (except across teleports) to stay in its jaws.
    _follow() {
        if (!this._getPos) return true;
        _w.copy(this.position);
        let r;
        try { r = this._getPos(_w); } catch (err) { return false; }
        if (r && r.isVector3 && r !== _w) _w.copy(r);
        if (!Number.isFinite(_w.x + _w.y + _w.z)) return true;
        _s.subVectors(_w, this._hp);
        const predict = this._hpOk && _s.lengthSq() < 0.0225;
        this._hp.copy(_w);
        this._hpOk = true;
        this.position.copy(_w);
        if (predict) this.position.add(_s);
        return true;
    }

    _updateHeld(dt, t) {
        this._heldT += dt;
        if (!this._follow()) { this.release(); return; }   // broken holder: let go
        let s = 1;
        if (this._eating) {
            this._eatT += dt;
            const k = clamp(this._eatT / this._eatDur, 0, 1);
            this.scale = 1 - smooth(k);
            if (k >= 1) { this._vanish(); return; }
            s = 1 - k;
        } else if (this._heldT > 30) { this.release(); return; }   // never stuck in a holder
        // struggle: small twists, fading while it's eaten
        _e.set(this._noise(6, t * 6) * 0.25 * s, this._noise(7, t * 5) * 0.3 * s, this._noise(8, t * 7) * 0.2 * s);
        this.quaternion.copy(this._heldQ).multiply(_q.setFromEuler(_e));
    }

    _vanish() {
        this._getPos = null;
        this._eating = false;
        this.scale = 0;
        this.velocity.set(0, 0, 0);
        this._respawnIn = rand(4, 8);
        this._setMode('gone');
    }

    // Body orientation in the air: along the flight path and banking into turns; level while
    // hovering; lining up with the leaf while settling onto it
    _orient(dt, t, snap) {
        const v = this.velocity, f = this._fwd, m = this._mode;
        if (dt > 0) this._acc.lerp(_a.subVectors(v, this._pv).divideScalar(dt), damp(dt, 0.1));
        this._pv.copy(v);
        const sp = v.length();
        if (m === 'hover') _a.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));
        else if (sp > 0.05) {
            _a.copy(v).divideScalar(sp);
            _a.y = clamp(_a.y, -0.45, 0.45) + 0.12 * (1 - Math.min(sp, 1));
        } else _a.copy(f);
        _a.normalize();
        if (snap) f.copy(_a);
        else f.lerp(_a, damp(dt, m === 'hover' ? 0.15 : 0.07)).normalize();
        _b.crossVectors(f, UP);
        if (_b.lengthSq() < 1e-6) _b.set(0, 0, 1);
        _b.normalize();                     // level right
        _c.crossVectors(_b, f);             // level up
        const bank = clamp(this._acc.dot(_b) * 0.1, -0.6, 0.6);
        _n.copy(_c).multiplyScalar(Math.cos(bank)).addScaledVector(_b, Math.sin(bank));
        _q.setFromRotationMatrix(_m.makeBasis(f, _n, _t.crossVectors(f, _n)));
        if (m === 'descend') {
            const ln = this._ln;
            _d.copy(f).addScaledVector(ln, -f.dot(ln));
            if (_d.lengthSq() > 1e-6) {
                _d.normalize();
                _q.setFromRotationMatrix(_m.makeBasis(_d, ln, _t.crossVectors(_d, ln)));
            }
        }
        if (snap) this.quaternion.copy(_q);
        else this.quaternion.slerp(_q, damp(dt, 0.05));
    }

    // Front legs (stand, groom, struggle, tuck) and the wing beat
    _animate(dt, t) {
        const m = this._mode, L = this._legs;
        let yl = 0.7, pl = 0, rl = 0, yr = 0.7, pr = 0, rr = 0;   // standing
        if (m === 'held') {
            yl = 0.5 + 0.45 * this._noise(6, t * 7); pl = 0.4 + 0.7 * this._noise(7, t * 8);
            yr = 0.5 + 0.45 * this._noise(8, t * 7.5); pr = 0.4 + 0.7 * this._noise(6, t * 8.5 + 3);
        } else if (m === 'landed' && this._act === 'rub') {   // rub the front legs together
            const w = Math.sin(t * 22), w2 = Math.cos(t * 22);
            yl = 0.05 + 0.12 * w; yr = 0.05 - 0.12 * w;
            pl = 0.08 + 0.1 * w2; pr = 0.08 - 0.1 * w2;
            rl = rr = 1.5;
        } else if (m === 'landed' && this._act === 'head') {   // wipe the eyes
            const w = Math.sin(t * 16);
            yl = yr = 0.3;
            pl = 1.2 + 0.3 * w; pr = 1.2 - 0.3 * w;
            rl = rr = 1.5;
        } else if (m === 'landed' && this._act === 'walk') {
            const w = Math.sin(t * 14);
            pl = 0.25 * Math.max(0, w);
            pr = 0.25 * Math.max(0, -w);
        } else if (m !== 'landed' && m !== 'descend') {   // flying: tucked under
            yl = yr = 0.4;
            pl = pr = -0.45;
        }
        const k = damp(dt, 0.06);
        L[0] += (yl - L[0]) * k; L[1] += (pl - L[1]) * k; L[2] += (rl - L[2]) * k;
        L[3] += (yr - L[3]) * k; L[4] += (pr - L[4]) * k; L[5] += (rr - L[5]) * k;
        const open = this.state === 'flying' || this.state === 'hovering' ? 1 : 0;
        this._spread += (open - this._spread) * damp(dt, 0.06);
        this._flap = (this._flap + dt * this._flapHz * Math.PI * 2) % (Math.PI * 2);
    }
}

// ---------------------------------------------------------------------------------------------
// Fireflies: soft additive glows drifting around the plant at different depths, each flashing
// (sometimes twice) every few seconds over a faint steady glow.

function createFireflies(group) {
    const n = FIREFLY_COUNT;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
        size: 0.6, map: glowTexture(), vertexColors: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    // fade glows out when the camera gets very close to one
    mat.onBeforeCompile = sh => {
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vFade;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvFade = smoothstep(0.35, 1.2, -mvPosition.z);');
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vFade;')
            .replace('#include <opaque_fragment>', 'diffuseColor.a *= vFade;\n#include <opaque_fragment>');
    };
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 2;
    group.add(points);

    const glow = new THREE.Color(COL.glow);
    const bugs = [];
    for (let i = 0; i < n; i++) {
        bugs.push({
            a: (i / n) * Math.PI * 2 + rand(-0.25, 0.25), r: rand(0.75, 2.4), y: rand(0.35, 2.7),
            w: rand(0.02, 0.06) * (Math.random() < 0.5 ? -1 : 1),   // slow orbit
            f: [rand(0.15, 0.35), rand(0.12, 0.3), rand(0.2, 0.45), rand(0.6, 1.1)],
            p: [rand(0, 6.3), rand(0, 6.3), rand(0, 6.3), rand(0, 6.3)],
            start: -10, dur: 1, next: rand(0, 4),
            base: rand(0.08, 0.16), peak: rand(0.8, 1.15), twin: Math.random() < 0.3,
        });
    }

    function update(t) {
        for (let i = 0; i < n; i++) {
            const b = bugs[i], f = b.f, p = b.p;
            const a = b.a + b.w * t + 0.25 * Math.sin(t * f[0] + p[0]);
            const r = b.r + 0.22 * Math.sin(t * f[1] + p[1]);
            pos[i * 3] = Math.sin(a) * r;
            pos[i * 3 + 1] = b.y + 0.18 * Math.sin(t * f[2] + p[2]) + 0.05 * Math.sin(t * f[3] + p[3]);
            pos[i * 3 + 2] = Math.cos(a) * r;
            if (t >= b.next || t < b.start) {
                b.start = t;
                b.dur = rand(0.5, 1.1);
                b.next = t + b.dur + rand(1.2, 4.8);
            }
            const k = (t - b.start) / b.dur;
            const e = k >= 0 && k <= 1 ? Math.sin(Math.PI * (b.twin ? 2 : 1) * k) ** 2 : 0;
            const v = b.base + e * b.peak;
            col[i * 3] = glow.r * v;
            col[i * 3 + 1] = glow.g * v;
            col[i * 3 + 2] = glow.b * v;
        }
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
    }

    return { points, update };
}

// ---------------------------------------------------------------------------------------------

const WING_TILT = 0.14;   // wing dihedral
const WING_BASE = [
    new THREE.Quaternion().setFromAxisAngle(Z_AXIS, WING_TILT),
    new THREE.Quaternion().setFromAxisAngle(X_AXIS, Math.PI).multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, -WING_TILT)),
];
const _bp = new THREE.Vector3(), _bn = new THREE.Vector3();

export function createFlies({ scene, plant, count = 4 } = {}) {
    const n = Math.max(0, Math.floor(count) || 0);
    const group = new THREE.Group();
    group.name = 'flies';
    if (scene) scene.add(group);

    // Three instanced draws for all the flies, sharing one matte flat-shaded material
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
    const wingMat = new THREE.MeshStandardMaterial({
        color: COL.wing, flatShading: true, roughness: 0.3, metalness: 0,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
    });
    const instanced = (geo, mat, k) => {
        const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, k));
        mesh.count = k;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;   // instances roam; precomputed bounds would go stale
        group.add(mesh);
        return mesh;
    };
    const bodies = instanced(bodyGeometry(), bodyMat, n);
    bodies.castShadow = bodies.receiveShadow = true;
    const legs = instanced(frontLegGeometry(), bodyMat, n * 2);
    const wings = instanced(wingGeometry(), wingMat, n * 2);

    const sys = {
        infos: [],
        // Inside a leaf's patch boxes? → ±1 (above / below the blade) and its normal, or 0
        hit(p, mAB, mH, skip, outN) {
            for (let i = 0; i < this.infos.length; i++) {
                const info = this.infos[i];
                if (info.leaf === skip) continue;
                const side = info.hit(p, mAB, mH, outN);
                if (side) return side;
            }
            return 0;
        },
        // Does the straight path cross a leaf? Its end may sit close above `target`
        blocked(from, to, target) {
            const len = from.distanceTo(to), steps = clamp(Math.ceil(len / 0.05), 2, 40);
            for (let i = 1; i <= steps; i++) {
                const s = i / steps;
                _bp.lerpVectors(from, to, s);
                if (this.hit(_bp, 0.03, 0.1, (1 - s) * len < 0.13 ? target : null, _bn)) return true;
            }
            return false;
        },
    };

    const list = [];
    for (let i = 0; i < n; i++) list.push(new Fly(sys, i));
    const fireflies = createFireflies(group);
    let clock = 0, settled = false;

    // Track plant.leaves (built lazily, after the plant has posed its leaves)
    function syncLeaves() {
        const leaves = plant && Array.isArray(plant.leaves) ? plant.leaves : null;
        const infos = sys.infos;
        let same = !!leaves && leaves.length === infos.length;
        for (let i = 0; same && i < infos.length; i++) same = infos[i].leaf === leaves[i];
        if (same || (!leaves && !infos.length)) {
            for (let i = 0; i < infos.length; i++) infos[i].refresh();
            return;
        }
        sys.infos = leaves ? leaves.map(l => new LeafInfo(l)) : [];
        for (const f of list) if (f._info && !sys.infos.includes(f._info)) f._startWander(true);
    }

    function write() {
        for (let i = 0; i < n; i++) {
            const f = list[i], s = f.size * f.scale;
            if (f.state === 'gone' || s < 1e-4) {
                bodies.setMatrixAt(i, ZERO);
                for (let k = 0; k < 2; k++) {
                    legs.setMatrixAt(i * 2 + k, ZERO);
                    wings.setMatrixAt(i * 2 + k, ZERO);
                }
                continue;
            }
            _m.compose(f.position, f.quaternion, _s.setScalar(s));
            bodies.setMatrixAt(i, _m);
            const L = f._legs, open = f._spread, ph = f._flap;
            const beat = open * (0.35 + 0.55 * Math.sin(ph)) + (1 - open) * 0.04;   // up and down
            const sweep = 2.76 + (1.95 + 0.3 * Math.cos(ph) - 2.76) * open;          // folded → out
            for (let k = 0; k < 2; k++) {
                const sg = k ? -1 : 1;   // left (−Z) first, then right (+Z), mirrored
                _q.setFromEuler(_e.set(-sg * L[k * 3 + 2], sg * L[k * 3], L[k * 3 + 1], 'YZX'));
                _m2.compose(LEG_ROOT[k], _q, ONE);
                legs.setMatrixAt(i * 2 + k, _m3.multiplyMatrices(_m, _m2));
                _q.setFromAxisAngle(X_AXIS, sg * beat).multiply(_q2.setFromAxisAngle(UP, sg * sweep)).multiply(WING_BASE[k]);
                _m2.compose(WING_ROOT[k], _q, ONE);
                wings.setMatrixAt(i * 2 + k, _m3.multiplyMatrices(_m, _m2));
            }
        }
        bodies.instanceMatrix.needsUpdate = true;
        legs.instanceMatrix.needsUpdate = true;
        wings.instanceMatrix.needsUpdate = true;
    }

    function update(dt, t) {
        dt = Number.isFinite(dt) ? clamp(dt, 0, 0.05) : 0;
        clock += dt;
        if (!Number.isFinite(t)) t = clock;
        syncLeaves();
        if (!settled && sys.infos.length && n) {   // open the scene with one fly sat on a leaf
            settled = true;
            for (let k = 0; k < 8; k++) {
                const info = sys.infos[(Math.random() * sys.infos.length) | 0], u = rand(0.35, 0.7), v = rand(-0.4, 0.4);
                if (info.leaf.surfacePoint(u, v, _a, _n) && _n.y > 0.3) { list[0]._placeOn(info, u, v); break; }
            }
        }
        for (let i = 0; i < n; i++) list[i].update(dt, t);
        write();
        fireflies.update(t);
    }

    // A free fly within maxDist of point, nearest first, hovering or landed flies before flying
    function findPrey(point, maxDist = Infinity) {
        if (!point) return null;
        const max2 = maxDist * maxDist;
        let near = null, nearD = Infinity, air = null, airD = Infinity;
        for (let i = 0; i < n; i++) {
            const f = list[i];
            if (f.state === 'caught' || f.state === 'gone') continue;
            const d = f.position.distanceToSquared(point);
            if (d > max2) continue;
            if (f.state === 'flying') { if (d < airD) { airD = d; air = f; } }
            else if (d < nearD) { nearD = d; near = f; }
        }
        return near || air;
    }

    function dispose() {
        group.removeFromParent();
        for (const mesh of [bodies, legs, wings, fireflies.points]) {
            mesh.geometry.dispose();
            if (mesh.material.map) mesh.material.map.dispose();
        }
        bodyMat.dispose();
        wingMat.dispose();
        fireflies.points.material.dispose();
    }

    return { group, list, fireflies: fireflies.points, update, findPrey, dispose };
}
