import { useEffect, useState } from 'react';
import { Archive, ArrowUpRight, Ban, Check, Leaf, LoaderCircle, Plus, RotateCcw, Search, Sparkles } from 'lucide-react';
import {
  cookingLevelHints, cookingLevelLabels, cookingLevels, dishDetails, parisDate, recipeUrl, seasonForDate, seasonLabels, seasons, sourceRecipeSchema,
  type Analysis, type CookingLevel, type Dish, type Season,
} from '../shared/model';
import { EmptyState, Modal } from './components';
import { LevelGauge, LevelTag } from './CookingLevel';
import { errorMessage, save, setDishGenerationExcluded, signInHint, useServerFeatures } from './store';
import { newId } from './id';
import { recipeServings } from '../shared/recipe';

export function Library({ dishes, analyses, online, aiConfigured, onSaved, onSignInRequired }: {
  dishes: Dish[]; analyses: Analysis[]; online: boolean; aiConfigured: boolean; onSaved: () => void;
  onSignInRequired: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Season | 'any'>('any');
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const entries = dishes.map(dish => ({ dish, details: dishDetails(dish, analysisMap.get(dish.id)) }))
    .filter(({ dish, details }) => dish.archived === archived &&
      details.name.toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr')) &&
      (filter === 'any' || details.seasons.includes(filter) || details.seasons.includes('all')))
    .sort((a, b) => a.details.name.localeCompare(b.details.name, 'fr'));
  const selectedDish = dishes.find(dish => dish.id === selected);
  return <section className="library">
    <div className="section-heading"><div><p className="eyebrow">LES IDÉES QUI RESTENT</p><h2>Mon carnet de recettes</h2></div><Leaf size={24} strokeWidth={1.3} /></div>
  
    <button className="primary-button" onClick={() => setCreating(true)}><Plus size={17} />Ajouter une recette</button>
    <label className="search-field"><Search size={18} /><input type="search" aria-label="Rechercher dans le carnet" placeholder="Une recette, une envie…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="season-filters" aria-label="Filtrer le carnet par saison">
      <button aria-pressed={filter === 'any'} onClick={() => setFilter('any')}>Tout le carnet</button>
      {seasons.filter(season => season !== 'all').map(season => <button key={season} aria-pressed={filter === season} onClick={() => setFilter(season)}>{seasonLabels[season]}</button>)}
    </div>
    <label className="checkbox-field"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />Voir les repas archivés</label>
    <div className="recipe-grid">
      {entries.map(({ dish, details }) => {
        const analysis = analysisMap.get(dish.id);
        const currentAnalysis = analysis?.analysisKey === dish.analysisKey ? analysis : undefined;
        const status = dish.sourceRecipe ? recipeSharingStatus(currentAnalysis)
          : dish.details ? 'À votre façon' : analysis?.status === 'ready' ? 'Recette enrichie'
          : analysis?.status === 'error' ? 'Analyse à relancer' : analysis?.error ? 'Quota atteint · en attente'
            : analysis?.status === 'processing' ? 'Génération en cours…' : 'Analyse en attente';
        return <button className="recipe-card" key={dish.id} onClick={() => setSelected(dish.id)}>
          <div className="recipe-card-top"><span className="recipe-leaf"><Leaf size={24} strokeWidth={1.2} /></span><ArrowUpRight size={17} /></div>
          <h3>{details.name}</h3>
          <p>{details.seasons.map(season => seasonLabels[season]).join(' · ')}</p>
          {details.level && <LevelTag level={details.level} />}
          {dish.excludedFromGeneration && <span className="generation-excluded-label">Exclu des générations</span>}
          <small className={analysis?.status === 'error' && !dish.details ? 'danger' : ''}><Sparkles size={12} />{status}</small>
        </button>;
      })}
    </div>
    {entries.length === 0 && <EmptyState title={dishes.length ? 'Aucun repas dans cette sélection' : 'Les petits plats font les grands carnets'}>
      {dishes.length ? 'Essayez un autre filtre ou une autre recherche.' : 'Ajoutez votre première recette ou remplissez une case du planning. Vos idées seront conservées ici.'}
    </EmptyState>}
    {creating && <RecipeCreator online={online} aiConfigured={aiConfigured} onClose={() => setCreating(false)} onSaved={onSaved} />}
    {selectedDish && <DishEditor key={selectedDish.id} dish={selectedDish} analysis={analysisMap.get(selectedDish.id)} online={online && aiConfigured}
      onClose={() => setSelected(null)} onSaved={onSaved} onSignInRequired={onSignInRequired} />}
  </section>;
}

function recipeSharingStatus(analysis?: Analysis): string {
  if (analysis?.status === 'error') return 'Validation à relancer · recette privée';
  if (analysis?.sharing === 'rejected') return 'Non partagée · recette privée';
  if (analysis?.sharing === 'approved') return 'Recette validée pour le partage';
  return analysis?.status === 'processing' ? 'Validation IA en cours…' : 'Validation IA en attente';
}

function recipeSource(ingredients: string, recipe: string, servings: string) {
  const parsed = sourceRecipeSchema.safeParse({
    ingredients: ingredients.split('\n').map(line => line.trim()).filter(Boolean), recipe, servings: Number(servings),
  });
  if (!parsed.success) throw new Error('Renseignez les étapes, de 0,5 à 60 portions et de 1 à 100 ingrédients (120 caractères maximum par ligne).');
  return parsed.data;
}

function RecipeCreator({ online, aiConfigured, onClose, onSaved }: { online: boolean; aiConfigured: boolean; onClose: () => void; onSaved: () => void }) {
  const serverFeatures = useServerFeatures();
  const [name, setName] = useState('');
  const [ingredients, setIngredients] = useState('');
  const [recipe, setRecipe] = useState('');
  const [servings, setServings] = useState('4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await save([{
        type: 'dish', id: newId(), name: name.trim(), creationSeason: seasonForDate(parisDate()),
        analysisKey: newId(), details: null, archived: false, sourceRecipe: recipeSource(ingredients, recipe, servings),
      }]);
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return <Modal title="Ajouter une recette" onClose={onClose} wide dismissible={!busy}>
    <p className="modal-subtitle">Votre titre et vos étapes restent inchangés. L’IA standardise les ingrédients pour adapter les quantités aux convives.</p>
    <p className="field-hint">La recette rejoint immédiatement votre carnet. Après validation par l’IA, elle pourra être trouvée par recherche ou choisie au hasard par les autres foyers, sans être ajoutée automatiquement à leur carnet. Ne saisissez pas de données personnelles.</p>
    {(!serverFeatures || !online || !aiConfigured) && <p className="field-hint">{!serverFeatures
      ? 'En mode invité, la recette reste sur cet appareil. Connectez-vous pour la faire valider et la partager.'
      : !online ? 'Hors ligne, la recette sera envoyée pour validation après reconnexion.'
        : 'L’IA n’est pas configurée sur le serveur. Votre recette restera privée en attente de validation.'}</p>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="field-label" htmlFor="new-recipe-name">Titre de votre recette</label>
      <input id="new-recipe-name" value={name} onChange={event => setName(event.target.value)} maxLength={240} required />
      <label className="field-label" htmlFor="new-recipe-servings">Nombre de portions de votre recette</label>
      <input id="new-recipe-servings" type="number" min="0.5" max="60" step="0.5" value={servings} onChange={event => setServings(event.target.value)} required />
      <label className="field-label" htmlFor="new-recipe-ingredients">Ingrédients et quantités <small>(un par ligne)</small></label>
      <textarea id="new-recipe-ingredients" value={ingredients} onChange={event => setIngredients(event.target.value)} rows={5} required />
      <label className="field-label" htmlFor="new-recipe-steps">Étapes de votre recette</label>
      <textarea id="new-recipe-steps" value={recipe} onChange={event => setRecipe(event.target.value)} maxLength={4000} rows={6} required />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="editor-actions"><button className="primary-button" disabled={busy || !name.trim() || !ingredients.trim() || !recipe.trim()}>
        <Check size={17} />Ajouter au carnet</button></div>
    </form>
  </Modal>;
}

function DishEditor({ dish, analysis, online, onClose, onSaved, onSignInRequired }: {
  dish: Dish; analysis?: Analysis; online: boolean; onClose: () => void; onSaved: () => void;
  onSignInRequired: () => void;
}) {
  const initial = dishDetails(dish, analysis);
  const serverFeatures = useServerFeatures();
  const [name, setName] = useState(initial.name);
  const [selectedSeasons, setSelectedSeasons] = useState(initial.seasons);
  const [ingredients, setIngredients] = useState((dish.sourceRecipe?.ingredients ?? initial.ingredients).join('\n'));
  const [recipe, setRecipe] = useState(initial.recipe);
  const [level, setLevel] = useState<CookingLevel | undefined>(initial.level);
  const [vegetarian, setVegetarian] = useState<boolean | undefined>(initial.vegetarian);
  const [servings, setServings] = useState(String(recipeServings(initial) ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    const updated = dishDetails(dish, analysis);
    setName(updated.name);
    setSelectedSeasons(updated.seasons);
    setIngredients((dish.sourceRecipe?.ingredients ?? updated.ingredients).join('\n'));
    setRecipe(updated.recipe);
    setLevel(updated.level);
    setVegetarian(updated.vegetarian);
    setServings(String(recipeServings(updated) ?? ''));
  }, [dish, analysis, dirty]);

  async function persist(action: 'edit' | 'archive' | 'analyze' | 'exclude') {
    if (action === 'analyze' && !serverFeatures) { onSignInRequired(); return; }
    setBusy(true);
    setError(null);
    try {
      if (action === 'exclude') await setDishGenerationExcluded(dish.id, !dish.excludedFromGeneration);
      else await save([action === 'archive' ? { ...dish, archived: !dish.archived }
        : dish.sourceRecipe ? { ...dish, name: name.trim(), details: null, analysisKey: newId(),
          sourceRecipe: recipeSource(ingredients, recipe, servings) }
          : action === 'analyze' ? { ...dish, name: name.trim(), details: null, analysisKey: newId(),
          ...((dish.sourceUrl ?? recipeUrl(dish.name)) ? { sourceUrl: dish.sourceUrl ?? recipeUrl(dish.name) } : {}) }
          : { ...dish, name: name.trim(), details: {
            name: name.trim(), seasons: selectedSeasons,
            ingredients: ingredients.split('\n').map(item => item.trim()).filter(Boolean), recipe,
            ...(level ? { level } : {}),
            ...(vegetarian !== undefined ? { vegetarian } : {}),
            ...(servings.trim() ? { servings: Number(servings) } : {}),
            // Structured quantities stay valid only while ingredients and their base are unchanged.
            ...(initial.items && ingredients === initial.ingredients.join('\n') && servings === String(recipeServings(initial) ?? '')
              ? { items: initial.items } : {}),
            ...(initial.tags ? { tags: initial.tags } : {}),
            ...(initial.preserveRecipe ? { preserveRecipe: true } : {}),
          } }]);
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  function toggleSeason(season: Season) {
    setDirty(true);
    setSelectedSeasons(current => current.includes(season) ? current.filter(value => value !== season)
      : season === 'all' ? ['all'] : [...current.filter(value => value !== 'all'), season]);
  }
  return <Modal title="Une page du carnet" onClose={onClose} wide>
    <p className="modal-subtitle">Modifier cette fiche ne change pas les textes déjà inscrits au planning.</p>
    {dish.sourceRecipe && <p className="field-hint" role="status">{recipeSharingStatus(analysis?.analysisKey === dish.analysisKey ? analysis : undefined)}.
      {' '}Votre titre et vos étapes sont conservés. Une modification relance la validation ; les copies déjà partagées restent inchangées.
      {analysis?.sharing === 'rejected' && ' L’IA n’a pas validé cette recette pour le catalogue commun. Vous pouvez la corriger puis réessayer.'}</p>}
    {dish.sourceUrl && <p className="field-hint"><a href={dish.sourceUrl} target="_blank" rel="noopener noreferrer">Voir la recette d’origine</a></p>}
    {!dish.details && analysis?.error && <p className="inline-error" role="alert">{analysis.error}</p>}
    {!dish.sourceRecipe && !dish.details && !analysis?.error && (!analysis || analysis.analysisKey !== dish.analysisKey ||
      analysis.status === 'pending' || analysis.status === 'processing') && <p className="analysis-progress" role="status">
      {online && serverFeatures && <LoaderCircle size={18} className="spinning" aria-hidden="true" />}
      {!serverFeatures ? 'Recette en attente. Connectez-vous pour utiliser l’IA.'
        : !online ? 'Recette en attente de connexion ou de configuration IA.'
          : analysis?.status === 'processing' ? 'Génération de la recette en cours… Elle s’affichera automatiquement ici.'
            : 'Recette en attente de génération… Elle s’affichera automatiquement ici après synchronisation.'}
    </p>}
    <form onChange={() => setDirty(true)} onSubmit={event => { event.preventDefault(); void persist('edit'); }}>
      <label className="field-label" htmlFor="dish-name">Nom du repas</label>
      <input id="dish-name" value={name} onChange={event => setName(event.target.value)} maxLength={!dish.sourceRecipe && recipeUrl(name) ? 2048 : 240} required />
      {!dish.sourceRecipe && <><fieldset><legend className="field-label">Les bonnes saisons</legend><div className="season-filters">
        {seasons.map(season => <button type="button" key={season} aria-pressed={selectedSeasons.includes(season)} onClick={() => toggleSeason(season)}>{seasonLabels[season]}</button>)}
      </div></fieldset>
      <fieldset><legend className="field-label">Niveau de cuisine</legend><div className="season-filters level-filters">
        {cookingLevels.map(value => <button type="button" key={value} aria-pressed={level === value} title={cookingLevelHints[value]}
          onClick={() => { setDirty(true); setLevel(current => current === value ? undefined : value); }}>
          <LevelGauge level={value} />{cookingLevelLabels[value]}</button>)}
      </div>
      {!level && <p className="field-hint">Sans niveau, ce repas n’est pas proposé par le choix au hasard. Choisissez-en un, ou relancez l’IA pour l’évaluer.</p>}
      </fieldset>
      <label className="checkbox-field"><input type="checkbox" checked={vegetarian === true}
        onChange={event => { setDirty(true); setVegetarian(event.target.checked); }} />Recette végétarienne</label>
      <p className="field-hint">Sans viande, poisson, fruits de mer ni bouillon de viande. Œufs et produits laitiers possibles.
        {vegetarian === undefined && ' Cette fiche n’est pas encore classée : vérifiez la recette et cochez-la si elle convient, ou relancez l’IA.'}</p></>}
      <label className="field-label" htmlFor="recipe-servings">Nombre de portions de la recette d’origine</label>
      <input id="recipe-servings" type="number" min="0.5" max="60" step="0.5" value={servings}
        required={Boolean(dish.sourceRecipe)}
        onChange={event => setServings(event.target.value)} />
      <label className="field-label" htmlFor="ingredients">Ingrédients et quantités <small>(un par ligne)</small></label>
      <textarea id="ingredients" value={ingredients} onChange={event => setIngredients(event.target.value)} rows={4} required={Boolean(dish.sourceRecipe)} />
      <label className="field-label" htmlFor="recipe">Une petite recette</label>
      <textarea id="recipe" value={recipe} onChange={event => setRecipe(event.target.value)} maxLength={4000} rows={5} required={Boolean(dish.sourceRecipe)} />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="editor-actions"><button className="primary-button" disabled={busy || !name.trim() || !selectedSeasons.length}><Check size={17} />Enregistrer la fiche</button></div>
    </form>
    <div className="dish-secondary-actions">
      <button className="text-button" disabled={busy} onClick={() => void persist('exclude')}>
        {dish.excludedFromGeneration ? <RotateCcw size={16} /> : <Ban size={16} />}
        {dish.excludedFromGeneration ? 'Réautoriser les générations' : 'Exclure des générations'}
      </button>
      <button className="text-button" disabled={busy} onClick={() => void persist('archive')}>
        {dish.archived ? <RotateCcw size={16} /> : <Archive size={16} />}{dish.archived ? 'Restaurer ce repas' : 'Archiver ce repas'}
      </button>
      <button className="text-button" disabled={busy || (serverFeatures && !online) || !name.trim() || dish.archived}
        title={serverFeatures ? dish.sourceRecipe ? 'Valide la recette et standardise les ingrédients sans réécrire votre titre ni vos étapes.'
          : 'Remplace les informations de cette fiche par une nouvelle analyse ; les menus ne changent pas.' : signInHint}
        onClick={() => void persist('analyze')}><Sparkles size={16} />Relancer l’IA</button>
    </div>
  </Modal>;
}
