import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Leaf, Minus, Pencil, Plus, Search, Shuffle, Sparkles, Trash2, Users } from 'lucide-react';
import {
  cookingLevelLabels, defaultCookingLevel, defaultHousehold, dishDetails, formatDate, householdCategories, householdSchema, householdSummary, mealDisplayName,
  mealHousehold, mealId, normalizedName, recipeUrl, seasonalDishes, seasonForDate, seasonLabels,
  type Analysis, type CookingLevel, type Dish, type Household, type Meal, type Slot,
} from '../shared/model';
import { EmptyState, Modal } from './components';
import { LevelButton, LevelTag, seasonalLevelCounts } from './CookingLevel';
import { errorMessage, fillMeal, save, saveMealHousehold } from './store';
import type { Draft } from './repository';
import { newId } from './id';

export function MealEditor({ date, slot, start, index, meal, today, dishes, analyses, household = defaultHousehold, cookingLevel, onAddDish, onClose, onSaved }: {
  date: string; slot: Slot; start: string; meal?: Meal; today: string; dishes: Dish[]; analyses: Analysis[];
  index?: 1;
  household?: Household;
  cookingLevel?: CookingLevel;
  onAddDish?: () => void;
  onClose: () => void; onSaved: () => void;
}) {
  const [text, setText] = useState(meal?.text ?? '');
  const [query, setQuery] = useState('');
  const [allSeasons, setAllSeasons] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!meal?.text);
  const [filling, setFilling] = useState<'ai' | 'random' | null>(null);
  const [guestMeal, setGuestMeal] = useState<Meal | null>(null);
  const [useDefaults, setUseDefaults] = useState(true);
  const [guestDraft, setGuestDraft] = useState({ adults: '', teenagers: '', children: '' });
  const [guestError, setGuestError] = useState<string | null>(null);
  const [guestsSaved, setGuestsSaved] = useState(false);
  const guestsButton = useRef<HTMLButtonElement>(null);
  const defaultsCheckbox = useRef<HTMLInputElement>(null);
  const wasEditingGuests = useRef(false);
  const guests = mealHousehold(meal, household);
  useEffect(() => {
    if (guestMeal) defaultsCheckbox.current?.focus();
    else if (wasEditingGuests.current) guestsButton.current?.focus();
    wasEditingGuests.current = Boolean(guestMeal);
  }, [guestMeal]);
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
    drafts.push({ type: 'meal', id: mealId(date, slot, index), date, slot, ...(index === 1 ? { index } : {}), text: value.trim(), dishId,
      household: value.trim() ? meal?.household ?? null : null });
    try {
      await save(drafts);
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }

  async function replace(mode: 'ai' | 'random', level?: CookingLevel) {
    if (busy) return;
    setBusy(true);
    setFilling(mode);
    setError(null);
    try {
      await fillMeal(date, slot, start, mode, meal, index, level);
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
      setFilling(null);
    }
  }

  function levelButtons(disabled: boolean) {
    return <>
      <LevelButton className="secondary-button" disabled={disabled} preferred={cookingLevel} title="Appui long : choisir le niveau de cuisine"
        menuTitle="Générer avec l’IA" menuSubtitle="Choisissez le niveau de cuisine de ce repas. Celui des paramètres ne change pas."
        onPress={() => void replace('ai')} onLevel={level => void replace('ai', level)}>
        <Sparkles size={17} />{filling === 'ai' ? 'Génération…' : 'Générer avec l’IA'}</LevelButton>
      <LevelButton className="secondary-button" disabled={disabled} preferred={cookingLevel} title="Appui long : choisir le niveau de cuisine"
        menuTitle="Choisir au hasard" menuSubtitle="Tirage parmi les plats de saison du carnet au niveau choisi."
        levelCounts={() => seasonalLevelCounts(available, analyses, date)}
        onPress={() => void replace('random')} onLevel={level => void replace('random', level)}>
        <Shuffle size={17} />{filling === 'random' ? 'Recherche…' : 'Choisir au hasard'}</LevelButton>
    </>;
  }
  const levelHint = `Niveau « ${cookingLevelLabels[cookingLevel ?? defaultCookingLevel]} » par défaut : appui long sur « Générer avec l’IA » ou « Choisir au hasard » pour en choisir un autre.`;

  function editGuests() {
    if (!meal) return;
    setGuestMeal(meal);
    setUseDefaults(!meal.household);
    setGuestDraft({ adults: String(guests.adults), teenagers: String(guests.teenagers), children: String(guests.children) });
    setGuestError(null);
    setGuestsSaved(false);
  }

  async function commitGuests() {
    if (busy || !guestMeal) return;
    const parsed = householdSchema.safeParse({
      adults: guestDraft.adults.trim() ? Number(guestDraft.adults) : NaN,
      teenagers: guestDraft.teenagers.trim() ? Number(guestDraft.teenagers) : NaN,
      children: guestDraft.children.trim() ? Number(guestDraft.children) : NaN,
    });
    if (!useDefaults && !parsed.success) {
      setGuestError('Indiquez entre 0 et 20 convives par catégorie, avec au moins une personne au total.');
      return;
    }
    setBusy(true);
    setGuestError(null);
    try {
      await saveMealHousehold(guestMeal, !useDefaults && parsed.success ? parsed.data : null);
      setGuestMeal(null);
      setGuestsSaved(true);
      onSaved();
    } catch (cause) { setGuestError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return <Modal title={editing ? 'Qu’est-ce qu’on mange ?' : 'Votre repas'} onClose={onClose}>
    <p className="modal-subtitle">{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} · {slot === 'lunch' ? 'Midi' : 'Soir'}{index === 1 ? ' · Deuxième plat' : ''}</p>
    {!editing ? <>
      <h3 className="meal-detail-name">{displayName}</h3>
      <section className="meal-guests" aria-label="Convives du repas">
        <div className="meal-guests-heading"><h3><Users size={18} />À table pour ce repas</h3>
          <span className="meal-guests-source">{meal?.household ? 'Personnalisé' : 'Selon vos paramètres'}</span></div>
        {!guestMeal ? <>
          <button ref={guestsButton} className="meal-guests-summary" disabled={busy} onClick={editGuests}>
            <span>{householdSummary(guests)}</span><span className="meal-guests-edit">Adapter<ChevronDown size={16} /></span>
          </button>
          {guestsSaved && <p className="field-hint" role="status">Convives enregistrés pour ce repas.</p>}
        </> : <form id="meal-guests-form" noValidate onSubmit={event => { event.preventDefault(); void commitGuests(); }}>
          <fieldset disabled={busy}>
            <legend className="sr-only">Choisir les convives de ce repas</legend>
            <label className="meal-guests-default"><input ref={defaultsCheckbox} type="checkbox" checked={useDefaults}
              onChange={event => { setUseDefaults(event.target.checked); setGuestError(null); }} />Utiliser le foyer des paramètres</label>
            {useDefaults ? <p className="field-hint">{householdSummary(household)}. Ce repas suivra les changements de votre foyer.</p>
              : <div className="meal-guests-counts">{householdCategories.map(([person, label]) => <div className="meal-guest-row" key={person}>
                <label htmlFor={`meal-${person}`}>{label}</label>
                <div className="meal-guest-stepper">
                  <button type="button" aria-label={`Retirer un ${label.toLocaleLowerCase('fr-FR').slice(0, -1)}`}
                    disabled={!guestDraft[person].trim() || !Number.isInteger(Number(guestDraft[person])) || Number(guestDraft[person]) <= 0}
                    onClick={() => { setGuestDraft(current => ({ ...current, [person]: String(Number(current[person]) - 1) })); setGuestError(null); }}><Minus size={16} /></button>
                  <input id={`meal-${person}`} type="number" inputMode="numeric" min="0" max="20" step="1" required
                    value={guestDraft[person]} onChange={event => { setGuestDraft(current => ({ ...current, [person]: event.target.value })); setGuestError(null); }} />
                  <button type="button" aria-label={`Ajouter un ${label.toLocaleLowerCase('fr-FR').slice(0, -1)}`}
                    disabled={!guestDraft[person].trim() || !Number.isInteger(Number(guestDraft[person])) || Number(guestDraft[person]) >= 20}
                    onClick={() => { setGuestDraft(current => ({ ...current, [person]: String(Number(current[person]) + 1) })); setGuestError(null); }}><Plus size={16} /></button>
                </div>
              </div>)}</div>}
          </fieldset>
          <p className="field-hint">Uniquement pour ce plat : le foyer et les autres plats restent inchangés.</p>
          {guestError && <p className="inline-error" role="alert">{guestError}</p>}
          <div className="action-grid">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => { setGuestMeal(null); setGuestError(null); }}>Annuler</button>
            <button className="primary-button" disabled={busy}><Check size={17} />{busy ? 'Enregistrement…' : 'Enregistrer les convives'}</button>
          </div>
        </form>}
      </section>
      <div className="action-grid" aria-busy={busy}>
        <button className="secondary-button" disabled={busy || Boolean(guestMeal)} onClick={() => { setText(displayName); setEditing(true); }}><Pencil size={17} />Modifier le repas</button>
        <button className="secondary-button danger" disabled={busy || Boolean(guestMeal)} onClick={() => void commit('')}><Trash2 size={16} />Vider</button>
        {levelButtons(busy || Boolean(guestMeal))}
        {meal?.text && onAddDish && <button className="secondary-button wide" disabled={busy || Boolean(guestMeal)}
          onClick={onAddDish}><Plus size={17} />Ajouter un deuxième plat</button>}
      </div>
      <p className="field-hint">Remplacer ou vider ce plat conserve sa fiche dans le carnet et ne change pas l’autre plat du créneau. {levelHint}</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <section className="meal-recipe" aria-label="Recette du repas">
        <h3>La recette</h3>
        {currentDetails?.level && <p className="meal-level">Niveau de cuisine : <LevelTag level={currentDetails.level} /></p>}
        {currentDetails && currentDetails.name !== displayName && <p className="field-hint">Fiche du carnet : {currentDetails.name}</p>}
        {currentDish?.sourceUrl && <p className="field-hint"><a href={currentDish.sourceUrl} target="_blank" rel="noopener noreferrer">Voir la recette d’origine</a></p>}
        {currentDetails && currentDetails.ingredients.length > 0 && <>
          <h4>Ingrédients principaux</h4>
          {meal?.household && <p className="field-hint">Les convives sont personnalisés pour ce repas. Les quantités de la fiche du carnet ne sont pas recalculées.</p>}
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
        {levelButtons(busy)}
      </div>
      <p className="field-hint">{levelHint}</p>
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
        <span><strong>{details.name}</strong><small>{details.seasons.map(value => seasonLabels[value]).join(' · ')}{details.level ? ` · ${cookingLevelLabels[details.level]}` : ''}</small></span>
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
