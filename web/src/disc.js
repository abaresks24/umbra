// The umbral disc — Umbra's signature element, drawn with a hand-written WebGL
// fragment shader (no library; a few KB). A dark moon ringed by a corona over a
// sinking sun. State is driven by a handful of uniforms that lerp toward targets:
//   occ     0..1  occultation (1 = sun fully behind the disc, deep shadow)
//   reveal  0..1  balance revealed -> corona brightens
//   flare   0..1  transient corona flare (peaks mid-occultation)
// Honours prefers-reduced-motion (static frame, no RAF loop, no animated grain).

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime, uOcc, uReveal, uFlare, uStill;

const vec3 UMBRA  = vec3(0.051,0.039,0.071);
const vec3 EMBER  = vec3(0.949,0.576,0.235);
const vec3 CORAL  = vec3(0.933,0.416,0.302);
const vec3 ROSE   = vec3(0.878,0.333,0.420);
const vec3 PERI   = vec3(0.486,0.420,0.839);
const vec3 CORONA = vec3(1.000,0.886,0.651);

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }

vec3 horizon(float a){
  a = fract(a);
  if(a < 0.34) return mix(EMBER, CORAL, a/0.34);
  if(a < 0.67) return mix(CORAL, ROSE, (a-0.34)/0.33);
  return mix(ROSE, PERI, (a-0.67)/0.33);
}

void main(){
  vec2 uv = vUv*2.0 - 1.0;
  uv.x *= uRes.x/uRes.y;
  float d = length(uv);
  float ang = atan(uv.y, uv.x)/6.2831853 + 0.5;
  float t = mix(uTime, 0.0, uStill);

  float R = 0.6;

  // sun: starts beside the disc (upper-right), slides behind as occ -> 1
  vec2 sunPos = mix(vec2(0.46,0.34), vec2(0.0,0.0), uOcc);
  float sd = length(uv - sunPos);
  float sun = exp(-pow(sd/(0.30*(1.0-0.45*uOcc)), 2.0)) * (1.0 - 0.65*uOcc);

  // corona ring centred on the disc edge, breathing slightly
  float breathe = 0.013*sin(t*0.5 + ang*6.2831853);
  float ringW = 0.052 + breathe + 0.02*uFlare;
  float ring = exp(-pow((d-R)/ringW, 2.0));
  float halo = exp(-pow(max(d-R,0.0)/0.55, 1.5));

  vec3 col = UMBRA;

  // disc interior — deep violet shadow, darker still when fully eclipsed
  float inside = smoothstep(R+0.004, R-0.004, d);
  col = mix(col, UMBRA*mix(0.95,0.45,uOcc), inside);

  // ring: horizon gradient, washed toward corona as the balance is revealed
  vec3 ringCol = mix(horizon(ang + 0.06*sin(t*0.15)), CORONA, 0.30 + 0.45*uReveal);
  float ringI = ring*(0.85 + 0.7*uReveal) + halo*0.28;
  col += ringCol*ringI;

  // warmth bleeding from the sun behind the limb
  col += mix(EMBER, ROSE, 0.5)*sun*0.85;

  // corona flare (transient, the occultation crescendo)
  col += CORONA*ring*uFlare*0.9;

  // film grain (frozen when still)
  float g = hash(vUv*uRes.xy*0.5 + floor(t*24.0));
  col += (g-0.5)*0.022*(1.0-0.7*uStill);

  // Coverage as ALPHA so the square canvas blends seamlessly into the page:
  // opaque across the dark moon + ring + halo + sun, fully transparent at corners.
  float alpha = clamp(max(inside, ring*1.25 + halo*0.7 + sun*0.7), 0.0, 1.0);
  alpha *= smoothstep(1.14, 0.80, d);
  alpha = max(alpha, inside);
  gl_FragColor = vec4(col, alpha);
}`;

const VERT = `attribute vec2 p; varying vec2 vUv; void main(){ vUv=p*0.5+0.5; gl_Position=vec4(p,0.0,1.0); }`;

export function createDisc(canvas) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false });
  // state: current + target for smooth lerp
  const cur = { occ: 0.74, reveal: 0, flare: 0 };
  const tgt = { occ: 0.74, reveal: 0, flare: 0 };
  let raf = 0, t0 = performance.now(), U = {};

  if (!gl) return cssFallback(canvas, cur, tgt); // graceful degrade

  const prog = link(gl, VERT, FRAG);
  if (!prog) return cssFallback(canvas, cur, tgt);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  for (const u of ["uRes", "uTime", "uOcc", "uReveal", "uFlare", "uStill"]) U[u] = gl.getUniformLocation(prog, u);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw(now) {
    const k = reduced ? 1 : 0.12; // lerp speed
    cur.occ += (tgt.occ - cur.occ) * k;
    cur.reveal += (tgt.reveal - cur.reveal) * k;
    cur.flare += (tgt.flare - cur.flare) * (reduced ? 1 : 0.08);
    resize();
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, (now - t0) / 1000);
    gl.uniform1f(U.uOcc, cur.occ);
    gl.uniform1f(U.uReveal, cur.reveal);
    gl.uniform1f(U.uFlare, cur.flare);
    gl.uniform1f(U.uStill, reduced ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduced) raf = requestAnimationFrame(draw);
  }

  if (reduced) { resize(); requestAnimationFrame(draw); }
  else raf = requestAnimationFrame(draw);

  return makeApi(cur, tgt, reduced, () => { if (reduced) requestAnimationFrame(draw); });
}

// Shared control surface for both WebGL and CSS-fallback discs.
function makeApi(cur, tgt, reduced, kick) {
  let flareTimer = 0;
  const api = {
    reveal(on) { tgt.reveal = on ? 1 : 0; kick(); },
    idle() { tgt.occ = 0.74; tgt.flare = 0; kick(); },
    // the occultation: sun slips fully behind, corona flares, holds in shadow
    occult() {
      tgt.occ = 1; tgt.flare = 1; kick();
      clearTimeout(flareTimer);
      flareTimer = setTimeout(() => { tgt.flare = 0.15; kick(); }, reduced ? 0 : 1100);
    },
    settle() { tgt.occ = 0.92; tgt.flare = 0; kick(); }, // proof done — rests in shadow
    get current() { return cur; },
  };
  return api;
}

function link(gl, vs, fs) {
  const c = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const v = c(gl.VERTEX_SHADER, vs), f = c(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}

// No WebGL → a calm layered-gradient disc via a class on the canvas's parent.
function cssFallback(canvas, cur, tgt) {
  canvas.classList.add("disc-css");
  const apply = () => {
    canvas.style.setProperty("--occ", cur.occ.toFixed(2));
    canvas.style.setProperty("--rev", cur.reveal.toFixed(2));
  };
  apply();
  return makeApi(cur, tgt, true, () => { cur.occ = tgt.occ; cur.reveal = tgt.reveal; apply(); });
}
