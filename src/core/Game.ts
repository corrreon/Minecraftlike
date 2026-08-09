/**
 * Orchestrateur du jeu : boucle principale, rendu, interactions, entités,
 * cycle jour/nuit, météo, sauvegarde et console de commandes.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import {
  CHUNK_X,
  CHUNK_Z,
  DAY_LENGTH_SECONDS,
  REACH_CREATIVE,
  REACH_SURVIVAL,
  SEA_LEVEL,
  WORLD_HEIGHT,
  chunkKey,
  floorDiv,
  mod,
  voxelIndex,
} from './constants';
import { Input } from './Input';
import { isTouchDevice, loadSettings, saveSettings, type Settings } from './Settings';
import { AudioEngine, type SoundGroup } from '../audio/Audio';
import { Mob, ItemEntity, MOBS, coloredBox, findSpawnSpot, findWaterSpawnSpot, itemColor, type MobKind } from '../entities/Entities';
import { Container, HOTBAR_SIZE, makeStack, type ItemStack } from '../items/Inventory';
import { Inventory } from '../items/Inventory';
import { ITEM_BY_KEY, ITEM_OF_BLOCK, SMELTING, blockDrops, breakInfo, type ItemDef } from '../items/items';
import { ONEBLOCK_PHASES, phaseFor, pickOneblock, rollLoot } from '../items/loot';
import { GameMode, Player } from '../player/Player';
import { raycast, type RaycastHit } from '../player/physics';
import { TILE, buildAtlas, type Atlas } from '../render/atlas';
import { ChunkManager } from '../render/ChunkManager';
import { createEnvUniforms, type EnvUniforms } from '../render/env';
import { createEntityMaterial } from '../render/entityMaterial';
import { createShadowMaterial, createTerrainMaterial } from '../render/materials';
import { ParticleSystem, Weather } from '../render/Particles';
import { PostFX, projectSun } from '../render/PostFX';
import { Sky, computeSkyState, createSkyState, type SkyState } from '../render/Sky';
import { ShadowMap } from '../render/ShadowMap';
import { openDatabase, deleteWorld as dbDeleteWorld, listWorlds, SaveManager, type EntitySave, type PlayerSave, type WorldMeta } from '../save/SaveManager';
import { B, BLOCKS, BLOCK_BY_KEY, FACINGS, IS_SOLID, RenderKind, block as blockDef, type Facing } from '../world/blocks';
import { biomeDef } from '../world/biomes';
import { ChunkState } from '../world/Chunk';
import { World } from '../world/World';
import { WorkerPool } from '../world/WorkerPool';
import { NETHER_LAVA, ONEBLOCK_X, ONEBLOCK_Y, ONEBLOCK_Z, TerrainGenerator, type Dimension, type GenKind, type WorldType } from '../world/generator';
import { Hud, type TouchHandlers } from '../ui/Hud';
import { Screens, type FurnaceState } from '../ui/Screens';
import { buildIcons } from '../ui/icons';
import { mulberry32 } from '../world/noise';

const MOB_TICK = 1.8;
/** Vitesse de décrochage d'un avion, dupliquée ici pour l'affichage. */
const PLANE_STALL_SPEED = 9;
/** Sensibilité du manche de pilotage, en radians par seconde à fond de course. */
const PLANE_STICK = 1.1;
/** Plafond d'objets au sol, et durée au bout de laquelle ils s'effacent. */
const MAX_DROPS = 320;
const DROP_LIFETIME = 300;
/**
 * Coulée d'eau. Minecraft distingue sept niveaux d'écoulement, ce qui donne
 * la lame qui s'amincit au bord d'une nappe — mais sept identifiants de bloc
 * par fluide, et il n'en reste que deux sur les 256. La coulée est donc faite
 * de blocs pleins : l'eau descend, s'étale, remplit les creux et franchit les
 * rebords, sans le biseau du bord.
 */
/** Portée horizontale d'une coulée depuis sa source, en blocs. */
const FLOW_REACH = 4;
/** Plafond de cases par coulée : une flaque ne doit pas devenir un océan. */
const FLOW_BUDGET = 120;

/** Les six voisins d'une case, pour les tests de contact fluide. */
const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const AUTOSAVE_INTERVAL = 25;

interface HeldView {
  group: Group;
  current: number;
  swing: number;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private env: EnvUniforms = createEnvUniforms();
  private atlas!: Atlas;
  private sky!: Sky;
  private post!: PostFX;
  private shadows!: ShadowMap;
  private shadowMaterial: Material | null = null;
  private skyState = createSkyState();

  private settings: Settings = loadSettings();
  private input: Input;
  private audio = new AudioEngine();
  private hud: Hud;
  private screens: Screens;

  private db: IDBDatabase | null = null;
  private save: SaveManager | null = null;
  private world!: World;
  private pool!: WorkerPool;
  private chunks!: ChunkManager;
  private player = new Player();
  private inventory = new Inventory();

  private mobs: Mob[] = [];
  private drops: ItemEntity[] = [];
  /** Créature actuellement montée, ou null. */
  private mount: Mob | null = null;
  /** Les entités écrites ont déjà été relues pour la dimension courante. */
  private entitiesRestored = false;
  /**
   * Une action d'état a déjà eu lieu pendant cet appui. Poser des blocs se
   * répète tant qu'on maintient le clic — c'est ce qui permet de bâtir en
   * glissant — mais basculer une porte ou remplir un seau, non : un appui d'une
   * demi-seconde remplissait le seau puis le revidait aussitôt.
   */
  private useLocked = false;
  private leashLines!: LineSegments;
  private leashBuf = new Float32Array(0);
  private entityGroup = new Group();
  private particles!: ParticleSystem;
  private weather = new Weather();

  private blockEntities = new Map<string, FurnaceState | Container>();
  private openBlockPos: string | null = null;

  // Boucle.
  private running = false;
  private paused = true;
  private lastTime = 0;
  private accumulator = 0;
  private elapsed = 0;
  private dayTime = 0.32;
  private fps = 60;
  private frameTimes: number[] = [];
  private mobTimer = 0;
  private autosaveTimer = 0;
  private playtime = 0;
  private timeFrozen = false;
  private mobsEnabled = true;

  // Structures et modes de jeu.
  /**
   * Copie du générateur sur le thread principal. Elle ne produit aucun bloc :
   * elle sert à retrouver les villages alentour (pour y faire apparaître
   * villageois et golems) et à savoir si un coffre appartient à une structure.
   */
  private structGen: TerrainGenerator | null = null;
  private worldType: WorldType = 'normal';
  /** Dimension où se trouve le joueur. */
  private dimension: Dimension = 'overworld';
  /** Position de retour dans l'Overworld, retenue en franchissant un portail. */
  private returnPos: Vector3 | null = null;
  /** Temps passé dans un bloc de portail : au-delà d'un seuil, on bascule. */
  private portalTimer = 0;
  /** Empêche un aller-retour immédiat au moment où l'on ressort d'un portail. */
  private portalCooldown = 0;
  /** Contenus de conteneurs, rangés par dimension. */
  private dimEntities = new Map<Dimension, Map<string, FurnaceState | Container>>();
  /** Combat de l'End : le boss, ses cristaux, et le délai avant son entrée. */
  private dragon: Mob | null = null;
  private dragonSpawnDelay = 4;
  private crystals = 0;
  private crystalTimer = 0;
  /** Coffres de structures déjà remplis, pour ne pas les regarnir. */
  private lootedChests = new Set<string>();
  /** Mode « oneblock » : compteur de blocs cassés et phase courante. */
  private oneblockCount = 0;
  private oneblockPhase = '';
  private rainTarget = 0;
  private rainLevel = 0;
  private weatherTimer = 120;

  // Interaction.
  private breakProgress = 0;
  private breakKey = '';
  /**
   * Vrai depuis la destruction d'un bloc jusqu'au relâchement du bouton. C'est
   * ce qui garantit « un bloc par appui » : maintenir enfoncé ne creuse pas.
   */
  private mineLocked = false;
  private placeCooldown = 0;
  private attackCooldown = 0;
  private outline: LineSegments;
  private breakOverlay: Mesh;
  private heldView: HeldView;
  private playerModel: Group;
  private spawnPoint = new Vector3(0, 80, 0);
  private worldReady = false;
  /**
   * Faux tant que `startWorld` n'a pas fini de construire monde, pool et
   * gestionnaire de chunks. Sans ce garde, une image rendue pendant l'un des
   * `await` de la création trouvait `save` déjà assigné mais `chunks` encore
   * indéfini, et levait une exception.
   */
  private sessionReady = false;
  private consoleEl!: HTMLElement;
  private consoleLog!: HTMLElement;
  private consoleInput!: HTMLInputElement;
  private rnd = mulberry32(1234);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;
    this.camera = new PerspectiveCamera(this.settings.fov, 1, 0.08, 1400);
    this.scene.add(this.entityGroup);

    this.input = new Input(canvas);
    this.hud = new Hud();
    this.screens = new Screens({
      settings: this.settings,
      applySettings: () => this.applySettings(),
      listWorlds: () => listWorlds(this.db),
      createWorld: (name, seed, mode, flat) => void this.createWorld(name, seed, mode, flat),
      playWorld: (meta) => void this.startWorld(meta),
      deleteWorld: (id) => dbDeleteWorld(this.db, id),
      resume: () => this.closeScreen(),
      quitToMenu: () => void this.quitToMenu(),
      respawn: () => this.respawn(),
      inventory: this.inventory,
      isCreative: () => this.player.mode === GameMode.Creative,
      onCraft: () => this.hud.updateHotbar(this.inventory, true),
      runCommand: (c) => this.runCommand(c),
      currentFurnace: () => {
        const e = this.openBlockPos ? this.blockEntities.get(this.openBlockPos) : null;
        return e && 'burn' in e ? e : null;
      },
      currentChest: () => {
        const e = this.openBlockPos ? this.blockEntities.get(this.openBlockPos) : null;
        return e instanceof Container ? e : null;
      },
      sound: (n) => (n === 'click' ? this.audio.click() : this.audio.craft()),
    });

    // Contour du bloc visé.
    const edges = new EdgesGeometry(new BoxGeometry(1.001, 1.001, 1.001));
    this.outline = new LineSegments(edges, new LineBasicMaterial({ color: 0x0b0d12, transparent: true, opacity: 0.65, depthTest: true }));
    this.outline.visible = false;
    this.outline.renderOrder = 5;
    this.scene.add(this.outline);

    this.breakOverlay = new Mesh(
      new BoxGeometry(1.004, 1.004, 1.004),
      new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.breakOverlay.visible = false;
    this.breakOverlay.renderOrder = 6;
    this.scene.add(this.breakOverlay);

    // Cordes des laisses : un seul objet, dont on réécrit les sommets à chaque
    // image. En créer un par bête ferait autant d'appels de dessin.
    this.leashLines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: 0x6b5a3e, transparent: true, opacity: 0.9 }),
    );
    this.leashLines.frustumCulled = false;
    this.leashLines.visible = false;
    this.scene.add(this.leashLines);

    this.heldView = { group: new Group(), current: -1, swing: 0 };
    this.scene.add(this.heldView.group);
    this.playerModel = this.buildPlayerModel();
    this.playerModel.visible = false;
    this.scene.add(this.playerModel);

    this.buildConsole();
    this.bindKeys();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('beforeunload', () => void this.persist(true));
  }

  /** Relevé des blocs d'une boîte, par clé : inspection d'une structure. */
  debugScan(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const id = this.world.getBlock(x, y, z);
          if (id <= 0) continue;
          const k = blockDef(id).key;
          out[k] = (out[k] ?? 0) + 1;
        }
      }
    }
    return out;
  }

  /** Position du premier bloc d'une clé donnée dans une boîte. */
  debugFind(key: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] | null {
    const want = BLOCK_BY_KEY.get(key)?.id ?? -1;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) if (this.world.getBlock(x, y, z) === want) return [x, y, z];
      }
    }
    return null;
  }

  /** Butin qu'un coffre de structure rendrait, sans avoir à l'ouvrir. */
  debugLoot(x: number, y: number, z: number): { kind: string | null; items: string[] } {
    const kind = this.structGen?.lootKindAt(x, y, z) ?? null;
    if (!kind) return { kind: null, items: [] };
    return { kind, items: [...rollLoot(kind, x, y, z, 27).values()].map((s) => `${s.item.key}×${s.count}`) };
  }

  /**
   * Rejoue un clic droit sur une face de bloc donnée, sans passer par le
   * lancer de rayon. Sert aux tests : viser à la souris depuis un script est
   * fragile, alors que la face visée, elle, est sans ambiguïté.
   */
  debugUse(x: number, y: number, z: number, nx = 0, ny = 1, nz = 0): void {
    const block = this.world.getBlock(x, y, z);
    if (block < 0) return;
    this.useItem({
      x, y, z, block, nx, ny, nz,
      point: new Vector3(x + 0.5 + nx * 0.5, y + 0.5 + ny * 0.5, z + 0.5 + nz * 0.5),
      distance: 2,
    });
  }

  /** Fait apparaître une créature à une position donnée. */
  debugSpawn(kind: string, x: number, y: number, z: number): boolean {
    if (!(kind in MOBS)) return false;
    this.addMob(kind as MobKind, x, y, z);
    return true;
  }

  /**
   * Casse un bloc comme le ferait le dernier coup de pioche : butin compris.
   * Le lancer de rayon dépend du regard et de la distance, ce qui rend les
   * tests fragiles ; ici la cible est explicite.
   */
  debugBreak(x: number, y: number, z: number): boolean {
    const block = this.world.getBlock(x, y, z);
    if (block <= 0) return false;
    this.destroyBlock({
      x, y, z, block, nx: 0, ny: 1, nz: 0,
      point: new Vector3(x + 0.5, y + 1, z + 0.5),
      distance: 2,
    }, true);
    return true;
  }

  /** Ce qui serait écrit dans la sauvegarde pour la dimension courante. */
  debugEntities(): unknown[] {
    return this.serializeEntities();
  }

  /** Force une sauvegarde immédiate. */
  debugPersist(): Promise<void> {
    return this.persist(false);
  }

  /** Attache toutes les bêtes proches à un piquet : mise en scène des tests. */
  debugTie(x: number, y: number, z: number): number {
    let n = 0;
    for (const m of this.mobs) {
      if (m.def.hostile || m.def.aircraft) continue;
      if (m.position.distanceTo(new Vector3(x + 0.5, y, z + 0.5)) > 8) continue;
      m.leashed = false;
      m.leashPost = { x, y, z };
      n++;
    }
    return n;
  }

  /** Rejoue un clic droit sur ce que le joueur vise réellement. */
  debugUseAimed(): void {
    const eye = this.player.eyePosition.clone();
    const dir = this.player.forward.clone().normalize();
    const reach = this.player.mode === GameMode.Creative ? REACH_CREATIVE : REACH_SURVIVAL;
    this.useItem(raycast(this.world, eye, dir, reach));
  }

  /** Bloc actuellement visé par le rayon d'interaction, fluides compris. */
  debugAimed(): { key: string; x: number; y: number; z: number } | null {
    const eye = this.player.eyePosition.clone();
    const dir = this.player.forward.clone().normalize();
    const h = raycast(this.world, eye, dir, REACH_CREATIVE, true);
    return h ? { key: blockDef(h.block).key, x: h.x, y: h.y, z: h.z } : null;
  }

  /** État des laisses : qui est tenu, qui est noué, et où. */
  debugLeashes(): { kind: string; leashed: boolean; post: number[] | null }[] {
    return this.mobs.filter((m) => !m.dead && (m.leashed || m.leashPost))
      .map((m) => ({ kind: m.kind, leashed: m.leashed, post: m.leashPost ? [m.leashPost.x, m.leashPost.y, m.leashPost.z] : null }));
  }

  /** Relevé des créatures vivantes : espèce et position. */
  debugMobs(): { kind: string; position: number[]; health: number; burning: number }[] {
    return this.mobs.filter((m) => !m.dead)
      .map((m) => ({
        kind: m.kind,
        position: m.position.toArray().map((v) => +v.toFixed(2)),
        health: m.health,
        burning: +m.burning.toFixed(2),
      }));
  }

  /** Vitesse air de l'engin piloté, ou 0. */
  debugAirspeed(): number {
    return this.mount ? this.mount.airspeed : 0;
  }

  /** Créature montée, s'il y en a une. */
  debugMount(): { kind: string; position: number[]; drive: number[]; yaw: number; onGround: boolean } | null {
    const m = this.mount;
    return m
      ? { kind: m.kind, position: m.position.toArray(), drive: [m.driveX, m.driveZ], yaw: this.player.yaw, onGround: m.onGround }
      : null;
  }

  /** Objets au sol, par clé : contrôle de la fusion des piles. */
  debugDrops(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of this.drops) out[d.stack.item.key] = (out[d.stack.item.key] ?? 0) + d.stack.count;
    return out;
  }

  /**
   * Pose un bloc par sa clé : mise en place de scénarios de test.
   * Rend faux si le bloc est inconnu ou si le chunk n'est pas chargé — sans
   * quoi un test croirait avoir bâti un décor qui n'existe pas.
   */
  debugSet(x: number, y: number, z: number, key: string): boolean {
    const id = key === 'air' ? 0 : BLOCK_BY_KEY.get(key)?.id;
    if (id === undefined) return false;
    if (!this.world.setBlock(x, y, z, id)) return false;
    const cx = floorDiv(x, CHUNK_X);
    const cz = floorDiv(z, CHUNK_Z);
    this.save?.recordEdit(cx, cz, voxelIndex(mod(x, CHUNK_X), y, mod(z, CHUNK_Z)), id);
    return true;
  }

  /** Allume un cadre d'obsidienne sans passer par le briquet. */
  debugIgnite(x: number, y: number, z: number): boolean {
    return this.ignitePortal(x, y, z);
  }

  /** Dimension courante et point de retour. */
  debugDimension(): { dimension: string; returnPos: number[] | null } {
    return { dimension: this.dimension, returnPos: this.returnPos ? this.returnPos.toArray() : null };
  }

  /** État du mode « oneblock » : compteur et phase. */
  debugOneblock(): { type: string; count: number; phase: string } {
    return { type: this.worldType, count: this.oneblockCount, phase: this.oneblockPhase };
  }

  /**
   * Planche de contact de toutes les tuiles de l'atlas, en data-URL.
   * Sert à inspecter les textures depuis la console sans lancer d'outil.
   */
  debugAtlasPreview(scale = 3): string {
    const n = this.atlas.layerCount;
    const cols = 12;
    const rows = Math.ceil(n / cols);
    const size = TILE * scale;
    const canvas = document.createElement('canvas');
    canvas.width = cols * size;
    canvas.height = rows * size;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const tmp = document.createElement('canvas');
    tmp.width = TILE;
    tmp.height = TILE;
    const tctx = tmp.getContext('2d')!;
    for (let i = 0; i < n; i++) {
      const img = tctx.createImageData(TILE, TILE);
      img.data.set(this.atlas.tileData(i));
      tctx.putImageData(img, 0, 0);
      ctx.drawImage(tmp, (i % cols) * size, Math.floor(i / cols) * size, size, size);
    }
    return canvas.toDataURL();
  }

  /** Instantané d'état, utile en console et pour les tests automatisés. */
  debugSnapshot(): Record<string, unknown> {
    return {
      paused: this.paused,
      screen: this.screens.active,
      worldReady: this.worldReady,
      locked: this.input.locked,
      attack: this.input.state.attack,
      use: this.input.state.use,
      breakProgress: this.breakProgress,
      pos: this.player.position.toArray(),
      yaw: this.player.yaw,
      pitch: this.player.pitch,
      mode: this.player.mode,
      mobs: this.mobs.length,
      drops: this.drops.length,
      lookingAt: this.lastHit
        ? { block: blockDef(this.lastHit.block).key, x: this.lastHit.x, y: this.lastHit.y, z: this.lastHit.z }
        : null,
      breakKey: this.breakKey,
      aimedMob: this.lastAimedMob,
    };
  }

  /** Dernier bloc visé, exposé pour le débogage. */
  private lastHit: RaycastHit | null = null;
  private lastAimedMob: string | null = null;

  // --- Amorçage -----------------------------------------------------------

  async boot(onProgress: (p: number, label: string) => void): Promise<void> {
    onProgress(0.1, 'Génération des textures…');
    await frame();
    this.atlas = buildAtlas();
    onProgress(0.4, 'Préparation des icônes…');
    await frame();
    buildIcons(this.atlas);
    onProgress(0.6, 'Compilation des shaders…');
    await frame();

    this.sky = new Sky(this.env);
    this.scene.add(this.sky.mesh);
    this.shadows = new ShadowMap(this.settings.shadowResolution, 80);
    this.post = new PostFX(this.renderer, this.env);
    this.scene.add(this.weather.points);

    onProgress(0.8, 'Ouverture de la sauvegarde…');
    // Sur mobile, on bascule d'emblée sur les contrôles tactiles : le
    // verrouillage du pointeur n'y a pas de sens.
    if (isTouchDevice()) this.input.touchEnabled = true;
    this.db = await openDatabase();
    onProgress(1, 'Prêt.');
    this.resize();
    this.screens.show('menu');
    this.hud.show(false);
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  // --- Cycle de vie d'un monde -------------------------------------------

  private async createWorld(name: string, seedText: string, mode: number, type: WorldType = 'normal'): Promise<void> {
    const seed = seedText ? hashSeed(seedText) : (Math.random() * 2 ** 31) | 0;
    const meta: WorldMeta = {
      id: `w_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      name,
      seed,
      mode,
      created: Date.now(),
      lastPlayed: Date.now(),
      playtime: 0,
      dayTime: 0.42,
      type,
      flat: type === 'flat',
      oneblock: type === 'oneblock' ? 0 : undefined,
    };
    await this.startWorld(meta, true);
  }

  private async startWorld(meta: WorldMeta, isNew = false): Promise<void> {
    this.teardownWorld();
    this.sessionReady = false;
    this.screens.show('none');
    this.setLoading(true, 'Génération du monde…');

    meta.lastPlayed = Date.now();
    this.save = await SaveManager.load(this.db, meta);
    if (isNew) await this.save.createOrUpdateMeta();

    // Les mondes créés avant l'arrivée du sélecteur de type n'ont que `flat`.
    this.worldType = meta.type ?? (meta.flat === true ? 'flat' : 'normal');
    this.oneblockCount = meta.oneblock ?? 0;
    this.oneblockPhase = phaseFor(this.oneblockCount).name;
    this.lootedChests.clear();

    this.rnd = mulberry32(meta.seed ^ 0x9e3779b9);
    this.dimension = meta.dimension ?? 'overworld';
    this.save.dimension = this.dimension;
    this.returnPos = meta.returnPos ? new Vector3(...meta.returnPos) : null;
    this.dimEntities.clear();
    this.portalCooldown = 4;
    this.arrivedFrom = null;
    this.buildDimension(meta.seed);

    this.player = new Player();
    this.player.mode = meta.mode as GameMode;
    this.player.autoJump = this.settings.autoJump;
    this.inventory.main.clear();
    this.inventory.armor.clear();
    this.inventory.crafting.clear();
    this.inventory.held = null;
    this.dayTime = meta.dayTime ?? 0.42;
    this.playtime = meta.playtime ?? 0;

    const saved = await this.save.loadPlayer();
    if (saved) this.applyPlayerSave(saved);
    else {
      this.player.position.set(0.5, WORLD_HEIGHT - 4, 0.5);
      if (meta.mode === GameMode.Creative) this.giveStarterKit();
    }

    this.chunks.setCenter(this.player.position.x, this.player.position.z);
    this.worldReady = false;
    this.entitiesRestored = false;
    this.sessionReady = true;
    this.paused = false;
    this.hud.show(true);
    this.hud.updateHotbar(this.inventory, true);
    this.audio.resume();
    this.applySettings();
  }

  /**
   * (Re)construit monde, workers et chunks pour la dimension courante. Appelé à
   * l'ouverture d'un monde, puis à chaque passage de portail.
   */
  private buildDimension(seed: number): void {
    // Le générateur dépend de la dimension : superplat et oneblock ne
    // concernent que l'Overworld.
    const kind: GenKind = this.dimension === 'overworld' ? this.worldType : this.dimension;
    this.world = new World(seed);
    this.structGen = kind === 'normal' || kind === 'nether' ? new TerrainGenerator(seed, kind) : null;
    this.pool = new WorkerPool(seed, kind);
    this.particles = new ParticleSystem(this.world);
    this.scene.add(this.particles.mesh);

    const materials = {
      opaque: createTerrainMaterial('opaque', this.atlas.texture, this.atlas.normalTexture, this.env),
      cutout: createTerrainMaterial('cutout', this.atlas.texture, this.atlas.normalTexture, this.env),
      water: createTerrainMaterial('water', this.atlas.texture, this.atlas.normalTexture, this.env),
    };
    this.shadowMaterial = createShadowMaterial(this.atlas.texture, this.env);
    this.chunks = new ChunkManager(this.world, this.pool, materials, this.save);
    this.chunks.renderDistance = this.settings.renderDistance;
    this.scene.add(this.chunks.group);
  }

  private applyPlayerSave(s: PlayerSave): void {
    this.player.position.set(s.x, s.y, s.z);
    this.player.yaw = s.yaw;
    this.player.pitch = s.pitch;
    this.player.stats.health = s.health;
    this.player.stats.food = s.food;
    this.player.stats.saturation = s.saturation;
    this.player.stats.xp = s.xp;
    this.player.stats.level = s.level;
    this.player.mode = s.mode as GameMode;
    this.inventory.selected = s.selected;
    this.inventory.main.deserialize(s.main);
    this.inventory.armor.deserialize(s.armor);
    if (s.spawn) this.spawnPoint.set(s.spawn[0], s.spawn[1], s.spawn[2]);
  }

  private giveStarterKit(): void {
    for (const key of ['stone', 'oak_planks', 'glass', 'torch', 'oak_log', 'white_wool', 'sand', 'glowstone', 'crafting_table']) {
      const def = ITEM_BY_KEY.get(key);
      if (def) this.inventory.give(makeStack(def, def.maxStack));
    }
  }

  private teardownWorld(): void {
    this.sessionReady = false;
    if (this.chunks) {
      this.chunks.dispose();
      this.scene.remove(this.chunks.group);
    }
    if (this.pool) this.pool.dispose();
    if (this.particles) this.scene.remove(this.particles.mesh);
    this.mount = null;
    this.player.riding = false;
    for (const m of this.mobs) { this.entityGroup.remove(m.group); m.dispose(); }
    for (const d of this.drops) { this.entityGroup.remove(d.object); d.dispose(); }
    this.mobs = [];
    this.drops = [];
    this.blockEntities.clear();
    this.worldReady = false;
    this.entitiesRestored = false;
  }

  private async quitToMenu(): Promise<void> {
    await this.persist(true);
    this.teardownWorld();
    this.save = null;
    this.paused = true;
    this.hud.show(false);
    this.input.exitLock();
    this.screens.show('menu');
  }

  // --- Réglages -----------------------------------------------------------

  applySettings(): void {
    const s = this.settings;
    saveSettings(s);
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.audio.masterVolume = s.masterVolume;
    this.audio.sfxVolume = s.sfxVolume;
    this.audio.musicVolume = s.musicVolume;
    this.audio.muted = s.muted;
    this.audio.applyVolumes();
    this.hud.setGuiScale(s.guiScale);
    this.player.autoJump = s.autoJump;
    if (this.shadows) this.shadows.setSize(s.shadowResolution);
    if (this.post) {
      this.post.quality.bloom = s.bloom;
      this.post.quality.godRays = s.godRays;
      this.post.quality.fxaa = s.fxaa;
    }
    if (this.chunks && this.chunks.renderDistance !== s.renderDistance) {
      this.chunks.renderDistance = s.renderDistance;
    }
    this.env.uRenderDistance.value = s.renderDistance * CHUNK_X;
    this.resize();
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.settings.resolutionScale;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    if (this.post) this.post.setSize(w, h, dpr);
  }

  private setLoading(active: boolean, label: string): void {
    const l = document.getElementById('loading')!;
    const t = document.getElementById('loading-text')!;
    const bar = document.getElementById('loading-bar')!;
    t.textContent = label;
    bar.style.width = active ? '65%' : '100%';
    l.classList.toggle('done', !active);
  }

  // --- Entrées ------------------------------------------------------------

  private bindKeys(): void {
    this.input.setLockHandler((locked) => {
      // Perdre le pointeur mène en pause, sauf si c'est nous qui l'avons
      // relâché pour ouvrir la console ou un écran.
      if (!locked && !this.paused && !this.screens.isOpen && !this.consoleOpen) this.openPause();
    });

    this.canvas.addEventListener('mousedown', () => {
      this.audio.resume();
      if (!this.paused && !this.screens.isOpen && !this.input.locked) this.input.requestLock();
    });

    this.input.onKey('Escape', () => {
      if (this.screens.isOpen) {
        if (this.screens.isGameOverlay) this.closeScreen();
        else if (this.screens.active === 'settings' || this.screens.active === 'help') this.screens.show(this.screens.previous);
        else if (this.screens.active === 'pause') this.closeScreen();
      } else if (!this.paused) {
        this.openPause();
      }
    });

    this.input.onKey('KeyE', () => {
      if (this.paused) return;
      if (this.screens.isGameOverlay) this.closeScreen();
      else if (!this.screens.isOpen) this.openInventory('inventory');
    });

    this.input.onKey('F3', (e) => {
      e.preventDefault();
      this.settings.showFps = !this.settings.showFps;
      saveSettings(this.settings);
    });

    this.input.onKey('F5', () => {
      this.player.cameraMode = (this.player.cameraMode + 1) % 3;
    });
    this.input.onKey('KeyF', () => {
      this.player.cameraMode = (this.player.cameraMode + 1) % 3;
    });

    // `preventDefault` évite que la touche d'ouverture ne soit saisie dans le
    // champ que l'on vient de focaliser.
    this.input.onKey('KeyT', (e) => {
      if (this.paused || this.screens.isOpen || this.consoleOpen) return;
      e.preventDefault();
      this.openConsole('');
    });
    this.input.onKey('Slash', (e) => {
      if (this.paused || this.screens.isOpen || this.consoleOpen) return;
      e.preventDefault();
      this.openConsole('/');
    });

    this.input.onKey('KeyQ', () => {
      if (this.paused || this.screens.isOpen) return;
      this.dropSelected();
    });

    for (let i = 0; i < 9; i++) {
      this.input.onKey(`Digit${i + 1}`, () => {
        if (this.paused || this.screens.isOpen) return;
        this.inventory.selected = i;
      });
    }
  }

  private openPause(): void {
    this.paused = true;
    this.input.exitLock();
    this.screens.previous = 'pause';
    this.screens.show('pause');
  }

  private openInventory(which: 'inventory' | 'crafting'): void {
    this.input.exitLock();
    this.screens.show(which);
  }

  private closeScreen(): void {
    if (this.screens.isGameOverlay) this.screens.returnHeldAndCrafting();
    this.screens.show('none');
    this.openBlockPos = null;
    this.paused = false;
    this.hud.updateHotbar(this.inventory, true);
    if (!this.input.touchEnabled) this.input.requestLock();
  }

  // --- Console ------------------------------------------------------------

  private buildConsole(): void {
    const c = document.createElement('div');
    c.id = 'console';
    const log = document.createElement('div');
    log.id = 'console-log';
    const row = document.createElement('div');
    row.id = 'console-row';
    const input = document.createElement('input');
    input.id = 'console-input';
    input.type = 'text';
    // Le clavier virtuel ne doit ni corriger ni capitaliser une commande.
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.enterKeyHint = 'send';
    input.placeholder = '/aide';

    // Sans touche Entrée ni Échap au doigt, il faut deux boutons.
    const send = document.createElement('button');
    send.id = 'console-send';
    send.type = 'button';
    send.textContent = '⏎';
    send.title = 'Envoyer';
    const close = document.createElement('button');
    close.id = 'console-close';
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Fermer';

    row.append(input, send, close);
    c.appendChild(log);
    c.appendChild(row);
    document.body.appendChild(c);
    this.consoleEl = c;
    this.consoleLog = log;
    this.consoleInput = input;

    const submit = () => {
      const text = input.value.trim();
      input.value = '';
      if (text) this.runCommand(text);
      this.closeConsole();
    };
    send.addEventListener('click', (e) => { e.stopPropagation(); submit(); });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.closeConsole(); });

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') this.closeConsole();
    });

    // Le clavier virtuel rogne la fenêtre par le bas : on remonte la console
    // d'autant, sinon elle disparaît derrière.
    const vv = window.visualViewport;
    if (vv) {
      const fit = () => {
        const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        c.style.setProperty('--kb', `${Math.round(inset)}px`);
      };
      vv.addEventListener('resize', fit);
      vv.addEventListener('scroll', fit);
    }
  }

  private consoleOpen = false;

  private openConsole(prefix: string): void {
    this.consoleOpen = true;
    this.consoleEl.classList.add('open');
    this.consoleInput.value = prefix;
    this.input.exitLock();
    this.consoleInput.focus();
  }

  private closeConsole(): void {
    this.consoleOpen = false;
    this.consoleEl.classList.remove('open');
    this.consoleInput.blur();
    if (!this.paused && !this.screens.isOpen && !this.input.touchEnabled) this.input.requestLock();
  }

  private echo(text: string): void {
    const line = document.createElement('div');
    line.textContent = text;
    this.consoleLog.appendChild(line);
    while (this.consoleLog.childElementCount > 60) this.consoleLog.firstElementChild!.remove();
    this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
    this.hud.toast(text);
  }

  // --- Outils de construction (mode créatif) --------------------------------

  private sel1: Vector3 | null = null;
  private sel2: Vector3 | null = null;
  /** Pile d'annulation : quadruplets [x, y, z, ancien bloc]. */
  private undoStack: number[][] = [];
  /** Presse-papier : dimensions puis contenu, relatif au coin minimal. */
  private clipboard: { w: number; h: number; d: number; data: Uint8Array } | null = null;

  private static readonly MAX_REGION = 160000;

  private selectionBounds(): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; count: number } | null {
    if (!this.sel1 || !this.sel2) return null;
    const x0 = Math.min(this.sel1.x, this.sel2.x), x1 = Math.max(this.sel1.x, this.sel2.x);
    const y0 = Math.min(this.sel1.y, this.sel2.y), y1 = Math.max(this.sel1.y, this.sel2.y);
    const z0 = Math.min(this.sel1.z, this.sel2.z), z1 = Math.max(this.sel1.z, this.sel2.z);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    return { x0, y0, z0, x1, y1, z1, count };
  }

  /**
   * Applique une transformation à chaque voxel d'une région, en un seul lot :
   * écritures brutes, puis un unique recalcul de lumière par chunk touché.
   * Passer bloc par bloc par `setBlock` déclencherait une propagation de
   * lumière par bloc et prendrait des minutes sur une grande zone.
   */
  private editRegion(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    pick: (x: number, y: number, z: number, current: number) => number | null,
  ): number {
    const undo: number[] = [];
    const touched = new Set<string>();
    let changed = 0;
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= WORLD_HEIGHT) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const current = this.world.getBlock(x, y, z);
          if (current < 0) continue;
          const next = pick(x, y, z, current);
          if (next === null || next === current) continue;
          if (!this.world.setBlockRaw(x, y, z, next)) continue;
          undo.push(x, y, z, current);
          touched.add(chunkKey(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z)));
          changed++;
        }
      }
    }
    if (!changed) return 0;
    this.undoStack.push(undo);
    if (this.undoStack.length > 8) this.undoStack.shift();
    this.finishBulk(touched);
    return changed;
  }

  private finishBulk(touched: Set<string>): void {
    for (const key of touched) {
      const [cx, cz] = key.split(',').map(Number);
      this.world.relight(cx, cz);
      const c = this.world.chunks.get(key);
      if (c?.edits && this.save) this.save.storeEdits(cx, cz, c.edits);
    }
  }

  private resolveBlock(name: string | undefined): number | null {
    if (!name) return null;
    if (name === 'air' || name === 'vide') return 0;
    const b = BLOCK_BY_KEY.get(name);
    return b ? b.id : null;
  }

  /** Bloc actuellement visé, ou la position du joueur à défaut. */
  private aimedOrFeet(): Vector3 {
    if (this.lastHit) return new Vector3(this.lastHit.x, this.lastHit.y, this.lastHit.z);
    return new Vector3(
      Math.floor(this.player.position.x),
      Math.floor(this.player.position.y),
      Math.floor(this.player.position.z),
    );
  }

  runCommand(raw: string): void {
    const text = raw.startsWith('/') ? raw.slice(1) : raw;
    const parts = text.split(/\s+/);
    const cmd = (parts.shift() ?? '').toLowerCase();
    switch (cmd) {
      case 'gamemode':
      case 'gm': {
        const m = parts[0]?.toLowerCase();
        const mode = m === 'creatif' || m === 'creative' || m === '1' ? GameMode.Creative
          : m === 'spectateur' || m === 'spectator' || m === '2' ? GameMode.Spectator
            : GameMode.Survival;
        this.player.mode = mode;
        if (this.save) this.save.meta.mode = mode;
        this.echo(`Mode : ${mode === 1 ? 'créatif' : mode === 2 ? 'spectateur' : 'survie'}`);
        break;
      }
      case 'tp': {
        const [x, y, z] = parts.map(Number);
        if ([x, y, z].every((v) => Number.isFinite(v))) {
          this.player.position.set(x, y, z);
          this.player.velocity.set(0, 0, 0);
          this.echo(`Téléporté en ${x}, ${y}, ${z}`);
        } else this.echo('Usage : /tp x y z');
        break;
      }
      case 'time':
      case 'heure': {
        const a = parts[0]?.toLowerCase();
        if (a === 'jour' || a === 'day') this.dayTime = 0.5;
        else if (a === 'nuit' || a === 'night') this.dayTime = 0.0;
        else if (a === 'aube') this.dayTime = 0.26;
        else if (a === 'crepuscule') this.dayTime = 0.755;
        // Au-delà de 1, on comprend des heures : `/time 6` donne bien 6 h du
        // matin, ce qui est plus naturel qu'une fraction de journée.
        else if (Number.isFinite(Number(a))) {
          const n = Number(a);
          this.dayTime = mod(n > 1 ? n / 24 : n, 1);
        }
        const h = Math.floor(this.dayTime * 24);
        const min = Math.floor(((this.dayTime * 24) % 1) * 60);
        this.echo(`Heure : ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
        break;
      }
      case 'give': {
        const key = parts[0];
        const n = Number(parts[1] ?? 1) || 1;
        const def = ITEM_BY_KEY.get(key ?? '');
        if (!def) { this.echo(`Objet inconnu : ${key}`); break; }
        this.inventory.give(makeStack(def, n));
        this.hud.updateHotbar(this.inventory, true);
        this.echo(`${n} × ${def.name}`);
        break;
      }
      case 'meteo':
      case 'weather': {
        const a = parts[0]?.toLowerCase();
        this.rainTarget = a === 'pluie' || a === 'rain' ? 1 : 0;
        this.weatherTimer = 300;
        this.echo(this.rainTarget ? 'Il se met à pleuvoir.' : 'Le ciel se dégage.');
        break;
      }
      case 'seed':
      case 'graine':
        this.echo(`Graine : ${this.save?.meta.seed ?? 0}`);
        break;
      case 'tuer':
      case 'kill': {
        let n = 0;
        // Les engins pilotés sont épargnés : ce sont des biens du joueur, pas
        // des créatures qui repeuplent le monde toutes seules.
        for (const m of this.mobs) { if (m.def.aircraft) continue; m.dead = true; n++; }
        this.echo(`${n} créature(s) supprimée(s).`);
        break;
      }
      // --- Sélection et édition de région ---
      case 'pos1':
      case 'pos2': {
        const p = this.aimedOrFeet();
        if (cmd === 'pos1') this.sel1 = p;
        else this.sel2 = p;
        const b = this.selectionBounds();
        this.echo(`${cmd} en ${p.x}, ${p.y}, ${p.z}${b ? ` — ${b.count} blocs sélectionnés` : ''}`);
        break;
      }
      case 'sel': {
        const b = this.selectionBounds();
        if (!b) { this.sel1 = this.sel2 = null; this.echo('Sélection effacée.'); break; }
        this.echo(`Sélection : ${b.x1 - b.x0 + 1} × ${b.y1 - b.y0 + 1} × ${b.z1 - b.z0 + 1} = ${b.count} blocs`);
        break;
      }
      case 'fill':
      case 'remplir': {
        const b = this.selectionBounds();
        const id = this.resolveBlock(parts[0]);
        if (!b) { this.echo('Définissez d’abord /pos1 et /pos2.'); break; }
        if (id === null) { this.echo(`Bloc inconnu : ${parts[0]}`); break; }
        if (b.count > Game.MAX_REGION) { this.echo(`Trop grand : ${b.count} blocs (max ${Game.MAX_REGION}).`); break; }
        const n = this.editRegion(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, () => id);
        this.echo(`${n} bloc(s) remplacé(s).`);
        break;
      }
      case 'hollow':
      case 'coque': {
        const b = this.selectionBounds();
        const id = this.resolveBlock(parts[0]);
        if (!b || id === null) { this.echo('Usage : /coque <bloc>, après /pos1 et /pos2.'); break; }
        if (b.count > Game.MAX_REGION) { this.echo('Zone trop grande.'); break; }
        const n = this.editRegion(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, (x, y, z) =>
          (x === b.x0 || x === b.x1 || y === b.y0 || y === b.y1 || z === b.z0 || z === b.z1) ? id : null);
        this.echo(`Coque : ${n} bloc(s).`);
        break;
      }
      case 'replace':
      case 'remplacer': {
        const b = this.selectionBounds();
        const from = this.resolveBlock(parts[0]);
        const to = this.resolveBlock(parts[1]);
        if (!b || from === null || to === null) { this.echo('Usage : /remplacer <de> <vers>'); break; }
        if (b.count > Game.MAX_REGION) { this.echo('Zone trop grande.'); break; }
        const n = this.editRegion(b.x0, b.y0, b.z0, b.x1, b.y1, b.z1, (_x, _y, _z, cur) => (cur === from ? to : null));
        this.echo(`${n} bloc(s) remplacé(s).`);
        break;
      }
      case 'copy':
      case 'copier': {
        const b = this.selectionBounds();
        if (!b) { this.echo('Définissez d’abord /pos1 et /pos2.'); break; }
        if (b.count > Game.MAX_REGION) { this.echo('Zone trop grande.'); break; }
        const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, d = b.z1 - b.z0 + 1;
        const data = new Uint8Array(w * h * d);
        for (let y = 0; y < h; y++)
          for (let z = 0; z < d; z++)
            for (let x = 0; x < w; x++) {
              const v = this.world.getBlock(b.x0 + x, b.y0 + y, b.z0 + z);
              data[x + w * (z + d * y)] = v < 0 ? 0 : v;
            }
        this.clipboard = { w, h, d, data };
        this.echo(`Copié : ${w} × ${h} × ${d}.`);
        break;
      }
      case 'paste':
      case 'coller': {
        const cb = this.clipboard;
        if (!cb) { this.echo('Presse-papier vide — utilisez /copier.'); break; }
        const ox = Math.floor(this.player.position.x);
        const oy = Math.floor(this.player.position.y);
        const oz = Math.floor(this.player.position.z);
        const keepAir = parts[0] !== 'tout';
        const n = this.editRegion(ox, oy, oz, ox + cb.w - 1, oy + cb.h - 1, oz + cb.d - 1, (x, y, z) => {
          const v = cb.data[(x - ox) + cb.w * ((z - oz) + cb.d * (y - oy))];
          return keepAir && v === 0 ? null : v;
        });
        this.echo(`Collé : ${n} bloc(s). (« /coller tout » écrase aussi avec le vide.)`);
        break;
      }
      case 'undo':
      case 'annuler': {
        const last = this.undoStack.pop();
        if (!last) { this.echo('Rien à annuler.'); break; }
        const touched = new Set<string>();
        for (let i = 0; i < last.length; i += 4) {
          if (this.world.setBlockRaw(last[i], last[i + 1], last[i + 2], last[i + 3])) {
            touched.add(chunkKey(floorDiv(last[i], CHUNK_X), floorDiv(last[i + 2], CHUNK_Z)));
          }
        }
        this.finishBulk(touched);
        this.echo(`Annulé : ${last.length / 4} bloc(s).`);
        break;
      }
      // --- Règles du monde ---
      case 'figer':
      case 'freeze':
        this.timeFrozen = !this.timeFrozen;
        this.echo(this.timeFrozen ? 'Temps figé.' : 'Le temps reprend son cours.');
        break;
      // --- Dimensions ---
      case 'dim':
      case 'dimension': {
        const a = (parts[0] ?? '').toLowerCase();
        const to: Dimension | null =
          a === 'nether' ? 'nether'
            : a === 'end' ? 'end'
              : a === 'overworld' || a === 'monde' ? 'overworld'
                : null;
        if (!to) { this.echo(`Dimension courante : ${this.dimension}. Usage : /dimension <overworld|nether|end>`); break; }
        if (to === this.dimension) { this.echo('Vous y êtes déjà.'); break; }
        void this.travelTo(to);
        break;
      }
      case 'mobs': {
        const a = parts[0]?.toLowerCase();
        this.mobsEnabled = a === 'on' || a === 'oui' ? true : a === 'off' || a === 'non' ? false : !this.mobsEnabled;
        if (!this.mobsEnabled) for (const m of this.mobs) m.dead = true;
        this.echo(this.mobsEnabled ? 'Apparition des créatures activée.' : 'Créatures désactivées.');
        break;
      }
      case 'aide':
      case 'help':
        this.echo('Jeu : /gamemode /tp /time /give /meteo /seed /tuer /figer /mobs /dimension');
        this.echo('Construction : /pos1 /pos2 /sel /remplir /coque /remplacer /copier /coller /annuler');
        break;
      default:
        this.echo(`Commande inconnue : ${cmd}`);
    }
  }

  // --- Boucle -------------------------------------------------------------

  private loop = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > 0.25) dt = 0.25;

    this.frameTimes.push(dt);
    if (this.frameTimes.length > 40) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = 1 / Math.max(avg, 1e-4);

    if (this.sessionReady) this.update(dt);
    this.render();
    this.input.endFrame();
  };

  private update(dt: number): void {
    const active = !this.paused && !this.screens.isOpen;
    this.elapsed += dt;
    if (active) this.playtime += dt;

    // Regard.
    if (active && (this.input.state.lookX !== 0 || this.input.state.lookY !== 0)) {
      this.player.applyLook(this.input.state.lookX, this.input.state.lookY);
    }
    if (active) {
      const wheel = this.input.takeWheel();
      if (wheel !== 0) {
        this.inventory.selected = (this.inventory.selected + wheel + HOTBAR_SIZE) % HOTBAR_SIZE;
      }
    }

    // Attente du chargement initial du terrain sous le joueur.
    if (!this.worldReady) {
      this.chunks.setCenter(this.player.position.x, this.player.position.z);
      this.chunks.update();
      this.world.processLighting(60000);
      this.world.flushBorders();
      if (this.chunks.isReadyAt(this.player.position.x, this.player.position.z)) {
        if (this.arrivedFrom !== null) { this.buildArrivalPlatform(); this.arrivedFrom = null; }
        else if (this.worldType === 'oneblock') this.placeOnOneblock();
        else if (this.dimension === 'overworld') this.placePlayerOnGround();
        this.worldReady = true;
        // Les créatures de la dimension reviennent une fois le terrain là :
        // les faire naître dans du vide les ferait tomber à travers le monde.
        if (!this.entitiesRestored) {
          this.entitiesRestored = true;
          void this.restoreDimensionEntities();
        }
        this.setLoading(false, '');
        if (!this.input.touchEnabled) this.input.requestLock();
        else this.hud.enableTouch(this.touchHandlers());
      }
      return;
    }

    // Physique (pas fixe pour la stabilité).
    this.accumulator += active ? dt : 0;
    const step = 1 / 60;
    let guard = 0;
    while (this.accumulator >= step && guard++ < 6) {
      this.accumulator -= step;
      this.player.update(step, this.input.state, this.world, this.elapsed);
      this.handleStepSounds(step);
      this.guardVoid();
      this.updatePortals(step);
    }
    if (this.player.dead && this.screens.active !== 'death') {
      this.audio.hurt();
      this.screens.show('death');
    }

    // Temps, météo, ciel.
    if (active && !this.timeFrozen) this.dayTime = (this.dayTime + dt / DAY_LENGTH_SECONDS) % 1;
    this.updateWeather(dt, active);
    this.updateSky();

    // Monde.
    this.chunks.setCenter(this.player.position.x, this.player.position.z);
    this.chunks.update();
    this.world.processLighting(this.chunks.stats().pendingMesh > 0 ? 6000 : 14000);
    this.world.flushBorders();

    // Interaction.
    if (active) this.updateInteraction(dt);
    else { this.breakProgress = 0; this.outline.visible = false; this.breakOverlay.visible = false; }

    // Entités. La monture est replacée après elles : le cavalier suit sa
    // créature, jamais l'inverse.
    this.updateEntities(dt, active);
    if (active) this.updateMount(dt);
    this.updateBlockEntities(dt);
    if (this.settings.particles) this.particles.update(dt, this.skyState.dayFactor);

    this.updateLeashes();

    // Caméra et modèle porté.
    this.updateCamera(dt);
    this.updateHeldView(dt);

    // Interface.
    this.hud.tick(dt);
    this.hud.updateHotbar(this.inventory);
    this.hud.updateBars(
      this.player.stats.health, this.player.stats.maxHealth, this.player.stats.food,
      this.player.stats.breath, this.player.stats.maxBreath,
      this.player.mode === GameMode.Survival,
    );
    this.hud.setDamageVignette(this.player.lastDamage * 0.7);
    this.post.damage = this.player.lastDamage * 0.5;
    if (this.screens.isGameOverlay) this.screens.refreshAll();
    this.updateDebug();

    // Sauvegarde périodique.
    this.autosaveTimer += dt;
    if (this.autosaveTimer > AUTOSAVE_INTERVAL) {
      this.autosaveTimer = 0;
      void this.persist(false);
    }
  }

  /**
   * Équivalents tactiles de tous les raccourcis clavier. Sans clavier ni
   * souris, ces callbacks sont le seul accès à la console, à la pause, au
   * changement de vue et au reste.
   */
  private touchHandlers(): TouchHandlers {
    return {
      onJump: (v: boolean) => this.input.setVirtual('jump', v),
      onSneak: (v: boolean) => this.input.setVirtual('sneak', v),
      onAttack: (v: boolean) => this.input.setVirtual('attack', v),
      onUse: (v: boolean) => this.input.setVirtual('use', v),
      onSprint: (v: boolean) => this.input.setVirtual('sprint', v),
      onFly: () => {
        if (this.player.mode !== GameMode.Creative) return;
        this.player.flying = !this.player.flying;
        if (this.player.flying) this.player.velocity.y = 0;
      },
      onInventory: () => {
        if (this.paused) return;
        if (this.screens.isGameOverlay) this.closeScreen();
        else if (!this.screens.isOpen) this.openInventory('inventory');
      },
      onSelectSlot: (i: number) => {
        this.inventory.selected = i;
        this.hud.updateHotbar(this.inventory, true);
        this.audio.click();
      },
      onPause: () => {
        if (this.consoleOpen) { this.closeConsole(); return; }
        if (this.screens.isOpen) {
          if (this.screens.isGameOverlay) this.closeScreen();
          else if (this.screens.active === 'settings' || this.screens.active === 'help') this.screens.show(this.screens.previous);
          else if (this.screens.active === 'pause') this.closeScreen();
        } else if (!this.paused) {
          this.openPause();
        }
      },
      onConsole: () => {
        if (this.paused || this.screens.isOpen) return;
        if (this.consoleOpen) this.closeConsole();
        else this.openConsole('/');
      },
      onCamera: () => { this.player.cameraMode = (this.player.cameraMode + 1) % 3; },
      onDebug: () => {
        this.settings.showFps = !this.settings.showFps;
        saveSettings(this.settings);
      },
      onDrop: () => {
        if (this.paused || this.screens.isOpen) return;
        this.dropSelected();
      },
      onPick: () => {
        if (this.paused || this.screens.isOpen) return;
        if (this.lastHit) this.pickBlock(this.lastHit.block);
      },
    };
  }

  /**
   * Sommet du sol d'une colonne, en ignorant la végétation : on ne veut pas
   * faire apparaître le joueur au sommet d'un arbre.
   */
  private groundHeight(x: number, z: number): number {
    for (let y = WORLD_HEIGHT - 2; y > 1; y--) {
      const b = this.world.getBlock(x, y, z);
      if (b <= 0 || !IS_SOLID[b]) continue;
      const key = blockDef(b).key;
      if (key.endsWith('_leaves') || key.endsWith('_log') || key === 'cactus') continue;
      return y;
    }
    return -1;
  }

  /**
   * Mode « oneblock » : le joueur ne repart du bloc unique que s'il n'a
   * vraiment rien sous les pieds — sinon on respecte la plate-forme qu'il
   * s'est construite.
   */
  private placeOnOneblock(): void {
    this.spawnPoint.set(ONEBLOCK_X + 0.5, ONEBLOCK_Y + 1.02, ONEBLOCK_Z + 0.5);
    const px = Math.floor(this.player.position.x);
    const pz = Math.floor(this.player.position.z);
    for (let y = Math.floor(this.player.position.y); y > Math.floor(this.player.position.y) - 10 && y > 0; y--) {
      const b = this.world.getBlock(px, y, pz);
      if (b > 0 && IS_SOLID[b]) return;
    }
    this.player.position.copy(this.spawnPoint);
    this.player.velocity.set(0, 0, 0);
  }

  /** Cherche en spirale une colonne de terre ferme autour de la position. */
  private placePlayerOnGround(): void {
    const sx = Math.floor(this.player.position.x);
    const sz = Math.floor(this.player.position.z);
    for (let r = 0; r <= 20; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const x = sx + dx;
          const z = sz + dz;
          const y = this.groundHeight(x, z);
          if (y < 0 || y < SEA_LEVEL - 1) continue;
          const surface = blockDef(this.world.getBlock(x, y, z)).key;
          if (surface === 'water' || surface === 'lava') continue;
          if (this.world.getBlock(x, y + 1, z) !== 0 || this.world.getBlock(x, y + 2, z) !== 0) continue;
          this.player.position.set(x + 0.5, y + 1.02, z + 0.5);
          this.player.velocity.set(0, 0, 0);
          if (this.spawnPoint.lengthSq() < 1) this.spawnPoint.copy(this.player.position);
          return;
        }
      }
    }
    this.player.position.y = SEA_LEVEL + 2;
    if (this.spawnPoint.lengthSq() < 1) this.spawnPoint.copy(this.player.position);
  }

  private respawn(): void {
    this.player.respawn(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z);
    this.screens.show('none');
    this.paused = false;
    if (!this.input.touchEnabled) this.input.requestLock();
  }

  // --- Ciel et météo ------------------------------------------------------

  private updateSky(): void {
    const st = computeSkyState(this.dayTime, this.skyState);
    const e = this.env;
    e.uTime.value = this.elapsed;
    (e.uSunDir.value as Vector3).copy(st.sunDir);
    (e.uMoonDir.value as Vector3).copy(st.sunDir).multiplyScalar(-1);
    (e.uSunColor.value as Color).copy(st.sunColor);
    (e.uZenith.value as Color).copy(st.zenith);
    (e.uHorizon.value as Color).copy(st.horizon);
    (e.uSkyLight.value as Color).copy(st.skyLight);
    (e.uAmbient.value as Color).copy(st.ambient);
    e.uDayFactor.value = st.dayFactor;
    e.uStarStrength.value = st.starStrength;
    e.uCloudCover.value = this.settings.clouds ? 0.45 : 1.2;
    e.uRain.value = this.rainLevel;

    // Teinte du brouillard mélangée à celle du biome sous le joueur.
    const bx = Math.floor(this.player.position.x);
    const bz = Math.floor(this.player.position.z);
    const c = this.world.getChunk(floorDiv(bx, CHUNK_X), floorDiv(bz, CHUNK_Z));
    let fogTint = 0xc0d8ff;
    let fogScale = 1;
    if (c && c.state === ChunkState.Ready) {
      const bd = biomeDef(c.biomes[mod(bx, CHUNK_X) + mod(bz, CHUNK_Z) * CHUNK_X]);
      fogTint = bd.fogTint;
      fogScale = bd.fogDensity;
    }
    // `setHex` linéarise déjà : pas de conversion supplémentaire ici.
    tmpColor.setHex(fogTint);
    (e.uFogColor.value as Color).copy(st.fog).lerp(tmpColor, 0.45).multiplyScalar(0.35 + 0.65 * st.dayFactor);
    (e.uFogSky.value as Color).copy(st.horizon);

    // Distance de vue : le brouillard s'ouvre avec la distance de rendu.
    const far = this.settings.renderDistance * CHUNK_X;
    e.uFogDensity.value = (1.35 / Math.max(48, far)) * fogScale * (1 + this.rainLevel * 0.9);
    this.camera.far = far + 220;
    this.camera.updateProjectionMatrix();

    e.uUnderwater.value = this.player.submerged ? 1 : 0;
    (e.uCameraPos.value as Vector3).copy(this.camera.position);

    if (this.dimension !== 'overworld') this.applyDimensionSky(st);
  }

  /**
   * Le Nether et l'End n'ont ni soleil ni cycle : on écrase la lumière du ciel
   * par une ambiance fixe, rouge et étouffante d'un côté, froide et vide de
   * l'autre. Sans ça, on aurait un ciel bleu au plafond du Nether.
   */
  private applyDimensionSky(st: SkyState): void {
    const e = this.env;
    const nether = this.dimension === 'nether';
    // Le soleil vient d'en haut, sans azimut : pas d'ombres rasantes absurdes.
    (e.uSunDir.value as Vector3).set(0.35, 0.92, 0.18).normalize();
    (e.uSunColor.value as Color).setHex(nether ? 0x6a2a20 : 0x342a4a);
    (e.uZenith.value as Color).setHex(nether ? 0x1c0806 : 0x05040c);
    (e.uHorizon.value as Color).setHex(nether ? 0x50130e : 0x120c22);
    (e.uSkyLight.value as Color).setHex(nether ? 0x53231a : 0x2a2438);
    // Sans ciel, la lumière ambiante est le seul éclairage de fond : c'est elle
    // qui décide si la dimension est jouable ou noire. Les valeurs sont données
    // en sRGB et linéarisées par `setHex`, d'où des teintes qui paraissent
    // claires sur le papier.
    (e.uAmbient.value as Color).setHex(nether ? 0xc07a60 : 0x453e63);
    e.uDayFactor.value = 1;
    e.uStarStrength.value = nether ? 0 : 1;
    e.uRain.value = 0;
    (e.uFogColor.value as Color).setHex(nether ? 0x5c241c : 0x0a0812);
    (e.uFogSky.value as Color).setHex(nether ? 0x50130e : 0x120c22);
    // Brume beaucoup plus dense dans le Nether : l'horizon doit se fermer.
    const far = this.settings.renderDistance * CHUNK_X;
    // Une brume trop dense refermait l'horizon du Nether à une dizaine de
    // blocs : on n'y voyait plus la forteresse qu'on longeait.
    e.uFogDensity.value = (1.35 / Math.max(48, far)) * (nether ? 1.35 : 1.1);
    void st;
  }

  private updateWeather(dt: number, active: boolean): void {
    if (!active) return;
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      this.weatherTimer = 180 + Math.random() * 420;
      this.rainTarget = Math.random() < 0.28 ? 1 : 0;
    }
    if (!this.settings.weather) this.rainTarget = 0;
    this.rainLevel += (this.rainTarget - this.rainLevel) * Math.min(1, dt * 0.25);

    const bx = Math.floor(this.player.position.x);
    const bz = Math.floor(this.player.position.z);
    const c = this.world.getChunk(floorDiv(bx, CHUNK_X), floorDiv(bz, CHUNK_Z));
    const bd = c && c.state === ChunkState.Ready
      ? biomeDef(c.biomes[mod(bx, CHUNK_X) + mod(bz, CHUNK_Z) * CHUNK_X])
      : null;
    const snow = !!bd && bd.temperature < 0;
    const desert = !!bd && bd.temperature > 1.2;
    this.weather.update(this.elapsed, this.player.position, desert ? 0 : this.rainLevel, snow);
  }

  // --- Interaction --------------------------------------------------------

  private updateInteraction(dt: number): void {
    if (this.placeCooldown > 0) this.placeCooldown -= dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;

    const eye = this.player.eyePosition.clone();
    const dir = this.player.forward.clone().normalize();
    const reach = this.player.mode === GameMode.Creative ? REACH_CREATIVE : REACH_SURVIVAL;
    const hit = this.player.mode === GameMode.Spectator ? null : raycast(this.world, eye, dir, reach);
    this.lastHit = hit;

    // Contour.
    if (hit) {
      this.outline.visible = true;
      this.outline.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      this.outline.visible = false;
    }

    const st = this.input.state;

    // --- Prise du bloc visé (clic milieu) ---
    if (this.input.takePick() && hit) this.pickBlock(hit.block);

    // --- Attaque / minage ---
    if (st.attack) {
      const mob = this.pickMob(eye, dir, reach);
      this.lastAimedMob = mob ? mob.kind : null;
      if (mob && this.attackCooldown <= 0) {
        this.attackCooldown = 0.42;
        this.hitMob(mob);
        this.heldView.swing = 1;
        this.breakProgress = 0;
      } else if (this.mineLocked) {
        // Un bloc par appui : tant que le bouton n'est pas relâché, on ne
        // creuse plus. Sans ce verrou, le mode créatif cassait un bloc par
        // image et un simple appui ouvrait une tranchée.
        this.breakProgress = 0;
        this.breakKey = '';
        this.breakOverlay.visible = false;
      } else if (hit) {
        this.mineBlock(hit, dt);
      } else {
        this.breakProgress = 0;
        this.breakOverlay.visible = false;
        if (this.attackCooldown <= 0) { this.attackCooldown = 0.28; this.heldView.swing = 1; }
      }
    } else {
      this.mineLocked = false;
      this.breakProgress = 0;
      this.breakKey = '';
      this.breakOverlay.visible = false;
    }

    // --- Utilisation ---
    if (st.use && !this.useLocked && this.placeCooldown <= 0) {
      this.placeCooldown = 0.22;
      this.useItem(hit);
    } else if (!st.use) {
      this.useLocked = false;
    }
  }

  /**
   * Place le bloc visé dans la barre rapide. S'il s'y trouve déjà on s'y
   * positionne simplement ; sinon on le remonte depuis l'inventaire, et en
   * créatif on le crée de toutes pièces.
   */
  private pickBlock(blockId: number): void {
    const def = ITEM_OF_BLOCK.get(blockId);
    if (!def) return;
    const inv = this.inventory;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (inv.main.get(i)?.item === def) {
        inv.selected = i;
        this.hud.updateHotbar(inv, true);
        return;
      }
    }

    // Ailleurs dans le sac : on l'échange avec la case courante.
    for (let i = HOTBAR_SIZE; i < inv.main.size; i++) {
      if (inv.main.get(i)?.item !== def) continue;
      const current = inv.main.get(inv.selected);
      inv.main.set(inv.selected, inv.main.get(i));
      inv.main.set(i, current);
      this.hud.updateHotbar(inv, true);
      this.audio.click();
      return;
    }

    if (this.player.mode === GameMode.Creative) {
      inv.main.set(inv.selected, makeStack(def, def.maxStack));
      this.hud.updateHotbar(inv, true);
      this.audio.click();
    }
  }

  private mineBlock(hit: RaycastHit, dt: number): void {
    const key = `${hit.x},${hit.y},${hit.z}`;
    if (key !== this.breakKey) {
      this.breakKey = key;
      this.breakProgress = 0;
    }
    const def = blockDef(hit.block);
    const held = this.inventory.selectedItem;
    const info = breakInfo(hit.block, held);
    if (!Number.isFinite(info.time)) return;

    if (this.player.mode === GameMode.Creative) {
      this.destroyBlock(hit, true);
      this.breakProgress = 0;
      this.mineLocked = true;
      this.heldView.swing = 1;
      return;
    }

    this.breakProgress += dt / Math.max(0.05, info.time);
    this.heldView.swing = Math.max(this.heldView.swing, 0.6);
    if (this.rnd() < dt * 8) {
      this.audio.dig(def.sound as SoundGroup, 0.35);
      if (this.settings.particles) {
        this.particles.burstBlock(hit.x, hit.y, hit.z, this.atlas.tileAverage(def.layers.side), 2);
      }
    }

    this.breakOverlay.visible = true;
    this.breakOverlay.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    (this.breakOverlay.material as MeshBasicMaterial).opacity = Math.min(0.72, this.breakProgress * 0.72);

    if (this.breakProgress >= 1) {
      this.destroyBlock(hit, info.harvest);
      this.breakProgress = 0;
      this.mineLocked = true;
      this.breakOverlay.visible = false;
    }
  }

  private destroyBlock(hit: RaycastHit, harvest: boolean): void {
    const def = blockDef(hit.block);
    const creative = this.player.mode === GameMode.Creative;
    this.setBlock(hit.x, hit.y, hit.z, 0);
    // Porte et lit tiennent sur deux cases : casser l'une emporte l'autre.
    this.breakPairedHalf(hit.x, hit.y, hit.z, def.key);
    this.audio.break(def.sound as SoundGroup);
    if (this.settings.particles) {
      this.particles.burstBlock(hit.x, hit.y, hit.z, this.atlas.tileAverage(def.layers.side), 16);
    }
    if (!creative) {
      for (const d of blockDrops(hit.block, harvest, () => this.rnd())) {
        this.spawnDrop(hit.x + 0.5, hit.y + 0.25, hit.z + 0.5, makeStack(d.item, d.count));
      }
      // Un chêne finit par donner : son feuillage lâche parfois une pomme.
      if (def.key === 'oak_leaves' && this.rnd() < 0.06) {
        const pomme = ITEM_BY_KEY.get('apple');
        if (pomme) this.spawnDrop(hit.x + 0.5, hit.y + 0.25, hit.z + 0.5, makeStack(pomme, 1));
      }
      const held = this.inventory.selectedStack;
      if (held?.item.tool) {
        if (this.inventory.damageSelected(1)) this.audio.break('wood');
      }
      this.player.addXp(def.hardness > 2.5 ? 2 : 0);
    }
    // Support des blocs posés dessus (fleurs, torches, neige) et à côté (échelles).
    this.dropUnsupported(hit.x, hit.y + 1, hit.z);
    this.dropLadders(hit.x, hit.y, hit.z);
    this.untieFrom(hit.x, hit.y, hit.z, creative);
    this.stirWater(hit.x, hit.y, hit.z);
    this.applyGravityBlocks(hit.x, hit.y + 1, hit.z);
    // Un coffre/four détruit rend son contenu.
    const bkey = `${hit.x},${hit.y},${hit.z}`;
    const be = this.blockEntities.get(bkey);
    if (be) {
      const containers = be instanceof Container ? [be] : [be.input, be.fuel, be.output];
      for (const c of containers) {
        for (let i = 0; i < c.size; i++) {
          const s = c.get(i);
          if (s) this.spawnDrop(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, s);
        }
      }
      this.blockEntities.delete(bkey);
    }
    // Le bloc unique repousse aussitôt : c'est tout le principe du mode.
    if (this.worldType === 'oneblock' && hit.x === ONEBLOCK_X && hit.y === ONEBLOCK_Y && hit.z === ONEBLOCK_Z) {
      this.oneblockAdvance();
    }
    if (def.key === 'lucky_block') this.rollLuckyBlock(hit.x, hit.y, hit.z);
  }

  /**
   * Tire au sort ce que rend un lucky bloc. Le tirage est fait ici et non dans
   * une table de butin, parce que la moitié des issues ne sont pas des objets :
   * une volée de créatures ou une explosion ne se rangent pas dans un coffre.
   */
  private rollLuckyBlock(x: number, y: number, z: number): void {
    const r = this.rnd();
    const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
    const donne = (key: string, n: number): void => {
      const def = ITEM_BY_KEY.get(key);
      if (def) this.spawnDrop(cx, cy, cz, makeStack(def, n));
    };

    if (r < 0.16) {
      // Jackpot.
      donne('diamond', 3 + Math.floor(this.rnd() * 5));
      donne('golden_apple', 1);
      this.hud.toast('Jackpot !');
    } else if (r < 0.34) {
      donne('gold_ingot', 4 + Math.floor(this.rnd() * 8));
      donne('emerald', 1 + Math.floor(this.rnd() * 3));
      this.hud.toast('Un joli magot.');
    } else if (r < 0.5) {
      const outils = ['diamond_pickaxe', 'diamond_sword', 'iron_chestplate', 'diamond_helmet'];
      donne(outils[Math.floor(this.rnd() * outils.length)], 1);
      this.hud.toast('De l’équipement !');
    } else if (r < 0.62) {
      donne('cooked_beef', 5 + Math.floor(this.rnd() * 6));
      donne('golden_carrot', 2);
      this.hud.toast('De quoi tenir un moment.');
    } else if (r < 0.74) {
      // Une tour de blocs de construction, en vrac.
      for (const k of ['oak_planks', 'cobblestone', 'glass', 'torch']) donne(k, 16 + Math.floor(this.rnd() * 32));
      this.hud.toast('Des matériaux plein les bras.');
    } else if (r < 0.86) {
      // Comité d'accueil.
      const kinds: MobKind[] = this.rnd() < 0.5 ? ['zombie', 'skeleton'] : ['creeper', 'spider'];
      for (let i = 0; i < 3; i++) {
        const k = kinds[Math.floor(this.rnd() * kinds.length)];
        this.addMob(k, cx + (this.rnd() - 0.5) * 3, y + 1, cz + (this.rnd() - 0.5) * 3);
      }
      this.hud.toast('Mauvaise pioche : des monstres !');
    } else if (r < 0.94) {
      // Un cheval, une vache : la bonne surprise vivante.
      const k: MobKind = this.rnd() < 0.5 ? 'horse' : 'cow';
      this.addMob(k, cx, y + 1, cz);
      this.hud.toast('Une créature en sort !');
    } else {
      this.explode(cx, cy, cz, 2.6);
      this.hud.toast('Aïe.');
    }
  }

  private dropUnsupported(x: number, y: number, z: number): void {
    const above = this.world.getBlock(x, y, z);
    if (above <= 0) return;
    const d = blockDef(above);
    if (d.render === RenderKind.Cross || d.key === 'snow_block') {
      this.setBlock(x, y, z, 0);
      if (this.player.mode !== GameMode.Creative) {
        for (const drop of blockDrops(above, true, () => this.rnd())) {
          this.spawnDrop(x + 0.5, y + 0.25, z + 0.5, makeStack(drop.item, drop.count));
        }
      }
      this.dropUnsupported(x, y + 1, z);
    }
  }

  /**
   * Répand l'eau depuis une case. Elle cherche le bas d'abord — une colonne qui
   * tombe ne s'étale pas —, puis s'élargit jusqu'à sa portée. Toute lave
   * touchée se fige en obsidienne.
   */
  private spreadWater(sx: number, sy: number, sz: number): void {
    const file: [number, number, number, number][] = [[sx, sy, sz, 0]];
    const vus = new Set<string>([`${sx},${sy},${sz}`]);
    let pose = 0;

    /** La case peut-elle recevoir de l'eau ? */
    const libre = (x: number, y: number, z: number): boolean => {
      const b = this.world.getBlock(x, y, z);
      if (b < 0 || b === B.water) return false;
      return b === 0 || blockDef(b).replaceable;
    };
    const empiler = (x: number, y: number, z: number, d: number): void => {
      const k = `${x},${y},${z}`;
      if (vus.has(k)) return;
      vus.add(k);
      file.push([x, y, z, d]);
    };

    while (file.length > 0 && pose < FLOW_BUDGET) {
      const [x, y, z, d] = file.shift()!;

      // Vers le bas d'abord.
      if (y > 1) {
        const sous = this.world.getBlock(x, y - 1, z);
        if (sous === B.lava) {
          this.setBlock(x, y - 1, z, B.obsidian);
          continue;
        }
        if (libre(x, y - 1, z)) {
          this.setBlock(x, y - 1, z, B.water);
          pose++;
          // La chute ne consomme pas la portée : en bas, la nappe repart entière.
          empiler(x, y - 1, z, 0);
          continue;
        }
      }

      if (d >= FLOW_REACH) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, nz = z + dz;
        if (this.world.getBlock(nx, y, nz) === B.lava) {
          this.setBlock(nx, y, nz, B.obsidian);
          continue;
        }
        if (!libre(nx, y, nz)) continue;
        this.setBlock(nx, y, nz, B.water);
        pose++;
        empiler(nx, y, nz, d + 1);
        if (pose >= FLOW_BUDGET) break;
      }
    }
  }

  /**
   * Relance les coulées autour d'une case qu'on vient de vider : creuser un
   * canal au bord d'une mare doit y faire entrer l'eau.
   */
  private stirWater(x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of NEIGHBOURS) {
      if (dy < 0) continue; // l'eau ne remonte pas
      if (this.world.getBlock(x + dx, y + dy, z + dz) !== B.water) continue;
      this.spreadWater(x + dx, y + dy, z + dz);
    }
  }

  /** Fait tomber sable et gravier laissés sans appui (résolu instantanément). */
  private applyGravityBlocks(x: number, y: number, z: number): void {
    for (let yy = y; yy < WORLD_HEIGHT - 1; yy++) {
      const id = this.world.getBlock(x, yy, z);
      if (id <= 0) break;
      if (!blockDef(id).gravity) break;
      let target = yy;
      while (target > 0 && this.world.getBlock(x, target - 1, z) === 0) target--;
      if (target === yy) break;
      this.setBlock(x, yy, z, 0);
      this.setBlock(x, target, z, id);
      if (this.settings.particles) {
        this.particles.puff(x + 0.5, target, z + 0.5, this.atlas.tileAverage(blockDef(id).layers.top), 4);
      }
    }
  }

  private useItem(hit: RaycastHit | null): void {
    const stackHeld = this.inventory.selectedStack;

    // Monter une créature montable visée : ça passe avant tout le reste, sinon
    // on poserait un bloc dans le cheval. Une laisse en main dit le contraire :
    // on veut attacher la bête, pas l'enfourcher.
    if (!this.mount && stackHeld?.item.key !== 'lead') {
      const eye = this.player.eyePosition.clone();
      const dir = this.player.forward.clone().normalize();
      const aimed = this.pickMob(eye, dir, REACH_SURVIVAL);
      if (aimed?.def.rideable) { this.useLocked = true; this.mountMob(aimed); return; }
    }

    // Interaction avec un bloc « conteneur ».
    if (hit && !this.player.sneaking) {
      const key = blockDef(hit.block).key;
      this.useLocked = true;
      if (key === 'crafting_table') { this.openInventory('crafting'); return; }
      if (key === 'furnace') { this.openContainer(hit, 'furnace'); return; }
      if (key === 'chest') { this.openContainer(hit, 'chest'); return; }
      // Sertir un œil de l'Ender dans un cadre de portail.
      if (key === 'end_portal_frame' && this.fillPortalFrame(hit.x, hit.y, hit.z)) return;
      if (key.startsWith('oak_door_')) { this.toggleDoor(hit.x, hit.y, hit.z); this.heldView.swing = 1; return; }
      if (key.startsWith('oak_fence_gate_')) { this.toggleGate(hit.x, hit.y, hit.z); this.heldView.swing = 1; return; }
      if (key.startsWith('red_bed_')) { this.sleep(hit.x, hit.y, hit.z); return; }
      if (key.startsWith('oak_trapdoor_')) { this.toggleTrapdoor(hit.x, hit.y, hit.z); this.heldView.swing = 1; return; }
      // Aucune de ces interactions n'a eu lieu : l'appui reste disponible pour
      // poser un bloc, geste qui, lui, se répète.
      this.useLocked = false;
    }

    // Le briquet allume un cadre d'obsidienne : c'est la porte du Nether.
    if (hit && stackHeld?.item.key === 'flint_and_steel') {
      const tx = hit.x + hit.nx, ty = hit.y + hit.ny, tz = hit.z + hit.nz;
      if (this.ignitePortal(tx, ty, tz)) {
        this.heldView.swing = 1;
        if (this.player.mode !== GameMode.Creative && this.inventory.damageSelected(1)) this.audio.break('metal');
        return;
      }
      this.hud.toast('Il faut un cadre d’obsidienne fermé.');
      this.heldView.swing = 1;
      return;
    }

    if (!stackHeld) return;
    const item = stackHeld.item;

    // Laisse : on attrape la bête visée, ou on relâche celle qu'on tient.
    if (item.key === 'lead') {
      this.useLocked = true;
      // La barrière passe avant la bête : une vache qui suit son maître se
      // trouve souvent entre lui et le piquet, et on relâcherait ce qu'on
      // voulait justement attacher.
      if (hit && blockDef(hit.block).key.startsWith('oak_fence')) {
        let n = 0;
        for (const m of this.mobs) {
          if (!m.leashed) continue;
          m.leashed = false;
          m.leashPost = { x: hit.x, y: hit.y, z: hit.z };
          n++;
        }
        if (n > 0) {
          this.hud.toast(n === 1 ? 'Attachée à la barrière.' : `${n} bêtes attachées à la barrière.`);
          this.audio.place('wood');
          this.heldView.swing = 1;
          return;
        }
      }
      const eye = this.player.eyePosition.clone();
      const dir = this.player.forward.clone().normalize();
      const cible = this.pickMob(eye, dir, REACH_SURVIVAL);
      if (cible && !cible.def.hostile && !cible.def.aircraft) {
        if (cible.leashed || cible.leashPost) {
          cible.leashed = false;
          cible.leashPost = null;
          this.hud.toast('Bête relâchée.');
        } else {
          cible.leashed = true;
          this.hud.toast('Au bout de la laisse.');
        }
        this.audio.click();
        this.heldView.swing = 1;
        return;
      }
    }

    // L'avion n'est pas un bloc : il apparaît devant soi, prêt à décoller.
    if (item.key === 'plane' && hit) {
      this.useLocked = true;
      this.addMob('plane', hit.x + hit.nx + 0.5, hit.y + hit.ny, hit.z + hit.nz + 0.5);
      this.audio.click();
      this.heldView.swing = 1;
      if (this.player.mode !== GameMode.Creative) this.inventory.main.consume(this.inventory.selected);
      this.hud.toast('Clic droit pour monter à bord.');
      return;
    }

    // Seaux : puiser, verser, et figer la lave en obsidienne.
    if (item.key === 'bucket' || item.key === 'water_bucket' || item.key === 'lava_bucket') {
      if (this.useBucket(item.key, hit)) { this.useLocked = true; return; }
    }

    // Nourriture.
    // Les dorures se mangent même le ventre plein : on les garde pour se
    // soigner, pas pour se nourrir.
    const dorure = item.key === 'golden_apple' ? 8 : item.key === 'golden_carrot' ? 4 : 0;
    if (item.food && this.player.mode === GameMode.Survival && (this.player.stats.food < 20 || dorure > 0)) {
      this.player.eat(item.food.hunger, item.food.saturation);
      if (dorure > 0) {
        const st = this.player.stats;
        st.health = Math.min(st.maxHealth, st.health + dorure);
        this.hud.toast(item.key === 'golden_apple' ? 'La pomme dorée te remet d’aplomb.' : 'La carotte dorée te ravigote.');
      }
      this.inventory.main.consume(this.inventory.selected);
      this.audio.eat();
      this.heldView.swing = 1;
      return;
    }

    // Armure : équipement rapide.
    if (item.armor) {
      const slot = item.armor.slot;
      const prev = this.inventory.armor.get(slot);
      this.inventory.armor.set(slot, { item, count: 1, damage: stackHeld.damage });
      this.inventory.main.set(this.inventory.selected, prev);
      this.audio.click();
      return;
    }

    // Pose de bloc.
    if (!item.block || !hit) return;
    const nx = hit.x + hit.nx;
    const ny = hit.y + hit.ny;
    const nz = hit.z + hit.nz;
    if (ny < 0 || ny >= WORLD_HEIGHT) return;
    const target = this.world.getBlock(nx, ny, nz);
    if (target < 0) return;
    if (target !== 0 && !blockDef(target).replaceable) return;
    if (this.blocksPlayer(nx, ny, nz, item.block)) return;

    // Porte et lit occupent deux cellules : leur pose a ses propres règles.
    if (item.key === 'oak_door') { this.placeDoor(nx, ny, nz); return; }
    if (item.key === 'red_bed') { this.placeBed(nx, ny, nz); return; }
    if (item.key === 'ladder') { this.placeLadder(nx, ny, nz, hit); return; }

    // Une dalle se pose en bas ou en haut du voxel selon l'endroit visé.
    let placeId = item.block;
    const placeDef = blockDef(placeId);
    if (placeDef.key.endsWith('_slab')) {
      const frac = hit.point.y - Math.floor(hit.point.y);
      const upper = hit.ny < 0 || (hit.ny === 0 && frac > 0.5);
      if (upper) placeId = BLOCK_BY_KEY.get(`${placeDef.key}_top`)?.id ?? placeId;
    }

    // Un escalier se tourne selon le regard : la marche haute est du côté où
    // l'on regarde, de sorte qu'on gravit dans le sens où l'on avance.
    if (placeDef.key.endsWith('_stairs_north')) {
      const base = placeDef.key.slice(0, -'_north'.length);
      placeId = BLOCK_BY_KEY.get(`${base}_${this.viewFacing()}`)?.id ?? placeId;
    }

    // Le portillon barre le passage : son battant se met en travers du regard,
    // ce que donne directement l'orientation de la vue.
    if (placeDef.key === 'oak_fence_gate_north_closed') {
      placeId = BLOCK_BY_KEY.get(`oak_fence_gate_${this.viewFacing()}_closed`)?.id ?? placeId;
    }

    this.setBlock(nx, ny, nz, placeId);
    this.audio.place(blockDef(placeId).sound as SoundGroup);
    this.heldView.swing = 1;
    if (this.player.mode !== GameMode.Creative) this.inventory.main.consume(this.inventory.selected);
    this.applyGravityBlocks(nx, ny, nz);
  }

  // --- Monture -------------------------------------------------------------

  private mountMob(m: Mob): void {
    this.mount = m;
    m.ridden = true;
    this.player.riding = true;
    this.player.velocity.set(0, 0, 0);
    // Le même appui ne doit pas enchaîner sur l'usage de l'objet tenu : sans
    // ce délai, monter en tenant un seau vidait le seau sous la monture.
    this.placeCooldown = 0.6;
    this.hud.toast('En selle. Accroupis-toi pour descendre.');
    this.audio.click();
  }

  private dismount(): void {
    const m = this.mount;
    if (!m) return;
    this.hud.setAirspeed(null);
    m.ridden = false;
    m.driveX = 0;
    m.driveZ = 0;
    m.driveJump = false;
    this.mount = null;
    this.player.riding = false;
    // On descend sur le côté, jamais dans la monture.
    this.player.position.set(m.position.x + m.def.width + 0.2, m.position.y + 0.4, m.position.z);
    this.player.velocity.set(0, 0, 0);
  }

  /**
   * Transmet les commandes du cavalier à sa monture et l'y assoit. Le joueur
   * n'a plus de physique propre tant qu'il est en selle : il suit la créature.
   */
  private updateMount(dt: number): void {
    const m = this.mount;
    if (!m) return;
    if (m.dead || this.player.dead || this.player.mode === GameMode.Spectator) { this.dismount(); return; }

    const st = this.input.state;

    // Un avion se pilote au regard : cap et assiette viennent de la caméra, et
    // seules la poussée et le frein restent au clavier. On n'en descend qu'une
    // fois posé — sauter en marche n'est pas une commande, c'est un accident.
    if (m.def.aircraft) {
      // Au tactile, le pouce droit reste sur les gaz : il ne peut plus balayer
      // l'écran pour viser. Le manche gauche, inutile en vol, devient donc la
      // commande de pilotage — pousser en haut lève le nez.
      if (st.moveX !== 0 || st.moveY !== 0) {
        this.player.applyLook(st.moveX * PLANE_STICK * dt, st.moveY * PLANE_STICK * dt);
      }
      m.driveYaw = this.player.yaw;
      m.drivePitch = this.player.pitch;
      m.driveJump = st.jump;
      m.driveBrake = st.sneak;
      if (st.sneak && m.onGround && m.airspeed < 1) { this.dismount(); return; }
      const seat = m.position.y + m.def.height * 0.62;
      this.player.position.x = m.position.x;
      this.player.position.z = m.position.z;
      this.player.position.y += (seat - this.player.position.y) * Math.min(1, 18 * dt);
      this.player.velocity.set(0, 0, 0);
      this.player.onGround = m.onGround;
      this.hud.setAirspeed(m.airspeed, PLANE_STALL_SPEED);
      return;
    }

    if (st.sneak) { this.dismount(); return; }

    // Le repère est celui du joueur : « avant » vaut (-sin yaw, -cos yaw).
    const ix = (st.right ? 1 : 0) - (st.left ? 1 : 0) + st.moveX;
    const iz = (st.back ? 1 : 0) - (st.forward ? 1 : 0) + st.moveY;
    const sin = Math.sin(this.player.yaw);
    const cos = Math.cos(this.player.yaw);
    let dx = ix * cos + iz * sin;
    let dz = iz * cos - ix * sin;
    const mag = Math.hypot(dx, dz);
    if (mag > 1) { dx /= mag; dz /= mag; }
    m.driveX = dx;
    m.driveZ = dz;
    m.driveJump = st.jump;

    // Le joueur est assis sur le dos : à l'aplomb de la créature, à sa hauteur
    // de garrot. `dt` sert à lisser la descente de selle sur les terrains bosselés.
    const seat = m.position.y + m.def.height * 0.62;
    this.player.position.x = m.position.x;
    this.player.position.z = m.position.z;
    this.player.position.y += (seat - this.player.position.y) * Math.min(1, 18 * dt);
    this.player.velocity.set(0, 0, 0);
    this.player.onGround = m.onGround;
  }

  // --- Seaux ---------------------------------------------------------------

  /**
   * Puise ou verse un fluide. Verser de l'eau sur de la lave la fige en
   * obsidienne : c'est la route vers le portail du Nether quand on n'a pas
   * trouvé de portail englouti.
   *
   * @returns vrai si le seau a servi (auquel cas rien d'autre ne doit suivre).
   */
  private useBucket(key: string, aimed: RaycastHit | null): boolean {
    // Le rayon d'interaction ordinaire ignore les fluides — c'est ce qui évite
    // de « cliquer sur de l'eau » en construisant. Un seau, lui, ne vise que ça :
    // il lui faut sa propre visée, sans quoi il ne peut jamais être rempli.
    const eye = this.player.eyePosition.clone();
    const dir = this.player.forward.clone().normalize();
    const reach = this.player.mode === GameMode.Creative ? REACH_CREATIVE : REACH_SURVIVAL;
    const hit = raycast(this.world, eye, dir, reach, true) ?? aimed;
    if (!hit) return false;
    const creative = this.player.mode === GameMode.Creative;
    const swap = (to: string): void => {
      if (creative) return;
      const def = ITEM_BY_KEY.get(to);
      this.inventory.main.set(this.inventory.selected, def ? makeStack(def, 1) : null);
    };
    this.heldView.swing = 1;

    if (key === 'bucket') {
      if (hit.block !== B.water && hit.block !== B.lava) return false;
      this.setBlock(hit.x, hit.y, hit.z, 0);
      swap(hit.block === B.water ? 'water_bucket' : 'lava_bucket');
      this.audio.place('liquid');
      return true;
    }

    // L'eau versée directement sur la lave la refroidit sur place.
    if (key === 'water_bucket' && hit.block === B.lava) {
      this.setBlock(hit.x, hit.y, hit.z, B.obsidian);
      swap('bucket');
      this.audio.break('stone');
      this.hud.toast('La lave se fige en obsidienne.');
      return true;
    }

    const tx = hit.x + hit.nx, ty = hit.y + hit.ny, tz = hit.z + hit.nz;
    if (ty < 0 || ty >= WORLD_HEIGHT) return false;
    const at = this.world.getBlock(tx, ty, tz);
    if (at < 0 || (at !== 0 && !blockDef(at).replaceable)) return false;
    // Verser de l'eau contre de la lave la fige aussi : c'est le geste naturel
    // quand on se tient au bord d'un lac.
    if (key === 'water_bucket') {
      for (const [dx, dy, dz] of NEIGHBOURS) {
        if (this.world.getBlock(tx + dx, ty + dy, tz + dz) !== B.lava) continue;
        this.setBlock(tx + dx, ty + dy, tz + dz, B.obsidian);
        swap('bucket');
        this.audio.break('stone');
        this.hud.toast('La lave se fige en obsidienne.');
        return true;
      }
    }
    this.setBlock(tx, ty, tz, key === 'water_bucket' ? B.water : B.lava);
    if (key === 'water_bucket') this.spreadWater(tx, ty, tz);
    swap('bucket');
    this.audio.place('liquid');
    return true;
  }

  // --- Menuiserie : porte, portillon, lit ----------------------------------

  /** Orientation cardinale du regard, dans la convention des blocs orientés. */
  private viewFacing(): Facing {
    const f = this.player.forward;
    return Math.abs(f.x) > Math.abs(f.z) ? (f.x > 0 ? 'east' : 'west') : (f.z > 0 ? 'south' : 'north');
  }

  /** Décalage d'une case dans la direction donnée. */
  private static readonly STEP: Record<Facing, [number, number]> = {
    north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0],
  };

  /**
   * Une porte tient sur deux cases empilées : sans la place au-dessus, on ne
   * pose rien plutôt que de laisser une demi-porte.
   */
  private placeDoor(x: number, y: number, z: number): void {
    const above = this.world.getBlock(x, y + 1, z);
    if (above !== 0 && !(above > 0 && blockDef(above).replaceable)) {
      this.hud.toast('Il faut deux blocs de haut pour une porte.');
      return;
    }
    if (this.blocksPlayer(x, y + 1, z, 1)) return;
    const facing = this.viewFacing();
    const lower = BLOCK_BY_KEY.get(`oak_door_${facing}_lower_closed`)!.id;
    const upper = BLOCK_BY_KEY.get(`oak_door_${facing}_upper_closed`)!.id;
    this.setBlock(x, y, z, lower);
    this.setBlock(x, y + 1, z, upper);
    this.audio.place('wood');
    this.heldView.swing = 1;
    if (this.player.mode !== GameMode.Creative) this.inventory.main.consume(this.inventory.selected);
  }

  /** Un lit s'étend sur deux cases au sol, la tête devant le joueur. */
  private placeBed(x: number, y: number, z: number): void {
    const facing = this.viewFacing();
    const [dx, dz] = Game.STEP[facing];
    const hx = x + dx, hz = z + dz;
    const head = this.world.getBlock(hx, y, hz);
    if (head < 0 || (head !== 0 && !blockDef(head).replaceable)) {
      this.hud.toast('Il faut deux cases libres pour un lit.');
      return;
    }
    if (!IS_SOLID[this.world.getBlock(x, y - 1, z)] || !IS_SOLID[this.world.getBlock(hx, y - 1, hz)]) {
      this.hud.toast('Le lit doit reposer sur un sol plein.');
      return;
    }
    this.setBlock(x, y, z, BLOCK_BY_KEY.get(`red_bed_${facing}_foot`)!.id);
    this.setBlock(hx, y, hz, BLOCK_BY_KEY.get(`red_bed_${facing}_head`)!.id);
    this.audio.place('wool');
    this.heldView.swing = 1;
    if (this.player.mode !== GameMode.Creative) this.inventory.main.consume(this.inventory.selected);
  }

  /**
   * Une échelle se plaque contre le mur qu'on a visé. Viser le sol ou le
   * plafond ne dit rien du mur porteur : on cherche alors un appui autour,
   * en commençant par le côté opposé au regard.
   */
  private placeLadder(x: number, y: number, z: number, hit: RaycastHit): void {
    const from = (dx: number, dz: number): Facing | null =>
      dz < 0 ? 'north' : dz > 0 ? 'south' : dx < 0 ? 'west' : dx > 0 ? 'east' : null;

    // Le mur est du côté d'où vient la normale de la face visée.
    let facing = from(-hit.nx, -hit.nz);
    if (!facing) {
      const view = this.viewFacing();
      const order: Facing[] = [view, 'north', 'south', 'west', 'east'];
      for (const f of order) {
        const [dx, dz] = Game.STEP[f];
        if (IS_SOLID[this.world.getBlock(x + dx, y, z + dz)]) { facing = f; break; }
      }
    }
    if (!facing) {
      this.hud.toast('Une échelle a besoin d’un mur.');
      return;
    }
    const [dx, dz] = Game.STEP[facing];
    if (!IS_SOLID[this.world.getBlock(x + dx, y, z + dz)]) {
      this.hud.toast('Une échelle a besoin d’un mur.');
      return;
    }
    this.setBlock(x, y, z, BLOCK_BY_KEY.get(`ladder_${facing}`)!.id);
    this.audio.place('wood');
    this.heldView.swing = 1;
    if (this.player.mode !== GameMode.Creative) this.inventory.main.consume(this.inventory.selected);
  }

  /**
   * Fait tomber les échelles qui s'appuyaient sur le bloc qu'on vient de
   * casser. Sans ça elles resteraient collées au vide.
   */
  private dropLadders(x: number, y: number, z: number): void {
    for (const f of FACINGS) {
      const [dx, dz] = Game.STEP[f];
      // Une échelle en (x-dx, y, z-dz) tournée vers `f` s'appuie sur (x,y,z).
      const lx = x - dx, lz = z - dz;
      const id = this.world.getBlock(lx, y, lz);
      if (id <= 0 || blockDef(id).key !== `ladder_${f}`) continue;
      this.setBlock(lx, y, lz, 0);
      if (this.player.mode !== GameMode.Creative) {
        for (const d of blockDrops(id, true, () => this.rnd())) {
          this.spawnDrop(lx + 0.5, y + 0.5, lz + 0.5, makeStack(d.item, d.count));
        }
      }
    }
  }

  /**
   * Ouvre ou ferme une porte. Les deux moitiés basculent ensemble : elles se
   * distinguent par leur texture, pas par leur état.
   */
  private toggleDoor(x: number, y: number, z: number): void {
    const key = blockDef(this.world.getBlock(x, y, z)).key;
    const m = /^oak_door_(\w+?)_(lower|upper)_(closed|open)$/.exec(key);
    if (!m) return;
    const [, facing, half, state] = m;
    const next = state === 'closed' ? 'open' : 'closed';
    const other = half === 'lower' ? y + 1 : y - 1;
    this.setBlock(x, y, z, BLOCK_BY_KEY.get(`oak_door_${facing}_${half}_${next}`)!.id);
    const otherKey = blockDef(this.world.getBlock(x, other, z)).key;
    if (otherKey.startsWith('oak_door_')) {
      const otherHalf = half === 'lower' ? 'upper' : 'lower';
      this.setBlock(x, other, z, BLOCK_BY_KEY.get(`oak_door_${facing}_${otherHalf}_${next}`)!.id);
    }
    this.audio.place('wood');
  }

  /**
   * Bascule une trappe. Ouverte, elle se rabat contre le côté qu'on regarde ;
   * fermée, elle redevient un plancher — et l'orientation, qu'on ne voit plus,
   * n'est pas conservée.
   */
  private toggleTrapdoor(x: number, y: number, z: number): void {
    const key = blockDef(this.world.getBlock(x, y, z)).key;
    const ouverte = key.startsWith('oak_trapdoor_open_');
    const id = ouverte
      ? BLOCK_BY_KEY.get('oak_trapdoor_closed')!.id
      : BLOCK_BY_KEY.get(`oak_trapdoor_open_${this.viewFacing()}`)!.id;
    if (!ouverte && this.blocksPlayer(x, y, z, id)) return;
    this.setBlock(x, y, z, id);
    this.audio.place('wood');
  }

  private toggleGate(x: number, y: number, z: number): void {
    const m = /^oak_fence_gate_(\w+?)_(closed|open)$/.exec(blockDef(this.world.getBlock(x, y, z)).key);
    if (!m) return;
    const next = m[2] === 'closed' ? 'open' : 'closed';
    // Refuser de refermer un portillon sur le joueur : il resterait coincé.
    const id = BLOCK_BY_KEY.get(`oak_fence_gate_${m[1]}_${next}`)!.id;
    if (next === 'closed' && this.blocksPlayer(x, y, z, id)) return;
    this.setBlock(x, y, z, id);
    this.audio.place('wood');
  }

  /**
   * Dormir : passe au matin et fixe le point de réapparition. Refusé de jour et
   * tant qu'une créature hostile rôde — sinon le lit annulerait toute la nuit.
   */
  private sleep(x: number, y: number, z: number): void {
    if (this.dimension !== 'overworld') {
      this.hud.toast('Impossible de dormir ici.');
      return;
    }
    // Le point de réapparition se règle de jour comme de nuit ; seul le saut
    // de la nuit demande qu'il fasse effectivement nuit.
    const night = this.dayTime > 0.5;
    this.spawnPoint.set(x + 0.5, y + 1, z + 0.5);
    if (!night) {
      this.hud.toast('Point de réapparition enregistré.');
      return;
    }
    const monster = this.mobs.find((m) => m.def.hostile && !m.dead && m.position.distanceTo(this.player.position) < 12);
    if (monster) {
      this.hud.toast('Impossible de dormir, il y a des monstres tout près.');
      return;
    }
    this.dayTime = 0.02;
    this.player.stats.health = Math.min(this.player.stats.maxHealth, this.player.stats.health + 2);
    this.hud.toast('Bonne nuit. Point de réapparition enregistré.');
    this.audio.click();
  }

  /**
   * Retire l'autre moitié d'une porte ou d'un lit. Sans ça, casser le bas
   * laisserait le haut flotter en l'air.
   */
  private breakPairedHalf(x: number, y: number, z: number, key: string): void {
    let ox = x, oy = y, oz = z;
    if (key.startsWith('oak_door_')) {
      oy = key.includes('_lower_') ? y + 1 : y - 1;
    } else if (key.startsWith('red_bed_')) {
      const m = /^red_bed_(\w+?)_(foot|head)$/.exec(key)!;
      const [dx, dz] = Game.STEP[m[1] as Facing];
      // La tête est devant le pied : on remonte dans l'autre sens depuis la tête.
      const s = m[2] === 'foot' ? 1 : -1;
      ox = x + dx * s;
      oz = z + dz * s;
    } else {
      return;
    }
    const other = this.world.getBlock(ox, oy, oz);
    if (other <= 0) return;
    const otherKey = blockDef(other).key;
    const family = key.startsWith('oak_door_') ? 'oak_door_' : 'red_bed_';
    if (!otherKey.startsWith(family)) return;
    this.setBlock(ox, oy, oz, 0);
    if (this.settings.particles) {
      this.particles.burstBlock(ox, oy, oz, this.atlas.tileAverage(blockDef(other).layers.side), 10);
    }
  }

  private openContainer(hit: RaycastHit, kind: 'furnace' | 'chest'): void {
    const key = `${hit.x},${hit.y},${hit.z}`;
    let be = this.blockEntities.get(key);
    if (!be) {
      be = kind === 'chest'
        ? new Container(27)
        : { input: new Container(1), fuel: new Container(1), output: new Container(1), burn: 0, burnMax: 0, progress: 0 };
      this.blockEntities.set(key, be);
      // Premier ouvre-boîte : si ce coffre appartient à une structure générée,
      // il se garnit maintenant. Le tirage dépend de sa position, donc revenir
      // dans le monde après un rechargement redonne exactement le même butin.
      if (be instanceof Container) this.fillStructureLoot(hit.x, hit.y, hit.z, be);
    }
    this.openBlockPos = key;
    this.input.exitLock();
    this.screens.show(kind);
  }

  /**
   * Garnit un coffre de structure. Une fois vidé par le joueur, il ne se
   * remplit plus : la sauvegarde retient les positions déjà servies.
   */
  private fillStructureLoot(x: number, y: number, z: number, c: Container): void {
    if (!this.structGen) return;
    const key = `${x},${y},${z}`;
    if (this.lootedChests.has(key)) return;
    const kind = this.structGen.lootKindAt(x, y, z);
    if (!kind) return;
    this.lootedChests.add(key);
    for (const [slot, stack] of rollLoot(kind, x, y, z, c.size)) c.set(slot, stack);
  }

  // --- Dimensions et portails ---------------------------------------------

  /**
   * Allume un cadre d'obsidienne. On part du bloc visé, on cherche le rectangle
   * d'air borné par de l'obsidienne dans l'un des deux plans verticaux, et on
   * le remplit de blocs de portail.
   *
   * @returns vrai si un portail a été allumé.
   */
  private ignitePortal(x: number, y: number, z: number): boolean {
    for (const axis of ['x', 'z'] as const) {
      const cells = this.portalInterior(x, y, z, axis);
      if (!cells) continue;
      for (const [px, py, pz] of cells) this.setBlock(px, py, pz, B.nether_portal);
      this.audio.explosion();
      this.hud.toast('Le portail s’ouvre.');
      return true;
    }
    return false;
  }

  /**
   * Remplissage par diffusion de l'air d'un plan vertical, borné par de
   * l'obsidienne. Renvoie `null` si la zone fuit, dépasse 40 cases, ou n'est pas
   * assez haute pour qu'on la traverse.
   */
  private portalInterior(x: number, y: number, z: number, axis: 'x' | 'z'): [number, number, number][] | null {
    const seen = new Set<string>();
    const out: [number, number, number][] = [];
    const stack: [number, number, number][] = [[x, y, z]];
    let minY = y, maxY = y;
    while (stack.length) {
      const [cx, cy, cz] = stack.pop()!;
      const k = `${cx},${cy},${cz}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const id = this.world.getBlock(cx, cy, cz);
      if (id === B.obsidian || id === B.glowing_obsidian) continue; // bord du cadre
      if (id !== 0) return null; // autre chose que de l'air : le cadre n'est pas propre
      if (out.length > 40) return null;
      out.push([cx, cy, cz]);
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      stack.push([cx, cy + 1, cz], [cx, cy - 1, cz]);
      if (axis === 'x') stack.push([cx + 1, cy, cz], [cx - 1, cy, cz]);
      else stack.push([cx, cy, cz + 1], [cx, cy, cz - 1]);
    }
    if (out.length < 6 || maxY - minY < 2) return null;
    return out;
  }

  /**
   * Le joueur est-il dans un bloc de portail ? Deux secondes suffisent à
   * basculer — assez pour qu'on puisse ressortir sans le vouloir.
   */
  private updatePortals(dt: number): void {
    if (this.portalCooldown > 0) this.portalCooldown -= dt;
    const p = this.player.position;
    const head = this.world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.9), Math.floor(p.z));
    const feet = this.world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.1), Math.floor(p.z));
    const at = head === B.nether_portal || head === B.end_portal ? head : feet;
    const inPortal = at === B.nether_portal || at === B.end_portal;
    if (!inPortal || this.portalCooldown > 0) {
      this.portalTimer = 0;
      return;
    }
    this.portalTimer += dt;
    const delay = at === B.end_portal ? 1.2 : 2;
    if (this.portalTimer < delay) return;
    this.portalTimer = 0;
    if (at === B.end_portal) {
      void this.travelTo(this.dimension === 'end' ? 'overworld' : 'end');
    } else {
      void this.travelTo(this.dimension === 'nether' ? 'overworld' : 'nether');
    }
  }

  /**
   * Change de dimension : on démonte le monde courant, on en reconstruit un
   * avec l'autre générateur, et on dépose le joueur sur une plate-forme sûre.
   * L'inventaire, l'heure et le temps de jeu ne bougent pas.
   */
  private async travelTo(to: Dimension): Promise<void> {
    if (!this.save || this.dimension === to) return;
    const from = this.dimension;
    this.sessionReady = false;
    this.setLoading(true, to === 'nether' ? 'Descente dans le Nether…' : to === 'end' ? 'Passage vers l’End…' : 'Retour au monde…');
    await frame();

    // On retient d'où l'on vient pour ressortir au bon endroit.
    if (from === 'overworld') this.returnPos = this.player.position.clone();
    for (const c of this.world.chunks.values()) if (c.edits?.size) this.save.storeEdits(c.cx, c.cz, c.edits);
    await this.save.flush();

    // Les conteneurs restent attachés à leur dimension.
    this.dimEntities.set(from, new Map(this.blockEntities));
    this.teardownDimension();

    this.dimension = to;
    this.save.dimension = to;
    this.save.meta.dimension = to;
    this.blockEntities = this.dimEntities.get(to) ?? new Map();
    this.buildDimension(this.save.meta.seed);

    // Où atterrir. Dans le Nether, on divise les coordonnées par huit : c'est
    // ce qui rend le raccourci utile.
    const p = this.player.position;
    if (to === 'nether') this.player.position.set(Math.round(p.x / 8) + 0.5, NETHER_LAVA + 14, Math.round(p.z / 8) + 0.5);
    else if (to === 'end') this.player.position.set(0.5, 84, 0.5);
    else if (this.returnPos) this.player.position.copy(this.returnPos);
    else this.player.position.set(Math.round(p.x * 8) + 0.5, WORLD_HEIGHT - 8, Math.round(p.z * 8) + 0.5);
    this.player.velocity.set(0, 0, 0);

    this.arrivedFrom = from;
    this.worldReady = false;
    this.entitiesRestored = false;
    this.sessionReady = true;
    this.portalCooldown = 4;
    this.chunks.setCenter(this.player.position.x, this.player.position.z);
  }

  /** Dimension quittée au dernier voyage, pour construire la plate-forme d'arrivée. */
  private arrivedFrom: Dimension | null = null;

  /** Démonte tout ce qui appartient à la dimension quittée. */
  private teardownDimension(): void {
    // Les créatures partent avec la dimension : on les écrit avant de les
    // détruire, sinon franchir un portail effacerait tout un cheptel.
    this.flushEntities(this.dimension);
    if (this.chunks) { this.chunks.dispose(); this.scene.remove(this.chunks.group); }
    if (this.pool) this.pool.dispose();
    if (this.particles) this.scene.remove(this.particles.mesh);
    this.mount = null;
    this.player.riding = false;
    for (const m of this.mobs) { this.entityGroup.remove(m.group); m.dispose(); }
    for (const d of this.drops) { this.entityGroup.remove(d.object); d.dispose(); }
    this.mobs = [];
    this.drops = [];
    this.lootedChests.clear();
    this.dragon = null;
    this.dragonSpawnDelay = 4;
    this.crystals = 0;
    this.crystalTimer = 0;
    this.hud.setBoss(null);
  }

  /**
   * Creuse une poche d'arrivée et y dresse un portail de retour. Sans ça, on
   * apparaîtrait volontiers dans la roche ou au-dessus d'une mer de lave.
   */
  private buildArrivalPlatform(): void {
    const p = this.player.position;
    // De retour chez soi, le portail construit à l'aller est toujours en place :
    // on repose le joueur dessus sans rien creuser.
    if (this.dimension === 'overworld' && this.returnPos) {
      this.player.position.copy(this.returnPos);
      this.player.velocity.set(0, 0, 0);
      this.hud.toast('De retour au grand air.');
      return;
    }
    const bx = Math.floor(p.x), bz = Math.floor(p.z);
    let by = Math.floor(p.y);

    if (this.dimension === 'nether') {
      // On cherche une poche d'air posée sur du solide, en partant du milieu de
      // la couche jouable. À défaut, on se pose franchement au-dessus de la
      // lave : mieux vaut une plate-forme suspendue qu'un bain.
      by = NETHER_LAVA + 12;
      for (let y = 78; y > NETHER_LAVA + 4; y--) {
        const below = this.world.getBlock(bx, y - 1, bz);
        if (below <= 0 || below === B.lava || !IS_SOLID[below]) continue;
        let clear = true;
        for (let h = 0; h < 4; h++) if (this.world.getBlock(bx, y + h, bz) !== 0) { clear = false; break; }
        if (clear) { by = y; break; }
      }
    } else if (this.dimension === 'end') {
      by = 0;
      for (let y = WORLD_HEIGHT - 2; y > 4; y--) {
        if (this.world.getBlock(bx, y, bz) !== 0) { by = y + 1; break; }
      }
      if (by === 0) by = 66;
    }

    // Socle dégagé sur quatre de haut. Dans l'End il s'étire vers l'est pour
    // loger aussi le portail de retour.
    const floor = this.dimension === 'end' ? B.end_stone : B.obsidian;
    const xMax = this.dimension === 'end' ? 5 : 2;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= xMax; dx++) {
        this.setBlock(bx + dx, by - 1, bz + dz, floor);
        for (let dy = 0; dy < 4; dy++) this.setBlock(bx + dx, by + dy, bz + dz, 0);
      }

    // Portail de retour, sauf dans l'End où c'est celui du sol qui compte.
    if (this.dimension !== 'end') {
      for (let dy = -1; dy <= 4; dy++)
        for (let dx = -1; dx <= 2; dx++) {
          const frame = dy === -1 || dy === 4 || dx === -1 || dx === 2;
          this.setBlock(bx + dx, by + dy, bz - 2, frame ? B.obsidian : B.nether_portal);
        }
    } else {
      // L'End : le portail de retour est un carré au ras du sol, trois blocs
      // plus loin — assez pour ne pas repartir dès l'arrivée.
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          this.setBlock(bx + 3 + dx, by - 1, bz + dz, B.obsidian);
          this.setBlock(bx + 3 + dx, by, bz + dz, B.end_portal);
        }
    }

    this.player.position.set(bx + 0.5, by + 0.02, bz + 0.5);
    this.player.velocity.set(0, 0, 0);
    this.hud.toast(
      this.dimension === 'nether' ? 'Bienvenue dans le Nether.'
        : this.dimension === 'end' ? 'Bienvenue dans l’End.'
          : 'De retour au grand air.',
    );
  }

  /**
   * Sertit un œil de l'Ender dans un cadre. Quand les douze sont garnis, le
   * bassin s'ouvre sur l'End.
   */
  private fillPortalFrame(x: number, y: number, z: number): boolean {
    if (this.world.getBlock(x, y, z) !== B.end_portal_frame) return false;
    const held = this.inventory.selectedStack;
    const creative = this.player.mode === GameMode.Creative;
    if (!creative && held?.item.key !== 'eye_of_ender') return false;
    this.setBlock(x, y, z, B.end_portal_frame_filled);
    if (!creative) this.inventory.main.consume(this.inventory.selected);
    this.audio.craft();
    this.hud.updateHotbar(this.inventory, true);
    this.tryOpenEndPortal(x, y, z);
    return true;
  }

  /** Cherche l'anneau complet autour du cadre serti et remplit le bassin. */
  private tryOpenEndPortal(x: number, y: number, z: number): void {
    // Le centre du bassin est à deux blocs du cadre, sur l'un des quatre côtés.
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
      const cx = x + dx, cz = z + dz;
      let complete = true;
      for (let d = -1; d <= 1 && complete; d++) {
        for (const [fx, fz] of [[d, -2], [d, 2], [-2, d], [2, d]] as const) {
          if (this.world.getBlock(cx + fx, y, cz + fz) !== B.end_portal_frame_filled) { complete = false; break; }
        }
      }
      if (!complete) continue;
      for (let iz = -1; iz <= 1; iz++)
        for (let ix = -1; ix <= 1; ix++) this.setBlock(cx + ix, y, cz + iz, B.end_portal);
      this.audio.explosion();
      this.hud.toast('Le portail de l’End s’ouvre !');
      return;
    }
  }

  // --- Mode « oneblock » ---------------------------------------------------

  /**
   * Le bloc unique vient d'être cassé : on en tire un nouveau dans la table de
   * la phase courante, avec parfois un coffre ou une créature à la place.
   */
  private oneblockAdvance(): void {
    this.oneblockCount++;
    if (this.save) this.save.meta.oneblock = this.oneblockCount;

    const phase = phaseFor(this.oneblockCount);
    if (phase.name !== this.oneblockPhase) {
      this.oneblockPhase = phase.name;
      this.hud.toast(`Phase « ${phase.name} » — bloc n° ${this.oneblockCount}`);
      this.audio.craft();
    }

    const x = ONEBLOCK_X, y = ONEBLOCK_Y, z = ONEBLOCK_Z;
    if (this.rnd() < phase.chestChance) {
      this.setBlock(x, y, z, BLOCK_BY_KEY.get('chest')?.id ?? 0);
      const c = new Container(27);
      // Le compteur entre dans la graine : deux coffres successifs diffèrent.
      for (const [slot, stack] of rollLoot(phase.chestLoot, x + this.oneblockCount, y, z, c.size)) c.set(slot, stack);
      this.blockEntities.set(`${x},${y},${z}`, c);
    } else {
      const def = BLOCK_BY_KEY.get(pickOneblock(phase, () => this.rnd()));
      this.setBlock(x, y, z, def?.id ?? 0);
    }

    if (this.mobsEnabled && this.mobs.length < this.settings.maxMobs && this.rnd() < phase.mobChance) {
      const kinds = phase.mobs as readonly MobKind[];
      const kind = kinds[Math.floor(this.rnd() * kinds.length)];
      const m = new Mob(kind, x + 0.5, y + 1.2, z + 0.5, this.env, (this.rnd() * 1e9) | 0);
      this.mobs.push(m);
      this.entityGroup.add(m.group);
    }
  }

  /** Blocs restants avant la phase suivante, ou -1 s'il n'y en a plus. */
  private nextPhaseIn(): number {
    for (const p of ONEBLOCK_PHASES) if (p.from > this.oneblockCount) return p.from - this.oneblockCount;
    return -1;
  }

  /** Le vide n'est pas une mort définitive : on renvoie le joueur sur l'île. */
  private guardVoid(): void {
    if (this.worldType !== 'oneblock') return;
    if (this.player.position.y > -18) return;
    this.player.position.copy(this.spawnPoint);
    this.player.velocity.set(0, 0, 0);
    if (this.player.mode === GameMode.Survival) {
      this.player.damage(4, false, this.inventory.totalDefense());
      this.audio.hurt();
    }
    this.hud.toast('Rattrapé de justesse au bord du vide.');
  }

  private blocksPlayer(x: number, y: number, z: number, id: number): boolean {
    if (!IS_SOLID[id]) return false;
    const p = this.player.position;
    const half = 0.31;
    const top = p.y + this.player.height;
    return (
      x + 1 > p.x - half && x < p.x + half &&
      z + 1 > p.z - half && z < p.z + half &&
      y + 1 > p.y + 0.02 && y < top
    );
  }

  /** Écrit un bloc et met à jour la sauvegarde. */
  private setBlock(x: number, y: number, z: number, id: number): void {
    if (!this.world.setBlock(x, y, z, id)) return;
    const cx = floorDiv(x, CHUNK_X);
    const cz = floorDiv(z, CHUNK_Z);
    this.save?.recordEdit(cx, cz, voxelIndex(mod(x, CHUNK_X), y, mod(z, CHUNK_Z)), id);
  }

  private spawnDrop(x: number, y: number, z: number, s: ItemStack): void {
    // Fusion : une veine de charbon, un arbre abattu ou une explosion créent
    // des dizaines de piles au même endroit. Les regrouper évite d'atteindre le
    // plafond d'entités — au-delà duquel du butin disparaissait sans être vu.
    if (s.item.maxStack > 1 && !s.item.durability) {
      for (const d of this.drops) {
        if (d.dead || d.stack.item !== s.item || d.stack.damage !== s.damage) continue;
        if (d.stack.count + s.count > s.item.maxStack) continue;
        const dx = d.position.x - x, dy = d.position.y - y, dz = d.position.z - z;
        if (dx * dx + dy * dy + dz * dz > 6.25) continue;
        d.stack.count += s.count;
        // Le compteur repart de zéro : une pile qu'on alimente ne périme pas.
        d.age = 0;
        return;
      }
    }
    if (this.drops.length >= MAX_DROPS) {
      const old = this.drops.shift()!;
      this.entityGroup.remove(old.object);
      old.dispose();
    }
    const e = new ItemEntity(x, y, z, s, this.env, itemColor(s.item));
    this.drops.push(e);
    this.entityGroup.add(e.object);
  }

  private dropSelected(): void {
    const s = this.inventory.selectedStack;
    if (!s) return;
    const one: ItemStack = { item: s.item, count: 1, damage: s.damage };
    this.inventory.main.consume(this.inventory.selected);
    const eye = this.player.eyePosition;
    const dir = this.player.forward;
    const e = new ItemEntity(eye.x + dir.x, eye.y - 0.2, eye.z + dir.z, one, this.env, itemColor(one.item));
    e.velocity.set(dir.x * 6, dir.y * 6 + 1.5, dir.z * 6);
    e.pickupDelay = 1;
    this.drops.push(e);
    this.entityGroup.add(e.object);
  }

  // --- Entités ------------------------------------------------------------

  private pickMob(origin: Vector3, dir: Vector3, maxDist: number): Mob | null {
    let best: Mob | null = null;
    let bestT = maxDist;
    for (const m of this.mobs) {
      const w = m.def.width / 2;
      const t = rayBox(origin, dir, m.position.x - w, m.position.y, m.position.z - w, m.position.x + w, m.position.y + m.def.height, m.position.z + w);
      if (t !== null && t < bestT) { bestT = t; best = m; }
    }
    return best;
  }

  private hitMob(m: Mob): void {
    const held = this.inventory.selectedStack;

    // Frapper un avion le replie en objet : c'est la seule façon de le
    // déplacer, et ça évite d'en semer un peu partout.
    if (m.kind === 'plane') {
      if (m === this.mount) this.dismount();
      m.dead = true;
      const def = ITEM_BY_KEY.get('plane');
      if (def && this.player.mode !== GameMode.Creative) {
        this.spawnDrop(m.position.x, m.position.y + 0.5, m.position.z, makeStack(def, 1));
      }
      this.audio.break('metal');
      this.heldView.swing = 1;
      return;
    }

    // Les cisailles tondent au lieu de blesser : c'est la façon paisible de
    // récolter de la laine, sans avoir à abattre le troupeau.
    if (held?.item.tool?.kind === 'shears' && m.kind === 'sheep' && !m.shorn) {
      m.shorn = true;
      const laine = ITEM_BY_KEY.get('white_wool');
      if (laine) this.spawnDrop(m.position.x, m.position.y + 0.6, m.position.z, makeStack(laine, 1 + Math.floor(this.rnd() * 3)));
      this.audio.mobHurt(m.kind);
      if (this.player.mode !== GameMode.Creative) this.inventory.damageSelected(1);
      this.heldView.swing = 1;
      return;
    }

    const damage = held?.item.tool?.damage ?? 1;
    const killed = m.hurt(damage);
    this.audio.mobHurt(m.kind);
    if (this.settings.particles) this.particles.puff(m.position.x, m.position.y + m.def.height * 0.6, m.position.z, 0xc03030, 4);
    // Recul.
    const dx = m.position.x - this.player.position.x;
    const dz = m.position.z - this.player.position.z;
    const len = Math.hypot(dx, dz) || 1;
    m.velocity.x += (dx / len) * 5.5;
    m.velocity.z += (dz / len) * 5.5;
    if (!m.def.orbit) {
      // Un boss de deux cents points de vie ne se fait pas bousculer.
      m.velocity.y = Math.max(m.velocity.y, 3.4);
    } else {
      m.velocity.x -= (dx / len) * 5.5;
      m.velocity.z -= (dz / len) * 5.5;
    }
    if (held?.item.durability) this.inventory.damageSelected(1);
    if (killed) {
      m.lootDropped = true;
      for (const d of m.rollDrops()) this.spawnDrop(d.x, d.y, d.z, d.stack);
      this.player.addXp(m.def.xp);
      if (m.def.orbit) this.onDragonSlain(m);
    }
  }

  // --- Combat du dragon ----------------------------------------------------

  /**
   * Le dragon apparaît la première fois qu'on arrive dans l'End, et une seule
   * fois par monde. Tant qu'un cristal tient sur sa colonne, il se régénère.
   */
  private updateDragonFight(dt: number): void {
    if (this.dimension !== 'end') { this.dragon = null; return; }

    if (!this.dragon && !this.save?.meta.dragonSlain && this.mobsEnabled) {
      this.dragonSpawnDelay -= dt;
      if (this.dragonSpawnDelay <= 0) {
        this.dragonSpawnDelay = 12;
        // On l'amène par le nord de l'île, en altitude.
        this.dragon = new Mob('ender_dragon', 0.5, 96, -44.5, this.env, (Math.random() * 1e9) | 0);
        this.mobs.push(this.dragon);
        this.entityGroup.add(this.dragon.group);
        this.hud.toast('Le dragon de l’End vous a vu.', 'warn', 5000);
        this.audio.mobAmbient('ender_dragon');
      }
    }

    const d = this.dragon;
    if (!d) { this.hud.setBoss(null); return; }
    if (d.dead) { this.dragon = null; this.hud.setBoss(null); return; }

    // Recomptage périodique : balayer l'île à chaque image coûterait trop cher.
    this.crystalTimer -= dt;
    if (this.crystalTimer <= 0) {
      this.crystalTimer = 2.5;
      this.crystals = this.countCrystals();
    }
    if (this.crystals > 0 && d.health < d.def.health) {
      // Chaque cristal rend deux points par seconde.
      d.health = Math.min(d.def.health, d.health + this.crystals * 2 * dt);
      if (this.settings.particles && Math.random() < dt * 6) {
        this.particles.puff(d.position.x, d.position.y + 3, d.position.z, 0xc79cf0, 2);
      }
    }
    this.hud.setBoss({
      name: d.def.name,
      ratio: Math.max(0, d.health / d.def.health),
      note: this.crystals > 1 ? `${this.crystals} cristaux le régénèrent`
        : this.crystals === 1 ? 'un cristal le régénère'
          : 'plus aucun cristal',
    });
  }

  /**
   * Cristaux encore debout au-dessus de l'île centrale.
   *
   * Un cristal est toujours le bloc le plus haut de sa colonne : on interroge
   * la carte de hauteur du chunk plutôt que de balayer trente niveaux, ce qui
   * ramène le comptage de trois cent mille lectures à onze mille.
   */
  private countCrystals(): number {
    let n = 0;
    const R = 52;
    for (let z = -R; z <= R; z++) {
      for (let x = -R; x <= R; x++) {
        if (x * x + z * z > R * R) continue;
        const c = this.world.getChunk(floorDiv(x, CHUNK_X), floorDiv(z, CHUNK_Z));
        if (!c || c.state !== ChunkState.Ready) continue;
        const top = c.height[mod(x, CHUNK_X) + mod(z, CHUNK_Z) * CHUNK_X];
        if (top > 60 && this.world.getBlock(x, top, z) === B.end_crystal) n++;
      }
    }
    return n;
  }

  /** Mort du dragon : explosion, œuf, portail de sortie, et c'est fini. */
  private onDragonSlain(m: Mob): void {
    this.dragon = null;
    this.hud.setBoss(null);
    if (this.save) this.save.meta.dragonSlain = true;
    this.audio.explosion();
    if (this.settings.particles) this.particles.explosion(m.position.x, m.position.y + 2, m.position.z, 6);

    // Piédestal au centre de l'île, surmonté de l'œuf.
    let top = 0;
    for (let y = WORLD_HEIGHT - 2; y > 4; y--) if (this.world.getBlock(0, y, 0) !== 0) { top = y; break; }
    if (top > 0) {
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          const h = Math.abs(dx) + Math.abs(dz) <= 1 ? 3 : Math.abs(dx) + Math.abs(dz) <= 2 ? 2 : 1;
          for (let dy = 1; dy <= h; dy++) this.setBlock(dx, top + dy, dz, B.obsidian);
        }
      this.setBlock(0, top + 4, 0, B.dragon_egg);
    }
    this.player.addXp(200);
    this.hud.toast('Le dragon s’effondre. L’œuf est à vous.', 'info', 6000);
  }


  private updateEntities(dt: number, active: boolean): void {
    if (!active) return;
    const maxDist = this.settings.entityDistance;
    // Hors de l'Overworld, le cycle jour/nuit ne s'applique pas : sans ça, les
    // créatures du Nether et de l'End s'assombrissaient au gré de l'heure.
    const dayFactor = this.dimension === 'overworld' ? this.skyState.dayFactor : 1;
    this.assignGuardTargets();

    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      const dist = m.position.distanceTo(this.player.position);
      // Un engin et une bête attachée appartiennent au joueur : ils ne
      // s'évaporent pas parce qu'il s'est éloigné. Le reste, si.
      const permanent = m.def.aircraft === true || m.leashed || m.leashPost !== null;
      if (m.dead || (dist > 110 && !m.def.orbit && !permanent)) {
        // Morte autrement que sous les coups du joueur — noyée, brûlée, tombée
        // dans le vide — la bête laisse quand même son butin.
        if (m.dead && !m.lootDropped) {
          m.lootDropped = true;
          for (const d of m.rollDrops()) this.spawnDrop(d.x, d.y, d.z, d.stack);
        }
        this.entityGroup.remove(m.group);
        m.dispose();
        this.mobs.splice(i, 1);
        continue;
      }
      m.group.visible = dist < maxDist;
      if (dist > maxDist * 1.4) continue;
      m.update(
        dt, this.world, this.player.position,
        this.player.mode === GameMode.Survival,
        dayFactor,
        (dmg) => {
          this.player.damage(dmg, false, this.inventory.totalDefense());
          this.inventory.damageArmor(1);
          this.audio.hurt();
        },
        (mob) => this.explode(mob.position.x, mob.position.y, mob.position.z, 3.2),
      );
      if (Math.random() < dt * 0.06) this.audio.mobAmbient(m.kind);
      // Une créature en feu crache des flammes : sans particules, on ne
      // comprendrait pas pourquoi elle perd de la vie.
      if (m.burning > 0 && this.settings.particles && Math.random() < dt * 14) {
        this.particles.puff(
          m.position.x + (Math.random() - 0.5) * m.def.width,
          m.position.y + Math.random() * m.def.height,
          m.position.z + (Math.random() - 0.5) * m.def.width,
          Math.random() < 0.5 ? 0xffa32a : 0xe0521a, 1,
        );
      }
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.update(dt, this.world, this.player.position, dayFactor);
      // Un objet oublié finit par disparaître : c'est ce qui garde de la place
      // pour le butin qu'on est en train de miner.
      if (d.age > DROP_LIFETIME) d.dead = true;
      if (!d.dead && d.canPickup(this.player.position)) {
        const left = this.inventory.give(d.stack);
        if (!left) {
          d.dead = true;
          this.audio.click();
          this.hud.updateHotbar(this.inventory, true);
        } else {
          d.stack = left;
        }
      }
      if (d.dead) {
        this.entityGroup.remove(d.object);
        d.dispose();
        this.drops.splice(i, 1);
      }
    }

    this.updateDragonFight(dt);

    this.mobTimer += dt;
    if (this.mobTimer >= MOB_TICK) {
      this.mobTimer = 0;
      this.trySpawnMob();
    }
  }

  /**
   * Chaque golem prend pour cible la créature hostile la plus proche. Sans ça
   * il resterait planté au milieu du village pendant qu'on l'attaque.
   */
  private assignGuardTargets(): void {
    for (const g of this.mobs) {
      if (!g.def.guard) continue;
      let best: Mob | null = null;
      let bestD = g.def.aggroRange;
      for (const m of this.mobs) {
        if (m === g || m.dead || !m.def.hostile) continue;
        const d = m.position.distanceTo(g.position);
        if (d < bestD) { bestD = d; best = m; }
      }
      g.threat = best;
    }
  }

  private trySpawnMob(): void {
    if (!this.mobsEnabled) return;
    if (this.mobs.length >= this.settings.maxMobs) return;
    if (this.player.mode === GameMode.Spectator) return;
    if (this.worldType === 'oneblock') return; // ici, tout sort du bloc
    if (this.dimension !== 'overworld') { this.trySpawnDimensionMob(); return; }

    // Un village proche peuple d'abord ses propres habitants.
    if (this.trySpawnVillagers()) return;
    // Le kraken ne se montre qu'en eau profonde.
    if (Math.random() < 0.16 && this.trySpawnKraken()) return;

    const night = this.skyState.dayFactor < 0.25;
    const hostile = night ? Math.random() < 0.75 : Math.random() < 0.2;
    const kinds: MobKind[] = hostile
      ? night && Math.random() < 0.12
        ? ['enderman'] // l'enderman ne sort que la nuit, et rarement
        : ['zombie', 'skeleton', 'creeper', 'spider', 'bloop']
      : ['pig', 'cow', 'sheep', 'chicken', 'horse'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const def = MOBS[kind];
    const spot = findSpawnSpot(
      this.world,
      this.player.position.x, this.player.position.z,
      Math.max(4, this.player.position.y - 26), Math.min(WORLD_HEIGHT - 4, this.player.position.y + 26),
      () => Math.random(),
      !hostile,
      def.width, def.height,
    );
    if (!spot) return;
    if (spot.distanceTo(this.player.position) < 18) return;
    this.addMob(kind, spot.x, spot.y, spot.z);
  }

  /**
   * Peuple les villages alentour : quelques villageois, et un golem de fer pour
   * les garder. Les positions des villages sont recalculées depuis la graine,
   * sans avoir à les stocker.
   */
  private trySpawnVillagers(): boolean {
    if (!this.structGen) return false;
    const villages = this.structGen.villagesAround(
      Math.round(this.player.position.x), Math.round(this.player.position.z), 64,
    );
    if (!villages.length) return false;
    const v = villages[Math.floor(Math.random() * villages.length)];

    // Quota par village : on compte ce qui vit déjà dans son enceinte.
    let villagers = 0, golems = 0;
    for (const m of this.mobs) {
      if (Math.hypot(m.position.x - v.x, m.position.z - v.z) > 34) continue;
      if (m.kind === 'villager') villagers++;
      else if (m.kind === 'iron_golem') golems++;
    }
    let idiots = 0;
    for (const m of this.mobs) {
      if (m.kind === 'village_idiot' && Math.hypot(m.position.x - v.x, m.position.z - v.z) <= 34) idiots++;
    }
    // Chaque village a le sien — et un seul, il est déjà bien assez.
    const kind: MobKind | null =
      villagers < 5 ? 'villager'
        : idiots < 1 ? 'village_idiot'
          : golems < 1 ? 'iron_golem'
            : null;
    if (!kind) return false;

    const def = MOBS[kind];
    const spot = findSpawnSpot(
      this.world, v.x, v.z,
      Math.max(4, v.y - 6), Math.min(WORLD_HEIGHT - 4, v.y + 10),
      () => Math.random(), true, def.width, def.height,
    );
    if (!spot) return false;
    if (Math.hypot(spot.x - v.x, spot.z - v.z) > 30) return false;
    this.addMob(kind, spot.x, spot.y, spot.z);
    return true;
  }

  /**
   * Peuplement du Nether et de l'End. Aucune notion de jour ni de niveau de
   * lumière ici : tout ce qui apparaît est hostile, et les braises ont besoin
   * d'un vide où flotter.
   */
  private trySpawnDimensionMob(): void {
    const nether = this.dimension === 'nether';
    const kinds: MobKind[] = nether
      ? ['piglin', 'piglin', 'blaze', 'blaze', 'enderman', 'zombie', 'bloop']
      : ['enderman', 'enderman', 'bloop'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const def = MOBS[kind];
    const p = this.player.position;

    if (def.flies) {
      // Une braise apparaît en l'air, quelque part au-dessus d'un sol.
      for (let t = 0; t < 14; t++) {
        const x = Math.floor(p.x + (Math.random() - 0.5) * 60);
        const z = Math.floor(p.z + (Math.random() - 0.5) * 60);
        const y = Math.floor(p.y + (Math.random() - 0.5) * 24);
        if (y < 6 || y > WORLD_HEIGHT - 6) continue;
        if (this.world.getBlock(x, y, z) !== 0 || this.world.getBlock(x, y + 1, z) !== 0) continue;
        if (Math.hypot(x - p.x, y - p.y, z - p.z) < 14) continue;
        this.addMob(kind, x + 0.5, y, z + 0.5);
        return;
      }
      return;
    }

    const spot = findSpawnSpot(
      this.world, p.x, p.z,
      Math.max(4, p.y - 24), Math.min(WORLD_HEIGHT - 4, p.y + 24),
      () => Math.random(), false, def.width, def.height,
    );
    if (!spot || spot.distanceTo(p) < 16) return;
    this.addMob(kind, spot.x, spot.y, spot.z);
  }

  private trySpawnKraken(): boolean {
    for (const m of this.mobs) if (m.kind === 'kraken') return false;
    const def = MOBS.kraken;
    const spot = findWaterSpawnSpot(this.world, this.player.position.x, this.player.position.z, () => Math.random(), def.height);
    if (!spot) return false;
    if (spot.distanceTo(this.player.position) < 16) return false;
    this.addMob('kraken', spot.x, spot.y, spot.z);
    return true;
  }

  /**
   * Redessine les cordes : de chaque bête attachée vers sa barrière, ou vers la
   * main du joueur quand il la tient.
   */
  private updateLeashes(): void {
    const attaches: Mob[] = [];
    for (const m of this.mobs) if (!m.dead && (m.leashed || m.leashPost)) attaches.push(m);
    if (attaches.length === 0) { this.leashLines.visible = false; return; }

    const need = attaches.length * 6;
    if (this.leashBuf.length !== need) {
      this.leashBuf = new Float32Array(need);
      this.leashLines.geometry.setAttribute('position', new BufferAttribute(this.leashBuf, 3));
    }
    const hand = this.player.eyePosition;
    let k = 0;
    for (const m of attaches) {
      this.leashBuf[k++] = m.position.x;
      this.leashBuf[k++] = m.position.y + m.def.height * 0.8;
      this.leashBuf[k++] = m.position.z;
      if (m.leashPost) {
        this.leashBuf[k++] = m.leashPost.x + 0.5;
        this.leashBuf[k++] = m.leashPost.y + 0.9;
        this.leashBuf[k++] = m.leashPost.z + 0.5;
      } else {
        this.leashBuf[k++] = hand.x;
        this.leashBuf[k++] = hand.y - 0.35;
        this.leashBuf[k++] = hand.z;
      }
    }
    (this.leashLines.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.leashLines.geometry.setDrawRange(0, attaches.length * 2);
    this.leashLines.visible = true;
  }

  /**
   * Libère les bêtes attachées au bloc qu'on vient de casser, et rend leur
   * laisse. Sans ça elles resteraient retenues par un piquet disparu.
   */
  private untieFrom(x: number, y: number, z: number, creative: boolean): void {
    const laisse = ITEM_BY_KEY.get('lead');
    for (const m of this.mobs) {
      const p = m.leashPost;
      if (!p || p.x !== x || p.y !== y || p.z !== z) continue;
      m.leashPost = null;
      if (laisse && !creative) this.spawnDrop(x + 0.5, y + 0.5, z + 0.5, makeStack(laisse, 1));
    }
  }

  private addMob(kind: MobKind, x: number, y: number, z: number): Mob {
    const m = new Mob(kind, x, y, z, this.env, (Math.random() * 1e9) | 0);
    this.mobs.push(m);
    this.entityGroup.add(m.group);
    return m;
  }

  // --- Persistance des créatures et des engins ------------------------------

  /**
   * Créatures et engins de la dimension courante, prêts à être écrits.
   *
   * Le dragon est exclu : c'est la logique de l'End qui décide de sa présence,
   * d'après le drapeau « déjà vaincu ». Le restaurer en plus en ferait deux.
   */
  private serializeEntities(): EntitySave[] {
    const out: EntitySave[] = [];
    for (const m of this.mobs) {
      if (m.dead || m.kind === 'ender_dragon') continue;
      out.push({
        kind: m.kind,
        x: +m.position.x.toFixed(2), y: +m.position.y.toFixed(2), z: +m.position.z.toFixed(2),
        yaw: +m.yaw.toFixed(3),
        health: m.health,
        shorn: m.shorn || undefined,
        airspeed: m.def.aircraft ? +m.airspeed.toFixed(2) : undefined,
        // Seule la laisse nouée se garde : « tenue en main » n'a plus de sens
        // une fois la partie fermée.
        post: m.leashPost ? [m.leashPost.x, m.leashPost.y, m.leashPost.z] : undefined,
      });
    }
    return out;
  }

  /** Recrée les créatures et les engins écrits pour la dimension courante. */
  private restoreEntities(list: EntitySave[]): void {
    for (const e of list) {
      if (!(e.kind in MOBS)) continue; // espèce disparue d'une version à l'autre
      const m = this.addMob(e.kind as MobKind, e.x, e.y, e.z);
      m.yaw = e.yaw;
      m.health = Math.min(m.def.health, Math.max(1, e.health));
      if (e.shorn) m.shorn = true;
      if (e.airspeed !== undefined) m.airspeed = e.airspeed;
      if (e.post) m.leashPost = { x: e.post[0], y: e.post[1], z: e.post[2] };
    }
  }

  /** Relit et recrée les entités écrites pour la dimension courante. */
  private async restoreDimensionEntities(): Promise<void> {
    if (!this.save) return;
    const dimension = this.dimension;
    const list = await this.save.loadEntities(dimension);
    // Le joueur a pu changer de dimension pendant la lecture.
    if (!list.length || this.dimension !== dimension) return;
    this.restoreEntities(list);
  }

  /** Écrit les entités d'une dimension donnée, sans attendre la fin. */
  private flushEntities(dimension: Dimension): void {
    if (!this.save) return;
    void this.save.saveEntities(dimension, this.serializeEntities());
  }

  private explode(x: number, y: number, z: number, radius: number): void {
    this.audio.explosion();
    if (this.settings.particles) this.particles.explosion(x, y, z, radius);
    const r = Math.ceil(radius);
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy, dz);
          if (d > radius) continue;
          const bx = Math.floor(x) + dx;
          const by = Math.floor(y) + dy;
          const bz = Math.floor(z) + dz;
          const id = this.world.getBlock(bx, by, bz);
          if (id <= 0) continue;
          const def = blockDef(id);
          if (def.hardness < 0 || def.hardness > 12) continue;
          if (Math.random() > 1 - d / (radius + 1)) continue;
          this.setBlock(bx, by, bz, 0);
          if (Math.random() < 0.2) {
            for (const drop of blockDrops(id, true, () => Math.random())) {
              this.spawnDrop(bx + 0.5, by + 0.5, bz + 0.5, makeStack(drop.item, drop.count));
            }
          }
        }
      }
    }
    // Souffle sur le joueur.
    const dist = this.player.position.distanceTo(tmpVec.set(x, y, z));
    if (dist < radius * 2.2) {
      const power = 1 - dist / (radius * 2.2);
      this.player.damage(Math.round(14 * power), false, this.inventory.totalDefense());
      const dir = tmpVec2.copy(this.player.position).sub(tmpVec.set(x, y, z)).normalize();
      this.player.velocity.addScaledVector(dir, 12 * power);
      this.player.velocity.y += 5 * power;
      this.audio.hurt();
    }
  }

  // --- Fours --------------------------------------------------------------

  private updateBlockEntities(dt: number): void {
    for (const be of this.blockEntities.values()) {
      if (be instanceof Container) continue;
      const f = be;
      const input = f.input.get(0);
      const outKey = input ? SMELTING[input.item.key] : undefined;
      const outDef = outKey ? ITEM_BY_KEY.get(outKey) : undefined;
      const out = f.output.get(0);
      const canOutput = !!outDef && (!out || (out.item === outDef && out.count < outDef.maxStack));

      if (f.burn <= 0 && canOutput) {
        const fuel = f.fuel.get(0);
        if (fuel?.item.fuel) {
          f.burnMax = fuel.item.fuel;
          f.burn = fuel.item.fuel;
          f.fuel.consume(0);
        }
      }
      if (f.burn > 0) {
        f.burn = Math.max(0, f.burn - dt);
        if (canOutput && input) {
          f.progress += dt / 9;
          if (f.progress >= 1) {
            f.progress = 0;
            f.input.consume(0);
            if (out) { out.count++; f.output.version++; }
            else f.output.set(0, makeStack(outDef!, 1));
          }
        } else {
          f.progress = Math.max(0, f.progress - dt * 0.5);
        }
      } else {
        f.progress = Math.max(0, f.progress - dt * 0.5);
      }
    }
  }

  // --- Caméra et modèles --------------------------------------------------

  private updateCamera(dt: number): void {
    const p = this.player;
    const eye = p.eyePosition;
    this.camera.position.copy(eye);

    if (this.settings.viewBobbing && p.onGround) {
      const amp = Math.min(0.055, Math.hypot(p.velocity.x, p.velocity.z) * 0.011);
      this.camera.position.y += Math.sin(p.bobPhase * 4) * amp;
      this.camera.position.x += Math.cos(p.bobPhase * 2) * amp * 0.6;
    }

    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(p.yaw);
    this.camera.rotateX(-p.pitch);
    // Légère inclinaison en sprint.
    this.camera.rotateZ(p.sprinting ? -0.018 : 0);

    if (p.cameraMode > 0) {
      const back = p.cameraMode === 1 ? 1 : -1;
      const dir = p.forward.clone().multiplyScalar(-back);
      const dist = 4.2;
      const hit = raycast(this.world, eye, dir, dist);
      const d = hit ? Math.max(0.6, hit.distance - 0.35) : dist;
      this.camera.position.addScaledVector(dir, d);
      if (p.cameraMode === 2) {
        this.camera.rotateY(Math.PI);
      }
      this.playerModel.visible = true;
      this.playerModel.position.copy(p.position);
      this.playerModel.rotation.y = p.yaw + Math.PI;
      const swing = Math.sin(p.bobPhase * 4) * Math.min(0.7, Math.hypot(p.velocity.x, p.velocity.z) * 0.16);
      const [armL, armR, legL, legR] = this.playerLimbs;
      armL.rotation.x = swing;
      armR.rotation.x = -swing;
      legL.rotation.x = -swing;
      legR.rotation.x = swing;
    } else {
      this.playerModel.visible = false;
    }
    this.camera.updateMatrixWorld();
    void dt;
  }

  private playerLimbs: Group[] = [];

  private buildPlayerModel(): Group {
    const g = new Group();
    const mat = createEntityMaterial(this.env);
    const add = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, pivotTop = false) => {
      const pivot = new Group();
      pivot.position.set(x, y, z);
      const mesh = new Mesh(coloredBox(w, h, d, color), mat);
      mesh.position.y = pivotTop ? -h / 2 : 0;
      pivot.add(mesh);
      g.add(pivot);
      return pivot;
    };
    add(0.5, 0.5, 0.5, 0xe0ac86, 0, 1.62, 0);
    add(0.52, 0.74, 0.28, 0x3aa0c8, 0, 1.0, 0);
    const armL = add(0.22, 0.72, 0.22, 0xe0ac86, -0.37, 1.38, 0, true);
    const armR = add(0.22, 0.72, 0.22, 0xe0ac86, 0.37, 1.38, 0, true);
    const legL = add(0.24, 0.68, 0.24, 0x3b4a86, -0.13, 0.68, 0, true);
    const legR = add(0.24, 0.68, 0.24, 0x3b4a86, 0.13, 0.68, 0, true);
    this.playerLimbs = [armL, armR, legL, legR];
    g.userData.material = mat;
    return g;
  }

  private updateHeldView(dt: number): void {
    const view = this.heldView;
    view.swing = Math.max(0, view.swing - dt * 4.2);
    const stackHeld = this.inventory.selectedStack;
    const id = stackHeld ? stackHeld.item.id : -1;
    if (id !== view.current) {
      view.current = id;
      view.group.clear();
      if (stackHeld) view.group.add(this.buildHeldMesh(stackHeld.item));
    }
    view.group.visible = this.player.cameraMode === 0 && !!stackHeld && !this.screens.isOpen;
    if (!view.group.visible) return;

    const swing = Math.sin(view.swing * Math.PI) ;
    const bob = this.settings.viewBobbing ? Math.sin(this.player.bobPhase * 4) * 0.012 : 0;
    tmpVec.set(0.30, -0.26 + bob - swing * 0.1, -0.46);
    tmpVec.applyQuaternion(this.camera.quaternion);
    view.group.position.copy(this.camera.position).add(tmpVec);
    view.group.quaternion.copy(this.camera.quaternion);
    view.group.rotateY(-0.42);
    view.group.rotateX(-0.18 - swing * 1.15);
    view.group.rotateZ(swing * 0.4);
  }

  private buildHeldMesh(item: ItemDef): Mesh {
    if (item.block) {
      const geo = buildBlockCubeGeometry(item.block);
      const mat = createTerrainMaterial('cutout', this.atlas.texture, this.atlas.normalTexture, this.env);
      mat.depthTest = true;
      const m = new Mesh(geo, mat);
      m.scale.setScalar(0.24);
      return m;
    }
    const mat = createEntityMaterial(this.env);
    (mat.uniforms.uLight.value as Color).setRGB(1.05, 1.05, 1.05);
    const m = new Mesh(coloredBox(0.08, 0.42, 0.08, item.color), mat);
    m.rotation.z = 0.5;
    return m;
  }

  // --- Sons de pas --------------------------------------------------------

  private lastStep = 0;
  private wasInWater = false;

  private handleStepSounds(dt: number): void {
    const p = this.player;
    if (p.onGround && p.stepDistance - this.lastStep > (p.sprinting ? 1.9 : 2.5)) {
      this.lastStep = p.stepDistance;
      const below = this.world.getBlock(Math.floor(p.position.x), Math.floor(p.position.y - 0.15), Math.floor(p.position.z));
      if (below > 0) {
        const def = blockDef(below);
        this.audio.step(def.sound as SoundGroup);
        if (this.settings.particles && p.sprinting) {
          this.particles.puff(p.position.x, p.position.y, p.position.z, this.atlas.tileAverage(def.layers.top), 2);
        }
      }
    }
    if (p.inWater !== this.wasInWater) {
      this.wasInWater = p.inWater;
      if (p.inWater) {
        this.audio.splash();
        if (this.settings.particles) this.particles.splash(p.position.x, p.position.y, p.position.z);
      }
    }
    void dt;
  }

  // --- Débogage -----------------------------------------------------------

  private updateDebug(): void {
    if (!this.settings.showFps) {
      this.hud.setDebug(null);
      return;
    }
    const p = this.player;
    const s = this.chunks.stats();
    const bx = Math.floor(p.position.x);
    const by = Math.floor(p.position.y);
    const bz = Math.floor(p.position.z);
    const c = this.world.getChunk(floorDiv(bx, CHUNK_X), floorDiv(bz, CHUNK_Z));
    const biome = c && c.state === ChunkState.Ready
      ? biomeDef(c.biomes[mod(bx, CHUNK_X) + mod(bz, CHUNK_Z) * CHUNK_X]).name
      : '—';
    const light = this.world.getLight(bx, by + 1, bz);
    const hours = Math.floor(this.dayTime * 24);
    const minutes = Math.floor(((this.dayTime * 24) % 1) * 60);
    this.hud.setDebug(
      `VoxelCraft — ${this.fps.toFixed(0)} FPS\n` +
      `XYZ ${p.position.x.toFixed(2)} / ${p.position.y.toFixed(2)} / ${p.position.z.toFixed(2)}\n` +
      `Chunk ${floorDiv(bx, CHUNK_X)}, ${floorDiv(bz, CHUNK_Z)}   ` +
      `${this.dimension === 'overworld' ? `Biome ${biome}` : this.dimension === 'nether' ? 'Nether' : 'End'}\n` +
      `Lumière ciel ${light >> 4} · blocs ${light & 15}\n` +
      `Heure ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}  (jour ${this.skyState.dayFactor.toFixed(2)})\n` +
      `Chunks ${s.meshed}/${s.loaded} · gén ${s.pendingGen} · maillage ${s.pendingMesh} · upload ${s.uploadQueue}\n` +
      `Triangles ${(s.triangles / 1000).toFixed(1)}k · lumière en file ${Math.round(this.world.lightPending)}\n` +
      `Entités ${this.mobs.length} créatures, ${this.drops.length} objets\n` +
      `Mode ${p.mode === 1 ? 'créatif' : p.mode === 2 ? 'spectateur' : 'survie'}${p.flying ? ' (vol)' : ''}` +
      (this.worldType === 'oneblock' ? `\nOneblock — bloc n° ${this.oneblockCount}, phase « ${this.oneblockPhase} »` +
        `${this.nextPhaseIn() >= 0 ? ` (suivante dans ${this.nextPhaseIn()})` : ''}` : ''),
    );
  }

  // --- Rendu --------------------------------------------------------------

  /**
   * Rend la profondeur de la scène vue du soleil. Le ciel, les particules, la
   * météo et l'objet tenu en main sont exclus : ils ne projettent pas d'ombre.
   */
  private renderShadowPass(): void {
    const strength = this.shadowStrength();
    this.env.uShadowStrength.value = strength;
    if (strength <= 0 || !this.shadowMaterial) {
      this.env.uShadowMap.value = null;
      return;
    }

    const radius = Math.min(110, Math.max(48, this.settings.renderDistance * CHUNK_X * 0.55));
    this.shadows.setRadius(radius);
    this.shadows.update(this.skyState.sunDir, this.player.position, this.player.forward);
    this.env.uShadowMatrix.value.copy(this.shadows.matrix);
    this.env.uShadowTexel.value = 1 / this.shadows.size;
    this.env.uShadowRadius.value = radius;

    const skyVisible = this.sky.mesh.visible;
    const particlesVisible = this.particles.mesh.visible;
    const weatherVisible = this.weather.points.visible;
    const heldVisible = this.heldView.group.visible;
    const outlineVisible = this.outline.visible;
    this.sky.mesh.visible = false;
    this.particles.mesh.visible = false;
    this.weather.points.visible = false;
    this.heldView.group.visible = false;
    this.outline.visible = false;
    this.breakOverlay.visible = false;

    this.chunks.beginShadowPass(this.shadowMaterial);
    this.scene.overrideMaterial = this.shadowMaterial;
    this.renderer.setRenderTarget(this.shadows.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.shadows.camera);
    this.scene.overrideMaterial = null;
    this.chunks.endShadowPass();

    this.sky.mesh.visible = skyVisible;
    this.particles.mesh.visible = particlesVisible;
    this.weather.points.visible = weatherVisible;
    this.heldView.group.visible = heldVisible;
    this.outline.visible = outlineVisible;

    this.env.uShadowMap.value = this.shadows.depthTexture;
  }

  /** Les ombres s'effacent au crépuscule : rasantes, elles deviennent fausses. */
  private shadowStrength(): number {
    if (!this.settings.shadows) return 0;
    // Ni le Nether ni l'End n'ont de soleil : pas d'ombres portées non plus.
    if (this.dimension !== 'overworld') return 0;
    const elev = this.skyState.sunDir.y;
    return Math.max(0, Math.min(1, (elev - 0.06) / 0.18)) * 0.92;
  }

  private render(): void {
    if (!this.post) return;
    if (this.sessionReady && this.worldReady) {
      this.renderShadowPass();
      this.renderer.setRenderTarget(this.post.renderTarget);
      // Hors de l'Overworld il n'y a pas de ciel à dessiner : on efface
      // directement avec la couleur de brume, et le brouillard fait le reste.
      const other = this.dimension !== 'overworld';
      this.sky.mesh.visible = !other;
      if (other) this.renderer.setClearColor(this.dimension === 'nether' ? 0x2a0d0a : 0x07060e, 1);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      // Ni soleil ni rayons crépusculaires ailleurs que dans l'Overworld.
      const vis = other ? 0 : projectSun(this.skyState.sunDir, this.camera, sunScreen) * this.skyState.dayFactor;
      this.post.render(sunScreen, vis);
    } else {
      // Menus : fond animé simple.
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0x0b0e14, 1);
      this.renderer.clear();
    }
  }

  // --- Persistance --------------------------------------------------------

  private async persist(final: boolean): Promise<void> {
    if (!this.save) return;
    this.save.meta.playtime = this.playtime;
    this.save.meta.dayTime = this.dayTime;
    this.save.meta.lastPlayed = Date.now();
    this.save.meta.mode = this.player.mode;
    // Modifications encore en mémoire dans les chunks chargés.
    for (const c of this.world.chunks.values()) {
      if (c.edits && c.edits.size) this.save.storeEdits(c.cx, c.cz, c.edits);
    }
    const state: PlayerSave = {
      x: this.player.position.x, y: this.player.position.y, z: this.player.position.z,
      yaw: this.player.yaw, pitch: this.player.pitch,
      health: this.player.stats.health, food: this.player.stats.food,
      saturation: this.player.stats.saturation, xp: this.player.stats.xp, level: this.player.stats.level,
      mode: this.player.mode, selected: this.inventory.selected,
      main: this.inventory.main.serialize(), armor: this.inventory.armor.serialize(),
      spawn: [this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z],
    };
    this.save.meta.dimension = this.dimension;
    this.save.meta.returnPos = this.returnPos
      ? [this.returnPos.x, this.returnPos.y, this.returnPos.z]
      : undefined;
    await this.save.savePlayer(state);
    await this.save.saveEntities(this.dimension, this.serializeEntities());
    await this.save.flush();
    if (final) this.hud.toast('Partie sauvegardée.');
  }
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const tmpVec = new Vector3();
const tmpVec2 = new Vector3();
const tmpColor = new Color();
const sunScreen = new Vector2();

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function hashSeed(text: string): number {
  const n = Number(text);
  if (Number.isFinite(n) && text.trim() !== '') return n | 0;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h | 0;
}

/** Intersection rayon / boîte alignée ; renvoie la distance ou null. */
function rayBox(o: Vector3, d: Vector3, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number | null {
  let tmin = 0;
  let tmax = Infinity;
  const origin = [o.x, o.y, o.z];
  const dir = [d.x, d.y, d.z];
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-8) {
      if (origin[i] < lo[i] || origin[i] > hi[i]) return null;
      continue;
    }
    const inv = 1 / dir[i];
    let t1 = (lo[i] - origin[i]) * inv;
    let t2 = (hi[i] - origin[i]) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Cube unitaire au format d'attributs du terrain, pour l'objet tenu en main. */
function buildBlockCubeGeometry(blockId: number): BufferGeometry {
  const def = BLOCKS[blockId];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tints: number[] = [];
  const data: number[] = [];
  const indices: number[] = [];
  const tint = def.tint || 0xffffff;
  const faces: [number[], number[], number[][]][] = [
    [[0, 1, 0], [0, 0, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [0, 0, 0], [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]]],
    [[0, 0, 1], [0, 0, 0], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [0, 0, 0], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
    [[1, 0, 0], [0, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
    [[-1, 0, 0], [0, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  ];
  let v = 0;
  for (const [n, , corners] of faces) {
    const layer = n[1] > 0 ? def.layers.top : n[1] < 0 ? def.layers.bottom : def.layers.side;
    const packed = layer | (3 << 9) | (15 << 11) | (0 << 15);
    for (let i = 0; i < 4; i++) {
      positions.push(corners[i][0] - 0.5, corners[i][1] - 0.5, corners[i][2] - 0.5);
      normals.push(n[0], n[1], n[2]);
      uvs.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0);
      tints.push((tint >> 16) & 255, (tint >> 8) & 255, tint & 255);
      data.push(packed);
    }
    indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Int8Array(normals.map((x) => x * 127)), 3, true));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('tint', new BufferAttribute(new Uint8Array(tints), 3, true));
  g.setAttribute('vdata', new BufferAttribute(new Float32Array(data), 1));
  g.setIndex(indices);
  return g;
}
