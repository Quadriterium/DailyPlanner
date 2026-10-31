import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { adaptFieldFontSize } from './viewport';

adaptFieldFontSize();

createRoot(document.getElementById('root')!).render(<App />);
