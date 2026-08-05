/** Affichage tête haute : barre rapide, jauges, débogage, notifications, tactile. */

import { HOTBAR_SIZE, type Inventory, type ItemStack } from '../items/Inventory';
import { iconFor } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * Tout ce que le clavier et la souris savent faire doit être atteignable au
 * doigt : chaque raccourci du jeu a son équivalent tactile.
 */
export interface TouchHandlers {
  onJump(down: boolean): void;
  onSneak(down: boolean): void;
  onAttack(down: boolean): void;
  onUse(down: boolean): void;
  /** Course (Ctrl au clavier) : bascule, on ne va pas maintenir le doigt. */
  onSprint(on: boolean): void;
  /** Double appui sur Sauter : bascule le vol en créatif. */
  onFly(): void;
  onInventory(): void;
  /** Sélection d'une case de la barre rapide : sans molette ni pavé numérique,
   *  c'est le seul moyen de changer d'objet sur mobile. */
  onSelectSlot(index: number): void;
  /** Échap. */
  onPause(): void;
  /** T ou / : ouvre la console de commandes. */
  onConsole(): void;
  /** F / F5 : change de vue. */
  onCamera(): void;
  /** F3 : informations de débogage. */
  onDebug(): void;
  /** Q : jeter l'objet tenu. */
  onDrop(): void;
  /** Clic milieu : prendre le bloc visé. */
  onPick(): void;
}

export class Hud {
  readonly root: HTMLElement;
  private hotbarEl: HTMLElement;
  private healthEl: HTMLElement;
  private hungerEl: HTMLElement;
  private breathEl: HTMLElement;
  private heldName: HTMLElement;
  private airspeedEl: HTMLElement;
  private debugEl: HTMLElement;
  private toastStack: HTMLElement;
  private vignette: HTMLElement;
  private touchLayer: HTMLElement;
  private bossEl!: HTMLElement;
  private bossName!: HTMLElement;
  private bossFill!: HTMLElement;
  private bossNote!: HTMLElement;
  private slots: HTMLElement[] = [];
  private lastVersion = -1;
  private lastSelected = -1;
  private heldTimer = 0;
  private touchReady = false;

  constructor() {
    this.root = document.getElementById('hud')!;
    this.hotbarEl = document.getElementById('hotbar')!;
    this.healthEl = document.getElementById('health')!;
    this.hungerEl = document.getElementById('hunger')!;
    this.breathEl = document.getElementById('breath')!;
    this.heldName = document.getElementById('held-item-name')!;
    this.airspeedEl = document.getElementById('airspeed')!;
    this.debugEl = document.getElementById('debug')!;
    this.toastStack = document.getElementById('toast-stack')!;
    this.vignette = document.getElementById('hit-vignette')!;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = el('div', 'slot', this.hotbarEl);
      el('img', undefined, s);
      el('span', 'count', s);
      const d = el('div', 'dura', s);
      el('i', undefined, d);
      this.slots.push(s);
    }

    this.touchLayer = el('div', 'touch-ui', this.root);

    // Barre de boss, cachée tant qu'aucun combat n'est en cours.
    this.bossEl = el('div', 'boss hidden', this.root);
    this.bossName = el('div', 'boss-name', this.bossEl);
    const track = el('div', 'boss-track', this.bossEl);
    this.bossFill = el('i', undefined, track);
    this.bossNote = el('div', 'boss-note', this.bossEl);
  }

  /**
   * Affiche ou masque la barre du boss. `null` la retire.
   */
  setBoss(state: { name: string; ratio: number; note?: string } | null): void {
    if (!state) {
      if (!this.bossEl.classList.contains('hidden')) this.bossEl.classList.add('hidden');
      return;
    }
    this.bossEl.classList.remove('hidden');
    if (this.bossName.textContent !== state.name) this.bossName.textContent = state.name;
    this.bossFill.style.width = `${Math.round(Math.max(0, Math.min(1, state.ratio)) * 100)}%`;
    const note = state.note ?? '';
    if (this.bossNote.textContent !== note) this.bossNote.textContent = note;
  }

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setGuiScale(scale: number): void {
    document.documentElement.style.setProperty('--gui', String(scale));
  }

  // --- Barre rapide -------------------------------------------------------

  updateHotbar(inv: Inventory, force = false): void {
    if (!force && inv.main.version === this.lastVersion && inv.selected === this.lastSelected) return;
    this.lastVersion = inv.main.version;
    if (inv.selected !== this.lastSelected) {
      this.lastSelected = inv.selected;
      this.flashHeldName(inv.selectedStack);
    }
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = this.slots[i];
      slot.classList.toggle('active', i === inv.selected);
      renderSlot(slot, inv.main.get(i));
    }
  }

  private flashHeldName(s: ItemStack | null): void {
    if (!s) {
      this.heldName.classList.remove('show');
      return;
    }
    this.heldName.textContent = s.item.name;
    this.heldName.classList.add('show');
    this.heldTimer = 2.2;
  }

  // --- Jauges -------------------------------------------------------------

  updateBars(health: number, maxHealth: number, food: number, breath: number, maxBreath: number, survival: boolean): void {
    if (!survival) {
      this.healthEl.style.display = 'none';
      this.hungerEl.style.display = 'none';
      this.breathEl.style.display = 'none';
      return;
    }
    this.healthEl.style.display = '';
    this.hungerEl.style.display = '';
    renderPips(this.healthEl, 'heart', health, maxHealth);
    renderPips(this.hungerEl, 'food', food, 20);
    const airRatio = breath / maxBreath;
    if (airRatio >= 0.999) {
      this.breathEl.style.display = 'none';
    } else {
      this.breathEl.style.display = '';
      renderPips(this.breathEl, 'air', Math.ceil(airRatio * 20), 20);
    }
  }

  setDamageVignette(v: number): void {
    this.vignette.style.opacity = String(Math.min(0.85, v));
  }

  // --- Débogage -----------------------------------------------------------

  setDebug(text: string | null): void {
    if (text === null) {
      this.debugEl.classList.add('hidden');
      return;
    }
    this.debugEl.classList.remove('hidden');
    this.debugEl.textContent = text;
  }

  // --- Notifications ------------------------------------------------------

  /**
   * Badinier de l'engin piloté. `null` le masque. Sans lui, le décrochage
   * arrive sans prévenir : rien à l'écran ne dit qu'on ralentit.
   */
  setAirspeed(speed: number | null, stall = 0): void {
    if (speed === null) { this.airspeedEl.classList.remove('show'); return; }
    this.airspeedEl.classList.add('show');
    this.airspeedEl.classList.toggle('stall', speed < stall);
    this.airspeedEl.textContent = `${speed.toFixed(0)} m/s${speed < stall ? '  ⚠ décrochage' : ''}`;
  }

  toast(message: string, kind: 'info' | 'warn' | 'error' = 'info', duration = 3200): void {
    const t = el('div', `toast ${kind === 'info' ? '' : kind}`.trim(), this.toastStack);
    t.textContent = message;
    window.setTimeout(() => {
      t.style.transition = 'opacity .3s ease';
      t.style.opacity = '0';
      window.setTimeout(() => t.remove(), 320);
    }, duration);
  }

  tick(dt: number): void {
    if (this.heldTimer > 0) {
      this.heldTimer -= dt;
      if (this.heldTimer <= 0) this.heldName.classList.remove('show');
    }
  }

  // --- Contrôles tactiles -------------------------------------------------

  enableTouch(handlers: TouchHandlers): void {
    if (this.touchReady) return;
    this.touchReady = true;
    this.touchLayer.classList.add('on');
    this.touchLayer.innerHTML = '';
    el('div', 'stick-base', this.touchLayer);

    // La couche HUD ignore les pointeurs ; on les réactive sur la seule barre
    // rapide, qui devient touchable.
    this.hotbarEl.classList.add('tappable');
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handlers.onSelectSlot(i);
      });
    }

    /** Bouton maintenu : l'action dure tant que le doigt reste posé. */
    const hold = (parent: HTMLElement, cls: string, label: string, title: string, down: (v: boolean) => void) => {
      const b = el('div', `touch-btn ${cls}`, parent);
      b.textContent = label;
      b.title = title;
      b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(true); });
      b.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); down(false); });
      b.addEventListener('touchcancel', () => down(false));
      return b;
    };

    /**
     * Bouton d'action ponctuelle. On écoute `click` et non `touchstart` :
     * `preventDefault` sur un `touchstart` empêche le navigateur de considérer
     * le geste comme une interaction utilisateur, et le clavier virtuel refuse
     * alors de s'ouvrir quand on focalise la console.
     */
    const tap = (parent: HTMLElement, cls: string, label: string, title: string, fn: () => void) => {
      const b = el('div', `touch-btn ${cls}`, parent);
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    // Amas d'action, sous le pouce droit.
    const jump = hold(this.touchLayer, 'jump', '⤒', 'Sauter / voler', handlers.onJump);
    // Le double appui déclenche le vol explicitement. La détection par fronts
    // dans la physique suppose une image entre les deux appuis ; en dessous de
    // dix images par seconde, elle rate le geste.
    let lastJumpTap = -1;
    jump.addEventListener('touchstart', () => {
      const now = performance.now();
      if (lastJumpTap > 0 && now - lastJumpTap < 340) { handlers.onFly(); lastJumpTap = -1; }
      else lastJumpTap = now;
    });
    hold(this.touchLayer, 'sneak', '⤓', 'S’accroupir / descendre', handlers.onSneak);
    hold(this.touchLayer, 'attack', '⛏', 'Casser / attaquer', handlers.onAttack);
    hold(this.touchLayer, 'use', '▣', 'Poser / utiliser', handlers.onUse);

    // Course : une bascule, personne ne garde un doigt sur Ctrl.
    let sprinting = false;
    const sprint = tap(this.touchLayer, 'sprint', '»', 'Courir', () => {
      sprinting = !sprinting;
      sprint.classList.toggle('active', sprinting);
      handlers.onSprint(sprinting);
    });

    // Colonne de menus, en haut à droite.
    const menu = el('div', 'touch-menu', this.touchLayer);
    tap(menu, 'inv', '☰', 'Inventaire', handlers.onInventory);
    tap(menu, 'pause', '❚❚', 'Pause', handlers.onPause);
    tap(menu, 'console', '>_', 'Console de commandes', handlers.onConsole);

    // Le reste tient dans un tiroir : l'écran d'un téléphone est étroit.
    const drawer = el('div', 'touch-drawer', menu);
    const more = tap(menu, 'more', '⋯', 'Plus d’actions', () => {
      drawer.classList.toggle('open');
      more.classList.toggle('active', drawer.classList.contains('open'));
    });
    tap(drawer, '', '👁', 'Changer de vue', handlers.onCamera);
    tap(drawer, '', 'ⓘ', 'Informations de débogage', handlers.onDebug);
    tap(drawer, '', '⤵', 'Jeter l’objet tenu', handlers.onDrop);
    tap(drawer, '', '⊕', 'Prendre le bloc visé', handlers.onPick);
  }
}

export function renderSlot(slot: HTMLElement, s: ItemStack | null): void {
  const img = slot.querySelector('img') as HTMLImageElement;
  const count = slot.querySelector('.count') as HTMLElement;
  const dura = slot.querySelector('.dura') as HTMLElement | null;
  if (!s) {
    img.removeAttribute('src');
    img.style.display = 'none';
    count.textContent = '';
    if (dura) dura.style.display = 'none';
    slot.title = '';
    return;
  }
  const url = iconFor(s.item);
  img.style.display = '';
  if (img.getAttribute('src') !== url) img.src = url;
  count.textContent = s.count > 1 ? String(s.count) : '';
  slot.title = s.item.name;
  if (dura) {
    if (s.item.durability && s.damage > 0) {
      dura.style.display = '';
      const ratio = 1 - s.damage / s.item.durability;
      const bar = dura.querySelector('i') as HTMLElement;
      bar.style.width = `${Math.max(0, ratio) * 100}%`;
      bar.style.background = ratio > 0.5 ? '#6fcf5f' : ratio > 0.22 ? '#e0c03f' : '#e0503f';
    } else {
      dura.style.display = 'none';
    }
  }
}

function renderPips(container: HTMLElement, kind: string, value: number, max: number): void {
  const pipCount = Math.ceil(max / 2);
  while (container.children.length < pipCount) el('div', `pip ${kind}`, container);
  while (container.children.length > pipCount) container.lastElementChild!.remove();
  for (let i = 0; i < pipCount; i++) {
    const pip = container.children[i] as HTMLElement;
    pip.className = `pip ${kind}`;
    const filled = value - i * 2;
    if (filled >= 2) pip.classList.add('full');
    else if (filled >= 1) pip.classList.add('half');
  }
}
