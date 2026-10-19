// Shared "toon" ink look: three flat tones (paper, fine checker, black) plus
// crease and silhouette outlines. Used by the sphere, the detail viewer and the
// admin thumbnail renderer so they always match.
import * as THREE from 'three';

export const PAPER = new THREE.Color(0xf4f4f1);


const vert = /* glsl */`
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */`
uniform float uTime;
uniform float uDim;
uniform float uHover;
uniform float uCell;
uniform vec3 uPaper;
varying vec3 vN;
varying vec3 vV;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  if (!gl_FrontFacing) N = -N;

  // Key + fill light with wrap, so every face keeps some tone and the form stays readable.
  vec3 L1 = normalize(vec3(-0.45, 0.75, 0.65));
  vec3 L2 = normalize(vec3(0.7, -0.2, 0.5));
  float diff = clamp(dot(N, L1) * 0.5 + 0.5, 0.0, 1.0);
  float fill = clamp(dot(N, L2) * 0.5 + 0.5, 0.0, 1.0);
  float light = clamp(0.25 + 0.6 * diff + 0.25 * fill, 0.0, 1.0);
  float t = clamp((1.0 - light) / 0.75, 0.0, 1.0);          // 0 = lit, 1 = deepest shadow
  float ndv = max(dot(N, V), 0.0);

  // Outlines: sharp creases + silhouettes.
  float crease = smoothstep(0.08, 0.3, length(fwidth(N)));
  float sil = smoothstep(0.80, 0.93, 1.0 - ndv);
  float edge = max(crease, sil);

  vec2 fc = gl_FragCoord.xy;
  float S = uCell;                                           // pixel scale
  float n2 = hash(floor(fc / S) * 1.7 + 91.0 + floor(uTime * 6.0) * 5.0);

  float chk = mod(floor(fc.x / S) + floor(fc.y / S), 2.0);
  float band = t > 0.40 ? 1.0 : (t > 0.14 ? chk : 0.0);
  float ink = max(edge, band);

  // Hover: bolder.
  ink = max(ink, step(n2, uHover * 0.3));

  vec3 col = mix(uPaper, vec3(0.02), ink);
  col = mix(col, uPaper, uDim * 0.85);
  gl_FragColor = vec4(col, 1.0);
}`;

export function createInkMaterial({ cell = 1.5 } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uDim: { value: 0 },
      uHover: { value: 0 },
      uCell: { value: cell },
      uPaper: { value: PAPER },
    },
  });
}

// Centre a loaded model, fit it in a `size`-unit box, and optionally stand a
// Z-up CAD export upright. Returns a Group whose origin is the model centre.
export function normalizeModel(scene, { size = 3.4, up = 'y', pose = null } = {}) {
  const inner = new THREE.Group();
  inner.add(scene);
  if (up === 'z') inner.rotation.x = -Math.PI / 2;
  if (pose && pose.length === 4) inner.quaternion.premultiply(new THREE.Quaternion(pose[0], pose[1], pose[2], pose[3]));   // the "home view" chosen in the admin
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const k = size / (Math.max(s.x, s.y, s.z) || 1);
  const outer = new THREE.Group();
  inner.position.sub(c);
  const wrap = new THREE.Group();
  wrap.add(inner);
  wrap.scale.setScalar(k);
  outer.add(wrap);
  return outer;
}

export function applyInk(root, material) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.material = material;
      o.frustumCulled = true;
    }
  });
}

// Everything a project page does to a loaded model before showing it, in one place so the sphere, the detail
// viewer and the admin editor agree: drop the parts that were hidden in the admin (by mesh order), stand it up,
// apply the chosen home pose, then centre and fit it. `p` only needs { hidden, up, pose }.
export function prepareModel(gltfScene, p = {}, { size = 3.4 } = {}) {
  const clone = gltfScene.clone(true), hidden = new Set(p.hidden || []), drop = [];
  let i = 0;
  clone.traverse((o) => { if (o.isMesh) { if (hidden.has(i)) drop.push(o); i++; } });
  drop.forEach((o) => o.parent && o.parent.remove(o));
  return normalizeModel(clone, { size, up: p.up || 'y', pose: p.pose });
}
