// Portia jumping spider for the jungle homepage (Spider API: dev/CONTRACT.md).
// Low-poly indie style: faceted, flat-shaded body parts in a warm palette (one colour per facet),
// chunky cone tufts, banded hexagonal leg segments with joint balls, and smooth glossy eyes with an
// amber ring and a highlight dot. Legs use a 2-bone IK (femur, tibia) to an ankle point above each
// foot plus a metatarsus segment; planted feet are kept in leaf (u, v) so they ride along when the
// leaf sways. Behaviour runs on a small generator-based task system: every action is a generator
// that yields once per frame and receives dt back.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const { clamp, lerp } = THREE.MathUtils;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const bulge = (x, k) => x * (1 + k * (1 - x * x));   // fuller, boxier cross-sections
const steps = n => Array.from({ length: n + 1 }, (_, i) => i / n);

const UP = new V3(0, 1, 0), DOWN = new V3(0, -1, 0), X_AXIS = new V3(1, 0, 0), Z_AXIS = new V3(0, 0, 1);
const ONE = new V3(1, 1, 1), ZERO = new V3();
const DEFAULT_GAZE = new V3(0, 2.75, 5.6);
const KEY_DIR = new V3(2.5, 3.3, 3).normalize();   // towards the key light, for the eye highlight

// Warm palette, converted to linear for vertex colours
const lin = h => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
const PAL = {
    ink: lin(0x16100c), umberDark: lin(0x2f1e14), umber: lin(0x4b301f), brown: lin(0x7b5236),
    tan: lin(0xba8c5c), cream: lin(0xeedcb6), orange: lin(0xc8772f), fang: lin(0x24150e),
    pupil: lin(0x080605), irisIn: lin(0x6e3c16), irisOut: lin(0xc47d30), rim: lin(0x24160e),
};

// ------------------------------------------------------------------------------------------------
// Dimensions. Spider space: +Z forward, +Y up (dorsal), +X to the spider's left. The root sits on
// the leaf under the sternum; the body rig floats BODY_H above it. Body length ≈ 0.24.

const BODY_H = 0.04;
const FOOT_LIFT = 0.0024;          // tarsus tips rest on, not in, the leaf
const CARA = { zF: 0.062, zR: -0.048, w: 0.042, hF: 0.064, hR: 0.03, bot: 0.009, y0: 0.004 };   // tall, boxy Portia head
const ABD = { len: 0.094, w: 0.033, hT: 0.02, hB: 0.016, yc: 0.008, z0: 0.006 };    // small and flat
const ABD_PIVOT = new V3(0, 0.012, -0.044);
const ABD_PITCH = 0.1;             // abdomen tail held a little up
const AME_R = 0.0148;
const AME_POS = [new V3(0.0158, CARA.y0 + 0.03, CARA.zF - 0.0035), new V3(-0.0158, CARA.y0 + 0.03, CARA.zF - 0.0035)];
const AME_ROWS = [0, 0.07, 0.14, 0.2, 0.26, 0.33, 0.45, 0.6];
const AME_COLS = [PAL.pupil, PAL.pupil, PAL.irisIn, PAL.irisOut, PAL.rim, PAL.ink, PAL.ink];
const MOUTH = new V3(0, CARA.y0 - 0.026, CARA.zF + 0.02);                 // body-rig space
const SPINNERET = new V3(0, ABD.yc - 0.011, ABD.z0 - ABD.len + 0.004);    // abdomen space
const PITCH_PIVOT = new V3(0, 0, -0.03);                                  // body rears up around here
const MOUTH_ROOT = new V3(0, BODY_H, 0).add(MOUTH);
const SPIN_ROOT = SPINNERET.clone().applyAxisAngle(X_AXIS, ABD_PITCH).add(ABD_PIVOT).add(new V3(0, BODY_H, 0));
const ANK_UP = 0.9, ANK_IN = 0.4;    // metatarsus direction from the foot up to the ankle
const EAT_TIME = 3.6;
const PALP_L = [0.017, 0.014, 0.014], PALP_R = [0.0027, 0.0037, 0.0034];
const PALP_BASE = [new V3(0.012, CARA.y0 - 0.006, CARA.zF - 0.005), new V3(-0.012, CARA.y0 - 0.006, CARA.zF - 0.005)];
const WALK = { uMin: 0.12, uMax: 0.9, vMax: 0.85 };   // walkable region (CONTRACT clampUV)

// Legs I–IV: angle from forward, foot reach from the coxa, coxa x/z, femur/tibia/metatarsus lengths
const LEG_DEFS = [
    { ang: 0.5, reach: 0.175, cx: 0.024, cz: 0.036, L: [0.088, 0.097, 0.088], th: 1.12 },
    { ang: 1.16, reach: 0.15, cx: 0.031, cz: 0.019, L: [0.074, 0.08, 0.074], th: 0.96 },
    { ang: 1.92, reach: 0.145, cx: 0.031, cz: 0.001, L: [0.072, 0.075, 0.071], th: 0.96 },
    { ang: 2.58, reach: 0.17, cx: 0.025, cz: -0.018, L: [0.085, 0.091, 0.085], th: 1.03 },
];
const LEG_R = [0.0088, 0.0046, 0.0028, 0.0068, 0.0034];   // femur, tibia, metatarsus, knee ball, ankle ball

// Leaf edge samples for silk drops: both sides and the tip
const EDGE_SAMPLES = [];
for (let u = 0.22; u <= 0.9; u += 0.04) EDGE_SAMPLES.push({ u, v: 0.94 }, { u, v: -0.94 });
EDGE_SAMPLES.push({ u: 0.93, v: 0 }, { u: 0.92, v: 0.4 }, { u: 0.92, v: -0.4 });

function mulberry32(a) {
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Scratch objects (no allocations in the per-frame paths)
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3(), _f = new V3();
const _g = new V3(), _h = new V3(), _i = new V3(), _j = new V3(), _k = new V3(), _l = new V3();
const _m1 = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');
const _uv1 = { u: 0, v: 0 }, _uv2 = { u: 0, v: 0 }, _uv3 = { u: 0, v: 0 }, _uvd = { u: 0, v: 0 };

// Orientation from a forward and an up direction (+Z forward, +Y up), robust to non-orthogonal input
const _bx = new V3(), _bz = new V3(), _bm = new THREE.Matrix4();
function basisQuat(fwd, up, out) {
    _bx.crossVectors(up, fwd);
    if (_bx.lengthSq() < 1e-12) _bx.crossVectors(up, Math.abs(up.y) < 0.9 ? UP : Z_AXIS);
    _bx.normalize();
    _bz.crossVectors(_bx, up).normalize();
    _bm.makeBasis(_bx, up, _bz);
    return out.setFromRotationMatrix(_bm);
}

// Surface frame of a leaf at (u, v): point, unit normal and the two parameter tangents
const _sfA = new V3(), _sfB = new V3(), _sfN = new V3();
class SurfaceFrame {
    constructor() { this.p = new V3(); this.n = new V3(); this.pu = new V3(); this.pv = new V3(); }

    compute(leaf, u, v) {
        const h = 0.004;
        leaf.surfacePoint(u, v, this.p, this.n);
        leaf.surfacePoint(u + h, v, _sfA, _sfN);
        leaf.surfacePoint(u - h, v, _sfB, _sfN);
        this.pu.subVectors(_sfA, _sfB).multiplyScalar(0.5 / h);
        leaf.surfacePoint(u, v + h, _sfA, _sfN);
        leaf.surfacePoint(u, v - h, _sfB, _sfN);
        this.pv.subVectors(_sfA, _sfB).multiplyScalar(0.5 / h);
        return this;
    }

    // (du, dv) for a world-space displacement d, least squares in the tangent plane
    solve(d, out) {
        const pu = this.pu, pv = this.pv;
        const a = pu.dot(pu), b = pu.dot(pv), c = pv.dot(pv), e = pu.dot(d), f = pv.dot(d);
        const det = a * c - b * b;
        if (Math.abs(det) < 1e-14) { out.u = 0; out.v = 0; return out; }
        out.u = (c * e - b * f) / det;
        out.v = (a * f - b * e) / det;
        return out;
    }
}

// ------------------------------------------------------------------------------------------------
// Body shapes, as (s, a) → point: s runs along the body (front to back), a around it from the
// ventral midline (a = 0) over the left side to the top (a = π).

function carapacePoint(s, a, out) {
    const t = 0.5 + 0.5 * Math.cos(Math.PI * s);          // 1 at the face → 0 at the rear
    const k = 2 * t - 1, m = k > 0 ? 4.2 : 2.3;            // flat face, rounder rear
    const R = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(k), m)), 1 / m);
    const halfW = CARA.w * (0.62 + 0.38 * sstep(0.02, 0.5, t)) * (1 - 0.05 * sstep(0.7, 1, t));
    const top = CARA.hR + (CARA.hF - CARA.hR) * sstep(0.15, 0.68, t);   // tall eye region
    const yy = bulge(-Math.cos(a), 0.3);
    return out.set(halfW * R * bulge(Math.sin(a), 0.3), CARA.y0 + (yy > 0 ? top : CARA.bot) * R * yy,
        CARA.zR + (CARA.zF - CARA.zR) * t);
}

function abdomenPoint(s, a, out) {                          // abdomen-pivot space
    const t = 0.5 - 0.5 * Math.cos(Math.PI * s);           // 0 front → 1 spinnerets
    const k = 2 * t - 1, m = k < 0 ? 2.5 : 2.0;
    const R = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(k), m)), 1 / m) * (1.05 - 0.1 * t);
    const yy = bulge(-Math.cos(a), 0.15);
    return out.set(ABD.w * R * bulge(Math.sin(a), 0.15), ABD.yc + (yy > 0 ? ABD.hT : ABD.hB) * R * yy - 0.008 * t * t,
        ABD.z0 - ABD.len * t);
}

function eyePoint(s, a, out) {                              // unit eye, pupil at the +Z pole
    const th = s * Math.PI;
    return out.set(Math.sin(a) * Math.sin(th), -Math.cos(a) * Math.sin(th), 0.9 * Math.cos(th));
}

function cheliceraPoint(s, a, out) {                        // chunky lobe along -Z, rotated to hang
    const R = Math.pow(Math.sin(Math.PI * s), 0.55) * (1.1 - 0.45 * s);
    return out.set(0.0076 * R * bulge(Math.sin(a), 0.2), -0.0068 * R * bulge(Math.cos(a), 0.2),
        -0.025 * (0.5 - 0.5 * Math.cos(Math.PI * s)));
}

const _na = new V3(), _nb = new V3(), _nc = new V3(), _nd = new V3();
function normalAt(fn, s, a, out) {
    const e = 1e-3, sc = clamp(s, 3e-3, 1 - 3e-3);
    fn(sc + e, a, _na); fn(sc - e, a, _nb); _na.sub(_nb);
    fn(sc, a + e, _nc); fn(sc, a - e, _nd); _nc.sub(_nd);
    return out.crossVectors(_na, _nc).normalize();
}

function geoFrom(pos, nor, col) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (nor) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    if (!nor) g.computeVertexNormals();
    return g;
}

// Non-indexed grid over a shape function, one colour per facet (from its centroid and normal).
// smooth: keep per-vertex normals (eyes); otherwise facets are flat.
function faceted({ fn, rows, nA, aOff = 0.5, color, smooth = false, jitter = 0.04, rng = Math.random }) {
    const P = [], N = [];
    for (const s of rows) {
        for (let j = 0; j <= nA; j++) {
            const a = ((j + aOff) / nA) * TAU;
            P.push(fn(s, a, new V3()));
            if (smooth) N.push(normalAt(fn, s, a, new V3()));
        }
    }
    const pos = [], nor = [], col = [], cen = new V3(), fn0 = new V3(), e1 = new V3();
    const tri = (i0, i1, i2, row) => {
        const A = P[i0], B = P[i1], C = P[i2];
        e1.subVectors(B, A);
        fn0.subVectors(C, A).crossVectors(e1, fn0);
        const len = fn0.length();
        if (len < 1e-11) return;   // collapsed pole triangles
        fn0.multiplyScalar(1 / len);
        cen.copy(A).add(B).add(C).multiplyScalar(1 / 3);
        const rgb = color(cen, fn0, row), k = 1 + (rng() - 0.5) * 2 * jitter;
        for (const i of [i0, i1, i2]) {
            const p = P[i], n = smooth ? N[i] : fn0;
            pos.push(p.x, p.y, p.z);
            nor.push(n.x, n.y, n.z);
            col.push(rgb[0] * k, rgb[1] * k, rgb[2] * k);
        }
    };
    for (let i = 0; i < rows.length - 1; i++) {
        for (let j = 0; j < nA; j++) {
            const a = i * (nA + 1) + j, b = a + nA + 1;
            tri(a, b, a + 1, i);
            tri(b, b + 1, a + 1, i);
        }
    }
    return geoFrom(pos, nor, col);
}

// A three.js primitive as a flat-coloured, non-indexed part
function prim(geo, rgb, m = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g.attributes.uv) g.deleteAttribute('uv');
    if (m) g.applyMatrix4(m);
    g.computeVertexNormals();
    const n = g.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set(rgb, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
}

const _cm = new THREE.Matrix4(), _cq = new THREE.Quaternion(), _cv = new V3();
function coneAt(P, axis, r, h, rgb, sides = 5) {
    const g = new THREE.ConeGeometry(r, h, sides, 1, true).translate(0, h / 2, 0);
    _cq.setFromUnitVectors(UP, _cv.copy(axis).normalize());
    return prim(g, rgb, _cm.compose(P, _cq, ONE));
}

function ballAt(P, r, rgb) {
    return prim(new THREE.IcosahedronGeometry(r, 0), rgb, _cm.makeTranslation(P.x, P.y, P.z));
}

// A chunky tuft standing out of a body surface at (s, a), leaning back along the body
function tuftAt(fn, s, a, r, h, rgb, lean = 0.6, out = 0) {
    const P = fn(s, a, new V3()), N = normalAt(fn, s, a, new V3());
    const B = fn(Math.min(s + 0.01, 1), a, new V3()).sub(P).normalize();
    const side = new V3(Math.sign(Math.sin(a)), 0, 0);
    const axis = N.clone().addScaledVector(B, lean).addScaledVector(side, out).normalize();
    return coneAt(P.addScaledVector(axis, -0.0018), axis, r, h, rgb);
}

// Unit leg segment: tapered prism along +Y (0..1), radius 1 at the base, banded by section.
// Scaled per instance to (radius, length, radius). +X is the ventral side (inside of the bend).
function segmentGeo({ sides = 6, rows, colors, taper = 0.8, fin = 0 }) {
    const rad = y => lerp(1, taper, y) * (1 + 0.07 * Math.sin(Math.PI * y));
    const R = rows.map(y => {
        const r = rad(y), ring = [];
        for (let j = 0; j < sides; j++) {
            const a = ((j + 0.5) / sides) * TAU;
            ring.push(new V3(Math.cos(a) * r, y, Math.sin(a) * r));
        }
        return ring;
    });
    const pos = [], col = [];
    const tri = (A, B, C, c) => { for (const p of [A, B, C]) { pos.push(p.x, p.y, p.z); col.push(c[0], c[1], c[2]); } };
    for (let i = 0; i < rows.length - 1; i++) {
        for (let j = 0; j < sides; j++) {
            const j1 = (j + 1) % sides;
            tri(R[i][j], R[i + 1][j], R[i][j1], colors[i]);
            tri(R[i + 1][j], R[i + 1][j1], R[i][j1], colors[i]);
        }
    }
    const c0 = new V3(0, -0.03, 0), c1 = new V3(0, 1.03, 0), last = R[R.length - 1];
    for (let j = 0; j < sides; j++) {
        const j1 = (j + 1) % sides;
        tri(c0, R[0][j], R[0][j1], colors[0]);
        tri(c1, last[j1], last[j], colors[colors.length - 1]);
    }
    if (fin) {
        // Portia's fringed tibia I: a comb of dark teeth along the underside, two-sided
        const n = 4;
        for (let k = 0; k < n; k++) {
            const y0 = 0.16 + (0.7 * k) / n, y1 = y0 + 0.7 / n, ym = lerp(y0, y1, 0.7);
            const A = new V3(rad(y0) * 0.7, y0, 0), B = new V3(rad(y1) * 0.7, y1, 0);
            const C = new V3(rad(ym) + fin * (0.75 + 0.25 * Math.sin(k * 1.9 + 1)), ym + 0.06, 0);
            tri(A, B, C, PAL.umberDark);
            tri(A, C, B, PAL.umberDark);
        }
    }
    return geoFrom(pos, null, col);
}

// Facet colours: Portia simplified to a few readable patches
function caraColor(c, n) {
    const y = c.y - CARA.y0;
    if (n.z > 0.72) return y < 0.004 ? PAL.cream : PAL.umberDark;            // face, cream "moustache"
    if (c.z > 0.046 && n.y < 0.1 && n.z > 0.25 && y < 0.008) return PAL.cream;   // clypeus bevel
    if (n.y < -0.45) return PAL.tan;                                          // sternum
    if (n.y > 0.5) {
        if (c.z > 0.016) return PAL.umberDark;                                // dark eye region
        return Math.abs(c.x) < 0.012 ? PAL.tan : PAL.brown;                  // thorax, pale stripe
    }
    if (y < 0.007 && c.z < 0.05) return PAL.cream;                           // pale marginal band
    return c.z > 0.016 ? PAL.umber : PAL.brown;
}

function abdColor(c, n) {
    const t = clamp((ABD.z0 - c.z) / ABD.len, 0, 1), k = Math.floor(t * 9);
    if (n.y < -0.45) return PAL.tan;                                          // belly
    const mid = Math.abs(c.x) < 0.013;
    if (n.y > 0.55) {
        if (t < 0.45) return mid ? PAL.cream : PAL.brown;                     // pale median band
        if (k % 2 === 1) return PAL.umberDark;                                // chevrons
        return mid ? PAL.cream : PAL.tan;
    }
    if (n.y > 0.1) return t > 0.45 && k % 2 === 1 ? PAL.umberDark : PAL.brown;
    return PAL.umber;                                                         // darker flanks
}

// ------------------------------------------------------------------------------------------------
// Silk: a fat line (constant pixel width) whose buffer is rewritten in place every frame

class Thread {
    constructor(parent, n = 14) {
        this.n = n;
        const geo = new LineGeometry();
        geo.setPositions(new Float32Array(n * 3));
        this.mat = new LineMaterial({ color: 0xeef4e6, linewidth: 1.3, transparent: true, opacity: 0, depthWrite: false });
        this.line = new Line2(geo, this.mat);
        this.line.frustumCulled = false;
        this.line.visible = false;
        this.line.renderOrder = 2;
        parent.add(this.line);
        this.buf = geo.attributes.instanceStart.data;
        this.active = false;
        this.alpha = 0;
        this.fade = 0;
        this.aLeaf = null; this.au = 0; this.av = 0;
        this.bLeaf = null; this.bu = 0; this.bv = 0;
    }

    start(leaf, u, v) {
        this.aLeaf = leaf; this.au = u; this.av = v;
        this.bLeaf = null;
        this.alpha = 1;
        this.fade = 0;
        this.active = true;
        this.line.visible = true;
    }

    pin(leaf, u, v, fade) { this.bLeaf = leaf; this.bu = u; this.bv = v; this.fade = fade; }

    hide() { this.active = false; this.line.visible = false; }

    write(A, B, sag) {
        const arr = this.buf.array, n = this.n;
        for (let i = 0; i < n - 1; i++) {
            for (let k = 0; k < 2; k++) {
                const s = (i + k) / (n - 1), o = i * 6 + k * 3;
                arr[o] = A.x + (B.x - A.x) * s;
                arr[o + 1] = A.y + (B.y - A.y) * s - sag * 4 * s * (1 - s);
                arr[o + 2] = A.z + (B.z - A.z) * s;
            }
        }
        this.buf.needsUpdate = true;
    }
}

// ------------------------------------------------------------------------------------------------

export class Spider {
    constructor({ scene, plant, flies = null, camera = null } = {}) {
        this.scene = scene;
        this.plant = plant;
        this.flies = flies;
        this.camera = camera;
        this.object = new THREE.Group();
        this.object.name = 'spider';
        this.object.userData.spider = true;
        this.pickables = [];
        this.leaf = null;
        this.roaming = true;

        // Locomotion: anchor (u, v) on the leaf, heading as a direction in (u, v) space
        this.u = 0.5; this.v = 0; this.hu = 1; this.hv = 0;
        this.mode = 'ground';        // 'ground': posed from the leaf; 'air': from airPos / airQuat
        this.airborne = false;       // a mid-air move is in progress (never interrupted)
        this.airPos = new V3();
        this.airQuat = new THREE.Quaternion();
        this._af = new SurfaceFrame();
        this._tf = new SurfaceFrame();
        this._fwd = new V3(0, 0, 1);
        this._up = new V3(0, 1, 0);
        this._speed = 0;
        this._turnRate = 0;
        this._moveVel = new V3();
        this._still = 0;
        this._lastGroup = 0;
        this._invRoot = new THREE.Matrix4();
        this._invRootQ = new THREE.Quaternion();
        this._rigQ = new THREE.Quaternion();

        // Posture and expression
        this.crouch = 0; this.crouchTarget = 0; this.crouchRate = 10;
        this.rear = 0; this.rearTarget = 0;
        this._sq = { x: 0, v: 0 };   // landing squash spring
        this._lookPitch = 0; this._roll = 0; this._rollTarget = 0; this._bobPh = 0; this._breath = 0;
        this.eyePop = 0;
        this.palpMode = 'idle';
        this.eating = false;
        this._eyeYaw = [0, 0]; this._eyePitch = [0, 0];
        this._sac = new THREE.Vector2(); this._sacT = 0;

        // Behaviour
        this._gaze = null; this._lookOverride = null; this._prey = null;
        this._task = null; this._taskName = '';
        this._goal = null; this._pokeReq = false;
        this._huntCD = rand(3, 6); this._roamAct = false; this._needsPlant = false;
        this._dt = 1 / 60; this._time = 0;
        this._getMouth = out => this.mouthPosition(out);   // flies predict a frame ahead themselves
        this._raycaster = new THREE.Raycaster();

        this._buildModel();
        this._buildLegs();
        this._buildSilk();
        scene.add(this.object);

        const leaves = plant?.leaves ?? [];
        const first = leaves.find(l => !l.section) ?? leaves[0];
        if (first) this.placeOn(first, first.center.u, first.center.v);
    }

    // ============================================================================== public API

    placeOn(leaf, u = leaf?.center.u, v = leaf?.center.v) {
        if (!leaf) return;
        this._abortTask();
        if (this._goal) { this._goal.resolve(false); this._goal = null; }
        for (const th of this._threads) th.hide();
        leaf.mesh?.updateWorldMatrix?.(true, false);
        const c = leaf.clampUV(u, v);
        this.leaf = leaf; this.u = c.u; this.v = c.v;
        this.mode = 'ground'; this.airborne = false;
        this.crouch = this.crouchTarget = 0; this.rear = this.rearTarget = 0;
        this._sq.x = this._sq.v = 0;
        // Face the viewer, or along the midrib if they're straight above
        const F = this._af.compute(leaf, this.u, this.v);
        _a.subVectors(this._gazeRef(), F.p);
        _a.addScaledVector(F.n, -_a.dot(F.n));
        if (_a.lengthSq() < 1e-6) _a.copy(F.pu);
        this._setHeadingWorld(_a.normalize());
        this._plantAll();
        this._needsPlant = true;   // plant again on the first update, once the leaves are posed
    }

    goToLeaf(leaf, uv = leaf?.center) {
        if (!leaf) return Promise.resolve(false);
        if (this._goal) { this._goal.resolve(false); this._goal = null; }
        const c = leaf.clampUV(uv?.u ?? leaf.center.u, uv?.v ?? leaf.center.v);
        return new Promise(resolve => {
            const goal = { leaf, uv: c, started: false, done: false };
            goal.resolve = ok => { if (!goal.done) { goal.done = true; resolve(ok); } };
            this._goal = goal;
            if (!this.leaf && this.mode === 'ground') { this.placeOn(leaf, c.u, c.v); goal.resolve(true); }
        });
    }

    setRoaming(on) { this.roaming = !!on; }

    // Kept by reference, so a live vector (e.g. the cursor point) is tracked as it changes
    setGaze(point) { this._gaze = point ?? null; }

    poke() {
        this.eyePop = 1;
        this._pokeReq = true;
    }

    mouthPosition(out = new V3()) {
        return this.bodyRig.localToWorld(out.copy(MOUTH));
    }

    update(dt, t) {
        if (!this.leaf && this.mode === 'ground') return;
        dt = clamp(dt, 0, 0.05);
        this._dt = dt;
        this._time = t;
        if (this._needsPlant && this.mode === 'ground') {
            this._needsPlant = false;
            this._plantAll();
        }
        this._huntCD -= dt;
        this._think(dt);
        this._applyPose(dt);
        this._updateLegs(dt);
        this._updatePalps(dt);
        this._updateHead(dt);
        this._updateSilk(dt);
    }

    // ================================================================================== model

    _buildModel() {
        const rng = mulberry32(7);
        const mat = this._mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0 });
        const eyeMat = this._eyeMat = new THREE.MeshPhysicalMaterial({
            vertexColors: true, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
        });
        const rig = this.bodyRig = new THREE.Group();
        this.object.add(rig);
        const shade = m => { m.castShadow = true; m.receiveShadow = true; return m; };

        // Carapace, coxae and head tufts: one static mesh
        const sOf = t => Math.acos(clamp(2 * t - 1, -1, 1)) / Math.PI;   // carapace t → s
        const parts = [faceted({ fn: carapacePoint, rows: steps(8), nA: 10, color: caraColor, rng })];
        for (const d of LEG_DEFS) {
            for (const side of [1, -1]) {
                const dir = new V3(side * Math.sin(d.ang), -0.32, Math.cos(d.ang)).normalize();
                parts.push(ballAt(new V3(side * d.cx, -0.004, d.cz).addScaledVector(dir, 0.006), 0.0074 * d.th, PAL.brown));
            }
        }
        for (const side of [1, -1]) {
            parts.push(tuftAt(carapacePoint, sOf(0.74), Math.PI - side * 0.62, 0.0047, 0.012, PAL.orange, 0.55, 0.3));
            parts.push(tuftAt(carapacePoint, sOf(0.47), Math.PI - side * 0.42, 0.0042, 0.009, PAL.cream, 0.8, 0.15));
        }
        const body = this._bodyMesh = shade(new THREE.Mesh(mergeGeometries(parts), mat));
        rig.add(body);

        // Abdomen with its tufts and spinnerets, on a pivot at the pedicel
        const abdPivot = this.abdomen = new THREE.Group();
        abdPivot.position.copy(ABD_PIVOT);
        abdPivot.rotation.x = ABD_PITCH;
        rig.add(abdPivot);
        const aOf = t => Math.acos(clamp(1 - 2 * t, -1, 1)) / Math.PI;   // abdomen t → s
        const ap = [faceted({ fn: abdomenPoint, rows: steps(9), nA: 10, color: abdColor, rng })];
        for (const side of [1, -1]) {
            ap.push(tuftAt(abdomenPoint, aOf(0.3), Math.PI - side * 0.6, 0.0055, 0.013, PAL.cream, 0.7, 0.2));
            ap.push(tuftAt(abdomenPoint, aOf(0.55), Math.PI - side * 0.66, 0.0055, 0.014, PAL.orange, 0.7, 0.25));
            ap.push(tuftAt(abdomenPoint, aOf(0.76), Math.PI - side * 0.5, 0.005, 0.012, PAL.cream, 0.8, 0.2));
            ap.push(tuftAt(abdomenPoint, aOf(0.97), side * 0.5, 0.0024, 0.007, PAL.tan, 3.5, 0));   // spinnerets
        }
        ap.push(tuftAt(abdomenPoint, aOf(0.92), Math.PI, 0.005, 0.012, PAL.umber, 1.2, 0));
        const abd = this._abdMesh = shade(new THREE.Mesh(mergeGeometries(ap), mat));
        abdPivot.add(abd);

        // Chelicerae (one mesh so they can chew together)
        const chel = [];
        for (const side of [1, -1]) {
            const g = faceted({ fn: cheliceraPoint, rows: steps(4), nA: 6, color: (c, n, i) => (i < 2 ? PAL.brown : i < 3 ? PAL.umber : PAL.umberDark), rng });
            g.rotateX(-Math.PI / 2 - 0.25).translate(side * 0.0086, 0, 0);
            chel.push(g);
            const tip = new V3(side * 0.0086, -0.0242, 0.0062);
            chel.push(coneAt(tip.add(new V3(-side * 0.003, 0.003, 0.002)), new V3(-side, -0.25, -0.55), 0.0016, 0.007, PAL.fang, 4));
        }
        const cm = this._chel = shade(new THREE.Mesh(mergeGeometries(chel), mat));
        cm.position.set(0, CARA.y0 - 0.004, CARA.zF - 0.007);
        rig.add(cm);

        // Main eyes: smooth, glossy, instanced so they can look around
        const ameGeo = faceted({ fn: eyePoint, rows: AME_ROWS, nA: 18, aOff: 0, color: (c, n, i) => AME_COLS[i], smooth: true, jitter: 0 });
        this._ame = new THREE.InstancedMesh(ameGeo, eyeMat, 2);
        this._ame.frustumCulled = false;
        this._ame.castShadow = true;
        rig.add(this._ame);
        // Highlight dots, placed where the key light reflects towards the camera
        this._glint = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 2);
        this._glint.frustumCulled = false;
        this._glint.renderOrder = 3;
        rig.add(this._glint);
        // ALE, PME and PLE: small glossy beads merged into one static mesh
        const small = [];
        const eyeAt = (t, a, r, rows, nA, fwdBias) => {
            const s = sOf(t), P = carapacePoint(s, a, new V3()), N = normalAt(carapacePoint, s, a, new V3());
            const dir = N.clone().addScaledVector(Z_AXIS, fwdBias).normalize();
            const g = faceted({ fn: eyePoint, rows, nA, aOff: 0, smooth: true, jitter: 0,
                color: (c, n, i) => (i === 1 ? PAL.irisOut : i === 2 ? PAL.irisIn : PAL.pupil) });
            _q1.setFromUnitVectors(Z_AXIS, dir);
            return g.applyMatrix4(_m1.compose(P.addScaledVector(N, -r * 0.35), _q1, _a.setScalar(r)));
        };
        for (const side of [1, -1]) {
            small.push(eyeAt(0.9, Math.PI - side * 1.05, 0.0098, [0, 0.12, 0.22, 0.32, 0.55], 10, 0.6));   // ALE
            small.push(eyeAt(0.62, Math.PI - side * 0.62, 0.0088, [0, 0.15, 0.3, 0.55], 8, 0));            // PLE
            small.push(eyeAt(0.78, Math.PI - side * 0.8, 0.0036, [0, 0.3, 0.55], 6, 0));             // PME
        }
        rig.add(new THREE.Mesh(mergeGeometries(small), eyeMat));

        // Pale chunky palps: femur, tibia, tarsus per side, instanced and posed every frame
        const palpGeo = segmentGeo({ sides: 5, rows: [0, 0.55, 1], colors: [PAL.cream, lin(0xf6ead0)], taper: 0.78 });
        this._palpMesh = new THREE.InstancedMesh(palpGeo, mat, 6);
        this._palpMesh.frustumCulled = false;
        this._palpMesh.castShadow = true;
        this._palpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        rig.add(this._palpMesh);
        this._palps = [0, 1].map(() => ({ lift: 0.1, liftT: 0.1, spread: 0, spreadT: 0, curl: 0, curlT: 0, k: 16, timer: rand(0.2, 1) }));

        // Invisible, generous hit volume so the spider is easy to click
        const hit = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ visible: false }));
        hit.scale.set(0.07, 0.062, 0.135);
        hit.position.set(0, 0.022, -0.046);
        rig.add(hit);
        for (const m of [hit, body, abd]) m.userData.spider = true;
        this.pickables = [hit, body, abd];
    }

    _buildLegs() {
        const root = this.object;
        const mk = (geo, n) => {
            const m = new THREE.InstancedMesh(geo, this._mat, n);
            m.frustumCulled = false;
            m.castShadow = true;
            m.receiveShadow = true;
            m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            root.add(m);
            return m;
        };
        // Banded light/dark segments; leg I has a darker tibia with Portia's fringe
        this._femur = mk(segmentGeo({ rows: [0, 0.55, 0.8, 1], colors: [PAL.umber, PAL.tan, PAL.umber], taper: 0.82 }), 8);
        this._tibia = mk(segmentGeo({ rows: [0, 0.32, 0.52, 1], colors: [PAL.brown, PAL.cream, PAL.umber], taper: 0.85 }), 6);
        this._tibia1 = mk(segmentGeo({ rows: [0, 0.32, 0.52, 1], colors: [PAL.umber, PAL.tan, PAL.umberDark], taper: 0.85, fin: 1.7 }), 2);
        this._meta = mk(segmentGeo({ rows: [0, 0.3, 0.68, 1], colors: [PAL.cream, PAL.umber, PAL.tan], taper: 0.55 }), 8);
        this._joints = mk(prim(new THREE.IcosahedronGeometry(1, 0), [1, 1, 1]), 16);
        const knee = new THREE.Color().setRGB(...PAL.cream), ankle = new THREE.Color().setRGB(...PAL.tan);

        this.legs = [];
        LEG_DEFS.forEach((d, pair) => {
            for (const side of [1, -1]) {
                const i = this.legs.length;
                const dir = new V3(side * Math.sin(d.ang), -0.32, Math.cos(d.ang)).normalize();
                const coxa = new V3(side * d.cx, -0.004, d.cz);
                const leg = {
                    i, pair, side,
                    group: (pair + (side > 0 ? 0 : 1)) % 2,   // alternating tetrapod gait
                    L: d.L,
                    r: LEG_R.map(r => r * d.th),
                    hip: coxa.clone().addScaledVector(dir, 0.012),
                    rest: new V3(side * (d.cx + Math.sin(d.ang) * d.reach), 0, d.cz + Math.cos(d.ang) * d.reach),
                    tibiaMesh: pair === 0 ? this._tibia1 : this._tibia,
                    tibiaIdx: pair === 0 ? (side > 0 ? 0 : 1) : i - 2,
                    mode: 'planted', leaf: null, u: 0.5, v: 0,
                    fw: new V3(), fn: new V3(0, 1, 0), poseLocal: new V3(), err: 0,
                    ankUp: ANK_UP, ankIn: ANK_IN,   // ankle placement; raised legs extend instead
                    sw: { fromUV: true, fromLeaf: null, fu: 0, fv: 0, from: new V3(), toUV: true, tu: 0, tv: 0, t: 0, dur: 0.1, h: 0 },
                };
                this._joints.setColorAt(i * 2, knee);
                this._joints.setColorAt(i * 2 + 1, ankle);
                this.legs.push(leg);
            }
        });
        this._joints.instanceColor.needsUpdate = true;
    }

    _buildSilk() {
        // Threads live in world space: this group cancels the root transform every frame
        this._worldSpace = new THREE.Group();
        this._worldSpace.matrixAutoUpdate = false;
        this.object.add(this._worldSpace);
        this._threads = [0, 1, 2].map(() => new Thread(this._worldSpace));
    }

    // ================================================================================== posing

    // A gaze point on the spider itself (the cursor over it) means "look at the viewer"
    _gazeRef() {
        const g = this._gaze;
        if (g && g.distanceToSquared(this.object.position) > 0.0225) return g;
        return this.camera?.position ?? DEFAULT_GAZE;
    }

    _lookRef() { return this._prey?.position ?? this._lookOverride ?? this._gazeRef(); }

    // Root on the leaf under the body, aligned to the (footprint-averaged) surface normal
    _groundPose() {
        const leaf = this.leaf, F = this._af.compute(leaf, this.u, this.v);
        const du = 0.05 / Math.max(F.pu.length(), 0.05), dv = 0.045 / Math.max(F.pv.length(), 0.05);
        const n = _a.copy(F.n).multiplyScalar(2);
        leaf.surfacePoint(this.u + du, this.v, _b, _c); n.add(_c);
        leaf.surfacePoint(this.u - du, this.v, _b, _c); n.add(_c);
        leaf.surfacePoint(this.u, this.v + dv, _b, _c); n.add(_c);
        leaf.surfacePoint(this.u, this.v - dv, _b, _c); n.add(_c);
        n.normalize();
        const f = _d.copy(F.pu).multiplyScalar(this.hu).addScaledVector(F.pv, this.hv);
        f.addScaledVector(n, -f.dot(n));
        if (f.lengthSq() < 1e-10) f.copy(F.pu).addScaledVector(n, -F.pu.dot(n));
        f.normalize();
        this._up.copy(n);
        this._fwd.copy(f);
        this.object.position.copy(F.p);
        basisQuat(f, n, this.object.quaternion);
    }

    _applyPose(dt) {
        if (this.mode === 'ground') this._groundPose();
        else {
            this.object.position.copy(this.airPos);
            this.object.quaternion.copy(this.airQuat);
            this._up.set(0, 1, 0).applyQuaternion(this.airQuat);
            this._fwd.set(0, 0, 1).applyQuaternion(this.airQuat);
        }
        this._posture(dt);
        this.object.updateMatrixWorld(true);
        this._invRoot.copy(this.object.matrixWorld).invert();
        this._invRootQ.copy(this.object.quaternion).invert();
        this._rigQ.copy(this.object.quaternion).multiply(this.bodyRig.quaternion);
        this._worldSpace.matrix.copy(this._invRoot);
        this._worldSpace.matrixWorld.identity();
    }

    // Body height, crouch, rear-up, look pitch, landing squash, breathing
    _posture(dt) {
        this.crouch += (this.crouchTarget - this.crouch) * damp(this.crouchRate, dt);
        const sq = this._sq;
        sq.v += (-260 * sq.x - 17 * sq.v) * dt;
        sq.x += sq.v * dt;
        this.rear += (this.rearTarget - this.rear) * damp(7, dt);
        let lp = 0;
        if (this.mode === 'ground' && this._speed < 0.02) {
            _a.copy(this._lookRef()).applyMatrix4(this._invRoot);
            if (_a.z > 0.04) lp = clamp(Math.atan2(_a.y - 0.06, Math.hypot(_a.x, _a.z)) * 0.32, -0.08, 0.22);
        }
        this._lookPitch += (lp - this._lookPitch) * damp(3, dt);
        this._roll += (this._rollTarget - this._roll) * damp(4, dt);
        const k = clamp(sq.x, -0.6, 1);
        this._bobPh += dt * 24;
        const bob = this._speed > 0.02 ? Math.abs(Math.sin(this._bobPh)) * 0.0025 : 0;
        const h = BODY_H * (1 - 0.42 * this.crouch) - 0.011 * k + bob + 0.003 * this.rear;
        const br = this.bodyRig;
        br.rotation.set(-(this._lookPitch + 0.3 * this.rear), 0, this._roll);
        _b.copy(PITCH_PIVOT).applyQuaternion(br.quaternion);
        br.position.set(0, h, 0).add(PITCH_PIVOT).sub(_b);
        br.scale.set(1 + 0.05 * k, 1 - 0.1 * k, 1 + 0.05 * k);
        this._breath += dt;
        const ab = this.abdomen;
        ab.rotation.x = ABD_PITCH - 0.07 * k + 0.012 * Math.sin(this._breath * 2.2) + 0.08 * this.rear;
        ab.scale.setScalar(1 + 0.01 * Math.sin(this._breath * 4.4));
    }

    // ==================================================================================== legs

    _updateLegs(dt) {
        this._feet(dt);
        if (this.mode === 'ground') this._gait(dt);
        this._ik();
    }

    // World foot positions: planted feet from their leaf (u, v), swings interpolated, poses from
    // root-local targets
    _feet(dt) {
        for (const leg of this.legs) {
            if (leg.mode === 'planted') {
                leg.leaf.surfacePoint(leg.u, leg.v, leg.fw, leg.fn);
                leg.fw.addScaledVector(leg.fn, FOOT_LIFT);
            } else if (leg.mode === 'pose') {
                this.object.localToWorld(leg.fw.copy(leg.poseLocal));
                leg.fn.copy(this._up);
            } else {
                const sw = leg.sw;
                sw.t += dt;
                const p = Math.min(sw.t / sw.dur, 1), e = ease(p);
                if (sw.fromUV) { sw.fromLeaf.surfacePoint(sw.fu, sw.fv, _a, _b); _a.addScaledVector(_b, FOOT_LIFT); }
                else { this.object.localToWorld(_a.copy(sw.from)); _b.copy(this._up); }
                if (sw.toUV) { leg.leaf.surfacePoint(sw.tu, sw.tv, _c, _d); _c.addScaledVector(_d, FOOT_LIFT); }
                else { this.object.localToWorld(_c.copy(leg.poseLocal)); _d.copy(this._up); }
                leg.fw.lerpVectors(_a, _c, e);
                leg.fn.lerpVectors(_b, _d, e).normalize();
                leg.fw.addScaledVector(leg.fn, sw.h * Math.sin(Math.PI * p));
                if (p >= 1) {
                    if (sw.toUV) { leg.mode = 'planted'; leg.u = sw.tu; leg.v = sw.tv; }
                    else leg.mode = 'pose';
                }
            }
        }
    }

    // Alternating tetrapod gait: one group of four steps at a time, when its feet lag their rest
    // spots under the body. Steps get quicker the faster the body moves or turns.
    _gait(dt) {
        const turning = Math.abs(this._turnRate);
        const moving = this._speed > 0.02 || turning > 0.35;
        this._still = moving ? 0 : this._still + dt;
        let sw = false, e0 = 0, e1 = 0;
        for (const leg of this.legs) {
            leg.err = 0;
            if (leg.mode === 'swing') { sw = true; continue; }
            if (leg.mode !== 'planted') continue;
            this.object.localToWorld(_a.copy(leg.rest)).sub(leg.fw);
            _a.addScaledVector(this._up, -_a.dot(this._up));
            leg.err = _a.length();
            if (leg.group) e1 = Math.max(e1, leg.err); else e0 = Math.max(e0, leg.err);
        }
        if (sw) return;
        const thr = this._still > 0.18 ? 0.012 : 0.028;   // settle precisely once stopped
        if (e0 < thr && e1 < thr) return;
        let g = e0 >= e1 ? 0 : 1;
        if (g === this._lastGroup && (g ? e0 : e1) > thr * 0.5) g = 1 - g;
        this._lastGroup = g;
        const dur = clamp(0.15 - this._speed * 0.1 - turning * 0.012, 0.075, 0.15);
        const lead = moving ? dur * 0.5 + 0.05 : 0;
        for (const leg of this.legs) {
            if (leg.mode === 'planted' && leg.group === g && leg.err > 0.005) this._stepLeg(leg, lead, dur);
        }
    }

    _stepLeg(leg, lead, dur) {
        this._idealUV(leg, lead, _uv1);
        this.leaf.surfacePoint(_uv1.u, _uv1.v, _e, _f);
        const len = _e.distanceTo(leg.fw);
        if (len < 0.004) return;
        leg.leaf = this.leaf;
        this._swing(leg, true, _uv1.u, _uv1.v, dur, clamp(0.01 + len * 0.32, 0.01, 0.034));
    }

    _swing(leg, toUV, tu, tv, dur, h) {
        const sw = leg.sw;
        if (leg.mode === 'planted') { sw.fromUV = true; sw.fromLeaf = leg.leaf; sw.fu = leg.u; sw.fv = leg.v; }
        else if (leg.mode === 'pose') { sw.fromUV = false; sw.from.copy(leg.poseLocal); }
        else { sw.fromUV = false; sw.from.copy(leg.fw).applyMatrix4(this._invRoot); }
        sw.toUV = toUV; sw.tu = tu; sw.tv = tv;
        sw.t = 0; sw.dur = Math.max(dur, 0.016); sw.h = h;
        leg.mode = 'swing';
    }

    // Where a foot wants to be: its rest spot under the body, predicted `lead` seconds ahead
    _idealUV(leg, lead, out) {
        const a = this._turnRate * lead, c = Math.cos(a), s = Math.sin(a), r = leg.rest;
        _g.set(r.x * c + r.z * s, 0, -r.x * s + r.z * c);
        this.object.localToWorld(_g).addScaledVector(this._moveVel, lead);
        this._af.solve(_h.subVectors(_g, this._af.p), out);
        out.u += this.u;
        out.v += this.v;
        this._refineUV(this.leaf, _g, out, 1);
        out.u = clamp(out.u, 0.04, 0.97);   // clamp feet to the leaf
        out.v = clamp(out.v, -0.95, 0.95);
        return out;
    }

    _refineUV(leaf, world, uv, iters) {
        for (let k = 0; k < iters; k++) {
            uv.u = clamp(uv.u, -0.1, 1.1);
            uv.v = clamp(uv.v, -1.4, 1.4);
            const F = this._tf.compute(leaf, uv.u, uv.v);
            F.solve(_i.subVectors(world, F.p), _uvd);
            uv.u += _uvd.u;
            uv.v += _uvd.v;
        }
        return uv;
    }

    _uvOn(leaf, world, gu, gv, out) {
        out.u = gu; out.v = gv;
        return this._refineUV(leaf, world, out, 3);
    }

    // Plant every foot at its rest spot (start-up, teleports)
    _plantAll() {
        this._groundPose();
        this._posture(0);
        this.object.updateMatrixWorld(true);
        this._invRoot.copy(this.object.matrixWorld).invert();
        this._invRootQ.copy(this.object.quaternion).invert();
        this._speed = 0; this._turnRate = 0; this._moveVel.set(0, 0, 0);
        for (const leg of this.legs) {
            leg.leaf = this.leaf;
            leg.ankUp = ANK_UP;
            leg.ankIn = ANK_IN;
            this._idealUV(leg, 0, _uv2);
            leg.u = _uv2.u; leg.v = _uv2.v;
            leg.mode = 'planted';
            this.leaf.surfacePoint(leg.u, leg.v, leg.fw, leg.fn);
            leg.fw.addScaledVector(leg.fn, FOOT_LIFT);
        }
    }

    _replantLeg(leg, dur = 0.14) {
        if (this.mode !== 'ground' || !this.leaf) return;
        leg.ankUp = ANK_UP;
        leg.ankIn = ANK_IN;
        leg.leaf = this.leaf;
        this._idealUV(leg, 0, _uv2);
        this._swing(leg, true, _uv2.u, _uv2.v, dur, 0.012);
    }

    // 2-bone IK (femur, tibia) from the hip to an ankle point above the foot, then the metatarsus.
    // Everything in root space; segments go straight into the instanced meshes.
    _ik() {
        const br = this.bodyRig;
        br.updateMatrix();
        for (const leg of this.legs) {
            const [L1, L2, L3] = leg.L;
            const H = _a.copy(leg.hip).applyMatrix4(br.matrix);
            const F = _b.copy(leg.fw).applyMatrix4(this._invRoot);
            const n = _c.copy(leg.fn).applyQuaternion(this._invRootQ);
            const inward = _d.subVectors(H, F);
            inward.addScaledVector(n, -inward.dot(n));
            const il = inward.length();
            if (il > 1e-6) inward.multiplyScalar(1 / il);
            const ad = _e.copy(n).multiplyScalar(leg.ankUp).addScaledVector(inward, leg.ankIn).normalize();
            const A = _f.copy(F).addScaledVector(ad, L3);
            const D = _g.subVectors(A, H);
            let dist = D.length();
            if (dist < 1e-6) { D.set(0, 0, 1); dist = 1e-6; }
            D.multiplyScalar(1 / dist);
            const maxR = (L1 + L2) * 0.995, minR = Math.abs(L1 - L2) + 0.006;
            if (dist > maxR || dist < minR) {   // out of reach: the foot comes short of its target
                dist = clamp(dist, minR, maxR);
                A.copy(H).addScaledVector(D, dist);
                F.copy(A).addScaledVector(ad, -L3);
            }
            // Knee up and a little outward
            const P = _h.set(F.x - H.x, 0, F.z - H.z);
            const pl = P.length();
            if (pl > 1e-6) P.multiplyScalar(0.18 / pl);   // knees high: arched legs
            P.y += 1;
            P.addScaledVector(D, -P.dot(D));
            if (P.lengthSq() < 1e-10) P.set(0, 1, 0);
            P.normalize();
            const ca = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1), sa = Math.sqrt(1 - ca * ca);
            const K = _i.copy(H).addScaledVector(D, L1 * ca).addScaledVector(P, L1 * sa);
            const N = _j.subVectors(K, H).cross(_k.subVectors(A, K));
            if (N.lengthSq() < 1e-12) N.crossVectors(P, D);
            N.normalize();
            const r = leg.r;
            this._seg(this._femur, leg.i, H, K, N, r[0]);
            this._seg(leg.tibiaMesh, leg.tibiaIdx, K, A, N, r[1]);
            this._seg(this._meta, leg.i, A, F, N, r[2]);
            this._joints.setMatrixAt(leg.i * 2, _m1.makeScale(r[3], r[3], r[3]).setPosition(K));
            this._joints.setMatrixAt(leg.i * 2 + 1, _m1.makeScale(r[4], r[4], r[4]).setPosition(A));
        }
        this._femur.instanceMatrix.needsUpdate = true;
        this._tibia.instanceMatrix.needsUpdate = true;
        this._tibia1.instanceMatrix.needsUpdate = true;
        this._meta.instanceMatrix.needsUpdate = true;
        this._joints.instanceMatrix.needsUpdate = true;
    }

    // Instance matrix for a unit segment from P to Q, rolled so +X faces the inside of the bend
    _seg(mesh, idx, P, Q, N, r) {
        const Y = _l.subVectors(Q, P), L = Y.length();
        if (L < 1e-7) return;
        Y.multiplyScalar(1 / L);
        const X = _bx.crossVectors(N, Y);
        if (X.lengthSq() < 1e-10) X.crossVectors(Math.abs(Y.y) < 0.9 ? UP : X_AXIS, Y);
        X.normalize();
        const Z = _bz.crossVectors(X, Y);
        _m1.makeBasis(X.multiplyScalar(r), Y.multiplyScalar(L), Z.multiplyScalar(r)).setPosition(P);
        mesh.setMatrixAt(idx, _m1);
    }

    // Foot targets (root space) for flight: hind legs trail from the push, then all reach for the leaf
    _airFoot(leg, s, out) {
        const r = leg.rest;
        if (leg.pair >= 2) {
            _a.set(r.x * 0.5, -0.03, r.z - 0.07 - 0.03 * (leg.pair - 2));
            _b.set(r.x * 0.95, -0.006, r.z * 0.85);
            return out.lerpVectors(_a, _b, sstep(0.2, 0.85, s));
        }
        _a.set(r.x * 0.75, 0.02 - 0.012 * leg.pair, r.z + 0.025);
        _b.set(r.x * 1.02, -0.006, r.z * 0.98 + 0.012);
        return out.lerpVectors(_a, _b, sstep(0.45, 0.95, s));
    }

    // Hanging head-down on silk: front legs spread towards the leaf below, hind legs on the thread
    _hangFoot(leg, out) {
        const r = leg.rest;
        switch (leg.pair) {
            case 0: return out.set(r.x * 0.75, -0.012, r.z + 0.035);
            case 1: return out.set(r.x * 0.95, -0.02, r.z + 0.03);
            case 2: return out.set(r.x * 0.95, -0.01, r.z + 0.01);
            default: return out.set(leg.side * 0.012, BODY_H + 0.012, -0.2);
        }
    }

    _liftOff() {
        this.airPos.copy(this.object.position);
        this.airQuat.copy(this.object.quaternion);
        this.mode = 'air';
        this.airborne = true;
        this.leaf = null;
        this._speed = 0; this._turnRate = 0; this._moveVel.set(0, 0, 0);
        for (const leg of this.legs) {
            this._airFoot(leg, 0, leg.poseLocal);
            this._swing(leg, false, 0, 0, leg.pair >= 2 ? 0.1 : 0.06, 0);
        }
    }

    _airLegs(s) { for (const leg of this.legs) this._airFoot(leg, s, leg.poseLocal); }

    // Touch down on (leaf, u, v) facing fwd: feet slap down onto their rest spots
    _landOn(leaf, u, v, fwd, bounce = 1) {
        this.leaf = leaf; this.u = u; this.v = v;
        this.mode = 'ground';
        this.airborne = false;
        this._speed = 0; this._turnRate = 0; this._moveVel.set(0, 0, 0);
        const F = this._af.compute(leaf, u, v);
        _a.copy(fwd).addScaledVector(F.n, -fwd.dot(F.n));
        if (_a.lengthSq() < 1e-8) _a.copy(F.pu);
        this._setHeadingWorld(_a.normalize());
        this._groundPose();
        this.object.updateMatrixWorld(true);
        this._invRoot.copy(this.object.matrixWorld).invert();
        this._invRootQ.copy(this.object.quaternion).invert();
        for (const leg of this.legs) {
            leg.leaf = leaf;
            leg.ankUp = ANK_UP;
            leg.ankIn = ANK_IN;
            this._idealUV(leg, 0, _uv2);
            this._swing(leg, true, _uv2.u, _uv2.v, 0.045 + 0.02 * leg.pair, 0.003);
        }
        if (bounce) leaf.bounce(bounce);
        this._sq.v -= 2.2 * Math.min(bounce, 1.4);
    }

    // ============================================================================ palps & head

    _updatePalps(dt) {
        const t = this._time;
        for (let i = 0; i < 2; i++) {
            const p = this._palps[i], side = i ? -1 : 1;
            switch (this.palpMode) {
                case 'walk': p.liftT = 0.25 + 0.4 * Math.max(0, Math.sin(t * 11 + i * Math.PI)); p.spreadT = 0.1; p.curlT = 0; p.k = 22; break;
                case 'alert': p.liftT = 0.5; p.spreadT = 0.25; p.curlT = 0.1; p.k = 10; break;
                case 'eat': p.liftT = 0.05 + 0.08 * Math.sin(t * 8 + i * 2); p.spreadT = -0.55; p.curlT = 0.9; p.k = 14; break;
                case 'up': p.liftT = 1.05; p.spreadT = 0.7; p.curlT = -0.3; p.k = 18; break;
                case 'groom': p.liftT = 0.3 + 0.25 * Math.sin(t * 15 + i * Math.PI); p.spreadT = -0.35; p.curlT = 0.5; p.k = 24; break;
                default:   // Portia's palps flick up and down in little jerks
                    if ((p.timer -= dt) <= 0) {
                        p.timer = rand(0.25, 1.5);
                        p.liftT = Math.random() < 0.4 ? rand(0.35, 0.8) : rand(-0.1, 0.2);
                        p.spreadT = rand(-0.1, 0.25);
                        p.curlT = rand(-0.1, 0.3);
                        p.k = rand(14, 30);
                    }
            }
            const a = damp(p.k, dt);
            p.lift += (p.liftT - p.lift) * a;
            p.spread += (p.spreadT - p.spread) * a;
            p.curl += (p.curlT - p.curl) * a;
            // Femur forward and down, tibia and tarsus hanging in front of the chelicerae
            const y1 = side * (0.36 + 0.3 * p.spread), p1 = -0.85 + 1.0 * p.lift;
            const y2 = side * (0.05 - 0.3 * p.curl), p2 = p1 - 0.7 + 0.2 * p.lift - 0.2 * p.curl;
            const y3 = side * (-0.25 - 0.25 * p.curl), p3 = p2 - 0.3 - 0.35 * p.curl;
            const B = PALP_BASE[i], N = _c.set(Math.cos(y1), 0, -Math.sin(y1));
            const K1 = _a.copy(B).addScaledVector(dirYP(y1, p1, _d), PALP_L[0]);
            this._seg(this._palpMesh, i * 3, B, K1, N, PALP_R[0]);
            const K2 = _b.copy(K1).addScaledVector(dirYP(y2, p2, _d), PALP_L[1]);
            this._seg(this._palpMesh, i * 3 + 1, K1, K2, N, PALP_R[1]);
            const K3 = _e.copy(K2).addScaledVector(dirYP(y3, p3, _d), PALP_L[2]);
            this._seg(this._palpMesh, i * 3 + 2, K2, K3, N, PALP_R[2]);
        }
        this._palpMesh.instanceMatrix.needsUpdate = true;
    }

    // Eyes track the look target with little saccades; the highlight dot follows the light
    _updateHead(dt) {
        const lp = this.bodyRig.worldToLocal(_a.copy(this._lookRef()));
        if ((this._sacT -= dt) <= 0) {
            this._sacT = rand(0.35, 2);
            this._sac.set(rand(-0.08, 0.08), rand(-0.05, 0.06));
        }
        this.eyePop = Math.max(0, this.eyePop - dt * 1.4);
        const pop = 1 + 0.16 * ease(this.eyePop);
        const cam = this.camera?.position ?? DEFAULT_GAZE;
        _q2.copy(this._rigQ).invert();
        for (let i = 0; i < 2; i++) {
            const c = AME_POS[i];
            _b.subVectors(lp, c);
            const yaw = clamp(Math.atan2(_b.x, Math.max(_b.z, 0.02)) + this._sac.x, -0.38, 0.38);
            const pitch = clamp(Math.atan2(_b.y, Math.hypot(_b.x, _b.z)) + this._sac.y, -0.3, 0.3);
            this._eyeYaw[i] += (yaw - this._eyeYaw[i]) * damp(20, dt);
            this._eyePitch[i] += (pitch - this._eyePitch[i]) * damp(20, dt);
            _q1.setFromEuler(_eul.set(-this._eyePitch[i], this._eyeYaw[i], 0));
            this._ame.setMatrixAt(i, _m1.compose(c, _q1, _c.setScalar(AME_R * pop)));
            // Highlight: halfway between the view and key-light directions, on the eye's surface
            this.bodyRig.localToWorld(_d.copy(c));
            _e.subVectors(cam, _d).normalize().addScaledVector(KEY_DIR, 0.7).normalize().applyQuaternion(_q2);
            const vis = _e.z > -0.1 ? 1 : 0;
            _f.copy(c).addScaledVector(_e, AME_R * pop * 1.02);
            _q1.setFromUnitVectors(Z_AXIS, _e);
            this._glint.setMatrixAt(i, _m1.compose(_f, _q1, _c.setScalar(AME_R * 0.24 * pop * vis)));
        }
        this._ame.instanceMatrix.needsUpdate = true;
        this._glint.instanceMatrix.needsUpdate = true;
        this._chel.rotation.x = this.eating ? 0.1 + 0.1 * Math.sin(this._time * 10) : 0;
    }

    // ==================================================================================== silk

    _updateSilk(dt) {
        for (const th of this._threads) {
            if (!th.active) continue;
            th.aLeaf.surfacePoint(th.au, th.av, _a, _c);
            if (th.bLeaf) th.bLeaf.surfacePoint(th.bu, th.bv, _b, _c);
            else this.abdomen.localToWorld(_b.copy(SPINNERET));
            if (th.fade > 0) {
                th.alpha -= dt / th.fade;
                if (th.alpha <= 0) { th.hide(); continue; }
            }
            th.mat.opacity = 0.72 * Math.min(1, th.alpha * 1.5);
            const d = _a.distanceTo(_b);
            th.write(_a, _b, th.bLeaf ? d * 0.05 * (1.3 - th.alpha) : d * 0.01);
        }
    }

    _threadStart(leaf, u, v) {
        let th = this._threads.find(x => !x.active);
        if (!th) th = this._threads.reduce((x, y) => (x.alpha < y.alpha ? x : y));
        th.start(leaf, u, v);
        return th;
    }

    // Pin the free end of a thread to the leaf under the spinnerets and let it fade
    _threadPin(th, leaf, fade, gu, gv) {
        this.abdomen.localToWorld(_a.copy(SPINNERET));
        this._uvOn(leaf, _a, gu, gv, _uv3);
        th.pin(leaf, clamp(_uv3.u, 0.02, 0.98), clamp(_uv3.v, -0.98, 0.98), fade);
    }

    // ============================================================================ heading utils

    _setHeadingWorld(d) {
        this._af.solve(d, _uv3);
        const l = Math.hypot(_uv3.u, _uv3.v);
        if (l < 1e-9) return;
        this.hu = _uv3.u / l;
        this.hv = _uv3.v / l;
    }

    _rotateHeading(a) {
        if (!a) return;
        _a.crossVectors(this._up, this._fwd);   // left
        this._fwd.multiplyScalar(Math.cos(a)).addScaledVector(_a, Math.sin(a)).normalize();
        this._setHeadingWorld(this._fwd);
    }

    // Signed angle (left positive) from our heading to a world point, in the leaf's plane
    _angleTo(p) {
        _b.subVectors(p, this._af.p);
        _b.addScaledVector(this._up, -_b.dot(this._up));
        if (_b.lengthSq() < 1e-8) return 0;
        _c.crossVectors(this._fwd, _b);
        return Math.atan2(_c.dot(this._up), this._fwd.dot(_b));
    }

    _moveForward(dist) {
        this._af.solve(_a.copy(this._fwd).multiplyScalar(dist), _uv3);
        this.u = clamp(this.u + _uv3.u, WALK.uMin, WALK.uMax);
        this.v = clamp(this.v + _uv3.v, -WALK.vMax, WALK.vMax);
    }

    _arcPoint(P0, P1, H, s, out) {
        out.lerpVectors(P0, P1, s);
        out.y += 4 * H * s * (1 - s);
        return out;
    }

    // ============================================================================== behaviour

    _think() {
        const grounded = this.mode === 'ground' && !this.airborne;
        const g = this._goal;
        if (g && !g.started && grounded) {
            this._abortTask();
            g.started = true;
            this._task = this._taskGoTo(g);
            this._taskName = 'goto';
        } else if (this._pokeReq && grounded) {
            this._pokeReq = false;
            if (this._taskName !== 'goto' && this._taskName !== 'poke') {
                this._abortTask();
                this._task = this._taskPoke();
                this._taskName = 'poke';
            }
        } else if (!this.roaming && this._roamAct && grounded) {
            this._abortTask();   // roaming switched off mid-wander: stay put
        }
        if (!grounded) this._pokeReq = false;
        if (!this._task) {
            this._task = this._taskAmbient();
            this._taskName = 'ambient';
        }
        if (this._task.next(this._dt).done) { this._task = null; this._taskName = ''; }
    }

    _abortTask() {
        const t = this._task;
        this._task = null;
        this._taskName = '';
        if (t) t.return();
        this._roamAct = false;
        this.crouchTarget = 0; this.crouchRate = 10;
        this.rearTarget = 0; this._rollTarget = 0;
        this.palpMode = 'idle';
        this._lookOverride = null;
        this.eating = false;
        this._speed = 0; this._turnRate = 0; this._moveVel.set(0, 0, 0);
        if (this.mode === 'ground' && this.leaf) {
            for (const leg of this.legs) if (leg.mode === 'pose' || (leg.mode === 'swing' && !leg.sw.toUV)) this._replantLeg(leg, 0.14);
        }
    }

    *_wait(sec) { let t = 0; while (t < sec) t += yield; }

    // Ambient life: something every 4–10 s, watching the viewer and hunting in between
    *_taskAmbient() {
        let next = rand(2.5, 5), off = 0;
        for (;;) {
            let t = 0;
            while (t < next) {
                const dt = yield;
                t += dt;
                if (this.mode !== 'ground') continue;
                off = Math.abs(this._angleTo(this._gazeRef())) > 0.75 ? off + dt : 0;
                if (off > 1.2) {
                    off = 0;
                    yield* this._turnToward(this._gazeRef(), { speed: 3.6, tol: 0.2 });
                }
                if (this.roaming && this._huntCD <= 0) {
                    this._huntCD = 0.35;
                    const prey = this._findPrey();
                    if (prey) {
                        this._roamAct = true;
                        try { yield* this._hunt(prey.fly, prey.pounce); } finally { this._roamAct = false; }
                        t = Math.min(t, next - rand(2, 4));
                    }
                }
            }
            yield* this._ambientAction();
            next = rand(4, 10);
        }
    }

    *_ambientAction() {
        const r = Math.random();
        if (!this.roaming) {
            if (r < 0.3) yield* this._actLook();
            else if (r < 0.55) yield* this._actClean();
            else if (r < 0.8) yield* this._actShuffle();
            else yield* this._actPeek();
            return;
        }
        this._roamAct = true;
        try {
            if (r < 0.3) yield* this._actWander();
            else if (r < 0.52) { if (!(yield* this._actHop())) yield* this._actWander(); }
            else if (r < 0.64) { if (!(yield* this._actSilk())) yield* this._actWander(); }
            else {
                this._roamAct = false;
                if (r < 0.76) yield* this._actClean();
                else if (r < 0.88) yield* this._actLook();
                else yield* this._actPeek();
            }
        } finally { this._roamAct = false; }
    }

    // In-place turn towards a (live) world point, in Portia's jerky bursts
    *_turnToward(point, { speed = 3.6, choppy = true, tol = 0.12, maxTime = 2.5 } = {}) {
        let t = 0, burst = Math.min(rand(0.08, 0.16), 0.36 / speed), pause = 0;
        try {
            while (t < maxTime) {
                const dt = yield;
                t += dt;
                const ang = this._angleTo(point);
                if (Math.abs(ang) < tol) break;
                if (choppy) {
                    if (pause > 0) { pause -= dt; this._turnRate = 0; continue; }
                    if ((burst -= dt) <= 0) { burst = Math.min(rand(0.09, 0.16), 0.36 / speed); pause = rand(0.06, 0.15); }
                }
                const a = Math.sign(ang) * Math.min(Math.abs(ang), speed * dt);
                this._rotateHeading(a);
                this._turnRate = a / Math.max(dt, 1e-4);
            }
        } finally { this._turnRate = 0; }
    }

    // Choppy stop-start walk to (u, v) on the current leaf, palps waving
    *_walkTo(u, v, { speed = 0.3, choppy = true, hurry = false, tol = 0.012, maxTime = 6, until = null } = {}) {
        const leaf = this.leaf;
        if (!leaf) return;
        u = clamp(u, WALK.uMin, WALK.uMax);
        v = clamp(v, -WALK.vMax, WALK.vMax);
        const tgt = new V3(), tn = new V3(), d = new V3();
        let phase = 1, timer = rand(0.12, 0.22), cur = 0, t = 0;
        this.palpMode = 'walk';
        try {
            while (t < maxTime && this.leaf === leaf) {
                const dt = yield;
                t += dt;
                if (until?.()) break;
                leaf.surfacePoint(u, v, tgt, tn);
                d.subVectors(tgt, this._af.p).addScaledVector(this._up, -d.dot(this._up));
                const dist = d.length();
                if (dist < tol) break;
                const ang = this._angleTo(tgt);
                if (Math.abs(ang) > 0.85) {
                    this._speed = cur = 0;
                    this._moveVel.set(0, 0, 0);
                    yield* this._turnToward(tgt, { speed: hurry ? 7 : 3.4, choppy: !hurry, tol: 0.3 });
                    continue;
                }
                if (choppy && (timer -= dt) <= 0) {
                    phase = 1 - phase;
                    timer = phase ? rand(0.13, 0.24) : hurry ? rand(0.03, 0.08) : rand(0.08, 0.32);
                }
                const want = phase || !choppy ? speed : 0;
                cur += (want - cur) * damp(want > cur ? 28 : 40, dt);
                const turn = clamp(ang, -2.5 * dt, 2.5 * dt);
                this._rotateHeading(turn);
                this._turnRate = turn / Math.max(dt, 1e-4);
                this._moveForward(Math.min(cur * dt, dist));
                this._speed = cur;
                this._moveVel.copy(this._fwd).multiplyScalar(cur);
            }
        } finally {
            this._speed = 0; this._turnRate = 0; this._moveVel.set(0, 0, 0);
            this.palpMode = 'idle';
        }
    }

    // Ballistic flight from where we stand to (leaf1, uv1), dragline trailing; lands and plants
    *_flight(leaf1, uv1, { T, H, fwd, bounceUp = 0.8, bounceDown = 1, thread = true, pitchAmt = 0.38 }) {
        const leaf0 = this.leaf;
        const P0 = this.object.position.clone(), q0 = this.object.quaternion.clone();
        const P1 = new V3(), n1 = new V3(), q1 = new THREE.Quaternion(), fw = new V3(), qp = new THREE.Quaternion();
        // No dragline when jumping up: silk only trails a jump that lands lower than it started
        leaf1.surfacePoint(uv1.u, uv1.v, P1, n1);
        const upward = P1.y > P0.y;
        const th = thread && !upward ? this._threadStart(leaf0, this.u, this.v) : null;
        leaf0.bounce(bounceUp);
        this._liftOff();
        let t = 0;
        while (t < T) {
            const dt = yield;
            t += dt;
            const s = Math.min(t / T, 1);
            leaf1.surfacePoint(uv1.u, uv1.v, P1, n1);
            this._arcPoint(P0, P1, H, s, this.airPos);
            fw.copy(fwd).addScaledVector(n1, -fwd.dot(n1));
            if (fw.lengthSq() < 1e-8) fw.copy(this._fwd);
            fw.normalize();
            basisQuat(fw, n1, q1);
            this.airQuat.slerpQuaternions(q0, q1, sstep(0.05, 0.8, s));
            const pitch = pitchAmt * Math.cos(Math.PI * s) * (1 - s ** 4);   // nose up, level, reaching
            this.airQuat.multiply(qp.setFromAxisAngle(X_AXIS, -pitch));
            this._airLegs(s);
        }
        this._landOn(leaf1, uv1.u, uv1.v, fw, bounceDown);
        if (th) this._threadPin(th, leaf1, 1.6, uv1.u, uv1.v);
    }

    _planJump(P0, n0, P1, n1, leaf0, leaf1, hurry) {
        const D = _j.subVectors(P1, P0), dist = D.length(), horiz = Math.hypot(D.x, D.z);
        let H = 0.04 + 0.16 * horiz + 0.3 * Math.max(0, D.y);
        if (n1.y > 0.12) H = Math.max(H, D.dot(n1) / (4 * n1.y) + 0.05);    // come down onto the face
        if (n0.y > 0.12) H = Math.max(H, -D.dot(n0) / (4 * n0.y) + 0.035);  // leave it upwards
        let blocked = this._arcBlocked(P0, P1, H, leaf0, leaf1);
        for (let k = 0; k < 3 && blocked; k++) {
            H += 0.15;
            blocked = this._arcBlocked(P0, P1, H, leaf0, leaf1);
        }
        const T = clamp(0.34 + 0.32 * Math.sqrt(dist) + 0.15 * H, 0.36, 0.95) * (hurry ? 0.92 : 1);
        return { H, T, blocked };
    }

    // Does the arc pass through another leaf? (decision time only)
    _arcBlocked(P0, P1, H, leaf0, leaf1) {
        const picks = this.plant?.pickables;
        if (!picks?.length) return false;
        const rc = this._raycaster, prev = new V3().copy(P0).addScaledVector(UP, 0.03), cur = new V3(), dir = new V3();
        for (let i = 1; i <= 10; i++) {
            this._arcPoint(P0, P1, H, i / 10, cur);
            dir.subVectors(cur, prev);
            const len = dir.length();
            if (len < 1e-6) continue;
            rc.set(prev, dir.multiplyScalar(1 / len));
            rc.near = 0;
            rc.far = len;
            for (const hit of rc.intersectObjects(picks, true)) {
                const lf = this._leafOf(hit.object);
                if (lf === leaf0 && hit.point.distanceTo(P0) < 0.14) continue;
                if (lf === leaf1 && hit.point.distanceTo(P1) < 0.14) continue;
                return true;
            }
            prev.copy(cur);
        }
        return false;
    }

    _leafOf(o) {
        for (; o; o = o.parent) if (o.userData?.leaf) return o.userData.leaf;
        return null;
    }

    // First leaf below a point (decision time only)
    _rayLeaf(origin, dir, far, exclude) {
        const picks = this.plant?.pickables;
        if (!picks?.length) return null;
        const rc = this._raycaster;
        rc.set(origin, dir);
        rc.near = 0;
        rc.far = far;
        for (const hit of rc.intersectObjects(picks, true)) {
            const leaf = this._leafOf(hit.object);
            if (!leaf || leaf === exclude) continue;
            const g = leaf.project(hit.point), uv = leaf.clampUV(g.u, g.v);
            const p = new V3(), n = new V3();
            leaf.surfacePoint(uv.u, uv.v, p, n);
            return n.y > 0.15 ? { leaf, uv, point: p } : null;
        }
        return null;
    }

    _edgeOut(leaf, u, v, out) {
        const F = this._tf.compute(leaf, u, v);
        if (Math.abs(v) > 0.5) out.copy(F.pv).multiplyScalar(Math.sign(v));
        else out.copy(F.pu);
        out.addScaledVector(F.n, -out.dot(F.n));
        return out.normalize();
    }

    *_jump(leaf1, uv1, { hurry = false } = {}) {
        const P1 = new V3(), n1 = new V3();
        leaf1.surfacePoint(uv1.u, uv1.v, P1, n1);
        // A quick partial pivot when hurried: the flight turns us the rest of the way
        yield* this._turnToward(P1, hurry ? { speed: 7, choppy: false, tol: 0.4, maxTime: 0.22 } : { speed: 3.6, tol: 0.15, maxTime: 2.5 });
        // Crouch and aim
        this.crouchTarget = 1;
        this.crouchRate = hurry ? 22 : 9;
        this.palpMode = 'alert';
        yield* this._wait(hurry ? 0.13 : rand(0.28, 0.5));
        leaf1.surfacePoint(uv1.u, uv1.v, P1, n1);
        const P0 = this.object.position;
        const plan = this._planJump(P0, this._up, P1, n1, this.leaf, leaf1, hurry);
        const dir = new V3().subVectors(P1, P0).setY(0);
        if (dir.lengthSq() < 1e-6) dir.copy(this._fwd);
        dir.normalize();
        this.crouchTarget = 0;
        this.crouchRate = 30;
        this.palpMode = 'idle';
        yield* this._flight(leaf1, uv1, { T: plan.T, H: plan.H, fwd: dir, bounceUp: 0.8, bounceDown: hurry ? 1.1 : 0.9 });
        yield* this._wait(hurry ? 0.1 : 0.25);
    }


    // goToLeaf: jump (or abseil when the target is mostly below), then settle on the spot
    *_taskGoTo(goal) {
        const { leaf, uv } = goal;
        for (let k = 0; k < 3 && this._goal === goal; k++) {
            if (this.leaf === leaf) {
                leaf.surfacePoint(uv.u, uv.v, _a, _b);
                const d = _a.distanceTo(this._af.p);
                if (d < 0.025) break;
                if (d < 0.3) yield* this._walkTo(uv.u, uv.v, { speed: 0.7, hurry: true, tol: 0.018, maxTime: 2.5 });
                else yield* this._jump(leaf, uv, { hurry: true });
            } else {
                const route = this._chooseRoute(leaf, uv);
                if (route.silk) yield* this._silkDrop({ edge: route.edge, target: { leaf, uv }, hurry: true });
                else yield* this._jump(leaf, uv, { hurry: true });
            }
        }
        if (this._goal === goal) this._goal = null;
        goal.resolve(true);
        yield* this._turnToward(this._gazeRef(), { speed: 5, tol: 0.25, maxTime: 1.2 });
    }

    _chooseRoute(leaf, uv) {
        const T = new V3(), nT = new V3(), E = new V3(), nE = new V3(), o = new V3();
        leaf.surfacePoint(uv.u, uv.v, T, nT);
        const P = this._af.p, dy = P.y - T.y, hd = Math.hypot(T.x - P.x, T.z - P.z);
        if (dy < 0.3 || dy < 1.1 * hd) return { silk: false };
        let best = null;
        for (const e of EDGE_SAMPLES) {
            this.leaf.surfacePoint(e.u, e.v, E, nE);
            if (E.y - T.y < 0.28) continue;
            const he = Math.hypot(E.x - T.x, E.z - T.z), walk = E.distanceTo(P), cost = 2 * he + walk;
            if (!best || cost < best.cost) best = { u: e.u, v: e.v, he, walk, cost };
        }
        if (!best || best.he > 0.28 || best.walk > 0.45) return { silk: false };
        // Only abseil when it fits the ~1.8 s budget: walk, step off, drop, flip
        const drop = Math.max(0, dy - 0.3);
        const tDrop = drop < 0.24 ? Math.sqrt(drop / 5.5) : 0.21 + (drop - 0.24) / 2.3;
        this.leaf.surfacePoint(best.u, best.v, E, nE);
        const turn = Math.abs(this._angleTo(E)) / 7;
        if (turn + best.walk / 0.85 + 0.2 + 0.22 + tDrop + 0.3 > 1.65) return { silk: false };
        // Nothing else in the way below the edge
        this._edgeOut(this.leaf, best.u, best.v, o).setY(0);
        if (o.lengthSq() > 1e-6) o.normalize();
        const hit = this._rayLeaf(E.addScaledVector(o, 0.02).addScaledVector(UP, -0.06), DOWN, dy + 0.4, this.leaf);
        if (hit && hit.leaf !== leaf) return { silk: false };
        return { silk: true, edge: best };
    }

    // Walk to an edge, step off head-first and abseil onto the leaf below (or dangle and climb back)
    *_silkDrop({ edge, target = null, hurry = false }) {
        const leaf0 = this.leaf;
        const inner = leaf0.clampUV(edge.u, edge.v);
        yield* this._walkTo(inner.u, inner.v, { speed: hurry ? 1.15 : 0.3, hurry, tol: 0.02, maxTime: hurry ? 1.2 : 5 });
        if (this.leaf !== leaf0 || this.mode !== 'ground') return false;
        const A = new V3(), nA = new V3(), out = new V3(), D = new V3(), look = new V3();
        leaf0.surfacePoint(edge.u, edge.v, A, nA);
        this._edgeOut(leaf0, edge.u, edge.v, out);
        look.copy(A).addScaledVector(out, 0.3);
        yield* this._turnToward(look, hurry ? { speed: 8, choppy: false, tol: 0.3, maxTime: 0.25 } : { speed: 3.6, tol: 0.15 });
        D.copy(out).setY(0);
        if (D.lengthSq() < 1e-4) D.copy(this._fwd).setY(0);
        if (D.lengthSq() < 1e-6) D.set(0, 0, 1);
        D.normalize();
        const tLeaf = target?.leaf ?? edge.below?.leaf ?? null;
        const tUV = target?.uv ?? edge.below?.uv ?? null;
        const T = new V3(), nT = new V3();

        // Step off: pitch head-first over the edge onto a short thread, legs letting go front to back
        const th = this._threadStart(leaf0, edge.u, edge.v);
        const p0 = this.object.position.clone(), q0 = this.object.quaternion.clone();
        this.mode = 'air';
        this.airborne = true;
        this.leaf = null;
        this.airPos.copy(p0);
        this.airQuat.copy(q0);
        const tdir = new V3(0, -1, 0), qh = new THREE.Quaternion(), ph = new V3(), Dc = D.clone();
        const l0 = 0.03, Tso = hurry ? 0.22 : 0.5, letGo = [0.05, 0.2, 0.45, 0.7];
        let t = 0;
        while (t < Tso) {
            const dt = yield;
            t += dt;
            const e = ease(t / Tso);
            leaf0.surfacePoint(edge.u, edge.v, A, nA);
            this._hangPose(A, l0 * e, D, tdir, ph, qh);
            this.airQuat.slerpQuaternions(q0, qh, e);
            this.airPos.lerpVectors(p0, ph, e).addScaledVector(nA, 0.04 * Math.sin(Math.PI * e)).addScaledVector(D, 0.03 * Math.sin(Math.PI * e));
            for (const leg of this.legs) {
                this._hangFoot(leg, leg.poseLocal);
                if (leg.mode === 'planted' && e > letGo[leg.pair]) this._swing(leg, false, 0, 0, 0.12, 0.01);
            }
        }
        for (const leg of this.legs) if (leg.mode === 'planted') this._swing(leg, false, 0, 0, 0.08, 0.01);

        // Lower away. With a target the thread swings us over it; without, dangle for a bit
        let len = l0, vel = 0, tt = 0, hang = 0, spin = rand(0, TAU);
        const swayPh = rand(0, TAU), spinV = rand(0.3, 0.6) * (Math.random() < 0.5 ? -1 : 1);
        const hangFor = rand(1.4, 2.4), dangleLen = rand(0.24, 0.42);
        for (;;) {
            const dt = yield;
            tt += dt;
            const rush = hurry || !!(this._goal && !this._goal.started);
            leaf0.surfacePoint(edge.u, edge.v, A, nA);
            const vMax = rush ? 2.3 : 0.42;
            if (tLeaf) {
                vel = Math.min(vMax, vel + dt * (rush ? 11 : 1.6));
                len += vel * dt;
                tLeaf.surfacePoint(tUV.u, tUV.v, T, nT);
                const prog = ease((len - l0) / Math.max(0.05, A.y - T.y - 0.25));
                tdir.set((T.x + 0.045 * D.x - A.x) * prog, -len, (T.z + 0.045 * D.z - A.z) * prog).normalize();
            } else {
                if (len < dangleLen) {
                    vel = Math.min(vMax, vel + dt * 1.6);
                    len = Math.min(dangleLen, len + vel * dt);
                } else if ((hang += dt) > (rush ? 0.15 : hangFor)) break;
                const sw = 0.1 * Math.sin(tt * 2.4 + swayPh) * Math.exp(-tt * 0.3);
                tdir.set(D.x * sw, -1, D.z * sw).normalize();
                spin += spinV * dt;
                Dc.copy(D).applyAxisAngle(UP, 0.5 * Math.sin(spin));
            }
            this._hangPose(A, len, tLeaf ? D : Dc, tdir, this.airPos, this.airQuat);
            for (const leg of this.legs) this._hangFoot(leg, leg.poseLocal);
            if (tLeaf) {
                _a.set(0, BODY_H + 0.02, 0.075).applyQuaternion(this.airQuat).add(this.airPos);   // head
                if (_a.y - T.y < 0.07 + vel * 0.03 || len > 3) break;
            }
        }

        if (tLeaf) {
            // Flip onto the leaf below, back towards where we came from
            const pH = this.airPos.clone(), qH = this.airQuat.clone(), q1 = new THREE.Quaternion(), fw = new V3();
            const Tl = hurry ? 0.2 : 0.34;
            let t3 = 0;
            while (t3 < Tl) {
                const dt = yield;
                t3 += dt;
                const e = ease(t3 / Tl);
                tLeaf.surfacePoint(tUV.u, tUV.v, T, nT);
                fw.copy(D).addScaledVector(nT, -D.dot(nT));
                if (fw.lengthSq() < 1e-6) fw.copy(this._fwd);
                fw.normalize();
                basisQuat(fw, nT, q1);
                this.airQuat.slerpQuaternions(qH, q1, e);
                this.airPos.lerpVectors(pH, T, e);
                for (const leg of this.legs) this._airFoot(leg, 0.6 + 0.4 * e, leg.poseLocal);
            }
            this._landOn(tLeaf, tUV.u, tUV.v, fw, hurry ? 0.7 : 0.55);
            this._threadPin(th, tLeaf, 2, tUV.u, tUV.v);
            yield* this._wait(hurry ? 0.1 : 0.3);
            return true;
        }

        // Nothing below: reel back up and swing back over the edge
        while (len > l0) {
            const dt = yield;
            const rush = hurry || !!(this._goal && !this._goal.started);
            leaf0.surfacePoint(edge.u, edge.v, A, nA);
            len = Math.max(l0, len - dt * (rush ? 0.9 : 0.3));
            Dc.lerp(D, damp(3, dt)).normalize();
            this._hangPose(A, len, Dc, DOWN, this.airPos, this.airQuat);
            for (const leg of this.legs) this._hangFoot(leg, leg.poseLocal);
        }
        const pH = this.airPos.clone(), qH = this.airQuat.clone(), q1 = new THREE.Quaternion(), fw = new V3(), P1 = new V3(), n1 = new V3();
        const Tb = hurry ? 0.3 : 0.5;
        let t5 = 0;
        while (t5 < Tb) {
            const dt = yield;
            t5 += dt;
            const e = ease(t5 / Tb);
            leaf0.surfacePoint(inner.u, inner.v, P1, n1);
            fw.copy(D).addScaledVector(n1, -D.dot(n1)).normalize();
            basisQuat(fw, n1, q1);
            this.airQuat.slerpQuaternions(qH, q1, e);
            this.airPos.lerpVectors(pH, P1, e).addScaledVector(n1, 0.04 * Math.sin(Math.PI * e));
            for (const leg of this.legs) this._airFoot(leg, 0.7 + 0.3 * e, leg.poseLocal);
        }
        this._landOn(leaf0, inner.u, inner.v, fw, 0.3);
        th.hide();
        yield* this._wait(0.3);
        yield* this._turnToward(this._gazeRef(), { speed: 4, tol: 0.25 });
        return false;
    }

    // Hanging head-down from the spinnerets: forward along the thread, back facing D
    _hangPose(A, len, D, tdir, outPos, outQuat) {
        _k.copy(D).addScaledVector(tdir, -D.dot(tdir)).normalize();
        basisQuat(tdir, _k, outQuat);
        _l.copy(A).addScaledVector(tdir, len);
        return outPos.subVectors(_l, _i.copy(SPIN_ROOT).applyQuaternion(outQuat));
    }

    _findPrey() {
        const flies = this.flies;
        if (!flies?.findPrey || !this.leaf) return null;
        _a.copy(this._af.p).addScaledVector(this._up, 0.2);
        const fly = flies.findPrey(_a, 0.55);
        if (!fly || fly.state === 'caught' || fly.state === 'gone') return null;
        _b.subVectors(fly.position, this._af.p);
        const h = _b.dot(this._up), lat = Math.sqrt(Math.max(0, _b.lengthSq() - h * h));
        const g = this.leaf.project(fly.position);
        if (h > 0.06 && h < 0.6 && lat < 0.45 && g.u > 0.02 && g.u < 1.05 && Math.abs(g.v) < 1.2) return { fly, pounce: false };
        if (fly.state === 'landed' && Math.abs(h) < 0.05 && lat > 0.12 && lat < 0.5 && g.u > 0.1 && g.u < 0.92 && Math.abs(g.v) < 0.88) {
            return { fly, pounce: true };
        }
        return null;
    }

    _preyOk(fly) {
        return !!fly && fly.state !== 'caught' && fly.state !== 'gone' && fly.position.distanceTo(this.object.position) < 0.95;
    }

    // Track a fly, crouch, leap to intercept (or pounce on a landed one), then eat it
    *_hunt(fly, pounce) {
        const leaf0 = this.leaf;
        this._prey = fly;
        let held = false, eaten = false;
        try {
            if (pounce) {
                // Creep up on it, slowly and jerkily
                _a.subVectors(fly.position, this._af.p).addScaledVector(this._up, -_a.dot(this._up));
                const d = _a.length();
                _b.copy(fly.position).addScaledVector(_a.normalize(), -Math.min(0.17, d));
                const g = leaf0.project(_b);
                yield* this._walkTo(g.u, g.v, { speed: 0.14, tol: 0.02, maxTime: 4, until: () => !this._preyOk(fly) || fly.state !== 'landed' });
                if (!this._preyOk(fly) || fly.state !== 'landed' || this.leaf !== leaf0) return;
            }
            yield* this._turnToward(fly.position, { speed: 4.5, tol: 0.14, maxTime: 1.6 });
            this.palpMode = 'alert';
            let t = 0;
            const trackT = pounce ? rand(0.3, 0.6) : rand(0.45, 0.9);
            while (t < trackT) {
                const dt = yield;
                t += dt;
                if (!this._preyOk(fly) || this.leaf !== leaf0) return;
                const a = clamp(this._angleTo(fly.position), -3 * dt, 3 * dt);
                this._rotateHeading(a);
                this._turnRate = a / Math.max(dt, 1e-4);
                this.crouchTarget = 0.9 * sstep(0, trackT, t);
                this.crouchRate = 8;
            }
            this._turnRate = 0;
            if (!this._preyOk(fly)) return;
            if (pounce) held = yield* this._pounce(fly);
            else held = yield* this._leap(fly);
            if (held) {
                this._roamAct = false;   // eating isn't roaming: finish the meal
                this.eating = true;
                this.palpMode = 'eat';
                fly.eat?.(EAT_TIME);
                eaten = true;
                yield* this._wait(EAT_TIME + 0.25);
                this.eating = false;
                this.palpMode = 'idle';
                if (Math.random() < 0.7) yield* this._actClean();
            } else {
                this.palpMode = 'idle';
                yield* this._wait(0.4);
            }
        } finally {
            if (held && !eaten) fly.eat?.(2.5);
            this._prey = null;
            this.eating = false;
            this.palpMode = 'idle';
            this.crouchTarget = 0;
            this.crouchRate = 10;
            this._huntCD = rand(6, 12);
        }
    }

    // Leap up at a flying fly, homing in on it, then fall back to the leaf on the dragline
    *_leap(fly) {
        const leaf0 = this.leaf;
        const mouth = this.mouthPosition(new V3());
        const T1 = clamp(0.2 + 0.4 * mouth.distanceTo(fly.position), 0.22, 0.48);
        const I = fly.position.clone().addScaledVector(fly.velocity ?? ZERO, T1 * 0.8);
        const miss = Math.random() < 0.3;
        const P0 = this.object.position.clone(), q0 = this.object.quaternion.clone(), back = this._fwd.clone().negate();
        const th = this._threadStart(leaf0, this.u, this.v);
        leaf0.bounce(0.6);
        this.crouchTarget = 0;
        this.crouchRate = 30;
        this.palpMode = 'up';
        this._liftOff();
        const live = new V3(), dirI = new V3(), upI = new V3(), qI = new THREE.Quaternion(), rootI = new V3();
        let startled = false, t = 0;
        while (t < T1) {
            const dt = yield;
            t += dt;
            const s = Math.min(t / T1, 1);
            live.copy(I);
            if (!miss && this._preyOk(fly)) live.lerp(fly.position, sstep(0.35, 1, s));
            dirI.subVectors(live, P0).normalize();
            upI.copy(UP).addScaledVector(dirI, -dirI.y);
            if (upI.lengthSq() < 1e-4) upI.copy(back);
            basisQuat(dirI, upI.normalize(), qI);
            rootI.subVectors(live, _a.copy(MOUTH_ROOT).applyQuaternion(qI));
            this._arcPoint(P0, rootI, 0.03, s, this.airPos);
            this.airQuat.slerpQuaternions(q0, qI, sstep(0, 0.4, s));
            this._airLegs(Math.min(1, s * 0.5));
            if (miss && !startled && s > 0.45) { fly.startle?.(this.airPos); startled = true; }
        }
        _a.copy(MOUTH_ROOT).applyQuaternion(this.airQuat).add(this.airPos);
        let held = false;
        if (!miss && this._preyOk(fly) && _a.distanceTo(fly.position) < 0.075) {
            fly.hold(this._getMouth);
            held = true;
        } else if (!startled && this._preyOk(fly)) fly.startle?.(_a);
        // Drop back onto the leaf
        const Pc = this.airPos.clone(), qc = this.airQuat.clone();
        const g = leaf0.project(Pc), luv = leaf0.clampUV(g.u, g.v);
        const P1 = new V3(), n1 = new V3(), q1 = new THREE.Quaternion(), fw = new V3();
        leaf0.surfacePoint(luv.u, luv.v, P1, n1);
        const T2 = clamp(0.3 + 0.35 * Pc.distanceTo(P1), 0.32, 0.62);
        const face = dirI.clone().setY(0);
        if (face.lengthSq() < 1e-4) face.copy(back).negate();
        face.normalize();
        t = 0;
        while (t < T2) {
            const dt = yield;
            t += dt;
            const s = Math.min(t / T2, 1);
            leaf0.surfacePoint(luv.u, luv.v, P1, n1);
            this._arcPoint(Pc, P1, 0.025, s, this.airPos);
            fw.copy(face).addScaledVector(n1, -face.dot(n1)).normalize();
            basisQuat(fw, n1, q1);
            this.airQuat.slerpQuaternions(qc, q1, sstep(0, 0.8, s));
            this._airLegs(0.5 + 0.5 * s);
        }
        this._landOn(leaf0, luv.u, luv.v, fw, 0.9);
        this._threadPin(th, leaf0, 1.6, luv.u, luv.v);
        return held;
    }

    // Short hop onto a fly sitting on our leaf, landing with the mouth on it
    *_pounce(fly) {
        const leaf = this.leaf;
        _a.subVectors(fly.position, this._af.p).addScaledVector(this._up, -_a.dot(this._up)).normalize();
        const dir = _a.clone();
        _b.copy(fly.position).addScaledVector(dir, -0.09);
        const g = leaf.project(_b), uv = leaf.clampUV(g.u, g.v);
        this.crouchTarget = 0;
        this.crouchRate = 30;
        this.palpMode = 'up';
        yield* this._flight(leaf, uv, { T: 0.3, H: 0.05, fwd: dir, bounceUp: 0.4, bounceDown: 0.6, pitchAmt: 0.25 });
        this.mouthPosition(_a);
        if (this._preyOk(fly) && _a.distanceTo(fly.position) < 0.09) { fly.hold(this._getMouth); return true; }
        if (this._preyOk(fly)) fly.startle?.(_a);
        return false;
    }

    // Clicked: a startled hop back, then rear up with front legs raised, looking at the viewer
    *_taskPoke() {
        const leaf = this.leaf;
        this.palpMode = 'up';
        this.eyePop = 1;
        const front = [this.legs[0], this.legs[1]];
        try {
            this.crouchTarget = 0.7;
            this.crouchRate = 45;
            yield* this._wait(0.07);
            this._af.solve(_a.copy(this._fwd).multiplyScalar(-0.04), _uv1);
            const c = leaf.clampUV(this.u + _uv1.u, this.v + _uv1.v);
            this.crouchTarget = 0;
            this.crouchRate = 30;
            yield* this._flight(leaf, c, { T: 0.3, H: 0.05, fwd: this._fwd.clone(), bounceUp: 0.35, bounceDown: 0.5, thread: false, pitchAmt: 0.2 });
            this.rearTarget = 1;
            for (const leg of front) {
                this._displayFoot(leg, 0, leg.poseLocal);
                leg.ankUp = -0.15;
                leg.ankIn = 1;
                this._swing(leg, false, 0, 0, 0.12, 0.01);
            }
            const gz = this._gazeRef();
            let t = 0;
            while (t < 1.1) {
                const dt = yield;
                t += dt;
                for (const leg of front) this._displayFoot(leg, t, leg.poseLocal);
                const a = clamp(this._angleTo(gz), -6 * dt, 6 * dt);
                this._rotateHeading(a);
                this._turnRate = a / Math.max(dt, 1e-4);
            }
        } finally {
            this._turnRate = 0;
            this.rearTarget = 0;
            this.palpMode = 'idle';
            this.crouchTarget = 0;
            this.crouchRate = 10;
            if (this.mode === 'ground') for (const leg of front) if (leg.mode !== 'planted') this._replantLeg(leg, 0.14);
        }
        yield* this._wait(0.3);
    }

    _displayFoot(leg, t, out) {
        const r = leg.rest;
        return out.set(r.x * 0.75, BODY_H + 0.08 + 0.008 * Math.sin(t * 8 + leg.side), r.z * 0.75 + 0.02);
    }

    // -------------------------------------------------------------------------- ambient actions

    *_actWander() {
        const leaf = this.leaf, p = new V3(), n = new V3();
        for (let k = 0; k < 8; k++) {
            const c = leaf.clampUV(rand(0.22, 0.8), rand(-0.6, 0.6));
            leaf.surfacePoint(c.u, c.v, p, n);
            const d = p.distanceTo(this._af.p);
            if (d > 0.1 && d < 0.4) {
                yield* this._walkTo(c.u, c.v, { speed: rand(0.22, 0.34) });
                break;
            }
        }
        yield* this._wait(rand(0.3, 0.8));
        yield* this._turnToward(this._gazeRef(), { speed: 3.5, tol: 0.25 });
    }

    *_actShuffle() {
        const a = rand(0.3, 0.7) * (Math.random() < 0.5 ? -1 : 1);
        const pt = this._fwd.clone().applyAxisAngle(this._up, a).multiplyScalar(0.4).add(this._af.p);
        yield* this._turnToward(pt, { speed: 3, tol: 0.1 });
        yield* this._wait(rand(0.4, 1));
    }

    *_actLook() {
        const a = rand(0.5, 1.3) * (Math.random() < 0.5 ? -1 : 1);
        const pt = this._fwd.clone().applyAxisAngle(this._up, a).multiplyScalar(0.6).add(this._af.p).addScaledVector(this._up, rand(0, 0.3));
        this._lookOverride = pt;
        try {
            yield* this._wait(rand(0.25, 0.5));   // eyes first, then the body
            yield* this._turnToward(pt, { speed: 4, tol: 0.15 });
            yield* this._wait(rand(0.7, 1.4));
        } finally { this._lookOverride = null; }
        yield* this._wait(rand(0.3, 0.6));
        yield* this._turnToward(this._gazeRef(), { speed: 4, tol: 0.2 });
    }

    *_actPeek() {
        yield* this._turnToward(this._gazeRef(), { speed: 4, tol: 0.15 });
        this.rearTarget = 1;
        this.palpMode = 'up';
        this._rollTarget = rand(0.08, 0.16) * (Math.random() < 0.5 ? -1 : 1);   // curious head tilt
        try { yield* this._wait(rand(1, 1.8)); } finally {
            this.rearTarget = 0;
            this.palpMode = 'idle';
            this._rollTarget = 0;
        }
        yield* this._wait(0.4);
    }

    // Leg cleaning: draw a front leg through the mouthparts while the palps groom
    *_actClean() {
        const leg = this.legs[Math.random() < 0.5 ? 0 : 1];
        const base = new V3(leg.side * 0.011, BODY_H + 0.004, 0.085);
        leg.poseLocal.copy(base);
        leg.ankUp = 0.15;
        leg.ankIn = 1;
        this._swing(leg, false, 0, 0, 0.16, 0.015);
        this.palpMode = 'groom';
        let t = 0;
        const T = rand(1, 1.7);
        try {
            while (t < T) {
                const dt = yield;
                t += dt;
                leg.poseLocal.set(base.x + 0.004 * Math.sin(t * 9), base.y + 0.005 * Math.sin(t * 16), base.z + 0.01 * Math.sin(t * 8));
            }
        } finally {
            this.palpMode = 'idle';
            this._replantLeg(leg, 0.16);
        }
        yield* this._wait(0.25);
    }

    *_actHop() {
        const o = this._pickHopTarget();
        if (!o) return false;
        yield* this._jump(o.leaf, o.uv);
        yield* this._wait(rand(0.4, 0.9));
        yield* this._turnToward(this._gazeRef(), { speed: 3.5, tol: 0.25 });
        return true;
    }

    *_actSilk(dangle = false) {
        const e = this._pickDropEdge(dangle);
        if (!e) return false;
        yield* this._silkDrop({ edge: e });
        return true;
    }

    _pickHopTarget() {
        const P = this._af.p.clone(), up = this._up.clone(), opts = [];
        for (const leaf of this.plant?.leaves ?? []) {
            if (leaf === this.leaf) continue;
            const uv = leaf.clampUV(rand(0.3, 0.72), rand(-0.45, 0.45));
            const p = new V3(), n = new V3();
            leaf.surfacePoint(uv.u, uv.v, p, n);
            const d = p.distanceTo(P);
            if (d < 0.2 || d > 1.25 || n.y < 0.2) continue;
            opts.push({ leaf, uv, p, n, w: 1 / (d + 0.25) });
        }
        while (opts.length) {
            let r = Math.random() * opts.reduce((s, o) => s + o.w, 0), k = 0;
            while (k < opts.length - 1 && (r -= opts[k].w) > 0) k++;
            const o = opts.splice(k, 1)[0];
            if (!this._planJump(P, up, o.p, o.n, this.leaf, o.leaf, false).blocked) return o;
        }
        return null;
    }

    _pickDropEdge(dangle = false) {
        const leaf = this.leaf, P = this._af.p, cands = [], E = new V3(), nE = new V3(), o = new V3();
        for (const e of EDGE_SAMPLES) {
            leaf.surfacePoint(e.u, e.v, E, nE);
            if (E.distanceTo(P) > 0.5) continue;
            this._edgeOut(leaf, e.u, e.v, o).setY(0);
            if (o.lengthSq() < 1e-4) continue;
            o.normalize();
            const below = dangle ? null : this._rayLeaf(E.clone().addScaledVector(o, 0.02).addScaledVector(UP, -0.06), DOWN, 1.3, leaf);
            if (below && E.y - below.point.y < 0.3) continue;   // too short a drop to bother
            cands.push({ u: e.u, v: e.v, below });
        }
        if (!cands.length) return null;
        if (dangle) return pick(cands);
        const good = cands.filter(c => c.below);
        if (good.length && Math.random() < 0.85) return pick(good);
        return Math.random() < 0.5 ? { ...pick(cands), below: null } : null;
    }

    // Dev helper for the test page: run one named action now (if grounded)
    _debugAction(name, arg) {
        if (this.mode !== 'ground' || !this.leaf || this._goal) return false;
        const self = this;
        const acts = {
            hop: () => self._actHop(), silk: () => self._actSilk(), dangle: () => self._actSilk(true),
            clean: () => self._actClean(), look: () => self._actLook(), peek: () => self._actPeek(),
            wander: () => self._actWander(), hunt: () => self._hunt(arg, arg?.state === 'landed'),
        };
        if (!acts[name] || (name === 'hunt' && !arg?.position)) return false;
        this._abortTask();
        this._task = (function* () { yield* acts[name](); })();
        this._taskName = 'debug';
        return true;
    }
}

function dirYP(yaw, pitch, out) {
    return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
}
