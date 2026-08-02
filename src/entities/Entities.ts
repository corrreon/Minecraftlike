/**
 * Entités du monde : créatures (IA, modèles articulés) et objets au sol.
 *
 * Les modèles sont construits à partir de boîtes colorées par attribut de
 * sommet, dans l'esprit voxel du jeu, et éclairés par la lumière locale.
 */

import {
  BoxGeometry,
  BufferAttribute,
  Color,
  Group,
  Mesh,
  Object3D,
  Vector3,
  type ShaderMaterial,
} from 'three';
import { GRAVITY, TERMINAL_VELOCITY, WORLD_HEIGHT } from '../core/constants';
import { createEntityMaterial, voxelLightColor } from '../render/entityMaterial';
import type { EnvUniforms } from '../render/env';
import { itemOf, type ItemDef } from '../items/items';
import { makeStack, type ItemStack } from '../items/Inventory';
import { B, IS_SOLID, RENDER_KIND, RenderKind } from '../world/blocks';
import type { World } from '../world/World';
import { moveBox, type Box } from '../player/physics';
import { mulberry32 } from '../world/noise';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'chicken' | 'zombie' | 'skeleton' | 'creeper' | 'spider';

interface MobPart {
  name: string;
  size: [number, number, number];
  offset: [number, number, number];
  color: number;
  /** Type d'animation appliqué à la pièce. */
  anim?: 'legFL' | 'legFR' | 'legBL' | 'legBR' | 'head' | 'armL' | 'armR' | 'none';
}

interface MobDef {
  name: string;
  hostile: boolean;
  health: number;
  speed: number;
  width: number;
  height: number;
  damage: number;
  /** Distance de détection du joueur. */
  aggroRange: number;
  xp: number;
  drops: { key: string; min: number; max: number; cookable?: string }[];
  parts: MobPart[];
}

const M = (
  name: string,
  hostile: boolean,
  health: number,
  speed: number,
  width: number,
  height: number,
  damage: number,
  aggroRange: number,
  xp: number,
  drops: MobDef['drops'],
  parts: MobPart[],
): MobDef => ({ name, hostile, health, speed, width, height, damage, aggroRange, xp, drops, parts });

// Les dimensions sont exprimées en blocs (1 bloc = 1 unité).
export const MOBS: Record<MobKind, MobDef> = {
  pig: M('Cochon', false, 10, 1.5, 0.9, 0.9, 0, 0, 1,
    [{ key: 'porkchop', min: 1, max: 3 }],
    [
      { name: 'body', size: [0.62, 0.5, 1.0], offset: [0, 0.62, 0], color: 0xe8a0a0 },
      { name: 'head', size: [0.5, 0.5, 0.44], offset: [0, 0.72, -0.66], color: 0xe8a0a0, anim: 'head' },
      { name: 'snout', size: [0.24, 0.16, 0.1], offset: [0, 0.66, -0.92], color: 0xd88a8a, anim: 'head' },
      { name: 'l1', size: [0.22, 0.38, 0.22], offset: [-0.18, 0.19, -0.3], color: 0xd08a8a, anim: 'legFL' },
      { name: 'l2', size: [0.22, 0.38, 0.22], offset: [0.18, 0.19, -0.3], color: 0xd08a8a, anim: 'legFR' },
      { name: 'l3', size: [0.22, 0.38, 0.22], offset: [-0.18, 0.19, 0.32], color: 0xd08a8a, anim: 'legBL' },
      { name: 'l4', size: [0.22, 0.38, 0.22], offset: [0.18, 0.19, 0.32], color: 0xd08a8a, anim: 'legBR' },
    ]),
  cow: M('Vache', false, 10, 1.3, 0.9, 1.4, 0, 0, 1,
    [{ key: 'beef', min: 1, max: 3 }, { key: 'leather', min: 0, max: 2 }],
    [
      { name: 'body', size: [0.72, 0.6, 1.2], offset: [0, 0.95, 0], color: 0x4a3524 },
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.15, -0.82], color: 0x3a2a1c, anim: 'head' },
      { name: 'hornL', size: [0.12, 0.12, 0.12], offset: [-0.28, 1.36, -0.82], color: 0xe8e0c8, anim: 'head' },
      { name: 'hornR', size: [0.12, 0.12, 0.12], offset: [0.28, 1.36, -0.82], color: 0xe8e0c8, anim: 'head' },
      { name: 'l1', size: [0.24, 0.66, 0.24], offset: [-0.22, 0.33, -0.36], color: 0x3f2c1e, anim: 'legFL' },
      { name: 'l2', size: [0.24, 0.66, 0.24], offset: [0.22, 0.33, -0.36], color: 0x3f2c1e, anim: 'legFR' },
      { name: 'l3', size: [0.24, 0.66, 0.24], offset: [-0.22, 0.33, 0.4], color: 0x3f2c1e, anim: 'legBL' },
      { name: 'l4', size: [0.24, 0.66, 0.24], offset: [0.22, 0.33, 0.4], color: 0x3f2c1e, anim: 'legBR' },
    ]),
  sheep: M('Mouton', false, 8, 1.4, 0.9, 1.3, 0, 0, 1,
    [{ key: 'mutton', min: 1, max: 2 }, { key: 'white_wool', min: 1, max: 1 }],
    [
      { name: 'body', size: [0.78, 0.68, 1.1], offset: [0, 0.9, 0], color: 0xf0efe8 },
      { name: 'head', size: [0.42, 0.42, 0.46], offset: [0, 1.06, -0.72], color: 0xe8e2d4, anim: 'head' },
      { name: 'l1', size: [0.2, 0.56, 0.2], offset: [-0.22, 0.28, -0.3], color: 0xdad4c4, anim: 'legFL' },
      { name: 'l2', size: [0.2, 0.56, 0.2], offset: [0.22, 0.28, -0.3], color: 0xdad4c4, anim: 'legFR' },
      { name: 'l3', size: [0.2, 0.56, 0.2], offset: [-0.22, 0.28, 0.34], color: 0xdad4c4, anim: 'legBL' },
      { name: 'l4', size: [0.2, 0.56, 0.2], offset: [0.22, 0.28, 0.34], color: 0xdad4c4, anim: 'legBR' },
    ]),
  chicken: M('Poule', false, 4, 1.6, 0.5, 0.7, 0, 0, 1,
    [{ key: 'chicken', min: 1, max: 1 }, { key: 'feather', min: 0, max: 2 }],
    [
      { name: 'body', size: [0.34, 0.34, 0.42], offset: [0, 0.42, 0], color: 0xf2f2f2 },
      { name: 'head', size: [0.24, 0.24, 0.2], offset: [0, 0.66, -0.24], color: 0xf6f6f6, anim: 'head' },
      { name: 'beak', size: [0.1, 0.08, 0.1], offset: [0, 0.62, -0.38], color: 0xf0a52a, anim: 'head' },
      { name: 'comb', size: [0.06, 0.1, 0.14], offset: [0, 0.8, -0.24], color: 0xd83a2c, anim: 'head' },
      { name: 'l1', size: [0.1, 0.26, 0.1], offset: [-0.1, 0.13, 0], color: 0xf0a52a, anim: 'legFL' },
      { name: 'l2', size: [0.1, 0.26, 0.1], offset: [0.1, 0.13, 0], color: 0xf0a52a, anim: 'legFR' },
    ]),
  zombie: M('Zombie', true, 20, 2.2, 0.6, 1.95, 3, 22, 5,
    [{ key: 'rotten_flesh', min: 0, max: 2 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.62, 0], color: 0x4a7a3a, anim: 'head' },
      { name: 'body', size: [0.5, 0.74, 0.26], offset: [0, 1.0, 0], color: 0x2a6a8a },
      { name: 'armL', size: [0.24, 0.72, 0.24], offset: [-0.38, 1.0, -0.18], color: 0x4a7a3a, anim: 'armL' },
      { name: 'armR', size: [0.24, 0.72, 0.24], offset: [0.38, 1.0, -0.18], color: 0x4a7a3a, anim: 'armR' },
      { name: 'legL', size: [0.24, 0.66, 0.24], offset: [-0.13, 0.33, 0], color: 0x2a3a6a, anim: 'legFL' },
      { name: 'legR', size: [0.24, 0.66, 0.24], offset: [0.13, 0.33, 0], color: 0x2a3a6a, anim: 'legFR' },
    ]),
  skeleton: M('Squelette', true, 16, 2.4, 0.6, 1.95, 2, 20, 5,
    [{ key: 'bone', min: 0, max: 2 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.62, 0], color: 0xdcdcd0, anim: 'head' },
      { name: 'body', size: [0.42, 0.72, 0.2], offset: [0, 1.0, 0], color: 0xc8c8bc },
      { name: 'armL', size: [0.16, 0.7, 0.16], offset: [-0.32, 1.0, 0], color: 0xdcdcd0, anim: 'armL' },
      { name: 'armR', size: [0.16, 0.7, 0.16], offset: [0.32, 1.0, 0], color: 0xdcdcd0, anim: 'armR' },
      { name: 'legL', size: [0.16, 0.66, 0.16], offset: [-0.11, 0.33, 0], color: 0xc8c8bc, anim: 'legFL' },
      { name: 'legR', size: [0.16, 0.66, 0.16], offset: [0.11, 0.33, 0], color: 0xc8c8bc, anim: 'legFR' },
    ]),
  creeper: M('Creeper', true, 20, 2.3, 0.6, 1.7, 0, 20, 5,
    [{ key: 'gunpowder', min: 0, max: 2 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.42, 0], color: 0x66b04a, anim: 'head' },
      { name: 'body', size: [0.5, 0.74, 0.26], offset: [0, 0.8, 0], color: 0x5aa440 },
      { name: 'legFL', size: [0.24, 0.4, 0.24], offset: [-0.13, 0.2, -0.22], color: 0x4f9438, anim: 'legFL' },
      { name: 'legFR', size: [0.24, 0.4, 0.24], offset: [0.13, 0.2, -0.22], color: 0x4f9438, anim: 'legFR' },
      { name: 'legBL', size: [0.24, 0.4, 0.24], offset: [-0.13, 0.2, 0.22], color: 0x4f9438, anim: 'legBL' },
      { name: 'legBR', size: [0.24, 0.4, 0.24], offset: [0.13, 0.2, 0.22], color: 0x4f9438, anim: 'legBR' },
    ]),
  spider: M('Araignée', true, 16, 2.9, 1.3, 0.9, 2, 18, 5,
    [{ key: 'string', min: 0, max: 2 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 0.55, -0.6], color: 0x2a2a30, anim: 'head' },
      { name: 'body', size: [0.62, 0.5, 0.72], offset: [0, 0.55, 0.28], color: 0x22222a },
      { name: 'eyeL', size: [0.1, 0.1, 0.06], offset: [-0.14, 0.66, -0.86], color: 0xd83a2c, anim: 'head' },
      { name: 'eyeR', size: [0.1, 0.1, 0.06], offset: [0.14, 0.66, -0.86], color: 0xd83a2c, anim: 'head' },
      { name: 'l1', size: [0.9, 0.1, 0.1], offset: [-0.5, 0.4, -0.3], color: 0x1a1a22, anim: 'legFL' },
      { name: 'l2', size: [0.9, 0.1, 0.1], offset: [0.5, 0.4, -0.3], color: 0x1a1a22, anim: 'legFR' },
      { name: 'l3', size: [0.9, 0.1, 0.1], offset: [-0.5, 0.4, 0.3], color: 0x1a1a22, anim: 'legBL' },
      { name: 'l4', size: [0.9, 0.1, 0.1], offset: [0.5, 0.4, 0.3], color: 0x1a1a22, anim: 'legBR' },
    ]),
};

export function coloredBox(w: number, h: number, d: number, color: number): BoxGeometry {
  const g = new BoxGeometry(w, h, d);
  const n = g.attributes.position.count;
  const arr = new Uint8Array(n * 3);
  const r = (color >> 16) & 255, gg = (color >> 8) & 255, b = color & 255;
  for (let i = 0; i < n; i++) {
    // Légère variation par face pour éviter l'aspect « plat ».
    arr[i * 3] = r;
    arr[i * 3 + 1] = gg;
    arr[i * 3 + 2] = b;
  }
  g.setAttribute('tint', new BufferAttribute(arr, 3, true));
  return g;
}

export interface DropRequest {
  x: number;
  y: number;
  z: number;
  stack: ItemStack;
}

export class Mob {
  readonly kind: MobKind;
  readonly def: MobDef;
  readonly group = new Group();
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  yaw = 0;
  health: number;
  onGround = false;
  inWater = false;
  /** Cible de déplacement courante. */
  private wanderTimer = 0;
  private wanderYaw = 0;
  private wanderMove = false;
  private attackCooldown = 0;
  private jumpCooldown = 0;
  aggro = false;
  fuse = -1;
  hurtFlash = 0;
  age = 0;
  private walkPhase = 0;
  private parts: { mesh: Mesh; anim: MobPart['anim']; base: Vector3 }[] = [];
  material: ShaderMaterial;
  dead = false;
  private rnd: () => number;

  constructor(kind: MobKind, x: number, y: number, z: number, env: EnvUniforms, seed: number) {
    this.kind = kind;
    this.def = MOBS[kind];
    this.health = this.def.health;
    this.position.set(x, y, z);
    this.rnd = mulberry32(seed);
    this.material = createEntityMaterial(env);

    for (const p of this.def.parts) {
      const mesh = new Mesh(coloredBox(p.size[0], p.size[1], p.size[2], p.color), this.material);
      mesh.position.set(p.offset[0], p.offset[1], p.offset[2]);
      this.group.add(mesh);
      this.parts.push({ mesh, anim: p.anim, base: mesh.position.clone() });
    }
    this.group.position.copy(this.position);
    this.wanderYaw = this.rnd() * Math.PI * 2;
  }

  get eyeY(): number {
    return this.position.y + this.def.height * 0.85;
  }

  update(dt: number, world: World, playerPos: Vector3, playerReachable: boolean, dayFactor: number, onDamagePlayer: (dmg: number) => void, onExplode: (m: Mob) => void): void {
    this.age += dt;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;

    const d = this.def;
    const toPlayer = tmpVec.copy(playerPos).sub(this.position);
    const dist = toPlayer.length();

    // --- Décision ---
    let wishX = 0, wishZ = 0;
    if (d.hostile && playerReachable && dist < d.aggroRange) {
      this.aggro = true;
    } else if (dist > d.aggroRange * 1.6) {
      this.aggro = false;
    }

    if (this.aggro && dist > 0.05) {
      this.yaw = Math.atan2(toPlayer.x, toPlayer.z);
      const speed = this.kind === 'creeper' && this.fuse >= 0 ? 0 : 1;
      wishX = (toPlayer.x / dist) * speed;
      wishZ = (toPlayer.z / dist) * speed;

      if (this.kind === 'creeper') {
        if (dist < 2.6) {
          if (this.fuse < 0) this.fuse = 0;
          this.fuse += dt;
          if (this.fuse >= 1.5) { onExplode(this); this.dead = true; return; }
        } else if (this.fuse >= 0) {
          this.fuse = Math.max(-1, this.fuse - dt * 2);
        }
      } else if (dist < 1.4 + d.width * 0.5 && this.attackCooldown <= 0 && d.damage > 0) {
        this.attackCooldown = 1.1;
        onDamagePlayer(d.damage);
      }
    } else {
      // Errance.
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 2 + this.rnd() * 5;
        this.wanderMove = this.rnd() < 0.65;
        this.wanderYaw += (this.rnd() - 0.5) * 2.4;
      }
      if (this.wanderMove) {
        this.yaw = this.wanderYaw;
        wishX = Math.sin(this.wanderYaw) * 0.45;
        wishZ = Math.cos(this.wanderYaw) * 0.45;
      }
    }

    // --- Physique ---
    const speed = d.speed * (this.aggro ? 1 : 0.7);
    this.velocity.x += (wishX * speed - this.velocity.x) * Math.min(1, 9 * dt);
    this.velocity.z += (wishZ * speed - this.velocity.z) * Math.min(1, 9 * dt);

    this.inWater = isLiquid(world, this.position.x, this.position.y + 0.2, this.position.z);
    if (this.inWater) {
      this.velocity.y += 14 * dt;
      this.velocity.y *= 0.86;
    } else {
      this.velocity.y -= GRAVITY * dt;
      if (this.velocity.y < -TERMINAL_VELOCITY) this.velocity.y = -TERMINAL_VELOCITY;
    }

    const box: Box = { x: this.position.x, y: this.position.y, z: this.position.z, width: d.width, height: d.height };
    const res = moveBox(world, box, this.velocity, dt, false);
    // Franchit les marches d'un bloc.
    if ((res.hitX || res.hitZ) && res.onGround && this.jumpCooldown <= 0) {
      this.velocity.y = 7.2;
      this.jumpCooldown = 0.6;
    }
    this.position.set(box.x, box.y, box.z);
    this.onGround = res.onGround;

    if (this.position.y < -8) { this.dead = true; return; }

    // --- Rendu ---
    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += dt * (2.5 + planar * 2.6);
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
    this.animate(planar);

    const l = world.getLight(Math.floor(this.position.x), Math.floor(this.position.y + 1), Math.floor(this.position.z));
    voxelLightColor(l >> 4, l & 15, dayFactor, lightColor);
    (this.material.uniforms.uLight.value as Color).copy(lightColor);
    const flashing = this.kind === 'creeper' && this.fuse >= 0 ? (Math.sin(this.fuse * 26) * 0.5 + 0.5) * 0.9 : 0;
    this.material.uniforms.uFlash.value = Math.max(this.hurtFlash, flashing);
  }

  private animate(planar: number): void {
    const swing = Math.sin(this.walkPhase * 2.4) * Math.min(0.7, 0.18 + planar * 0.22);
    for (const p of this.parts) {
      switch (p.anim) {
        case 'legFL':
        case 'legBR':
        case 'armR':
          p.mesh.rotation.x = swing;
          break;
        case 'legFR':
        case 'legBL':
        case 'armL':
          p.mesh.rotation.x = -swing;
          break;
        case 'head':
          p.mesh.rotation.y = Math.sin(this.age * 0.7) * 0.15;
          break;
        default:
          break;
      }
      if (p.anim && p.anim !== 'head' && p.anim !== 'none') {
        // Pivot au sommet de la pièce plutôt qu'en son centre.
        const h = (p.mesh.geometry as BoxGeometry).parameters.height;
        const r = p.mesh.rotation.x;
        p.mesh.position.set(p.base.x, p.base.y - (h / 2) * (1 - Math.cos(r)), p.base.z + (h / 2) * Math.sin(r));
      }
    }
  }

  hurt(amount: number): boolean {
    this.health -= amount;
    this.hurtFlash = 1;
    this.aggro = true;
    if (this.health <= 0) {
      this.dead = true;
      return true;
    }
    return false;
  }

  rollDrops(): DropRequest[] {
    const out: DropRequest[] = [];
    for (const d of this.def.drops) {
      const n = d.min + Math.floor(this.rnd() * (d.max - d.min + 1));
      if (n <= 0) continue;
      const def = itemOf(d.key);
      out.push({ x: this.position.x, y: this.position.y + 0.5, z: this.position.z, stack: makeStack(def, n) });
    }
    return out;
  }

  dispose(): void {
    for (const p of this.parts) p.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Objet lâché au sol, attiré par le joueur puis ramassé. */
export class ItemEntity {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly object: Object3D;
  stack: ItemStack;
  age = 0;
  pickupDelay = 0.4;
  dead = false;
  private mesh: Mesh;

  constructor(x: number, y: number, z: number, stack: ItemStack, env: EnvUniforms, atlasColor: number) {
    this.position.set(x, y, z);
    this.stack = stack;
    const mat = createEntityMaterial(env);
    mat.uniforms.uOpacity.value = 1;
    this.mesh = new Mesh(coloredBox(0.28, 0.28, 0.28, atlasColor), mat);
    this.object = new Group();
    this.object.add(this.mesh);
    this.object.position.copy(this.position);
    this.velocity.set((Math.random() - 0.5) * 1.6, 2.4, (Math.random() - 0.5) * 1.6);
  }

  update(dt: number, world: World, playerPos: Vector3, dayFactor: number): void {
    this.age += dt;
    if (this.pickupDelay > 0) this.pickupDelay -= dt;

    this.velocity.y -= GRAVITY * 0.7 * dt;
    const box: Box = { x: this.position.x, y: this.position.y, z: this.position.z, width: 0.28, height: 0.28 };
    const res = moveBox(world, box, this.velocity, dt, false);
    this.position.set(box.x, box.y, box.z);
    if (res.onGround) {
      this.velocity.x *= Math.pow(0.02, dt);
      this.velocity.z *= Math.pow(0.02, dt);
    }

    // Attraction vers le joueur à courte distance.
    const d = tmpVec.copy(playerPos).sub(this.position);
    d.y += 0.9;
    const dist = d.length();
    if (this.pickupDelay <= 0 && dist < 2.2) {
      d.normalize().multiplyScalar(9 * dt * (2.4 - dist));
      this.velocity.add(d);
    }

    this.object.position.set(this.position.x, this.position.y + 0.18 + Math.sin(this.age * 2.6) * 0.06, this.position.z);
    this.object.rotation.y = this.age * 1.6;

    const l = world.getLight(Math.floor(this.position.x), Math.floor(this.position.y), Math.floor(this.position.z));
    voxelLightColor(l >> 4, l & 15, dayFactor, lightColor);
    ((this.mesh.material as ShaderMaterial).uniforms.uLight.value as Color).copy(lightColor);

    if (this.age > 300) this.dead = true;
  }

  canPickup(playerPos: Vector3): boolean {
    if (this.pickupDelay > 0) return false;
    const dx = playerPos.x - this.position.x;
    const dy = playerPos.y + 0.9 - this.position.y;
    const dz = playerPos.z - this.position.z;
    return dx * dx + dy * dy + dz * dz < 1.35;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
  }
}

function isLiquid(world: World, x: number, y: number, z: number): boolean {
  const b = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  return b > 0 && RENDER_KIND[b] === RenderKind.Liquid;
}

/** Couleur représentative d'un objet, utilisée par les entités « objet au sol ». */
export function itemColor(def: ItemDef): number {
  return def.color === 0xffffff ? 0xbfbfbf : def.color;
}

/** Emplacement libre au sol pour l'apparition d'une créature. */
export function findSpawnSpot(
  world: World,
  cx: number,
  cz: number,
  minY: number,
  maxY: number,
  rnd: () => number,
  needSky: boolean,
  width: number,
  height: number,
): Vector3 | null {
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = Math.floor(cx + (rnd() - 0.5) * 56);
    const z = Math.floor(cz + (rnd() - 0.5) * 56);
    for (let t = 0; t < 8; t++) {
      const y = Math.floor(minY + rnd() * (maxY - minY));
      if (y < 2 || y >= WORLD_HEIGHT - 3) continue;
      const ground = world.getBlock(x, y - 1, z);
      if (ground <= 0 || !IS_SOLID[ground]) continue;
      if (ground === B.water || ground === B.lava) continue;
      let clear = true;
      for (let h = 0; h < Math.ceil(height); h++) {
        const b = world.getBlock(x, y + h, z);
        if (b !== 0) { clear = false; break; }
      }
      if (!clear) continue;
      const light = world.getLight(x, y, z);
      const sky = light >> 4;
      const blockLight = light & 15;
      if (needSky && sky < 9) continue;
      if (!needSky && (blockLight > 7 || sky > 7)) continue;
      void width;
      return new Vector3(x + 0.5, y, z + 0.5);
    }
  }
  return null;
}

const tmpVec = new Vector3();
const lightColor = new Color();
