/**
 * Dôme céleste procédural : dégradé atmosphérique, disque solaire, lune avec
 * phase, champ d'étoiles et couche nuageuse projetée en perspective.
 *
 * Tout est calculé dans le fragment shader ; aucune texture n'est nécessaire.
 */

import { BackSide, Color, GLSL3, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import type { EnvUniforms } from './env';

const SKY_VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  // Projeté sur le plan lointain : le ciel ne masque jamais la géométrie.
  gl_Position = p.xyww;
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uNight;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uDayFactor;
uniform float uStarStrength;
uniform float uCloudCover;
uniform float uRain;
uniform vec3 uCameraPos;
uniform int uUnderwater;
uniform vec3 uFogColor;

in vec3 vDir;
layout(location = 0) out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * valueNoise(p);
    p = rot * p * 2.02;
    a *= 0.5;
  }
  return v;
}

// Champ d'étoiles : grille hachée, quelques cellules allumées.
float stars(vec3 dir) {
  vec3 d = dir * 220.0;
  vec3 id = floor(d);
  vec3 f = fract(d) - 0.5;
  float h = hash21(id.xy + id.z * 37.0);
  if (h < 0.985) return 0.0;
  float twinkle = 0.65 + 0.35 * sin(uTime * 2.2 + h * 400.0);
  return smoothstep(0.42, 0.0, length(f)) * twinkle;
}

void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;

  // Dégradé jour.
  float t = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 0.65);
  vec3 dayCol = mix(uHorizon, uZenith, smoothstep(0.45, 1.0, t));
  dayCol = mix(uHorizon, dayCol, smoothstep(-0.05, 0.25, up));

  vec3 col = mix(uNight, dayCol, uDayFactor);

  // Halo chaud autour du soleil (diffusion de Mie approchée).
  float sunDot = max(dot(dir, uSunDir), 0.0);
  float haze = pow(sunDot, 8.0) * 0.35 + pow(sunDot, 2.0) * 0.09;
  col += uSunColor * haze * uDayFactor * (1.0 - clamp(abs(up) * 0.8, 0.0, 1.0) * 0.4);

  // Étoiles (avant les nuages pour qu'ils les masquent).
  float night = 1.0 - uDayFactor;
  col += vec3(0.95, 0.96, 1.0) * stars(dir) * uStarStrength * night;

  // Disque solaire.
  float sunDisc = smoothstep(0.99915, 0.99975, sunDot);
  col += uSunColor * sunDisc * 14.0 * max(uDayFactor, 0.15);

  // Lune et sa phase.
  float moonDot = dot(dir, uMoonDir);
  float moonDisc = smoothstep(0.9990, 0.99955, moonDot);
  if (moonDisc > 0.0) {
    vec3 tangent = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(0.001));
    float offset = dot(normalize(dir - uMoonDir * moonDot), tangent);
    float phase = sin(uTime * 0.0037) * 0.9;
    float lit = smoothstep(phase - 0.25, phase + 0.25, offset);
    col += vec3(0.88, 0.9, 1.0) * moonDisc * (0.35 + 1.6 * lit) * night;
  }

  // Couche nuageuse projetée à altitude constante.
  if (up > 0.015) {
    float h = 260.0;
    float dist = h / up;
    vec2 p = (uCameraPos.xz + dir.xz * dist) * 0.0016;
    p += vec2(uTime * 0.0055, uTime * 0.0022);
    float n = fbm(p * 1.6);
    float cover = mix(0.72, 0.30, clamp(uCloudCover + uRain * 0.35, 0.0, 1.0));
    float density = smoothstep(cover, cover + 0.22, n);
    density *= smoothstep(0.015, 0.13, up);          // atténuation vers l'horizon
    density *= 1.0 - smoothstep(1200.0, 4200.0, dist);
    float shading = smoothstep(cover - 0.05, cover + 0.35, n);
    vec3 lightSide = mix(vec3(0.55, 0.58, 0.66), vec3(1.02, 1.0, 0.97), shading);
    vec3 cloudCol = lightSide * mix(0.25, 1.0, uDayFactor);
    cloudCol = mix(cloudCol, cloudCol * vec3(1.15, 0.85, 0.7), pow(sunDot, 3.0) * uDayFactor);
    cloudCol *= mix(1.0, 0.55, uRain);
    col = mix(col, cloudCol, density * 0.92);
  }

  // Voile de brume à l'horizon pour raccorder au brouillard du terrain.
  col = mix(col, uFogColor, smoothstep(0.12, -0.08, up) * 0.85);

  if (uUnderwater == 1) col = mix(col, vec3(0.05, 0.20, 0.32), 0.86);

  fragColor = vec4(col, 1.0);
}
`;

export class Sky {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;

  constructor(env: EnvUniforms) {
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: {
        uZenith: env.uZenith,
        uHorizon: env.uHorizon,
        uNight: env.uNight,
        uSunDir: env.uSunDir,
        uMoonDir: env.uMoonDir,
        uSunColor: env.uSunColor,
        uTime: env.uTime,
        uDayFactor: env.uDayFactor,
        uStarStrength: env.uStarStrength,
        uCloudCover: env.uCloudCover,
        uRain: env.uRain,
        uCameraPos: env.uCameraPos,
        uUnderwater: env.uUnderwater,
        uFogColor: env.uFogColor,
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 32, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
  }
}

/**
 * Palette du ciel en fonction de l'heure. `t` va de 0 (minuit) à 1 (minuit
 * suivant) ; 0.25 correspond à l'aube et 0.75 au crépuscule.
 */
export interface SkyState {
  sunDir: Vector3;
  dayFactor: number;
  zenith: Color;
  horizon: Color;
  fog: Color;
  sunColor: Color;
  skyLight: Color;
  ambient: Color;
  starStrength: number;
}

const DAY_ZENITH = new Color(0.16, 0.36, 0.78);
const DAY_HORIZON = new Color(0.68, 0.82, 0.96);
const DUSK_ZENITH = new Color(0.16, 0.16, 0.42);
const DUSK_HORIZON = new Color(0.98, 0.48, 0.24);
const NIGHT_ZENITH = new Color(0.015, 0.02, 0.06);
const NIGHT_HORIZON = new Color(0.05, 0.07, 0.16);

const tmpA = new Color();
const tmpB = new Color();

export function computeSkyState(dayTime: number, out: SkyState): SkyState {
  // Angle solaire : midi au zénith, minuit au nadir.
  const angle = (dayTime - 0.25) * Math.PI * 2;
  out.sunDir.set(Math.cos(angle), Math.sin(angle), 0.28).normalize();

  const elev = out.sunDir.y;
  // Crépuscule long et progressif : la pleine lumière n'est atteinte que
  // lorsque le soleil est franchement au-dessus de l'horizon.
  const day = smooth(elev, -0.16, 0.17);
  const dusk = Math.max(0, 1 - Math.abs(elev + 0.02) / 0.36);

  out.dayFactor = day;

  tmpA.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, day);
  tmpB.copy(DUSK_ZENITH);
  out.zenith.copy(tmpA).lerp(tmpB, dusk * 0.65);

  tmpA.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day);
  tmpB.copy(DUSK_HORIZON);
  out.horizon.copy(tmpA).lerp(tmpB, dusk * 0.8);

  out.fog.copy(out.horizon).lerp(out.zenith, 0.25);

  // Le soleil rougit près de l'horizon.
  out.sunColor.setRGB(1.0, 0.96, 0.88).lerp(tmpA.setRGB(1.0, 0.55, 0.28), dusk * 0.85);

  out.skyLight.setRGB(1, 1, 1).multiplyScalar(1).lerp(tmpA.setRGB(1.0, 0.78, 0.6), dusk * 0.5);
  const amb = 0.055 + 0.13 * day;
  out.ambient.setRGB(amb * 0.8, amb * 0.86, amb * 1.15);
  out.starStrength = 1 - smooth(elev, -0.22, 0.02);
  return out;
}

function smooth(v: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function createSkyState(): SkyState {
  return {
    sunDir: new Vector3(0, 1, 0),
    dayFactor: 1,
    zenith: new Color(),
    horizon: new Color(),
    fog: new Color(),
    sunColor: new Color(),
    skyLight: new Color(),
    ambient: new Color(),
    starStrength: 0,
  };
}
