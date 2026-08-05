/** Recettes d'artisanat (grilles 2×2 et 3×3), avec gestion des ingrédients alternatifs. */

import { ITEM_BY_KEY, type ItemDef } from './items';

export interface RecipeResult {
  item: ItemDef;
  count: number;
}

interface ShapedRecipe {
  type: 'shaped';
  pattern: string[];
  key: Record<string, string | string[]>;
  result: string;
  count: number;
}

interface ShapelessRecipe {
  type: 'shapeless';
  ingredients: (string | string[])[];
  result: string;
  count: number;
}

export type Recipe = ShapedRecipe | ShapelessRecipe;

const PLANKS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks'];
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log'];
const WOOL = [
  'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool',
  'pink_wool', 'gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool', 'brown_wool', 'green_wool',
  'red_wool', 'black_wool',
];

const shaped = (pattern: string[], key: Record<string, string | string[]>, result: string, count = 1): ShapedRecipe => ({
  type: 'shaped', pattern, key, result, count,
});
const shapeless = (ingredients: (string | string[])[], result: string, count = 1): ShapelessRecipe => ({
  type: 'shapeless', ingredients, result, count,
});

export const RECIPES: Recipe[] = [];

// --- Bois et base ----------------------------------------------------------
for (let i = 0; i < LOGS.length; i++) RECIPES.push(shapeless([LOGS[i]], PLANKS[i], 4));
RECIPES.push(shaped(['P', 'P'], { P: PLANKS }, 'stick', 4));
RECIPES.push(shaped(['PP', 'PP'], { P: PLANKS }, 'crafting_table'));
RECIPES.push(shaped(['CCC', 'C C', 'CCC'], { C: 'cobblestone' }, 'furnace'));
RECIPES.push(shaped(['PPP', 'P P', 'PPP'], { P: PLANKS }, 'chest'));
RECIPES.push(shaped(['C', 'S'], { C: ['coal', 'charcoal'], S: 'stick' }, 'torch', 4));
RECIPES.push(shaped(['PPP', 'BBB', 'PPP'], { P: PLANKS, B: 'book' }, 'bookshelf'));

// --- Outils ----------------------------------------------------------------
const TOOL_MATS: [string, string | string[]][] = [
  ['wooden', PLANKS],
  ['stone', 'cobblestone'],
  ['iron', 'iron_ingot'],
  ['golden', 'gold_ingot'],
  ['diamond', 'diamond'],
];
for (const [tier, mat] of TOOL_MATS) {
  RECIPES.push(shaped(['MMM', ' S ', ' S '], { M: mat, S: 'stick' }, `${tier}_pickaxe`));
  RECIPES.push(shaped(['MM', 'MS', ' S'], { M: mat, S: 'stick' }, `${tier}_axe`));
  RECIPES.push(shaped(['M', 'S', 'S'], { M: mat, S: 'stick' }, `${tier}_shovel`));
  RECIPES.push(shaped(['M', 'M', 'S'], { M: mat, S: 'stick' }, `${tier}_sword`));
}
RECIPES.push(shaped([' I', 'I '], { I: 'iron_ingot' }, 'shears'));

// --- Armures ---------------------------------------------------------------
const ARMOR_MATS: [string, string][] = [
  ['leather', 'leather'],
  ['iron', 'iron_ingot'],
  ['golden', 'gold_ingot'],
  ['diamond', 'diamond'],
];
for (const [tier, mat] of ARMOR_MATS) {
  RECIPES.push(shaped(['MMM', 'M M'], { M: mat }, `${tier}_helmet`));
  RECIPES.push(shaped(['M M', 'MMM', 'MMM'], { M: mat }, `${tier}_chestplate`));
  RECIPES.push(shaped(['MMM', 'M M', 'M M'], { M: mat }, `${tier}_leggings`));
  RECIPES.push(shaped(['M M', 'M M'], { M: mat }, `${tier}_boots`));
}

// --- Blocs compacts et inverses -------------------------------------------
const COMPACT: [string, string][] = [
  ['coal', 'coal_block'],
  ['iron_ingot', 'iron_block'],
  ['gold_ingot', 'gold_block'],
  ['diamond', 'diamond_block'],
  ['emerald', 'emerald_block'],
  ['lapis', 'lapis_block'],
  ['redstone', 'redstone_block'],
];
for (const [unit, block] of COMPACT) {
  RECIPES.push(shaped(['UUU', 'UUU', 'UUU'], { U: unit }, block));
  RECIPES.push(shapeless([block], unit, 9));
}

// --- Matériaux de construction --------------------------------------------
RECIPES.push(shaped(['SS', 'SS'], { S: 'stone' }, 'stone_bricks', 4));
RECIPES.push(shaped(['SS', 'SS'], { S: 'sand' }, 'sandstone'));
RECIPES.push(shaped(['BB', 'BB'], { B: 'brick' }, 'bricks'));
RECIPES.push(shapeless(['cobblestone', 'tall_grass'], 'mossy_cobblestone'));
RECIPES.push(shaped(['GG', 'GG'], { G: 'gravel' }, 'coarse_dirt', 4));
RECIPES.push(shaped(['SSS', 'SSS', 'SSS'], { S: 'snow_block' }, 'packed_ice'));

// --- Dalles : trois blocs alignés donnent six dalles, et l'inverse ---------
const SLAB_RECIPES: [string, string][] = [
  ['stone', 'stone_slab'],
  ['cobblestone', 'cobblestone_slab'],
  ['stone_bricks', 'stone_brick_slab'],
  ['sandstone', 'sandstone_slab'],
  ['bricks', 'brick_slab'],
  ['quartz_block', 'quartz_slab'],
  ['oak_planks', 'oak_slab'],
  ['birch_planks', 'birch_slab'],
  ['spruce_planks', 'spruce_slab'],
  ['jungle_planks', 'jungle_slab'],
];
for (const [full, slab] of SLAB_RECIPES) {
  RECIPES.push(shaped(['FFF'], { F: full }, slab, 6));
  RECIPES.push(shaped(['S', 'S'], { S: slab }, full));
}

// --- Escaliers : six blocs en gradins donnent quatre marches ---------------
const STAIR_RECIPES: [string, string][] = [
  ['cobblestone', 'cobblestone_stairs'],
  ['stone_bricks', 'stone_brick_stairs'],
  ['sandstone', 'sandstone_stairs'],
  ['bricks', 'brick_stairs'],
  ['oak_planks', 'oak_stairs'],
  ['spruce_planks', 'spruce_stairs'],
];
for (const [full, stairs] of STAIR_RECIPES) {
  RECIPES.push(shaped(['M  ', 'MM ', 'MMM'], { M: full }, stairs, 4));
  RECIPES.push(shaped(['  M', ' MM', 'MMM'], { M: full }, stairs, 4));
}

// --- Palette de construction ----------------------------------------------
RECIPES.push(shaped(['SS', 'SS'], { S: 'smooth_stone' }, 'quartz_block'));
RECIPES.push(shaped(['GG', 'GG'], { G: 'granite' }, 'polished_granite', 4));
RECIPES.push(shaped(['DD', 'DD'], { D: 'diorite' }, 'polished_diorite', 4));
RECIPES.push(shaped(['AA', 'AA'], { A: 'andesite' }, 'polished_andesite', 4));
RECIPES.push(shaped(['SS', 'SS'], { S: 'stone_bricks' }, 'chiseled_stone_bricks'));
RECIPES.push(shaped(['PP', 'PP'], { P: 'prismarine' }, 'dark_prismarine'));

// Béton, terre cuite et verre teinté : un colorant pour huit blocs de base.
const COLOR_SOURCES: [string, string][] = [
  ['poppy', 'red'], ['dandelion', 'yellow'], ['blue_orchid', 'light_blue'],
  ['lapis', 'blue'], ['coal', 'black'], ['emerald', 'green'],
  ['brown_mushroom', 'brown'], ['clay_ball', 'gray'], ['redstone', 'magenta'],
];
for (const [dye, color] of COLOR_SOURCES) {
  RECIPES.push(shaped(['SSS', 'SDS', 'SSS'], { S: 'sand', D: dye }, `${color}_concrete`, 8));
  RECIPES.push(shaped(['TTT', 'TDT', 'TTT'], { T: 'clay', D: dye }, `${color}_terracotta`, 8));
  RECIPES.push(shaped(['GGG', 'GDG', 'GGG'], { G: 'glass', D: dye }, `${color}_stained_glass`, 8));
}
RECIPES.push(shaped(['SSS', 'S S', 'SSS'], { S: 'sand' }, 'white_concrete', 8));
RECIPES.push(shaped(['TTT', 'T T', 'TTT'], { T: 'clay' }, 'white_terracotta', 8));
RECIPES.push(shaped(['GGG', 'G G', 'GGG'], { G: 'glass' }, 'white_stained_glass', 8));

// --- Divers ----------------------------------------------------------------
RECIPES.push(shapeless(['wheat', 'wheat', 'wheat'], 'bread'));
RECIPES.push(shaped(['CCC'], { C: 'sugar_cane' }, 'paper', 3));
RECIPES.push(shapeless(['paper', 'paper', 'paper', 'leather'], 'book'));
RECIPES.push(shaped(['SS', 'SS'], { S: 'string' }, 'white_wool'));
RECIPES.push(shaped(['GSG', 'SGS', 'GSG'], { G: 'gunpowder', S: 'sand' }, 'tnt'));
RECIPES.push(shapeless(['pumpkin', 'torch'], 'jack_o_lantern'));
RECIPES.push(shaped(['MMM', 'MMM', 'MMM'], { M: 'melon_slice' }, 'melon'));
RECIPES.push(shapeless(['melon'], 'melon_slice', 9));
RECIPES.push(shapeless(['wheat_seeds', 'wheat_seeds', 'wheat_seeds'], 'wheat'));

// Teinture de la laine par les fleurs et minéraux disponibles.
const DYES: [string, string][] = [
  ['poppy', 'red_wool'],
  ['dandelion', 'yellow_wool'],
  ['blue_orchid', 'light_blue_wool'],
  ['lapis', 'blue_wool'],
  ['coal', 'black_wool'],
  ['emerald', 'green_wool'],
  ['brown_mushroom', 'brown_wool'],
  ['clay_ball', 'gray_wool'],
  ['redstone', 'magenta_wool'],
];
for (const [dye, out] of DYES) RECIPES.push(shapeless([dye, WOOL], out));

// --- Menuiserie ------------------------------------------------------------
RECIPES.push(shaped(['PP', 'PP', 'PP'], { P: PLANKS }, 'oak_door', 3));
RECIPES.push(shaped(['SPS', 'SPS'], { S: 'stick', P: PLANKS }, 'oak_fence_gate'));
// Trois laines et trois planches : la couleur de la laine n'entre pas en compte,
// le lit est rouge quoi qu'il arrive.
RECIPES.push(shaped(['WWW', 'PPP'], { W: WOOL, P: PLANKS }, 'red_bed'));

// Sept bâtons en échelle donnent trois échelons.
RECIPES.push(shaped(['S S', 'SSS', 'S S'], { S: 'stick' }, 'ladder', 3));

// --- Seaux -----------------------------------------------------------------
RECIPES.push(shaped(['I I', ' I '], { I: 'iron_ingot' }, 'bucket'));

// --- Nether, End et netherite ----------------------------------------------
// Le briquet allume un cadre d'obsidienne : c'est la clé du Nether.
RECIPES.push(shaped(['I ', ' F'], { I: 'iron_ingot', F: 'flint' }, 'flint_and_steel'));
RECIPES.push(shapeless(['gravel', 'gravel', 'gravel', 'gravel'], 'flint'));

// Quatre éclats fondus + quatre lingots d'or donnent un lingot de netherite.
RECIPES.push(shaped(['SSG', 'SSG', 'GG '], { S: 'netherite_scrap', G: 'gold_ingot' }, 'netherite_ingot'));
RECIPES.push(shaped(['NNN', 'NNN', 'NNN'], { N: 'netherite_ingot' }, 'netherite_block'));
RECIPES.push(shapeless(['netherite_block'], 'netherite_ingot', 9));

// L'équipement en netherite s'obtient en améliorant celui en diamant.
for (const k of ['pickaxe', 'axe', 'shovel', 'sword']) {
  RECIPES.push(shapeless([`diamond_${k}`, 'netherite_ingot'], `netherite_${k}`));
}
for (const p of ['helmet', 'chestplate', 'leggings', 'boots']) {
  RECIPES.push(shapeless([`diamond_${p}`, 'netherite_ingot'], `netherite_${p}`));
}

RECIPES.push(shaped(['NN', 'NN'], { N: 'netherrack' }, 'nether_bricks'));
RECIPES.push(shapeless(['blaze_rod'], 'blaze_powder', 2));
// L'œil de l'Ender : ce qu'il faut pour rallumer un portail de l'End.
RECIPES.push(shapeless(['ender_pearl', 'blaze_powder'], 'eye_of_ender'));

// --- Recherche -------------------------------------------------------------

function matches(slot: string | null, spec: string | string[] | undefined): boolean {
  if (spec === undefined) return slot === null;
  if (slot === null) return false;
  return Array.isArray(spec) ? spec.includes(slot) : spec === slot;
}

function matchShaped(r: ShapedRecipe, grid: (string | null)[], size: number): boolean {
  const rh = r.pattern.length;
  const rw = Math.max(...r.pattern.map((p) => p.length));
  if (rh > size || rw > size) return false;
  for (let oy = 0; oy + rh <= size; oy++) {
    for (let ox = 0; ox + rw <= size; ox++) {
      let ok = true;
      for (let y = 0; y < size && ok; y++) {
        for (let x = 0; x < size; x++) {
          const slot = grid[y * size + x];
          const inside = x >= ox && x < ox + rw && y >= oy && y < oy + rh;
          const ch = inside ? (r.pattern[y - oy][x - ox] ?? ' ') : ' ';
          const spec = ch === ' ' ? undefined : r.key[ch];
          if (!matches(slot, spec)) { ok = false; break; }
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

function matchShapeless(r: ShapelessRecipe, grid: (string | null)[]): boolean {
  const present = grid.filter((s): s is string => s !== null);
  if (present.length !== r.ingredients.length) return false;
  const pool = present.slice();
  for (const ing of r.ingredients) {
    const idx = pool.findIndex((p) => matches(p, ing));
    if (idx < 0) return false;
    pool.splice(idx, 1);
  }
  return true;
}

/** Trouve la recette correspondant à une grille de `size`×`size` clés d'objets. */
export function findRecipe(grid: (string | null)[], size: number): RecipeResult | null {
  for (const r of RECIPES) {
    const ok = r.type === 'shaped' ? matchShaped(r, grid, size) : matchShapeless(r, grid);
    if (!ok) continue;
    const def = ITEM_BY_KEY.get(r.result);
    if (!def) continue;
    return { item: def, count: r.count };
  }
  return null;
}

/** Liste des recettes réalisables (pour le livre de recettes de l'interface). */
export function allRecipes(): Recipe[] {
  return RECIPES;
}
