# VoxelCraft

Un bac à sable voxel façon Minecraft, entièrement jouable dans le navigateur.
Monde infini généré procéduralement, villages, mines, **Nether** et **End**,
survie, artisanat, créatures, cycle jour/nuit, météo et rendu avancé — le tout
sans aucun asset externe : textures, icônes et sons sont **synthétisés au
démarrage**.

Pile technique : **TypeScript + Vite + Three.js (WebGL 2 / GLSL ES 3.0)**,
avec un pool de **Web Workers** pour la génération de terrain et le maillage.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # bundle de production dans dist/
npm run preview  # sert le bundle construit
```

WebGL 2 est requis (tableau de textures, shaders GLSL 3).

---

## Ce que le jeu contient

### Monde

- **Terrain infini** en colonnes de 16 × 128 × 16, streamé autour du joueur.
- Génération pilotée par un **climat à cinq bruits** (continentalité, érosion,
  relief, température, humidité) combinés par courbes splines : océans, plages,
  plaines, forêts, taïgas, jungles, marais, savanes, déserts, mesas, alpages et
  sommets rocheux — **17 biomes** aux teintes, brumes et végétations propres.
- **Grottes** creusées par intersection de bruits *ridged* (tunnels) et de
  poches volumineuses en profondeur, échantillonnées sur grille grossière puis
  interpolées ; lacs de lave au fond.
- **Filons de minerai** par marche aléatoire (charbon, fer, or, redstone,
  lapis, diamant, émeraude) avec plages d'altitude distinctes.
- **Végétation** : 8 formes d'arbres (chêne, grand chêne, bouleau, sapin,
  grand sapin, acajou, acacia, chêne de marais), cactus, cannes à sucre,
  fleurs, fougères, champignons, citrouilles. Les structures qui débordent d'un
  chunk sont reportées sur les chunks voisins.
- **Structures** ancrées sur une grille de régions : **villages** tous les
  100 blocs (puits, cinq à huit maisons meublées, sentiers, lampadaires et un
  **champ de citrouilles** clôturé, palette selon le biome), **mines
  abandonnées** sur deux niveaux, **épaves** échouées, **portails engloutis**
  et **coffres au trésor** enfouis sous les plages. Chaque chunk reconstruit
  intégralement la structure qui le touche et découpe ce qui dépasse : aucune
  couture quand on arrive par le bord.
- **~210 blocs** : roches et variantes polies, minerais, quatre essences de
  bois, verre, glace, blocs décoratifs, établi, four, coffre, TNT, sources de
  lumière, matériaux du Nether et de l'End, et une palette de construction
  complète — laine, **béton**, **terre cuite** et **verre teinté** dans les
  16 teintes, plus **10 familles de dalles** et **6 familles d'escaliers**
  orientés selon le regard à la pose.
- **Trois types de monde** au choix à la création : normal, **superplat** pour
  bâtir sans terrain qui gêne, et **oneblock**.

### Dimensions

- **Nether** : une caverne close entre deux couches de bedrock, sculptée dans du
  plein par un bruit 3D seuillé — d'où les voûtes, les surplombs et les puits
  verticaux. Mers de lave, sable des âmes sur leurs rives, pierre lumineuse
  accrochée aux plafonds, quartz partout et **débris antiques** en profondeur.
  On y trouve des **forteresses** en briques du Nether : pont à arches, tours,
  salle des braises, et la salle du portail.
- **End** : une île de pierre de l'End hérissée de colonnes d'obsidienne, puis
  un archipel dispersé au-dessus du vide. Le **dragon** y attend : il tourne en
  orbite au-dessus de l'île, pique sur le joueur, et **se régénère tant qu'un
  cristal reste debout** au sommet d'une colonne. Barre de boss à l'écran,
  décompte des cristaux, et à sa mort un piédestal d'obsidienne surmonté de
  l'**œuf de dragon**. Il ne réapparaît pas.
- **Portails** : un cadre d'obsidienne allumé au **briquet** ouvre le passage
  vers le Nether (les coordonnées y sont divisées par huit, le raccourci est
  donc bien réel). Le **portail de l'End** attend dans la forteresse : douze
  cadres en anneau, à garnir d'**yeux de l'Ender**.
- Chaque dimension a son propre relief, sa propre ambiance — pas de soleil,
  donc pas d'ombres portées ni de rayons crépusculaires — et ses propres
  modifications sauvegardées.

### Modes de jeu particuliers

- **Oneblock** : le monde est entièrement vide, à l'exception d'un unique bloc
  qui repousse à chaque fois qu'on le casse. Six phases — Prairie, Forêt,
  Désert, Océan, Cavernes, Abysse — avec leurs tables de blocs, leurs créatures
  et leurs coffres. Tomber dans le vide ramène sur l'île au lieu de tuer.

### Rendu

- **Greedy meshing** dans des workers, avec **occlusion ambiante par sommet** et
  **éclairage lissé** ; les attributs sont compactés dans un seul flottant
  (index de texture, AO, lumière du ciel, lumière de bloc, mode d'animation,
  profondeur d'eau).
- **Ombres portées du soleil** : carte d'ombre orthographique suivant le joueur,
  centre aligné sur la grille de texels, PCF 3×3, biais dépendant de
  l'inclinaison, feuillages alpha-testés dans la passe de profondeur, intensité
  fondue au crépuscule.
- **Propagation de lumière** incrémentale, budgétée par image : lumière du ciel
  en colonne puis diffusion, lumière de bloc (torches, lave, pierre lumineuse),
  avec algorithmes d'ajout **et** de retrait corrects lorsqu'on casse ou pose.
- **Atlas procédural** : chaque tuile 32×32 est peinte au démarrage dans un
  `DataArrayTexture` (fissures en marche aléatoire, motifs cellulaires, briques,
  cernes et nœuds du bois, strates, trame tissée, silhouettes de plantes), ce
  qui supprime tout saignement d'atlas et donne des mipmaps propres.
- **Relief par pixel** : chaque peintre produit un champ de hauteur d'où l'on
  dérive une carte de normales tangentes, plus une rugosité par matériau. Le
  repère tangent est reconstruit depuis les dérivées d'écran, et un spéculaire
  solaire distingue les métaux et la glace de la laine et de la terre.
- **Ciel volumétrique** : dégradé atmosphérique, halo de diffusion solaire,
  disque solaire, lune avec phase, champ d'étoiles scintillantes et couche
  nuageuse projetée en perspective à altitude constante.
- **Post-traitement maison** (sans addons Three) : extraction des hautes
  lumières, flou gaussien séparable sur trois échelles, **bloom**, **rayons
  crépusculaires** échantillonnés radialement, effet **sous-marin** (ondulation
  et teinte), vignette, étalonnage, tonemap **ACES** et **FXAA**.
- **Eau** : surface abaissée et animée, normales ondulées, scintillement à deux
  lobes, Fresnel, transparence triée. La **profondeur de la colonne d'eau est
  calculée par le mailleur**, ce qui donne l'absorption (turquoise sur les
  hauts-fonds, bleu profond au large) sans passe de profondeur supplémentaire,
  ainsi que l'**écume** sur les rives et les **caustiques** animées projetées
  sur les fonds immergés.
- Feuillages et herbes qui **ondulent au vent** (amplifié par la pluie),
  brouillard atmosphérique teinté par le biome, particules de blocs cassés,
  gerbes d'eau, étincelles d'explosion, pluie et neige.

### Jeu

- **Trois modes** : survie, créatif (vol par double appui sur Espace),
  spectateur.
- **Minage** dépendant du bloc et de l'outil : durée, niveau requis, butin
  conditionnel, usure des outils, particules et sons par matériau.
- **Inventaire complet** : 36 emplacements + barre rapide, 4 emplacements
  d'armure, glisser-déposer (clic gauche/droit, `Maj`+clic pour le transfert
  rapide), infobulles détaillées, sélecteur d'objets filtrable en créatif.
- **Artisanat** : grille 2×2 dans l'inventaire, 3×3 sur un établi, plus de
  **165 recettes** (outils et armures des 6 matériaux, blocs compacts, teinture
  de la laine, dalles et escaliers — dessinés dans un sens ou dans l'autre —,
  TNT, papier, livres, briquet, œil de l'Ender…), avec ingrédients
  alternatifs. La progression **fer → or → diamant → netherite** va jusqu'au
  bout : les débris antiques se fondent en éclats, quatre éclats et quatre
  lingots d'or donnent un lingot, et l'équipement en diamant s'améliore.
- **Coffres de structures** : leur contenu est tiré depuis leur position, sans
  jamais être stocké — le même coffre rend donc toujours le même butin, même
  après un rechargement du monde.
- **Four** fonctionnel : combustion, progression de cuisson, table de fusion
  (minerais, verre, briques, cuisson des viandes) ; **coffres** de 27 cases.
- **Créatures** : cochon, vache, mouton, poule, zombie, squelette, creeper,
  araignée, **villageois**, **idiot du village**, **golem de fer**, **kraken**,
  **bloop**, **braise**, **enderman** et le **dragon de l'End** — modèles
  articulés animés (ailes battantes et queue ondulante pour le dragon), IA
  d'errance et de poursuite, apparition selon la lumière, l'heure et la
  dimension, butins, expérience. Les creepers **explosent** et creusent le
  terrain, le golem prend pour cible la créature hostile la plus proche et
  riposte si on le frappe, le kraken nage et s'échoue hors de l'eau, le bloop
  n'avance que par bonds, la braise ne se pose jamais et l'enderman se dérobe
  d'un pas de côté dès qu'on le touche.
- **Survie** : vie, faim et saturation, souffle sous l'eau, dégâts de chute, de
  lave, de cactus et de famine, régénération, armure et réduction de dégâts,
  écran de mort et réapparition.
- **Physique** : collisions AABB par axe avec résolution dichotomique, nage,
  vol, accroupissement (qui empêche de tomber d'un rebord), saut automatique
  optionnel, sable et gravier qui tombent.
- **Sauvegarde IndexedDB** : plusieurs mondes, seuls les blocs modifiés sont
  stockés (le terrain est reproductible depuis la graine), position, inventaire,
  armure, heure et temps de jeu ; sauvegarde automatique.
- **Outils de construction** (console) : `/pos1` et `/pos2` marquent une zone
  depuis le bloc visé, puis `/remplir`, `/coque`, `/remplacer`, `/copier`,
  `/coller` et `/annuler`. Les opérations en masse écrivent les blocs
  directement et ne recalculent la lumière qu'une fois par chunk touché — une
  zone de 160 000 blocs se remplit d'un coup.
- **Sélecteur créatif par onglets** : Construction, Couleurs, Nature,
  Mécanismes, Équipement, Ressources, Nourriture, avec recherche transversale.
- **Règles du monde** : `/figer` bloque le cycle jour/nuit, `/mobs off` coupe
  l'apparition des créatures.
- **Console de commandes** : `/gamemode`, `/tp`, `/time`, `/give`, `/meteo`,
  `/seed`, `/tuer`, `/dimension`, `/aide`.
- **Audio 100 % procédural** (Web Audio) : impacts filtrés par matériau, pas,
  cris de créatures, explosions, nappe d'ambiance jour/nuit.
- **Options** : distance de rendu, FOV, échelle de résolution et d'interface,
  bloom, rayons crépusculaires, FXAA, nuages, météo, particules, oscillation de
  caméra, sensibilité, volumes, nombre de créatures.
- **Contrôles tactiles** détectés automatiquement, et **complets** : joystick
  virtuel, zone de visée, amas d'action, bascule de course, **barre rapide
  touchable**, et une colonne de menus donnant accès à l'inventaire, à la
  pause, à la **console de commandes**, au changement de vue, au débogage, au
  lâcher d'objet et à la prise du bloc visé. La console remonte au-dessus du
  clavier virtuel et s'accompagne de ses boutons « envoyer » et « fermer », qui
  remplacent `Entrée` et `Échap`.

---

## Contrôles

Chaque raccourci a son équivalent au doigt : rien n'est réservé au clavier.

| Action | Clavier / souris | Tactile |
| --- | --- | --- |
| Se déplacer | `Z Q S D` / `W A S D` | joystick, en bas à gauche |
| Sauter | `Espace` | `⤒` |
| Voler (créatif) | double appui sur `Espace` | double appui sur `⤒` |
| S'accroupir / descendre en vol | `Maj` | `⤓` |
| Courir | `Ctrl` | `»` (bascule) |
| Casser un bloc / attaquer | clic gauche | `⛏` |
| Poser / utiliser / ouvrir | clic droit | `▣` |
| Allumer un cadre d'obsidienne | clic droit avec un briquet | `▣` avec un briquet |
| Changer d'objet | molette, `1`-`9` | appui sur une case de la barre rapide |
| Prendre le bloc visé | clic milieu | `⊕` |
| Inventaire | `E` | `☰` |
| Jeter l'objet tenu | `Q` | `⤵` |
| Vue à la troisième personne | `F` / `F5` | `👁` |
| Informations de débogage | `F3` | `ⓘ` |
| Console de commandes | `T` ou `/` | `>_` |
| Pause | `Échap` | `❚❚` |

Vue, débogage, lâcher d'objet et prise du bloc visé se rangent dans un tiroir
qu'ouvre le bouton `⋯` :
sur l'écran d'un téléphone, mieux vaut ne pas tout afficher d'un coup. Le
tiroir s'ouvre vers la gauche, et la colonne de menus se couche à l'horizontale
en mode paysage — vérifié de 320 × 568 à 863 × 360 sans qu'un bouton sorte de
l'écran.

---

## Architecture

```
src/
  core/        constantes, entrées (clavier/souris/tactile), réglages, boucle de jeu
  world/       registre des blocs, bruits, biomes, générateur, structures, mailleur, monde, pool de workers
  workers/     worker polyvalent (génération + maillage)
  render/      atlas procédural, matériaux GLSL 3, ciel, post-traitement, particules, streaming
  player/      physique AABB, lancer de rayon DDA, état et vitalité du joueur
  items/       registre d'objets, recettes, tables de butin, inventaire et conteneurs
  entities/    créatures (modèles, IA) et objets au sol
  ui/          HUD, écrans, icônes générées, feuille de style
  audio/       synthèse sonore Web Audio
  save/        persistance IndexedDB
```

Quelques points de conception :

- **Rien n'est calculé deux fois entre les threads.** Le registre de blocs est
  importé aussi bien par le thread principal que par les workers ; les index de
  textures découlent de l'ordre d'enregistrement, ce qui garantit des valeurs
  identiques des deux côtés sans échange de message.
- **Le maillage reçoit un volume étendu** de 18 × 128 × 18 (le chunk plus une
  marge d'un voxel copiée depuis les huit voisins), transféré en zéro-copie et
  recyclé dans un pool de tampons.
- **La lumière n'est amorcée que là où elle peut changer** : au-dessus de la
  crête locale, la lumière du ciel vaut 15 partout et la diffusion latérale
  serait inutile. Cette borne fait passer la file d'attente de ~10⁶ à ~10⁴
  opérations sur une distance de rendu de 8 chunks.
- **Le rendu est linéaire de bout en bout** : les textures sRGB sont converties
  par le GPU, les teintes de sommets sont linéarisées dans le shader, et
  l'encodage sRGB n'a lieu qu'à la toute dernière passe.

## Limites connues

- Les contenus de fours et de coffres vivent en mémoire pour la session : ils
  ne sont pas encore écrits dans IndexedDB (les blocs, eux, le sont).
- Les fluides ne s'écoulent pas ; l'eau et la lave sont statiques.
- Les formes non cubiques se limitent à deux boîtes par bloc : dalles et
  escaliers passent, mais un muret ou une clôture, qui en demandent plus,
  restent hors de portée du mailleur.
- Les escaliers ne se posent qu'à l'endroit : les variantes retournées sous un
  plafond coûteraient 24 identifiants de bloc de plus.
- Le lancer de rayon vise le voxel entier : on peut cibler une dalle ou la
  moitié creuse d'un escalier en visant du vide.
- Une seule cascade d'ombre : au-delà du rayon couvert (48 à 110 blocs selon la
  distance de rendu), les ombres s'estompent au lieu de se prolonger.
- La lumière de bloc est monochrome : une torche et une lanterne aquatique
  éclairent de la même teinte.
