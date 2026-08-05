/** Collisions AABB contre voxels et lancer de rayon DDA. */

import { Vector3 } from 'three';
import { WORLD_HEIGHT } from '../core/constants';
import { IS_GATE, IS_SOLID, MAX_BOXES, SHAPE_BOXES, SHAPE_COUNT, RENDER_KIND, RenderKind } from '../world/blocks';
import { fenceConnects } from '../world/mesher';
import type { World } from '../world/World';

export interface Box {
  /** Centre au sol : x et z centrés, y au niveau des pieds. */
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

export interface MoveResult {
  onGround: boolean;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  /** Hauteur du ressaut effectué (0 si aucun). */
  stepped: number;
}

/** Hauteur de collision d'une barrière : plus qu'un bloc, pour ne pas l'enjamber. */
const FENCE_HEIGHT = 1.5;

/**
 * Emprise horizontale d'une barrière : le poteau central, plus une lisse vers
 * chaque côté raccordé. Le raccordement suit la même règle qu'au maillage,
 * pour que ce qu'on voit et ce qu'on heurte coïncident.
 */
function fenceOverlaps(world: World, b: Box, x: number, y: number, z: number): boolean {
  const half = b.width / 2;
  const bx0 = b.x - half, bx1 = b.x + half;
  const bz0 = b.z - half, bz1 = b.z + half;
  const croise = (x0: number, z0: number, x1: number, z1: number): boolean =>
    bx1 > x + x0 && bx0 < x + x1 && bz1 > z + z0 && bz0 < z + z1;

  if (croise(0.375, 0.375, 0.625, 0.625)) return true;
  for (const [dx, dz] of FENCE_SIDES) {
    if (!fenceConnects(world.getBlock(x + dx, y, z + dz))) continue;
    const x0 = dx < 0 ? 0 : dx > 0 ? 0.625 : 0.4375;
    const x1 = dx < 0 ? 0.375 : dx > 0 ? 1 : 0.5625;
    const z0 = dz < 0 ? 0 : dz > 0 ? 0.625 : 0.4375;
    const z1 = dz < 0 ? 0.375 : dz > 0 ? 1 : 0.5625;
    if (croise(x0, z0, x1, z1)) return true;
  }
  return false;
}

const FENCE_SIDES: readonly (readonly [number, number])[] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

function overlaps(world: World, b: Box): boolean {
  const half = b.width / 2;
  const x0 = Math.floor(b.x - half + 1e-6);
  const x1 = Math.floor(b.x + half - 1e-6);
  const y0 = Math.floor(b.y + 1e-6);
  const y1 = Math.floor(b.y + b.height - 1e-6);
  const z0 = Math.floor(b.z - half + 1e-6);
  const z1 = Math.floor(b.z + half - 1e-6);
  const top = b.y + b.height;
  // Une barrière dépasse du haut de son voxel : la rangée juste en dessous doit
  // donc être examinée elle aussi, sans quoi on lui sauterait par-dessus.
  for (let y = y0 - 1; y <= y1; y++) {
    const sousLaBoite = y < y0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (y < 0) { if (sousLaBoite) continue; return true; }
        if (y >= WORLD_HEIGHT) continue;
        const id = world.getBlock(x, y, z);
        if (id < 0) { if (sousLaBoite) continue; return true; } // chunk non chargé : mur invisible
        if (!IS_SOLID[id]) continue;
        // Une barrière n'a pas de forme figée : elle se déduit du voisinage,
        // exactement comme au maillage.
        if (RENDER_KIND[id] === RenderKind.Fence) {
          if (top <= y || b.y >= y + FENCE_HEIGHT) continue;
          if (fenceOverlaps(world, b, x, y, z)) return true;
          continue;
        }
        // Un portillon fermé se défend comme la barrière qu'il complète : sa
        // collision monte au-dessus de son voxel, sinon on l'enjambe d'un saut
        // et l'enclos ne sert plus à rien. Il reste dessiné à sa taille.
        const portillon = IS_GATE[id] === 1;
        if (sousLaBoite && !portillon) continue;
        // Les dalles n'occupent qu'une partie de leur voxel.
        // Un escalier est fait de deux boîtes : il faut les tester toutes,
        // sinon on traverse la marche haute.
        const n = SHAPE_COUNT[id];
        for (let k = 0; k < n && k < MAX_BOXES; k++) {
          const o = (id * MAX_BOXES + k) * 6;
          const hautDeBoite = portillon ? FENCE_HEIGHT : SHAPE_BOXES[o + 4];
          if (b.x + b.width / 2 <= x + SHAPE_BOXES[o] || b.x - b.width / 2 >= x + SHAPE_BOXES[o + 3]) continue;
          if (b.z + b.width / 2 <= z + SHAPE_BOXES[o + 2] || b.z - b.width / 2 >= z + SHAPE_BOXES[o + 5]) continue;
          if (b.y < y + hautDeBoite && top > y + SHAPE_BOXES[o + 1]) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Déplace la boîte en résolvant les collisions axe par axe.
 * `velocity` est modifié : les composantes bloquées sont annulées.
 * `maxStep` est la hauteur du ressaut franchissable sans sauter : 0 pour
 * aucun, 0.55 pour les dalles et les escaliers, 1 pour le saut automatique.
 */
export function moveBox(world: World, box: Box, velocity: Vector3, dt: number, maxStep = 0): MoveResult {
  const res: MoveResult = { onGround: false, hitX: false, hitY: false, hitZ: false, stepped: 0 };

  // Sous-pas pour éviter de traverser un bloc à grande vitesse.
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z) * dt;
  const steps = Math.max(1, Math.ceil(speed / 0.4));
  const sdt = dt / steps;

  for (let s = 0; s < steps; s++) {
    // Y
    if (velocity.y !== 0) {
      const dy = velocity.y * sdt;
      box.y += dy;
      if (overlaps(world, box)) {
        box.y -= dy;
        // Dichotomie : on se colle au contact sans jamais pénétrer le bloc.
        let free = 0;
        let blocked = dy;
        for (let k = 0; k < 10; k++) {
          const mid = (free + blocked) / 2;
          box.y += mid;
          const bad = overlaps(world, box);
          box.y -= mid;
          if (bad) blocked = mid;
          else free = mid;
        }
        box.y += free;
        if (dy < 0) res.onGround = true;
        velocity.y = 0;
        res.hitY = true;
      }
    }

    // X
    if (velocity.x !== 0) {
      const dx = velocity.x * sdt;
      box.x += dx;
      if (overlaps(world, box)) {
        box.x -= dx;
        let resolved = false;
        if (maxStep > 0 && res.onGround) {
          const oldY = box.y;
          for (let h = 0.25; h <= maxStep + 1e-6; h += 0.25) {
            box.y = oldY + h;
            box.x += dx;
            if (!overlaps(world, box)) { resolved = true; res.stepped = h; break; }
            box.x -= dx;
          }
          if (!resolved) box.y = oldY;
        }
        if (!resolved) {
          velocity.x = 0;
          res.hitX = true;
        }
      }
    }

    // Z
    if (velocity.z !== 0) {
      const dz = velocity.z * sdt;
      box.z += dz;
      if (overlaps(world, box)) {
        box.z -= dz;
        let resolved = false;
        if (maxStep > 0 && res.onGround) {
          const oldY = box.y;
          for (let h = 0.25; h <= maxStep + 1e-6; h += 0.25) {
            box.y = oldY + h;
            box.z += dz;
            if (!overlaps(world, box)) { resolved = true; res.stepped = Math.max(res.stepped, h); break; }
            box.z -= dz;
          }
          if (!resolved) box.y = oldY;
        }
        if (!resolved) {
          velocity.z = 0;
          res.hitZ = true;
        }
      }
    }
  }

  // Contact avec le sol même sans vitesse verticale.
  if (!res.onGround) {
    const probe: Box = { ...box, y: box.y - 0.02 };
    if (overlaps(world, probe)) res.onGround = true;
  }
  return res;
}

export interface RaycastHit {
  /** Coordonnées du bloc touché. */
  x: number;
  y: number;
  z: number;
  block: number;
  /** Normale de la face touchée. */
  nx: number;
  ny: number;
  nz: number;
  distance: number;
  /** Point d'impact exact. */
  point: Vector3;
}

const hitPoint = new Vector3();

/**
 * Parcours DDA d'une grille de voxels (Amanatides & Woo).
 * @param includeFluids inclure l'eau et la lave dans les cibles
 */
export function raycast(
  world: World,
  origin: Vector3,
  direction: Vector3,
  maxDistance: number,
  includeFluids = false,
): RaycastHit | null {
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);

  const dx = direction.x, dy = direction.y, dz = direction.z;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

  const bx = stepX > 0 ? x + 1 - origin.x : origin.x - x;
  const by = stepY > 0 ? y + 1 - origin.y : origin.y - y;
  const bz = stepZ > 0 ? z + 1 - origin.z : origin.z - z;

  let tMaxX = stepX !== 0 ? bx * tDeltaX : Infinity;
  let tMaxY = stepY !== 0 ? by * tDeltaY : Infinity;
  let tMaxZ = stepZ !== 0 ? bz * tDeltaZ : Infinity;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;

  for (let i = 0; i < 512; i++) {
    if (y >= 0 && y < WORLD_HEIGHT) {
      const b = world.getBlock(x, y, z);
      if (b > 0) {
        const kind = RENDER_KIND[b];
        const targetable = includeFluids
          ? kind !== RenderKind.None
          : kind === RenderKind.Cube || kind === RenderKind.Cross || kind === RenderKind.Fence;
        if (targetable) {
          hitPoint.copy(direction).multiplyScalar(t).add(origin);
          return { x, y, z, block: b, nx, ny, nz, distance: t, point: hitPoint.clone() };
        }
      }
    }
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        if (tMaxX > maxDistance) break;
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else {
        if (tMaxZ > maxDistance) break;
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
    } else {
      if (tMaxY < tMaxZ) {
        if (tMaxY > maxDistance) break;
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        if (tMaxZ > maxDistance) break;
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
    }
  }
  return null;
}

/** Le point est-il à l'intérieur d'un fluide ? */
export function fluidAt(world: World, x: number, y: number, z: number): number {
  const b = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  if (b <= 0) return 0;
  return RENDER_KIND[b] === RenderKind.Liquid ? b : 0;
}
