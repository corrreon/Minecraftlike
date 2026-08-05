/**
 * Tables de butin des coffres de structures et du mode « oneblock ».
 *
 * Le tirage est déterministe pour un coffre donné : sa position sert de graine.
 * Un coffre ouvert, refermé et rouvert après un rechargement du monde rend donc
 * exactement le même contenu, sans qu'on ait à l'écrire dans la sauvegarde.
 */

import { ITEM_BY_KEY, type ItemDef } from './items';
import { makeStack, type ItemStack } from './Inventory';
import { mulberry32 } from '../world/noise';
import type { LootKind } from '../world/structures';

/** [clé, poids, min, max] */
type Entry = readonly [string, number, number, number];

interface Table {
  /** Nombre de piles tirées. */
  rolls: [number, number];
  entries: readonly Entry[];
}

const TABLES: Record<LootKind, Table> = {
  village: {
    rolls: [3, 6],
    entries: [
      ['bread', 10, 1, 3],
      ['wheat', 10, 2, 6],
      ['wheat_seeds', 8, 2, 5],
      ['apple', 7, 1, 3],
      ['carrot', 8, 2, 5],
      ['emerald', 5, 1, 2],
      ['iron_ingot', 5, 1, 3],
      ['coal', 6, 1, 4],
      ['stick', 6, 2, 5],
      ['oak_planks', 6, 4, 12],
      ['pumpkin', 4, 1, 3],
      ['leather', 4, 1, 2],
      ['book', 3, 1, 2],
      ['iron_pickaxe', 2, 1, 1],
      ['torch', 6, 3, 8],
    ],
  },
  shipwreck: {
    rolls: [4, 7],
    entries: [
      ['gold_ingot', 6, 1, 3],
      ['iron_ingot', 6, 1, 4],
      ['emerald', 4, 1, 3],
      ['paper', 8, 1, 5],
      ['book', 4, 1, 2],
      ['leather', 6, 1, 3],
      ['bread', 6, 1, 3],
      ['cooked_beef', 4, 1, 2],
      ['tnt', 3, 1, 2],
      ['lapis', 5, 1, 5],
      ['diamond', 2, 1, 1],
      ['spruce_planks', 6, 4, 10],
    ],
  },
  portal: {
    rolls: [3, 6],
    entries: [
      ['obsidian', 8, 2, 6],
      ['lucky_block', 3, 1, 2],
      ['gold_ingot', 6, 2, 5],
      ['diamond', 3, 1, 2],
      ['emerald', 4, 1, 4],
      ['redstone', 6, 3, 8],
      ['glowstone', 5, 2, 5],
      ['flint', 6, 1, 3],
      ['sea_lantern', 3, 1, 2],
      ['gunpowder', 5, 2, 5],
      ['diamond_sword', 1, 1, 1],
    ],
  },
  mineshaft: {
    rolls: [3, 6],
    entries: [
      ['iron_ingot', 8, 1, 4],
      ['coal', 10, 2, 8],
      ['gold_ingot', 4, 1, 2],
      ['diamond', 2, 1, 2],
      ['redstone', 6, 2, 6],
      ['lapis', 5, 2, 6],
      ['bread', 6, 1, 3],
      ['oak_planks', 8, 4, 10],
      ['torch', 8, 4, 12],
      ['stone_pickaxe', 3, 1, 1],
      ['bone', 5, 1, 3],
      ['rotten_flesh', 4, 1, 2],
    ],
  },
  fortress: {
    rolls: [4, 7],
    entries: [
      ['gold_ingot', 8, 2, 6],
      ['netherite_scrap', 3, 1, 2],
      ['blaze_rod', 5, 1, 3],
      ['nether_bricks', 8, 4, 12],
      ['obsidian', 5, 2, 5],
      ['diamond', 3, 1, 2],
      ['ender_pearl', 4, 1, 3],
      ['glowstone', 6, 2, 6],
      ['cooked_porkchop', 5, 1, 3],
      ['golden_sword', 2, 1, 1],
      ['gunpowder', 5, 2, 6],
    ],
  },
  treasure: {
    rolls: [4, 8],
    entries: [
      ['diamond', 5, 1, 3],
      ['gold_ingot', 8, 2, 6],
      ['emerald', 6, 2, 5],
      ['iron_ingot', 7, 2, 6],
      ['lapis', 5, 2, 8],
      ['gold_block', 2, 1, 2],
      ['cooked_beef', 5, 1, 3],
      ['diamond_pickaxe', 1, 1, 1],
      ['iron_chestplate', 2, 1, 1],
      ['golden_apple', 2, 1, 1],
      ['lucky_block', 4, 1, 3],
      ['tnt', 3, 1, 3],
      ['bone', 5, 1, 4],
    ],
  },
};

function pick(t: Table, r: () => number): Entry | null {
  let total = 0;
  for (const e of t.entries) total += e[1];
  let v = r() * total;
  for (const e of t.entries) {
    v -= e[1];
    if (v <= 0) return e;
  }
  return t.entries[t.entries.length - 1] ?? null;
}

/**
 * Contenu d'un coffre de structure : des piles et leur emplacement dans la
 * grille de 27 cases.
 */
export function rollLoot(kind: LootKind, x: number, y: number, z: number, slots = 27): Map<number, ItemStack> {
  const t = TABLES[kind];
  const r = mulberry32((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0);
  const out = new Map<number, ItemStack>();
  const n = t.rolls[0] + Math.floor(r() * (t.rolls[1] - t.rolls[0] + 1));
  for (let i = 0; i < n; i++) {
    const e = pick(t, r);
    if (!e) continue;
    const def = ITEM_BY_KEY.get(e[0]);
    if (!def) continue;
    const count = Math.min(def.maxStack, e[2] + Math.floor(r() * (e[3] - e[2] + 1)));
    let slot = Math.floor(r() * slots);
    for (let g = 0; g < slots && out.has(slot); g++) slot = (slot + 1) % slots;
    if (out.has(slot)) break;
    out.set(slot, makeStack(def, count));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode « oneblock »
// ---------------------------------------------------------------------------

export interface OneblockPhase {
  name: string;
  /** Nombre de blocs cassés à partir duquel la phase commence. */
  from: number;
  /** [clé de bloc, poids] */
  blocks: readonly (readonly [string, number])[];
  /** Créatures susceptibles de sortir du bloc, avec leur probabilité globale. */
  mobs: readonly string[];
  mobChance: number;
  /** Probabilité qu'un coffre remplace le bloc. */
  chestChance: number;
  chestLoot: LootKind;
}

export const ONEBLOCK_PHASES: readonly OneblockPhase[] = [
  {
    name: 'Prairie', from: 0, mobChance: 0.03, chestChance: 0.012, chestLoot: 'village',
    blocks: [
      ['grass_block', 30], ['dirt', 22], ['oak_log', 8], ['oak_leaves', 8], ['sand', 6],
      ['tall_grass', 5], ['poppy', 3], ['dandelion', 3], ['pumpkin', 2], ['cobblestone', 6],
      ['coal_ore', 4], ['oak_planks', 3],
    ],
    mobs: ['pig', 'cow', 'sheep', 'chicken'],
  },
  {
    name: 'Forêt', from: 100, mobChance: 0.05, chestChance: 0.014, chestLoot: 'village',
    blocks: [
      ['oak_log', 14], ['spruce_log', 10], ['birch_log', 8], ['oak_leaves', 14], ['spruce_leaves', 10],
      ['dirt', 14], ['grass_block', 12], ['coarse_dirt', 6], ['brown_mushroom', 3],
      ['red_mushroom', 3], ['coal_ore', 6], ['iron_ore', 4], ['bookshelf', 2],
    ],
    mobs: ['sheep', 'chicken', 'zombie', 'bloop', 'villager'],
  },
  {
    name: 'Désert', from: 250, mobChance: 0.06, chestChance: 0.016, chestLoot: 'treasure',
    blocks: [
      ['sand', 26], ['sandstone', 18], ['red_sand', 10], ['cactus', 6], ['dead_bush', 4],
      ['gravel', 8], ['gold_ore', 4], ['orange_terracotta', 6], ['bricks', 4],
      ['smooth_stone', 6], ['glass', 4],
    ],
    mobs: ['zombie', 'skeleton', 'bloop'],
  },
  {
    name: 'Océan', from: 450, mobChance: 0.07, chestChance: 0.02, chestLoot: 'shipwreck',
    blocks: [
      ['sand', 16], ['gravel', 12], ['clay', 10], ['prismarine', 12], ['dark_prismarine', 8],
      ['sea_lantern', 3], ['spruce_planks', 8], ['ice', 6], ['packed_ice', 4], ['lapis_ore', 4],
      ['emerald_ore', 2], ['glass', 6],
    ],
    mobs: ['kraken', 'bloop', 'creeper'],
  },
  {
    name: 'Cavernes', from: 700, mobChance: 0.09, chestChance: 0.022, chestLoot: 'portal',
    blocks: [
      ['stone', 22], ['cobblestone', 14], ['andesite', 8], ['granite', 8], ['diorite', 8],
      ['coal_ore', 8], ['iron_ore', 7], ['gold_ore', 5], ['redstone_ore', 5], ['lapis_ore', 4],
      ['diamond_ore', 2], ['emerald_ore', 2], ['mossy_cobblestone', 5], ['glowstone', 3],
    ],
    mobs: ['zombie', 'skeleton', 'creeper', 'spider', 'bloop'],
  },
  {
    name: 'Abysse', from: 1000, mobChance: 0.11, chestChance: 0.025, chestLoot: 'portal',
    blocks: [
      ['obsidian', 12], ['nether_bricks', 12], ['stone_bricks', 10], ['cracked_stone_bricks', 8],
      ['purpur_block', 8], ['quartz_block', 8], ['glowstone', 6], ['diamond_ore', 4],
      ['emerald_ore', 4], ['gold_block', 2], ['diamond_block', 1], ['sea_lantern', 4],
    ],
    mobs: ['creeper', 'skeleton', 'bloop', 'kraken', 'iron_golem'],
  },
];

export function phaseFor(count: number): OneblockPhase {
  let p = ONEBLOCK_PHASES[0];
  for (const q of ONEBLOCK_PHASES) if (count >= q.from) p = q;
  return p;
}

/** Bloc suivant du « oneblock », tiré dans la table de la phase courante. */
export function pickOneblock(phase: OneblockPhase, r: () => number): string {
  let total = 0;
  for (const [, w] of phase.blocks) total += w;
  let v = r() * total;
  for (const [k, w] of phase.blocks) {
    v -= w;
    if (v <= 0) return k;
  }
  return 'stone';
}

export function itemByKey(key: string): ItemDef | undefined {
  return ITEM_BY_KEY.get(key);
}
