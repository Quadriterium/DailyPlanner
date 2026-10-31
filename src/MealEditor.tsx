import { useState } from 'react';
import { ArrowUpRight, Check, Leaf, Pencil, Search, Shuffle, Sparkles, Trash2 } from 'lucide-react';
import {
  dishDetails, formatDate, mealDisplayName, normalizedName, recipeUrl, seasonalDishes, seasonForDate, seasonLabels,
  type Analysis, type Dish, type Meal, type Slot,
} from '../shared/model';
import { EmptyState, Modal } from './components';
import { errorMessage, fillMeal, save } from './store';
import type { Draft } from './repository';
import { newId } from './id';

export function MealEditor({ date, slot, start, meal, today, dishes, analyses, onClose, onSaved }: {
  date: string; slot: Slot; start: string; meal?: Meal; today: string; dishes: Dish[]; analyses: Analysis[];
  onClose: () => void; onSaved: () => void;
}) {
  const [text, setText] = useState(meal?.text ?? '');
  const [query, setQuery] = useState('');
  const [allSeasons, setAllSeasons] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!meal?.text);
  const [filling, setFilling] = useState<'ai' | 'random' | null>(null);
  const season = seasonForDate(date);
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const currentDish = dishes.find(dish => dish.id === meal?.dishId);
  const currentAnalysis = currentDish ? analysisMap.get(currentDish.id) : undefined;
  const currentDetails = currentDish ? dishDetails(currentDish, currentAnalysis) : undefined;
  const displayName = meal ? mealDisplayName(meal, currentDish, currentAnalysis) : '';
  const analysisError = !currentDish?.details && currentAnalysis?.analysisKey === currentDish?.analysisKey
    ? currentAnalysis?.error : null;
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
    const url = recipeUrl(value);
    if (value.trim()) {
      const existing = chosenDish ?? available.find(dish =>
        url ? (dish.sourceUrl ?? recipeUrl(dish.name)) === url :
          normalizedName(dish.name) === normalizedName(value) ||
          normalizedName(dishDetails(dish, analysisMap.get(dish.id)).name) === normalizedName(value));
      if (existing) dishId = existing.id;
      else {
        dishId = newId();
        drafts.push({
          type: 'dish', id: dishId, name: value.trim(), creationSeason: seasonForDate(today),
          analysisKey: newId(), details: null, archived: false,
          ...(url ? { sourceUrl: url } : {}),
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

  async function replace(mode: 'ai' | 'random') {
    if (busy) return;
    setBusy(true);
    setFilling(mode);
    setError(null);
    try {
      await fillMeal(date, slot, start, mode, meal);
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
      setFilling(null);
    }
  }

  return <Modal title={editing ? 'Qu’est-ce qu’on mange ?' : 'Votre repas'} onClose={onClose}>
    <p className="modal-subtitle">{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} · {slot === 'lunch' ? 'Midi' : 'Soir'}</p>
    {!editing ? <>
      <h3 className="meal-detail-name">{displayName}</h3>
      <div className="action-grid" aria-busy={busy}>
        <button className="secondary-button" disabled={busy} onClick={() => { setText(displayName); setEditing(true); }}><Pencil size={17} />Modifier le repas</button>
        <button className="secondary-button danger" disabled={busy} onClick={() => void commit('')}><Trash2 size={16} />Vider</button>
        <button className="secondary-button" disabled={busy} onClick={() => void replace('ai')}><Sparkles size={17} />{filling === 'ai' ? 'Génération…' : 'Générer avec l’IA'}</button>
        <button className="secondary-button" disabled={busy} onClick={() => void replace('random')}><Shuffle size={17} />{filling === 'random' ? 'Recherche…' : 'Choisir au hasard'}</button>
      </div>
      <p className="field-hint">Remplacer ou vider ce créneau conserve la fiche dans le carnet.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <section className="meal-recipe" aria-label="Recette du repas">
        <h3>La recette</h3>
        {currentDetails && currentDetails.name !== displayName && <p className="field-hint">Fiche du carnet : {currentDetails.name}</p>}
        {currentDish?.sourceUrl && <p className="field-hint"><a href={currentDish.sourceUrl} target="_blank" rel="noopener noreferrer">Voir la recette d’origine</a></p>}
        {currentDetails && currentDetails.ingredients.length > 0 && <>
          <h4>Ingrédients principaux</h4>
          <ul>{currentDetails.ingredients.map((ingredient, index) => <li key={index}>{ingredient}</li>)}</ul>
        </>}
        {currentDetails?.recipe ? <p className="recipe-text">{currentDetails.recipe}</p>
          : <p className="field-hint">{analysisError
            ? 'La recette n’a pas pu être enrichie. Vous pouvez relancer l’IA depuis le carnet.'
            : currentDish && !currentDish.details
              ? 'La recette n’est pas encore disponible. L’enrichissement se fait en arrière-plan après synchronisation.'
              : 'Aucune recette disponible pour ce repas.'}</p>}
        {analysisError && <p className="inline-error" role="alert">{analysisError}</p>}
        <p className="field-hint">Les ingrédients et la recette sont indicatifs. Vérifiez la composition réelle et la cuisson ; ils ne garantissent pas l’absence d’allergènes.</p>
      </section>
    </> : <>
    <form onSubmit={event => { event.preventDefault(); if (text.trim()) void commit(text); }}>
      <label className="field-label" htmlFor="meal-name">Votre idée du jour</label>
      <textarea id="meal-name" placeholder="Un plat ou un lien de recette https://…" value={text} maxLength={2048} rows={2}
        onChange={event => setText(event.target.value)} />
      <p className="field-hint">Collez un lien HTTP ou HTTPS : l’IA identifiera le plat et adaptera la recette au foyer des paramètres après synchronisation. Nom : 240 caractères ; lien : 2 048.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="action-grid">
        {meal?.text && <button className="secondary-button danger" type="button" disabled={busy} onClick={() => void commit('')}><Trash2 size={16} />Vider</button>}
        <button className={`primary-button ${meal?.text ? '' : 'wide'}`} disabled={busy || !text.trim()}><Check size={17} />{busy && !filling ? 'Enregistrement…' : 'Garder ce repas'}</button>
      </div>
    </form>
    {!meal?.text && <>
      <div className="section-divider"><span>ou une idée de saison</span><Sparkles size={15} /></div>
      <div className="action-grid flush" aria-busy={Boolean(filling)}>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void replace('ai')}><Sparkles size={17} />{filling === 'ai' ? 'Génération…' : 'Générer avec l’IA'}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void replace('random')}><Shuffle size={17} />{filling === 'random' ? 'Recherche…' : 'Choisir au hasard'}</button>
      </div>
    </>}
    <div className="section-divider"><span>ou piocher dans le carnet</span><Leaf size={15} /></div>
    <div className="filter-tabs segmented" aria-label="Saison des suggestions">
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
    </>}
  </Modal>;
}
