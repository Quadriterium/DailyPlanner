import { useState } from 'react';
import { ArrowUpRight, Check, Leaf, Search, Trash2 } from 'lucide-react';
import {
  dishDetails, formatDate, normalizedName, seasonalDishes, seasonForDate, seasonLabels,
  type Analysis, type Dish, type Meal, type Slot,
} from '../shared/model';
import { EmptyState, Modal } from './components';
import { errorMessage, save } from './store';
import type { Draft } from './repository';
import { newId } from './id';

export function MealEditor({ date, slot, meal, today, dishes, analyses, onClose, onSaved }: {
  date: string; slot: Slot; meal?: Meal; today: string; dishes: Dish[]; analyses: Analysis[];
  onClose: () => void; onSaved: () => void;
}) {
  const [text, setText] = useState(meal?.text ?? '');
  const [query, setQuery] = useState('');
  const [allSeasons, setAllSeasons] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const season = seasonForDate(date);
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const available = dishes.filter(dish => !dish.archived);
  const seasonal = seasonalDishes(available, analyses, date);
  const suggestions = (allSeasons ? available : seasonal)
    .map(dish => ({ dish, details: dishDetails(dish, analysisMap.get(dish.id)) }))
    .filter(({ details }) => normalizedName(details.name).includes(normalizedName(query)))
    .sort((a, b) => a.details.name.localeCompare(b.details.name, 'fr'));

  async function commit(value: string, chosenDish?: Dish) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const drafts: Draft[] = [];
    let dishId: string | null = null;
    if (value.trim()) {
      const existing = chosenDish ?? available.find(dish =>
        normalizedName(dish.name) === normalizedName(value) ||
        normalizedName(dishDetails(dish, analysisMap.get(dish.id)).name) === normalizedName(value));
      if (existing) dishId = existing.id;
      else {
        dishId = newId();
        drafts.push({
          type: 'dish', id: dishId, name: value.trim(), creationSeason: seasonForDate(today),
          analysisKey: newId(), details: null, archived: false,
        });
      }
    }
    drafts.push({ type: 'meal', id: `${date}:${slot}`, date, slot, text: value.trim(), dishId });
    try {
      await save(drafts);
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  return <Modal title="Qu’est-ce qu’on mange ?" onClose={onClose}>
    <p className="modal-subtitle">{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} · {slot === 'lunch' ? 'Midi' : 'Soir'}</p>
    <form onSubmit={event => { event.preventDefault(); if (text.trim()) void commit(text); }}>
      <label className="field-label" htmlFor="meal-name">Votre idée du jour</label>
      <textarea id="meal-name" placeholder="Par exemple : poulet, frites et salade…" value={text} maxLength={240} rows={2}
        onChange={event => setText(event.target.value)} />
      <p className="field-hint">Écrivez simplement. Votre recette sera classée en arrière-plan, sans changer ce texte dans le planning.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="editor-actions">
        {meal?.text && <button className="text-button danger" type="button" disabled={busy} onClick={() => void commit('')}><Trash2 size={16} />Vider</button>}
        <button className="primary-button" disabled={busy || !text.trim()}><Check size={17} />{busy ? 'Enregistrement…' : 'Garder ce repas'}</button>
      </div>
    </form>
    <div className="section-divider"><span>ou piocher dans le carnet</span><Leaf size={15} /></div>
    <div className="filter-tabs" aria-label="Saison des suggestions">
      <button aria-pressed={!allSeasons} onClick={() => setAllSeasons(false)}>De saison <span>{seasonal.length}</span></button>
      <button aria-pressed={allSeasons} onClick={() => setAllSeasons(true)}>Tous les repas <span>{available.length}</span></button>
    </div>
    {available.length > 0 && <label className="search-field"><Search size={17} /><input type="search" aria-label="Rechercher un repas" placeholder="Retrouver une envie…" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <div className="suggestions">
      {suggestions.map(({ dish, details }) => <button className="suggestion" key={dish.id} disabled={busy} onClick={() => void commit(details.name, dish)}>
        <span className="suggestion-icon"><Leaf size={18} strokeWidth={1.4} /></span>
        <span><strong>{details.name}</strong><small>{details.seasons.map(value => seasonLabels[value]).join(' · ')}</small></span>
        <ArrowUpRight size={17} />
      </button>)}
      {suggestions.length === 0 && <EmptyState title={available.length ? 'Pas encore d’idée par ici' : 'Votre carnet commence ici'}>
        {available.length ? `Aucun repas ${allSeasons ? 'correspondant' : `pour cette saison (${seasonLabels[season].toLowerCase()})`}. Essayez un autre filtre ou créez le vôtre.`
          : 'Ajoutez votre premier repas ci-dessus. Il vous attendra ici la prochaine fois.'}
      </EmptyState>}
    </div>
  </Modal>;
}
