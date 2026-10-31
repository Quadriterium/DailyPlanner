import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, Leaf, LoaderCircle, Moon, Plus, Shuffle, Sparkles, Sun, Users } from 'lucide-react';
import { addDays, formatDate, householdSummary, isoWeekday, mealDisplayName, mealId, seasonForDate, seasonLabels, type Analysis, type CookingLevel, type Dish, type Meal, type Slot } from '../shared/model';
import { Modal } from './components';
import { LevelButton, seasonalLevelCounts } from './CookingLevel';
import { errorMessage, fillMeal } from './store';

export function Planner({ today, meals, dishes, analyses, cookingLevel, onSelect, onSaved }: {
  today: string; meals: Meal[]; dishes: Dish[]; analyses: Analysis[]; cookingLevel?: CookingLevel;
  onSelect: (date: string, slot: Slot, start: string, index?: 1) => void; onSaved: () => void;
}) {
  const [range, setRange] = useState({ start: -7, end: 20 });
  const [visibleDay, setVisibleDay] = useState(today);
  const scroll = useRef<HTMLDivElement>(null);
  const adjustment = useRef<number | 'today'>('today');
  const expanding = useRef(false);
  const filling = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mealMap = new Map(meals.map(meal => [meal.id, meal]));
  const dishMap = new Map(dishes.map(dish => [dish.id, dish]));
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const season = seasonForDate(visibleDay);
  const dates = Array.from({ length: range.end - range.start + 1 }, (_, index) => addDays(today, range.start + index));

  function rowHeight() { return scroll.current?.querySelector<HTMLElement>('.day-row')?.getBoundingClientRect().height ?? 80; }
  useLayoutEffect(() => {
    const element = scroll.current!;
    if (adjustment.current === 'today') element.scrollTop = -range.start * rowHeight();
    else if (adjustment.current) element.scrollTop += adjustment.current;
    adjustment.current = 0;
    expanding.current = false;
  }, [range, today]);
  useEffect(() => {
    let previousHeight = rowHeight();
    const observer = new ResizeObserver(() => {
      const height = rowHeight();
      if (height !== previousHeight && scroll.current) {
        scroll.current.scrollTop = Math.round(scroll.current.scrollTop / previousHeight) * height;
        previousHeight = height;
      }
    });
    const row = scroll.current?.querySelector('.day-row');
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, []);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const height = rowHeight();
    const offset = range.start + Math.round(element.scrollTop / height);
    setVisibleDay(addDays(today, offset));
    if (expanding.current) return;
    if (element.scrollTop < height * 2) {
      expanding.current = true;
      adjustment.current = height * 7;
      setRange(current => ({ ...current, start: current.start - 7 }));
    } else if (element.scrollHeight - element.scrollTop - element.clientHeight < height * 2) {
      expanding.current = true;
      setRange(current => ({ ...current, end: current.end + 7 }));
    }
  }

  function goToday() {
    adjustment.current = 'today';
    setRange({ start: -7, end: 20 });
    setVisibleDay(today);
  }

  async function fill(date: string, slot: Slot, mode: 'ai' | 'random', level?: CookingLevel) {
    if (filling.current) return;
    filling.current = true;
    setBusy(`${date}:${slot}`);
    try {
      await fillMeal(date, slot, visibleDay, mode, undefined, undefined, level);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      filling.current = false;
      setBusy(null);
    }
  }

  return <section className="planner" aria-label="Planning des repas">
    <div className="section-heading">
      <div><h2>
        {formatDate(visibleDay, { day: 'numeric', month: 'long' })}<span className="date-dash"> — </span>
        {formatDate(addDays(visibleDay, 6), { day: 'numeric', month: 'long' })}
      </h2></div>
      <div className="planner-heading-actions">
        <span className={`season-label ${season}`}><Leaf size={14} />{seasonLabels[season]}</span>
        <button className="text-button" onClick={goToday}><CalendarDays size={15} />Aujourd’hui</button>
      </div>
    </div>
    <div className="menu-grid">
      <div className="column-headings"><span>AU FIL DES JOURS</span><span><Sun size={18} />Midi</span><span><Moon size={17} />Soir</span></div>
      <div className="days-scroll" ref={scroll} onScroll={onScroll} aria-label="Jours du planning, défilement vertical" tabIndex={0}>
        {dates.map(date => <div className={`day-row weekday-${isoWeekday(date)} ${date === today ? 'is-today' : ''} ${date < today ? 'is-past' : ''}`} key={date} data-date={date}>
          <div className="day-label"><span className="weekday">{formatDate(date, { weekday: 'long' })}</span>
            <span className="day-number">{formatDate(date, { day: '2-digit' })}<small>{formatDate(date, { month: 'short' })}</small></span>
            {date === today && <span className="today-label">Aujourd’hui</span>}
          </div>
          {(['lunch', 'dinner'] as const).map(slot => {
            const first = mealMap.get(mealId(date, slot));
            const second = mealMap.get(mealId(date, slot, 1));
            const choices = [first, second].filter((meal): meal is Meal => Boolean(meal?.text.trim()));
            const label = `${formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${slot === 'lunch' ? 'midi' : 'soir'}`;
            const pending = busy === `${date}:${slot}`;
            return <div key={slot} className={`meal-slot ${choices.length ? 'filled' : 'empty'} ${choices.length === 2 ? 'multiple' : ''}`} aria-busy={pending}>
              {choices.length ? choices.map(meal => {
                const dish = meal.dishId ? dishMap.get(meal.dishId) : undefined;
                const name = mealDisplayName(meal, dish, dish ? analysisMap.get(dish.id) : undefined);
                return <div className={`meal-choice ${choices.length === 1 ? 'single' : ''}`} key={meal.id}>
                  <button className="meal-cell filled" data-meal-id={meal.id} disabled={pending} title={name}
                    aria-label={`${label} : ${name}${meal.household ? ` ; convives personnalisés : ${householdSummary(meal.household)}` : ''}`}
                    onClick={() => onSelect(date, slot, visibleDay, meal.index)}>
                    <span className="meal-name">{name}</span>
                    {choices.length === 1 && meal.household && <Users className="meal-guests-marker" size={14} aria-hidden="true" />}
                  </button>
                  {choices.length === 1 && <button className="meal-add-second" aria-label={`${label} : ajouter un deuxième plat`}
                    title="Ajouter un deuxième plat" onClick={() => onSelect(date, slot, visibleDay, first?.text.trim() ? 1 : undefined)}><Plus size={16} /></button>}
                </div>;
              }) : <button className="meal-cell" disabled={pending} aria-label={`${label} : choisir un repas`}
                onClick={() => onSelect(date, slot, visibleDay)}>
                {pending ? <LoaderCircle size={16} className="spinning" aria-label="Recherche d’un repas en cours" />
                  : <><Plus size={16} strokeWidth={1.4} /><span className="placeholder">À imaginer</span></>}
              </button>}
              {!choices.length && <div className="meal-quick-actions">
                <LevelButton className="meal-quick-button" disabled={Boolean(busy)} preferred={cookingLevel}
                  title="Générer un repas de saison avec l’IA (appui long : choisir le niveau)"
                  aria-label={`${label} : générer un repas de saison avec l’IA`}
                  menuTitle="Générer avec l’IA" menuSubtitle={`Pour le ${label} : choisissez le niveau de cuisine de ce repas. Celui des paramètres ne change pas.`}
                  onPress={() => void fill(date, slot, 'ai')} onLevel={level => void fill(date, slot, 'ai', level)}><Sparkles size={16} /></LevelButton>
                <LevelButton className="meal-quick-button" disabled={Boolean(busy)} preferred={cookingLevel}
                  title="Piocher un repas de saison dans le carnet (appui long : choisir le niveau)"
                  aria-label={`${label} : piocher un repas de saison dans le carnet`}
                  menuTitle="Piocher au hasard" menuSubtitle={`Pour le ${label} : tirage parmi les plats de saison du carnet au niveau choisi.`}
                  levelCounts={() => seasonalLevelCounts(dishes, analyses, date)}
                  onPress={() => void fill(date, slot, 'random')} onLevel={level => void fill(date, slot, 'random', level)}><Shuffle size={16} /></LevelButton>
              </div>}
            </div>;
          })}
        </div>)}
      </div>
      <div className="scroll-footer">
        <button className="icon-button" aria-label="Voir les sept jours précédents" onClick={() => scroll.current?.scrollBy({ top: -rowHeight() * 7, behavior: 'smooth' })}><ArrowUp size={16} /></button>
        <span>Faites défiler pour changer de jours</span>
        <button className="icon-button" aria-label="Voir les sept jours suivants" onClick={() => scroll.current?.scrollBy({ top: rowHeight() * 7, behavior: 'smooth' })}><ArrowDown size={16} /></button>
      </div>
    </div>
    {error && <Modal title="Repas non choisi" onClose={() => setError(null)}><p role="alert">{error}</p></Modal>}
  </section>;
}
