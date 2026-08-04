/** État et physique du joueur : déplacement, nage, vol créatif, vitalité. */

import { Vector3 } from 'three';
import {
  GRAVITY,
  PLAYER_CROUCH_EYE,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_EYE,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  TERMINAL_VELOCITY,
  WORLD_HEIGHT,
} from '../core/constants';
import type { InputState } from '../core/Input';
import { BLOCKS, IS_SOLID, RENDER_KIND, RenderKind } from '../world/blocks';
import type { World } from '../world/World';
import { moveBox, type Box } from './physics';

export const enum GameMode {
  Survival = 0,
  Creative = 1,
  Spectator = 2,
}

const WALK_SPEED = 4.4;
const SPRINT_SPEED = 5.9;
const SNEAK_SPEED = 1.45;
const FLY_SPEED = 11;
const FLY_SPRINT = 22;
const JUMP_VELOCITY = 8.4;
const SWIM_SPEED = 3.1;
const WATER_DRAG = 0.82;

export interface PlayerStats {
  health: number;
  maxHealth: number;
  food: number;
  saturation: number;
  /** Souffle restant, en secondes. */
  breath: number;
  maxBreath: number;
  xp: number;
  level: number;
}

export class Player {
  readonly position = new Vector3(0, 80, 0);
  readonly velocity = new Vector3();
  yaw = 0;
  pitch = 0;

  mode: GameMode = GameMode.Survival;
  onGround = false;
  inWater = false;
  submerged = false;
  inLava = false;
  sneaking = false;
  sprinting = false;
  flying = false;
  /** Vue à la troisième personne (0 = première, 1 = arrière, 2 = avant). */
  cameraMode = 0;

  stats: PlayerStats = {
    health: 20, maxHealth: 20, food: 20, saturation: 5,
    breath: 15, maxBreath: 15, xp: 0, level: 0,
  };

  /** Distance de chute accumulée, pour les dégâts à l'atterrissage. */
  private fallDistance = 0;
  private lastJumpTap = -1;
  /** Compteur de balancement utilisé par le HUD et le bruit de pas. */
  bobPhase = 0;
  stepDistance = 0;
  /** Temps d'invulnérabilité restant. */
  hurtCooldown = 0;
  /** Dernier montant de dégâts, pour l'effet plein écran. */
  lastDamage = 0;
  dead = false;

  private foodTimer = 0;
  private regenTimer = 0;
  private starveTimer = 0;

  autoJump = false;
  /** En selle : la monture décide de la position, la physique du joueur se tait. */
  riding = false;

  get eyeHeight(): number {
    return this.sneaking ? PLAYER_CROUCH_EYE : PLAYER_EYE;
  }

  get height(): number {
    return this.sneaking ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  }

  get eyePosition(): Vector3 {
    return tmpEye.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  get forward(): Vector3 {
    return tmpFwd.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
  }

  applyLook(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch += dy;
    const limit = Math.PI / 2 - 0.001;
    if (this.pitch > limit) this.pitch = limit;
    if (this.pitch < -limit) this.pitch = -limit;
    // Normalise le lacet pour éviter la perte de précision sur longue session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Le joueur peut-il traverser les blocs et ignorer la gravité ? */
  get noclip(): boolean {
    return this.mode === GameMode.Spectator;
  }

  update(dt: number, input: InputState, world: World, elapsed: number): void {
    if (this.dead) {
      this.velocity.set(0, 0, 0);
      return;
    }
    this.updateEnvironment(world);

    // En selle, la monture pilote : on garde la vitalité et le regard, mais on
    // ne touche ni à la position ni à la vitesse — le jeu s'en charge.
    if (this.riding) {
      this.sneaking = false;
      this.flying = false;
      this.sprinting = false;
      this.fallDistance = 0;
      this.velocity.set(0, 0, 0);
      this.bobPhase += dt * 0.9;
      this.updateVitals(dt, world);
      return;
    }

    const wantSneak = input.sneak && !this.flying;
    // On ne se relève pas si le plafond est trop bas.
    if (this.sneaking && !wantSneak && this.canStand(world)) this.sneaking = false;
    else if (wantSneak) this.sneaking = true;

    // Double appui sur saut : bascule du vol en créatif.
    if (input.jump) {
      if (this.lastJumpTap < 0) {
        if (this.mode === GameMode.Creative || this.mode === GameMode.Spectator) {
          if (elapsed - this.lastJumpRelease < 0.32) {
            this.flying = !this.flying;
            this.velocity.y = 0;
          }
        }
        this.lastJumpTap = elapsed;
      }
    } else if (this.lastJumpTap >= 0) {
      this.lastJumpRelease = elapsed;
      this.lastJumpTap = -1;
    }
    if (this.mode === GameMode.Survival) this.flying = false;
    if (this.mode === GameMode.Spectator) this.flying = true;

    // --- Direction souhaitée ---
    let ix = (input.right ? 1 : 0) - (input.left ? 1 : 0) + input.moveX;
    let iz = (input.back ? 1 : 0) - (input.forward ? 1 : 0) + input.moveY;
    const mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; }

    // Repère : « avant » vaut (-sin yaw, -cos yaw), « droite » (cos yaw, -sin yaw).
    // `iz` est négatif quand on avance, d'où les signes ci-dessous.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wishX = ix * cos + iz * sin;
    const wishZ = iz * cos - ix * sin;

    this.sprinting = input.sprint && !this.sneaking && (iz < -0.1 || mag > 0.7) && this.stats.food > 6;

    if (this.flying) this.flyStep(dt, wishX, wishZ, input);
    else if (this.inWater || this.inLava) this.swimStep(dt, wishX, wishZ, input);
    else this.walkStep(dt, wishX, wishZ, input);

    // --- Intégration ---
    if (this.noclip) {
      this.position.addScaledVector(this.velocity, dt);
      this.onGround = false;
    } else {
      const box: Box = { x: this.position.x, y: this.position.y, z: this.position.z, width: PLAYER_WIDTH, height: this.height };
      const before = this.position.y;
      // On gravit toujours un demi-bloc sans sauter, sinon les dalles et les
      // escaliers seraient des murs ; le saut automatique étend le ressaut au
      // bloc entier.
      const step = this.onGround && !this.flying ? (this.autoJump ? 1 : 0.55) : 0;
      const res = moveBox(world, box, this.velocity, dt, step);
      // Le mode accroupi empêche de tomber d'un rebord.
      if (this.sneaking && this.onGround && !res.onGround) {
        const test: Box = { ...box, x: this.position.x, y: box.y };
        if (!this.hasGroundBelow(world, test)) {
          box.x = this.position.x;
          box.z = this.position.z;
        }
      }
      this.position.set(box.x, box.y, box.z);
      this.onGround = res.onGround;

      if (this.velocity.y < 0) this.fallDistance += before - this.position.y;
      if (res.onGround) {
        if (this.fallDistance > 3.2 && this.mode === GameMode.Survival && !this.inWater) {
          this.damage(Math.floor(this.fallDistance - 3));
        }
        this.fallDistance = 0;
      }
      if (this.inWater || this.flying) this.fallDistance = 0;
    }

    if (this.position.y < -12) {
      if (this.mode === GameMode.Survival) this.damage(4);
      else this.position.y = WORLD_HEIGHT + 4;
    }

    // Balancement de la caméra et cadence des pas.
    const planar = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.onGround && planar > 0.2) {
      this.bobPhase += dt * planar * 1.6;
      this.stepDistance += planar * dt;
    } else {
      this.bobPhase += dt * 0.4;
    }

    this.updateVitals(dt, world);
  }

  private lastJumpRelease = -10;

  private walkStep(dt: number, wishX: number, wishZ: number, input: InputState): void {
    const target = this.sneaking ? SNEAK_SPEED : this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const control = this.onGround ? 12 : 2.6;
    this.velocity.x += (wishX * target - this.velocity.x) * Math.min(1, control * dt);
    this.velocity.z += (wishZ * target - this.velocity.z) * Math.min(1, control * dt);

    if (input.jump && this.onGround) {
      this.velocity.y = JUMP_VELOCITY;
      this.onGround = false;
      if (this.sprinting) {
        this.velocity.x += wishX * 1.4;
        this.velocity.z += wishZ * 1.4;
      }
    }
    this.velocity.y -= GRAVITY * dt;
    if (this.velocity.y < -TERMINAL_VELOCITY) this.velocity.y = -TERMINAL_VELOCITY;
  }

  private swimStep(dt: number, wishX: number, wishZ: number, input: InputState): void {
    const target = this.inLava ? SWIM_SPEED * 0.4 : SWIM_SPEED;
    this.velocity.x += (wishX * target - this.velocity.x) * Math.min(1, 6 * dt);
    this.velocity.z += (wishZ * target - this.velocity.z) * Math.min(1, 6 * dt);
    this.velocity.y -= GRAVITY * 0.28 * dt;
    if (input.jump) this.velocity.y += 22 * dt;
    else if (input.sneak) this.velocity.y -= 12 * dt;
    // Flottabilité : on remonte doucement en surface.
    if (!this.submerged && this.velocity.y < 0) this.velocity.y *= 0.6;
    this.velocity.multiplyScalar(Math.pow(WATER_DRAG, dt * 12));
    this.fallDistance = 0;
  }

  private flyStep(dt: number, wishX: number, wishZ: number, input: InputState): void {
    const target = input.sprint ? FLY_SPRINT : FLY_SPEED;
    this.velocity.x += (wishX * target - this.velocity.x) * Math.min(1, 10 * dt);
    this.velocity.z += (wishZ * target - this.velocity.z) * Math.min(1, 10 * dt);
    let vy = 0;
    if (input.jump) vy += target;
    if (input.sneak) vy -= target;
    this.velocity.y += (vy - this.velocity.y) * Math.min(1, 10 * dt);
  }

  private hasGroundBelow(world: World, box: Box): boolean {
    const half = box.width / 2;
    const y = Math.floor(box.y - 0.06);
    for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half]] as const) {
      const b = world.getBlock(Math.floor(box.x + dx), y, Math.floor(box.z + dz));
      if (b > 0 && IS_SOLID[b]) return true;
    }
    return false;
  }

  private canStand(world: World): boolean {
    const box: Box = { x: this.position.x, y: this.position.y, z: this.position.z, width: PLAYER_WIDTH, height: PLAYER_HEIGHT };
    const half = box.width / 2;
    const y0 = Math.floor(box.y + PLAYER_CROUCH_HEIGHT);
    const y1 = Math.floor(box.y + PLAYER_HEIGHT - 1e-4);
    for (let y = y0; y <= y1; y++) {
      for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half]] as const) {
        const b = world.getBlock(Math.floor(box.x + dx), y, Math.floor(box.z + dz));
        if (b > 0 && IS_SOLID[b]) return false;
      }
    }
    return true;
  }

  private updateEnvironment(world: World): void {
    const bx = Math.floor(this.position.x);
    const bz = Math.floor(this.position.z);
    const feet = world.getBlock(bx, Math.floor(this.position.y + 0.2), bz);
    const eyes = world.getBlock(bx, Math.floor(this.position.y + this.eyeHeight), bz);
    const isLiquid = (b: number) => b > 0 && RENDER_KIND[b] === RenderKind.Liquid;
    this.inWater = isLiquid(feet) && BLOCKS[feet].key === 'water';
    this.inLava = isLiquid(feet) && BLOCKS[feet].key === 'lava';
    this.submerged = isLiquid(eyes);
  }

  private updateVitals(dt: number, world: World): void {
    if (this.hurtCooldown > 0) this.hurtCooldown -= dt;
    if (this.lastDamage > 0) this.lastDamage = Math.max(0, this.lastDamage - dt * 2);
    if (this.mode !== GameMode.Survival) {
      this.stats.breath = this.stats.maxBreath;
      return;
    }

    // Souffle.
    if (this.submerged && !this.inLava) {
      this.stats.breath -= dt;
      if (this.stats.breath <= 0) {
        this.stats.breath = 0;
        this.drownTimer += dt;
        if (this.drownTimer >= 1) { this.drownTimer = 0; this.damage(2, true); }
      }
    } else {
      this.stats.breath = Math.min(this.stats.maxBreath, this.stats.breath + dt * 4);
      this.drownTimer = 0;
    }

    // Lave et cactus.
    if (this.inLava) {
      this.lavaTimer += dt;
      if (this.lavaTimer >= 0.5) { this.lavaTimer = 0; this.damage(3, true); }
    } else {
      this.lavaTimer = 0;
    }
    const touching = this.touchingDamage(world);
    if (touching > 0) {
      this.contactTimer += dt;
      if (this.contactTimer >= 0.5) { this.contactTimer = 0; this.damage(touching); }
    } else {
      this.contactTimer = 0;
    }

    // Faim : l'effort consomme de la saturation puis de la nourriture.
    const exertion = (this.sprinting ? 0.09 : 0.018) + (this.onGround ? 0 : 0.006);
    this.foodTimer += dt * exertion * (Math.hypot(this.velocity.x, this.velocity.z) > 0.5 ? 1 : 0.25);
    if (this.foodTimer >= 1) {
      this.foodTimer = 0;
      if (this.stats.saturation > 0) this.stats.saturation = Math.max(0, this.stats.saturation - 1);
      else this.stats.food = Math.max(0, this.stats.food - 1);
    }

    // Régénération et famine.
    if (this.stats.food >= 18 && this.stats.health < this.stats.maxHealth) {
      this.regenTimer += dt;
      if (this.regenTimer >= 3.5) {
        this.regenTimer = 0;
        this.stats.health = Math.min(this.stats.maxHealth, this.stats.health + 1);
        this.stats.saturation = Math.max(0, this.stats.saturation - 0.6);
      }
    } else {
      this.regenTimer = 0;
    }
    if (this.stats.food <= 0) {
      this.starveTimer += dt;
      if (this.starveTimer >= 4) { this.starveTimer = 0; this.damage(1, true); }
    }
  }

  private drownTimer = 0;
  private lavaTimer = 0;
  private contactTimer = 0;

  private touchingDamage(world: World): number {
    const half = PLAYER_WIDTH / 2 + 0.08;
    let worst = 0;
    for (let y = Math.floor(this.position.y); y <= Math.floor(this.position.y + this.height - 0.1); y++) {
      for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half]] as const) {
        const b = world.getBlock(Math.floor(this.position.x + dx), y, Math.floor(this.position.z + dz));
        if (b > 0) worst = Math.max(worst, BLOCKS[b].contactDamage);
      }
    }
    return worst;
  }

  /** Inflige des dégâts. `bypassArmor` ignore la réduction (noyade, famine). */
  damage(amount: number, bypassArmor = false, defense = 0): void {
    if (this.mode !== GameMode.Survival || this.dead) return;
    if (this.hurtCooldown > 0 && !bypassArmor) return;
    let final = amount;
    if (!bypassArmor && defense > 0) final = amount * (1 - Math.min(0.8, defense * 0.04));
    this.stats.health -= final;
    this.lastDamage = Math.min(1, 0.4 + final * 0.08);
    this.hurtCooldown = 0.5;
    if (this.stats.health <= 0) {
      this.stats.health = 0;
      this.dead = true;
    }
  }

  heal(n: number): void {
    this.stats.health = Math.min(this.stats.maxHealth, this.stats.health + n);
  }

  eat(hunger: number, saturation: number): void {
    this.stats.food = Math.min(20, this.stats.food + hunger);
    this.stats.saturation = Math.min(this.stats.food, this.stats.saturation + saturation);
  }

  addXp(n: number): void {
    this.stats.xp += n;
    while (this.stats.xp >= this.xpForNextLevel()) {
      this.stats.xp -= this.xpForNextLevel();
      this.stats.level++;
    }
  }

  xpForNextLevel(): number {
    const l = this.stats.level;
    return l < 16 ? 2 * l + 7 : l < 31 ? 5 * l - 38 : 9 * l - 158;
  }

  respawn(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.stats.health = this.stats.maxHealth;
    this.stats.food = 20;
    this.stats.saturation = 5;
    this.stats.breath = this.stats.maxBreath;
    this.dead = false;
    this.fallDistance = 0;
    this.hurtCooldown = 1;
  }
}

const tmpEye = new Vector3();
const tmpFwd = new Vector3();
