/**
 * Matériau des entités : cubes colorés éclairés par la lumière voxel locale,
 * avec le même brouillard que le terrain pour une intégration parfaite.
 */

import { GLSL3, ShaderMaterial, Color, Vector3 } from 'three';
import type { EnvUniforms } from './env';

const VERT = /* glsl */ `
in vec3 tint;
out vec3 vTint;
out vec3 vNormal;
out vec3 vWorld;
out float vFogDepth;
out vec4 vShadowCoord;
uniform mat4 uShadowMatrix;
uniform float uShadowStrength;
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
void main() {
  vTint = srgbToLinear(tint);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vShadowCoord = uShadowStrength > 0.0
    ? uShadowMatrix * vec4(world.xyz + vNormal * 0.04, 1.0)
    : vec4(0.0);
  vec4 mv = viewMatrix * world;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform vec3 uLight;
uniform vec3 uFogColor;
uniform vec3 uFogSky;
uniform float uFogDensity;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform float uDayFactor;
uniform int uUnderwater;
uniform float uFlash;
uniform float uOpacity;
uniform sampler2D uShadowMap;
uniform float uShadowStrength;
uniform float uShadowTexel;

in vec3 vTint;
in vec3 vNormal;
in vec3 vWorld;
in float vFogDepth;
in vec4 vShadowCoord;
layout(location = 0) out vec4 fragColor;

float sunVisibility() {
  if (uShadowStrength <= 0.0) return 1.0;
  vec3 proj = vShadowCoord.xyz / vShadowCoord.w;
  if (proj.z > 1.0 || proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0) return 1.0;
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float depth = texture(uShadowMap, proj.xy + vec2(float(x), float(y)) * uShadowTexel).r;
      sum += proj.z - 0.0016 > depth ? 0.0 : 1.0;
    }
  }
  vec2 edge = abs(proj.xy - 0.5) * 2.0;
  float fade = 1.0 - smoothstep(0.82, 1.0, max(edge.x, edge.y));
  return mix(1.0, sum / 9.0, fade * uShadowStrength);
}

void main() {
  vec3 n = normalize(vNormal);
  float shade = 0.55 + 0.45 * max(n.y, 0.0) + 0.18 * abs(n.x) + 0.1 * abs(n.z);
  float shadow = sunVisibility();
  shade *= 0.92 + 0.18 * max(dot(n, uSunDir), 0.0) * uDayFactor * shadow;
  vec3 color = vTint * uLight * shade * mix(0.55, 1.0, shadow);
  color = mix(color, vec3(1.0, 0.35, 0.3), uFlash);

  vec3 viewDir = normalize(vWorld - uCameraPos);
  vec3 fogCol = mix(uFogColor, uFogSky, smoothstep(-0.15, 0.35, viewDir.y));
  float density = uFogDensity * (uUnderwater == 1 ? 5.5 : 1.0);
  if (uUnderwater == 1) fogCol = vec3(0.06, 0.22, 0.34) * (0.35 + 0.65 * uDayFactor);
  float fog = 1.0 - exp(-pow(max(vFogDepth - 8.0, 0.0) * density, 1.8));
  color = mix(color, fogCol, clamp(fog, 0.0, 1.0));

  fragColor = vec4(color, uOpacity);
}
`;

export function createEntityMaterial(env: EnvUniforms): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      uLight: { value: new Color(1, 1, 1) },
      uFogColor: env.uFogColor,
      uFogSky: env.uFogSky,
      uFogDensity: env.uFogDensity,
      uCameraPos: env.uCameraPos,
      uSunDir: env.uSunDir,
      uDayFactor: env.uDayFactor,
      uUnderwater: env.uUnderwater,
      uFlash: { value: 0 },
      uOpacity: { value: 1 },
      uShadowMap: env.uShadowMap,
      uShadowMatrix: env.uShadowMatrix,
      uShadowStrength: env.uShadowStrength,
      uShadowTexel: env.uShadowTexel,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}

/** Convertit la lumière voxel (0-15) en couleur d'éclairage perçue. */
const skyCol = new Vector3();
export function voxelLightColor(sky: number, block: number, dayFactor: number, out: Color): Color {
  const s = Math.pow(sky / 15, 1.35) * dayFactor;
  const b = Math.pow(block / 15, 1.45);
  skyCol.set(s, s, s * 1.03);
  const r = Math.max(skyCol.x, b * 1.0);
  const g = Math.max(skyCol.y, b * 0.72);
  const bl = Math.max(skyCol.z, b * 0.42);
  const amb = 0.075 + 0.06 * dayFactor;
  out.setRGB(r + amb, g + amb, bl + amb * 1.2);
  return out;
}
