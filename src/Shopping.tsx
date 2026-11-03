import { useEffect, useRef, useState } from 'react';
import { Copy, ShoppingBasket, Sparkles, Undo2 } from 'lucide-react';
import {
  dishDetails, formatDate, householdCount, mealDisplayName, mealHousehold, mealSchema,
  type Analysis, type Dish, type Household, type Meal,
} from '../shared/model';
import {
  generateShoppingList, nextShoppingWeek, refinedShoppingListText, shoppingListText, shoppingMeals, type ShoppingList,
} from '../shared/shopping';
import { EmptyState, Modal } from './components';
import { errorMessage, refineShopping, signInHint, useServerFeatures } from './store';

export function Shopping({ today, meals, dishes, analyses, household, online, onSignInRequired }: {
  today: string; meals: Meal[]; dishes: Dish[]; analyses: Analysis[]; household?: Household;
  online: boolean; onSignInRequired: () => void;
}) {
  const serverFeatures = useServerFeatures();
  const [period, setPeriod] = useState(() => nextShoppingWeek(today));
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [generated, setGenerated] = useState<{ list: ShoppingList; text: string; refined?: string } | null>(null);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState('');
  const refineRun = useRef(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copying, setCopying] = useState(false);
  const generateButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!generated && wasOpen.current) generateButton.current?.focus({ preventScroll: true });
    wasOpen.current = Boolean(generated);
  }, [generated]);
  const validDate = (date: string) => mealSchema.shape.date.safeParse(date).success;
  const validPeriod = validDate(period.start) && validDate(period.end) && period.start <= period.end;
  const entries = validPeriod ? shoppingMeals(meals, period.start, period.end) : [];
  const selected = entries.filter(meal => !excluded.has(meal.id));
  const dishMap = new Map(dishes.map(dish => [dish.id, dish]));
  const analysisMap = new Map(analyses.map(analysis => [analysis.dishId, analysis]));

  function changePeriod(start: string, end: string) {
    setPeriod({ start, end });
    setExcluded(new Set());
  }
  function generate() {
    const list = generateShoppingList(selected, dishes, analyses, household);
    setGenerated({ list, text: shoppingListText(list, period.start, period.end) });
    setCopied(false);
    setCopyError('');
    setRefineError('');
  }
  function close() {
    refineRun.current++;
    setRefining(false);
    setGenerated(null);
  }
  async function refine() {
    if (!generated) return;
    if (!serverFeatures) { onSignInRequired(); return; }
    const run = ++refineRun.current;
    setRefining(true);
    setRefineError('');
    try {
      const refined = await refineShopping(generated.list.lines);
      if (run !== refineRun.current) return;
      setGenerated({ ...generated, refined: refinedShoppingListText(refined, generated.list.warnings, period.start, period.end) });
      setCopied(false);
    } catch (error) {
      if (run === refineRun.current) setRefineError(errorMessage(error));
    } finally {
      if (run === refineRun.current) setRefining(false);
    }
  }
  async function copy(text: string) {
    setCopying(true);
    setCopyError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('La copie automatique est indisponible sur cette connexion. Sélectionnez et copiez le texte ci-dessous.');
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (error) {
      setCopied(false);
      setCopyError(`Copie impossible : ${errorMessage(error)} Vous pouvez sélectionner le texte ci-dessous.`);
    } finally { setCopying(false); }
  }

  return <section className="shopping">
    <div className="section-heading"><div><p className="eyebrow">POUR NE RIEN OUBLIER</p><h2>Liste de courses</h2></div><ShoppingBasket size={24} strokeWidth={1.3} /></div>
    <p className="section-description">Choisissez une période et les repas à inclure. Les quantités tiennent compte des convives de chaque plat.</p>
    <div className="shopping-period">
      <label className="field-label">Du<input type="date" value={period.start} onChange={event => changePeriod(event.target.value, period.end)} /></label>
      <label className="field-label">Au<input type="date" value={period.end} onChange={event => changePeriod(period.start, event.target.value)} /></label>
      <button className="secondary-button" onClick={() => { const week = nextShoppingWeek(today); changePeriod(week.start, week.end); }}>Semaine prochaine</button>
    </div>
    {!validPeriod && <p className="inline-error" role="alert">Choisissez deux dates valides ; la fin doit être égale ou postérieure au début.</p>}
    {entries.length > 0 && <>
      <div className="shopping-selection">
        <p role="status">{selected.length} plat{selected.length > 1 ? 's' : ''} sélectionné{selected.length > 1 ? 's' : ''} sur {entries.length}</p>
        <button className="text-button" onClick={() => setExcluded(selected.length === entries.length ? new Set(entries.map(meal => meal.id)) : new Set())}>
          {selected.length === entries.length ? 'Tout décocher' : 'Tout cocher'}
        </button>
      </div>
      <ul className="shopping-meals">
        {entries.map(meal => {
          const dish = meal.dishId ? dishMap.get(meal.dishId) : undefined;
          const analysis = dish ? analysisMap.get(dish.id) : undefined;
          const details = dish ? dishDetails(dish, analysis) : undefined;
          const count = householdCount(mealHousehold(meal, household));
          return <li key={meal.id}><label>
            <input type="checkbox" checked={!excluded.has(meal.id)} onChange={event => {
              const next = new Set(excluded);
              if (event.target.checked) next.delete(meal.id); else next.add(meal.id);
              setExcluded(next);
            }} />
            <span><small>{formatDate(meal.date, { weekday: 'long', day: 'numeric', month: 'long' })} · {meal.slot === 'lunch' ? 'Midi' : 'Soir'}</small>
              <strong>{mealDisplayName(meal, dish, analysis)}</strong>
              <small>{count} personne{count > 1 ? 's' : ''}{!details || !(details.items?.length || details.ingredients.length) ? ' · Ingrédients indisponibles' : ''}</small>
            </span>
          </label></li>;
        })}
      </ul>
    </>}
    {validPeriod && !entries.length && <EmptyState title="Aucun repas prévu">Ajoutez des repas dans le planning ou choisissez une autre période.</EmptyState>}
    <button ref={generateButton} className="primary-button shopping-generate" disabled={!validPeriod || !selected.length} onClick={generate}><ShoppingBasket size={18} />Générer la liste</button>
    {generated && <Modal title="Votre liste de courses" onClose={close}>
      {!generated.list.lines.length && <p className="notice-text">Aucun ingrédient disponible pour les repas sélectionnés. Complétez les fiches du carnet avant de régénérer la liste.</p>}
      <label className="field-label" htmlFor="shopping-list-text">{generated.refined ? 'Liste affinée par l’IA, à copier' : 'Liste à copier'}</label>
      <textarea id="shopping-list-text" className="shopping-output" readOnly value={generated.refined ?? generated.text} rows={14} />
      {generated.refined && <p className="field-hint">Rayons et quantités arrondies proposés par l’IA : vérifiez avant vos achats.</p>}
      {generated.list.warnings.length > 0 && <p className="field-hint">Cette liste est à vérifier : les précisions sur les recettes incomplètes figurent dans le texte ci-dessus et seront aussi copiées.</p>}
      <div className="shopping-actions">
        <button className="primary-button" disabled={copying || refining} onClick={() => void copy(generated.refined ?? generated.text)}><Copy size={17} />Copier la liste</button>
        {generated.refined
          ? <button className="secondary-button" onClick={() => { setGenerated({ ...generated, refined: undefined }); setCopied(false); }}><Undo2 size={17} />Revenir à la liste exacte</button>
          : generated.list.lines.length > 0 && <button className="secondary-button" disabled={refining || (serverFeatures && !online)}
            title={serverFeatures ? (online ? 'Regroupe par rayon et arrondit les quantités ; seuls les ingrédients et quantités sont envoyés à l’IA.' : 'Nécessite une connexion au serveur et l’IA configurée.') : signInHint}
            onClick={() => void refine()}><Sparkles size={17} />{refining ? 'Affinage en cours…' : 'Affiner avec l’IA'}</button>}
      </div>
      {refineError && <p className="inline-error" role="alert">{refineError}</p>}
      {copied && <p className="field-hint" role="status">Liste copiée.</p>}
      {copyError && <p className="inline-error" role="alert">{copyError}</p>}
    </Modal>}
  </section>;
}
