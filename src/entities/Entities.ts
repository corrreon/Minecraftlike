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
import { GRAVITY, SEA_LEVEL, TERMINAL_VELOCITY, WORLD_HEIGHT } from '../core/constants';
import { createEntityMaterial, voxelLightColor } from '../render/entityMaterial';
import type { EnvUniforms } from '../render/env';
import { itemOf, type ItemDef } from '../items/items';
import { makeStack, type ItemStack } from '../items/Inventory';
import { B, IS_SOLID, RENDER_KIND, RenderKind } from '../world/blocks';
import type { World } from '../world/World';
import { moveBox, type Box } from '../player/physics';
import { mulberry32 } from '../world/noise';

export type MobKind =
  | 'pig' | 'cow' | 'sheep' | 'chicken' | 'horse'
  | 'zombie' | 'skeleton' | 'creeper' | 'spider'
  | 'villager' | 'village_idiot' | 'iron_golem' | 'kraken' | 'bloop'
  | 'blaze' | 'enderman' | 'ender_dragon'
  | 'plane';

interface MobPart {
  name: string;
  size: [number, number, number];
  offset: [number, number, number];
  color: number;
  /** Type d'animation appliqué à la pièce. */
  anim?: 'legFL' | 'legFR' | 'legBL' | 'legBR' | 'head' | 'armL' | 'armR' | 'wingL' | 'wingR' | 'tail' | 'prop' | 'none';
}

interface MobTraits {
  /** Créature aquatique : elle nage, et s'échoue hors de l'eau. */
  aquatic?: boolean;
  /** Se déplace par bonds plutôt qu'en marchant. */
  hops?: boolean;
  /** Gardien : s'en prend aux créatures hostiles proches (golem de fer). */
  guard?: boolean;
  /** Riposte contre le joueur quand on la frappe, même si elle est pacifique. */
  retaliates?: boolean;
  /** Recul infligé à la cible. */
  knockback?: number;
  /** Vole en permanence : ni gravité, ni saut. */
  flies?: boolean;
  /** Change d'avis sans arrêt : l'idiot du village ne tient pas en place. */
  erratic?: boolean;
  /** Se téléporte à courte distance quand on l'attaque. */
  blinks?: boolean;
  /** Le joueur peut la monter : elle obéit alors au lieu d'errer. */
  rideable?: boolean;
  /**
   * Engin volant piloté : ni IA ni errance. Il suit le regard du pilote, et ne
   * tient en l'air que tant qu'il a de la vitesse.
   */
  aircraft?: boolean;
  /**
   * Boss : tourne en orbite autour du centre de l'île et pique sur le joueur.
   * `[rayon, altitude]` de l'orbite.
   */
  orbit?: [number, number];
}

interface MobDef extends MobTraits {
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
  traits: MobTraits = {},
): MobDef => ({ name, hostile, health, speed, width, height, damage, aggroRange, xp, drops, parts, ...traits });

// Les dimensions sont exprimées en blocs (1 bloc = 1 unité).
export const MOBS: Record<MobKind, MobDef> = {
  pig: M('Cochon', false, 10, 1.5, 0.9, 0.9, 0, 0, 1,
    [{ key: 'porkchop', min: 1, max: 3 }],
    [
      { name: 'body', size: [0.62, 0.5, 1.0], offset: [0, 0.62, 0], color: 0xe8a0a0 },
      { name: 'head', size: [0.5, 0.5, 0.44], offset: [0, 0.72, -0.66], color: 0xdd8f92, anim: 'head' },
      { name: 'snout', size: [0.24, 0.16, 0.1], offset: [0, 0.66, -0.92], color: 0xd88a8a, anim: 'head' },
      { name: 'eyeL', size: [0.1, 0.1, 0.06], offset: [-0.17, 0.86, -0.9], color: 0x2a1a1c, anim: 'head' },
      { name: 'eyeR', size: [0.1, 0.1, 0.06], offset: [0.17, 0.86, -0.9], color: 0x2a1a1c, anim: 'head' },
      { name: 'nostrilL', size: [0.05, 0.05, 0.04], offset: [-0.05, 0.66, -0.98], color: 0x8a5254, anim: 'head' },
      { name: 'nostrilR', size: [0.05, 0.05, 0.04], offset: [0.05, 0.66, -0.98], color: 0x8a5254, anim: 'head' },
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
      { name: 'eyeL', size: [0.1, 0.1, 0.06], offset: [-0.15, 1.24, -1.09], color: 0x14100c, anim: 'head' },
      { name: 'eyeR', size: [0.1, 0.1, 0.06], offset: [0.15, 1.24, -1.09], color: 0x14100c, anim: 'head' },
      { name: 'muzzle', size: [0.28, 0.16, 0.06], offset: [0, 1.02, -1.09], color: 0xc9b49c, anim: 'head' },
      { name: 'l1', size: [0.24, 0.66, 0.24], offset: [-0.22, 0.33, -0.36], color: 0x3f2c1e, anim: 'legFL' },
      { name: 'l2', size: [0.24, 0.66, 0.24], offset: [0.22, 0.33, -0.36], color: 0x3f2c1e, anim: 'legFR' },
      { name: 'l3', size: [0.24, 0.66, 0.24], offset: [-0.22, 0.33, 0.4], color: 0x3f2c1e, anim: 'legBL' },
      { name: 'l4', size: [0.24, 0.66, 0.24], offset: [0.22, 0.33, 0.4], color: 0x3f2c1e, anim: 'legBR' },
    ]),
  sheep: M('Mouton', false, 8, 1.4, 0.9, 1.3, 0, 0, 1,
    [{ key: 'mutton', min: 1, max: 2 }, { key: 'white_wool', min: 1, max: 1 }],
    [
      { name: 'body', size: [0.78, 0.68, 1.1], offset: [0, 0.9, 0], color: 0xf0efe8 },
      { name: 'head', size: [0.44, 0.44, 0.46], offset: [0, 1.06, -0.72], color: 0xcbb9a4, anim: 'head' },
      { name: 'eyeL', size: [0.09, 0.09, 0.06], offset: [-0.13, 1.14, -0.97], color: 0x201810, anim: 'head' },
      { name: 'eyeR', size: [0.09, 0.09, 0.06], offset: [0.13, 1.14, -0.97], color: 0x201810, anim: 'head' },
      { name: 'muzzle', size: [0.2, 0.1, 0.06], offset: [0, 0.99, -0.97], color: 0x8f7d68, anim: 'head' },
      { name: 'l1', size: [0.2, 0.56, 0.2], offset: [-0.22, 0.28, -0.3], color: 0xdad4c4, anim: 'legFL' },
      { name: 'l2', size: [0.2, 0.56, 0.2], offset: [0.22, 0.28, -0.3], color: 0xdad4c4, anim: 'legFR' },
      { name: 'l3', size: [0.2, 0.56, 0.2], offset: [-0.22, 0.28, 0.34], color: 0xdad4c4, anim: 'legBL' },
      { name: 'l4', size: [0.2, 0.56, 0.2], offset: [0.22, 0.28, 0.34], color: 0xdad4c4, anim: 'legBR' },
    ]),
  horse: M('Cheval', false, 22, 2.1, 1.1, 1.6, 0, 0, 3,
    [{ key: 'leather', min: 0, max: 2 }],
    [
      { name: 'body', size: [0.78, 0.74, 1.5], offset: [0, 1.1, 0], color: 0x8b5a2b },
      { name: 'neck', size: [0.34, 0.62, 0.42], offset: [0, 1.5, -0.72], color: 0x7d5027, anim: 'head' },
      { name: 'head', size: [0.34, 0.34, 0.62], offset: [0, 1.72, -1.06], color: 0x8b5a2b, anim: 'head' },
      { name: 'muzzle', size: [0.28, 0.24, 0.16], offset: [0, 1.6, -1.4], color: 0x5d3a1c, anim: 'head' },
      { name: 'eyeL', size: [0.09, 0.09, 0.06], offset: [-0.16, 1.8, -1.3], color: 0x140f0c, anim: 'head' },
      { name: 'eyeR', size: [0.09, 0.09, 0.06], offset: [0.16, 1.8, -1.3], color: 0x140f0c, anim: 'head' },
      { name: 'earL', size: [0.08, 0.16, 0.08], offset: [-0.12, 1.94, -0.98], color: 0x6d4522, anim: 'head' },
      { name: 'earR', size: [0.08, 0.16, 0.08], offset: [0.12, 1.94, -0.98], color: 0x6d4522, anim: 'head' },
      { name: 'mane', size: [0.14, 0.2, 0.72], offset: [0, 1.78, -0.66], color: 0x3a2412, anim: 'head' },
      { name: 'saddle', size: [0.72, 0.12, 0.5], offset: [0, 1.5, -0.06], color: 0x54331a },
      { name: 'tail', size: [0.16, 0.5, 0.16], offset: [0, 1.3, 0.82], color: 0x3a2412, anim: 'tail' },
      { name: 'l1', size: [0.24, 0.78, 0.24], offset: [-0.26, 0.39, -0.5], color: 0x82522a, anim: 'legFL' },
      { name: 'l2', size: [0.24, 0.78, 0.24], offset: [0.26, 0.39, -0.5], color: 0x82522a, anim: 'legFR' },
      { name: 'l3', size: [0.24, 0.78, 0.24], offset: [-0.26, 0.39, 0.52], color: 0x82522a, anim: 'legBL' },
      { name: 'l4', size: [0.24, 0.78, 0.24], offset: [0.26, 0.39, 0.52], color: 0x82522a, anim: 'legBR' },
    ], { rideable: true }),
  chicken: M('Poule', false, 4, 1.6, 0.5, 0.7, 0, 0, 1,
    [{ key: 'chicken', min: 1, max: 1 }, { key: 'feather', min: 0, max: 2 }],
    [
      { name: 'body', size: [0.34, 0.34, 0.42], offset: [0, 0.42, 0], color: 0xf2f2f2 },
      { name: 'head', size: [0.24, 0.24, 0.2], offset: [0, 0.66, -0.24], color: 0xf6f6f6, anim: 'head' },
      { name: 'beak', size: [0.1, 0.08, 0.1], offset: [0, 0.62, -0.38], color: 0xf0a52a, anim: 'head' },
      { name: 'comb', size: [0.06, 0.1, 0.14], offset: [0, 0.8, -0.24], color: 0xd83a2c, anim: 'head' },
      { name: 'eyeL', size: [0.06, 0.06, 0.05], offset: [-0.09, 0.7, -0.36], color: 0x1a1210, anim: 'head' },
      { name: 'eyeR', size: [0.06, 0.06, 0.05], offset: [0.09, 0.7, -0.36], color: 0x1a1210, anim: 'head' },
      { name: 'l1', size: [0.1, 0.26, 0.1], offset: [-0.1, 0.13, 0], color: 0xf0a52a, anim: 'legFL' },
      { name: 'l2', size: [0.1, 0.26, 0.1], offset: [0.1, 0.13, 0], color: 0xf0a52a, anim: 'legFR' },
    ]),
  zombie: M('Zombie', true, 20, 2.2, 0.6, 1.95, 3, 22, 5,
    [{ key: 'rotten_flesh', min: 0, max: 2 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.62, 0], color: 0x4a7a3a, anim: 'head' },
      { name: 'eyeL', size: [0.12, 0.09, 0.06], offset: [-0.13, 1.68, -0.27], color: 0x1b2a14, anim: 'head' },
      { name: 'eyeR', size: [0.12, 0.09, 0.06], offset: [0.13, 1.68, -0.27], color: 0x1b2a14, anim: 'head' },
      { name: 'mouth', size: [0.22, 0.05, 0.05], offset: [0, 1.5, -0.27], color: 0x2c4520, anim: 'head' },
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
      { name: 'eyeL', size: [0.13, 0.12, 0.06], offset: [-0.13, 1.68, -0.27], color: 0x151310, anim: 'head' },
      { name: 'eyeR', size: [0.13, 0.12, 0.06], offset: [0.13, 1.68, -0.27], color: 0x151310, anim: 'head' },
      { name: 'mouth', size: [0.24, 0.04, 0.05], offset: [0, 1.49, -0.27], color: 0x151310, anim: 'head' },
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
      { name: 'eyeL', size: [0.13, 0.13, 0.06], offset: [-0.13, 1.5, -0.27], color: 0x0d1a0b, anim: 'head' },
      { name: 'eyeR', size: [0.13, 0.13, 0.06], offset: [0.13, 1.5, -0.27], color: 0x0d1a0b, anim: 'head' },
      { name: 'mouth', size: [0.13, 0.11, 0.06], offset: [0, 1.37, -0.27], color: 0x0d1a0b, anim: 'head' },
      { name: 'fangL', size: [0.11, 0.11, 0.06], offset: [-0.11, 1.27, -0.27], color: 0x0d1a0b, anim: 'head' },
      { name: 'fangR', size: [0.11, 0.11, 0.06], offset: [0.11, 1.27, -0.27], color: 0x0d1a0b, anim: 'head' },
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

  // --- Habitants des villages ---------------------------------------------
  villager: M('Villageois', false, 20, 1.6, 0.6, 1.95, 0, 0, 3,
    [{ key: 'emerald', min: 0, max: 2 }, { key: 'bread', min: 0, max: 1 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.62, 0], color: 0xb08769, anim: 'head' },
      { name: 'nose', size: [0.14, 0.2, 0.14], offset: [0, 1.56, -0.3], color: 0xa07257, anim: 'head' },
      { name: 'brow', size: [0.52, 0.1, 0.1], offset: [0, 1.8, -0.22], color: 0x3a2a1e, anim: 'head' },
      { name: 'eyeL', size: [0.12, 0.1, 0.06], offset: [-0.155, 1.7, -0.27], color: 0xe8e4dc, anim: 'head' },
      { name: 'eyeR', size: [0.12, 0.1, 0.06], offset: [0.155, 1.7, -0.27], color: 0xe8e4dc, anim: 'head' },
      { name: 'pupilL', size: [0.06, 0.08, 0.05], offset: [-0.175, 1.7, -0.29], color: 0x2e3f6b, anim: 'head' },
      { name: 'pupilR', size: [0.06, 0.08, 0.05], offset: [0.175, 1.7, -0.29], color: 0x2e3f6b, anim: 'head' },
      { name: 'robe', size: [0.52, 0.78, 0.3], offset: [0, 1.0, 0], color: 0x6b4a33 },
      { name: 'stole', size: [0.56, 0.16, 0.34], offset: [0, 1.32, 0], color: 0xc4c4bc },
      { name: 'armL', size: [0.2, 0.6, 0.24], offset: [-0.36, 1.06, -0.06], color: 0x6b4a33, anim: 'armL' },
      { name: 'armR', size: [0.2, 0.6, 0.24], offset: [0.36, 1.06, -0.06], color: 0x6b4a33, anim: 'armR' },
      { name: 'legL', size: [0.22, 0.62, 0.22], offset: [-0.13, 0.31, 0], color: 0x4a3626, anim: 'legFL' },
      { name: 'legR', size: [0.22, 0.62, 0.22], offset: [0.13, 0.31, 0], color: 0x4a3626, anim: 'legFR' },
    ]),
  iron_golem: M('Golem de fer', false, 100, 1.5, 1.2, 2.7, 9, 24, 0,
    [{ key: 'iron_ingot', min: 2, max: 4 }, { key: 'poppy', min: 0, max: 2 }],
    [
      { name: 'head', size: [0.6, 0.6, 0.6], offset: [0, 2.36, -0.06], color: 0xcfd0cb, anim: 'head' },
      { name: 'nose', size: [0.16, 0.5, 0.16], offset: [0, 2.28, -0.38], color: 0xbcbdb8, anim: 'head' },
      { name: 'eyeL', size: [0.13, 0.08, 0.06], offset: [-0.19, 2.5, -0.38], color: 0x2b2b30, anim: 'head' },
      { name: 'eyeR', size: [0.13, 0.08, 0.06], offset: [0.19, 2.5, -0.38], color: 0x2b2b30, anim: 'head' },
      { name: 'vine', size: [0.5, 0.16, 0.5], offset: [0, 2.06, -0.06], color: 0x4d6b33 },
      { name: 'torso', size: [0.9, 0.9, 0.6], offset: [0, 1.55, 0], color: 0xc6c7c2 },
      { name: 'belt', size: [0.7, 0.5, 0.5], offset: [0, 1.0, 0], color: 0xb4b5b0 },
      { name: 'armL', size: [0.3, 1.5, 0.34], offset: [-0.66, 1.5, 0], color: 0xc6c7c2, anim: 'armL' },
      { name: 'armR', size: [0.3, 1.5, 0.34], offset: [0.66, 1.5, 0], color: 0xc6c7c2, anim: 'armR' },
      { name: 'legL', size: [0.36, 0.76, 0.4], offset: [-0.24, 0.38, 0], color: 0xa9aaa5, anim: 'legFL' },
      { name: 'legR', size: [0.36, 0.76, 0.4], offset: [0.24, 0.38, 0], color: 0xa9aaa5, anim: 'legFR' },
    ],
    { guard: true, retaliates: true, knockback: 9 }),

  // --- Créatures nouvelles --------------------------------------------------
  /** Céphalopode des grands fonds : lent hors de l'eau, redoutable dedans. */
  kraken: M('Kraken', true, 70, 3.4, 1.8, 1.9, 7, 26, 12,
    [{ key: 'string', min: 1, max: 3 }, { key: 'emerald', min: 0, max: 2 }, { key: 'lapis', min: 0, max: 3 }],
    [
      { name: 'mantle', size: [1.1, 1.3, 1.2], offset: [0, 1.25, 0.15], color: 0x5b2f6b },
      { name: 'crown', size: [0.8, 0.36, 0.8], offset: [0, 1.95, 0.15], color: 0x6d3a80 },
      { name: 'head', size: [1.0, 0.7, 0.9], offset: [0, 0.85, -0.55], color: 0x6d3a80, anim: 'head' },
      { name: 'eyeL', size: [0.24, 0.24, 0.1], offset: [-0.32, 0.98, -1.02], color: 0xf0e46a, anim: 'head' },
      { name: 'eyeR', size: [0.24, 0.24, 0.1], offset: [0.32, 0.98, -1.02], color: 0xf0e46a, anim: 'head' },
      { name: 't1', size: [0.2, 1.1, 0.2], offset: [-0.42, 0.3, -0.72], color: 0x7a4590, anim: 'legFL' },
      { name: 't2', size: [0.2, 1.1, 0.2], offset: [0.42, 0.3, -0.72], color: 0x7a4590, anim: 'legFR' },
      { name: 't3', size: [0.2, 1.0, 0.2], offset: [-0.6, 0.3, -0.2], color: 0x6b3b80, anim: 'legBL' },
      { name: 't4', size: [0.2, 1.0, 0.2], offset: [0.6, 0.3, -0.2], color: 0x6b3b80, anim: 'legBR' },
      { name: 't5', size: [0.18, 0.9, 0.18], offset: [-0.3, 0.3, 0.4], color: 0x5b2f6b, anim: 'legBR' },
      { name: 't6', size: [0.18, 0.9, 0.18], offset: [0.3, 0.3, 0.4], color: 0x5b2f6b, anim: 'legBL' },
    ],
    { aquatic: true, knockback: 7 }),
  /**
   * L'idiot du village : il porte un seau sur la tête, court dans tous les sens
   * et ne suit jamais bien longtemps la même idée. Inoffensif.
   */
  village_idiot: M('Idiot du village', false, 20, 2.6, 0.6, 1.95, 0, 0, 3,
    [{ key: 'emerald', min: 0, max: 1 }, { key: 'brown_mushroom', min: 1, max: 2 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.62, 0], color: 0xb08769, anim: 'head' },
      { name: 'bucket', size: [0.58, 0.4, 0.58], offset: [0, 1.96, 0], color: 0xb9bcc0, anim: 'head' },
      { name: 'nose', size: [0.16, 0.24, 0.16], offset: [0, 1.54, -0.31], color: 0xa07257, anim: 'head' },
      { name: 'eyeL', size: [0.13, 0.11, 0.06], offset: [-0.155, 1.71, -0.27], color: 0xe8e4dc, anim: 'head' },
      { name: 'eyeR', size: [0.13, 0.11, 0.06], offset: [0.155, 1.68, -0.27], color: 0xe8e4dc, anim: 'head' },
      // Les pupilles partent chacune de leur côté : c'est tout le personnage.
      { name: 'pupilL', size: [0.06, 0.08, 0.05], offset: [-0.2, 1.71, -0.29], color: 0x33322c, anim: 'head' },
      { name: 'pupilR', size: [0.06, 0.08, 0.05], offset: [0.12, 1.68, -0.29], color: 0x33322c, anim: 'head' },
      { name: 'robe', size: [0.52, 0.78, 0.3], offset: [0, 1.0, 0], color: 0x8a7a3a },
      { name: 'patch', size: [0.2, 0.2, 0.32], offset: [-0.14, 0.9, 0], color: 0x5f6b8a },
      { name: 'armL', size: [0.2, 0.6, 0.24], offset: [-0.36, 1.06, -0.06], color: 0x8a7a3a, anim: 'armL' },
      { name: 'armR', size: [0.2, 0.6, 0.24], offset: [0.36, 1.06, -0.06], color: 0x8a7a3a, anim: 'armR' },
      { name: 'legL', size: [0.22, 0.62, 0.22], offset: [-0.13, 0.31, 0], color: 0x6a5a2a, anim: 'legFL' },
      { name: 'legR', size: [0.22, 0.62, 0.22], offset: [0.13, 0.31, 0], color: 0x6a5a2a, anim: 'legFR' },
    ],
    { erratic: true }),

  /** Braise : elle flotte au-dessus de la lave et ne craint pas le feu. */
  blaze: M('Braise', true, 20, 2.6, 0.6, 1.8, 5, 24, 10,
    [{ key: 'blaze_rod', min: 1, max: 2 }, { key: 'gunpowder', min: 0, max: 1 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 1.4, 0], color: 0xf2c832, anim: 'head' },
      { name: 'eyeL', size: [0.12, 0.1, 0.06], offset: [-0.13, 1.46, -0.27], color: 0x3a2a10, anim: 'head' },
      { name: 'eyeR', size: [0.12, 0.1, 0.06], offset: [0.13, 1.46, -0.27], color: 0x3a2a10, anim: 'head' },
      { name: 'core', size: [0.3, 0.5, 0.3], offset: [0, 0.85, 0], color: 0xffe08a },
      // Les douze bâtons tournent autour du corps.
      { name: 'r1', size: [0.12, 0.7, 0.12], offset: [-0.36, 1.0, 0], color: 0xe8a01a, anim: 'armL' },
      { name: 'r2', size: [0.12, 0.7, 0.12], offset: [0.36, 1.0, 0], color: 0xe8a01a, anim: 'armR' },
      { name: 'r3', size: [0.12, 0.6, 0.12], offset: [0, 0.9, -0.36], color: 0xf2b02a, anim: 'legFL' },
      { name: 'r4', size: [0.12, 0.6, 0.12], offset: [0, 0.9, 0.36], color: 0xf2b02a, anim: 'legFR' },
      { name: 'r5', size: [0.1, 0.5, 0.1], offset: [-0.26, 0.6, -0.26], color: 0xd88a10, anim: 'legBL' },
      { name: 'r6', size: [0.1, 0.5, 0.1], offset: [0.26, 0.6, 0.26], color: 0xd88a10, anim: 'legBR' },
    ],
    { flies: true, knockback: 3 }),

  /** Enderman : long, silencieux, et se dérobe dès qu'on le touche. */
  enderman: M('Enderman', true, 40, 3.2, 0.6, 2.9, 6, 20, 8,
    [{ key: 'ender_pearl', min: 1, max: 2 }],
    [
      { name: 'head', size: [0.5, 0.5, 0.5], offset: [0, 2.6, 0], color: 0x100f14, anim: 'head' },
      { name: 'eyeL', size: [0.16, 0.08, 0.05], offset: [-0.13, 2.66, -0.27], color: 0xd8a8ff, anim: 'head' },
      { name: 'eyeR', size: [0.16, 0.08, 0.05], offset: [0.13, 2.66, -0.27], color: 0xd8a8ff, anim: 'head' },
      { name: 'body', size: [0.42, 0.9, 0.26], offset: [0, 1.9, 0], color: 0x16151c },
      { name: 'armL', size: [0.14, 1.3, 0.14], offset: [-0.28, 1.7, 0], color: 0x100f14, anim: 'armL' },
      { name: 'armR', size: [0.14, 1.3, 0.14], offset: [0.28, 1.7, 0], color: 0x100f14, anim: 'armR' },
      { name: 'legL', size: [0.14, 1.4, 0.14], offset: [-0.11, 0.7, 0], color: 0x16151c, anim: 'legFL' },
      { name: 'legR', size: [0.14, 1.4, 0.14], offset: [0.11, 0.7, 0], color: 0x16151c, anim: 'legFR' },
    ],
    { blinks: true, knockback: 5 }),

  /**
   * Le dragon de l'End. Il tourne au-dessus de l'île, pique sur le joueur, et
   * se régénère tant qu'un cristal reste debout sur une colonne.
   */
  ender_dragon: M('Dragon de l’End', true, 200, 11, 6, 4, 12, 90, 500,
    [{ key: 'ender_pearl', min: 4, max: 8 }, { key: 'end_crystal', min: 1, max: 2 }],
    [
      // Corps.
      { name: 'body', size: [1.7, 1.3, 3.2], offset: [0, 2.2, 0], color: 0x322c46 },
      { name: 'ridge', size: [0.3, 0.4, 3.0], offset: [0, 2.95, 0], color: 0x6f5ab0 },
      // Cou et tête, portés en avant.
      { name: 'neck', size: [0.9, 0.9, 2.2], offset: [0, 2.7, -2.3], color: 0x3a3352, anim: 'head' },
      { name: 'head', size: [1.2, 1.0, 1.6], offset: [0, 2.9, -4.0], color: 0x322c46, anim: 'head' },
      { name: 'jaw', size: [1.0, 0.34, 1.3], offset: [0, 2.44, -4.1], color: 0x272238, anim: 'head' },
      { name: 'eyeL', size: [0.3, 0.2, 0.1], offset: [-0.42, 3.16, -4.7], color: 0xd83a8c, anim: 'head' },
      { name: 'eyeR', size: [0.3, 0.2, 0.1], offset: [0.42, 3.16, -4.7], color: 0xd83a8c, anim: 'head' },
      { name: 'hornL', size: [0.2, 0.6, 0.2], offset: [-0.44, 3.5, -3.7], color: 0x6f5ab0, anim: 'head' },
      { name: 'hornR', size: [0.2, 0.6, 0.2], offset: [0.44, 3.5, -3.7], color: 0x6f5ab0, anim: 'head' },
      // Ailes membraneuses, en deux segments.
      { name: 'wingL', size: [3.4, 0.16, 1.9], offset: [-2.5, 2.7, 0.1], color: 0x453c63, anim: 'wingL' },
      { name: 'wingLTip', size: [2.6, 0.14, 1.3], offset: [-5.4, 2.7, 0.6], color: 0x554a78, anim: 'wingL' },
      { name: 'wingR', size: [3.4, 0.16, 1.9], offset: [2.5, 2.7, 0.1], color: 0x453c63, anim: 'wingR' },
      { name: 'wingRTip', size: [2.6, 0.14, 1.3], offset: [5.4, 2.7, 0.6], color: 0x554a78, anim: 'wingR' },
      // Queue en trois tronçons qui s'affine.
      { name: 'tail1', size: [0.8, 0.8, 1.8], offset: [0, 2.2, 2.3], color: 0x3a3352, anim: 'tail' },
      { name: 'tail2', size: [0.55, 0.55, 1.8], offset: [0, 2.2, 4.0], color: 0x322c46, anim: 'tail' },
      { name: 'tail3', size: [0.32, 0.32, 1.6], offset: [0, 2.2, 5.6], color: 0x272238, anim: 'tail' },
      // Pattes repliées sous le corps.
      { name: 'legL', size: [0.44, 1.0, 0.44], offset: [-0.7, 1.3, -0.6], color: 0x3a3352, anim: 'legFL' },
      { name: 'legR', size: [0.44, 1.0, 0.44], offset: [0.7, 1.3, -0.6], color: 0x3a3352, anim: 'legFR' },
    ],
    { flies: true, orbit: [42, 82], knockback: 14 }),

  /** Le « bloop » : une masse gélatineuse qui rebondit et colle aux basques. */
  bloop: M('Bloop', true, 14, 2.6, 0.85, 0.85, 3, 18, 4,
    [{ key: 'clay_ball', min: 1, max: 3 }, { key: 'gunpowder', min: 0, max: 1 }],
    [
      { name: 'body', size: [0.8, 0.62, 0.8], offset: [0, 0.32, 0], color: 0x63c86e },
      { name: 'crest', size: [0.56, 0.2, 0.56], offset: [0, 0.72, 0], color: 0x7ee089 },
      { name: 'eyeL', size: [0.14, 0.14, 0.08], offset: [-0.18, 0.44, -0.42], color: 0x14261a, anim: 'head' },
      { name: 'eyeR', size: [0.14, 0.14, 0.08], offset: [0.18, 0.44, -0.42], color: 0x14261a, anim: 'head' },
      { name: 'mouth', size: [0.3, 0.08, 0.06], offset: [0, 0.24, -0.42], color: 0x14261a, anim: 'head' },
      { name: 'footL', size: [0.2, 0.14, 0.24], offset: [-0.22, 0.07, 0], color: 0x4fae59, anim: 'legFL' },
      { name: 'footR', size: [0.2, 0.14, 0.24], offset: [0.22, 0.07, 0], color: 0x4fae59, anim: 'legFR' },
    ],
    { hops: true }),

  // Avion. Vitesse nulle au repos : garé, il ne bouge pas d'un pouce, et son
  // pilotage ne passe pas par l'IA mais par `updateAircraft`.
  plane: M('Avion', false, 40, 0, 1.3, 1.7, 0, 0, 0, [],
    [
      { name: 'fuselage', size: [0.7, 0.66, 3.2], offset: [0, 1.0, 0], color: 0xd23c30 },
      { name: 'nose', size: [0.58, 0.58, 0.5], offset: [0, 1.02, -1.82], color: 0xb02c22 },
      { name: 'moyeu', size: [0.2, 0.2, 0.16], offset: [0, 1.02, -2.12], color: 0x3a3a40 },
      { name: 'helice', size: [1.7, 0.14, 0.06], offset: [0, 1.02, -2.2], color: 0x6a6a72, anim: 'prop' },
      { name: 'aileL', size: [2.3, 0.13, 0.95], offset: [-1.45, 1.12, -0.1], color: 0xf0efe8 },
      { name: 'aileR', size: [2.3, 0.13, 0.95], offset: [1.45, 1.12, -0.1], color: 0xf0efe8 },
      { name: 'bandeL', size: [2.3, 0.05, 0.2], offset: [-1.45, 1.2, -0.1], color: 0xd23c30 },
      { name: 'bandeR', size: [2.3, 0.05, 0.2], offset: [1.45, 1.2, -0.1], color: 0xd23c30 },
      { name: 'cabine', size: [0.52, 0.4, 0.85], offset: [0, 1.42, -0.35], color: 0x2a3a4a },
      { name: 'derive', size: [0.11, 0.75, 0.65], offset: [0, 1.6, 1.42], color: 0xd23c30 },
      { name: 'planL', size: [0.9, 0.11, 0.45], offset: [-0.52, 1.16, 1.5], color: 0xf0efe8 },
      { name: 'planR', size: [0.9, 0.11, 0.45], offset: [0.52, 1.16, 1.5], color: 0xf0efe8 },
      { name: 'trainL', size: [0.14, 0.5, 0.14], offset: [-0.5, 0.45, -0.6], color: 0x3a3a40 },
      { name: 'trainR', size: [0.14, 0.5, 0.14], offset: [0.5, 0.45, -0.6], color: 0x3a3a40 },
      { name: 'roueL', size: [0.28, 0.28, 0.16], offset: [-0.5, 0.18, -0.6], color: 0x1c1c20 },
      { name: 'roueR', size: [0.28, 0.28, 0.16], offset: [0.5, 0.18, -0.6], color: 0x1c1c20 },
      { name: 'roulette', size: [0.2, 0.2, 0.12], offset: [0, 0.16, 1.35], color: 0x1c1c20 },
    ],
    { rideable: true, aircraft: true }),
};

// --- Modèle de vol ---------------------------------------------------------
// Volontairement « arcade » : on vole là où l'on regarde, et la seule chose à
// surveiller est la vitesse. Un modèle réaliste demanderait un manche, des
// gouvernes et un compensateur — hors de portée d'un enfant à la souris.
/** Vitesse maximale, en blocs par seconde. */
const PLANE_MAX = 26;
/** Poussée, freinage et traînée, en blocs par seconde carrée. */
const PLANE_ACCEL = 9;
const PLANE_BRAKE = 13;
const PLANE_DRAG = 2.2;
/** En dessous de cette vitesse, la portance s'efface et l'avion décroche. */
const PLANE_STALL = 9;

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
  /**
   * Cible prioritaire d'un gardien, choisie par le jeu : un golem de fer
   * frappe les créatures hostiles autour de lui plutôt que le joueur.
   */
  threat: Mob | null = null;
  /** Phase de rebond, pour les créatures qui sautillent. */
  private hopTimer = 0;
  /** Mouton déjà tondu : il ne rendra plus de laine. */
  shorn = false;
  /** Montée par le joueur : elle obéit aux commandes plutôt qu'à son IA. */
  ridden = false;
  /** Commande du cavalier : direction souhaitée dans le repère du monde, et saut. */
  driveX = 0;
  driveZ = 0;
  driveJump = false;
  /** Commandes propres au vol : cap et assiette visés, et frein. */
  driveYaw = 0;
  drivePitch = 0;
  driveBrake = false;
  /** Vitesse air de l'engin piloté. */
  airspeed = 0;
  /** Assiette et inclinaison du modèle, pour le rendu. */
  private pitch = 0;
  private roll = 0;
  /** Téléportation demandée par un coup reçu (enderman). */
  private blinkPending = false;
  private blinkCooldown = 0;
  /** Plan de vol du boss : angle sur l'orbite, phase de piqué, altitude visée. */
  private orbitAngle = 0;
  private diving = false;
  private diveTimer = 6;
  private flyTargetY = 0;
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
    // Un engin piloté a sa propre physique : ni décision, ni errance, ni
    // poursuite. Le brancher dans la chaîne commune reviendrait à laisser
    // l'errance écraser les commandes une image sur deux.
    if (this.def.aircraft && this.ridden) {
      this.updateAircraft(dt, world, dayFactor);
      return;
    }
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;

    const d = this.def;
    // Un gardien vise sa menace ; tout le monde vise le joueur.
    const guarding = d.guard === true && this.threat !== null && !this.threat.dead;
    const focus = guarding ? this.threat!.position : playerPos;
    const toPlayer = tmpVec.copy(focus).sub(this.position);
    const dist = toPlayer.length();

    // --- Décision ---
    let wishX = 0, wishZ = 0;
    if (this.ridden) {
      this.aggro = false;
    } else if (guarding) {
      this.aggro = true;
    } else if (d.hostile && playerReachable && dist < d.aggroRange) {
      this.aggro = true;
    } else if (dist > d.aggroRange * 1.6 || (!d.hostile && !d.retaliates)) {
      this.aggro = false;
    }

    if (this.ridden) {
      // Sous la selle, la monture n'écoute plus qu'une chose : le cavalier.
      // Ce cas doit venir avant l'errance, qui écraserait sinon la commande.
      wishX = this.driveX;
      wishZ = this.driveZ;
      if (wishX !== 0 || wishZ !== 0) this.yaw = Math.atan2(wishX, wishZ);
      if (this.driveJump && this.onGround) this.velocity.y = 9.5;
    } else if (d.orbit) {
      // Le boss suit son propre plan de vol : ni errance ni poursuite directe.
      this.aggro = true;
      const [radius, height] = d.orbit;
      this.diveTimer -= dt;
      if (this.diveTimer <= 0) {
        this.diving = !this.diving;
        // Un piqué court, puis une longue remontée : le joueur a le temps de riposter.
        this.diveTimer = this.diving ? 3.5 : 7 + this.rnd() * 5;
      }

      let tx: number, ty: number, tz: number;
      if (this.diving) {
        tx = focus.x; ty = focus.y + 1.2; tz = focus.z;
      } else {
        // Point courant de l'orbite autour de l'origine de l'île.
        this.orbitAngle += dt * (d.speed / Math.max(8, radius));
        tx = Math.cos(this.orbitAngle) * radius;
        tz = Math.sin(this.orbitAngle) * radius;
        ty = height + Math.sin(this.age * 0.4) * 3;
      }
      const dx = tx - this.position.x, dz = tz - this.position.z;
      const len = Math.hypot(dx, dz) || 1;
      wishX = dx / len;
      wishZ = dz / len;
      this.yaw = Math.atan2(dx, dz);
      this.flyTargetY = ty;

      if (dist < 4 + d.width * 0.5 && this.attackCooldown <= 0) {
        this.attackCooldown = 1.4;
        onDamagePlayer(d.damage);
      }
    } else if (this.aggro && dist > 0.05) {
      this.yaw = Math.atan2(toPlayer.x, toPlayer.z);
      const drive = this.kind === 'creeper' && this.fuse >= 0 ? 0 : 1;
      wishX = (toPlayer.x / dist) * drive;
      wishZ = (toPlayer.z / dist) * drive;

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
        if (guarding) {
          const t = this.threat!;
          t.hurt(d.damage);
          const k = d.knockback ?? 4;
          t.velocity.x += (toPlayer.x / dist) * k;
          t.velocity.z += (toPlayer.z / dist) * k;
          t.velocity.y += k * 0.45;
        } else {
          onDamagePlayer(d.damage);
        }
      }
    } else if (!d.aircraft) {
      // Errance. Un engin garé, lui, ne bouge pas tout seul.
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        // L'idiot repart dans une autre direction toutes les demi-secondes.
        this.wanderTimer = d.erratic ? 0.3 + this.rnd() * 0.9 : 2 + this.rnd() * 5;
        this.wanderMove = this.rnd() < (d.erratic ? 0.9 : 0.65);
        this.wanderYaw += (this.rnd() - 0.5) * (d.erratic ? 5 : 2.4);
      }
      if (this.wanderMove) {
        this.yaw = this.wanderYaw;
        wishX = Math.sin(this.wanderYaw) * 0.45;
        wishZ = Math.cos(this.wanderYaw) * 0.45;
      }
    }

    // --- Téléportation ---
    if (this.blinkCooldown > 0) this.blinkCooldown -= dt;
    if (this.blinkPending && this.blinkCooldown <= 0) {
      this.blinkPending = false;
      this.blinkCooldown = 1.4;
      this.blink(world);
    }

    // --- Physique ---
    this.inWater = isLiquid(world, this.position.x, this.position.y + 0.2, this.position.z);
    // Une créature qui sautille n'avance qu'en l'air : au sol elle prend son élan.
    const airborne = d.hops === true && !this.onGround && !this.inWater;
    const grounded = d.hops === true && this.onGround && !this.inWater;
    // Une monture doit dépasser la course à pied (5,9 m/s), sinon elle ne sert
    // à rien : 2,1 × 3,4 ≈ 7,1 m/s.
    let speed = this.ridden ? d.speed * 3.4 : d.speed * (this.aggro ? 1 : 0.7);
    if (d.hops) speed *= airborne ? 1 : 0.15;
    if (d.aquatic && !this.inWater) speed *= 0.3; // échoué : presque immobile
    this.velocity.x += (wishX * speed - this.velocity.x) * Math.min(1, (grounded ? 3 : 9) * dt);
    this.velocity.z += (wishZ * speed - this.velocity.z) * Math.min(1, (grounded ? 3 : 9) * dt);

    if (d.flies) {
      // Vol libre : la créature vise l'altitude de sa cible, et s'écarte du sol.
      const want = d.orbit ? this.flyTargetY
        : this.aggro ? focus.y + 1.2
          : this.position.y + Math.sin(this.age * 0.8) * 1.5;
      let climb = clampNum(want - this.position.y, -1, 1);
      // Quelque chose juste sous les pieds — roche ou lave : on prend de
      // l'altitude, une braise ne se pose jamais.
      if (blockUnder(world, this.position) !== 0) climb = 1;
      this.velocity.y += (climb * d.speed - this.velocity.y) * Math.min(1, 5 * dt);
    } else if (d.aquatic) {
      // Nage : flottabilité neutre dans l'eau, chute lourde à l'air libre.
      if (this.inWater) {
        const dy = focus.y + 0.5 - this.position.y;
        const climb = this.aggro ? clampNum(dy, -1, 1) : Math.sin(this.age * 0.6) * 0.4;
        this.velocity.y += (climb * d.speed * 0.8 - this.velocity.y) * Math.min(1, 4 * dt);
      } else {
        this.velocity.y -= GRAVITY * dt;
      }
    } else if (this.inWater) {
      this.velocity.y += 14 * dt;
      this.velocity.y *= 0.86;
    } else {
      this.velocity.y -= GRAVITY * dt;
      if (this.velocity.y < -TERMINAL_VELOCITY) this.velocity.y = -TERMINAL_VELOCITY;
    }

    // Rebond régulier du « bloop » : c'est sa seule façon d'avancer.
    if (d.hops) {
      this.hopTimer -= dt;
      if (this.onGround && this.hopTimer <= 0) {
        this.velocity.y = this.aggro ? 8.4 : 6.4;
        this.hopTimer = this.aggro ? 0.55 : 1.4 + this.rnd() * 1.6;
      }
    }

    const box: Box = { x: this.position.x, y: this.position.y, z: this.position.z, width: d.width, height: d.height };
    const res = moveBox(world, box, this.velocity, dt, 0.55);
    // Franchit les marches d'un bloc.
    if ((res.hitX || res.hitZ) && res.onGround && this.jumpCooldown <= 0 && !d.hops && !d.flies) {
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
    // Les modèles regardent vers -Z, alors que `yaw` suit la convention
    // `atan2(dx, dz)` du reste du jeu. Sans ce demi-tour, toutes les créatures
    // avançaient à reculons et ne montraient jamais que leur arrière-train —
    // le modèle du joueur applique déjà la même correction.
    this.group.rotation.y = this.yaw + Math.PI;
    this.animate(planar);

    const l = world.getLight(Math.floor(this.position.x), Math.floor(this.position.y + 1), Math.floor(this.position.z));
    voxelLightColor(l >> 4, l & 15, dayFactor, lightColor);
    (this.material.uniforms.uLight.value as Color).copy(lightColor);
    const flashing = this.kind === 'creeper' && this.fuse >= 0 ? (Math.sin(this.fuse * 26) * 0.5 + 0.5) * 0.9 : 0;
    this.material.uniforms.uFlash.value = Math.max(this.hurtFlash, flashing);
  }

  /**
   * Vol piloté. L'avion suit le regard du pilote ; la vitesse fait tout le
   * reste. Au-dessus de la vitesse de décrochage il tient sa trajectoire, en
   * dessous la portance s'efface et il retombe.
   */
  private updateAircraft(dt: number, world: World, dayFactor: number): void {
    if (this.driveJump) this.airspeed = Math.min(PLANE_MAX, this.airspeed + PLANE_ACCEL * dt);
    else if (this.driveBrake) this.airspeed = Math.max(0, this.airspeed - PLANE_BRAKE * dt);
    else this.airspeed = Math.max(0, this.airspeed - PLANE_DRAG * dt);

    // Cap et assiette visés, lissés : sans ça, un coup de souris ferait pivoter
    // l'avion instantanément et le vol serait illisible.
    const dYaw = wrapAngle(this.driveYaw - this.yaw);
    const suivi = Math.min(1, 5 * dt);
    this.yaw = wrapAngle(this.yaw + dYaw * suivi);
    this.pitch += (this.drivePitch - this.pitch) * suivi;

    const cp = Math.cos(this.pitch);
    const dx = -Math.sin(this.yaw) * cp;
    const dy = -Math.sin(this.pitch);
    const dz = -Math.cos(this.yaw) * cp;

    // Portance. Elle vaut 1 dès la vitesse de décrochage — l'avion tient alors
    // exactement la trajectoire visée — et s'effondre au carré en dessous : un
    // décrochage doit se creuser vite, sinon l'avion plane indéfiniment moteur
    // coupé et la vitesse cesse d'être un enjeu.
    const v = Math.min(1, this.airspeed / PLANE_STALL);
    const portance = v * v;
    this.velocity.x = dx * this.airspeed;
    this.velocity.z = dz * this.airspeed;
    this.velocity.y += (dy * this.airspeed - this.velocity.y) * Math.min(1, 6 * dt) * portance;
    this.velocity.y -= GRAVITY * dt * (1 - portance);
    if (this.velocity.y < -TERMINAL_VELOCITY) this.velocity.y = -TERMINAL_VELOCITY;

    // L'inclinaison suit le taux de virage : l'avion se penche dans ses virages.
    const vise = clampNum(-dYaw * 2.2, -0.7, 0.7);
    this.roll += (vise - this.roll) * Math.min(1, 4 * dt);

    const d = this.def;
    const box: Box = { x: this.position.x, y: this.position.y, z: this.position.z, width: d.width, height: d.height };
    const res = moveBox(world, box, this.velocity, dt, 0.55);
    this.position.set(box.x, box.y, box.z);
    this.onGround = res.onGround;
    // Un choc contre le relief coupe l'élan : on ne traverse pas une colline.
    if (res.hitX || res.hitZ) this.airspeed *= 0.3;
    // Au sol, les roues freinent toutes seules.
    if (res.onGround && !this.driveJump) this.airspeed = Math.max(0, this.airspeed - PLANE_DRAG * 2 * dt);
    if (this.position.y < -8) { this.dead = true; return; }

    this.group.position.copy(this.position);
    // Le modèle regarde vers -Z, d'où le demi-tour ; l'ordre YXZ fait tourner
    // l'assiette et l'inclinaison dans le repère déjà orienté par le cap.
    this.group.rotation.order = 'YXZ';
    this.group.rotation.set(-this.pitch, this.yaw + Math.PI, this.roll);
    this.walkPhase += dt * (2 + this.airspeed);
    this.animate(this.airspeed);

    const l = world.getLight(Math.floor(this.position.x), Math.floor(this.position.y + 1), Math.floor(this.position.z));
    voxelLightColor(l >> 4, l & 15, dayFactor, lightColor);
    (this.material.uniforms.uLight.value as Color).copy(lightColor);
    this.material.uniforms.uFlash.value = this.hurtFlash;
  }

  private animate(planar: number): void {
    const d = this.def;
    // Une masse gélatineuse s'écrase à l'atterrissage et s'étire en l'air.
    if (d.hops) {
      const squash = this.onGround ? 1 - Math.min(0.3, Math.max(0, this.hopTimer) * 0.4) : 1 + Math.min(0.28, Math.abs(this.velocity.y) * 0.03);
      this.group.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
    }
    // Les tentacules ondulent en permanence, même à l'arrêt.
    const swing = d.aquatic
      ? Math.sin(this.age * 3.2) * 0.45
      : Math.sin(this.walkPhase * 2.4) * Math.min(0.7, 0.18 + planar * 0.22);
    // Battement d'ailes : plus ample et plus lent que la marche.
    const flap = Math.sin(this.age * 2.2) * 0.55;
    if (d.aquatic) this.group.rotation.x = Math.sin(this.age * 1.3) * 0.12 - (this.inWater ? 0 : 0.3);
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
        // Les ailes pivotent autour de l'axe Z, sinon elles battraient d'avant
        // en arrière au lieu de haut en bas.
        case 'wingL':
          p.mesh.rotation.z = flap;
          break;
        case 'wingR':
          p.mesh.rotation.z = -flap;
          break;
        case 'tail':
          // Décalage de phase par tronçon : la queue ondule, elle ne pivote pas
          // d'un bloc.
          p.mesh.rotation.y = Math.sin(this.age * 1.7 - p.base.z * 0.35) * 0.28;
          break;
        // L'hélice tourne d'autant plus vite que l'avion va vite, et continue
        // de tourner au ralenti moteur coupé.
        case 'prop':
          p.mesh.rotation.z = this.age * (6 + this.airspeed * 3.2);
          break;
        default:
          break;
      }
      // Ailes et queue s'articulent à leur emplanture, pas en leur centre.
      if (p.anim === 'wingL' || p.anim === 'wingR') {
        const w = (p.mesh.geometry as BoxGeometry).parameters.width;
        const sign = p.anim === 'wingL' ? -1 : 1;
        const pivotX = p.base.x - sign * (w / 2);
        const a = p.mesh.rotation.z;
        p.mesh.position.set(pivotX + sign * (w / 2) * Math.cos(a), p.base.y + sign * (w / 2) * Math.sin(a), p.base.z);
        continue;
      }
      if (p.anim === 'tail') {
        const dz = (p.mesh.geometry as BoxGeometry).parameters.depth;
        const a = p.mesh.rotation.y;
        p.mesh.position.set(
          p.base.x + Math.sin(a) * (dz / 2),
          p.base.y,
          p.base.z - dz / 2 + Math.cos(a) * (dz / 2),
        );
        continue;
      }
      if (p.anim && p.anim !== 'head' && p.anim !== 'none' && p.anim !== 'prop') {
        // Pivot au sommet de la pièce plutôt qu'en son centre.
        const h = (p.mesh.geometry as BoxGeometry).parameters.height;
        const r = p.mesh.rotation.x;
        p.mesh.position.set(p.base.x, p.base.y - (h / 2) * (1 - Math.cos(r)), p.base.z + (h / 2) * Math.sin(r));
      }
    }
  }

  /** Cherche un sol libre dans un rayon de huit blocs et s'y pose. */
  private blink(world: World): void {
    for (let t = 0; t < 12; t++) {
      const a = this.rnd() * Math.PI * 2;
      const r = 4 + this.rnd() * 5;
      const x = Math.floor(this.position.x + Math.cos(a) * r);
      const z = Math.floor(this.position.z + Math.sin(a) * r);
      for (let dy = 3; dy >= -3; dy--) {
        const y = Math.floor(this.position.y) + dy;
        if (y < 2 || y >= WORLD_HEIGHT - 4) continue;
        if (!isSolidAt(world, x + 0.5, y - 1, z + 0.5)) continue;
        let clear = true;
        for (let h = 0; h < Math.ceil(this.def.height); h++) {
          if (world.getBlock(x, y + h, z) !== 0) { clear = false; break; }
        }
        if (!clear) continue;
        this.position.set(x + 0.5, y, z + 0.5);
        this.velocity.set(0, 0, 0);
        this.group.position.copy(this.position);
        return;
      }
    }
  }

  hurt(amount: number): boolean {
    this.health -= amount;
    this.hurtFlash = 1;
    this.aggro = true;
    // L'enderman ne encaisse pas : il se dérobe d'un pas de côté.
    if (this.def.blinks) this.blinkPending = true;
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
    const res = moveBox(world, box, this.velocity, dt, 0);
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

function isSolidAt(world: World, x: number, y: number, z: number): boolean {
  const b = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  return b > 0 && IS_SOLID[b] !== 0;
}

/** Bloc immédiatement sous une position, air compris. */
function blockUnder(world: World, p: Vector3): number {
  return world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.6), Math.floor(p.z));
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

/** Emplacement immergé pour une créature aquatique (kraken). */
export function findWaterSpawnSpot(
  world: World,
  cx: number,
  cz: number,
  rnd: () => number,
  height: number,
): Vector3 | null {
  for (let attempt = 0; attempt < 16; attempt++) {
    const x = Math.floor(cx + (rnd() - 0.5) * 72);
    const z = Math.floor(cz + (rnd() - 0.5) * 72);
    // On descend depuis la surface jusqu'à trouver une colonne d'eau assez haute.
    for (let y = SEA_LEVEL - 2; y > SEA_LEVEL - 26; y--) {
      if (y < 4) break;
      let deep = true;
      for (let h = 0; h < Math.ceil(height) + 1; h++) {
        if (world.getBlock(x, y + h, z) !== B.water) { deep = false; break; }
      }
      if (!deep) continue;
      if (world.getBlock(x, y - 1, z) === 0) continue;
      return new Vector3(x + 0.5, y, z + 0.5);
    }
  }
  return null;
}

/** Ramène un écart d'angle dans [-π, π] : un cap ne fait jamais le tour long. */
function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const tmpVec = new Vector3();
const lightColor = new Color();
