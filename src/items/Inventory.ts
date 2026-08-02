/** Piles d'objets, conteneurs et logique de transfert. */

import { itemById, itemOf, type ItemDef } from './items';

export interface ItemStack {
  item: ItemDef;
  count: number;
  /** Usure accumulée pour les outils. */
  damage: number;
}

export function stack(key: string, count = 1, damage = 0): ItemStack {
  return { item: itemOf(key), count, damage };
}

export function makeStack(item: ItemDef, count = 1, damage = 0): ItemStack {
  return { item, count, damage };
}

export function sameItem(a: ItemStack | null, b: ItemStack | null): boolean {
  if (!a || !b) return false;
  if (a.item !== b.item) return false;
  // Les objets endommagés ne s'empilent pas.
  if (a.item.durability) return false;
  return true;
}

export function copyStack(s: ItemStack | null): ItemStack | null {
  return s ? { item: s.item, count: s.count, damage: s.damage } : null;
}

/** Conteneur générique : tableau de slots pouvant être vides. */
export class Container {
  readonly slots: (ItemStack | null)[];
  /** Incrémenté à chaque changement : permet à l'interface de se rafraîchir. */
  version = 0;

  constructor(size: number) {
    this.slots = new Array(size).fill(null);
  }

  get size(): number {
    return this.slots.length;
  }

  get(i: number): ItemStack | null {
    return this.slots[i] ?? null;
  }

  set(i: number, s: ItemStack | null): void {
    this.slots[i] = s && s.count > 0 ? s : null;
    this.version++;
  }

  clear(): void {
    this.slots.fill(null);
    this.version++;
  }

  isEmpty(): boolean {
    return this.slots.every((s) => s === null);
  }

  count(key: string): number {
    let n = 0;
    for (const s of this.slots) if (s && s.item.key === key) n += s.count;
    return n;
  }

  /**
   * Ajoute une pile ; renvoie ce qui n'a pas pu être rangé.
   * @param range limite optionnelle [début, fin[ de slots visés
   */
  add(input: ItemStack, range?: [number, number]): ItemStack | null {
    const [from, to] = range ?? [0, this.slots.length];
    let remaining = input.count;
    const max = input.item.maxStack;

    if (max > 1) {
      for (let i = from; i < to && remaining > 0; i++) {
        const s = this.slots[i];
        if (!s || s.item !== input.item || s.count >= max) continue;
        if (s.item.durability) continue;
        const room = max - s.count;
        const moved = Math.min(room, remaining);
        s.count += moved;
        remaining -= moved;
      }
    }
    for (let i = from; i < to && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const moved = Math.min(max, remaining);
      this.slots[i] = { item: input.item, count: moved, damage: input.damage };
      remaining -= moved;
    }
    this.version++;
    return remaining > 0 ? { item: input.item, count: remaining, damage: input.damage } : null;
  }

  /** Retire jusqu'à `count` exemplaires ; renvoie la quantité effectivement retirée. */
  remove(key: string, count: number): number {
    let left = count;
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      const s = this.slots[i];
      if (!s || s.item.key !== key) continue;
      const taken = Math.min(s.count, left);
      s.count -= taken;
      left -= taken;
      if (s.count <= 0) this.slots[i] = null;
    }
    this.version++;
    return count - left;
  }

  /** Consomme un exemplaire du slot indiqué. */
  consume(i: number, n = 1): void {
    const s = this.slots[i];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[i] = null;
    this.version++;
  }

  serialize(): (null | [number, number, number])[] {
    return this.slots.map((s) => (s ? [s.item.id, s.count, s.damage] : null));
  }

  deserialize(data: (null | [number, number, number])[]): void {
    for (let i = 0; i < this.slots.length; i++) {
      const d = data[i];
      this.slots[i] = d ? { item: itemById(d[0]), count: d[1], damage: d[2] ?? 0 } : null;
    }
    this.version++;
  }
}

export const HOTBAR_SIZE = 9;
export const MAIN_SIZE = 36;

export class Inventory {
  readonly main = new Container(MAIN_SIZE);
  readonly armor = new Container(4);
  /** Grille d'artisanat courante (2×2 dans l'inventaire, 3×3 sur un établi). */
  readonly crafting = new Container(9);
  /** Pile actuellement « tenue » par le curseur dans l'interface. */
  held: ItemStack | null = null;
  selected = 0;

  get selectedStack(): ItemStack | null {
    return this.main.get(this.selected);
  }

  get selectedItem(): ItemDef | null {
    return this.main.get(this.selected)?.item ?? null;
  }

  /** Ajoute en privilégiant la barre rapide, puis le reste de l'inventaire. */
  give(s: ItemStack): ItemStack | null {
    const left = this.main.add(s, [0, HOTBAR_SIZE]);
    if (!left) return null;
    return this.main.add(left, [HOTBAR_SIZE, MAIN_SIZE]);
  }

  /** Applique l'usure à l'outil tenu ; le casse s'il est épuisé. */
  damageSelected(amount = 1): boolean {
    const s = this.selectedStack;
    if (!s || !s.item.durability) return false;
    s.damage += amount;
    this.main.version++;
    if (s.damage >= s.item.durability) {
      this.main.set(this.selected, null);
      return true;
    }
    return false;
  }

  totalDefense(): number {
    let d = 0;
    for (const s of this.armor.slots) if (s?.item.armor) d += s.item.armor.defense;
    return d;
  }

  /** Endommage l'armure lors d'une prise de dégâts. */
  damageArmor(amount: number): void {
    for (let i = 0; i < this.armor.size; i++) {
      const s = this.armor.get(i);
      if (!s?.item.durability) continue;
      s.damage += amount;
      if (s.damage >= s.item.durability) this.armor.set(i, null);
    }
    this.armor.version++;
  }
}
