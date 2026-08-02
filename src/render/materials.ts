/**
 * Matériaux du terrain : un shader unique décliné en trois variantes
 * (opaque, alpha-test, translucide) via des `defines`.
 *
 * Les données de sommet sont compactées par le mailleur dans un seul flottant
 * (`vdata`) : index de texture, occlusion ambiante, lumière du ciel, lumière de
 * bloc, mode d'animation et appartenance à la surface d'un fluide.
 */

import { DoubleSide, FrontSide, GLSL3, ShaderMaterial, type Texture } from 'three';
import type { EnvUniforms } from './env';

export const TERRAIN_VERTEX = /* glsl */ `
precision highp float;
precision highp int;

in vec3 tint;
in float vdata;

uniform float uTime;
uniform float uRain;
uniform mat4 uShadowMatrix;
uniform float uShadowStrength;

out vec4 vShadowCoord;
out vec2 vUv;
out vec3 vTint;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vLight;
out float vAO;
out float vFogDepth;
flat out int vLayer;
flat out int vWave;

// Les teintes sont stockées en sRGB (octets) : il faut les linéariser, sinon
// tout le rendu paraît délavé.
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

void main() {
  int d = int(vdata + 0.5);
  vLayer = d & 511;
  float ao = float((d >> 9) & 3);
  vLight = vec2(float((d >> 11) & 15), float((d >> 15) & 15)) / 15.0;
  vWave = (d >> 19) & 3;
  bool fluidTop = ((d >> 21) & 1) == 1;

  vAO = mix(0.42, 1.0, ao / 3.0);
  vTint = srgbToLinear(tint);
  vUv = uv;

  vec3 pos = position;
  vec4 world = modelMatrix * vec4(pos, 1.0);

  if (vWave == 3) {
    // Végétation : oscillation pondérée par la hauteur dans le quad.
    float sway = sin(uTime * 1.9 + world.x * 0.65 + world.z * 0.5) * 0.055
               + sin(uTime * 3.3 + world.z * 1.1) * 0.02;
    sway *= (1.0 + uRain * 1.6);
    world.xz += sway * uv.y;
  } else if (vWave == 1) {
    // Feuillage : micro-mouvement d'ensemble.
    float sway = sin(uTime * 1.3 + world.x * 0.4 + world.y * 0.2 + world.z * 0.35) * 0.028;
    world.xz += sway * (1.0 + uRain);
  } else if (vWave == 2 && fluidTop) {
    // Houle de la surface des fluides.
    float w = sin(world.x * 1.1 + uTime * 1.7) * 0.5 + sin(world.z * 0.9 - uTime * 1.3) * 0.5;
    world.y += w * 0.035;
  }

  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);

  // Décalage le long de la normale : supprime l'auto-ombrage en « rayures ».
  vShadowCoord = uShadowStrength > 0.0
    ? uShadowMatrix * vec4(world.xyz + vNormal * 0.035, 1.0)
    : vec4(0.0);

  vec4 mv = viewMatrix * world;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const TERRAIN_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyLight;
uniform vec3 uBlockLight;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform vec3 uFogSky;
uniform float uFogDensity;
uniform float uDayFactor;
uniform int uUnderwater;
uniform vec3 uCameraPos;
uniform sampler2D uShadowMap;
uniform float uShadowStrength;
uniform float uShadowTexel;
uniform float uShadowRadius;

in vec4 vShadowCoord;
in vec2 vUv;
in vec3 vTint;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vLight;
in float vAO;
in float vFogDepth;
flat in int vLayer;
flat in int vWave;
layout(location = 0) out vec4 fragColor;

/**
 * Fraction de lumière solaire atteignant le fragment.
 * PCF 3x3 sur la carte de profondeur, avec biais dépendant de l'inclinaison et
 * fondu progressif au bord de la zone couverte.
 */
float sunVisibility(vec3 n) {
  if (uShadowStrength <= 0.0) return 1.0;
  vec3 proj = vShadowCoord.xyz / vShadowCoord.w;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;

  float slope = 1.0 - clamp(dot(n, uSunDir), 0.0, 1.0);
  float bias = 0.00035 + 0.0022 * slope;

  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 off = vec2(float(x), float(y)) * uShadowTexel;
      float depth = texture(uShadowMap, proj.xy + off).r;
      sum += proj.z - bias > depth ? 0.0 : 1.0;
    }
  }
  float vis = sum / 9.0;

  // Estompe l'ombre près du bord de la carte pour éviter une coupure nette.
  vec2 edge = abs(proj.xy - 0.5) * 2.0;
  float fade = 1.0 - smoothstep(0.82, 1.0, max(edge.x, edge.y));
  return mix(1.0, vis, fade * uShadowStrength);
}

// Luminosité par orientation de face : lisibilité du relief façon voxel.
float faceShade(vec3 n) {
  float up = max(n.y, 0.0);
  float down = max(-n.y, 0.0);
  float sideX = abs(n.x);
  float sideZ = abs(n.z);
  return up * 1.0 + down * 0.52 + sideX * 0.68 + sideZ * 0.82;
}

void main() {
  vec2 duvx = dFdx(vUv);
  vec2 duvy = dFdy(vUv);
  vec4 texel = textureGrad(uAtlas, vec3(fract(vUv), float(vLayer)), duvx, duvy);

  #ifdef CUTOUT
    if (texel.a < 0.5) discard;
  #endif

  vec3 albedo = texel.rgb * vTint;

  // --- Éclairage voxel ---------------------------------------------------
  float sky = vLight.x;
  float blk = vLight.y;
  vec3 n = normalize(vNormal);
  // Seule la lumière du soleil est occultée : les torches traversent l'ombre.
  float shadow = sunVisibility(n);
  vec3 skyTerm = uSkyLight * pow(sky, 1.35) * uDayFactor * mix(0.32, 1.0, shadow);
  vec3 blockTerm = uBlockLight * pow(blk, 1.45);
  vec3 lighting = max(skyTerm, blockTerm);
  // L'ambiante ne s'ajoute que là où la scène est sombre : en plein jour elle
  // délaverait l'image.
  float lit = clamp(max(max(lighting.r, lighting.g), lighting.b), 0.0, 1.0);
  lighting += uAmbient * (1.0 - lit * 0.85);
  // Lueur résiduelle du ciel nocturne, pour ne jamais tomber au noir absolu.
  lighting = max(lighting, uAmbient * (0.35 + 0.65 * sky));

  float shade = faceShade(n);
  // Petit apport directionnel : les faces tournées vers le soleil ressortent.
  float sunFacing = max(dot(n, uSunDir), 0.0);
  lighting *= shade * (0.92 + 0.16 * sunFacing * uDayFactor * shadow);
  lighting *= vAO;

  vec3 color = albedo * lighting;

  // --- Reflets et transparence des fluides -------------------------------
  float alpha = texel.a;
  #ifdef WATER
    vec3 V = normalize(uCameraPos - vWorld);
    // Ondulation de la normale par deux vagues croisées.
    float r1 = sin(vWorld.x * 2.3 + uTime * 1.9) * 0.5 + sin(vWorld.z * 1.7 - uTime * 1.4) * 0.5;
    float r2 = sin(vWorld.x * 0.9 - uTime * 1.1) * 0.5 + sin(vWorld.z * 3.1 + uTime * 2.2) * 0.5;
    vec3 nn = normalize(n + vec3(r1, 0.0, r2) * 0.14);
    vec3 H = normalize(V + uSunDir);
    // Scintillement : un lobe large plus un piqué serré, tous deux éteints
    // lorsque la surface est à l'ombre.
    float spec = pow(max(dot(nn, H), 0.0), 110.0) * 1.0
               + pow(max(dot(nn, H), 0.0), 900.0) * 2.4;
    spec *= uDayFactor * shadow;
    float fres = pow(1.0 - clamp(dot(nn, V), 0.0, 1.0), 4.0);
    color += uSunColor * spec * 1.6 * sky;
    color = mix(color, uFogSky * (0.35 + 0.65 * uDayFactor), fres * 0.45 * sky);
    alpha = mix(alpha, 1.0, fres * 0.5);
    if (uUnderwater == 1) alpha *= 0.35;
  #endif

  // --- Brouillard atmosphérique ------------------------------------------
  vec3 viewDir = normalize(vWorld - uCameraPos);
  float horizonBlend = smoothstep(-0.15, 0.35, viewDir.y);
  vec3 fogCol = mix(uFogColor, uFogSky, horizonBlend);
  float density = uFogDensity * (uUnderwater == 1 ? 5.5 : 1.0);
  if (uUnderwater == 1) fogCol = vec3(0.06, 0.22, 0.34) * (0.35 + 0.65 * uDayFactor);
  float fog = 1.0 - exp(-pow(max(vFogDepth - 8.0, 0.0) * density, 1.8));
  color = mix(color, fogCol, clamp(fog, 0.0, 1.0));

  fragColor = vec4(color, alpha);
}
`;

export type TerrainVariant = 'opaque' | 'cutout' | 'water';

export function createTerrainMaterial(variant: TerrainVariant, atlas: Texture, env: EnvUniforms): ShaderMaterial {
  const defines: Record<string, boolean> = {};
  if (variant === 'cutout') defines.CUTOUT = true;
  if (variant === 'water') defines.WATER = true;

  const m = new ShaderMaterial({
    glslVersion: GLSL3,
    defines,
    uniforms: {
      uAtlas: { value: atlas },
      uTime: env.uTime,
      uSunDir: env.uSunDir,
      uSunColor: env.uSunColor,
      uSkyLight: env.uSkyLight,
      uBlockLight: env.uBlockLight,
      uAmbient: env.uAmbient,
      uFogColor: env.uFogColor,
      uFogSky: env.uFogSky,
      uFogDensity: env.uFogDensity,
      uDayFactor: env.uDayFactor,
      uUnderwater: env.uUnderwater,
      uCameraPos: env.uCameraPos,
      uRain: env.uRain,
      uShadowMap: env.uShadowMap,
      uShadowMatrix: env.uShadowMatrix,
      uShadowStrength: env.uShadowStrength,
      uShadowTexel: env.uShadowTexel,
      uShadowRadius: env.uShadowRadius,
    },
    vertexShader: TERRAIN_VERTEX,
    fragmentShader: TERRAIN_FRAGMENT,
    transparent: variant === 'water',
    depthWrite: variant !== 'water',
    side: variant === 'cutout' ? DoubleSide : FrontSide,
  });
  m.name = `terrain-${variant}`;
  return m;
}

// ---------------------------------------------------------------------------
// Passe d'ombre
// ---------------------------------------------------------------------------

/**
 * Rendu de profondeur vu du soleil. Reproduit exactement le déplacement animé
 * des sommets du terrain, faute de quoi les ombres du feuillage « nageraient »
 * par rapport à la géométrie.
 *
 * Le même matériau sert aux entités : leur géométrie ne fournit pas `vdata`,
 * l'attribut vaut donc 0, l'index de texture est 0 (`air`) et le test alpha est
 * ignoré — une créature projette une ombre pleine, ce qui est le bon résultat.
 */
const SHADOW_VERTEX = /* glsl */ `
precision highp float;
precision highp int;

in float vdata;
uniform float uTime;
uniform float uRain;

out vec2 vUv;
flat out int vLayer;

void main() {
  int d = int(vdata + 0.5);
  vLayer = d & 511;
  int wave = (d >> 19) & 3;
  bool fluidTop = ((d >> 21) & 1) == 1;
  vUv = uv;

  vec4 world = modelMatrix * vec4(position, 1.0);
  if (wave == 3) {
    float sway = sin(uTime * 1.9 + world.x * 0.65 + world.z * 0.5) * 0.055
               + sin(uTime * 3.3 + world.z * 1.1) * 0.02;
    sway *= (1.0 + uRain * 1.6);
    world.xz += sway * uv.y;
  } else if (wave == 1) {
    float sway = sin(uTime * 1.3 + world.x * 0.4 + world.y * 0.2 + world.z * 0.35) * 0.028;
    world.xz += sway * (1.0 + uRain);
  } else if (wave == 2 && fluidTop) {
    float w = sin(world.x * 1.1 + uTime * 1.7) * 0.5 + sin(world.z * 0.9 - uTime * 1.3) * 0.5;
    world.y += w * 0.035;
  }
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const SHADOW_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;
in vec2 vUv;
flat in int vLayer;
layout(location = 0) out vec4 fragColor;

void main() {
  // Les feuillages doivent laisser passer la lumière par leurs trous.
  if (vLayer > 0) {
    float a = texture(uAtlas, vec3(fract(vUv), float(vLayer))).a;
    if (a < 0.5) discard;
  }
  fragColor = vec4(1.0);
}
`;

export function createShadowMaterial(atlas: Texture, env: EnvUniforms): ShaderMaterial {
  const m = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      uAtlas: { value: atlas },
      uTime: env.uTime,
      uRain: env.uRain,
    },
    vertexShader: SHADOW_VERTEX,
    fragmentShader: SHADOW_FRAGMENT,
    side: DoubleSide,
    colorWrite: false,
  });
  m.name = 'terrain-shadow';
  return m;
}
