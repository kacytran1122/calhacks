import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ITEMS, ORIGIN, radial, toWorld, type Item } from "./items";
import { ARC, BLOCKED, FLOOR, PX_PER_M, ROOMS, SPONSORS, STAGE, STAIRS, TABLES, THEATER, VIEWS, type Pt, type View } from "./palace";
import { boothFront, canStand, doorOf, inside, nearestOpen, route, seen, standFor } from "./walk";
const COLORS = {
    wall: 0xfbf0e4,
    trim: 0x2b1b3d,
    closed: 0xeee2d4,
    ceiling: 0x5a4a6e,
    beam: 0x2b1b3d,
    skylight: 0xfff3d6,
    window: 0xd9f1ff,
    table: 0xffd84d,
    chair: 0xfff8ec,
    booth: 0xff6b5b,
    banner: 0x2b1b3d,
    stage: 0x5a4a6e,
    screen: 0xf5f9ff,
    stairs: 0x8a7aa0,
    seat: 0x7a6a92,
    door: 0x5a4a6e,
    beacon: 0xff6b5b,
    air: 0xf4ebe2,
    tint: { green: 0x1f9e72, yellow: 0xffd84d, red: 0xff6b5b } as Record<string, number>,
};
const EYE = 1.6;
const CEILING = 14;
const ROOM_H = 3;
const BAND = 1.1;
const MEZZANINE_H = 4.5;
const PACE = 2.4;
const LOOK = 0.0045;
const STEP_ANGLE = THREE.MathUtils.degToRad(2.2);
const v3 = (p: Pt, y = 0) => {
    const w = toWorld(p);
    return new THREE.Vector3(w.x, y, w.z);
};
const toPlan = (x: number, z: number): Pt => [x * PX_PER_M + ORIGIN[0], z * PX_PER_M + ORIGIN[1]];
const onArc = (r: number, a: number): Pt => [ARC.center[0] + r * Math.cos(a), ARC.center[1] + r * Math.sin(a)];
const yawToward = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(-(tx - fx), -(tz - fz));
const turnBy = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
function slabGeometry(poly: Pt[], height: number, y0 = 0) {
    const shape = new THREE.Shape(poly.map((p) => {
        const w = toWorld(p);
        return new THREE.Vector2(w.x, -w.z);
    }));
    const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0, 0);
    return g;
}
function wallGeometry(points: Pt[], height: number, thickness: number, closed: boolean) {
    const parts: THREE.BufferGeometry[] = [];
    const n = closed ? points.length : points.length - 1;
    for (let i = 0; i < n; i++) {
        const a = v3(points[i]!);
        const b = v3(points[(i + 1) % points.length]!);
        const len = a.distanceTo(b);
        if (len < 0.05)
            continue;
        const g = new THREE.BoxGeometry(len + thickness, height, thickness);
        g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x));
        g.translate((a.x + b.x) / 2, height / 2, (a.z + b.z) / 2);
        parts.push(g);
    }
    return mergeGeometries(parts)!;
}
const lerpPt = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function stairsGeometry(poly: Pt[], rise: "north" | "east", top: number, steps = 12) {
    const [p0, p1, p2, p3] = poly as [
        Pt,
        Pt,
        Pt,
        Pt
    ];
    const [lowA, lowB, highA, highB] = rise === "north" ? [p3, p2, p0, p1] : [p0, p3, p1, p2];
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const quad: Pt[] = [lerpPt(lowA, highA, t0), lerpPt(lowB, highB, t0), lerpPt(lowB, highB, t1), lerpPt(lowA, highA, t1)];
        parts.push(slabGeometry(quad, ((i + 1) / steps) * top));
    }
    return mergeGeometries(parts)!;
}
function floorTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d")!;
    g.fillStyle = "#ddd3c9";
    g.fillRect(0, 0, 256, 256);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1600; i++) {
        g.fillStyle = `rgba(43,27,61,${rand() * 0.06})`;
        g.fillRect(rand() * 256, rand() * 256, 2, 2);
    }
    g.strokeStyle = "rgba(43,27,61,0.18)";
    g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / 4, 1 / 4);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
}
function fadeTexture() {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(1, "rgba(255,255,255,0.85)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(c);
}
function drawBanner(c: HTMLCanvasElement, font: string, number: number | undefined, name: string) {
    const g = c.getContext("2d")!;
    const w = c.width;
    const h = c.height;
    g.fillStyle = "#2B1B3D";
    g.fillRect(0, 0, w, h);
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (number) {
        g.fillStyle = "#FFD84D";
        g.beginPath();
        g.arc(w / 2, 58, 38, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#2B1B3D";
        g.font = `800 40px ${font}`;
        g.fillText(String(number), w / 2, 60);
    }
    const words = name.split(" ");
    for (let size = 44; size >= 20; size -= 2) {
        g.font = `800 ${size}px ${font}`;
        const lines: string[] = [];
        for (const word of words) {
            const last = lines[lines.length - 1];
            if (last && g.measureText(`${last} ${word}`).width <= w - 28)
                lines[lines.length - 1] = `${last} ${word}`;
            else
                lines.push(word);
        }
        if (lines.length <= 2 && lines.every((l) => g.measureText(l).width <= w - 28)) {
            g.fillStyle = number ? "#FBF0E4" : "rgba(251,240,228,.7)";
            const top = number ? 150 : h / 2 - ((lines.length - 1) * size * 1.1) / 2;
            lines.forEach((l, i) => g.fillText(l, w / 2, top + i * size * 1.1));
            return;
        }
    }
}
type Label = {
    el: HTMLElement;
    far: HTMLElement;
    anchor: THREE.Vector3;
    item: Item;
    w?: number;
    h?: number;
    seen: boolean;
};
const PRIORITY: Record<Item["kind"], number> = { zone: 3, place: 2, sponsor: 1 };
const REACH: Record<Item["kind"], number> = { zone: 130, place: 70, sponsor: 0 };
const LIFT: Record<Item["kind"], number> = { zone: 4.4, place: 3.3, sponsor: 2.9 };
interface Glide {
    pts: THREE.Vector2[];
    at: number[];
    total: number;
    start: number;
    ms: number;
    face?: Pt;
    item?: Item;
    looking: boolean;
}
export interface SceneEvents {
    onPick: (item: Item) => void;
    onMove?: (at: Pt, yaw: number) => void;
    onRoute?: (path: Pt[] | null) => void;
    onArrive?: (item: Item) => void;
}
export type Hold = "forward" | "back" | "left" | "right";
export class VenueScene {
    private renderer: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera: THREE.PerspectiveCamera;
    private labels: Label[] = [];
    private beacon = new THREE.Group();
    private marker: THREE.Mesh;
    private floor!: THREE.Mesh;
    private booths!: THREE.InstancedMesh;
    private tappable: THREE.Object3D[] = [];
    private banners: {
        canvas: HTMLCanvasElement;
        texture: THREE.CanvasTexture;
        number?: number;
        name: string;
    }[] = [];
    private selected: Item | null = null;
    private pos = new THREE.Vector2();
    private yaw = 0;
    private pitch = 0;
    private keys = new Set<string>();
    private held = new Set<Hold>();
    private glide: Glide | null = null;
    private turn: {
        yaw: number;
        pitch: number;
        fromYaw: number;
        fromPitch: number;
        start: number;
        ms: number;
    } | null = null;
    private drag: {
        x: number;
        y: number;
        moved: boolean;
    } | null = null;
    private frame = 0;
    private tick = 0;
    private last = performance.now();
    private resize: ResizeObserver;
    private calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    constructor(private host: HTMLElement, private labelLayer: HTMLElement, private events: SceneEvents) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
        host.prepend(this.renderer.domElement);
        this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 400);
        this.camera.rotation.order = "YXZ";
        this.build();
        this.marker = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 40), new THREE.MeshBasicMaterial({ color: COLORS.trim, transparent: true, opacity: 0.7 }));
        this.marker.rotateX(-Math.PI / 2);
        this.marker.visible = false;
        this.scene.add(this.marker);
        this.buildBeacon();
        this.buildLabels();
        const start = VIEWS[0]!;
        this.place(start.at, start.facing);
        const el = this.renderer.domElement;
        el.tabIndex = 0;
        el.setAttribute("aria-label", "Inside the hall. Drag to look around, arrow keys or W A S D to walk.");
        el.addEventListener("pointerdown", this.down);
        el.addEventListener("pointermove", this.moveLook);
        el.addEventListener("pointerup", this.up);
        el.addEventListener("pointercancel", this.cancel);
        el.addEventListener("wheel", this.wheel, { passive: false });
        el.addEventListener("keydown", this.keyDown);
        el.addEventListener("keyup", this.keyUp);
        el.addEventListener("blur", this.blur);
        this.resize = new ResizeObserver(() => this.fit());
        this.resize.observe(host);
        this.fit();
        this.loop();
    }
    private build() {
        const s = this.scene;
        s.background = new THREE.Color(COLORS.air);
        s.fog = new THREE.Fog(COLORS.air, 35, 190);
        s.add(new THREE.HemisphereLight(0xfffaf0, 0x9a8c9e, 1.9));
        const key = new THREE.DirectionalLight(0xffffff, 0.9);
        key.position.set(-40, 80, 30);
        s.add(key);
        const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...extra });
        const glow = (color: number) => new THREE.MeshBasicMaterial({ color });
        const add = (g: THREE.BufferGeometry, m: THREE.Material, tappable = false) => {
            const x = new THREE.Mesh(g, m);
            s.add(x);
            if (tappable)
                this.tappable.push(x);
            return x;
        };
        this.floor = add(slabGeometry(FLOOR, 0.3, -0.3), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.75 }), true);
        add(slabGeometry(FLOOR, 0.4, CEILING), mat(COLORS.ceiling));
        add(wallGeometry(FLOOR, CEILING, 0.4, true), mat(COLORS.wall), true);
        add(wallGeometry(FLOOR, BAND, 0.5, true), mat(COLORS.trim));
        for (const b of BLOCKED) {
            add(slabGeometry(b.poly, CEILING), mat(COLORS.closed), true);
            add(wallGeometry(b.poly, BAND, 0.12, true), mat(COLORS.trim));
        }
        const beams: THREE.BufferGeometry[] = [];
        const lights: THREE.BufferGeometry[] = [];
        const panes: THREE.BufferGeometry[] = [];
        const a0 = Math.atan2(FLOOR[0]![1] - ARC.center[1], FLOOR[0]![0] - ARC.center[0]);
        const a1 = Math.atan2(635 - ARC.center[1], 2000 - ARC.center[0]);
        const indoors = (p: Pt) => inside(p, FLOOR) && !BLOCKED.some((b) => inside(p, b.poly));
        for (let a = a0 + STEP_ANGLE / 2, k = 0; a < a1; a += STEP_ANGLE, k++) {
            const inner = onArc(ARC.inner + 6, a);
            const outer = onArc(ARC.outer - 6, a);
            const A = v3(inner);
            const B = v3(outer);
            const len = A.distanceTo(B);
            const yaw = -Math.atan2(B.z - A.z, B.x - A.x);
            if (indoors(inner) && indoors(outer) && indoors(lerpPt(inner, outer, 0.5))) {
                const beam = new THREE.BoxGeometry(len, 0.7, 0.35);
                beam.rotateY(yaw);
                beam.translate((A.x + B.x) / 2, CEILING - 0.35, (A.z + B.z) / 2);
                beams.push(beam);
                if (k % 2 === 0) {
                    const mid = v3(onArc((ARC.inner + ARC.outer) / 2, a + STEP_ANGLE / 2), CEILING - 0.02);
                    const sky = new THREE.PlaneGeometry(len * 0.55, 1.4);
                    sky.rotateX(Math.PI / 2);
                    sky.rotateY(yaw);
                    sky.translate(mid.x, mid.y, mid.z);
                    lights.push(sky);
                }
            }
            const sill = onArc(ARC.inner + 4, a + STEP_ANGLE / 2);
            if (k % 2 === 1 && indoors(sill)) {
                const dir = radial(sill);
                const at = v3(sill, 8.5);
                const pane = new THREE.PlaneGeometry(2.2, 7);
                pane.rotateY(Math.atan2(dir.x, dir.z));
                pane.translate(at.x, at.y, at.z);
                panes.push(pane);
            }
        }
        if (beams.length)
            add(mergeGeometries(beams)!, mat(COLORS.beam));
        if (lights.length)
            add(mergeGeometries(lights)!, glow(COLORS.skylight));
        if (panes.length)
            add(mergeGeometries(panes)!, glow(COLORS.window));
        for (const r of ROOMS) {
            if (r.tint)
                add(slabGeometry(r.poly, 0.02, 0.001), mat(COLORS.tint[r.tint]!, { transparent: true, opacity: 0.5 }));
            add(wallGeometry(r.poly, ROOM_H, 0.2, true), mat(COLORS.wall), true);
            add(wallGeometry(r.poly, BAND, 0.26, true), mat(COLORS.trim));
            const door = doorOf(r.poly);
            if (door) {
                const w = toWorld(door.at);
                const d = add(new THREE.BoxGeometry(1.4, 2.3, 0.3), mat(COLORS.door));
                d.position.set(w.x, 1.15, w.z);
                d.rotation.y = door.yaw;
            }
        }
        add(slabGeometry(STAGE.poly, 0.8), mat(COLORS.stage), true);
        const hall = v3([600, 380]);
        for (const p of STAGE.screens) {
            const at = v3(p, 3.2);
            const screen = add(new THREE.BoxGeometry(4.2, 2.5, 0.12), mat(COLORS.screen, { emissive: 0xdde9ff, emissiveIntensity: 0.45 }));
            screen.position.copy(at);
            screen.lookAt(hall.x, at.y, hall.z);
        }
        for (const st of STAIRS)
            add(stairsGeometry(st.poly, st.rise, MEZZANINE_H), mat(COLORS.stairs), true);
        const tc = v3(THEATER.center);
        const r = THEATER.radius / PX_PER_M;
        const m4 = new THREE.Matrix4();
        const seatGeo = mergeGeometries([new THREE.BoxGeometry(0.5, 0.45, 0.5), new THREE.BoxGeometry(0.5, 0.5, 0.08).translate(0, 0.45, 0.21)])!;
        const seats = new THREE.InstancedMesh(seatGeo, mat(COLORS.seat), THEATER.rows * THEATER.seatsPerRow);
        let k = 0;
        for (let row = 0; row < THEATER.rows; row++) {
            const rr = r * (0.45 + 0.15 * row);
            for (let i = 0; i < THEATER.seatsPerRow; i++) {
                const a = Math.PI + (Math.PI * (i + 0.5)) / THEATER.seatsPerRow;
                seats.setMatrixAt(k++, m4.makeRotationY(-a + Math.PI / 2).setPosition(tc.x + rr * Math.cos(a), 0.25 + row * 0.35, tc.z + rr * Math.sin(a)));
            }
        }
        s.add(seats);
        const stageDisc = add(new THREE.CylinderGeometry(r * 0.3, r * 0.3, 0.6, 32, 1, false, Math.PI / 2, Math.PI), mat(COLORS.stage));
        stageDisc.position.set(tc.x, 0.3, tc.z);
        const tops = new THREE.InstancedMesh(new THREE.BoxGeometry(1.75, 0.74, 0.76), mat(COLORS.table), TABLES.length);
        const chairs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.46, 0.42), mat(COLORS.chair), TABLES.length * 4);
        let c = 0;
        TABLES.forEach((p, i) => {
            const w = toWorld(p);
            const dir = radial(p);
            const yaw = -Math.atan2(dir.z, dir.x);
            tops.setMatrixAt(i, m4.makeRotationY(yaw).setPosition(w.x, 0.37, w.z));
            for (const along of [-0.45, 0.45])
                for (const side of [-0.62, 0.62])
                    chairs.setMatrixAt(c++, m4.makeRotationY(yaw).setPosition(w.x + dir.x * along - dir.z * side, 0.23, w.z + dir.z * along + dir.x * side));
        });
        s.add(tops, chairs);
        this.tappable.push(tops, chairs);
        this.booths = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 0.76, 0.76), mat(COLORS.booth), SPONSORS.length);
        const backs = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 1.7, 0.06), mat(COLORS.banner), SPONSORS.length);
        const font = getComputedStyle(this.host).getPropertyValue("--nf-heading").trim() || "system-ui, sans-serif";
        SPONSORS.forEach((sp, i) => {
            const w = toWorld(sp.at);
            const f = boothFront(sp.at);
            const yaw = Math.atan2(f.x, f.z);
            this.booths.setMatrixAt(i, m4.makeRotationY(yaw).setPosition(w.x, 0.38, w.z));
            backs.setMatrixAt(i, m4.makeRotationY(yaw).setPosition(w.x - f.x * 0.5, 1.62, w.z - f.z * 0.5));
            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 242;
            const name = sp.name ?? "Sponsor";
            drawBanner(canvas, font, sp.number, name);
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = 4;
            this.banners.push({ canvas, texture, number: sp.number, name });
            const face = add(new THREE.PlaneGeometry(1.8, 1.7), new THREE.MeshBasicMaterial({ map: texture }), true);
            face.position.set(w.x - f.x * 0.465, 1.62, w.z - f.z * 0.465);
            face.rotation.y = yaw;
            face.userData.item = ITEMS.find((it) => it.id === `sponsor-${i}`);
        });
        s.add(this.booths, backs);
        this.tappable.push(this.booths);
        void document.fonts?.ready.then(() => {
            for (const b of this.banners) {
                drawBanner(b.canvas, font, b.number, b.name);
                b.texture.needsUpdate = true;
            }
        });
    }
    private buildBeacon() {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 11, 32, 1, true), new THREE.MeshBasicMaterial({ color: COLORS.beacon, map: fadeTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        beam.position.y = 5.5;
        beam.name = "beam";
        const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.5, 48), new THREE.MeshBasicMaterial({ color: COLORS.beacon, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
        ring.rotateX(-Math.PI / 2);
        ring.position.y = 0.03;
        ring.name = "ring";
        this.beacon.add(beam, ring);
        this.beacon.visible = false;
        this.scene.add(this.beacon);
    }
    private buildLabels() {
        for (const item of ITEMS) {
            const el = document.createElement("button");
            el.type = "button";
            el.className = `vn-label ${item.kind}`;
            el.innerHTML = `${item.kind === "sponsor" && item.number ? `<i>${item.number}</i>` : ""}<span>${esc(item.name)}</span>`;
            const far = document.createElement("em");
            el.append(far);
            el.addEventListener("click", () => (this.selected?.id === item.id ? this.face(item.at) : this.events.onPick(item)));
            this.labelLayer.append(el);
            this.labels.push({ el, far, anchor: v3(item.at, LIFT[item.kind]), item, seen: true });
        }
    }
    private fit() {
        const { clientWidth: w, clientHeight: h } = this.host;
        if (!w || !h)
            return;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }
    private loop = () => {
        this.frame = requestAnimationFrame(this.loop);
        const now = performance.now();
        const dt = Math.min(0.05, (now - this.last) / 1000);
        this.last = now;
        if (this.glide)
            this.glideStep(now, dt);
        else
            this.walkStep(dt);
        if (this.turn) {
            const t = this.calm ? 1 : Math.min(1, (now - this.turn.start) / this.turn.ms);
            const e = 1 - Math.pow(1 - t, 3);
            this.yaw = this.turn.fromYaw + turnBy(this.turn.fromYaw, this.turn.yaw) * e;
            this.pitch = this.turn.fromPitch + (this.turn.pitch - this.turn.fromPitch) * e;
            if (t >= 1)
                this.turn = null;
        }
        this.camera.position.set(this.pos.x, EYE, this.pos.y);
        this.camera.rotation.set(this.pitch, this.yaw, 0);
        if (this.beacon.visible) {
            this.beacon.getObjectByName("ring")!.scale.setScalar(1 + 0.12 * Math.sin(now / 260));
            const near = Math.hypot(this.beacon.position.x - this.pos.x, this.beacon.position.z - this.pos.y);
            ((this.beacon.getObjectByName("beam") as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp((near - 3) / 9, 0.08, 1);
        }
        this.renderer.render(this.scene, this.camera);
        this.placeLabels();
        if (this.tick++ % 3 === 0)
            this.events.onMove?.(this.position(), this.yaw);
    };
    private walkStep(dt: number) {
        const k = this.keys;
        const h = this.held;
        const ahead = +(k.has("w") || k.has("arrowup") || h.has("forward")) - +(k.has("s") || k.has("arrowdown") || h.has("back"));
        const side = +k.has("d") - +k.has("a");
        const turn = +(k.has("arrowleft") || k.has("q") || h.has("left")) - +(k.has("arrowright") || k.has("e") || h.has("right"));
        if (turn) {
            this.yaw += turn * dt * 1.7;
            this.turn = null;
        }
        if (!ahead && !side)
            return;
        this.turn = null;
        const pace = PACE * (k.has("shift") ? 2 : 1) * dt;
        const fx = -Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        let dx = fx * ahead - fz * side;
        let dz = fz * ahead + fx * side;
        const len = Math.hypot(dx, dz);
        dx = (dx / len) * pace;
        dz = (dz / len) * pace;
        this.step(dx, dz);
    }
    private step(dx: number, dz: number) {
        const ok = (x: number, z: number) => canStand(toPlan(x, z));
        const { x, y: z } = this.pos;
        if (ok(x + dx, z + dz))
            this.pos.set(x + dx, z + dz);
        else if (ok(x + dx, z))
            this.pos.set(x + dx, z);
        else if (ok(x, z + dz))
            this.pos.set(x, z + dz);
    }
    private glideStep(now: number, dt: number) {
        const g = this.glide!;
        const t = this.calm ? 1 : Math.min(1, (now - g.start) / g.ms);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const d = e * g.total;
        this.pos.copy(this.along(g, d));
        if (!g.looking) {
            const ahead = this.along(g, Math.min(g.total, d + 4));
            if (ahead.distanceTo(this.pos) > 0.3) {
                const want = yawToward(this.pos.x, this.pos.y, ahead.x, ahead.y);
                this.yaw += turnBy(this.yaw, want) * (1 - Math.exp(-dt * 5));
            }
            this.pitch += (0 - this.pitch) * (1 - Math.exp(-dt * 4));
        }
        if (t < 1)
            return;
        this.glide = null;
        this.marker.visible = false;
        this.events.onRoute?.(null);
        if (g.face)
            this.face(g.face);
        if (g.item)
            this.events.onArrive?.(g.item);
    }
    private along(g: Glide, d: number) {
        let i = 1;
        while (i < g.at.length - 1 && g.at[i]! < d)
            i++;
        const seg = g.at[i]! - g.at[i - 1]!;
        return new THREE.Vector2().lerpVectors(g.pts[i - 1]!, g.pts[i]!, seg > 0 ? (d - g.at[i - 1]!) / seg : 1);
    }
    private placeLabels() {
        const w = this.host.clientWidth;
        const h = this.host.clientHeight;
        const here = this.position();
        const recheck = this.tick % 10 === 0;
        const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
        const p = new THREE.Vector3();
        const shown: {
            l: Label;
            x: number;
            y: number;
            depth: number;
            rank: number;
            meters: number;
        }[] = [];
        for (const l of this.labels) {
            const isSelected = this.selected?.id === l.item.id;
            const meters = Math.hypot(l.anchor.x - this.pos.x, l.anchor.z - this.pos.y);
            if (recheck)
                l.seen = seen(here, l.item.at);
            l.el.classList.toggle("edge", false);
            if (!isSelected && (meters > REACH[l.item.kind] || !l.seen)) {
                l.el.style.display = "none";
                continue;
            }
            p.copy(l.anchor).project(this.camera);
            const inView = p.z < 1 && Math.abs(p.x) < 1.02 && Math.abs(p.y) < 1.05;
            if (inView) {
                shown.push({ l, x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, depth: p.z, rank: isSelected ? 9 : PRIORITY[l.item.kind], meters });
                continue;
            }
            if (!isSelected) {
                l.el.style.display = "none";
                continue;
            }
            const bearing = turnBy(this.yaw, yawToward(this.pos.x, this.pos.y, l.anchor.x, l.anchor.z));
            const left = Math.abs(bearing) <= halfFov ? p.x < 0 : bearing > 0;
            shown.push({ l, x: left ? 12 : w - 12, y: h * 0.42, depth: 0, rank: 10, meters });
            l.el.classList.add("edge");
            l.el.dataset.side = left ? "left" : "right";
        }
        shown.sort((a, b) => b.rank - a.rank || a.depth - b.depth);
        const taken: {
            x0: number;
            y0: number;
            x1: number;
            y1: number;
        }[] = [];
        for (const s of shown) {
            const { l } = s;
            const selected = s.rank >= 9;
            const far = selected ? `${Math.round(s.meters)} m` : "";
            if (l.far.textContent !== far) {
                l.far.textContent = far;
                l.w = undefined;
            }
            if (l.w === undefined) {
                l.el.style.display = "";
                l.w = l.el.offsetWidth;
                l.h = l.el.offsetHeight;
            }
            const edge = s.rank === 10;
            const x0 = edge ? (l.el.dataset.side === "left" ? s.x : s.x - l.w) : s.x - l.w / 2;
            const box = { x0: x0 - 3, y0: s.y - l.h! - 9, x1: x0 + l.w + 3, y1: s.y };
            if (!selected && taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0 && box.y0 < t.y1 && box.y1 > t.y0)) {
                l.el.style.display = "none";
                continue;
            }
            taken.push(box);
            l.el.style.display = "";
            l.el.classList.toggle("on", selected);
            l.el.style.opacity = selected ? "1" : String(Math.max(0.5, Math.min(1, 1 - (s.meters - 30) / 70)));
            l.el.style.transform = `translate(${x0}px, ${s.y}px) translateY(-100%)`;
            l.el.style.zIndex = String(selected ? 1000 : Math.round((1 - s.depth) * 900));
        }
    }
    private down = (e: PointerEvent) => {
        if (e.pointerType === "mouse" && e.button !== 0)
            return;
        this.drag = { x: e.clientX, y: e.clientY, moved: false };
        this.renderer.domElement.setPointerCapture(e.pointerId);
        this.renderer.domElement.focus({ preventScroll: true });
    };
    private moveLook = (e: PointerEvent) => {
        const d = this.drag;
        if (!d)
            return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 5)
            return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        this.yaw += dx * LOOK;
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * LOOK, -1.1, 1.1);
        this.turn = null;
        if (this.glide)
            this.glide.looking = true;
    };
    private up = (e: PointerEvent) => {
        const d = this.drag;
        this.drag = null;
        if (d && !d.moved)
            this.tap(e);
    };
    private cancel = () => {
        this.drag = null;
    };
    private wheel = (e: WheelEvent) => {
        e.preventDefault();
        if (this.glide)
            return;
        const m = THREE.MathUtils.clamp(-e.deltaY * 0.01, -1.5, 1.5);
        this.step(-Math.sin(this.yaw) * m, -Math.cos(this.yaw) * m);
    };
    private keyDown = (e: KeyboardEvent) => {
        const k = e.key.toLowerCase();
        if (!["w", "a", "s", "d", "q", "e", "shift", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k))
            return;
        e.preventDefault();
        this.keys.add(k);
        if (k !== "shift" && this.glide)
            this.stop();
    };
    private keyUp = (e: KeyboardEvent) => {
        this.keys.delete(e.key.toLowerCase());
    };
    private blur = () => {
        this.keys.clear();
    };
    private tap(e: PointerEvent) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.camera);
        const hit = ray.intersectObjects(this.tappable, false)[0];
        if (!hit)
            return;
        const item = hit.object === this.booths && hit.instanceId !== undefined ? ITEMS.find((it) => it.id === `sponsor-${hit.instanceId}`) : (hit.object.userData.item as Item | undefined);
        if (item)
            return this.events.onPick(item);
        if (hit.point.y < 1.2)
            this.walkToPoint(toPlan(hit.point.x, hit.point.z));
    }
    private place(at: Pt, facing: Pt) {
        const p = nearestOpen(at);
        const w = toWorld(p);
        const f = toWorld(facing);
        this.pos.set(w.x, w.z);
        this.yaw = yawToward(w.x, w.z, f.x, f.z);
        this.pitch = 0;
    }
    position(): Pt {
        return toPlan(this.pos.x, this.pos.y);
    }
    face(target: Pt, ms = 700) {
        const t = toWorld(target);
        this.turn = { yaw: yawToward(this.pos.x, this.pos.y, t.x, t.z), pitch: 0.02, fromYaw: this.yaw, fromPitch: this.pitch, start: performance.now(), ms };
    }
    private walk(to: Pt, face?: Pt, item?: Item) {
        const path = route(this.position(), to);
        const pts = path.map((p) => {
            const w = toWorld(p);
            return new THREE.Vector2(w.x, w.z);
        });
        const at = [0];
        for (let i = 1; i < pts.length; i++)
            at.push(at[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
        const total = at[at.length - 1]!;
        this.turn = null;
        if (total < 0.4) {
            if (face)
                this.face(face);
            if (item)
                this.events.onArrive?.(item);
            return;
        }
        this.glide = { pts, at, total, start: performance.now(), ms: THREE.MathUtils.clamp((total / 6) * 1000, 1200, 8000), face, item, looking: false };
        const end = pts[pts.length - 1]!;
        this.marker.position.set(end.x, 0.03, end.y);
        this.marker.visible = !item;
        this.events.onRoute?.(path);
    }
    walkTo(item: Item) {
        this.walk(standFor(item), item.at, item);
    }
    goTo(view: View) {
        this.walk(nearestOpen(view.at, true), view.facing);
    }
    walkToPoint(p: Pt) {
        this.walk(nearestOpen(p, true));
    }
    stop() {
        if (!this.glide)
            return;
        this.glide = null;
        this.marker.visible = false;
        this.events.onRoute?.(null);
    }
    hold(control: Hold, on: boolean) {
        if (on) {
            this.held.add(control);
            this.stop();
        }
        else
            this.held.delete(control);
    }
    select(item: Item | null) {
        this.selected = item;
        this.beacon.visible = Boolean(item);
        if (!item)
            return;
        const w = toWorld(item.at);
        this.beacon.position.set(w.x, 0, w.z);
        if (!this.glide)
            this.face(item.at);
    }
    dispose() {
        cancelAnimationFrame(this.frame);
        this.resize.disconnect();
        const el = this.renderer.domElement;
        el.removeEventListener("pointerdown", this.down);
        el.removeEventListener("pointermove", this.moveLook);
        el.removeEventListener("pointerup", this.up);
        el.removeEventListener("pointercancel", this.cancel);
        el.removeEventListener("wheel", this.wheel);
        el.removeEventListener("keydown", this.keyDown);
        el.removeEventListener("keyup", this.keyUp);
        el.removeEventListener("blur", this.blur);
        this.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            m.geometry?.dispose();
            const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
            for (const x of mats) {
                (x as THREE.MeshBasicMaterial).map?.dispose();
                x.dispose();
            }
        });
        this.renderer.dispose();
        el.remove();
        for (const l of this.labels)
            l.el.remove();
    }
}
function esc(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
