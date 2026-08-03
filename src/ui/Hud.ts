/** Affichage tête haute : barre rapide, jauges, débogage, notifications, tactile. */

import { HOTBAR_SIZE, type Inventory, type ItemStack } from '../items/Inventory';
import { iconFor } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export interface TouchHandlers {
  onJump(down: boolean): void;
  onSneak(down: boolean): void;
  onAttack(down: boolean): void;
  onUse(down: boolean): void;
  onInventory(): void;
  /** Sélection d'une case de la barre rapide : sans molette ni pavé numérique,
   *  c'est le seul moyen de changer d'objet sur mobile. */
  onSelectSlot(index: number): void;
}

export class Hud {
  readonly root: HTMLElement;
  private hotbarEl: HTMLElement;
  private healthEl: HTMLElement;
  private hungerEl: HTMLElement;
  private breathEl: HTMLElement;
  private heldName: HTMLElement;
  private debugEl: HTMLElement;
  private toastStack: HTMLElement;
  private vignette: HTMLElement;
  private touchLayer: HTMLElement;
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

    const mk = (cls: string, label: string, down: (v: boolean) => void, tap?: () => void) => {
      const b = el('div', `touch-btn ${cls}`, this.touchLayer);
      b.textContent = label;
      b.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); down(true); tap?.(); });
      b.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); down(false); });
      b.addEventListener('touchcancel', () => down(false));
      return b;
    };
    mk('jump', '⤒', handlers.onJump);
    mk('sneak', '⤓', handlers.onSneak);
    mk('attack', '⛏', handlers.onAttack);
    mk('use', '▣', handlers.onUse);
    mk('inv', '☰', () => {}, handlers.onInventory);
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
