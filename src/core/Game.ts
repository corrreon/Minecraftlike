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
  floorDiv,
  mod,
  voxelIndex,
} from './constants';
import { Input } from './Input';
import { isTouchDevice, loadSettings, saveSettings, type Settings } from './Settings';
import { AudioEngine, type SoundGroup } from '../audio/Audio';
import { Mob, ItemEntity, MOBS, coloredBox, findSpawnSpot, itemColor, type MobKind } from '../entities/Entities';
import { Container, HOTBAR_SIZE, makeStack, type ItemStack } from '../items/Inventory';
import { Inventory } from '../items/Inventory';
import { ITEM_BY_KEY, SMELTING, blockDrops, breakInfo, type ItemDef } from '../items/items';
import { GameMode, Player } from '../player/Player';
import { raycast, type RaycastHit } from '../player/physics';
import { buildAtlas, type Atlas } from '../render/atlas';
import { ChunkManager } from '../render/ChunkManager';
import { createEnvUniforms, type EnvUniforms } from '../render/env';
import { createEntityMaterial } from '../render/entityMaterial';
import { createShadowMaterial, createTerrainMaterial } from '../render/materials';
import { ParticleSystem, Weather } from '../render/Particles';
import { PostFX, projectSun } from '../render/PostFX';
import { Sky, computeSkyState, createSkyState } from '../render/Sky';
import { ShadowMap } from '../render/ShadowMap';
import { openDatabase, deleteWorld as dbDeleteWorld, listWorlds, SaveManager, type PlayerSave, type WorldMeta } from '../save/SaveManager';
import { BLOCKS, IS_SOLID, RenderKind, block as blockDef } from '../world/blocks';
import { biomeDef } from '../world/biomes';
import { ChunkState } from '../world/Chunk';
import { World } from '../world/World';
import { WorkerPool } from '../world/WorkerPool';
import { Hud } from '../ui/Hud';
import { Screens, type FurnaceState } from '../ui/Screens';
import { buildIcons } from '../ui/icons';
import { mulberry32 } from '../world/noise';

const MOB_TICK = 1.8;
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
  private rainTarget = 0;
  private rainLevel = 0;
  private weatherTimer = 120;

  // Interaction.
  private breakProgress = 0;
  private breakKey = '';
  private placeCooldown = 0;
  private attackCooldown = 0;
  private outline: LineSegments;
  private breakOverlay: Mesh;
  private heldView: HeldView;
  private playerModel: Group;
  private spawnPoint = new Vector3(0, 80, 0);
  private worldReady = false;
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
      createWorld: (name, seed, mode) => void this.createWorld(name, seed, mode),
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

  private async createWorld(name: string, seedText: string, mode: number): Promise<void> {
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
    };
    await this.startWorld(meta, true);
  }

  private async startWorld(meta: WorldMeta, isNew = false): Promise<void> {
    this.teardownWorld();
    this.screens.show('none');
    this.setLoading(true, 'Génération du monde…');

    meta.lastPlayed = Date.now();
    this.save = await SaveManager.load(this.db, meta);
    if (isNew) await this.save.createOrUpdateMeta();

    this.rnd = mulberry32(meta.seed ^ 0x9e3779b9);
    this.world = new World(meta.seed);
    this.pool = new WorkerPool(meta.seed);
    this.particles = new ParticleSystem(this.world);
    this.scene.add(this.particles.mesh);

    const materials = {
      opaque: createTerrainMaterial('opaque', this.atlas.texture, this.env),
      cutout: createTerrainMaterial('cutout', this.atlas.texture, this.env),
      water: createTerrainMaterial('water', this.atlas.texture, this.env),
    };
    this.shadowMaterial = createShadowMaterial(this.atlas.texture, this.env);
    this.chunks = new ChunkManager(this.world, this.pool, materials, this.save);
    this.chunks.renderDistance = this.settings.renderDistance;
    this.scene.add(this.chunks.group);

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
    this.paused = false;
    this.hud.show(true);
    this.hud.updateHotbar(this.inventory, true);
    this.audio.resume();
    this.applySettings();
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
    if (this.chunks) {
      this.chunks.dispose();
      this.scene.remove(this.chunks.group);
    }
    if (this.pool) this.pool.dispose();
    if (this.particles) this.scene.remove(this.particles.mesh);
    for (const m of this.mobs) { this.entityGroup.remove(m.group); m.dispose(); }
    for (const d of this.drops) { this.entityGroup.remove(d.object); d.dispose(); }
    this.mobs = [];
    this.drops = [];
    this.blockEntities.clear();
    this.worldReady = false;
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
    const input = document.createElement('input');
    input.id = 'console-input';
    input.type = 'text';
    c.appendChild(log);
    c.appendChild(input);
    document.body.appendChild(c);
    this.consoleEl = c;
    this.consoleLog = log;
    this.consoleInput = input;

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = input.value.trim();
        input.value = '';
        if (text) this.runCommand(text);
        this.closeConsole();
      } else if (e.key === 'Escape') {
        this.closeConsole();
      }
    });
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
        else if (Number.isFinite(Number(a))) this.dayTime = mod(Number(a), 1);
        this.echo(`Heure : ${this.dayTime.toFixed(2)}`);
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
        for (const m of this.mobs) { m.dead = true; n++; }
        this.echo(`${n} créature(s) supprimée(s).`);
        break;
      }
      case 'aide':
      case 'help':
        this.echo('/gamemode /tp /time /give /meteo /seed /tuer');
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

    if (this.save) this.update(dt);
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
        this.placePlayerOnGround();
        this.worldReady = true;
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
    }
    if (this.player.dead && this.screens.active !== 'death') {
      this.audio.hurt();
      this.screens.show('death');
    }

    // Temps, météo, ciel.
    if (active) this.dayTime = (this.dayTime + dt / DAY_LENGTH_SECONDS) % 1;
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

    // Entités.
    this.updateEntities(dt, active);
    this.updateBlockEntities(dt);
    if (this.settings.particles) this.particles.update(dt, this.skyState.dayFactor);

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

  private touchHandlers() {
    return {
      onJump: (v: boolean) => this.input.setVirtual('jump', v),
      onSneak: (v: boolean) => this.input.setVirtual('sneak', v),
      onAttack: (v: boolean) => this.input.setVirtual('attack', v),
      onUse: (v: boolean) => this.input.setVirtual('use', v),
      onInventory: () => this.openInventory('inventory'),
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

    // --- Attaque / minage ---
    if (st.attack) {
      const mob = this.pickMob(eye, dir, reach);
      this.lastAimedMob = mob ? mob.kind : null;
      if (mob && this.attackCooldown <= 0) {
        this.attackCooldown = 0.42;
        this.hitMob(mob);
        this.heldView.swing = 1;
        this.breakProgress = 0;
      } else if (hit) {
        this.mineBlock(hit, dt);
      } else {
        this.breakProgress = 0;
        this.breakOverlay.visible = false;
        if (this.attackCooldown <= 0) { this.attackCooldown = 0.28; this.heldView.swing = 1; }
      }
    } else {
      this.breakProgress = 0;
      this.breakKey = '';
      this.breakOverlay.visible = false;
    }

    // --- Utilisation ---
    if (st.use && this.placeCooldown <= 0) {
      this.placeCooldown = 0.22;
      this.useItem(hit);
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
      this.breakOverlay.visible = false;
    }
  }

  private destroyBlock(hit: RaycastHit, harvest: boolean): void {
    const def = blockDef(hit.block);
    const creative = this.player.mode === GameMode.Creative;
    this.setBlock(hit.x, hit.y, hit.z, 0);
    this.audio.break(def.sound as SoundGroup);
    if (this.settings.particles) {
      this.particles.burstBlock(hit.x, hit.y, hit.z, this.atlas.tileAverage(def.layers.side), 16);
    }
    if (!creative) {
      for (const d of blockDrops(hit.block, harvest, () => this.rnd())) {
        this.spawnDrop(hit.x + 0.5, hit.y + 0.25, hit.z + 0.5, makeStack(d.item, d.count));
      }
      const held = this.inventory.selectedStack;
      if (held?.item.tool) {
        if (this.inventory.damageSelected(1)) this.audio.break('wood');
      }
      this.player.addXp(def.hardness > 2.5 ? 2 : 0);
    }
    // Support des blocs posés dessus (fleurs, torches, neige).
    this.dropUnsupported(hit.x, hit.y + 1, hit.z);
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

    // Interaction avec un bloc « conteneur ».
    if (hit && !this.player.sneaking) {
      const key = blockDef(hit.block).key;
      if (key === 'crafting_table') { this.openInventory('crafting'); return; }
      if (key === 'furnace') { this.openContainer(hit, 'furnace'); return; }
      if (key === 'chest') { this.openContainer(hit, 'chest'); return; }
    }

    if (!stackHeld) return;
    const item = stackHeld.item;

    // Nourriture.
    if (item.food && this.player.mode === GameMode.Survival && this.player.stats.food < 20) {
      this.player.eat(item.food.hunger, item.food.saturation);
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

    this.setBlock(nx, ny, nz, item.block);
    this.audio.place(blockDef(item.block).sound as SoundGroup);
    this.heldView.swing = 1;
    if (this.player.mode !== GameMode.Creative) this.inventory.main.consume(this.inventory.selected);
    this.applyGravityBlocks(nx, ny, nz);
  }

  private openContainer(hit: RaycastHit, kind: 'furnace' | 'chest'): void {
    const key = `${hit.x},${hit.y},${hit.z}`;
    let be = this.blockEntities.get(key);
    if (!be) {
      be = kind === 'chest'
        ? new Container(27)
        : { input: new Container(1), fuel: new Container(1), output: new Container(1), burn: 0, burnMax: 0, progress: 0 };
      this.blockEntities.set(key, be);
    }
    this.openBlockPos = key;
    this.input.exitLock();
    this.screens.show(kind);
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
    if (this.drops.length > 220) {
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
    m.velocity.y = Math.max(m.velocity.y, 3.4);
    if (held?.item.durability) this.inventory.damageSelected(1);
    if (killed) {
      for (const d of m.rollDrops()) this.spawnDrop(d.x, d.y, d.z, d.stack);
      this.player.addXp(m.def.xp);
    }
  }

  private updateEntities(dt: number, active: boolean): void {
    if (!active) return;
    const maxDist = this.settings.entityDistance;
    const dayFactor = this.skyState.dayFactor;

    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const m = this.mobs[i];
      const dist = m.position.distanceTo(this.player.position);
      if (m.dead || dist > 110) {
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
    }

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.update(dt, this.world, this.player.position, dayFactor);
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

    this.mobTimer += dt;
    if (this.mobTimer >= MOB_TICK) {
      this.mobTimer = 0;
      this.trySpawnMob();
    }
  }

  private trySpawnMob(): void {
    if (this.mobs.length >= this.settings.maxMobs) return;
    if (this.player.mode === GameMode.Spectator) return;
    const night = this.skyState.dayFactor < 0.25;
    const hostile = night ? Math.random() < 0.75 : Math.random() < 0.2;
    const kinds: MobKind[] = hostile ? ['zombie', 'skeleton', 'creeper', 'spider'] : ['pig', 'cow', 'sheep', 'chicken'];
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
    const m = new Mob(kind, spot.x, spot.y, spot.z, this.env, (Math.random() * 1e9) | 0);
    this.mobs.push(m);
    this.entityGroup.add(m.group);
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
      const mat = createTerrainMaterial('cutout', this.atlas.texture, this.env);
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
      `Chunk ${floorDiv(bx, CHUNK_X)}, ${floorDiv(bz, CHUNK_Z)}   Biome ${biome}\n` +
      `Lumière ciel ${light >> 4} · blocs ${light & 15}\n` +
      `Heure ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}  (jour ${this.skyState.dayFactor.toFixed(2)})\n` +
      `Chunks ${s.meshed}/${s.loaded} · gén ${s.pendingGen} · maillage ${s.pendingMesh} · upload ${s.uploadQueue}\n` +
      `Triangles ${(s.triangles / 1000).toFixed(1)}k · lumière en file ${Math.round(this.world.lightPending)}\n` +
      `Entités ${this.mobs.length} créatures, ${this.drops.length} objets\n` +
      `Mode ${p.mode === 1 ? 'créatif' : p.mode === 2 ? 'spectateur' : 'survie'}${p.flying ? ' (vol)' : ''}`,
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
    const elev = this.skyState.sunDir.y;
    return Math.max(0, Math.min(1, (elev - 0.06) / 0.18)) * 0.92;
  }

  private render(): void {
    if (!this.post) return;
    if (this.save && this.worldReady) {
      this.renderShadowPass();
      this.renderer.setRenderTarget(this.post.renderTarget);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      const vis = projectSun(this.skyState.sunDir, this.camera, sunScreen) * this.skyState.dayFactor;
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
    await this.save.savePlayer(state);
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
