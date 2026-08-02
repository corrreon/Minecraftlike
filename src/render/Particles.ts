/**
 * Particules : éclats de blocs cassés, gerbes d'eau, étincelles d'explosion,
 * plus une couche météo (pluie / neige) qui suit le joueur.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  GLSL3,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { GRAVITY } from '../core/constants';
import { IS_SOLID } from '../world/blocks';
import type { World } from '../world/World';
import { voxelLightColor } from './entityMaterial';

const MAX_PARTICLES = 600;

interface Particle {
  pos: Vector3;
  vel: Vector3;
  life: number;
  maxLife: number;
  size: number;
  color: Color;
  gravity: number;
  glow: boolean;
}

const PARTICLE_VERT = /* glsl */ `
in vec3 tint;
in float alpha;
out vec3 vTint;
out float vAlpha;
void main() {
  vTint = tint;
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision highp float;
in vec3 vTint;
in float vAlpha;
layout(location = 0) out vec4 fragColor;
void main() {
  fragColor = vec4(vTint, vAlpha);
}
`;

export class ParticleSystem {
  readonly mesh: InstancedMesh;
  private pool: Particle[] = [];
  private active = 0;
  private dummy = new Object3D();
  private colorAttr: InstancedBufferAttribute;
  private alphaAttr: InstancedBufferAttribute;

  constructor(private world: World) {
    const geo = new BoxGeometry(1, 1, 1);
    this.colorAttr = new InstancedBufferAttribute(new Uint8Array(MAX_PARTICLES * 3), 3, true);
    this.alphaAttr = new InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    this.colorAttr.setUsage(DynamicDrawUsage);
    this.alphaAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('tint', this.colorAttr);
    geo.setAttribute('alpha', this.alphaAttr);

    const material = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: {},
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
    });

    this.mesh = new InstancedMesh(geo, material, MAX_PARTICLES);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.name = 'particles';

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({
        pos: new Vector3(), vel: new Vector3(), life: 0, maxLife: 1,
        size: 0.1, color: new Color(), gravity: 1, glow: false,
      });
    }
  }

  private spawn(): Particle | null {
    if (this.active >= MAX_PARTICLES) return null;
    return this.pool[this.active++];
  }

  /** Éclats projetés lors de la destruction d'un bloc. */
  burstBlock(x: number, y: number, z: number, color: number, count = 14): void {
    for (let i = 0; i < count; i++) {
      const p = this.spawn();
      if (!p) return;
      p.pos.set(x + Math.random(), y + Math.random(), z + Math.random());
      p.vel.set((Math.random() - 0.5) * 3.4, Math.random() * 3.4 + 0.6, (Math.random() - 0.5) * 3.4);
      p.maxLife = p.life = 0.6 + Math.random() * 0.6;
      p.size = 0.06 + Math.random() * 0.07;
      p.color.setHex(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);
      p.gravity = 1;
      p.glow = false;
    }
  }

  /** Petit nuage sous les pieds (course, atterrissage). */
  puff(x: number, y: number, z: number, color: number, count = 5): void {
    for (let i = 0; i < count; i++) {
      const p = this.spawn();
      if (!p) return;
      p.pos.set(x + (Math.random() - 0.5) * 0.6, y + 0.05, z + (Math.random() - 0.5) * 0.6);
      p.vel.set((Math.random() - 0.5) * 1.1, Math.random() * 0.9, (Math.random() - 0.5) * 1.1);
      p.maxLife = p.life = 0.35 + Math.random() * 0.3;
      p.size = 0.05 + Math.random() * 0.05;
      p.color.setHex(color);
      p.gravity = 0.25;
      p.glow = false;
    }
  }

  /** Gerbe d'entrée dans l'eau. */
  splash(x: number, y: number, z: number, count = 18): void {
    for (let i = 0; i < count; i++) {
      const p = this.spawn();
      if (!p) return;
      p.pos.set(x + (Math.random() - 0.5) * 0.7, y, z + (Math.random() - 0.5) * 0.7);
      p.vel.set((Math.random() - 0.5) * 2.4, 2 + Math.random() * 3, (Math.random() - 0.5) * 2.4);
      p.maxLife = p.life = 0.5 + Math.random() * 0.4;
      p.size = 0.045;
      p.color.setRGB(0.55, 0.75, 1.0);
      p.gravity = 1;
      p.glow = false;
    }
  }

  explosion(x: number, y: number, z: number, radius: number): void {
    for (let i = 0; i < 90; i++) {
      const p = this.spawn();
      if (!p) return;
      const dir = new Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
      p.pos.set(x, y, z).addScaledVector(dir, Math.random() * radius * 0.5);
      p.vel.copy(dir).multiplyScalar(4 + Math.random() * 9);
      p.maxLife = p.life = 0.5 + Math.random() * 0.8;
      p.size = 0.1 + Math.random() * 0.2;
      const t = Math.random();
      p.color.setRGB(1, 0.45 + t * 0.5, 0.12 + t * 0.3);
      p.gravity = 0.5;
      p.glow = true;
    }
  }

  update(dt: number, dayFactor: number): void {
    const colors = this.colorAttr.array as Uint8Array;
    const alphas = this.alphaAttr.array as Float32Array;
    let i = 0;
    while (i < this.active) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        // Échange avec la dernière particule vivante.
        this.pool[i] = this.pool[this.active - 1];
        this.pool[this.active - 1] = p;
        this.active--;
        continue;
      }
      p.vel.y -= GRAVITY * p.gravity * dt;
      const nx = p.pos.x + p.vel.x * dt;
      const ny = p.pos.y + p.vel.y * dt;
      const nz = p.pos.z + p.vel.z * dt;
      // Rebond simple sur le terrain.
      if (this.blocked(nx, p.pos.y, p.pos.z)) { p.vel.x *= -0.32; } else p.pos.x = nx;
      if (this.blocked(p.pos.x, ny, p.pos.z)) { p.vel.y *= -0.28; p.vel.x *= 0.7; p.vel.z *= 0.7; } else p.pos.y = ny;
      if (this.blocked(p.pos.x, p.pos.y, nz)) { p.vel.z *= -0.32; } else p.pos.z = nz;

      const fade = Math.min(1, p.life / (p.maxLife * 0.45));
      this.dummy.position.copy(p.pos);
      this.dummy.scale.setScalar(p.size * (0.6 + 0.4 * fade));
      this.dummy.rotation.set(p.pos.x * 3, p.pos.y * 3, p.pos.z * 3);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      if (p.glow) {
        colors[i * 3] = Math.min(255, p.color.r * 255);
        colors[i * 3 + 1] = Math.min(255, p.color.g * 255);
        colors[i * 3 + 2] = Math.min(255, p.color.b * 255);
      } else {
        const l = this.world.getLight(Math.floor(p.pos.x), Math.floor(p.pos.y), Math.floor(p.pos.z));
        voxelLightColor(l >> 4, l & 15, dayFactor, tmpColor);
        colors[i * 3] = Math.min(255, p.color.r * tmpColor.r * 255);
        colors[i * 3 + 1] = Math.min(255, p.color.g * tmpColor.g * 255);
        colors[i * 3 + 2] = Math.min(255, p.color.b * tmpColor.b * 255);
      }
      alphas[i] = fade;
      i++;
    }
    this.mesh.count = this.active;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  private blocked(x: number, y: number, z: number): boolean {
    const b = this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    return b > 0 && IS_SOLID[b] === 1;
  }
}

// ---------------------------------------------------------------------------
// Météo
// ---------------------------------------------------------------------------

const WEATHER_COUNT = 3500;

const WEATHER_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uOrigin;
uniform float uSnow;
uniform float uSpread;
uniform float uFall;
in float seed;
out float vFade;
void main() {
  float sp = uSpread;
  // Position pseudo-aléatoire réparties autour du joueur, qui « boucle ».
  float sx = fract(sin(seed * 12.9898) * 43758.5453);
  float sz = fract(sin(seed * 78.233) * 12345.6789);
  float sy = fract(sin(seed * 39.425) * 9876.5432);
  vec3 p;
  p.x = uOrigin.x + (sx - 0.5) * sp;
  p.z = uOrigin.z + (sz - 0.5) * sp;
  float h = 34.0;
  float t = fract(sy + uTime * uFall);
  p.y = uOrigin.y + 20.0 - t * h;
  // Dérive latérale de la neige.
  p.x += sin(uTime * 0.9 + seed * 6.0) * uSnow * 1.6;
  p.z += cos(uTime * 0.7 + seed * 4.0) * uSnow * 1.6;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = mix(2.0, 4.5, uSnow) * (24.0 / max(-mv.z, 1.0));
  vFade = 1.0 - smoothstep(0.65, 1.0, t);
}
`;

const WEATHER_FRAG = /* glsl */ `
precision highp float;
uniform float uSnow;
uniform float uOpacity;
in float vFade;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  vec3 col = mix(vec3(0.62, 0.74, 0.95), vec3(1.0), uSnow);
  fragColor = vec4(col, uOpacity * vFade * mix(0.55, 0.9, uSnow));
}
`;

export class Weather {
  readonly points: Points;
  readonly material: ShaderMaterial;

  constructor() {
    const geo = new BufferGeometry();
    const seeds = new Float32Array(WEATHER_COUNT);
    const pos = new Float32Array(WEATHER_COUNT * 3);
    for (let i = 0; i < WEATHER_COUNT; i++) seeds[i] = i / WEATHER_COUNT + Math.random() * 0.0002;
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('seed', new BufferAttribute(seeds, 1));
    geo.boundingSphere = null;

    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new Vector3() },
        uSnow: { value: 0 },
        uSpread: { value: 34 },
        uFall: { value: 0.55 },
        uOpacity: { value: 0 },
      },
      vertexShader: WEATHER_VERT,
      fragmentShader: WEATHER_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'weather';
    this.points.visible = false;
  }

  update(time: number, origin: Vector3, intensity: number, snow: boolean): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uOrigin.value as Vector3).copy(origin);
    u.uSnow.value = snow ? 1 : 0;
    u.uFall.value = snow ? 0.16 : 0.62;
    u.uOpacity.value = intensity;
    this.points.visible = intensity > 0.01;
  }
}

const tmpColor = new Color();
