"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import styles from "./tour.module.css";

type Room = {
  name: string;
  floor: string;
  role: string;
  position: readonly [number, number, number];
  viewpoint: readonly [number, number];
  angle?: number;
};

type TourRuntime = {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  modelReady: boolean;
};

const ROOMS: readonly Room[] = [
  {
    name: "Entrance & Check-in",
    floor: "First floor",
    role: "Welcome desks, information screens and queueing",
    position: [-10, 1.4, -7.6],
    viewpoint: [-12, -3.8],
    angle: -0.48,
  },
  {
    name: "Sponsors Galleria",
    floor: "First floor",
    role: "Branded demo booths, monitors and sponsor corridor",
    position: [-5.1, 1.5, 1.7],
    viewpoint: [-3.3, 1.7],
  },
  {
    name: "Food",
    floor: "First floor",
    role: "Buffet counters, menu band, drink station and café tables",
    position: [8.6, 1.4, 8.1],
    viewpoint: [9.8, 6],
  },
  {
    name: "Hacking Area — Collins Room",
    floor: "First floor",
    role: "Laptop workstations, shared power and presentation display",
    position: [10.5, 1.5, 2.7],
    viewpoint: [7, 2.5],
  },
  {
    name: "Hacking Area — Collins Patio",
    floor: "First floor · outdoors",
    role: "Shaded outdoor hacking tables and planting",
    position: [20.5, 1.2, 4],
    viewpoint: [18.3, 4],
  },
  {
    name: "Hacking Area — Founders’ Room",
    floor: "First floor",
    role: "Team tables, laptops, whiteboard and lounge seating",
    position: [2.1, 1.5, -8.1],
    viewpoint: [-1.2, -8.1],
  },
  {
    name: "Hacking Area — Founders’ Patio",
    floor: "First floor · outdoors",
    role: "Outdoor worktables beneath a shade canopy",
    position: [10.7, 1.2, -15.1],
    viewpoint: [10.7, -12.2],
  },
  {
    name: "Restrooms",
    floor: "First floor",
    role: "Wayfinding, privacy partitions, sinks and mirrors",
    position: [1.7, 1.5, -2.2],
    viewpoint: [1.7, -4.1],
  },
  {
    name: "Stairs to Second Floor",
    floor: "East side",
    role: "Exterior stair connecting both event levels",
    position: [17.5, 2.3, -0.5],
    viewpoint: [17.5, -2.7],
  },
  {
    name: "Workshops",
    floor: "Second floor",
    role: "Teaching stage, projection screen and classroom tables",
    position: [0.7, 5.6, 0],
    viewpoint: [-4.2, 0],
  },
  {
    name: "Networking — Northeast Patio",
    floor: "Second floor",
    role: "Cocktail tables, lounge seating, planters and warm lights",
    position: [8.4, 5.6, 7.2],
    viewpoint: [4.2, 7.1],
  },
] as const;

const MOVEMENT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ShiftLeft",
  "ShiftRight",
]);

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

export function TourClient() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<TourRuntime | null>(null);
  const tagRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const keysRef = useRef<Record<string, boolean>>({});
  const immersiveRef = useRef(false);
  const activeRoomRef = useRef(0);
  const yawRef = useRef(Math.PI);
  const pitchRef = useRef(0);

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadMessage, setLoadMessage] = useState("Preparing the 3D model…");
  const [welcomeOpen, setWelcomeOpen] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [activeRoomIndex, setActiveRoomIndex] = useState(0);

  const requestLookControl = useCallback(() => {
    const canvas = runtimeRef.current?.renderer.domElement;
    if (!canvas || document.pointerLockElement === canvas) return;
    try {
      const request = canvas.requestPointerLock?.();
      request?.catch?.(() => undefined);
    } catch {
      // Pointer lock is an enhancement. Keyboard and touch movement still work.
    }
  }, []);

  const exitImmerse = useCallback(() => {
    const runtime = runtimeRef.current;
    immersiveRef.current = false;
    keysRef.current = {};
    setImmersive(false);
    if (runtime) runtime.controls.enabled = true;
    if (document.pointerLockElement === runtime?.renderer.domElement) {
      void document.exitPointerLock?.();
    }
  }, []);

  const startImmerse = useCallback(
    (roomIndex = 0) => {
      const runtime = runtimeRef.current;
      const room = ROOMS[roomIndex];
      if (!runtime?.modelReady || !room) return;

      immersiveRef.current = true;
      activeRoomRef.current = roomIndex;
      setActiveRoomIndex(roomIndex);
      setImmersive(true);
      setWelcomeOpen(false);
      runtime.controls.enabled = false;

      const secondFloor = room.position[1] > 3;
      runtime.camera.position.set(room.viewpoint[0], secondFloor ? 5.72 : 1.72, room.viewpoint[1]);
      yawRef.current = room.angle ?? Math.PI;
      pitchRef.current = 0;
      runtime.renderer.domElement.focus({ preventScroll: true });
      requestLookControl();
    },
    [requestLookControl],
  );

  const showExterior = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.modelReady) return;
    exitImmerse();
    runtime.camera.position.set(34, 27, 38);
    runtime.controls.target.set(1, 3, -2);
    runtime.controls.update();
  }, [exitImmerse]);

  useEffect(() => {
    const host = viewportRef.current;
    if (!host) return;

    let disposed = false;
    let runtime: TourRuntime | null = null;
    let modelRoot: THREE.Object3D | null = null;

    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xdce6ef);
      scene.fog = new THREE.Fog(0xdce6ef, 58, 108);

      const camera = new THREE.PerspectiveCamera(58, 1, 0.08, 220);
      camera.position.set(-10, 1.72, -5.9);

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.tabIndex = 0;
      renderer.domElement.setAttribute("aria-label", "Interactive 3D building model");
      host.appendChild(renderer.domElement);

      const hemisphere = new THREE.HemisphereLight(0xeaf4ff, 0x6b6254, 2.15);
      scene.add(hemisphere);
      const sun = new THREE.DirectionalLight(0xfff3db, 3.2);
      sun.position.set(-22, 34, -18);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      scene.add(sun);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(-10, 1.72, 2);
      controls.enableDamping = true;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.minDistance = 0.8;
      controls.maxDistance = 92;
      controls.update();

      runtime = { camera, controls, renderer, scene, modelReady: false };
      runtimeRef.current = runtime;

      const resize = () => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      };
      resize();

      new GLTFLoader().load(
        "/3d-tour/james-west-alumni-center-concept.glb",
        (gltf) => {
          if (disposed) {
            disposeObject(gltf.scene);
            return;
          }
          gltf.scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          });
          modelRoot = gltf.scene;
          scene.add(gltf.scene);
          if (runtime) runtime.modelReady = true;
          setLoadState("ready");
          setLoadMessage("The concept is ready to explore.");
        },
        undefined,
        () => {
          if (disposed) return;
          setLoadState("error");
          setLoadMessage("We could not load the building model. Please reload the tour to try again.");
        },
      );

      const onCanvasClick = () => {
        if (immersiveRef.current) requestLookControl();
      };
      const onMouseMove = (event: MouseEvent) => {
        if (!immersiveRef.current || document.pointerLockElement !== renderer.domElement) return;
        yawRef.current -= event.movementX * 0.0022;
        pitchRef.current = Math.max(-1.25, Math.min(1.25, pitchRef.current - event.movementY * 0.0022));
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (!immersiveRef.current || !MOVEMENT_KEYS.has(event.code)) return;
        event.preventDefault();
        event.stopPropagation();
        keysRef.current[event.code] = true;
      };
      const onKeyUp = (event: KeyboardEvent) => {
        if (!MOVEMENT_KEYS.has(event.code)) return;
        if (immersiveRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
        keysRef.current[event.code] = false;
      };
      const onBlur = () => {
        keysRef.current = {};
      };

      renderer.domElement.addEventListener("click", onCanvasClick);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", onKeyUp, true);
      window.addEventListener("blur", onBlur);
      window.addEventListener("resize", resize);

      const forward = new THREE.Vector3();
      const right = new THREE.Vector3();
      const movement = new THREE.Vector3();
      const projected = new THREE.Vector3();
      let lastFrame = performance.now();

      const updateWalk = (delta: number) => {
        const keys = keysRef.current;
        if (keys.ArrowLeft) yawRef.current += delta * 1.9;
        if (keys.ArrowRight) yawRef.current -= delta * 1.9;

        camera.rotation.order = "YXZ";
        camera.rotation.set(pitchRef.current, yawRef.current, 0);
        forward.set(-Math.sin(yawRef.current), 0, -Math.cos(yawRef.current));
        right.set(Math.cos(yawRef.current), 0, -Math.sin(yawRef.current));
        movement.set(0, 0, 0);
        if (keys.KeyW || keys.ArrowUp) movement.add(forward);
        if (keys.KeyS || keys.ArrowDown) movement.sub(forward);
        if (keys.KeyD) movement.add(right);
        if (keys.KeyA) movement.sub(right);
        if (movement.lengthSq()) {
          const speed = keys.ShiftLeft || keys.ShiftRight ? 8 : 3.6;
          camera.position.add(movement.normalize().multiplyScalar(delta * speed));
        }

        const onSecondFloor = camera.position.y > 3;
        if (
          camera.position.x > 15.6 &&
          camera.position.x < 19.3 &&
          camera.position.z > -3.8 &&
          camera.position.z < 2.7
        ) {
          camera.position.y = Math.max(1.72, Math.min(5.72, 1.72 + (camera.position.z + 3.2) * 0.72));
        } else {
          camera.position.y = onSecondFloor ? 5.72 : 1.72;
        }

        let nearestIndex = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;
        ROOMS.forEach((room, index) => {
          const floorDistance = Math.abs(camera.position.y - room.position[1]);
          const distance =
            Math.hypot(camera.position.x - room.position[0], camera.position.z - room.position[2]) +
            floorDistance * 2;
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = index;
          }
        });
        if (nearestIndex !== activeRoomRef.current) {
          activeRoomRef.current = nearestIndex;
          setActiveRoomIndex(nearestIndex);
        }
      };

      const projectLabels = () => {
        const width = host.clientWidth;
        const height = host.clientHeight;
        ROOMS.forEach((room, index) => {
          const tag = tagRefs.current[index];
          if (!tag) return;
          projected.set(...room.position).project(camera);
          const visible = projected.z > -1 && projected.z < 1;
          tag.hidden = !visible;
          if (visible) {
            tag.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
            tag.style.top = `${(-projected.y * 0.5 + 0.5) * height}px`;
          }
        });
      };

      renderer.setAnimationLoop((time) => {
        const delta = Math.min(0.05, (time - lastFrame) / 1000);
        lastFrame = time;
        if (immersiveRef.current) updateWalk(delta);
        else {
          controls.update();
          projectLabels();
        }
        renderer.render(scene, camera);
      });

      return () => {
        disposed = true;
        immersiveRef.current = false;
        renderer.setAnimationLoop(null);
        renderer.domElement.removeEventListener("click", onCanvasClick);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("keyup", onKeyUp, true);
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("resize", resize);
        if (document.pointerLockElement === renderer.domElement) void document.exitPointerLock?.();
        controls.dispose();
        if (modelRoot) disposeObject(modelRoot);
        renderer.dispose();
        renderer.domElement.remove();
        runtimeRef.current = null;
      };
    } catch {
      setLoadState("error");
      setLoadMessage("Your browser could not start the 3D view. Please enable WebGL or try a different browser.");
    }

    return () => {
      disposed = true;
      runtime?.renderer.setAnimationLoop(null);
    };
  }, [requestLookControl]);

  const setVirtualKey = (event: ReactPointerEvent<HTMLButtonElement>, pressed: boolean) => {
    event.preventDefault();
    const code = event.currentTarget.dataset.key;
    if (!code) return;
    keysRef.current[code] = pressed;
    event.currentTarget.classList.toggle(styles.active, pressed);
    if (pressed) event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const activeRoom = ROOMS[activeRoomIndex] ?? ROOMS[0];
  const ready = loadState === "ready";

  return (
    <main className={`${styles.shell} ${immersive ? styles.immersive : ""}`}>
      <noscript>
        <div className={`${styles.welcome} ${styles.noScript}`}>
          <div className={styles.welcomeCard}>
            <h1>JavaScript is required for this 3D tour</h1>
            <p>Please enable JavaScript to explore the building model, or return to the event planner.</p>
            <Link className={`${styles.button} ${styles.primary}`} href="/finding-events">
              Back to events
            </Link>
          </div>
        </div>
      </noscript>
      <div ref={viewportRef} className={styles.viewport} role="application" aria-label="Interactive 3D building tour" />

      <div className={styles.labels} aria-label="Room labels">
        {ROOMS.map((room, index) => (
          <button
            ref={(node) => {
              tagRefs.current[index] = node;
            }}
            className={styles.tag}
            type="button"
            key={room.name}
            onClick={() => startImmerse(index)}
            disabled={!ready}
          >
            {room.name}
          </button>
        ))}
      </div>

      {welcomeOpen ? (
        <section className={styles.welcome} aria-labelledby="tour-welcome-title">
          <div className={styles.welcomeCard}>
            <div className={styles.eyebrow}>LA Hacks · 3D concept tour</div>
            <h1 id="tour-welcome-title">
              Step inside the
              <br />
              James West Alumni Center
            </h1>
            <p>Explore our concept, from check-in and hacking rooms to workshops and outdoor patios.</p>
            <p className={styles.loadStatus} role={loadState === "error" ? "alert" : "status"} aria-live="polite">
              {loadMessage}
            </p>
            <button className={`${styles.button} ${styles.primary}`} type="button" onClick={() => startImmerse(0)} disabled={!ready}>
              Enter the building
            </button>
            {loadState === "error" ? (
              <button className={styles.button} type="button" onClick={() => window.location.reload()}>
                Reload tour
              </button>
            ) : null}
            <p className={styles.welcomeNote}>
              An approximate interpretation of supplied sketches, not a verified current event layout or accessible navigation guide.
              Please confirm the venue with the organizer.
            </p>
          </div>
        </section>
      ) : null}

      <header className={styles.topbar}>
        <div className={styles.brand}>
          <h2>LA Hacks</h2>
          <p>James West Alumni Center · two-floor concept</p>
        </div>
        <div className={styles.actions}>
          <Link className={styles.button} href="/finding-events">
            Back to events
          </Link>
          <select
            className={styles.select}
            defaultValue=""
            disabled={!ready}
            aria-label="Jump to a place"
            onChange={(event) => {
              if (event.currentTarget.value) startImmerse(Number(event.currentTarget.value));
              event.currentTarget.value = "";
            }}
          >
            <option value="">Jump to a place…</option>
            {ROOMS.map((room, index) => (
              <option value={index} key={room.name}>
                {room.name}
              </option>
            ))}
          </select>
          <button className={styles.button} type="button" onClick={showExterior} disabled={!ready}>
            Exterior view
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            type="button"
            onClick={() => (immersive ? exitImmerse() : startImmerse())}
            disabled={!ready}
          >
            {immersive ? "Exit tour" : "Start walking"}
          </button>
        </div>
      </header>

      <aside className={styles.places} aria-label="Explore places">
        <h2>Explore places</h2>
        {ROOMS.map((room, index) => (
          <button className={styles.place} type="button" key={room.name} onClick={() => startImmerse(index)} disabled={!ready}>
            {room.name}
            <small>
              {room.floor} · {room.role}
            </small>
          </button>
        ))}
      </aside>

      <div className={styles.dpad} aria-label="Movement controls">
        {[
          ["ArrowUp", "F", "Move forward", styles.up],
          ["ArrowLeft", "L", "Turn left", styles.left],
          ["ArrowDown", "B", "Move backward", styles.down],
          ["ArrowRight", "R", "Turn right", styles.right],
        ].map(([code, symbol, label, position]) => (
          <button
            className={position}
            type="button"
            data-key={code}
            aria-label={label}
            key={code}
            onPointerDown={(event) => setVirtualKey(event, true)}
            onPointerUp={(event) => setVirtualKey(event, false)}
            onPointerCancel={(event) => setVirtualKey(event, false)}
            onPointerLeave={(event) => setVirtualKey(event, false)}
          >
            {symbol}
          </button>
        ))}
      </div>

      <div className={styles.crosshair} aria-hidden="true" />
      <div className={styles.hud} aria-live="polite">
        <b>{activeRoom.name}</b>
        <br />
        <span className={styles.role}>{activeRoom.role}</span>
        <br />
        <span>WASD / direction keys to walk · mouse to look · Shift to move faster · Esc releases mouse</span>
      </div>
    </main>
  );
}
