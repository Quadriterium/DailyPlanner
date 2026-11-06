import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Ban, BookOpen, Check, Leaf, LoaderCircle, Minus, Pencil, Plus, RotateCcw, Search, Shuffle, Sparkles, Trash2, Users } from 'lucide-react';
import {
  cookingLevelLabels, defaultHousehold, dishDetails, formatDate, formatPortions, householdCategories, householdCount, householdPortions, householdSchema,
  householdSummary, matchesDiet, mealDisplayName, mealHousehold, mealId, normalizedName, recipeUrl, seasonalDishes, seasonForDate, seasonLabels, vegetarianForSlot,
  type Analysis, type CatalogEntry, type CookingLevel, type DietarySettings, type Dish, type DishDetails, type Household, type Meal, type Slot,
} from '../shared/model';
import { EmptyState, GenerationProgress, Modal } from './components';
import { LevelButton, LevelTag, seasonalLevelCounts } from './CookingLevel';
import { errorMessage, fillMeal, save, saveMealHousehold, setDishGenerationExcluded, sharedRandomCandidates, signInHint, useServerFeatures } from './store';
import { useCatalog } from './catalog';
import type { Draft } from './repository';
import { newId } from './id';
import { scaleRecipe } from '../shared/recipe';

interface Completion { dish?: Dish; entry?: CatalogEntry; details: DishDetails }

export function MealEditor({ date, slot, start, index, meal, today, dishes, analyses, aiConfigured, household = defaultHousehold, cookingLevel, dietarySettings, onAddDish, onClose, onSaved, onSignInRequired }: {
  date: string; slot: Slot; start: string; meal?: Meal; today: string; dishes: Dish[]; analyses: Analysis[];
  aiConfigured: boolean;
  index?: 1;
  household?: Household;
  cookingLevel?: CookingLevel;
  dietarySettings?: DietarySettings;
  onAddDish?: () => void;
  onClose: () => void; onSaved: () => void;
  onSignInRequired: () => void;
}) {
  const [text, setText] = useState(meal?.text ?? '');
  const [chosenDish, setChosenDish] = useState<Dish>();
  const [chosenEntry, setChosenEntry] = useState<CatalogEntry>();
  const catalog = useCatalog();
  const [completing, setCompleting] = useState(false);
  const [activeOption, setActiveOption] = useState(-1);
  const ideaInput = useRef<HTMLInputElement>(null);
  const serverFeatures = useServerFeatures();
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
  const [managing, setManaging] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const wasManaging = useRef(false);
  const guests = mealHousehold(meal, household);
  const guestCount = householdCount(guests);
  const guestPortions = householdPortions(guests);
  useEffect(() => {
    if (guestMeal) defaultsCheckbox.current?.focus();
    else if (wasEditingGuests.current) guestsButton.current?.focus();
    wasEditingGuests.current = Boolean(guestMeal);
  }, [guestMeal]);
  useEffect(() => {
    if (wasManaging.current && !managing && !editing) manageButton.current?.focus({ preventScroll: true });
    wasManaging.current = managing;
  }, [managing, editing]);
  const season = seasonForDate(date);
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const currentDish = dishes.find(dish => dish.id === meal?.dishId);
  const currentAnalysis = currentDish ? analysisMap.get(currentDish.id) : undefined;
  const sourceDetails = currentDish ? dishDetails(currentDish, currentAnalysis) : undefined;
  const currentDetails = sourceDetails ? scaleRecipe(sourceDetails, guestPortions) : undefined;
  const draftHousehold = householdSchema.safeParse(useDefaults ? household : {
    adults: guestDraft.adults.trim() ? Number(guestDraft.adults) : NaN,
    teenagers: guestDraft.teenagers.trim() ? Number(guestDraft.teenagers) : NaN,
    children: guestDraft.children.trim() ? Number(guestDraft.children) : NaN,
  });
  const preview = sourceDetails && draftHousehold.success ? scaleRecipe(sourceDetails, householdPortions(draftHousehold.data)) : undefined;
  const displayName = meal ? mealDisplayName(meal, currentDish, currentAnalysis) : '';
  const analysisError = !currentDish?.details && currentAnalysis?.analysisKey === currentDish?.analysisKey
    ? currentAnalysis?.error : null;
  const available = dishes.filter(dish => !dish.archived);
  const vegetarian = vegetarianForSlot(dietarySettings, slot);
  const eligible = available.filter(dish => matchesDiet(dishDetails(dish, analysisMap.get(dish.id)), vegetarian));
  const eligibleCatalog = catalog.filter(entry => matchesDiet(entry.details, vegetarian));
  const typed = normalizedName(text);
  const carnetCompletions: Completion[] = text.trim() && !recipeUrl(text) ? eligible
    .map(dish => ({ dish, details: dishDetails(dish, analysisMap.get(dish.id)) }))
    .filter(({ dish, details }) => [dish.name, details.name].some(name => normalizedName(name).includes(typed)))
    .sort((a, b) => a.details.name.localeCompare(b.details.name, 'fr')).slice(0, 6) : [];
  const knownNames = new Set(available.flatMap(dish => [dish.name, dishDetails(dish, analysisMap.get(dish.id)).name].map(normalizedName)));
  // Carnet first, then the shared catalogue (all seasons), without duplicating a dish already in the carnet.
  const completions: Completion[] = text.trim() && !recipeUrl(text) ? [...carnetCompletions, ...eligibleCatalog
    .filter(entry => normalizedName(entry.details.name).includes(typed) && !knownNames.has(normalizedName(entry.details.name)))
    .slice(0, Math.max(3, 8 - carnetCompletions.length))
    .map(entry => ({ entry, details: entry.details }))] : [];
  const showCompletions = completing && completions.length > 0;
  const analysisPending = currentDish && !currentDish.details &&
    (!currentAnalysis || currentAnalysis.analysisKey !== currentDish.analysisKey ||
      currentAnalysis.status === 'pending' || currentAnalysis.status === 'processing');
  function chooseCompletion(index: number) {
    const option = completions[index];
    if (!option) return;
    setText(option.details.name);
    setChosenDish(option.dish);
    setChosenEntry(option.entry);
    setCompleting(false);
    setActiveOption(-1);
    ideaInput.current?.focus();
  }
  const seasonal = seasonalDishes(eligible, analyses, date);
  const suggestions = (allSeasons ? eligible : seasonal)
    .map(dish => ({ dish, details: dishDetails(dish, analysisMap.get(dish.id)) }))
    .filter(({ details }) => normalizedName(details.name).includes(normalizedName(query)))
    .sort((a, b) => a.details.name.localeCompare(b.details.name, 'fr'));

  async function commit(value: string, chosenDish?: Dish, chosenEntry?: CatalogEntry) {
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
      // A shared recipe is copied into the household carnet: no AI call, and later corrections stay private.
      const shared = existing ? undefined : chosenEntry ?? catalog.find(entry => url
        ? entry.sourceUrl === url : normalizedName(entry.details.name) === normalizedName(value));
      if (existing) dishId = existing.id;
      else {
        dishId = newId();
        drafts.push({
          type: 'dish', id: dishId, name: shared ? shared.details.name : value.trim(), creationSeason: seasonForDate(today),
          analysisKey: newId(), details: shared ? shared.details : null, archived: false,
          ...(url ? { sourceUrl: url } : shared?.sourceUrl ? { sourceUrl: shared.sourceUrl } : {}),
        });
      }
    } else if (currentDish && !currentDish.excludedGenerationDates?.includes(date)) {
      drafts.push({
        ...currentDish,
        excludedGenerationDates: [...new Set([...(currentDish.excludedGenerationDates ?? []), date])],
      });
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

  async function toggleGenerationExclusion() {
    if (!currentDish || busy) return;
    const excluded = !currentDish.excludedFromGeneration;
    setBusy(true);
    setError(null);
    setGenerationStatus(null);
    try {
      await setDishGenerationExcluded(currentDish.id, excluded);
      setGenerationStatus(excluded ? 'Plat exclu des futures générations.' : 'Plat à nouveau autorisé dans les générations.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setBusy(false); }
  }

  async function replace(mode: 'ai' | 'random', level?: CookingLevel, vegetarianMenu = false) {
    if (busy) return;
    if (mode === 'ai' && !serverFeatures) { onSignInRequired(); return; }
    setBusy(true);
    setFilling(mode);
    setError(null);
    try {
      const warning = await fillMeal(date, slot, start, mode, meal, index, level, vegetarianMenu);
      onSaved();
      if (warning) {
        setManaging(false);
        setEditing(false);
        setError(warning);
        setBusy(false);
        setFilling(null);
      } else onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
      setFilling(null);
    }
  }

  function levelButtons(disabled: boolean, replacement = false) {
    return <>
      <LevelButton className={`secondary-button${replacement ? ' wide' : ''}`} disabled={disabled} preferred={cookingLevel}
        title={serverFeatures ? 'Appui long : niveau de cuisine et menu végétarien' : signInHint}
        menuTitle={replacement ? 'Générer un nouveau plat' : 'Générer avec l’IA'} menuSubtitle="Choisissez le niveau de cuisine de ce repas. Celui des paramètres ne change pas."
        vegetarianRequired={vegetarian}
        onPress={() => void replace('ai')} onLevel={(level, vegetarianMenu) => void replace('ai', level, vegetarianMenu)}>
        <Sparkles size={17} />{filling === 'ai' ? 'Génération…' : replacement ? 'Générer un nouveau plat' : 'Générer avec l’IA'}</LevelButton>
      {!replacement && <LevelButton className="secondary-button" disabled={disabled} preferred={cookingLevel} title="Appui long : choisir le niveau de cuisine"
        menuTitle="Choisir au hasard" menuSubtitle="Tirage parmi les plats de saison du carnet et du catalogue commun au niveau choisi."
        levelCounts={() => {
          const counts = seasonalLevelCounts(eligible, analyses, date);
          for (const entry of sharedRandomCandidates(date).filter(entry => matchesDiet(entry.details, vegetarian))) if (entry.details.level) counts[entry.details.level]++;
          return counts;
        }}
        onPress={() => void replace('random')} onLevel={level => void replace('random', level)}>
        <Shuffle size={17} />{filling === 'random' ? 'Recherche…' : 'Choisir au hasard'}</LevelButton>}
    </>;
  }
  function editGuests() {
    if (!meal) return;
    setGuestMeal(meal);
    setUseDefaults(!meal.household);
    setGuestDraft({ adults: String(guests.adults), teenagers: String(guests.teenagers), children: String(guests.children) });
    setGuestError(null);
    setGuestsSaved(false);
  }

  function changeGuest(person: keyof Household, value: string) {
    setGuestDraft(current => ({
      ...(useDefaults ? { adults: String(household.adults), teenagers: String(household.teenagers), children: String(household.children) } : current),
      [person]: value,
    }));
    setUseDefaults(false);
    setGuestError(null);
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

  return <><Modal title={editing ? 'Qu’est-ce qu’on mange ?' : 'Votre repas'} onClose={onClose} dismissible={filling !== 'ai'}>
    <p className="modal-subtitle">{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} · {slot === 'lunch' ? 'Midi' : 'Soir'}{index === 1 ? ' · Deuxième plat' : ''}</p>
    {vegetarian && editing && <p className="field-hint">Suggestions et génération végétariennes pour ce repas. Les fiches non classées sont exclues ; la saisie libre reste possible.</p>}
    {!editing ? <>
      <h3 className="meal-detail-name">{displayName}</h3>
      {currentDish?.excludedFromGeneration && <p className="field-hint">Exclu des générations automatiques.</p>}
      <button ref={guestsButton} className="meal-guests-chip" disabled={busy} onClick={editGuests}
        aria-haspopup="dialog"
        title={`${householdSummary(guests)} — modifier le nombre de personnes`}>
        <span className="meal-guests-heading"><Users size={22} aria-hidden="true" /><strong>Repas pour {guestCount} {guestCount > 1 ? 'personnes' : 'personne'}</strong><Pencil size={16} aria-hidden="true" /></span>
        <span className="meal-guests-breakdown">{householdCategories.map(([key, label]) =>
          <span key={key}><b>{guests[key]}</b> {label.toLocaleLowerCase('fr-FR').replace(/s$/, guests[key] === 1 ? '' : 's')}</span>)}</span>
        <span className="meal-guests-source">{meal?.household ? 'Convives personnalisés · modifier' : 'Selon les paramètres du foyer · modifier'}</span>
      </button>
      {guestsSaved && <p className="field-hint" role="status">Convives enregistrés pour ce repas.</p>}
      {guestMeal && <Modal title="Convives du repas" onClose={() => { setGuestMeal(null); setGuestError(null); }}>
      <p className="modal-subtitle">{displayName}</p>
      <section className="meal-guests" aria-label="Convives du repas">
        <form id="meal-guests-form" noValidate onSubmit={event => { event.preventDefault(); void commitGuests(); }}>
          <fieldset disabled={busy}>
            <legend className="sr-only">Choisir les convives de ce repas</legend>
            <p className="meal-guests-total" aria-live="polite"><Users size={24} aria-hidden="true" />
              {draftHousehold.success ? `Repas pour ${householdCount(draftHousehold.data)} ${householdCount(draftHousehold.data) > 1 ? 'personnes' : 'personne'}` : 'Vérifiez le nombre de personnes'}</p>
            <p className="meal-guests-source">{useDefaults ? 'Ces nombres viennent des paramètres du foyer.' : 'Composition personnalisée pour ce repas.'}</p>
            <div className="meal-guests-counts">{householdCategories.map(([person, label]) => {
              const count = useDefaults ? String(household[person]) : guestDraft[person];
              return <div className="meal-guest-row" key={person}>
                <label htmlFor={`meal-${person}`}>{label}</label>
                <div className="meal-guest-stepper">
                  <button type="button" aria-label={`Retirer un ${label.toLocaleLowerCase('fr-FR').slice(0, -1)}`}
                    disabled={!count.trim() || !Number.isInteger(Number(count)) || Number(count) <= 0}
                    onClick={() => changeGuest(person, String(Number(count) - 1))}><Minus size={16} /></button>
                  <input id={`meal-${person}`} type="number" inputMode="numeric" min="0" max="20" step="1" required
                    value={count} onChange={event => changeGuest(person, event.target.value)} />
                  <button type="button" aria-label={`Ajouter un ${label.toLocaleLowerCase('fr-FR').slice(0, -1)}`}
                    disabled={!count.trim() || !Number.isInteger(Number(count)) || Number(count) >= 20}
                    onClick={() => changeGuest(person, String(Number(count) + 1))}><Plus size={16} /></button>
                </div>
              </div>;
            })}</div>
            <label className="meal-guests-default"><input ref={defaultsCheckbox} type="checkbox" checked={useDefaults}
              onChange={event => {
                setUseDefaults(event.target.checked);
                setGuestDraft({ adults: String(household.adults), teenagers: String(household.teenagers), children: String(household.children) });
                setGuestError(null);
              }} />Reprendre le nombre de personnes des paramètres</label>
            {useDefaults && <>
              <p className="field-hint">Les changements effectués dans les paramètres s’appliqueront aussi à ce plat.</p>
            </>}
          </fieldset>
          {!useDefaults && <p className="field-hint">Ces nombres ne s’appliqueront qu’à ce plat, sans modifier les paramètres ni les autres plats.</p>}
          {preview && preview.ingredients.length > 0 && <div className="meal-guests-preview" aria-label="Aperçu des quantités" aria-live="polite">
            {preview.base ? <>
              <p><strong>Quantités pour {formatPortions(draftHousehold.success ? householdPortions(draftHousehold.data) : guestPortions)}</strong></p>
              <ul>{preview.ingredients.map((ingredient, index) => <li key={index}>{ingredient}</li>)}</ul>
              {preview.unscaled > 0 && <p className="field-hint">{preview.unscaled} ingrédient(s) sans quantité reconnue, à ajuster si nécessaire.</p>}
              <details><summary>Voir la recette adaptée</summary><p className="recipe-text">{preview.recipe}</p></details>
            </> : <p className="inline-error">Nombre de portions d’origine inconnu : renseignez-le dans le carnet pour activer le recalcul. Les quantités restent celles de la fiche.</p>}
          </div>}
          {guestError && <p className="inline-error" role="alert">{guestError}</p>}
          <div className="action-grid">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => { setGuestMeal(null); setGuestError(null); }}>Annuler</button>
            <button className="primary-button" disabled={busy}><Check size={17} />{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </form>
      </section>
      </Modal>}
      <section className="meal-recipe" aria-label="Recette du repas">
        <h3>La recette</h3>
        {analysisPending && !analysisError && <p className="analysis-progress" role="status">
          {serverFeatures && aiConfigured && <LoaderCircle size={18} className="spinning" aria-hidden="true" />}
          {!serverFeatures ? 'Recette en attente. Connectez-vous pour utiliser l’IA.'
            : !aiConfigured ? 'Recette en attente : l’IA n’est pas configurée sur le serveur.'
              : currentAnalysis?.status === 'processing' ? 'Génération de la recette en cours… Elle s’affichera automatiquement ici.'
                : 'Recette en attente de génération… Elle s’affichera automatiquement ici après synchronisation.'}
        </p>}
        {currentDetails?.level && <p className="meal-level">Niveau de cuisine : <LevelTag level={currentDetails.level} /></p>}
        {currentDetails && currentDetails.name !== displayName && <p className="field-hint">Fiche du carnet : {currentDetails.name}</p>}
        {currentDish?.sourceUrl && <p className="field-hint"><a href={currentDish.sourceUrl} target="_blank" rel="noopener noreferrer">Voir la recette d’origine</a></p>}
        {currentDetails && currentDetails.ingredients.length > 0 && <>
          <h4>Ingrédients principaux</h4>
          {currentDetails.base ? <>
            {currentDetails.unscaled > 0 && <p className="field-hint" role="status">{currentDetails.unscaled} ingrédient(s) sans quantité reconnue, à ajuster si nécessaire.</p>}
          </> : <p className="inline-error" role="status">Nombre de portions d’origine inconnu : renseignez-le dans le carnet pour activer le recalcul. Les quantités restent celles de la fiche, pas nécessairement celles de ce repas.</p>}
          <ul>{currentDetails.ingredients.map((ingredient, index) => <li key={index}>{ingredient}</li>)}</ul>
        </>}
        {currentDetails?.recipe ? <p className="recipe-text">{currentDetails.recipe}</p>
          : analysisPending && !analysisError ? null
          : <p className="field-hint">{analysisError
            ? currentAnalysis?.status === 'pending' ? 'La recette est en attente et reprendra automatiquement lorsque le quota sera disponible.' : 'La recette n’a pas pu être enrichie. Vous pouvez relancer l’IA depuis le carnet.'
            : currentDish && !currentDish.details
              ? 'La recette n’est pas encore disponible. L’enrichissement se fait en arrière-plan après synchronisation.'
              : 'Aucune recette disponible pour ce repas.'}</p>}
        {analysisError && <p className="inline-error" role="alert">{analysisError}</p>}
      </section>
      <div className="action-grid meal-main-actions" aria-busy={busy}>
        <button ref={manageButton} className={`secondary-button ${meal?.text && onAddDish ? '' : 'wide'}`}
          disabled={busy} aria-haspopup="dialog" onClick={() => setManaging(true)}><Pencil size={17} />Modifier le repas</button>
        {meal?.text && onAddDish && <button className="secondary-button" disabled={busy} onClick={onAddDish}><Plus size={17} />Ajouter un plat</button>}
      </div>
      {error && !managing && <p className="inline-error" role="alert">{error}</p>}
    </> : <>
    <form onSubmit={event => { event.preventDefault(); if (text.trim()) void commit(text, chosenDish, chosenEntry); }}>
      <label className="field-label" htmlFor="meal-name">Votre idée du jour</label>
      <div className="meal-autocomplete">
        <input ref={ideaInput} id="meal-name" role="combobox" autoComplete="off" placeholder="Un plat ou un lien de recette…" value={text} maxLength={2048}
          aria-autocomplete="list" aria-expanded={showCompletions} aria-controls={showCompletions ? 'meal-completions' : undefined}
          aria-activedescendant={showCompletions && activeOption >= 0 ? `meal-completion-${activeOption}` : undefined}
          onChange={event => { setText(event.target.value); setChosenDish(undefined); setChosenEntry(undefined); setCompleting(true); setActiveOption(-1); }}
          onKeyDown={event => {
            if (!showCompletions) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveOption(current => current < 0 ? event.key === 'ArrowDown' ? 0 : completions.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : completions.length - 1)) % completions.length);
            } else if (event.key === 'Enter' && activeOption >= 0) {
              event.preventDefault(); chooseCompletion(activeOption);
            } else if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation(); setCompleting(false);
            }
          }} />
        {showCompletions && <div id="meal-completions" role="listbox" aria-label="Plats du carnet et du catalogue commun" className="meal-completions">
          {completions.map(({ dish, entry, details }, index) => <button key={dish?.id ?? entry?.id} id={`meal-completion-${index}`} role="option"
            aria-selected={activeOption === index} type="button" disabled={busy}
            onMouseDown={event => event.preventDefault()} onClick={() => chooseCompletion(index)}>
            {dish ? <Leaf size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}
            <span><strong>{details.name}</strong><small>{dish ? 'Reprendre la recette du carnet' : 'Catalogue commun · ajouter au carnet'}</small></span>
          </button>)}
        </div>}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="action-grid">
        {meal?.text && <button className="secondary-button danger" type="button" disabled={busy} onClick={() => void commit('')}><Trash2 size={16} />Vider</button>}
        <button className={`primary-button ${meal?.text ? '' : 'wide'}`} disabled={busy || !text.trim()}><Check size={17} />{busy && !filling ? 'Enregistrement…' : 'Créer le repas'}</button>
      </div>
    </form>
    {!meal?.text && <>
      <div className="section-divider"><span>ou une idée de saison</span><Sparkles size={15} /></div>
      <div className="action-grid flush" aria-busy={Boolean(filling)}>
        {levelButtons(busy)}
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
        <span><strong>{details.name}</strong><small>{details.seasons.map(value => seasonLabels[value]).join(' · ')}{details.level ? ` · ${cookingLevelLabels[details.level]}` : ''}</small></span>
        <ArrowUpRight size={17} />
      </button>)}
      {suggestions.length === 0 && <EmptyState title={available.length ? 'Pas encore d’idée par ici' : 'Votre carnet commence ici'}>
        {available.length ? `Aucun repas ${allSeasons ? 'correspondant' : `pour cette saison (${seasonLabels[season].toLowerCase()})`}. Essayez un autre filtre ou créez le vôtre.`
          : 'Ajoutez votre premier repas ci-dessus. Il vous attendra ici la prochaine fois.'}
      </EmptyState>}
    </div>
    </>}
  </Modal>
  {managing && <Modal title="Modifier le repas" onClose={() => setManaging(false)} dismissible={!busy}>
    <p className="modal-subtitle">{displayName}</p>
    <div className="action-grid flush" aria-busy={busy}>
      <button className="secondary-button" disabled={busy} onClick={() => { setText(displayName); setManaging(false); setEditing(true); }}><Pencil size={17} />Changer le plat</button>
      <button className="secondary-button danger" disabled={busy} onClick={() => void commit('')}><Trash2 size={16} />Supprimer</button>
      {currentDish && <button className="secondary-button wide" disabled={busy} onClick={() => void toggleGenerationExclusion()}>
        {currentDish.excludedFromGeneration ? <RotateCcw size={16} /> : <Ban size={16} />}
        {currentDish.excludedFromGeneration ? 'Réautoriser les générations' : 'Exclure des générations'}
      </button>}
      {levelButtons(busy, true)}
    </div>
    {generationStatus && <p className="field-hint" role="status">{generationStatus}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </Modal>}
  {filling === 'ai' && <GenerationProgress />}</>;
}
