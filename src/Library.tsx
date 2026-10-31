import { useEffect, useState } from 'react';
import { Archive, ArrowUpRight, Check, Leaf, RotateCcw, Search, Sparkles } from 'lucide-react';
import { dishDetails, recipeUrl, seasonLabels, seasons, type Analysis, type Dish, type Season } from '../shared/model';
import { EmptyState, Modal } from './components';
import { errorMessage, save } from './store';
import { newId } from './id';

export function Library({ dishes, analyses, online, onSaved }: {
  dishes: Dish[]; analyses: Analysis[]; online: boolean; onSaved: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Season | 'any'>('any');
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));
  const entries = dishes.map(dish => ({ dish, details: dishDetails(dish, analysisMap.get(dish.id)) }))
    .filter(({ dish, details }) => dish.archived === archived &&
      details.name.toLocaleLowerCase('fr').includes(query.toLocaleLowerCase('fr')) &&
      (filter === 'any' || details.seasons.includes(filter) || details.seasons.includes('all')))
    .sort((a, b) => a.details.name.localeCompare(b.details.name, 'fr'));
  const selectedDish = dishes.find(dish => dish.id === selected);
  return <section className="library">
    <div className="section-heading"><div><p className="eyebrow">LES IDÉES QUI RESTENT</p><h2>Mon carnet de recettes</h2></div><Leaf size={24} strokeWidth={1.3} /></div>
    <p className="section-description">Vos repas préférés et vos inspirations, à retrouver au bon moment.</p>
    <label className="search-field"><Search size={18} /><input type="search" aria-label="Rechercher dans le carnet" placeholder="Une recette, une envie…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="season-filters" aria-label="Filtrer le carnet par saison">
      <button aria-pressed={filter === 'any'} onClick={() => setFilter('any')}>Tout le carnet</button>
      {seasons.filter(season => season !== 'all').map(season => <button key={season} aria-pressed={filter === season} onClick={() => setFilter(season)}>{seasonLabels[season]}</button>)}
    </div>
    <label className="checkbox-field"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />Voir les repas archivés</label>
    <div className="recipe-grid">
      {entries.map(({ dish, details }) => {
        const analysis = analysisMap.get(dish.id);
        const status = dish.details ? 'À votre façon' : analysis?.status === 'ready' ? 'Recette enrichie'
          : analysis?.status === 'error' ? 'Analyse à relancer' : 'Analyse en attente';
        return <button className="recipe-card" key={dish.id} onClick={() => setSelected(dish.id)}>
          <div className="recipe-card-top"><span className="recipe-leaf"><Leaf size={24} strokeWidth={1.2} /></span><ArrowUpRight size={17} /></div>
          <h3>{details.name}</h3>
          <p>{details.seasons.map(season => seasonLabels[season]).join(' · ')}</p>
          <small className={analysis?.status === 'error' && !dish.details ? 'danger' : ''}><Sparkles size={12} />{status}</small>
        </button>;
      })}
    </div>
    {entries.length === 0 && <EmptyState title={dishes.length ? 'Aucun repas dans cette sélection' : 'Les petits plats font les grands carnets'}>
      {dishes.length ? 'Essayez un autre filtre ou une autre recherche.' : 'Commencez par remplir une case du planning. Vos idées seront conservées ici, sans rien avoir à faire de plus.'}
    </EmptyState>}
    {selectedDish && <DishEditor key={selectedDish.id} dish={selectedDish} analysis={analysisMap.get(selectedDish.id)} online={online}
      onClose={() => setSelected(null)} onSaved={onSaved} />}
  </section>;
}

function DishEditor({ dish, analysis, online, onClose, onSaved }: {
  dish: Dish; analysis?: Analysis; online: boolean; onClose: () => void; onSaved: () => void;
}) {
  const initial = dishDetails(dish, analysis);
  const [name, setName] = useState(initial.name);
  const [selectedSeasons, setSelectedSeasons] = useState(initial.seasons);
  const [ingredients, setIngredients] = useState(initial.ingredients.join('\n'));
  const [recipe, setRecipe] = useState(initial.recipe);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    const updated = dishDetails(dish, analysis);
    setName(updated.name);
    setSelectedSeasons(updated.seasons);
    setIngredients(updated.ingredients.join('\n'));
    setRecipe(updated.recipe);
  }, [dish, analysis, dirty]);

  async function persist(action: 'edit' | 'archive' | 'analyze') {
    setBusy(true);
    setError(null);
    try {
      await save([action === 'archive' ? { ...dish, archived: !dish.archived }
        : action === 'analyze' ? { ...dish, name: name.trim(), details: null, analysisKey: newId(),
          ...((dish.sourceUrl ?? recipeUrl(dish.name)) ? { sourceUrl: dish.sourceUrl ?? recipeUrl(dish.name) } : {}) }
          : { ...dish, name: name.trim(), details: {
            name: name.trim(), seasons: selectedSeasons,
            ingredients: ingredients.split('\n').map(item => item.trim()).filter(Boolean), recipe,
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
    {dish.sourceUrl && <p className="field-hint"><a href={dish.sourceUrl} target="_blank" rel="noopener noreferrer">Voir la recette d’origine</a></p>}
    {!dish.details && analysis?.error && <p className="inline-error" role="alert">{analysis.error}</p>}
    <form onChange={() => setDirty(true)} onSubmit={event => { event.preventDefault(); void persist('edit'); }}>
      <label className="field-label" htmlFor="dish-name">Nom du repas</label>
      <input id="dish-name" value={name} onChange={event => setName(event.target.value)} maxLength={recipeUrl(name) ? 2048 : 240} required />
      <fieldset><legend className="field-label">Les bonnes saisons</legend><div className="season-filters">
        {seasons.map(season => <button type="button" key={season} aria-pressed={selectedSeasons.includes(season)} onClick={() => toggleSeason(season)}>{seasonLabels[season]}</button>)}
      </div></fieldset>
      <label className="field-label" htmlFor="ingredients">Ingrédients et quantités <small>(un par ligne, 30 maximum)</small></label>
      <textarea id="ingredients" value={ingredients} onChange={event => setIngredients(event.target.value)} maxLength={3600} rows={4} />
      <label className="field-label" htmlFor="recipe">Une petite recette</label>
      <textarea id="recipe" value={recipe} onChange={event => setRecipe(event.target.value)} maxLength={4000} rows={5} />
      <p className="field-hint">Les ingrédients, quantités et recette proposés par l’IA sont indicatifs. Vérifiez la composition réelle et la cuisson ; ils ne garantissent pas l’absence d’allergènes.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="editor-actions"><button className="primary-button" disabled={busy || !name.trim() || !selectedSeasons.length}><Check size={17} />Enregistrer la fiche</button></div>
    </form>
    <div className="dish-secondary-actions">
      <button className="text-button" disabled={busy} onClick={() => void persist('archive')}>
        {dish.archived ? <RotateCcw size={16} /> : <Archive size={16} />}{dish.archived ? 'Restaurer ce repas' : 'Archiver ce repas'}
      </button>
      <button className="text-button" disabled={busy || !online || !name.trim() || dish.archived}
        title="Remplace les informations de cette fiche par une nouvelle analyse ; les menus ne changent pas."
        onClick={() => void persist('analyze')}><Sparkles size={16} />Relancer l’IA</button>
    </div>
    <p className="field-hint">Relancer l’IA remplace les informations de la fiche. L’archivage conserve les anciens menus.</p>
  </Modal>;
}
