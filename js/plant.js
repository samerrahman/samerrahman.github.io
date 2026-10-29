// Low-poly Alocasia ('Polly' / 'Frydek') on a mossy mound, implementing the Plant and Leaf API from
// dev/CONTRACT.md. Each blade is a coarse faceted grid sampled from a smooth leaf shape; localPoint()
// interpolates the grid exactly the way its triangles do, so surfacePoint() and project() match
// what is rendered, while outNormal is interpolated from vertex normals so it doesn't jump at facet
// edges. Flat shading and per-face vertex colours from a small palette; no textures except the
// soft mushroom glow sprite.
import * as THREE from 'three';

const VIEW = new THREE.Vector3(0, 2.75, 5.6); // default camera: section leaves are turned toward it

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};

// Palette (sRGB)
const PAL = {
    leafDark: 0x17432a, leafMid: 0x215c37, vein: 0xcfe7ba, rim: 0xaed29a, under: 0x7fb27a,
    stemBase: 0x625f35, stemLow: 0x36662d, stemTop: 0x5f9a42,
    moss: [0x37612a, 0x2b5223, 0x21431d, 0x172f16], grass: 0x23491f, grassTip: 0x6f9f3f, lime: 0xb8e05c,
    rock: 0x5f665a, rockDark: 0x3b4038, rockMoss: 0x3f6b2b, fern: 0x24501f, fernTip: 0x5a9537,
    shroomStem: 0x9fc4b0, shroomCap: 0x2f6f60, shroomGill: 0x9fe8c8, shroomGlow: 0x5dffb5,
};
const col = hex => new THREE.Color(hex);

// Scratch objects for hot paths (surfacePoint, project, update)
const _pp = new THREE.Vector3();
const _pP = new THREE.Vector3();
const _pDu = new THREE.Vector3();
const _pDv = new THREE.Vector3();
const _ln = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _nm = new THREE.Matrix3();
const _cell = { i: 0, j: 0, s: 0, t: 0 };
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------------------------
// Smooth leaf shape (only used to place the grid vertices). Planform in normalised units: x along
// the midrib in lengths, z across in half-widths. Constant-u lines sweep back toward the margin, so
// u = 0 is the sinus edge and the basal lobes reach behind the petiole attachment.

const LOBE_BACK = 0.32; // lobe tips sit this far behind the attachment (fraction of length)
const SWEEP_E = 0.2; // rounds the sinus apex
const SWEEP_N = Math.sqrt(1 + SWEEP_E * SWEEP_E) - SWEEP_E;
const DROOP_P = 2.2; // midrib droop exponent: flat near the petiole, bending toward the tip
const CREASE_E = 0.12; // softness of the midrib groove

const outlineRaw = u => Math.pow(Math.max(1 - u, 0), 0.85) * (0.5 + 3.0 * u - 3.2 * u * u);
const OUTLINE_MAX = (() => {
    let m = 0;
    for (let i = 0; i <= 1000; i++) m = Math.max(m, outlineRaw(i / 1000));
    return m;
})();
const outline = u => outlineRaw(clamp(u, 0, 1)) / OUTLINE_MAX; // widest point = 1
const marginX = u => u - LOBE_BACK * (1 - u) ** 3; // x of the margin at u
const sweep = a => (Math.sqrt(a * a + SWEEP_E * SWEEP_E) - SWEEP_E) / SWEEP_N;

// Blade grid. Two thin columns make the pale midrib, the outermost ones the pale rim.
const U_GRID = [0, 0.05, 0.11, 0.18, 0.26, 0.35, 0.44, 0.53, 0.62, 0.71, 0.8, 0.9, 1];
const V_GRID = [-1, -0.93, -0.6, -0.27, -0.055, 0.055, 0.27, 0.6, 0.93, 1];
const NU = U_GRID.length - 1;
const NV = V_GRID.length - 1;
const COLS = NV + 1;
const MIDRIB_CELL = 4;

// Lateral and basal veins as (u, v) polylines on the v > 0 half (mirrored for v < 0)
const VEINS = (() => {
    const veins = [{ pts: [[0.0, 0.055], [0.03, 0.3], [0.05, 0.52], [0.04, 0.72], [0.014, 0.93]], w0: 0.016, w1: 0.007 }];
    [[0.06, 0.25], [0.2, 0.42], [0.35, 0.59], [0.5, 0.75]].forEach(([u0, u1]) => {
        const pts = [];
        for (let k = 0; k <= 4; k++) {
            const f = k / 4;
            pts.push([u0 + (u1 - u0) * Math.pow(f, 1.6), 0.055 + 0.875 * f]); // ends on the pale rim
        }
        veins.push({ pts, w0: 0.016, w1: 0.006 });
    });
    return veins;
})();

// ---------------------------------------------------------------------------------------------
// Layout. yaw: heading of the midrib (0 = toward the camera, +90 = +X); pitch: tilt of the midrib
// at the petiole (+ = tip down); face: how far the upper face is turned from "up" toward the
// default camera; roll: extra twist about the midrib (degrees).

const LEAF_SPECS = [
    { section: 'about', attach: [0.03, 1.78, 0.16], yaw: 180, pitch: -28, face: 1, roll: 0,
        length: 0.94, halfWidth: 0.39, droop: 0.2 },
    { section: 'research', attach: [-0.28, 1.6, -0.12], yaw: -75, pitch: 3, face: 0.55, roll: 0,
        length: 1.0, halfWidth: 0.41, droop: 0.22 },
    { section: 'games', attach: [0.33, 1.72, -0.22], yaw: 79, pitch: 7, face: 0.55, roll: 0,
        length: 1.03, halfWidth: 0.42, droop: 0.23 },
    { section: 'tools', attach: [-0.31, 0.98, -0.06], yaw: -66, pitch: 15, face: 0.6, roll: 0,
        length: 1.03, halfWidth: 0.43, droop: 0.25 },
    { section: 'contact', attach: [0.33, 0.84, -0.14], yaw: 70, pitch: 7, face: 0.62, roll: 0,
        length: 1.0, halfWidth: 0.41, droop: 0.2 },
    // decorative: two rising behind (their lighter undersides fill the gaps up top), three low
    { section: null, attach: [-0.3, 1.36, -0.36], yaw: -132, pitch: -40, face: 0, roll: 0,
        length: 0.95, halfWidth: 0.38, droop: 0.24, shade: 0.9 },
    { section: null, attach: [0.3, 1.18, -0.36], yaw: 128, pitch: -36, face: 0, roll: 0,
        length: 0.92, halfWidth: 0.37, droop: 0.24, shade: 0.9 },
    { section: null, attach: [-0.12, 0.54, 0.2], yaw: -20, pitch: 21, face: 0.5, roll: 0,
        length: 0.86, halfWidth: 0.35, droop: 0.24, shade: 0.95 },
    { section: null, attach: [0.36, 0.4, -0.08], yaw: 108, pitch: 13, face: 0.4, roll: 0,
        length: 0.82, halfWidth: 0.33, droop: 0.24, shade: 0.95 },
    { section: null, attach: [-0.36, 0.44, -0.12], yaw: -120, pitch: 14, face: 0.3, roll: 0,
        length: 0.84, halfWidth: 0.34, droop: 0.26, shade: 0.92 },
];

const SPRING_K = 90; // bounce spring stiffness
const SPRING_C = 7; // bounce damping

function leafOrientation(attach, spec) {
    const deg = THREE.MathUtils.degToRad;
    const yaw = deg(spec.yaw), pitch = deg(spec.pitch);
    const f = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const toCam = VIEW.clone().sub(attach).normalize();
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(f, -f.y).normalize();
    const cam = toCam.clone().addScaledVector(f, -f.dot(toCam)).normalize();
    const n = up.multiplyScalar(1 - spec.face).addScaledVector(cam, spec.face).normalize();
    if (spec.roll) n.applyAxisAngle(f, deg(spec.roll));
    const s = new THREE.Vector3().crossVectors(f, n).normalize();
    n.crossVectors(s, f).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f, n, s));
}

// Locate (u, v) in the grid: cell indices and local coordinates (outside [0, 1] beyond the edges)
function locate(u, v, out) {
    let i = 0, j = 0;
    while (i < NU - 1 && u >= U_GRID[i + 1]) i++;
    while (j < NV - 1 && v >= V_GRID[j + 1]) j++;
    out.i = i;
    out.j = j;
    out.s = (u - U_GRID[i]) / (U_GRID[i + 1] - U_GRID[i]);
    out.t = (v - V_GRID[j]) / (V_GRID[j + 1] - V_GRID[j]);
    return out;
}

// ---------------------------------------------------------------------------------------------
// Leaf

class Leaf {
    constructor(id, spec, material) {
        this.id = id;
        this.section = spec.section ?? null;
        this.length = spec.length;
        this.halfWidth = spec.halfWidth;
        this.center = { u: spec.center?.[0] ?? 0.45, v: spec.center?.[1] ?? 0 };

        // Shape: midrib droop, groove along it, margin curl, crinkled margin, lobe droop
        this.droop = spec.droop ?? 0.22;
        this.crease = spec.crease ?? 0.14;
        this.curl = spec.curl ?? 0.2;
        this.crinkle = spec.crinkle ?? 0.045;
        this.lobeDroop = spec.lobeDroop ?? 0.35;
        this._arc = (this.droop * DROOP_P) ** 2 / (2 * (2 * DROOP_P - 1)); // keeps the midrib length
        this._labelUV = spec.label ?? [0.72, 0];

        this._dip = 0; // bounce spring angle (rad), positive dips the blade
        this._dipVel = 0;
        this._glow = 0;
        this._glowTarget = 0;
        this._phase = spec.phase ?? id * 1.37 + 0.4;
        this._swayAmp = 0.6 + 0.4 * Math.min(spec.attach[1] / 1.8, 1.2);

        // Grid vertices (leaf-local) and smooth vertex normals
        this._g = new Float32Array((NU + 1) * COLS * 3);
        this._n = new Float32Array((NU + 1) * COLS * 3);
        this._buildGrid();

        this.material = material;
        this.mesh = new THREE.Mesh(buildLeafGeometry(this, spec.shade ?? 1, id), material);
        this.mesh.name = `leaf-${this.section ?? id}`;
        this.mesh.castShadow = true;
        this.mesh.receiveShadow = true;
        this.mesh.userData.leaf = this;
        this.mesh.position.fromArray(spec.attach);
        this.baseQuat = leafOrientation(this.mesh.position, spec);
        this.mesh.quaternion.copy(this.baseQuat);
    }

    // Smooth shape the grid is sampled from; `zig` alternates per grid row to crinkle the margin
    _shape(u, v, zig, out) {
        const L = this.length, hw = this.halfWidth, a = Math.abs(v);
        const W = outline(u);
        const X = (u + (marginX(u) - u) * sweep(a)) * L;
        const Z = v * W * hw;
        let bx, by, sl; // bent midrib: droop ahead of the petiole, lobes hang a little behind it
        if (X >= 0) {
            const t = X / L, tp = Math.pow(t, DROOP_P - 1);
            by = -this.droop * L * tp * t;
            sl = -this.droop * DROOP_P * tp;
            bx = X - this._arc * L * Math.pow(t, 2 * DROOP_P - 1);
        } else {
            const t = X / L;
            by = -this.lobeDroop * L * t * t;
            sl = -2 * this.lobeDroop * t;
            bx = X;
        }
        const cross = W * (this.crease * (Math.sqrt(v * v + CREASE_E * CREASE_E) - CREASE_E) - this.curl * a * a * a);
        const crinkle = zig * this.crinkle * Math.min(1, 3 * W) * smoothstep(0.8, 1, a);
        const h = hw * (cross + crinkle);
        const inv = 1 / Math.sqrt(1 + sl * sl);
        return out.set(bx - sl * inv * h, by + inv * h, Z);
    }

    _buildGrid() {
        const P = new THREE.Vector3();
        for (let i = 0; i <= NU; i++) {
            for (let j = 0; j <= NV; j++) {
                this._shape(U_GRID[i], V_GRID[j], i % 2 ? 1 : -1, P);
                P.toArray(this._g, (i * COLS + j) * 3);
            }
        }
        // Vertex normals: area-weighted face normals of the rendered triangles
        const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
        const add = (ia, ib, ic) => {
            A.fromArray(this._g, ia * 3);
            B.fromArray(this._g, ib * 3);
            C.fromArray(this._g, ic * 3);
            N.crossVectors(B.sub(A), C.sub(A));
            for (const k of [ia, ib, ic]) {
                this._n[k * 3] += N.x;
                this._n[k * 3 + 1] += N.y;
                this._n[k * 3 + 2] += N.z;
            }
        };
        forEachTriangle(add);
        for (let k = 0; k < this._n.length; k += 3) {
            N.fromArray(this._n, k).normalize().toArray(this._n, k);
        }
    }

    widthAt(u) {
        return this.localPoint(clamp(u, 0, 1), 1, _w).z;
    }

    // Leaf-local point on the rendered (faceted) blade: +X along the midrib, +Y out of the upper
    // face, +Z across (v > 0). Linear continuation of the edge triangles outside the blade.
    localPoint(u, v, out) {
        const { i, j, s, t } = locate(u, v, _cell), g = this._g;
        const a = (i * COLS + j) * 3, a1 = a + 3, b = a + COLS * 3, b1 = b + 3;
        for (let k = 0; k < 3; k++) {
            let x;
            if (i === NU - 1) x = (1 - s) * ((1 - t) * g[a + k] + t * g[a1 + k]) + s * g[b + k]; // tip fan
            else if (s + t <= 1) x = g[a + k] + s * (g[b + k] - g[a + k]) + t * (g[a1 + k] - g[a + k]);
            else x = g[b1 + k] + (1 - s) * (g[a1 + k] - g[b1 + k]) + (1 - t) * (g[b + k] - g[b1 + k]);
            out.setComponent(k, x);
        }
        return out;
    }

    // Smooth local normal: bilinear blend of the cell's vertex normals
    _localNormal(u, v, out) {
        const { i, j } = locate(u, v, _cell), n = this._n;
        const s = clamp(_cell.s, 0, 1), t = clamp(_cell.t, 0, 1);
        const a = (i * COLS + j) * 3, a1 = a + 3, b = a + COLS * 3, b1 = b + 3;
        for (let k = 0; k < 3; k++) {
            out.setComponent(k, (1 - s) * ((1 - t) * n[a + k] + t * n[a1 + k]) + s * ((1 - t) * n[b + k] + t * n[b1 + k]));
        }
        return out.normalize();
    }

    surfacePoint(u, v, outPos = new THREE.Vector3(), outNormal = new THREE.Vector3()) {
        const m = this.mesh.matrixWorld;
        this._localNormal(u, v, outNormal).applyMatrix3(_nm.getNormalMatrix(m)).normalize();
        return this.localPoint(u, v, outPos).applyMatrix4(m);
    }

    // Inverse of surfacePoint: closest point on the faceted surface. Starts at the nearest grid
    // vertex, then Gauss-Newton steps on the triangle under the iterate (exact within a triangle),
    // halved until the distance drops so it can't bounce between facets.
    project(worldPos, out = { u: 0, v: 0 }) {
        const p = this.mesh.worldToLocal(_pp.copy(worldPos)), g = this._g;
        let best = Infinity, u = 0, v = 0;
        for (let k = 0; k < g.length; k += 3) {
            const d = (g[k] - p.x) ** 2 + (g[k + 1] - p.y) ** 2 + (g[k + 2] - p.z) ** 2;
            if (d < best) {
                best = d;
                u = U_GRID[Math.floor(k / 3 / COLS)];
                v = V_GRID[(k / 3) % COLS];
            }
        }
        let res = this.localPoint(u, v, _pP).distanceToSquared(p);
        for (let k = 0; k < 16 && res > 1e-14; k++) {
            this._jacobian(u, v, _pDu, _pDv);
            _pP.subVectors(p, _pP);
            const a11 = _pDu.dot(_pDu), a12 = _pDu.dot(_pDv), a22 = _pDv.dot(_pDv);
            const b1 = _pDu.dot(_pP), b2 = _pDv.dot(_pP);
            const lam = 1e-6 * (a11 + a22) + 1e-12;
            const det = (a11 + lam) * (a22 + lam) - a12 * a12;
            const du = clamp(((a22 + lam) * b1 - a12 * b2) / det, -0.3, 0.3);
            const dv = clamp(((a11 + lam) * b2 - a12 * b1) / det, -0.6, 0.6);
            let step = 1, moved = false;
            for (; step > 1 / 64; step *= 0.5) {
                const nu = clamp(u + du * step, -0.4, 1.4), nv = clamp(v + dv * step, -1.6, 1.6);
                const r = this.localPoint(nu, nv, _pP).distanceToSquared(p);
                if (r < res) {
                    u = nu;
                    v = nv;
                    res = r;
                    moved = true;
                    break;
                }
            }
            if (!moved) break;
            this.localPoint(u, v, _pP);
            if ((Math.abs(du) + Math.abs(dv)) * step < 1e-7) break;
        }
        out.u = u;
        out.v = v;
        return out;
    }

    // ∂P/∂u and ∂P/∂v of the triangle under (u, v)
    _jacobian(u, v, Du, Dv) {
        const { i, j, s, t } = locate(u, v, _cell), g = this._g;
        const a = (i * COLS + j) * 3, a1 = a + 3, b = a + COLS * 3, b1 = b + 3;
        const hu = U_GRID[i + 1] - U_GRID[i], hv = V_GRID[j + 1] - V_GRID[j];
        for (let k = 0; k < 3; k++) {
            let ds, dt;
            if (i === NU - 1) {
                ds = g[b + k] - ((1 - t) * g[a + k] + t * g[a1 + k]);
                dt = (1 - s) * (g[a1 + k] - g[a + k]);
            } else if (s + t <= 1) {
                ds = g[b + k] - g[a + k];
                dt = g[a1 + k] - g[a + k];
            } else {
                ds = g[b1 + k] - g[a1 + k];
                dt = g[b1 + k] - g[b + k];
            }
            Du.setComponent(k, ds / hu);
            Dv.setComponent(k, dt / hv);
        }
    }

    clampUV(u, v, out = { u: 0, v: 0 }) {
        out.u = clamp(u, 0.12, 0.9);
        out.v = clamp(v, -0.85, 0.85);
        return out;
    }

    labelAnchor(out = new THREE.Vector3()) {
        this.surfacePoint(this._labelUV[0], this._labelUV[1], out, _ln);
        return out.addScaledVector(_ln, 0.1);
    }

    bounce(strength) {
        this._dipVel += strength;
    }

    setHighlight(a) {
        this._glowTarget = clamp(a, 0, 1);
    }

    update(dt, t, gust = 1) {
        // Bounce: damped spring on the dip angle about the attachment (semi-implicit Euler)
        this._dipVel += (-SPRING_K * this._dip - SPRING_C * this._dipVel) * dt;
        this._dip = clamp(this._dip + this._dipVel * dt, -0.4, 0.4);
        // Sway: incommensurate sines per leaf under a shared gust envelope
        const ph = this._phase, amp = this._swayAmp * gust;
        const nod = amp * (0.016 * Math.sin(t * 0.83 + ph) + 0.007 * Math.sin(t * 1.91 + ph * 2.3));
        const twist = amp * 0.012 * Math.sin(t * 0.67 + ph * 1.7);
        _q.setFromAxisAngle(AXIS_Z, -(this._dip + nod));
        _q2.setFromAxisAngle(AXIS_X, twist);
        this.mesh.quaternion.copy(this.baseQuat).multiply(_q).multiply(_q2);
        // Hover glow eases toward its target
        this._glow += (this._glowTarget - this._glow) * (1 - Math.exp(-dt * 14));
        this.material.userData.glow.value = this._glow;
    }
}

// Visit the blade's triangles as grid-vertex indices, wound so the upper face (+Y) is the front
// face. The tip row collapses to a fan.
function forEachTriangle(fn) {
    for (let i = 0; i < NU; i++) {
        for (let j = 0; j < NV; j++) {
            const a = i * COLS + j, b = a + COLS;
            fn(a, a + 1, b, i, j);
            if (i < NU - 1) fn(a + 1, b + 1, b, i, j);
        }
    }
}

function buildLeafGeometry(leaf, shade, seed) {
    const pos = [], nor = [], cols = [];
    const rand = rng(1000 + seed * 17);
    const dark = col(PAL.leafDark), mid = col(PAL.leafMid), vein = col(PAL.vein), rim = col(PAL.rim);
    const c = new THREE.Color();
    const g = leaf._g, n = leaf._n;
    const push = (k, color) => {
        pos.push(g[k * 3], g[k * 3 + 1], g[k * 3 + 2]);
        nor.push(n[k * 3], n[k * 3 + 1], n[k * 3 + 2]);
        cols.push(color.r, color.g, color.b);
    };
    // Blade: lamina greener toward the midrib, a little per-face variation; pale midrib and rim
    forEachTriangle((ia, ib, ic, i, j) => {
        if (j === MIDRIB_CELL) c.copy(vein);
        else if (j === 0 || j === NV - 1) c.copy(rim);
        else {
            const vc = Math.abs((V_GRID[j] + V_GRID[j + 1]) / 2);
            const uc = (U_GRID[i] + U_GRID[i + 1]) / 2;
            c.copy(dark).lerp(mid, (1 - vc) * 0.8 + 0.2 * (1 - uc)).multiplyScalar(shade * (0.92 + rand() * 0.16));
        }
        push(ia, c);
        push(ib, c);
        push(ic, c);
    });

    // Veins: thin pale strips lying just above the facets. Each path is split wherever it crosses
    // a facet edge, so every piece sits over one flat triangle and the lift keeps it on top.
    const P = new THREE.Vector3(), N = new THREE.Vector3(), T = new THREE.Vector3(), S = new THREE.Vector3();
    const Q = new THREE.Vector3(), R = new THREE.Vector3();
    const LIFT = 0.003 * leaf.length;
    for (const vn of VEINS) {
        for (const side of [-1, 1]) {
            const path = splitOnFacets(vn.pts.map(([u, v]) => [u, side * v]));
            const ring = [];
            path.forEach(([u, v, f, du, dv]) => {
                leaf.localPoint(u + du * 0.01, v + dv * 0.01, Q);
                leaf.localPoint(u - du * 0.01, v - dv * 0.01, R);
                T.subVectors(Q, R).normalize();
                leaf.localPoint(u, v, P);
                leaf._localNormal(u, v, N);
                S.crossVectors(N, T).normalize();
                const w = lerp(vn.w0, vn.w1, f) * leaf.length * 0.5;
                P.addScaledVector(N, LIFT);
                ring.push([P.clone().addScaledVector(S, w), P.clone().addScaledVector(S, -w), N.clone()]);
            });
            for (let k = 0; k < ring.length - 1; k++) {
                const [l0, r0, n0] = ring[k], [l1, r1, n1] = ring[k + 1];
                // with S = N × T on the left, (l0, r0, l1) and (r0, r1, l1) face along +N
                for (const tri of [[l0, r0, l1], [r0, r1, l1]]) {
                    for (const p of tri) {
                        pos.push(p.x, p.y, p.z);
                        const nn = p === l0 || p === r0 ? n0 : n1;
                        nor.push(nn.x, nn.y, nn.z);
                        cols.push(vein.r, vein.g, vein.b);
                    }
                }
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeBoundingSphere();
    return geo;
}

// Insert points where a (u, v) polyline crosses grid lines or cell diagonals (the facet edges).
// Returns [u, v, fraction along the path, du, dv] with (du, dv) the segment direction.
function splitOnFacets(pts) {
    const segs = [];
    let total = 0;
    for (let k = 0; k < pts.length - 1; k++) {
        const len = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
        segs.push(len);
        total += len;
    }
    const out = [];
    let acc = 0;
    for (let k = 0; k < pts.length - 1; k++) {
        const [u0, v0] = pts[k], [u1, v1] = pts[k + 1], du = u1 - u0, dv = v1 - v0;
        const ts = [0];
        const cross = (a, d, grid) => {
            for (const g of grid) {
                const t = (g - a) / d;
                if (d && t > 1e-6 && t < 1 - 1e-6) ts.push(t);
            }
        };
        cross(u0, du, U_GRID);
        cross(v0, dv, V_GRID);
        for (let i = 0; i < NU - 1; i++) { // diagonals s + t = 1 (the tip row is a fan)
            const hu = U_GRID[i + 1] - U_GRID[i];
            for (let j = 0; j < NV; j++) {
                const hv = V_GRID[j + 1] - V_GRID[j], den = du / hu + dv / hv;
                if (!den) continue;
                const t = (1 - (u0 - U_GRID[i]) / hu - (v0 - V_GRID[j]) / hv) / den;
                const s = (u0 + du * t - U_GRID[i]) / hu;
                if (t > 1e-6 && t < 1 - 1e-6 && s >= 0 && s <= 1) ts.push(t);
            }
        }
        ts.sort((a, b) => a - b);
        const l = segs[k] || 1;
        for (const t of ts) out.push([u0 + du * t, v0 + dv * t, (acc + t * segs[k]) / total, du / l, dv / l]);
        acc += segs[k];
    }
    const [ue, ve] = pts[pts.length - 1], last = out[out.length - 1];
    out.push([ue, ve, 1, last[3], last[4]]);
    return out;
}

// Matte, flat-shaded, double-sided; lighter underside, lime hover glow (veins first, then a rim)
const LEAF_UNIFORMS = {
    uUnder: { value: col(PAL.under) },
    uGlowColor: { value: col(PAL.lime) },
};

function makeLeafMaterial() {
    const glow = { value: 0 };
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    });
    mat.userData.glow = glow;
    mat.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, LEAF_UNIFORMS);
        shader.uniforms.uGlow = glow;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uGlow;\nuniform vec3 uUnder;\nuniform vec3 uGlowColor;')
            .replace('#include <color_fragment>', `#include <color_fragment>
                float veinMask = smoothstep(0.15, 0.45, dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
                if (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, uUnder, 0.6);`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
                float glowRim = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.0);
                totalEmissiveRadiance += uGlowColor * uGlow * (0.035 + 0.5 * veinMask + 0.14 * glowRim);`);
    };
    return mat;
}

// ---------------------------------------------------------------------------------------------
// Procedural helpers: seeded random, value noise, a small geometry builder

function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash3(x, y, z) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y, z = 0) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
    const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), ux), x10 = lerp(c(0, 1, 0), c(1, 1, 0), ux);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), ux), x11 = lerp(c(0, 1, 1), c(1, 1, 1), ux);
    return lerp(lerp(x00, x10, uy), lerp(x01, x11, uy), uz);
}

// Flat-shaded triangle soup with per-vertex colour (+ optional alpha and glow)
class TriBuilder {
    constructor({ alpha = false, glow = false } = {}) {
        this.p = [];
        this.n = [];
        this.c = [];
        this.alpha = alpha;
        this.g = glow ? [] : null;
    }
    // Counter-clockwise seen from the front. Colours: THREE.Color, optional alpha / glow per vertex.
    tri(a, b, c, ca, cb = ca, cc = ca, { alpha = [1, 1, 1], glow = [0, 0, 0] } = {}) {
        const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        [a, b, c].forEach((p, k) => {
            const cl = [ca, cb, cc][k];
            this.p.push(p.x, p.y, p.z);
            this.n.push(nx, ny, nz);
            this.c.push(cl.r, cl.g, cl.b);
            if (this.alpha) this.c.push(alpha[k]);
            if (this.g) this.g.push(glow[k]);
        });
    }
    quad(a, b, c, d, ca, cb = ca, cc = ca, cd = ca, opts) { // a-b-c-d counter-clockwise
        this.tri(a, b, c, ca, cb, cc, opts && { alpha: [opts.alpha[0], opts.alpha[1], opts.alpha[2]], glow: [opts.glow[0], opts.glow[1], opts.glow[2]] });
        this.tri(a, c, d, ca, cc, cd, opts && { alpha: [opts.alpha[0], opts.alpha[2], opts.alpha[3]], glow: [opts.glow[0], opts.glow[2], opts.glow[3]] });
    }
    build() {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(this.c, this.alpha ? 4 : 3));
        if (this.g) geo.setAttribute('glow', new THREE.Float32BufferAttribute(this.g, 1));
        geo.computeBoundingSphere();
        return geo;
    }
}

// ---------------------------------------------------------------------------------------------
// Petioles: six-sided tapered stalks from the mound to each blade, joined under the sinus

function buildPetioles(leaves) {
    const b = new TriBuilder();
    const up = new THREE.Vector3(0, 1, 0);
    const cBase = col(PAL.stemBase), cLow = col(PAL.stemLow), cTop = col(PAL.stemTop);
    const SEG = 11, SIDES = 6;
    leaves.forEach((leaf, k) => {
        const A = leaf.mesh.position.clone();
        const f = AXIS_X.clone().applyQuaternion(leaf.baseQuat);
        const n = new THREE.Vector3(0, 1, 0).applyQuaternion(leaf.baseQuat);
        const d = up.clone().multiplyScalar(0.75).addScaledVector(f, 0.45).addScaledVector(n, 0.3).normalize();
        const ang = Math.atan2(A.z, A.x) + Math.sin(k * 2.1) * 0.3;
        const B0 = new THREE.Vector3(Math.cos(ang) * 0.05, -0.03, Math.sin(ang) * 0.05);
        const span = A.distanceTo(B0);
        const out = new THREE.Vector3(A.x, 0, A.z).normalize();
        const P1 = B0.clone().addScaledVector(up, 0.38 * (A.y - B0.y)).addScaledVector(out, 0.06);
        const P2 = A.clone().addScaledVector(d, -0.36 * span);
        const pts = [], rad = [], cs = [];
        const rBase = 0.03 + 0.004 * leaf.length, rTip = 0.012 * leaf.length;
        for (let i = 0; i <= SEG; i++) {
            const t = i / SEG, s = 1 - t;
            pts.push(new THREE.Vector3()
                .addScaledVector(B0, s * s * s).addScaledVector(P1, 3 * s * s * t)
                .addScaledVector(P2, 3 * s * t * t).addScaledVector(A, t * t * t));
            rad.push(lerp(rBase, rTip, Math.pow(t, 0.7)) * (i === SEG ? 0.5 : 1));
            cs.push(t < 0.1 ? cBase.clone().lerp(cLow, t / 0.1) : cLow.clone().lerp(cTop, Math.pow((t - 0.1) / 0.9, 0.8)));
        }
        addTube(b, pts, rad, cs, SIDES, k * 0.7);
    });
    const mesh = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0,
    }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'petioles';
    return mesh;
}

// Faceted tube along a polyline (parallel-transport frames)
function addTube(b, pts, radius, colors, sides, twist = 0) {
    const n = pts.length;
    const T = new THREE.Vector3(), N = new THREE.Vector3(0, 0, 1), B = new THREE.Vector3();
    const rings = [];
    for (let i = 0; i < n; i++) {
        T.subVectors(pts[Math.min(i + 1, n - 1)], pts[Math.max(i - 1, 0)]).normalize();
        if (i === 0 && Math.abs(T.z) > 0.9) N.set(1, 0, 0);
        N.addScaledVector(T, -N.dot(T)).normalize();
        B.crossVectors(T, N);
        const ring = [];
        for (let j = 0; j < sides; j++) {
            const th = (j / sides) * Math.PI * 2 + twist;
            ring.push(pts[i].clone().addScaledVector(N, Math.cos(th) * radius[i]).addScaledVector(B, Math.sin(th) * radius[i]));
        }
        rings.push(ring);
    }
    for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < sides; j++) {
            const j1 = (j + 1) % sides;
            b.quad(rings[i][j], rings[i][j1], rings[i + 1][j1], rings[i + 1][j], colors[i], colors[i], colors[i + 1], colors[i + 1]);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Ground: faceted mossy mound fading into the background, plus rocks, grass, ferns, mushrooms

const MOUND_RINGS = [0, 0.22, 0.48, 0.78, 1.1, 1.46, 1.86, 2.3];
const FADE_IN = 1.0, FADE_OUT = 2.15;

function moundHeight(x, z) {
    const r2 = x * x + z * z;
    const lumps = (vnoise(x * 2.3 + 7.3, z * 2.3 - 2.1) - 0.5) * 0.05;
    return 0.14 * Math.exp(-r2 / 0.5) + lumps * Math.exp(-r2 / 1.4);
}

function buildMound() {
    const SEGS = 22, rand = rng(4);
    const b = new TriBuilder({ alpha: true });
    const verts = MOUND_RINGS.map((r, k) => {
        const ring = [];
        for (let j = 0; j < SEGS; j++) {
            const th = ((j + (k % 2) * 0.5 + (k ? (rand() - 0.5) * 0.5 : 0)) / SEGS) * Math.PI * 2;
            const rr = r * (k ? 0.94 + rand() * 0.12 : 0);
            const x = rr * Math.cos(th), z = rr * Math.sin(th);
            ring.push(new THREE.Vector3(x, moundHeight(x, z), z));
        }
        return ring;
    });
    const stops = PAL.moss.map(col), c = new THREE.Color();
    const shade = p => {
        const t = Math.hypot(p.x, p.z) / 2.3 * (stops.length - 1), i = Math.min(Math.floor(t), stops.length - 2);
        return c.copy(stops[i]).lerp(stops[i + 1], t - i).multiplyScalar(0.92 + rand() * 0.16).clone();
    };
    const alpha = p => 1 - smoothstep(FADE_IN, FADE_OUT, Math.hypot(p.x, p.z));
    for (let k = 0; k < MOUND_RINGS.length - 1; k++) {
        for (let j = 0; j < SEGS; j++) {
            const j1 = (j + 1) % SEGS;
            const a = verts[k][j], a1 = verts[k][j1], o = verts[k + 1][j], o1 = verts[k + 1][j1];
            // wound counter-clockwise seen from above (+Y up)
            const t1 = [a, a1, o], t2 = [a1, o1, o];
            for (const t of k ? [t1, t2] : [t2]) {
                const m = new THREE.Vector3().add(t[0]).add(t[1]).add(t[2]).divideScalar(3);
                b.tri(t[0], t[1], t[2], shade(m), undefined, undefined, { alpha: t.map(alpha), glow: [0, 0, 0] });
            }
        }
    }
    const mesh = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, transparent: true,
    }));
    mesh.receiveShadow = true;
    mesh.renderOrder = -1; // first among transparent objects so glows drawn later stay visible
    mesh.name = 'mound';
    return mesh;
}

// Decoration spots (x, z, size); grass keeps clear of rocks
const ROCKS = [[-0.68, 0.44, 0.15], [0.76, 0.22, 0.12], [0.32, 0.82, 0.08], [-0.36, -0.64, 0.12], [1.02, -0.42, 0.09]];
const FERNS = [[-0.98, 0.04, 0.34], [0.94, 0.62, 0.28], [0.56, -0.78, 0.32], [-0.92, -0.58, 0.28]];
const MUSHROOMS = [ // x, z, stem height, cap radius
    [-0.5, 0.62, 0.1, 0.055], [-0.41, 0.68, 0.065, 0.038], [-0.58, 0.7, 0.045, 0.028],
    [0.6, 0.44, 0.085, 0.048], [0.69, 0.4, 0.05, 0.032],
    [0.14, 0.96, 0.055, 0.034], [-0.14, -0.62, 0.075, 0.04],
];

function buildDecor() {
    const b = new TriBuilder();
    const rand = rng(77);
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    // Rocks: lumpy low-poly icosahedrons with mossy tops
    const rock = col(PAL.rock), rockDark = col(PAL.rockDark), rockMoss = col(PAL.rockMoss), c = new THREE.Color();
    for (const [x, z, s] of ROCKS) {
        const ico = new THREE.IcosahedronGeometry(1, 1), p = ico.attributes.position;
        const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), rand() * Math.PI * 2);
        const sx = s * (1 + rand() * 0.4), sy = s * (0.6 + rand() * 0.2), sz = s * (0.85 + rand() * 0.3);
        const y0 = moundHeight(x, z) - sy * 0.3, seed = rand() * 40;
        const pts = [];
        for (let i = 0; i < p.count; i++) {
            const P = V(p.getX(i), p.getY(i), p.getZ(i));
            P.multiplyScalar(0.82 + 0.36 * vnoise(P.x * 1.7 + seed, P.y * 1.7, P.z * 1.7));
            if (P.y < -0.25) P.y = -0.25 + (P.y + 0.25) * 0.3; // flatter underside
            pts.push(P.set(P.x * sx, P.y * sy, P.z * sz).applyQuaternion(q).add(V(x, y0, z)));
        }
        for (let i = 0; i < pts.length; i += 3) {
            const n = V(0, 0, 0).crossVectors(pts[i + 1].clone().sub(pts[i]), pts[i + 2].clone().sub(pts[i])).normalize();
            c.copy(rock).lerp(rockDark, smoothstep(0.2, -0.6, n.y)).lerp(rockMoss, smoothstep(0.45, 0.85, n.y + (rand() - 0.5) * 0.3))
                .multiplyScalar(0.92 + rand() * 0.16);
            b.tri(pts[i], pts[i + 1], pts[i + 2], c.clone());
        }
        ico.dispose();
    }

    // Grass tufts of single-triangle blades, denser near the plant
    const gBase = col(PAL.grass), gTip = col(PAL.grassTip), lime = col(PAL.lime);
    const clear = (x, z) => ROCKS.every(([rx, rz, s]) => Math.hypot(x - rx, z - rz) > s * 1.2);
    for (let k = 0; k < 46; k++) {
        const r = 0.25 + 0.85 * Math.sqrt(rand()), th = rand() * Math.PI * 2;
        const x = r * Math.cos(th), z = r * Math.sin(th);
        if (!clear(x, z)) continue;
        const y = moundHeight(x, z) - 0.012, blades = 3 + Math.floor(rand() * 3);
        const tip = gTip.clone().lerp(lime, rand() < 0.25 ? 0.7 : 0);
        for (let i = 0; i < blades; i++) {
            const a = th + (i / blades) * Math.PI * 2 + rand() * 0.8, w = 0.012 + rand() * 0.008;
            const h = (0.07 + rand() * 0.1) * (1.25 - r * 0.4), lean = 0.25 + rand() * 0.35;
            const dx = Math.cos(a), dz = Math.sin(a), ox = (rand() - 0.5) * 0.04, oz = (rand() - 0.5) * 0.04;
            b.tri(V(x + ox - dz * w, y, z + oz + dx * w), V(x + ox + dz * w, y, z + oz - dx * w),
                V(x + ox + dx * h * lean, y + h, z + oz + dz * h * lean), gBase, gBase, tip);
        }
    }

    // Ferns: fronds of triangular pinnae arching out of the moss
    const fBase = col(PAL.fern), fTip = col(PAL.fernTip);
    for (const [x, z, size] of FERNS) {
        const y0 = moundHeight(x, z) - 0.01, fronds = 5, az0 = rand() * Math.PI;
        for (let f = 0; f < fronds; f++) {
            const az = az0 + (f / fronds) * Math.PI * 2 + (rand() - 0.5) * 0.5;
            const len = size * (0.8 + rand() * 0.35), elev = 1.0 + rand() * 0.3, N = 5;
            const dx = Math.cos(az), dz = Math.sin(az), side = V(-dz, 0, dx);
            const spine = [V(x, y0, z)];
            for (let k = 1; k <= N; k++) {
                const s = k / N, ang = elev * (1 - s) - 0.8 * s, p = spine[k - 1];
                spine.push(V(p.x + dx * Math.cos(ang) * len / N, p.y + Math.sin(ang) * len / N, p.z + dz * Math.cos(ang) * len / N));
            }
            for (let k = 0; k < N; k++) {
                const s = (k + 0.5) / N, pl = len * 0.32 * Math.sin(Math.PI * Math.min(s + 0.1, 1)) ** 0.7;
                const m = spine[k].clone().lerp(spine[k + 1], 0.5), fwd = spine[k + 1].clone().sub(spine[k]).normalize();
                const cs = fBase.clone().lerp(fTip, s);
                for (const sg of [-1, 1]) {
                    const tip = m.clone().addScaledVector(side, sg * pl).addScaledVector(fwd, pl * 0.45).add(V(0, -pl * 0.2, 0));
                    if (sg > 0) b.tri(spine[k], spine[k + 1], tip, fBase, fBase, cs);
                    else b.tri(spine[k + 1], spine[k], tip, fBase, fBase, cs);
                }
            }
        }
    }

    const mesh = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'decor';
    return mesh;
}

// Bioluminescent mushrooms: chunky faceted caps that glow (per-vertex strength) and soft halos
function buildMushrooms() {
    const b = new TriBuilder({ glow: true });
    const rand = rng(91);
    const stemC = col(PAL.shroomStem), capC = col(PAL.shroomCap), gillC = col(PAL.shroomGill);
    const halos = [];
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    for (const [x, z, h, R] of MUSHROOMS) {
        const y0 = moundHeight(x, z) - 0.015;
        const q = new THREE.Quaternion().setFromAxisAngle(V(rand() - 0.5, 0, rand() - 0.5).normalize(), (rand() - 0.5) * 0.5);
        const at = (px, py, pz) => V(px, py, pz).applyQuaternion(q).add(V(x, y0, z));
        const rot = rand() * Math.PI;
        const ring = (r, y, n, off = 0) => Array.from({ length: n }, (_, j) => {
            const th = rot + ((j + off) / n) * Math.PI * 2;
            return at(Math.cos(th) * r, y, Math.sin(th) * r);
        });
        // stem: five-sided, tapering up
        const sr = R * 0.24, low = ring(sr * 1.3, 0, 5), high = ring(sr * 0.85, h + 0.01, 5);
        for (let j = 0; j < 5; j++) {
            const j1 = (j + 1) % 5;
            b.quad(low[j1], low[j], high[j], high[j1], stemC, stemC, stemC, stemC, { alpha: [1, 1, 1, 1], glow: [0.15, 0.15, 0.35, 0.35] });
        }
        // cap: faceted dome over a glowing gill disc
        const ch = R * 0.8, top = at(0, h + ch, 0), mid = ring(R * 0.72, h + ch * 0.68, 6, 0.5), rim = ring(R, h + ch * 0.12, 6);
        const under = at(0, h + ch * 0.05, 0);
        for (let j = 0; j < 6; j++) {
            const j1 = (j + 1) % 6;
            b.tri(top, mid[j1], mid[j], capC, capC, capC, { glow: [0.55, 0.55, 0.55] });
            b.tri(mid[j], mid[j1], rim[j1], capC, capC, capC, { glow: [0.6, 0.6, 0.8] });
            b.tri(mid[j], rim[j1], rim[j], capC, capC, capC, { glow: [0.6, 0.8, 0.8] });
            b.tri(under, rim[j], rim[j1], gillC, gillC, gillC, { glow: [1.6, 1.2, 1.2] });
        }
        halos.push(top.x, top.y - ch * 0.4, top.z);
    }
    const pulse = { value: 1 };
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.8, metalness: 0,
        emissive: PAL.shroomGlow, emissiveIntensity: 1.5,
    });
    mat.onBeforeCompile = shader => {
        shader.uniforms.uPulse = pulse;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uPulse;')
            .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow * uPulse;');
    };
    const mesh = new THREE.Mesh(b.build(), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'mushrooms';

    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(halos, 3));
    const glowMat = new THREE.PointsMaterial({
        size: 0.42, map: paintGlow(), color: PAL.shroomGlow, transparent: true, opacity: 0.8,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const points = new THREE.Points(hg, glowMat);
    points.name = 'mushroom-glow';
    points.renderOrder = 1; // after the transparent mound, or it would paint over the halos
    return { mesh, points, pulse, glowMat };
}

function paintGlow() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

// ---------------------------------------------------------------------------------------------

export function createPlant() {
    const group = new THREE.Group();
    group.name = 'plant';

    const leaves = LEAF_SPECS.map((spec, i) => new Leaf(i, spec, makeLeafMaterial()));
    for (const leaf of leaves) group.add(leaf.mesh);
    const shrooms = buildMushrooms();
    for (const o of [buildPetioles(leaves), buildMound(), buildDecor(), shrooms.mesh, shrooms.points]) {
        o.matrixAutoUpdate = false; // static
        group.add(o);
    }
    group.updateWorldMatrix(true, true);

    return {
        group,
        leaves,
        pickables: leaves.map(l => l.mesh),
        update(dt, t) {
            const gust = 0.75 + 0.25 * Math.sin(t * 0.21) * Math.sin(t * 0.13 + 1.3);
            for (const leaf of leaves) leaf.update(dt, t, gust);
            const breathe = 0.85 + 0.15 * Math.sin(t * 0.7) * Math.sin(t * 0.31 + 2); // mushrooms
            shrooms.pulse.value = breathe;
            shrooms.glowMat.opacity = 0.75 * breathe;
            group.updateWorldMatrix(true, true);
        },
    };
}
