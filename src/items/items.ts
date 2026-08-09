/**
 * Registre des objets : items de blocs, outils, ressources, nourriture, armures.
 * Chaque bloc pose automatiquement un item homonyme, complété ici par les
 * objets qui n'existent pas sous forme de bloc.
 */

import { BLOCKS, BLOCK_BY_KEY, FACINGS, STAIR_FACINGS, STAIR_MATERIALS, RenderKind, type ToolKind } from '../world/blocks';

export interface ToolStats {
  kind: ToolKind;
  /** 1 = bois, 2 = pierre, 3 = fer/or, 4 = diamant. */
  tier: number;
  /** Multiplicateur de vitesse de minage. */
  speed: number;
  /** Dégâts en combat. */
  damage: number;
}

export interface ItemDef {
  id: number;
  key: string;
  name: string;
  maxStack: number;
  /** Identifiant de bloc posé au clic droit. */
  block: number;
  tool?: ToolStats;
  durability?: number;
  food?: { hunger: number; saturation: number };
  /** Durée de combustion dans un four, en secondes. */
  fuel?: number;
  armor?: { slot: number; defense: number };
  /** Couleur dominante utilisée par le générateur d'icônes. */
  color: number;
  icon: 'block' | 'tool' | 'gem' | 'ingot' | 'nugget' | 'stick' | 'food' | 'dust' | 'seed' | 'armor' | 'plain';
}

export const ITEMS: ItemDef[] = [];
export const ITEM_BY_KEY = new Map<string, ItemDef>();
/** Item correspondant à un identifiant de bloc. */
export const ITEM_OF_BLOCK = new Map<number, ItemDef>();

interface ItemOptions {
  name: string;
  maxStack?: number;
  block?: number;
  tool?: ToolStats;
  durability?: number;
  food?: { hunger: number; saturation: number };
  fuel?: number;
  armor?: { slot: number; defense: number };
  color?: number;
  icon?: ItemDef['icon'];
}

function item(key: string, o: ItemOptions): ItemDef {
  const def: ItemDef = {
    id: ITEMS.length,
    key,
    name: o.name,
    maxStack: o.maxStack ?? 64,
    block: o.block ?? 0,
    tool: o.tool,
    durability: o.durability,
    food: o.food,
    fuel: o.fuel,
    armor: o.armor,
    color: o.color ?? 0xffffff,
    icon: o.icon ?? 'plain',
  };
  ITEMS.push(def);
  ITEM_BY_KEY.set(key, def);
  if (def.block) ITEM_OF_BLOCK.set(def.block, def);
  return def;
}

// Slot 0 : « rien ».
item('air', { name: '', maxStack: 0, icon: 'plain' });

// --- Items de blocs --------------------------------------------------------
const BLOCK_FUEL: Record<string, number> = {
  oak_planks: 15, birch_planks: 15, spruce_planks: 15, jungle_planks: 15,
  oak_log: 15, birch_log: 15, spruce_log: 15, jungle_log: 15,
  crafting_table: 15, bookshelf: 15, chest: 15, coal_block: 800,
};

for (const b of BLOCKS) {
  if (b.id === 0) continue;
  if (b.hardness < 0 && b.key !== 'bedrock') continue; // eau, lave : pas d'item
  if (b.key === 'bedrock') continue;
  // `_slab_top` n'est qu'une variante de pose : un seul objet par matériau.
  if (b.key.endsWith('_slab_top')) continue;
  // L'œuf de dragon et les escaliers sont enregistrés tout en bas du fichier :
  // les identifiants d'objets sont écrits dans les sauvegardes, on n'insère
  // jamais au milieu.
  if (b.key === 'dragon_egg') continue;
  if (b.key.includes('_stairs_')) continue;
  if (b.key.startsWith('oak_door_') || b.key.startsWith('oak_fence_gate_') || b.key.startsWith('red_bed_')) continue;
  if (b.key.startsWith('ladder_')) continue;
  if (b.key.startsWith('oak_trapdoor_')) continue;
  if (b.key === 'carrots') continue; // l'objet est la carotte, pas le plant
  item(b.key, {
    name: b.name,
    block: b.id,
    icon: 'block',
    color: b.tint || 0xffffff,
    fuel: BLOCK_FUEL[b.key],
  });
}

// --- Ressources ------------------------------------------------------------
item('stick', { name: 'Bâton', color: 0x8a6a3a, icon: 'stick', fuel: 5 });
item('coal', { name: 'Charbon', color: 0x232323, icon: 'gem', fuel: 80 });
item('charcoal', { name: 'Charbon de bois', color: 0x3a3128, icon: 'gem', fuel: 80 });
item('raw_iron', { name: 'Fer brut', color: 0xd8a181, icon: 'nugget' });
item('raw_gold', { name: 'Or brut', color: 0xf2c94c, icon: 'nugget' });
item('iron_ingot', { name: 'Lingot de fer', color: 0xd8d8d8, icon: 'ingot' });
item('gold_ingot', { name: 'Lingot d’or', color: 0xf7d84c, icon: 'ingot' });
item('diamond', { name: 'Diamant', color: 0x5ce8e0, icon: 'gem' });
item('emerald', { name: 'Émeraude', color: 0x3ddb6a, icon: 'gem' });
item('lapis', { name: 'Lapis-lazuli', color: 0x2452c4, icon: 'gem' });
item('redstone', { name: 'Poudre de redstone', color: 0xd42a2a, icon: 'dust' });
item('clay_ball', { name: 'Boule d’argile', color: 0xa0a5b3, icon: 'nugget' });
item('brick', { name: 'Brique', color: 0x9a5b48, icon: 'plain' });
item('flint', { name: 'Silex', color: 0x4a4a4a, icon: 'nugget' });
item('leather', { name: 'Cuir', color: 0x9a6b3f, icon: 'plain' });
item('feather', { name: 'Plume', color: 0xf0f0f0, icon: 'plain' });
item('string', { name: 'Ficelle', color: 0xdddddd, icon: 'plain' });
item('bone', { name: 'Os', color: 0xe8e4d0, icon: 'stick' });
item('gunpowder', { name: 'Poudre à canon', color: 0x5a5a5a, icon: 'dust' });
item('rotten_flesh', { name: 'Chair putréfiée', color: 0x8a6a4a, icon: 'food', food: { hunger: 2, saturation: 0.5 } });
item('wheat_seeds', { name: 'Graines de blé', color: 0x8ab34a, icon: 'seed' });
item('wheat', { name: 'Blé', color: 0xd8c25a, icon: 'plain' });
item('paper', { name: 'Papier', color: 0xf2f2f2, icon: 'plain' });
item('book', { name: 'Livre', color: 0xa33b2c, icon: 'plain' });

// --- Nourriture ------------------------------------------------------------
item('apple', { name: 'Pomme', color: 0xd83a2c, icon: 'food', food: { hunger: 4, saturation: 2.4 } });
item('bread', { name: 'Pain', color: 0xc79a4e, icon: 'food', food: { hunger: 5, saturation: 6 } });
item('melon_slice', { name: 'Tranche de pastèque', color: 0xd8484a, icon: 'food', food: { hunger: 2, saturation: 1.2 } });
item('porkchop', { name: 'Porc cru', color: 0xe08a8a, icon: 'food', food: { hunger: 3, saturation: 1.8 } });
item('cooked_porkchop', { name: 'Porc cuit', color: 0xc06a3a, icon: 'food', food: { hunger: 8, saturation: 12.8 } });
item('beef', { name: 'Bœuf cru', color: 0xc85c5c, icon: 'food', food: { hunger: 3, saturation: 1.8 } });
item('cooked_beef', { name: 'Steak', color: 0x8a4a2a, icon: 'food', food: { hunger: 8, saturation: 12.8 } });
item('chicken', { name: 'Poulet cru', color: 0xe8bda0, icon: 'food', food: { hunger: 2, saturation: 1.2 } });
item('cooked_chicken', { name: 'Poulet cuit', color: 0xc98a4a, icon: 'food', food: { hunger: 6, saturation: 7.2 } });
item('mutton', { name: 'Mouton cru', color: 0xd07070, icon: 'food', food: { hunger: 2, saturation: 1.2 } });
item('cooked_mutton', { name: 'Mouton cuit', color: 0xa05a30, icon: 'food', food: { hunger: 6, saturation: 9.6 } });

// --- Outils ----------------------------------------------------------------
const TIERS: { key: string; name: string; tier: number; speed: number; dmg: number; dura: number; color: number }[] = [
  { key: 'wooden', name: 'en bois', tier: 1, speed: 2, dmg: 1, dura: 60, color: 0xb08a55 },
  { key: 'stone', name: 'en pierre', tier: 2, speed: 4, dmg: 2, dura: 132, color: 0x7d7d7d },
  { key: 'iron', name: 'en fer', tier: 3, speed: 6, dmg: 3, dura: 251, color: 0xd8d8d8 },
  { key: 'golden', name: 'en or', tier: 3, speed: 12, dmg: 1, dura: 33, color: 0xf7d84c },
  { key: 'diamond', name: 'en diamant', tier: 4, speed: 8, dmg: 4, dura: 1562, color: 0x5ce8e0 },
];

const TOOL_KINDS: { key: ToolKind; name: string; dmgBonus: number }[] = [
  { key: 'pickaxe', name: 'Pioche', dmgBonus: 1 },
  { key: 'axe', name: 'Hache', dmgBonus: 3 },
  { key: 'shovel', name: 'Pelle', dmgBonus: 0.5 },
  { key: 'sword', name: 'Épée', dmgBonus: 3 },
];

for (const t of TIERS) {
  for (const k of TOOL_KINDS) {
    item(`${t.key}_${k.key}`, {
      name: `${k.name} ${t.name}`,
      maxStack: 1,
      color: t.color,
      icon: 'tool',
      durability: k.key === 'sword' ? Math.round(t.dura * 0.9) : t.dura,
      tool: {
        kind: k.key,
        tier: t.tier,
        speed: k.key === 'sword' ? 1.5 : t.speed,
        damage: 1 + t.dmg + k.dmgBonus,
      },
    });
  }
}

item('shears', {
  name: 'Cisailles',
  maxStack: 1,
  color: 0xc8c8c8,
  icon: 'tool',
  durability: 238,
  tool: { kind: 'shears', tier: 1, speed: 6, damage: 1 },
});

// --- Armures ---------------------------------------------------------------
const ARMOR_SETS: { key: string; name: string; color: number; def: number[]; dura: number }[] = [
  { key: 'leather', name: 'en cuir', color: 0x9a6b3f, def: [1, 3, 2, 1], dura: 80 },
  { key: 'iron', name: 'en fer', color: 0xd8d8d8, def: [2, 6, 5, 2], dura: 240 },
  { key: 'golden', name: 'en or', color: 0xf7d84c, def: [2, 5, 3, 1], dura: 112 },
  { key: 'diamond', name: 'en diamant', color: 0x5ce8e0, def: [3, 8, 6, 3], dura: 528 },
];
const ARMOR_PIECES = [
  { key: 'helmet', name: 'Casque', slot: 0 },
  { key: 'chestplate', name: 'Plastron', slot: 1 },
  { key: 'leggings', name: 'Jambières', slot: 2 },
  { key: 'boots', name: 'Bottes', slot: 3 },
];
for (const s of ARMOR_SETS) {
  for (const p of ARMOR_PIECES) {
    item(`${s.key}_${p.key}`, {
      name: `${p.name} ${s.name}`,
      maxStack: 1,
      color: s.color,
      icon: 'armor',
      durability: s.dura,
      armor: { slot: p.slot, defense: s.def[p.slot] },
    });
  }
}

export const ITEM_COUNT = ITEMS.length;

export function itemOf(key: string): ItemDef {
  const i = ITEM_BY_KEY.get(key);
  if (!i) throw new Error(`Objet inconnu : ${key}`);
  return i;
}

// --- Nether, End et netherite ----------------------------------------------
item('flint_and_steel', {
  name: 'Briquet', maxStack: 1, color: 0xc0c0c0, icon: 'tool', durability: 64,
});
item('netherite_scrap', { name: 'Éclat de netherite', color: 0x8a6f5e, icon: 'nugget' });
item('netherite_ingot', { name: 'Lingot de netherite', color: 0x5a4a4e, icon: 'ingot' });
item('blaze_rod', { name: 'Bâton de braise', color: 0xf2b02a, icon: 'stick', fuel: 240 });
item('blaze_powder', { name: 'Poudre de braise', color: 0xe89a1a, icon: 'dust' });
item('ender_pearl', { name: 'Perle de l’Ender', color: 0x2fa892, icon: 'gem' });
item('eye_of_ender', { name: 'Œil de l’Ender', color: 0x63d8a8, icon: 'gem' });
item('ghast_tear', { name: 'Larme de spectre', color: 0xdff3f0, icon: 'gem' });

// La netherite prolonge la progression fer → or → diamant d'un cran.
for (const k of TOOL_KINDS) {
  item(`netherite_${k.key}`, {
    name: `${k.name} en netherite`,
    maxStack: 1,
    color: 0x5a4a4e,
    icon: 'tool',
    durability: k.key === 'sword' ? 1900 : 2031,
    tool: { kind: k.key, tier: 5, speed: k.key === 'sword' ? 1.8 : 9.5, damage: 1 + 5 + k.dmgBonus },
  });
}
for (const p of ARMOR_PIECES) {
  item(`netherite_${p.key}`, {
    name: `${p.name} en netherite`,
    maxStack: 1,
    color: 0x5a4a4e,
    icon: 'armor',
    durability: 666,
    armor: { slot: p.slot, defense: [3, 8, 6, 3][p.slot] + 1 },
  });
}

// Ajouté ici, en queue de registre, pour ne décaler aucun identifiant existant.
item('dragon_egg', {
  name: 'Œuf de dragon', maxStack: 1, block: BLOCK_BY_KEY.get('dragon_egg')!.id,
  icon: 'block', color: 0x6a3a9a,
});

// Un seul objet par matériau d'escalier : l'orientation est choisie à la pose.
// Les quatre variantes pointent vers ce même objet, pour que « prendre le bloc
// visé » et le butin retombent dessus quelle que soit la marche cassée.
for (const [key, name] of STAIR_MATERIALS) {
  const north = BLOCK_BY_KEY.get(`${key}_stairs_north`)!;
  const def = item(`${key}_stairs`, {
    name: `Escalier ${name}`,
    block: north.id,
    icon: 'block',
  });
  for (const facing of STAIR_FACINGS) {
    ITEM_OF_BLOCK.set(BLOCK_BY_KEY.get(`${key}_stairs_${facing}`)!.id, def);
  }
}

// Même principe pour la menuiserie : un objet, plusieurs blocs. La porte et le
// lit occupent deux blocs, mais ne se ramassent qu'une fois.
{
  const door = item('oak_door', {
    name: 'Porte de chêne', block: BLOCK_BY_KEY.get('oak_door_north_lower_closed')!.id,
    icon: 'block', fuel: 10,
  });
  const gate = item('oak_fence_gate', {
    name: 'Portillon de chêne', block: BLOCK_BY_KEY.get('oak_fence_gate_north_closed')!.id,
    icon: 'block', fuel: 15,
  });
  const bed = item('red_bed', {
    name: 'Lit rouge', maxStack: 1, block: BLOCK_BY_KEY.get('red_bed_north_foot')!.id,
    icon: 'block', color: 0xa62b2b,
  });
  for (const facing of FACINGS) {
    for (const half of ['lower', 'upper'] as const) {
      for (const state of ['closed', 'open'] as const) {
        ITEM_OF_BLOCK.set(BLOCK_BY_KEY.get(`oak_door_${facing}_${half}_${state}`)!.id, door);
      }
    }
    for (const state of ['closed', 'open'] as const) {
      ITEM_OF_BLOCK.set(BLOCK_BY_KEY.get(`oak_fence_gate_${facing}_${state}`)!.id, gate);
    }
    for (const half of ['foot', 'head'] as const) {
      ITEM_OF_BLOCK.set(BLOCK_BY_KEY.get(`red_bed_${facing}_${half}`)!.id, bed);
    }
  }

  const ladder = item('ladder', {
    name: 'Échelle', block: BLOCK_BY_KEY.get('ladder_north')!.id, icon: 'block', fuel: 8,
  });
  for (const facing of FACINGS) {
    ITEM_OF_BLOCK.set(BLOCK_BY_KEY.get(`ladder_${facing}`)!.id, ladder);
  }

  const trapdoor = item('oak_trapdoor', {
    name: 'Trappe de chêne', block: BLOCK_BY_KEY.get('oak_trapdoor_closed')!.id, icon: 'block', fuel: 10,
  });
  for (const facing of FACINGS) {
    ITEM_OF_BLOCK.set(BLOCK_BY_KEY.get(`oak_trapdoor_open_${facing}`)!.id, trapdoor);
  }
}

// Carottes : le plant n'a pas d'objet, c'est la racine qu'on ramasse et
// qu'on replante.
item('carrot', {
  name: 'Carotte', block: BLOCK_BY_KEY.get('carrots')!.id, icon: 'food', color: 0xe07818,
  food: { hunger: 3, saturation: 3.6 },
});
// Les deux dorures : la pomme régénère longuement, la carotte soigne d'un coup.
item('golden_apple', { name: 'Pomme dorée', maxStack: 16, color: 0xf7d84c, icon: 'food', food: { hunger: 4, saturation: 9.6 } });
item('golden_carrot', { name: 'Carotte dorée', maxStack: 16, color: 0xf0c020, icon: 'food', food: { hunger: 6, saturation: 14.4 } });

// L'avion n'est pas un bloc : l'objet fait apparaître l'engin devant soi.
item('plane', { name: 'Avion', maxStack: 1, color: 0xd23c30, icon: 'tool' });
// La laisse : on attache une bête, elle suit, puis on la noue à une barrière.
item('lead', { name: 'Laisse', maxStack: 16, color: 0xb8a082, icon: 'plain' });

// Seaux : la seule façon de transporter un fluide, et donc de figer la lave en
// obsidienne pour bâtir un portail sans dépendre d'un coffre de structure.
item('bucket', { name: 'Seau', maxStack: 1, color: 0xb0b6bd, icon: 'nugget' });
item('water_bucket', { name: 'Seau d’eau', maxStack: 1, color: 0x3a6fd8, icon: 'nugget' });
item('lava_bucket', { name: 'Seau de lave', maxStack: 1, color: 0xe06a1a, icon: 'nugget', fuel: 1000 });

export function itemById(id: number): ItemDef {
  return ITEMS[id] ?? ITEMS[0];
}

/** Niveau d'outil minimal requis pour récupérer le bloc. */
const MINE_LEVEL: Record<string, number> = {
  iron_ore: 2, lapis_ore: 2, lapis_block: 2, iron_block: 2,
  gold_ore: 3, diamond_ore: 3, emerald_ore: 3, redstone_ore: 3,
  gold_block: 3, diamond_block: 3, emerald_block: 3, redstone_block: 3,
  obsidian: 4,
  ancient_debris: 4, netherite_block: 4, glowing_obsidian: 4,
  nether_quartz_ore: 2, end_stone: 1, magma_block: 1,
};

export function requiredMineLevel(blockKey: string): number {
  return MINE_LEVEL[blockKey] ?? 1;
}

export interface BreakInfo {
  /** Durée en secondes. */
  time: number;
  /** Le bloc lâche-t-il son butin ? */
  harvest: boolean;
}

export function breakInfo(blockId: number, held: ItemDef | null): BreakInfo {
  const b = BLOCKS[blockId];
  if (!b || b.hardness < 0) return { time: Infinity, harvest: false };
  if (b.hardness === 0) return { time: 0, harvest: true };

  const tool = held?.tool;
  const matches = !!tool && tool.kind === b.tool && b.tool !== 'none';
  const level = requiredMineLevel(b.key);
  const harvest = !b.needsTool || (matches && tool.tier >= level);
  let speed = matches ? tool.speed : 1;
  // Les cisailles coupent le feuillage instantanément.
  if (tool?.kind === 'shears' && (b.tool === 'shears' || b.render === RenderKind.Cross)) speed = 15;
  const time = (b.hardness * (harvest ? 1.5 : 5)) / speed;
  return { time: Math.max(0.05, time), harvest };
}

/** Butin d'un bloc cassé. */
export function blockDrops(blockId: number, harvest: boolean, rnd: () => number): { item: ItemDef; count: number }[] {
  const b = BLOCKS[blockId];
  if (!b || !harvest) return [];
  const dropKey = b.drop ?? b.key;
  if (dropKey === 'air') return [];
  const def = ITEM_BY_KEY.get(dropKey);
  if (!def) return [];
  let count = 1;
  if (b.dropCount) {
    const [lo, hi] = b.dropCount;
    count = lo + Math.floor(rnd() * (hi - lo + 1));
  }
  if (count <= 0) return [];
  return [{ item: def, count }];
}

/** Recettes de cuisson : clé d'entrée → clé de sortie. */
export const SMELTING: Record<string, string> = {
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  sand: 'glass',
  red_sand: 'glass',
  cobblestone: 'stone',
  clay_ball: 'brick',
  clay: 'bricks',
  porkchop: 'cooked_porkchop',
  beef: 'cooked_beef',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  oak_log: 'charcoal',
  birch_log: 'charcoal',
  spruce_log: 'charcoal',
  jungle_log: 'charcoal',
  stone: 'stone_bricks',
  ancient_debris: 'netherite_scrap',
};

export function blockItemFor(blockKey: string): ItemDef | undefined {
  const b = BLOCK_BY_KEY.get(blockKey);
  return b ? ITEM_OF_BLOCK.get(b.id) : undefined;
}


// ---------------------------------------------------------------------------
// Catégories : structurent le sélecteur d'objets du mode créatif.
// ---------------------------------------------------------------------------

export type ItemCategory = 'construction' | 'couleurs' | 'nature' | 'redstone' | 'outils' | 'ressources' | 'nourriture';

export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  construction: 'Construction',
  couleurs: 'Couleurs',
  nature: 'Nature',
  redstone: 'Mécanismes',
  outils: 'Équipement',
  ressources: 'Ressources',
  nourriture: 'Nourriture',
};

const NATURE_KEYS = new Set([
  'grass_block', 'dirt', 'coarse_dirt', 'sand', 'red_sand', 'gravel', 'clay', 'snow_block',
  'ice', 'packed_ice', 'cactus', 'pumpkin', 'melon', 'jack_o_lantern',
  'netherrack', 'soul_sand', 'magma_block', 'end_stone',
]);

export function itemCategory(def: ItemDef): ItemCategory {
  // L'avion se range avec l'équipement : c'est un engin, pas un matériau.
  if (def.key === 'plane') return 'outils';
  if (def.tool || def.armor) return 'outils';
  if (def.food) return 'nourriture';
  if (!def.block) return 'ressources';

  const key = def.key;
  if (key.endsWith('_wool') || key.endsWith('_concrete') || key.endsWith('_terracotta') || key.endsWith('_stained_glass')) {
    return 'couleurs';
  }
  if (key === 'tnt' || key === 'crafting_table' || key === 'furnace' || key === 'chest' || key === 'bookshelf') {
    return 'redstone';
  }
  // Menuiserie : ce sont des mécanismes, on les ouvre et on les ferme.
  if (key === 'oak_door' || key === 'oak_fence_gate' || key === 'red_bed') return 'redstone';
  if (key === 'ladder' || key === 'oak_fence' || key === 'oak_trapdoor') return 'construction';
  if (key === 'lucky_block') return 'redstone';
  if (NATURE_KEYS.has(key)) return 'nature';
  const b = BLOCKS[def.block];
  if (b && (b.render === RenderKind.Cross || key.endsWith('_leaves') || key.endsWith('_log') || key.endsWith('_sapling'))) {
    return 'nature';
  }
  if (key.endsWith('_ore') || key === 'ancient_debris') return 'ressources';
  // Portails et cadres relèvent du mécanisme, pas de la décoration.
  if (key.startsWith('end_portal') || key === 'nether_portal') return 'redstone';
  return 'construction';
}
