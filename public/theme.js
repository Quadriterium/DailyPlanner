// Applique le thème avant le premier affichage pour éviter un flash clair.
// Même calcul que resolveTheme() dans src/theme.ts : garder les deux synchronisés.
(() => {
  const valid = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  let theme = 'light';
  try {
    const preference = JSON.parse(localStorage.getItem('a-table-theme') ?? 'null') ?? {};
    if (preference.mode === 'dark') theme = 'dark';
    else if (preference.mode === 'system') {
      theme = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } else if (preference.mode === 'schedule') {
      const now = new Date();
      const current = now.getHours() * 60 + now.getMinutes();
      const dark = minutes(valid(preference.darkFrom) ? preference.darkFrom : '20:00');
      const light = minutes(valid(preference.lightFrom) ? preference.lightFrom : '07:00');
      const inDark = dark < light ? current >= dark && current < light : current >= dark || current < light;
      theme = dark !== light && inDark ? 'dark' : 'light';
    }
  } catch { /* Stockage illisible : thème clair. */ }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1c1814' : '#f8f5ee');
})();
