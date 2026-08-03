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
}

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
    textures: t,
    layers: { top: tex(t.top), bottom: tex(t.bottom), side: tex(t.side) },
  };
  BLOCKS.push(def);
  BLOCK_BY_KEY.set(key, def);
  return def;
}

const FOLIAGE_TINT = 0x6cbb3c;
const GRASS_TINT = 0x79c05a;

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
  tint: 0x93c771,
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
  tint: 0x4d7a4a,
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
  tint: 0x54c72a,
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
cross('fern', 'Fougère', 'fern', { tint: 0x5fa04a, drop: 'air' });
cross('dead_bush', 'Buisson mort', 'dead_bush', { drop: 'stick', dropCount: [0, 2] });
cross('dandelion', 'Pissenlit', 'dandelion');
cross('poppy', 'Coquelicot', 'poppy');
cross('blue_orchid', 'Orchidée bleue', 'blue_orchid');
cross('brown_mushroom', 'Champignon brun', 'brown_mushroom', { emission: 1, flammable: false });
cross('red_mushroom', 'Champignon rouge', 'red_mushroom', { flammable: false });
cross('oak_sapling', 'Pousse de chêne', 'oak_sapling', { tint: FOLIAGE_TINT });
cross('birch_sapling', 'Pousse de bouleau', 'birch_sapling', { tint: 0x93c771 });
cross('spruce_sapling', 'Pousse de sapin', 'spruce_sapling', { tint: 0x4d7a4a });
cross('jungle_sapling', 'Pousse d’acajou', 'jungle_sapling', { tint: 0x54c72a });
cross('sugar_cane', 'Canne à sucre', 'sugar_cane', { tint: 0x92c866 });
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
/** Le bloc n'occupe pas tout son voxel (dalle) : géométrie et collision à part. */
export const IS_PARTIAL = new Uint8Array(BLOCK_COUNT);
/** [top, bottom, side] aplatis par identifiant de bloc. */
export const TEX_LAYERS = new Uint16Array(BLOCK_COUNT * 3);

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
  IS_PARTIAL[b.id] = b.minY > 0 || b.maxY < 1 ? 1 : 0;
  TEX_LAYERS[b.id * 3 + 0] = b.layers.top;
  TEX_LAYERS[b.id * 3 + 1] = b.layers.bottom;
  TEX_LAYERS[b.id * 3 + 2] = b.layers.side;
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
} as const;
