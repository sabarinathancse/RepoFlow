/* Boot: build navigation, wire search and theme, render the current hash. */
initTheme();
buildNav();
initSearch();
window.addEventListener('hashchange', render);
render();
