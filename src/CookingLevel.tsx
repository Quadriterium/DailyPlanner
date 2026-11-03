import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ChefHat } from 'lucide-react';
import {
  cookingLevelHints, cookingLevelLabels, cookingLevels, defaultCookingLevel, dishDetails, seasonalDishes,
  type Analysis, type CookingLevel, type Dish,
} from '../shared/model';
import { Modal } from './components';

const longPressDelay = 500;
const moveTolerance = 10;

export function LevelGauge({ level }: { level: CookingLevel }) {
  return <span className="level-gauge" aria-hidden="true">
    {cookingLevels.map(value => <ChefHat key={value} size={13} strokeWidth={1.8} className={value <= level ? 'on' : ''} />)}
  </span>;
}

export function LevelTag({ level }: { level: CookingLevel }) {
  return <span className="level-tag"><LevelGauge level={level} />{cookingLevelLabels[level]}</span>;
}

/** Nombre de plats de saison non archivés par niveau, pour le menu du choix au hasard. */
export function seasonalLevelCounts(dishes: Dish[], analyses: Analysis[], date: string): Record<CookingLevel, number> {
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const counts: Record<CookingLevel, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const dish of seasonalDishes(dishes, analyses, date)) {
    const level = dishDetails(dish, analysisMap.get(dish.id)).level;
    if (level) counts[level]++;
  }
  return counts;
}

function CookingLevelMenu({ title, subtitle, preferred, counts, vegetarianRequired, onChoose, onClose }: {
  title: string; subtitle: string; preferred: CookingLevel; counts?: Record<CookingLevel, number>;
  vegetarianRequired?: boolean;
  onChoose: (level: CookingLevel, vegetarian: boolean) => void; onClose: () => void;
}) {
  const [vegetarian, setVegetarian] = useState(vegetarianRequired === true);
  return <Modal title={title} onClose={onClose}>
    <p className="modal-subtitle">{subtitle}</p>
    {vegetarianRequired !== undefined && <>
      <label className="checkbox-field"><input type="checkbox" checked={vegetarianRequired || vegetarian}
        disabled={vegetarianRequired} onChange={event => setVegetarian(event.target.checked)} />Menu végétarien</label>
      <p className="field-hint">{vegetarianRequired ? 'Activé par les paramètres du foyer pour ce repas.'
        : 'Pour cette génération uniquement, sans modifier les paramètres.'}</p>
    </>}
    <div className="level-menu">
      {cookingLevels.map(level => <button key={level} type="button" className={`level-choice ${level === preferred ? 'preferred' : ''}`}
        disabled={counts?.[level] === 0} onClick={() => onChoose(level, vegetarianRequired || vegetarian)}>
        <LevelGauge level={level} />
        <span className="level-choice-text"><strong>{cookingLevelLabels[level]}</strong>
          <small>{cookingLevelHints[level]}</small>
          {counts && <small className="level-count">{counts[level] === 0 ? 'Aucun plat de saison à ce niveau'
            : `${counts[level]} plat${counts[level] > 1 ? 's' : ''} de saison`}</small>}
        </span>
        {level === preferred && <span className="level-badge">Votre niveau</span>}
      </button>)}
    </div>
  </Modal>;
}

type LevelButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onContextMenu' | 'onPointerDown' | 'onPointerMove'
  | 'onPointerUp' | 'onPointerLeave' | 'onPointerCancel' | 'onTouchEnd' | 'type' | 'children'> & {
  children: ReactNode;
  /** Appui court : niveau des paramètres. */
  onPress: () => void;
  /** Appui long, clic droit ou touche Menu : niveau choisi dans le menu. */
  onLevel: (level: CookingLevel, vegetarian: boolean) => void;
  menuTitle: string;
  menuSubtitle: string;
  preferred?: CookingLevel;
  levelCounts?: () => Record<CookingLevel, number>;
  vegetarianRequired?: boolean;
};

/** Bouton dont l'appui long ouvre un menu pour choisir le niveau de cuisine de cette action uniquement. */
export function LevelButton({
  children, onPress, onLevel, menuTitle, menuSubtitle, preferred = defaultCookingLevel, levelCounts, vegetarianRequired, className, ...props
}: LevelButtonProps) {
  const [menu, setMenu] = useState<Record<CookingLevel, number> | 'open' | null>(null);
  const press = useRef<{ timer?: number; x: number; y: number; opened: boolean }>({ x: 0, y: 0, opened: false });
  function cancel() {
    window.clearTimeout(press.current.timer);
    press.current.timer = undefined;
  }
  function open() {
    cancel();
    press.current.opened = true;
    setMenu(levelCounts?.() ?? 'open');
  }
  useEffect(() => cancel, []);
  return <>
    <button type="button" className={`${className ?? ''} long-press`} {...props}
      onPointerDown={event => {
        press.current.opened = false;
        if (event.button !== 0 || props.disabled) return;
        cancel();
        press.current = { x: event.clientX, y: event.clientY, opened: false, timer: window.setTimeout(open, longPressDelay) };
      }}
      onPointerMove={event => {
        if (press.current.timer !== undefined &&
          Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > moveTolerance) cancel();
      }}
      onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel}
      onTouchEnd={event => {
        // Sans cela, relâcher le doigt après l'ouverture du menu produit un tap sur le menu lui-même (fermeture ou choix involontaire).
        if (press.current.opened) event.preventDefault();
      }}
      onContextMenu={event => {
        event.preventDefault();
        if (!press.current.opened && !props.disabled) open();
      }}
      onClick={event => {
        // Le clic qui suit un appui long ne doit pas déclencher l'action courte ; un clic clavier (detail 0) reste toujours actif.
        const afterLongPress = press.current.opened && event.detail !== 0;
        press.current.opened = false;
        if (!afterLongPress) onPress();
      }}>
      {children}
    </button>
    {menu && <CookingLevelMenu title={menuTitle} subtitle={menuSubtitle} preferred={preferred}
      vegetarianRequired={vegetarianRequired}
      counts={menu === 'open' ? undefined : menu} onClose={() => setMenu(null)}
      onChoose={(level, vegetarian) => { setMenu(null); onLevel(level, vegetarian); }} />}
  </>;
}
