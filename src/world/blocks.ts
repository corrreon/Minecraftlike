/**
 * Registre des blocs.
 *
 * Ce module est importé aussi bien par le thread principal que par les workers :
 * il ne doit donc dépendre ni de THREE ni du DOM. Les index de textures sont
 * dérivés de l'ordre d'enregistrement, ce qui garantit que les deux côtés
 * calculent exactement les mêmes valeurs sans avoir à se les échanger.
 */

export const enum RenderKind {
  /** Rien à dessiner (air). */
  None = 0,
  /** Cube plein classique, éligible au greedy meshing. */
  Cube = 1,
  /** Deux quads croisés (fleurs, hautes herbes, torches…). */
  Cross = 2,
  /** Fluide : surface légèrement abaissée et animée. */
  Liquid = 3,
}

export const enum RenderLayer {
  Opaque = 0,
  /** Alpha testé : feuillages, verre gravé, croix. */
  Cutout = 1,
  /** Alpha blend trié : eau, glace. */
  Translucent = 2,
}

export type ToolKind = 'none' | 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'shears';

export interface FaceTextures {
  top: string;
  bottom: string;
  side: string;
}

export interface BlockDef {
  id: number;
  key: string;
  name: string;
  render: RenderKind;
  layer: RenderLayer;
  /** Bloque le passage du joueur. */
  solid: boolean;
  /** Masque totalement les faces voisines et la lumière. */
  opaque: boolean;
  /** Atténuation de la lumière traversante (0 = transparent parfait). */
  lightFilter: number;
  /** Lumière émise, 0..15. */
  emission: number;
  /** Dureté en « secondes à mains nues », -1 = incassable. */
  hardness: number;
  tool: ToolKind;
  /** Si vrai, aucun butin sans l'outil adapté. */
  needsTool: boolean;
  /** Clé d'objet lâché (par défaut : le bloc lui-même). */
  drop?: string;
  dropCount?: [number, number];
  /** Le bloc tombe s'il n'est pas supporté. */
  gravity: boolean;
  /** Le bloc peut être remplacé en posant dessus (herbe haute, eau…). */
  replaceable: boolean;
  /** Le joueur peut nager / traverser (fluides). */
  fluid: boolean;
  /** Dégâts par seconde au contact. */
  contactDamage: number;
  /** Groupe sonore utilisé par le moteur audio procédural. */
  sound: 'stone' | 'wood' | 'grass' | 'sand' | 'gravel' | 'glass' | 'wool' | 'liquid' | 'metal';
  /** Teinte appliquée à la texture (feuillage, herbe) au format 0xRRGGBB, ou 0 pour aucune. */
  tint: number;
  /** Faces texturées. */
  textures: FaceTextures;
  /** Index de couche dans le tableau de textures, résolu à l'initialisation. */
  layers: { top: number; bottom: number; side: number };
  /** Le bloc peut brûler / être détruit par la lave. */
  flammable: boolean;
  /** Emprise verticale du bloc, en fraction de voxel. Une dalle vaut 0→0,5. */
  minY: number;
  maxY: number;
  /**
   * Découpage du bloc en boîtes, en fraction de voxel, quand une seule ne
   * suffit pas : un escalier en demande deux. Vide pour un cube ou une dalle,
   * que `minY`/`maxY` décrivent déjà.
   */
  boxes?: Box[];
  /**
   * Quarts de tour appliqués à la texture de la face du dessus. Sert aux blocs
   * dont le motif a un sens — l'oreiller d'un lit pointe vers la tête.
   */
  rotTop: number;
  /** On y grimpe : le contact remplace la chute par une montée contrôlée. */
  climbable: boolean;
}

/** Boîte élémentaire d'une forme, en fraction de voxel. */
export type Box = readonly [number, number, number, number, number, number];

const TEXTURE_ORDER: string[] = [];
const TEXTURE_INDEX = new Map<string, number>();

function tex(name: string): number {
  let i = TEXTURE_INDEX.get(name);
  if (i === undefined) {
    i = TEXTURE_ORDER.length;
    TEXTURE_ORDER.push(name);
    TEXTURE_INDEX.set(name, i);
  }
  return i;
}

export const BLOCKS: BlockDef[] = [];
export const BLOCK_BY_KEY = new Map<string, BlockDef>();

interface BlockOptions {
  name: string;
  textures: string | Partial<FaceTextures>;
  render?: RenderKind;
  layer?: RenderLayer;
  solid?: boolean;
  opaque?: boolean;
  lightFilter?: number;
  emission?: number;
  hardness?: number;
  tool?: ToolKind;
  needsTool?: boolean;
  drop?: string;
  dropCount?: [number, number];
  gravity?: boolean;
  replaceable?: boolean;
  fluid?: boolean;
  contactDamage?: number;
  sound?: BlockDef['sound'];
  tint?: number;
  flammable?: boolean;
  minY?: number;
  maxY?: number;
  boxes?: Box[];
  rotTop?: number;
  climbable?: boolean;
}

function define(key: string, o: BlockOptions): BlockDef {
  const t: FaceTextures =
    typeof o.textures === 'string'
      ? { top: o.textures, bottom: o.textures, side: o.textures }
      : {
          top: o.textures.top ?? o.textures.side ?? 'missing',
          bottom: o.textures.bottom ?? o.textures.top ?? o.textures.side ?? 'missing',
          side: o.textures.side ?? o.textures.top ?? 'missing',
        };

  const render = o.render ?? RenderKind.Cube;
  const opaque = o.opaque ?? (render === RenderKind.Cube && (o.layer ?? RenderLayer.Opaque) === RenderLayer.Opaque);

  const def: BlockDef = {
    id: BLOCKS.length,
    key,
    name: o.name,
    render,
    layer: o.layer ?? RenderLayer.Opaque,
    solid: o.solid ?? render === RenderKind.Cube,
    opaque,
    lightFilter: o.lightFilter ?? (opaque ? 15 : 0),
    emission: o.emission ?? 0,
    hardness: o.hardness ?? 1,
    tool: o.tool ?? 'none',
    needsTool: o.needsTool ?? false,
    drop: o.drop,
    dropCount: o.dropCount,
    gravity: o.gravity ?? false,
    replaceable: o.replaceable ?? false,
    fluid: o.fluid ?? false,
    contactDamage: o.contactDamage ?? 0,
    sound: o.sound ?? 'stone',
    tint: o.tint ?? 0,
    flammable: o.flammable ?? false,
    minY: o.minY ?? 0,
    maxY: o.maxY ?? 1,
    boxes: o.boxes,
    rotTop: o.rotTop ?? 0,
    climbable: o.climbable ?? false,
    textures: t,
    layers: { top: tex(t.top), bottom: tex(t.bottom), side: tex(t.side) },
  };
  BLOCKS.push(def);
  BLOCK_BY_KEY.set(key, def);
  return def;
}

const FOLIAGE_TINT = 0x528e2e;
const GRASS_TINT = 0x51803c;

// ---------------------------------------------------------------------------
// L'ordre de déclaration fixe les identifiants numériques : ne jamais insérer
// au milieu sous peine de casser les sauvegardes existantes.
// ---------------------------------------------------------------------------

define('air', {
  name: 'Air',
  textures: 'air',
  render: RenderKind.None,
  solid: false,
  opaque: false,
  lightFilter: 0,
  hardness: 0,
  replaceable: true,
});

define('stone', { name: 'Pierre', textures: 'stone', hardness: 1.5, tool: 'pickaxe', needsTool: true, drop: 'cobblestone' });
define('grass_block', {
  name: 'Bloc d’herbe',
  textures: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' },
  hardness: 0.6,
  tool: 'shovel',
  drop: 'dirt',
  sound: 'grass',
  tint: GRASS_TINT,
});
define('dirt', { name: 'Terre', textures: 'dirt', hardness: 0.5, tool: 'shovel', sound: 'gravel' });
define('coarse_dirt', { name: 'Terre stérile', textures: 'coarse_dirt', hardness: 0.5, tool: 'shovel', sound: 'gravel' });
define('cobblestone', { name: 'Pierre taillée', textures: 'cobblestone', hardness: 2, tool: 'pickaxe', needsTool: true });
define('bedrock', { name: 'Bedrock', textures: 'bedrock', hardness: -1 });
define('sand', { name: 'Sable', textures: 'sand', hardness: 0.5, tool: 'shovel', gravity: true, sound: 'sand' });
define('red_sand', { name: 'Sable rouge', textures: 'red_sand', hardness: 0.5, tool: 'shovel', gravity: true, sound: 'sand' });
define('gravel', { name: 'Gravier', textures: 'gravel', hardness: 0.6, tool: 'shovel', gravity: true, sound: 'gravel' });
define('clay', { name: 'Argile', textures: 'clay', hardness: 0.6, tool: 'shovel', drop: 'clay_ball', dropCount: [4, 4], sound: 'gravel' });

define('water', {
  name: 'Eau',
  textures: 'water',
  render: RenderKind.Liquid,
  layer: RenderLayer.Translucent,
  solid: false,
  opaque: false,
  lightFilter: 2,
  hardness: -1,
  fluid: true,
  replaceable: true,
  sound: 'liquid',
});
define('lava', {
  name: 'Lave',
  textures: 'lava',
  render: RenderKind.Liquid,
  layer: RenderLayer.Opaque,
  solid: false,
  opaque: false,
  lightFilter: 0,
  emission: 15,
  hardness: -1,
  fluid: true,
  replaceable: true,
  contactDamage: 4,
  sound: 'liquid',
});

define('coal_ore', { name: 'Minerai de charbon', textures: 'coal_ore', hardness: 3, tool: 'pickaxe', needsTool: true, drop: 'coal' });
define('iron_ore', { name: 'Minerai de fer', textures: 'iron_ore', hardness: 3, tool: 'pickaxe', needsTool: true, drop: 'raw_iron' });
define('gold_ore', { name: 'Minerai d’or', textures: 'gold_ore', hardness: 3, tool: 'pickaxe', needsTool: true, drop: 'raw_gold' });
define('diamond_ore', { name: 'Minerai de diamant', textures: 'diamond_ore', hardness: 3, tool: 'pickaxe', needsTool: true, drop: 'diamond' });
define('redstone_ore', { name: 'Minerai de redstone', textures: 'redstone_ore', hardness: 3, tool: 'pickaxe', needsTool: true, drop: 'redstone', dropCount: [4, 5] });
define('lapis_ore', { name: 'Minerai de lapis', textures: 'lapis_ore', hardness: 3, tool: 'pickaxe', needsTool: true, drop: 'lapis', dropCount: [4, 8] });
define('emerald_ore', { name: 'Minerai d’émeraude', textures: 'emerald_ore', hardness: 3, tool: 'pickaxe', needsTool: true, drop: 'emerald' });

define('oak_log', { name: 'Bûche de chêne', textures: { top: 'oak_log_top', side: 'oak_log' }, hardness: 2, tool: 'axe', sound: 'wood', flammable: true });
define('birch_log', { name: 'Bûche de bouleau', textures: { top: 'birch_log_top', side: 'birch_log' }, hardness: 2, tool: 'axe', sound: 'wood', flammable: true });
define('spruce_log', { name: 'Bûche de sapin', textures: { top: 'spruce_log_top', side: 'spruce_log' }, hardness: 2, tool: 'axe', sound: 'wood', flammable: true });
define('jungle_log', { name: 'Bûche d’acajou', textures: { top: 'jungle_log_top', side: 'jungle_log' }, hardness: 2, tool: 'axe', sound: 'wood', flammable: true });

define('oak_leaves', {
  name: 'Feuilles de chêne',
  textures: 'oak_leaves',
  layer: RenderLayer.Cutout,
  opaque: false,
  lightFilter: 1,
  hardness: 0.2,
  tool: 'shears',
  drop: 'oak_sapling',
  dropCount: [0, 1],
  sound: 'grass',
  tint: FOLIAGE_TINT,
  flammable: true,
});
define('birch_leaves', {
  name: 'Feuilles de bouleau',
  textures: 'birch_leaves',
  layer: RenderLayer.Cutout,
  opaque: false,
  lightFilter: 1,
  hardness: 0.2,
  tool: 'shears',
  drop: 'birch_sapling',
  dropCount: [0, 1],
  sound: 'grass',
  tint: 0x709756,
  flammable: true,
});
define('spruce_leaves', {
  name: 'Feuilles de sapin',
  textures: 'spruce_leaves',
  layer: RenderLayer.Cutout,
  opaque: false,
  lightFilter: 1,
  hardness: 0.2,
  tool: 'shears',
  drop: 'spruce_sapling',
  dropCount: [0, 1],
  sound: 'grass',
  tint: 0x3b5d38,
  flammable: true,
});
define('jungle_leaves', {
  name: 'Feuilles d’acajou',
  textures: 'jungle_leaves',
  layer: RenderLayer.Cutout,
  opaque: false,
  lightFilter: 1,
  hardness: 0.2,
  tool: 'shears',
  drop: 'jungle_sapling',
  dropCount: [0, 1],
  sound: 'grass',
  tint: 0x409720,
  flammable: true,
});

define('oak_planks', { name: 'Planches de chêne', textures: 'oak_planks', hardness: 2, tool: 'axe', sound: 'wood', flammable: true });
define('birch_planks', { name: 'Planches de bouleau', textures: 'birch_planks', hardness: 2, tool: 'axe', sound: 'wood', flammable: true });
define('spruce_planks', { name: 'Planches de sapin', textures: 'spruce_planks', hardness: 2, tool: 'axe', sound: 'wood', flammable: true });
define('jungle_planks', { name: 'Planches d’acajou', textures: 'jungle_planks', hardness: 2, tool: 'axe', sound: 'wood', flammable: true });

define('glass', {
  name: 'Verre',
  textures: 'glass',
  layer: RenderLayer.Cutout,
  opaque: false,
  lightFilter: 0,
  hardness: 0.3,
  drop: 'air',
  sound: 'glass',
});
define('ice', {
  name: 'Glace',
  textures: 'ice',
  layer: RenderLayer.Translucent,
  opaque: false,
  lightFilter: 3,
  hardness: 0.5,
  tool: 'pickaxe',
  drop: 'air',
  sound: 'glass',
});
define('packed_ice', { name: 'Glace compactée', textures: 'packed_ice', hardness: 0.5, tool: 'pickaxe', sound: 'glass' });
define('snow_block', { name: 'Bloc de neige', textures: 'snow', hardness: 0.2, tool: 'shovel', sound: 'sand' });

define('sandstone', { name: 'Grès', textures: { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone' }, hardness: 0.8, tool: 'pickaxe', needsTool: true, sound: 'stone' });
define('stone_bricks', { name: 'Pierre taillée sculptée', textures: 'stone_bricks', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('mossy_cobblestone', { name: 'Pierre moussue', textures: 'mossy_cobblestone', hardness: 2, tool: 'pickaxe', needsTool: true });
define('bricks', { name: 'Briques', textures: 'bricks', hardness: 2, tool: 'pickaxe', needsTool: true });
define('obsidian', { name: 'Obsidienne', textures: 'obsidian', hardness: 25, tool: 'pickaxe', needsTool: true });
define('andesite', { name: 'Andésite', textures: 'andesite', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('granite', { name: 'Granite', textures: 'granite', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('diorite', { name: 'Diorite', textures: 'diorite', hardness: 1.5, tool: 'pickaxe', needsTool: true });

define('coal_block', { name: 'Bloc de charbon', textures: 'coal_block', hardness: 5, tool: 'pickaxe', needsTool: true });
define('iron_block', { name: 'Bloc de fer', textures: 'iron_block', hardness: 5, tool: 'pickaxe', needsTool: true, sound: 'metal' });
define('gold_block', { name: 'Bloc d’or', textures: 'gold_block', hardness: 3, tool: 'pickaxe', needsTool: true, sound: 'metal' });
define('diamond_block', { name: 'Bloc de diamant', textures: 'diamond_block', hardness: 5, tool: 'pickaxe', needsTool: true, sound: 'metal' });
define('emerald_block', { name: 'Bloc d’émeraude', textures: 'emerald_block', hardness: 5, tool: 'pickaxe', needsTool: true, sound: 'metal' });
define('lapis_block', { name: 'Bloc de lapis', textures: 'lapis_block', hardness: 3, tool: 'pickaxe', needsTool: true });
define('redstone_block', { name: 'Bloc de redstone', textures: 'redstone_block', hardness: 5, tool: 'pickaxe', needsTool: true });

define('glowstone', { name: 'Pierre lumineuse', textures: 'glowstone', hardness: 0.3, emission: 15, sound: 'glass' });
define('sea_lantern', { name: 'Lanterne aquatique', textures: 'sea_lantern', hardness: 0.3, emission: 15, sound: 'glass' });
define('crafting_table', { name: 'Établi', textures: { top: 'crafting_top', bottom: 'oak_planks', side: 'crafting_side' }, hardness: 2.5, tool: 'axe', sound: 'wood', flammable: true });
define('furnace', { name: 'Four', textures: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_front' }, hardness: 3.5, tool: 'pickaxe', needsTool: true });
define('chest', { name: 'Coffre', textures: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side' }, hardness: 2.5, tool: 'axe', sound: 'wood', flammable: true });
define('bookshelf', { name: 'Bibliothèque', textures: { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' }, hardness: 1.5, tool: 'axe', sound: 'wood', flammable: true });
define('tnt', { name: 'TNT', textures: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }, hardness: 0, sound: 'grass' });
define('pumpkin', { name: 'Citrouille', textures: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side' }, hardness: 1, tool: 'axe', sound: 'wood' });
define('jack_o_lantern', { name: 'Citrouille-lanterne', textures: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'jack_o_lantern' }, hardness: 1, emission: 15, tool: 'axe', sound: 'wood' });
define('melon', { name: 'Pastèque', textures: { top: 'melon_top', bottom: 'melon_top', side: 'melon_side' }, hardness: 1, tool: 'axe', drop: 'melon_slice', dropCount: [3, 7], sound: 'wood' });

define('cactus', {
  name: 'Cactus',
  textures: { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' },
  hardness: 0.4,
  contactDamage: 1,
  sound: 'wool',
});

for (const [k, n, c] of [
  ['white', 'blanche', 0xeeeeee],
  ['orange', 'orange', 0xe07a2a],
  ['magenta', 'magenta', 0xbd44b3],
  ['light_blue', 'bleu clair', 0x3aafd9],
  ['yellow', 'jaune', 0xe5c327],
  ['lime', 'vert clair', 0x70b919],
  ['pink', 'rose', 0xe98ba5],
  ['gray', 'grise', 0x3e4447],
  ['cyan', 'cyan', 0x158991],
  ['purple', 'violette', 0x792ab0],
  ['blue', 'bleue', 0x2f2fa5],
  ['brown', 'marron', 0x6a4020],
  ['green', 'verte', 0x4f6a1a],
  ['red', 'rouge', 0x9e2b27],
  ['black', 'noire', 0x191919],
] as const) {
  define(`${k}_wool`, {
    name: `Laine ${n}`,
    textures: 'wool',
    hardness: 0.8,
    sound: 'wool',
    tint: c,
    flammable: true,
  });
}

// --- Blocs « croix » (végétation, torches) ---------------------------------

const cross = (key: string, name: string, texture: string, extra: Partial<BlockOptions> = {}) =>
  define(key, {
    name,
    textures: texture,
    render: RenderKind.Cross,
    layer: RenderLayer.Cutout,
    solid: false,
    opaque: false,
    lightFilter: 0,
    hardness: 0,
    replaceable: true,
    sound: 'grass',
    flammable: true,
    ...extra,
  });

cross('tall_grass', 'Herbe haute', 'tall_grass', { tint: GRASS_TINT, drop: 'wheat_seeds', dropCount: [0, 1] });
cross('fern', 'Fougère', 'fern', { tint: 0x487a38, drop: 'air' });
cross('dead_bush', 'Buisson mort', 'dead_bush', { drop: 'stick', dropCount: [0, 2] });
cross('dandelion', 'Pissenlit', 'dandelion');
cross('poppy', 'Coquelicot', 'poppy');
cross('blue_orchid', 'Orchidée bleue', 'blue_orchid');
cross('brown_mushroom', 'Champignon brun', 'brown_mushroom', { emission: 1, flammable: false });
cross('red_mushroom', 'Champignon rouge', 'red_mushroom', { flammable: false });
cross('oak_sapling', 'Pousse de chêne', 'oak_sapling', { tint: FOLIAGE_TINT });
cross('birch_sapling', 'Pousse de bouleau', 'birch_sapling', { tint: 0x709756 });
cross('spruce_sapling', 'Pousse de sapin', 'spruce_sapling', { tint: 0x3b5d38 });
cross('jungle_sapling', 'Pousse d’acajou', 'jungle_sapling', { tint: 0x409720 });
cross('sugar_cane', 'Canne à sucre', 'sugar_cane', { tint: 0x6f984d });
cross('torch', 'Torche', 'torch', {
  emission: 14,
  replaceable: false,
  sound: 'wood',
});
cross('wheat', 'Blé', 'wheat', { drop: 'wheat', flammable: true });

// ---------------------------------------------------------------------------
// Extension « créatif » : palette de couleurs, variantes de pierre et dalles.
// Ajoutée en fin de registre : les identifiants existants ne bougent pas, les
// sauvegardes restent lisibles.
// ---------------------------------------------------------------------------

/** Les 16 teintes standard, partagées par le béton, la terre cuite et le verre. */
export const DYE_COLORS: readonly (readonly [string, string, number])[] = [
  ['white', 'blanc', 0xd8d8d0],
  ['orange', 'orange', 0xe0761f],
  ['magenta', 'magenta', 0xb03bb0],
  ['light_blue', 'bleu clair', 0x3a9cd8],
  ['yellow', 'jaune', 0xe5c327],
  ['lime', 'vert clair', 0x62b118],
  ['pink', 'rose', 0xe08aa5],
  ['gray', 'gris', 0x3a3f44],
  ['light_gray', 'gris clair', 0x8e9294],
  ['cyan', 'cyan', 0x158991],
  ['purple', 'violet', 0x6a24a8],
  ['blue', 'bleu', 0x2a35a0],
  ['brown', 'marron', 0x6a4020],
  ['green', 'vert', 0x4f6a1a],
  ['red', 'rouge', 0x9e2b27],
  ['black', 'noir', 0x15181a],
];

for (const [key, name, color] of DYE_COLORS) {
  define(`${key}_concrete`, {
    name: `Béton ${name}`,
    textures: 'concrete',
    hardness: 1.8,
    tool: 'pickaxe',
    needsTool: true,
    tint: color,
  });
}
for (const [key, name, color] of DYE_COLORS) {
  define(`${key}_terracotta`, {
    name: `Terre cuite ${name}`,
    textures: 'terracotta',
    hardness: 1.25,
    tool: 'pickaxe',
    needsTool: true,
    tint: color,
  });
}
for (const [key, name, color] of DYE_COLORS) {
  define(`${key}_stained_glass`, {
    name: `Verre teinté ${name}`,
    textures: 'stained_glass',
    layer: RenderLayer.Translucent,
    opaque: false,
    lightFilter: 1,
    hardness: 0.3,
    drop: 'air',
    sound: 'glass',
    tint: color,
  });
}

// Variantes de pierre : de quoi bâtir sans tout faire en pierre taillée.
define('smooth_stone', { name: 'Pierre lisse', textures: 'smooth_stone', hardness: 2, tool: 'pickaxe', needsTool: true });
define('polished_granite', { name: 'Granite poli', textures: 'polished_granite', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('polished_diorite', { name: 'Diorite polie', textures: 'polished_diorite', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('polished_andesite', { name: 'Andésite polie', textures: 'polished_andesite', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('cracked_stone_bricks', { name: 'Pierre taillée fissurée', textures: 'cracked_stone_bricks', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('chiseled_stone_bricks', { name: 'Pierre taillée sculptée', textures: 'chiseled_stone_bricks', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('quartz_block', { name: 'Bloc de quartz', textures: 'quartz', hardness: 0.8, tool: 'pickaxe', needsTool: true });
define('quartz_pillar', { name: 'Pilier de quartz', textures: { top: 'quartz_pillar_top', side: 'quartz_pillar' }, hardness: 0.8, tool: 'pickaxe', needsTool: true });
define('prismarine', { name: 'Prismarine', textures: 'prismarine', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('dark_prismarine', { name: 'Prismarine sombre', textures: 'dark_prismarine', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('purpur_block', { name: 'Bloc de purpur', textures: 'purpur', hardness: 1.5, tool: 'pickaxe', needsTool: true });
define('nether_bricks', { name: 'Briques du Nether', textures: 'nether_bricks', hardness: 2, tool: 'pickaxe', needsTool: true });

// Dalles : un bloc de haut sur un demi-voxel. Deux variantes par matériau,
// posée en bas ou en haut selon l'endroit visé.
export const SLAB_MATERIALS: readonly (readonly [string, string, string])[] = [
  ['stone', 'de pierre', 'stone'],
  ['cobblestone', 'de pierre taillée', 'cobblestone'],
  ['stone_brick', 'de pierre sculptée', 'stone_bricks'],
  ['sandstone', 'de grès', 'sandstone'],
  ['brick', 'de briques', 'bricks'],
  ['quartz', 'de quartz', 'quartz'],
  ['oak', 'de chêne', 'oak_planks'],
  ['birch', 'de bouleau', 'birch_planks'],
  ['spruce', 'de sapin', 'spruce_planks'],
  ['jungle', 'd’acajou', 'jungle_planks'],
];

for (const [key, name, texture] of SLAB_MATERIALS) {
  const wood = key === 'oak' || key === 'birch' || key === 'spruce' || key === 'jungle';
  for (const [suffix, minY, maxY] of [['', 0, 0.5], ['_top', 0.5, 1]] as const) {
    define(`${key}_slab${suffix}`, {
      name: `Dalle ${name}${suffix ? ' (haute)' : ''}`,
      textures: texture,
      // Le bloc ne remplit pas son voxel : il ne masque pas les faces voisines,
      // mais il arrête toute la lumière.
      opaque: false,
      lightFilter: 15,
      hardness: wood ? 2 : 2,
      tool: wood ? 'axe' : 'pickaxe',
      needsTool: !wood,
      sound: wood ? 'wood' : 'stone',
      flammable: wood,
      drop: `${key}_slab`,
      minY,
      maxY,
    });
  }
}

// ---------------------------------------------------------------------------
// Escaliers
// ---------------------------------------------------------------------------

/**
 * Un escalier est fait de deux boîtes : une dalle basse qui couvre tout le
 * voxel, et une demi-marche posée dessus, du côté haut. `facing` désigne ce
 * côté haut — celui contre lequel on bute et qu'on gravit.
 *
 * Quatre orientations suffisent ; on renonce aux escaliers retournés, qui
 * doubleraient le nombre d'identifiants pour un usage nettement plus rare.
 */
export const STAIR_FACINGS = ['north', 'south', 'west', 'east'] as const;
export type StairFacing = (typeof STAIR_FACINGS)[number];

/** Demi-marche haute, selon le côté relevé. */
const STEP_BOX: Record<StairFacing, Box> = {
  north: [0, 0.5, 0, 1, 1, 0.5],
  south: [0, 0.5, 0.5, 1, 1, 1],
  west: [0, 0.5, 0, 0.5, 1, 1],
  east: [0.5, 0.5, 0, 1, 1, 1],
};

export const STAIR_MATERIALS: readonly (readonly [string, string, string])[] = [
  ['cobblestone', 'de pierre taillée', 'cobblestone'],
  ['stone_brick', 'de pierre sculptée', 'stone_bricks'],
  ['sandstone', 'de grès', 'sandstone'],
  ['brick', 'de briques', 'bricks'],
  ['oak', 'de chêne', 'oak_planks'],
  ['spruce', 'de sapin', 'spruce_planks'],
];

for (const [key, name, texture] of STAIR_MATERIALS) {
  const wood = key === 'oak' || key === 'spruce';
  for (const facing of STAIR_FACINGS) {
    define(`${key}_stairs_${facing}`, {
      name: `Escalier ${name}`,
      textures: texture,
      // Comme la dalle : ne masque pas les faces voisines, mais arrête la lumière.
      opaque: false,
      lightFilter: 15,
      hardness: 2,
      tool: wood ? 'axe' : 'pickaxe',
      needsTool: !wood,
      sound: wood ? 'wood' : 'stone',
      flammable: wood,
      // Une seule clé d'objet pour les quatre orientations.
      drop: `${key}_stairs`,
      boxes: [[0, 0, 0, 1, 0.5, 1], STEP_BOX[facing]],
    });
  }
}

// ---------------------------------------------------------------------------
// Nether et End
// ---------------------------------------------------------------------------

define('netherrack', {
  name: 'Netherrack', textures: 'netherrack', hardness: 0.4, tool: 'pickaxe', needsTool: true, flammable: true,
});
define('soul_sand', {
  name: 'Sable des âmes', textures: 'soul_sand', hardness: 0.5, tool: 'shovel', sound: 'sand',
  // Le bloc n'occupe que sept huitièmes de son voxel : on s'y enfonce.
  minY: 0, maxY: 0.875, opaque: false, lightFilter: 15,
});
define('magma_block', {
  name: 'Bloc de magma', textures: 'magma', hardness: 0.5, tool: 'pickaxe', needsTool: true,
  emission: 3, contactDamage: 1,
});
define('glowing_obsidian', {
  name: 'Obsidienne pleurante', textures: 'glowing_obsidian', hardness: 12, tool: 'pickaxe', needsTool: true, emission: 10,
});
define('ancient_debris', {
  name: 'Débris antiques', textures: 'ancient_debris', hardness: 6, tool: 'pickaxe', needsTool: true,
  drop: 'ancient_debris', sound: 'metal',
});
define('netherite_block', {
  name: 'Bloc de netherite', textures: 'netherite_block', hardness: 8, tool: 'pickaxe', needsTool: true, sound: 'metal',
});
define('nether_quartz_ore', {
  name: 'Quartz du Nether', textures: 'nether_quartz_ore', hardness: 3, tool: 'pickaxe', needsTool: true,
  drop: 'quartz', dropCount: [1, 2],
});
define('end_stone', { name: 'Pierre de l’End', textures: 'end_stone', hardness: 3, tool: 'pickaxe', needsTool: true });

/**
 * Cadre du portail de l'End. Ne se casse pas : c'est le repère de la salle du
 * portail, et le remplir d'yeux ouvre le passage.
 */
define('end_portal_frame', {
  name: 'Cadre de portail', textures: { top: 'end_portal_frame_top', side: 'end_portal_frame' },
  hardness: -1, emission: 1,
});
define('end_portal_frame_filled', {
  name: 'Cadre de portail (œil)', textures: { top: 'end_portal_frame_eye', side: 'end_portal_frame' },
  hardness: -1, emission: 6,
});

/**
 * Blocs de portail. Traversables, lumineux, incassables à la main : c'est le
 * jeu qui les pose et les retire.
 */
define('nether_portal', {
  name: 'Portail du Nether', textures: 'nether_portal',
  render: RenderKind.Cube, layer: RenderLayer.Translucent,
  solid: false, opaque: false, lightFilter: 0, emission: 11, hardness: -1, replaceable: false, sound: 'glass',
});
/**
 * Cristal de l'End, planté au sommet des colonnes d'obsidienne. Tant qu'il en
 * reste un, le dragon se régénère : c'est le vrai enjeu du combat.
 */
define('end_crystal', {
  name: 'Cristal de l’End', textures: 'end_crystal',
  layer: RenderLayer.Cutout, opaque: false, lightFilter: 0, emission: 14,
  hardness: 0.4, drop: 'air', sound: 'glass',
});
/** Trophée déposé par le dragon, à récupérer à la pioche. */
define('dragon_egg', {
  name: 'Œuf de dragon', textures: 'dragon_egg', emission: 4, hardness: 3, tool: 'pickaxe', sound: 'stone',
});

define('end_portal', {
  name: 'Portail de l’End', textures: 'end_portal',
  render: RenderKind.Cube, layer: RenderLayer.Translucent,
  solid: false, opaque: false, lightFilter: 0, emission: 15, hardness: -1, sound: 'glass',
});

// ---------------------------------------------------------------------------
// Menuiserie : porte, portillon, lit
// ---------------------------------------------------------------------------

/**
 * Les trois familles partagent la même convention d'orientation que les
 * escaliers : `facing` désigne la direction vers laquelle le bloc « regarde ».
 *
 * - une porte est un panneau mince plaqué contre le bord `facing` du voxel ;
 *   ouverte, le panneau pivote d'un quart de tour et se plaque sur le côté ;
 * - un portillon fermé barre le passage à mi-hauteur ; ouvert, il ne reste que
 *   les deux montants, et on passe ;
 * - un lit occupe le bas du voxel, la tête portant l'oreiller.
 */
export const FACINGS = ['north', 'south', 'west', 'east'] as const;
export type Facing = (typeof FACINGS)[number];

/** Quart de tour à appliquer à la texture du dessus, par orientation. */
const FACING_ROT: Record<Facing, number> = { north: 0, south: 2, west: 3, east: 1 };

const T = 3 / 16; // épaisseur d'un panneau de porte

/** Panneau plaqué contre le bord `facing`. */
const PANEL: Record<Facing, Box> = {
  north: [0, 0, 0, 1, 1, T],
  south: [0, 0, 1 - T, 1, 1, 1],
  west: [0, 0, 0, T, 1, 1],
  east: [1 - T, 0, 0, 1, 1, 1],
};
const LT = 2 / 16; // épaisseur d'une échelle
/** Panneau d'échelle, plaqué contre le mur porteur. */
const LADDER_PANEL: Record<Facing, Box> = {
  north: [0, 0, 0, 1, 1, LT],
  south: [0, 0, 1 - LT, 1, 1, 1],
  west: [0, 0, 0, LT, 1, 1],
  east: [1 - LT, 0, 0, 1, 1, 1],
};
/** Quart de tour dans le sens horaire : la porte ouverte se plaque sur ce côté. */
const OPEN_OF: Record<Facing, Facing> = { north: 'east', east: 'south', south: 'west', west: 'north' };

for (const facing of FACINGS) {
  for (const [half, texture, label] of [['lower', 'door_lower', 'bas'], ['upper', 'door_upper', 'haut']] as const) {
    for (const [state, box] of [['closed', PANEL[facing]], ['open', PANEL[OPEN_OF[facing]]]] as const) {
      define(`oak_door_${facing}_${half}_${state}`, {
        name: `Porte de chêne (${label})`,
        textures: texture,
        layer: RenderLayer.Cutout,
        opaque: false,
        lightFilter: 0,
        hardness: 3,
        tool: 'axe',
        sound: 'wood',
        flammable: true,
        // Une seule clé d'objet pour les seize variantes, et seule la moitié
        // basse la rend : sinon casser une porte donnerait deux portes.
        drop: half === 'lower' ? 'oak_door' : 'air',
        boxes: [box],
      });
    }
  }
}

/** Montants du portillon ouvert : le passage est libre entre les deux. */
const GATE_POSTS: Record<Facing, [Box, Box]> = {
  north: [[0, 0.3, 0, 2 / 16, 1, T], [14 / 16, 0.3, 0, 1, 1, T]],
  south: [[0, 0.3, 1 - T, 2 / 16, 1, 1], [14 / 16, 0.3, 1 - T, 1, 1, 1]],
  west: [[0, 0.3, 0, T, 1, 2 / 16], [0, 0.3, 14 / 16, T, 1, 1]],
  east: [[1 - T, 0.3, 0, 1, 1, 2 / 16], [1 - T, 0.3, 14 / 16, 1, 1, 1]],
};
/** Battant fermé : une barrière pleine à mi-hauteur, en travers du passage. */
const GATE_LEAF: Record<Facing, Box> = {
  north: [0, 0.3, 0, 1, 1, T],
  south: [0, 0.3, 1 - T, 1, 1, 1],
  west: [0, 0.3, 0, T, 1, 1],
  east: [1 - T, 0.3, 0, 1, 1, 1],
};

for (const facing of FACINGS) {
  for (const state of ['closed', 'open'] as const) {
    define(`oak_fence_gate_${facing}_${state}`, {
      name: 'Portillon de chêne',
      textures: 'oak_planks',
      opaque: false,
      lightFilter: 0,
      // Ouvert, le portillon ne barre plus rien : les montants sont décoratifs.
      solid: state === 'closed',
      hardness: 2,
      tool: 'axe',
      sound: 'wood',
      flammable: true,
      drop: 'oak_fence_gate',
      boxes: state === 'closed' ? [GATE_LEAF[facing]] : GATE_POSTS[facing],
    });
  }
}

for (const facing of FACINGS) {
  for (const [half, top, label] of [['foot', 'bed_foot', 'pied'], ['head', 'bed_head', 'tête']] as const) {
    define(`red_bed_${facing}_${half}`, {
      name: `Lit rouge (${label})`,
      textures: { top, bottom: 'oak_planks', side: 'bed_side' },
      opaque: false,
      lightFilter: 15,
      hardness: 0.4,
      sound: 'wool',
      flammable: true,
      // Comme la porte : une seule des deux moitiés rend l'objet.
      drop: half === 'foot' ? 'red_bed' : 'air',
      // La tête d'un lit orienté « north » a son oreiller au nord : la texture
      // du dessus tourne avec l'orientation.
      rotTop: FACING_ROT[facing],
      minY: 0,
      maxY: 0.5625,
    });
  }
}

/**
 * Échelle : un panneau ajouré plaqué contre le mur qui la porte. `facing`
 * désigne le côté où se trouve ce mur — la même convention que la porte.
 *
 * Elle ne bloque pas le passage : on entre dedans, et c'est justement le
 * contact qui déclenche l'escalade.
 */
for (const facing of FACINGS) {
  define(`ladder_${facing}`, {
    name: 'Échelle',
    textures: 'ladder',
    layer: RenderLayer.Cutout,
    solid: false,
    opaque: false,
    lightFilter: 0,
    climbable: true,
    hardness: 0.4,
    tool: 'axe',
    sound: 'wood',
    flammable: true,
    drop: 'ladder',
    boxes: [LADDER_PANEL[facing]],
  });
}

export const AIR = 0;
export const BLOCK_COUNT = BLOCKS.length;

/** Table dense pour les accès chauds du mailleur (évite les indirections d'objet). */
export const IS_OPAQUE = new Uint8Array(BLOCK_COUNT);
export const IS_SOLID = new Uint8Array(BLOCK_COUNT);
export const LIGHT_FILTER = new Uint8Array(BLOCK_COUNT);
export const EMISSION = new Uint8Array(BLOCK_COUNT);
export const RENDER_KIND = new Uint8Array(BLOCK_COUNT);
export const RENDER_LAYER = new Uint8Array(BLOCK_COUNT);
export const IS_FLUID = new Uint8Array(BLOCK_COUNT);
export const IS_REPLACEABLE = new Uint8Array(BLOCK_COUNT);
export const TINTS = new Uint32Array(BLOCK_COUNT);
/** Emprise verticale : 1 quand le bloc remplit son voxel. */
export const MIN_Y = new Float32Array(BLOCK_COUNT);
export const MAX_Y = new Float32Array(BLOCK_COUNT);
/** Le bloc n'occupe pas tout son voxel : géométrie et collision à part. */
export const IS_PARTIAL = new Uint8Array(BLOCK_COUNT);
/** Nombre de boîtes composant le bloc (1 pour un cube ou une dalle, 2 pour un escalier). */
export const SHAPE_COUNT = new Uint8Array(BLOCK_COUNT);
/** Boîtes aplaties : six flottants par boîte, deux boîtes par bloc au plus. */
export const MAX_BOXES = 2;
export const SHAPE_BOXES = new Float32Array(BLOCK_COUNT * MAX_BOXES * 6);
/** [top, bottom, side] aplatis par identifiant de bloc. */
export const TEX_LAYERS = new Uint16Array(BLOCK_COUNT * 3);
/** Quarts de tour de la texture du dessus, 0..3. */
export const ROT_TOP = new Uint8Array(BLOCK_COUNT);
/** Le bloc se grimpe (échelle). */
export const IS_CLIMBABLE = new Uint8Array(BLOCK_COUNT);

for (const b of BLOCKS) {
  IS_OPAQUE[b.id] = b.opaque ? 1 : 0;
  IS_SOLID[b.id] = b.solid ? 1 : 0;
  LIGHT_FILTER[b.id] = b.lightFilter;
  EMISSION[b.id] = b.emission;
  RENDER_KIND[b.id] = b.render;
  RENDER_LAYER[b.id] = b.layer;
  IS_FLUID[b.id] = b.fluid ? 1 : 0;
  IS_REPLACEABLE[b.id] = b.replaceable ? 1 : 0;
  TINTS[b.id] = b.tint;
  MIN_Y[b.id] = b.minY;
  MAX_Y[b.id] = b.maxY;
  const boxes: Box[] = b.boxes ?? [[0, b.minY, 0, 1, b.maxY, 1]];
  SHAPE_COUNT[b.id] = boxes.length;
  for (let k = 0; k < boxes.length && k < MAX_BOXES; k++) {
    SHAPE_BOXES.set(boxes[k], (b.id * MAX_BOXES + k) * 6);
  }
  IS_PARTIAL[b.id] = b.boxes !== undefined || b.minY > 0 || b.maxY < 1 ? 1 : 0;
  TEX_LAYERS[b.id * 3 + 0] = b.layers.top;
  TEX_LAYERS[b.id * 3 + 1] = b.layers.bottom;
  TEX_LAYERS[b.id * 3 + 2] = b.layers.side;
  ROT_TOP[b.id] = b.rotTop;
  IS_CLIMBABLE[b.id] = b.climbable ? 1 : 0;
}

export const TEXTURE_NAMES: readonly string[] = TEXTURE_ORDER;

export function blockId(key: string): number {
  const b = BLOCK_BY_KEY.get(key);
  if (!b) throw new Error(`Bloc inconnu : ${key}`);
  return b.id;
}

export function block(id: number): BlockDef {
  return BLOCKS[id] ?? BLOCKS[0];
}

/** Raccourcis fréquemment utilisés par la génération de terrain. */
export const B = {
  air: 0,
  stone: blockId('stone'),
  grass: blockId('grass_block'),
  dirt: blockId('dirt'),
  coarse_dirt: blockId('coarse_dirt'),
  cobblestone: blockId('cobblestone'),
  bedrock: blockId('bedrock'),
  sand: blockId('sand'),
  red_sand: blockId('red_sand'),
  gravel: blockId('gravel'),
  clay: blockId('clay'),
  water: blockId('water'),
  lava: blockId('lava'),
  coal_ore: blockId('coal_ore'),
  iron_ore: blockId('iron_ore'),
  gold_ore: blockId('gold_ore'),
  diamond_ore: blockId('diamond_ore'),
  redstone_ore: blockId('redstone_ore'),
  lapis_ore: blockId('lapis_ore'),
  emerald_ore: blockId('emerald_ore'),
  oak_log: blockId('oak_log'),
  birch_log: blockId('birch_log'),
  spruce_log: blockId('spruce_log'),
  jungle_log: blockId('jungle_log'),
  oak_leaves: blockId('oak_leaves'),
  birch_leaves: blockId('birch_leaves'),
  spruce_leaves: blockId('spruce_leaves'),
  jungle_leaves: blockId('jungle_leaves'),
  snow: blockId('snow_block'),
  ice: blockId('ice'),
  packed_ice: blockId('packed_ice'),
  sandstone: blockId('sandstone'),
  andesite: blockId('andesite'),
  granite: blockId('granite'),
  diorite: blockId('diorite'),
  cactus: blockId('cactus'),
  tall_grass: blockId('tall_grass'),
  fern: blockId('fern'),
  dead_bush: blockId('dead_bush'),
  dandelion: blockId('dandelion'),
  poppy: blockId('poppy'),
  blue_orchid: blockId('blue_orchid'),
  brown_mushroom: blockId('brown_mushroom'),
  red_mushroom: blockId('red_mushroom'),
  sugar_cane: blockId('sugar_cane'),
  pumpkin: blockId('pumpkin'),
  melon: blockId('melon'),
  torch: blockId('torch'),
  glowstone: blockId('glowstone'),
  obsidian: blockId('obsidian'),
  mossy_cobblestone: blockId('mossy_cobblestone'),
  // Matériaux de structures (villages, épaves, portails engloutis).
  oak_planks: blockId('oak_planks'),
  birch_planks: blockId('birch_planks'),
  spruce_planks: blockId('spruce_planks'),
  jungle_planks: blockId('jungle_planks'),
  glass: blockId('glass'),
  stone_bricks: blockId('stone_bricks'),
  cracked_stone_bricks: blockId('cracked_stone_bricks'),
  bricks: blockId('bricks'),
  chest: blockId('chest'),
  crafting_table: blockId('crafting_table'),
  furnace: blockId('furnace'),
  bookshelf: blockId('bookshelf'),
  prismarine: blockId('prismarine'),
  dark_prismarine: blockId('dark_prismarine'),
  sea_lantern: blockId('sea_lantern'),
  jack_o_lantern: blockId('jack_o_lantern'),
  quartz_block: blockId('quartz_block'),
  wheat: blockId('wheat'),
  oak_slab: blockId('oak_slab'),
  spruce_slab: blockId('spruce_slab'),
  cobblestone_slab: blockId('cobblestone_slab'),
  sandstone_slab: blockId('sandstone_slab'),
  white_wool: blockId('white_wool'),
  red_wool: blockId('red_wool'),
  brown_terracotta: blockId('brown_terracotta'),
  // Nether et End.
  netherrack: blockId('netherrack'),
  soul_sand: blockId('soul_sand'),
  magma_block: blockId('magma_block'),
  glowing_obsidian: blockId('glowing_obsidian'),
  ancient_debris: blockId('ancient_debris'),
  netherite_block: blockId('netherite_block'),
  nether_quartz_ore: blockId('nether_quartz_ore'),
  end_stone: blockId('end_stone'),
  end_portal_frame: blockId('end_portal_frame'),
  end_portal_frame_filled: blockId('end_portal_frame_filled'),
  nether_portal: blockId('nether_portal'),
  end_portal: blockId('end_portal'),
  nether_bricks: blockId('nether_bricks'),
  purpur_block: blockId('purpur_block'),
  end_crystal: blockId('end_crystal'),
  dragon_egg: blockId('dragon_egg'),
} as const;
