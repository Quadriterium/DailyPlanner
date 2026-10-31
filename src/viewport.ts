const minimumFieldFontSize = 16;

/**
 * En mode « version pour ordinateur », Chrome Android ignore la balise viewport :
 * la page est mise en page sur ~980 px puis réduite, et le navigateur zoome dès
 * qu'un champ reçoit le focus car son texte paraît trop petit. On compense en
 * agrandissant la police des champs selon ce facteur de réduction.
 */
export function fieldFontSize(screenWidth: number, layoutWidth: number, coarsePointer: boolean) {
  if (!coarsePointer || !screenWidth || !layoutWidth || screenWidth >= layoutWidth) return minimumFieldFontSize;
  return Math.ceil(minimumFieldFontSize * layoutWidth / screenWidth);
}

export function adaptFieldFontSize() {
  const coarse = matchMedia('(any-pointer: coarse)');
  const update = () => {
    const size = fieldFontSize(screen.width, document.documentElement.clientWidth, coarse.matches);
    document.documentElement.style.setProperty('--field-font-size', `${size}px`);
  };
  update();
  addEventListener('resize', update);
  addEventListener('orientationchange', update);
}
