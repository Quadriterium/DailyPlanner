import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, Leaf, LoaderCircle, Moon, Plus, Shuffle, Sparkles, Sun } from 'lucide-react';
import { addDays, formatDate, isoWeekday, seasonForDate, seasonLabels, type Meal, type Slot } from '../shared/model';
import { Modal } from './components';
import { errorMessage, fillMeal } from './store';

export function Planner({ today, meals, onSelect, onSaved }: {
  today: string; meals: Meal[]; onSelect: (date: string, slot: Slot, start: string) => void; onSaved: () => void;
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

  async function fill(date: string, slot: Slot, mode: 'ai' | 'random') {
    if (filling.current) return;
    filling.current = true;
    setBusy(`${date}:${slot}`);
    try {
      await fillMeal(date, slot, visibleDay, mode);
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
            const meal = mealMap.get(`${date}:${slot}`);
            const label = `${formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${slot === 'lunch' ? 'midi' : 'soir'}`;
            const pending = busy === `${date}:${slot}`;
            return <div key={slot} className={`meal-slot ${meal?.text ? 'filled' : 'empty'}`} aria-busy={pending}>
              <button className={`meal-cell ${meal?.text ? 'filled' : ''}`} disabled={pending}
              aria-label={`${label}${meal?.text ? ` : ${meal.text}` : ' : choisir un repas'}`}
              onClick={() => onSelect(date, slot, visibleDay)}>
              {meal?.text ? <span>{meal.text}</span> : pending ? <LoaderCircle size={16} className="spinning" aria-label="Recherche d’un repas en cours" />
                : <><Plus size={16} strokeWidth={1.4} /><span className="placeholder">À imaginer</span></>}
              </button>
              {!meal?.text && <div className="meal-quick-actions">
                <button className="meal-quick-button" disabled={Boolean(busy)} title="Générer un repas de saison avec l’IA"
                  aria-label={`${label} : générer un repas de saison avec l’IA`} onClick={() => void fill(date, slot, 'ai')}><Sparkles size={16} /></button>
                <button className="meal-quick-button" disabled={Boolean(busy)} title="Piocher un repas de saison dans le carnet"
                  aria-label={`${label} : piocher un repas de saison dans le carnet`} onClick={() => void fill(date, slot, 'random')}><Shuffle size={16} /></button>
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
