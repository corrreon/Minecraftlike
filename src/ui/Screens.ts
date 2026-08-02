/**
 * Écrans plein cadre : menu principal, sélection de monde, options, pause,
 * inventaire/artisanat, four, coffre, mort et aide.
 */

import type { Settings } from '../core/Settings';
import { Container, HOTBAR_SIZE, MAIN_SIZE, type Inventory, type ItemStack } from '../items/Inventory';
import { ITEMS } from '../items/items';
import { findRecipe, type RecipeResult } from '../items/recipes';
import type { WorldMeta } from '../save/SaveManager';
import { renderSlot } from './Hud';
import { iconFor } from './icons';

export type ScreenName =
  | 'none' | 'menu' | 'worlds' | 'create' | 'settings' | 'pause'
  | 'inventory' | 'crafting' | 'furnace' | 'chest' | 'death' | 'help';

export interface FurnaceState {
  input: Container;
  fuel: Container;
  output: Container;
  /** Secondes de combustion restantes. */
  burn: number;
  burnMax: number;
  /** Progression de la cuisson en cours (0-1). */
  progress: number;
}

export interface ScreenContext {
  settings: Settings;
  applySettings(): void;
  listWorlds(): Promise<WorldMeta[]>;
  createWorld(name: string, seed: string, mode: number): void;
  playWorld(meta: WorldMeta): void;
  deleteWorld(id: string): Promise<void>;
  resume(): void;
  quitToMenu(): void;
  respawn(): void;
  inventory: Inventory;
  isCreative(): boolean;
  onCraft(): void;
  runCommand(cmd: string): void;
  currentFurnace(): FurnaceState | null;
  currentChest(): Container | null;
  sound(name: 'click' | 'craft'): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

interface SlotBinding {
  element: HTMLElement;
  container: Container;
  index: number;
  readonly?: boolean;
  onTake?: (all: boolean) => void;
}

export class Screens {
  private root: HTMLElement;
  private cursorEl: HTMLElement;
  private tooltipEl: HTMLElement;
  private current: ScreenName = 'none';
  private bindings: SlotBinding[] = [];
  private craftSize = 2;
  private craftResult: RecipeResult | null = null;
  private refreshers: (() => void)[] = [];

  constructor(private ctx: ScreenContext) {
    this.root = document.getElementById('screens')!;
    this.cursorEl = el('div', '', document.body);
    this.cursorEl.id = 'cursor-stack';
    el('img', undefined, this.cursorEl);
    el('span', 'count', this.cursorEl);
    this.tooltipEl = el('div', 'tooltip', document.body);

    window.addEventListener('mousemove', (e) => {
      this.cursorEl.style.left = `${e.clientX}px`;
      this.cursorEl.style.top = `${e.clientY}px`;
      if (this.tooltipEl.style.display === 'block') {
        this.tooltipEl.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 250)}px`;
        this.tooltipEl.style.top = `${e.clientY + 16}px`;
      }
    });
  }

  get active(): ScreenName {
    return this.current;
  }

  get isOpen(): boolean {
    return this.current !== 'none';
  }

  /** Un écran de « jeu » (inventaire, four…) plutôt qu'un menu. */
  get isGameOverlay(): boolean {
    return this.current === 'inventory' || this.current === 'crafting' || this.current === 'furnace' || this.current === 'chest';
  }

  show(name: ScreenName): void {
    this.current = name;
    this.bindings = [];
    this.refreshers = [];
    this.root.innerHTML = '';
    this.hideTooltip();
    if (name === 'none') {
      this.root.classList.remove('open');
      this.updateCursor();
      return;
    }
    this.root.classList.add('open');
    switch (name) {
      case 'menu': this.buildMenu(); break;
      case 'worlds': void this.buildWorlds(); break;
      case 'create': this.buildCreate(); break;
      case 'settings': this.buildSettings(); break;
      case 'pause': this.buildPause(); break;
      case 'inventory': this.buildInventory(2); break;
      case 'crafting': this.buildInventory(3); break;
      case 'furnace': this.buildFurnace(); break;
      case 'chest': this.buildChest(); break;
      case 'death': this.buildDeath(); break;
      case 'help': this.buildHelp(); break;
    }
    this.refreshAll();
  }

  refreshAll(): void {
    for (const b of this.bindings) renderSlot(b.element, b.container.get(b.index));
    for (const r of this.refreshers) r();
    this.updateCursor();
  }

  // --- Menu principal -----------------------------------------------------

  private buildMenu(): void {
    const s = el('div', 'screen menu', this.root);
    const p = el('div', 'panel', s);
    const h = el('h1', undefined, p);
    h.textContent = 'VOXELCRAFT';
    const sub = el('p', 'sub', p);
    sub.textContent = 'Bac à sable voxel — monde infini, artisanat, survie.';
    this.button(p, 'Jouer', 'primary', () => this.show('worlds'));
    this.button(p, 'Nouveau monde', '', () => this.show('create'));
    this.button(p, 'Options', '', () => this.show('settings'));
    this.button(p, 'Commandes & aide', '', () => this.show('help'));
  }

  private async buildWorlds(): Promise<void> {
    const s = el('div', 'screen menu', this.root);
    const p = el('div', 'panel', s);
    el('h1', undefined, p).textContent = 'MONDES';
    el('p', 'sub', p).textContent = 'Sélectionnez un monde à charger.';
    const list = el('div', 'world-list', p);
    const worlds = await this.ctx.listWorlds();
    if (!worlds.length) {
      el('div', 'empty-note', list).textContent = 'Aucun monde enregistré pour l’instant.';
    }
    for (const w of worlds) {
      const item = el('div', 'world-item', list);
      const meta = el('div', 'meta', item);
      el('div', 'name', meta).textContent = w.name;
      const modeName = w.mode === 1 ? 'Créatif' : w.mode === 2 ? 'Spectateur' : 'Survie';
      el('div', 'info', meta).textContent =
        `${modeName} · graine ${w.seed} · ${formatDuration(w.playtime)} · ${new Date(w.lastPlayed).toLocaleDateString()}`;
      item.addEventListener('click', () => this.ctx.playWorld(w));
      const del = el('button', 'btn small danger', item);
      del.textContent = 'Supprimer';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Supprimer définitivement « ${w.name} » ?`)) return;
        await this.ctx.deleteWorld(w.id);
        this.show('worlds');
      });
    }
    this.button(p, 'Nouveau monde', 'primary', () => this.show('create'));
    this.button(p, 'Retour', '', () => this.show('menu'));
  }

  private buildCreate(): void {
    const s = el('div', 'screen menu', this.root);
    const p = el('div', 'panel', s);
    el('h1', undefined, p).textContent = 'NOUVEAU MONDE';
    el('p', 'sub', p).textContent = 'Une graine identique reproduit exactement le même terrain.';

    const nameField = el('label', 'field', p);
    el('span', undefined, nameField).textContent = 'Nom du monde';
    const nameInput = el('input', undefined, nameField);
    nameInput.type = 'text';
    nameInput.value = randomWorldName();

    const seedField = el('label', 'field', p);
    el('span', undefined, seedField).textContent = 'Graine (vide = aléatoire)';
    const seedInput = el('input', undefined, seedField);
    seedInput.type = 'text';
    seedInput.placeholder = 'ex. 12345 ou « montagnes »';

    const modeField = el('label', 'field', p);
    el('span', undefined, modeField).textContent = 'Mode de jeu';
    const modeSelect = el('select', undefined, modeField);
    for (const [v, label] of [['0', 'Survie'], ['1', 'Créatif'], ['2', 'Spectateur']] as const) {
      const o = el('option', undefined, modeSelect);
      o.value = v;
      o.textContent = label;
    }

    this.button(p, 'Créer et jouer', 'primary', () => {
      this.ctx.createWorld(nameInput.value.trim() || 'Nouveau monde', seedInput.value.trim(), Number(modeSelect.value));
    });
    this.button(p, 'Retour', '', () => this.show('menu'));
  }

  // --- Options ------------------------------------------------------------

  private buildSettings(): void {
    const s = el('div', 'screen', this.root);
    const p = el('div', 'panel wide', s);
    el('h1', undefined, p).textContent = 'OPTIONS';
    const st = this.ctx.settings;

    el('h2', undefined, p).textContent = 'Affichage';
    this.slider(p, 'Distance de rendu', st.renderDistance, 2, 20, 1, (v) => { st.renderDistance = v; }, (v) => `${v} chunks`);
    this.slider(p, 'Champ de vision', st.fov, 55, 110, 1, (v) => { st.fov = v; }, (v) => `${v}°`);
    this.slider(p, 'Échelle de résolution', st.resolutionScale, 0.5, 2, 0.05, (v) => { st.resolutionScale = v; }, (v) => `${Math.round(v * 100)} %`);
    this.slider(p, 'Échelle de l’interface', st.guiScale, 0.7, 1.6, 0.05, (v) => { st.guiScale = v; }, (v) => `${Math.round(v * 100)} %`);
    this.toggle(p, 'Éclairage lissé', st.smoothLighting, (v) => { st.smoothLighting = v; });
    this.toggle(p, 'Nuages', st.clouds, (v) => { st.clouds = v; });
    this.toggle(p, 'Météo', st.weather, (v) => { st.weather = v; });
    this.toggle(p, 'Particules', st.particles, (v) => { st.particles = v; });
    this.toggle(p, 'Oscillation de la caméra', st.viewBobbing, (v) => { st.viewBobbing = v; });

    el('h2', undefined, p).textContent = 'Effets';
    this.toggle(p, 'Bloom', st.bloom, (v) => { st.bloom = v; });
    this.toggle(p, 'Rayons crépusculaires', st.godRays, (v) => { st.godRays = v; });
    this.toggle(p, 'Anticrénelage (FXAA)', st.fxaa, (v) => { st.fxaa = v; });

    el('h2', undefined, p).textContent = 'Contrôles';
    this.slider(p, 'Sensibilité', st.sensitivity, 0.2, 3, 0.05, (v) => { st.sensitivity = v; }, (v) => v.toFixed(2));
    this.toggle(p, 'Inverser l’axe vertical', st.invertY, (v) => { st.invertY = v; });
    this.toggle(p, 'Saut automatique', st.autoJump, (v) => { st.autoJump = v; });
    this.toggle(p, 'Afficher les FPS', st.showFps, (v) => { st.showFps = v; });

    el('h2', undefined, p).textContent = 'Audio';
    this.slider(p, 'Volume général', st.masterVolume, 0, 1, 0.05, (v) => { st.masterVolume = v; }, (v) => `${Math.round(v * 100)} %`);
    this.slider(p, 'Effets', st.sfxVolume, 0, 1, 0.05, (v) => { st.sfxVolume = v; }, (v) => `${Math.round(v * 100)} %`);
    this.slider(p, 'Ambiance', st.musicVolume, 0, 1, 0.05, (v) => { st.musicVolume = v; }, (v) => `${Math.round(v * 100)} %`);
    this.toggle(p, 'Couper le son', st.muted, (v) => { st.muted = v; });

    el('h2', undefined, p).textContent = 'Monde';
    this.slider(p, 'Créatures maximum', st.maxMobs, 0, 120, 5, (v) => { st.maxMobs = v; }, (v) => String(v));
    this.slider(p, 'Distance d’affichage des entités', st.entityDistance, 16, 128, 4, (v) => { st.entityDistance = v; }, (v) => `${v} m`);

    this.button(p, 'Retour', 'primary', () => this.show(this.previous));
  }

  /** Écran vers lequel revenir depuis les options. */
  previous: ScreenName = 'menu';

  private buildPause(): void {
    const s = el('div', 'screen', this.root);
    const p = el('div', 'panel', s);
    el('h1', undefined, p).textContent = 'PAUSE';
    this.button(p, 'Reprendre', 'primary', () => this.ctx.resume());
    this.button(p, 'Options', '', () => { this.previous = 'pause'; this.show('settings'); });
    this.button(p, 'Commandes & aide', '', () => { this.previous = 'pause'; this.show('help'); });
    this.button(p, 'Sauvegarder et quitter', 'danger', () => this.ctx.quitToMenu());
  }

  private buildDeath(): void {
    const s = el('div', 'screen death', this.root);
    const p = el('div', 'panel', s);
    el('h1', undefined, p).textContent = 'VOUS ÊTES MORT';
    el('p', 'sub', p).textContent = 'Votre inventaire a été conservé.';
    this.button(p, 'Réapparaître', 'primary', () => this.ctx.respawn());
    this.button(p, 'Retour au menu', '', () => this.ctx.quitToMenu());
  }

  private buildHelp(): void {
    const s = el('div', 'screen', this.root);
    const p = el('div', 'panel wide', s);
    el('h1', undefined, p).textContent = 'AIDE';
    el('h2', undefined, p).textContent = 'Contrôles';
    const g = el('div', 'help-grid', p);
    const rows: [string, string][] = [
      ['Z Q S D / W A S D', 'Se déplacer'],
      ['Espace', 'Sauter — double appui : voler (créatif)'],
      ['Maj', 'S’accroupir / descendre en vol'],
      ['Ctrl', 'Courir'],
      ['Clic gauche', 'Casser un bloc / attaquer'],
      ['Clic droit', 'Poser un bloc / utiliser'],
      ['Molette, 1-9', 'Changer d’objet'],
      ['E', 'Inventaire'],
      ['F', 'Vue à la troisième personne'],
      ['F3', 'Informations de débogage'],
      ['T ou /', 'Console de commandes'],
      ['Échap', 'Pause'],
    ];
    for (const [k, v] of rows) {
      const b = el('b', undefined, g);
      b.innerHTML = k
        .split(' ')
        .map((part) => (part === '/' || part === 'ou' ? part : `<kbd>${part}</kbd>`))
        .join(' ');
      el('span', undefined, g).textContent = v;
    }
    el('h2', undefined, p).textContent = 'Commandes';
    const g2 = el('div', 'help-grid', p);
    const cmds: [string, string][] = [
      ['/gamemode survie|creatif|spectateur', 'Changer de mode'],
      ['/tp x y z', 'Se téléporter'],
      ['/time jour|nuit|<0-1>', 'Régler l’heure'],
      ['/give <objet> [n]', 'Obtenir un objet'],
      ['/meteo clair|pluie', 'Changer la météo'],
      ['/seed', 'Afficher la graine'],
      ['/tuer', 'Supprimer les créatures proches'],
      ['/aide', 'Liste des commandes'],
    ];
    for (const [k, v] of cmds) {
      el('b', undefined, g2).textContent = k;
      el('span', undefined, g2).textContent = v;
    }
    this.button(p, 'Retour', 'primary', () => this.show(this.previous));
  }

  // --- Inventaire ---------------------------------------------------------

  private buildInventory(craftSize: number): void {
    this.craftSize = craftSize;
    const inv = this.ctx.inventory;
    const s = el('div', 'screen', this.root);
    const p = el('div', 'panel wide', s);
    el('h1', undefined, p).textContent = craftSize === 3 ? 'ÉTABLI' : 'INVENTAIRE';

    if (this.ctx.isCreative()) {
      this.buildCreativePicker(p);
    } else {
      // Zone d'artisanat.
      const area = el('div', 'craft-area', p);
      const grid = el('div', `craft-grid g${craftSize}`, area);
      for (let i = 0; i < craftSize * craftSize; i++) {
        const idx = craftGridIndex(i, craftSize);
        this.slot(grid, inv.crafting, idx, { onChange: () => this.updateCraftResult() });
      }
      el('div', 'arrow', area).textContent = '→';
      const resultWrap = el('div', undefined, area);
      const result = el('div', 'slot interactive result', resultWrap);
      el('img', undefined, result);
      el('span', 'count', result);
      this.resultSlot = result;
      result.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.takeCraftResult(e.shiftKey);
      });
      this.refreshers.push(() => this.updateCraftResult());
    }

    // Armure.
    const armorSec = el('div', 'inv-section', p);
    el('h3', undefined, armorSec).textContent = 'Armure';
    const armorGrid = el('div', 'inv-grid', armorSec);
    armorGrid.style.gridTemplateColumns = 'repeat(4, 44px)';
    for (let i = 0; i < 4; i++) this.slot(armorGrid, inv.armor, i, {});

    // Sac principal.
    const mainSec = el('div', 'inv-section', p);
    el('h3', undefined, mainSec).textContent = 'Inventaire';
    const mainGrid = el('div', 'inv-grid', mainSec);
    for (let i = HOTBAR_SIZE; i < MAIN_SIZE; i++) this.slot(mainGrid, inv.main, i, {});

    const hotSec = el('div', 'inv-section', p);
    el('h3', undefined, hotSec).textContent = 'Barre rapide';
    const hotGrid = el('div', 'inv-grid', hotSec);
    for (let i = 0; i < HOTBAR_SIZE; i++) this.slot(hotGrid, inv.main, i, {});

    this.button(p, 'Fermer', '', () => this.ctx.resume());
  }

  private resultSlot: HTMLElement | null = null;

  private buildCreativePicker(parent: HTMLElement): void {
    const sec = el('div', 'inv-section', parent);
    el('h3', undefined, sec).textContent = 'Tous les objets — clic pour prendre une pile';
    const search = el('input', undefined, sec);
    search.type = 'text';
    search.placeholder = 'Rechercher…';
    search.style.marginBottom = '8px';
    const grid = el('div', 'creative-grid', sec);

    const render = (filter: string) => {
      grid.innerHTML = '';
      const f = filter.trim().toLowerCase();
      for (const def of ITEMS) {
        if (def.id === 0) continue;
        if (f && !def.name.toLowerCase().includes(f) && !def.key.includes(f)) continue;
        const slot = el('div', 'slot interactive', grid);
        el('img', undefined, slot);
        el('span', 'count', slot);
        renderSlot(slot, { item: def, count: 1, damage: 0 });
        slot.title = def.name;
        slot.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const inv = this.ctx.inventory;
          inv.held = { item: def, count: e.button === 2 ? 1 : def.maxStack, damage: 0 };
          this.updateCursor();
          this.ctx.sound('click');
        });
        slot.addEventListener('contextmenu', (e) => e.preventDefault());
      }
    };
    render('');
    search.addEventListener('input', () => render(search.value));
  }

  private updateCraftResult(): void {
    if (!this.resultSlot) return;
    const inv = this.ctx.inventory;
    const size = this.craftSize;
    const grid: (string | null)[] = [];
    for (let i = 0; i < size * size; i++) {
      const s = inv.crafting.get(craftGridIndex(i, size));
      grid.push(s ? s.item.key : null);
    }
    this.craftResult = findRecipe(grid, size);
    renderSlot(this.resultSlot, this.craftResult ? { item: this.craftResult.item, count: this.craftResult.count, damage: 0 } : null);
  }

  private takeCraftResult(all: boolean): void {
    const inv = this.ctx.inventory;
    if (!this.craftResult) return;
    let iterations = 1;
    if (all) iterations = 64;
    let made = 0;
    for (let n = 0; n < iterations; n++) {
      if (!this.craftResult) break;
      const out: ItemStack = { item: this.craftResult.item, count: this.craftResult.count, damage: 0 };
      if (all || inv.held === null) {
        if (all) {
          const left = inv.give(out);
          if (left) break;
        } else {
          inv.held = out;
        }
      } else if (inv.held.item === out.item && inv.held.count + out.count <= out.item.maxStack) {
        inv.held.count += out.count;
      } else {
        break;
      }
      // Consomme un exemplaire de chaque ingrédient.
      for (let i = 0; i < this.craftSize * this.craftSize; i++) {
        inv.crafting.consume(craftGridIndex(i, this.craftSize));
      }
      made++;
      this.updateCraftResult();
      if (!this.craftResult) break;
    }
    if (made > 0) {
      this.ctx.sound('craft');
      this.ctx.onCraft();
      this.refreshAll();
    }
  }

  // --- Four et coffre -----------------------------------------------------

  private buildFurnace(): void {
    const f = this.ctx.currentFurnace();
    const inv = this.ctx.inventory;
    const s = el('div', 'screen', this.root);
    const p = el('div', 'panel', s);
    el('h1', undefined, p).textContent = 'FOUR';
    if (!f) {
      el('p', 'sub', p).textContent = 'Four introuvable.';
      this.button(p, 'Fermer', '', () => this.ctx.resume());
      return;
    }

    const layout = el('div', 'furnace-layout', p);
    const left = el('div', 'furnace-col', layout);
    this.slot(left, f.input, 0, {});
    const flame = el('div', 'flame', left);
    const flameBar = el('i', undefined, flame);
    this.slot(left, f.fuel, 0, {});

    const mid = el('div', 'furnace-col', layout);
    const arrow = el('div', 'progress-arrow', mid);
    const arrowBar = el('i', undefined, arrow);

    const right = el('div', 'furnace-col', layout);
    this.slot(right, f.output, 0, {});

    this.refreshers.push(() => {
      flameBar.style.height = `${f.burnMax > 0 ? (f.burn / f.burnMax) * 100 : 0}%`;
      arrowBar.style.width = `${f.progress * 100}%`;
    });

    const mainSec = el('div', 'inv-section', p);
    el('h3', undefined, mainSec).textContent = 'Inventaire';
    const mainGrid = el('div', 'inv-grid', mainSec);
    for (let i = HOTBAR_SIZE; i < MAIN_SIZE; i++) this.slot(mainGrid, inv.main, i, {});
    const hotGrid = el('div', 'inv-grid', mainSec);
    hotGrid.style.marginTop = '6px';
    for (let i = 0; i < HOTBAR_SIZE; i++) this.slot(hotGrid, inv.main, i, {});

    this.button(p, 'Fermer', '', () => this.ctx.resume());
  }

  private buildChest(): void {
    const chest = this.ctx.currentChest();
    const inv = this.ctx.inventory;
    const s = el('div', 'screen', this.root);
    const p = el('div', 'panel wide', s);
    el('h1', undefined, p).textContent = 'COFFRE';
    if (!chest) {
      this.button(p, 'Fermer', '', () => this.ctx.resume());
      return;
    }
    const sec = el('div', 'inv-section', p);
    const grid = el('div', 'inv-grid', sec);
    for (let i = 0; i < chest.size; i++) this.slot(grid, chest, i, {});

    const mainSec = el('div', 'inv-section', p);
    el('h3', undefined, mainSec).textContent = 'Inventaire';
    const mainGrid = el('div', 'inv-grid', mainSec);
    for (let i = HOTBAR_SIZE; i < MAIN_SIZE; i++) this.slot(mainGrid, inv.main, i, {});
    const hotGrid = el('div', 'inv-grid', mainSec);
    hotGrid.style.marginTop = '6px';
    for (let i = 0; i < HOTBAR_SIZE; i++) this.slot(hotGrid, inv.main, i, {});

    this.button(p, 'Fermer', '', () => this.ctx.resume());
  }

  // --- Slots interactifs --------------------------------------------------

  private slot(parent: HTMLElement, container: Container, index: number, opts: { onChange?: () => void }): HTMLElement {
    const e = el('div', 'slot interactive', parent);
    el('img', undefined, e);
    el('span', 'count', e);
    const d = el('div', 'dura', e);
    el('i', undefined, d);
    const binding: SlotBinding = { element: e, container, index };
    this.bindings.push(binding);

    e.addEventListener('contextmenu', (ev) => ev.preventDefault());
    e.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      if (ev.shiftKey && ev.button === 0) this.quickMove(container, index);
      else if (ev.button === 0) this.leftClick(container, index);
      else if (ev.button === 2) this.rightClick(container, index);
      this.ctx.sound('click');
      opts.onChange?.();
      this.refreshAll();
    });
    e.addEventListener('mouseenter', (ev) => {
      const st = container.get(index);
      if (st) this.showTooltip(st, ev.clientX, ev.clientY);
    });
    e.addEventListener('mouseleave', () => this.hideTooltip());
    return e;
  }

  private leftClick(container: Container, index: number): void {
    const inv = this.ctx.inventory;
    const slot = container.get(index);
    const held = inv.held;
    if (!held) {
      if (slot) { inv.held = slot; container.set(index, null); }
      return;
    }
    if (!slot) {
      container.set(index, held);
      inv.held = null;
      return;
    }
    if (slot.item === held.item && !slot.item.durability) {
      const room = slot.item.maxStack - slot.count;
      const moved = Math.min(room, held.count);
      slot.count += moved;
      held.count -= moved;
      container.version++;
      if (held.count <= 0) inv.held = null;
      return;
    }
    container.set(index, held);
    inv.held = slot;
  }

  private rightClick(container: Container, index: number): void {
    const inv = this.ctx.inventory;
    const slot = container.get(index);
    const held = inv.held;
    if (!held) {
      if (!slot) return;
      const half = Math.ceil(slot.count / 2);
      inv.held = { item: slot.item, count: half, damage: slot.damage };
      slot.count -= half;
      if (slot.count <= 0) container.set(index, null);
      else container.version++;
      return;
    }
    if (!slot) {
      container.set(index, { item: held.item, count: 1, damage: held.damage });
      held.count--;
      if (held.count <= 0) inv.held = null;
      return;
    }
    if (slot.item === held.item && slot.count < slot.item.maxStack && !slot.item.durability) {
      slot.count++;
      held.count--;
      container.version++;
      if (held.count <= 0) inv.held = null;
    }
  }

  private quickMove(container: Container, index: number): void {
    const inv = this.ctx.inventory;
    const slot = container.get(index);
    if (!slot) return;
    const isMain = container === inv.main;
    let left: ItemStack | null;
    if (isMain) {
      // Barre rapide ↔ sac, ou vers le conteneur ouvert.
      const other = this.ctx.currentChest() ?? this.ctx.currentFurnace()?.input ?? null;
      if (other && this.isGameOverlay && this.current !== 'inventory' && this.current !== 'crafting') {
        left = other.add(slot);
      } else if (index < HOTBAR_SIZE) {
        left = inv.main.add(slot, [HOTBAR_SIZE, MAIN_SIZE]);
      } else {
        left = inv.main.add(slot, [0, HOTBAR_SIZE]);
      }
    } else {
      left = inv.give(slot);
    }
    container.set(index, left);
  }

  private showTooltip(s: ItemStack, x: number, y: number): void {
    this.tooltipEl.innerHTML = '';
    const t = el('div', undefined, this.tooltipEl);
    t.textContent = s.item.name;
    const parts: string[] = [];
    if (s.item.tool) parts.push(`Outil : ${s.item.tool.kind} · niveau ${s.item.tool.tier} · dégâts ${s.item.tool.damage}`);
    if (s.item.armor) parts.push(`Protection : ${s.item.armor.defense}`);
    if (s.item.food) parts.push(`Nourriture : ${s.item.food.hunger} points`);
    if (s.item.fuel) parts.push(`Combustible : ${s.item.fuel} s`);
    if (s.item.durability) parts.push(`Durabilité : ${s.item.durability - s.damage} / ${s.item.durability}`);
    if (parts.length) el('div', 't-sub', this.tooltipEl).textContent = parts.join('\n');
    this.tooltipEl.style.display = 'block';
    this.tooltipEl.style.left = `${Math.min(x + 14, window.innerWidth - 250)}px`;
    this.tooltipEl.style.top = `${y + 16}px`;
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = 'none';
  }

  updateCursor(): void {
    const held = this.ctx.inventory.held;
    if (!held || !this.isOpen) {
      this.cursorEl.style.display = 'none';
      return;
    }
    this.cursorEl.style.display = 'grid';
    const img = this.cursorEl.querySelector('img') as HTMLImageElement;
    img.src = iconFor(held.item);
    (this.cursorEl.querySelector('.count') as HTMLElement).textContent = held.count > 1 ? String(held.count) : '';
  }

  /** Rend au joueur la pile tenue par le curseur et vide la grille d'artisanat. */
  returnHeldAndCrafting(): void {
    const inv = this.ctx.inventory;
    if (inv.held) {
      inv.give(inv.held);
      inv.held = null;
    }
    for (let i = 0; i < inv.crafting.size; i++) {
      const s = inv.crafting.get(i);
      if (s) {
        inv.give(s);
        inv.crafting.set(i, null);
      }
    }
  }

  // --- Widgets ------------------------------------------------------------

  private button(parent: HTMLElement, label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', `btn ${cls}`.trim(), parent);
    b.textContent = label;
    b.addEventListener('click', () => { this.ctx.sound('click'); onClick(); });
    return b;
  }

  private toggle(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
    const row = el('div', 'setting', parent);
    el('span', undefined, row).textContent = label;
    const ctrl = el('div', 'ctrl', row);
    const sw = el('div', `switch ${value ? 'on' : ''}`.trim(), ctrl);
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('on');
      sw.classList.toggle('on', next);
      onChange(next);
      this.ctx.applySettings();
      this.ctx.sound('click');
    });
  }

  private slider(
    parent: HTMLElement,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    format: (v: number) => string,
  ): void {
    const row = el('div', 'setting', parent);
    el('span', undefined, row).textContent = label;
    const ctrl = el('div', 'ctrl', row);
    const input = el('input', undefined, ctrl);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = el('span', 'value', ctrl);
    out.textContent = format(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      onChange(v);
      this.ctx.applySettings();
    });
  }
}

/** Les grilles 2×2 utilisent les cases 0,1,3,4 du tableau 3×3 sous-jacent. */
function craftGridIndex(i: number, size: number): number {
  if (size === 3) return i;
  const x = i % 2;
  const y = (i / 2) | 0;
  return y * 3 + x;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

const NAME_A = ['Vallée', 'Plateau', 'Terres', 'Île', 'Refuge', 'Colline', 'Rive', 'Forêt'];
const NAME_B = ['dorée', 'brumeuse', 'perdue', 'du nord', 'd’émeraude', 'silencieuse', 'ancienne', 'du couchant'];

function randomWorldName(): string {
  return `${NAME_A[Math.floor(Math.random() * NAME_A.length)]} ${NAME_B[Math.floor(Math.random() * NAME_B.length)]}`;
}
