import { createRoot } from 'react-dom/client';
import { lazy, Suspense } from 'react';
import './styles.css';
import { adaptFieldFontSize } from './viewport';

adaptFieldFontSize();

const admin = /^\/admin(?:\/|$)/.test(window.location.pathname);
if (admin) document.documentElement.classList.add('admin-page');
const Page = admin
  ? lazy(() => import('./Admin').then(module => ({ default: module.Admin })))
  : lazy(() => import('./App').then(module => ({ default: module.App })));

createRoot(document.getElementById('root')!).render(<Suspense fallback={<p role="status">Chargement…</p>}><Page /></Suspense>);
