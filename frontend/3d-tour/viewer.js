import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

function showFailure(message){
 document.querySelector("#loadStatus").textContent=message;
 document.querySelector("#loadStatus").setAttribute("role","alert");
 document.querySelector("#welcome").style.display="grid";
 document.querySelector("#reloadTour").hidden=false;
 document.querySelectorAll("#startTour,#immerse,#exterior,#jump").forEach(button=>button.disabled=true);
}
document.querySelector("#reloadTour").onclick=()=>location.reload();
function bootTour(){
function requestLookControl(){
 try{const lock=renderer.domElement.requestPointerLock?.();lock?.catch?.(()=>{});}catch{}
}
const rooms=[
 {name:"Entrance & Check-in",floor:"First floor",role:"Welcome desks, information screens and queueing",p:[-10,1.4,-7.6],v:[-12.0,-3.8],a:-.48},
 {name:"Sponsors Galleria",floor:"First floor",role:"Branded demo booths, monitors and sponsor corridor",p:[-5.1,1.5,1.7],v:[-3.3,1.7]},
 {name:"Food",floor:"First floor",role:"Buffet counters, menu band, drink station and café tables",p:[8.6,1.4,8.1],v:[9.8,6.0]},
 {name:"Hacking Area — Collins Room",floor:"First floor",role:"Laptop workstations, shared power and presentation display",p:[10.5,1.5,2.7],v:[7.0,2.5]},
 {name:"Hacking Area — Collins Patio",floor:"First floor · outdoors",role:"Shaded outdoor hacking tables and planting",p:[20.5,1.2,4.0],v:[18.3,4.0]},
 {name:"Hacking Area — Founders’ Room",floor:"First floor",role:"Team tables, laptops, whiteboard and lounge seating",p:[2.1,1.5,-8.1],v:[-1.2,-8.1]},
 {name:"Hacking Area — Founders’ Patio",floor:"First floor · outdoors",role:"Outdoor worktables beneath a shade canopy",p:[10.7,1.2,-15.1],v:[10.7,-12.2]},
 {name:"Restrooms",floor:"First floor",role:"Wayfinding, privacy partitions, sinks and mirrors",p:[1.7,1.5,-2.2],v:[1.7,-4.1]},
 {name:"Stairs to Second Floor",floor:"East side",role:"Exterior stair connecting both event levels",p:[17.5,2.3,-.5],v:[17.5,-2.7]},
 {name:"Workshops",floor:"Second floor",role:"Teaching stage, projection screen and classroom tables",p:[.7,5.6,0],v:[-4.2,0]},
 {name:"Networking — Northeast Patio",floor:"Second floor",role:"Cocktail tables, lounge seating, planters and warm lights",p:[8.4,5.6,7.2],v:[4.2,7.1]}
];
let modelReady=false;
const scene=new THREE.Scene();scene.background=new THREE.Color(0xdce6ef);scene.fog=new THREE.Fog(0xdce6ef,58,108);
const camera=new THREE.PerspectiveCamera(58,innerWidth/innerHeight,.08,220);camera.position.set(-10,1.72,-5.9);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;document.querySelector("#view").appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xeaf4ff,0x6b6254,2.15));const sun=new THREE.DirectionalLight(0xfff3db,3.2);sun.position.set(-22,34,-18);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);scene.add(sun);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(-10,1.72,2);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.49;controls.minDistance=.8;controls.maxDistance=92;controls.update();
new GLTFLoader().load("/3d-tour/james-west-alumni-center-concept.glb",g=>{
 g.scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});
 scene.add(g.scene);modelReady=true;
 document.querySelector("#loadStatus").textContent="The concept is ready to explore.";
 document.querySelectorAll("#startTour,#immerse,#exterior,#jump").forEach(button=>button.disabled=false);
},undefined,()=>showFailure("We could not load the building model. Please reload the tour to try again."));

const labels=document.querySelector("#labels"),list=document.querySelector("#placeList"),jump=document.querySelector("#jump");
rooms.forEach((r,i)=>{
 const tag=document.createElement("button");tag.className="tag";tag.textContent=r.name;tag.onclick=()=>focusRoom(i);labels.appendChild(tag);r.tag=tag;
 const row=document.createElement("button");row.className="place";row.innerHTML=r.name+"<small>"+r.floor+" · "+r.role+"</small>";row.onclick=()=>focusRoom(i);list.appendChild(row);
 const option=document.createElement("option");option.value=i;option.textContent=r.name;jump.appendChild(option);
});
function focusRoom(i){startImmerse(i)}
function exterior(){if(!modelReady)return;exitImmerse();camera.position.set(34,27,38);controls.target.set(1,3,-2);controls.update()}
document.querySelector("#exterior").onclick=exterior;
jump.onchange=()=>{if(jump.value!==""){startImmerse(Number(jump.value));jump.value=""}};

let immersive=false,yaw=Math.PI,pitch=0,last=performance.now();const keys={};
function startImmerse(roomIndex=0){
 if(!modelReady)return;
 immersive=true;document.body.classList.add("immersive");controls.enabled=false;
 const r=rooms[roomIndex],second=r.p[1]>3;camera.position.set(r.v[0],second?5.72:1.72,r.v[1]);yaw=r.a??Math.PI;pitch=0;requestLookControl();
 document.querySelector("#immerse").textContent="Exit tour";
 document.querySelector("#welcome").style.display="none";
 renderer.domElement.tabIndex=0;renderer.domElement.focus();
}
function exitImmerse(){
 if(!immersive)return;immersive=false;document.body.classList.remove("immersive");controls.enabled=true;document.exitPointerLock?.();document.querySelector("#immerse").textContent="Start walking";
}
document.querySelector("#immerse").onclick=()=>immersive?exitImmerse():startImmerse();
document.querySelector("#startTour").onclick=()=>startImmerse(0);
renderer.domElement.addEventListener("click",()=>{if(immersive&&document.pointerLockElement!==renderer.domElement)requestLookControl()});
addEventListener("mousemove",e=>{if(immersive&&document.pointerLockElement===renderer.domElement){yaw-=e.movementX*.0022;pitch=Math.max(-1.25,Math.min(1.25,pitch-e.movementY*.0022))}});
const arrowCodes=new Set(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"]);
addEventListener("keydown",e=>{if(arrowCodes.has(e.code)){e.preventDefault();e.stopPropagation()}keys[e.code]=true},{capture:true});
addEventListener("keyup",e=>{if(arrowCodes.has(e.code)){e.preventDefault();e.stopPropagation()}keys[e.code]=false},{capture:true});
addEventListener("blur",()=>{for(const k in keys)keys[k]=false});
document.querySelectorAll(".dpad button").forEach(button=>{
 const code=button.dataset.key;
 const down=e=>{e.preventDefault();keys[code]=true;button.classList.add("active")};
 const up=e=>{e.preventDefault();keys[code]=false;button.classList.remove("active")};
 button.addEventListener("pointerdown",down);button.addEventListener("pointerup",up);button.addEventListener("pointercancel",up);button.addEventListener("pointerleave",up);
});
function updateWalk(dt){
 if(keys.ArrowLeft)yaw+=dt*1.9;if(keys.ArrowRight)yaw-=dt*1.9;
 camera.rotation.order="YXZ";camera.rotation.set(pitch,yaw,0);
 const forward=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw));
 const right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw));
 const move=new THREE.Vector3();
 if(keys.KeyW||keys.ArrowUp)move.add(forward);if(keys.KeyS||keys.ArrowDown)move.sub(forward);
 if(keys.KeyD)move.add(right);if(keys.KeyA)move.sub(right);
 if(move.lengthSq())camera.position.add(move.normalize().multiplyScalar(dt*(keys.ShiftLeft||keys.ShiftRight?8:3.6)));
 const onSecond=camera.position.y>3;
 if(camera.position.x>15.6&&camera.position.x<19.3&&camera.position.z>-3.8&&camera.position.z<2.7){
   camera.position.y=Math.max(1.72,Math.min(5.72,1.72+(camera.position.z+3.2)*.72));
 }else camera.position.y=onSecond?5.72:1.72;
 let nearest=rooms[0],dist=1e9;for(const r of rooms){const dy=Math.abs(camera.position.y-r.p[1]);const d=Math.hypot(camera.position.x-r.p[0],camera.position.z-r.p[2])+dy*2;if(d<dist){dist=d;nearest=r}}
 document.querySelector("#zone").textContent=nearest.name;
 document.querySelector("#zoneRole").textContent=nearest.role;
}
function projectLabels(){
 const w=innerWidth,h=innerHeight;
 for(const r of rooms){const v=new THREE.Vector3(...r.p).project(camera);const visible=v.z>-1&&v.z<1;r.tag.style.display=visible?"block":"none";r.tag.style.left=(v.x*.5+.5)*w+"px";r.tag.style.top=(-v.y*.5+.5)*h+"px";}
}
addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
renderer.setAnimationLoop(t=>{const dt=Math.min(.05,(t-last)/1000);last=t;if(immersive)updateWalk(dt);else{controls.update();projectLabels()}renderer.render(scene,camera)});
}
try{bootTour()}catch{showFailure("Your browser could not start the 3D view. Please enable WebGL or try a different browser.")}
