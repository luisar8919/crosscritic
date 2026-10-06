// La Function App está publicada como recurso aparte (no como "managed
// functions" del Static Web App), así que apuntamos directo a su URL.
// Requiere CORS habilitado ahí para el dominio del Static Web App
// (ver README, sección 4).
const API_BASE = 'https://crosscritic-fabhbkf7due8hqbc.eastus-01.azurewebsites.net/api';

// Perfil anónimo por dispositivo: un id generado una vez y guardado en este
// navegador. Las preferencias (qué prensas usar) se guardan del lado del
// servidor (Blob Storage) contra ese id, así que sobreviven a que se borre
// el localStorage de la nota final, pero no cruzan de un navegador a otro.
const PROFILE_ID_KEY = 'crosscritic_profile_id';
const RECENT_KEY = 'crosscritic_recent_searches';
const MAX_RECENT = 8;

const els = {
  search: document.getElementById('game-search'),
  gameList: document.getElementById('game-list'),
  searchStatus: document.getElementById('search-status'),
  recentSearches: document.getElementById('recent-searches'),
  console: document.getElementById('console'),
  intro: document.getElementById('intro'),
  channels: document.getElementById('channels'),
  channelsSub: document.getElementById('channels-sub'),
  pressSummaryCount: document.getElementById('press-summary-count'),
  gameTitle: document.getElementById('game-title'),
  gaugeFill: document.getElementById('gauge-fill'),
  gaugeNeedle: document.getElementById('gauge-needle'),
  gaugeValue: document.getElementById('gauge-value'),
  chips: document.getElementById('chips'),
  selectAllBtn: document.getElementById('select-all-btn'),
  loadMoreBtn: document.getElementById('load-more-btn'),
  outlierToggleBtn: document.getElementById('outlier-toggle-btn'),
  shareBtn: document.getElementById('share-btn'),
  compareSearch: document.getElementById('compare-search'),
  compareClearBtn: document.getElementById('compare-clear-btn'),
  compareResult: document.getElementById('compare-result'),
  emptyHint: document.getElementById('empty-hint'),
  apiStatus: document.getElementById('api-status'),
};

const GAUGE_ARC_LENGTH = 314; // aprox. longitud del semicírculo (π * r=100)
const OUTLIER_Z = 1.5; // qué tan lejos de la media (en desvíos estándar) cuenta como outlier

let profileId = null;
let sources = [];               // catálogo semilla: [{source_id, source_name}]
let selectedSources = new Map(); // prensas elegidas por el usuario: source_id -> source_name
let allGames = [];              // índice completo: [{game_id, game_title, sources}]
let currentGame = null;         // último juego cargado desde la API
let compareGame = null;         // segundo juego cargado para comparar contra currentGame
let recentSearches = [];        // historial local: [{title, kind:'local'|'mc', id}]
let filterOutliersEnabled = false;

init();

async function init() {
  profileId = getOrCreateProfileId();
  loadRecent();

  await loadSources();
  const isNewProfile = await loadProfile();
  await loadGameIndex();
  await applySharedLinkIfPresent();

  if (isNewProfile) {
    els.channelsSub.textContent =
      '¡Bienvenido! Elige qué prensas quieres usar para calcular la nota — se guarda en tu perfil.';
  }

  renderChannels();
  renderRecent();
  refreshSearchAvailability();
  els.search.addEventListener('change', onGameChosen);
  els.search.addEventListener('input', onSearchInput);
  els.compareSearch.addEventListener('change', onCompareChosen);
  els.compareClearBtn.addEventListener('click', clearCompare);
  els.selectAllBtn.addEventListener('click', toggleAllCurrentReviews);
  els.loadMoreBtn.addEventListener('click', loadMoreMetacriticReviews);
  els.outlierToggleBtn.addEventListener('click', toggleOutlierFilter);
  els.shareBtn.addEventListener('click', shareLink);
}

/** Link compartible: ?local=<id>|mc=<slug>&title=<titulo>&src=<prensas en
 * base64>. Si trae `src`, pisa el perfil guardado (y lo persiste) para que
 * quien abre el link vea la misma selección de prensas que lo generó. */
async function applySharedLinkIfPresent() {
  const params = new URLSearchParams(location.search);
  const srcParam = params.get('src');
  if (srcParam) {
    try {
      selectedSources = new Map(JSON.parse(decodeURIComponent(atob(srcParam))));
      saveProfile();
    } catch {
      /* link corrupto: seguimos con el perfil guardado */
    }
  }

  const title = params.get('title') || '';
  const local = params.get('local');
  const mc = params.get('mc');
  if (local) {
    els.search.value = title;
    await loadLocalGame(local);
  } else if (mc) {
    els.search.value = title;
    await loadMetacriticGame(title, mc);
  }
}

function getOrCreateProfileId() {
  let id = localStorage.getItem(PROFILE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PROFILE_ID_KEY, id);
  }
  return id;
}

async function loadSources() {
  try {
    const res = await fetch(`${API_BASE}/sources`);
    const data = await res.json();
    sources = data.sources || [];
  } catch {
    setApiStatus('No se pudo cargar el catálogo de prensas. ¿La API está desplegada?');
  }
}

/** Devuelve true si el perfil no existía todavía (usuario nuevo). */
async function loadProfile() {
  try {
    const res = await fetch(`${API_BASE}/profile/${profileId}`);
    if (res.ok) {
      const data = await res.json();
      selectedSources = new Map((data.selected_sources || []).map((s) => [s.source_id, s.source_name]));
      return false;
    }
    // Perfil nuevo: arrancamos con todas las prensas del catálogo semilla
    // activas, para que la búsqueda sirva de entrada sin un paso extra.
    selectedSources = new Map(sources.map((s) => [s.source_id, s.source_name]));
    return true;
  } catch {
    selectedSources = new Map();
    setApiStatus('No se pudo cargar tu perfil de preferencias.');
    return false;
  }
}

async function saveProfile() {
  try {
    const selected_sources = Array.from(selectedSources, ([source_id, source_name]) => ({
      source_id,
      source_name,
    }));
    await fetch(`${API_BASE}/profile/${profileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_sources }),
    });
  } catch {
    setApiStatus('No se pudo guardar tu selección de prensas.');
  }
}

/** Suma o saca `id` de tus prensas seleccionadas — usado tanto por el
 * dropdown de arriba como por los chips de reseñas (local o Metacritic). */
function toggleSource(id, name) {
  if (selectedSources.has(id)) {
    selectedSources.delete(id);
  } else {
    selectedSources.set(id, name);
  }
  saveProfile();
  renderChannels();
  refreshSearchAvailability();
  renderReadout();
}

async function loadGameIndex() {
  try {
    const res = await fetch(`${API_BASE}/games`);
    const data = await res.json();
    allGames = data.games || [];
  } catch {
    allGames = [];
    setApiStatus('No se pudo cargar la lista de juegos.');
  }
}

/** El dropdown muestra tus prensas seleccionadas (no un catálogo fijo) —
 * se arma clickeando chips de reseñas en cualquier juego, local o de
 * Metacritic. Destildar acá las saca de la selección. */
function renderChannels() {
  els.channels.innerHTML = '';
  const entries = Array.from(selectedSources.entries()).sort((a, b) => a[1].localeCompare(b[1]));

  entries.forEach(([id, name]) => {
    const item = document.createElement('label');
    item.className = 'press-row is-selected';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.setAttribute('aria-label', name);
    checkbox.addEventListener('change', () => toggleSource(id, name));

    const nameEl = document.createElement('span');
    nameEl.className = 'press-name';
    nameEl.textContent = name;

    item.append(checkbox, nameEl);
    els.channels.appendChild(item);
  });

  updatePressSummaryCount();
}

function updatePressSummaryCount() {
  els.pressSummaryCount.textContent = `${selectedSources.size} seleccionadas`;
}

/** Filtra el buscador a solo los juegos reseñados por alguna prensa seleccionada. */
function refreshSearchAvailability() {
  const visibleGames = allGames.filter((g) =>
    (g.sources || []).some((s) => selectedSources.has(s))
  );

  els.gameList.innerHTML = '';
  visibleGames
    .sort((a, b) => a.game_title.localeCompare(b.game_title))
    .forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.game_title;
      opt.dataset.id = g.game_id;
      els.gameList.appendChild(opt);
    });

  if (selectedSources.size === 0) {
    els.searchStatus.textContent = 'Sin prensas seleccionadas: solo vas a poder buscar en vivo contra Metacritic.';
  } else {
    els.searchStatus.textContent = visibleGames.length
      ? ''
      : 'Ninguno de los juegos cosechados fue reseñado todavía por las prensas que elegiste — probá buscar igual, cae a Metacritic en vivo.';
  }
}

let suggestTimer = null;

/** Mientras escribís algo que no matchea tu cosecha local, sugiere títulos
 * reales de Metacritic (debounced) para no tener que escribir el nombre
 * exacto del juego. */
function onSearchInput() {
  const typed = els.search.value.trim();
  clearTimeout(suggestTimer);

  const localMatch = Array.from(els.gameList.options).some(
    (o) => !o.dataset.metacriticSlug && o.value === typed
  );
  if (!typed || typed.length < 3 || localMatch) return;

  suggestTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${API_BASE}/metacritic/suggest?q=${encodeURIComponent(typed)}`);
      const data = await res.json();
      // Saca sugerencias viejas sin tocar las opciones de tu cosecha local.
      Array.from(els.gameList.options)
        .filter((o) => o.dataset.metacriticSlug)
        .forEach((o) => o.remove());
      (data.suggestions || []).forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.title;
        opt.dataset.metacriticSlug = s.slug;
        els.gameList.appendChild(opt);
      });
    } catch {
      /* sin sugerencias, no pasa nada: igual se puede buscar a ciegas */
    }
  }, 300);
}

async function onGameChosen() {
  const typed = els.search.value.trim();
  if (!typed) return;
  const option = Array.from(els.gameList.options).find((o) => o.value === typed);

  if (option?.dataset.id) {
    await loadLocalGame(option.dataset.id);
  } else if (option?.dataset.metacriticSlug) {
    await loadMetacriticGame(typed, option.dataset.metacriticSlug);
  } else {
    // No está en tu cosecha RSS ni elegiste una sugerencia: prueba de
    // búsqueda en vivo contra Metacritic a ciegas, en vez de nada.
    await loadMetacriticGame(typed);
  }
}

async function fetchLocalGame(gameId) {
  const res = await fetch(`${API_BASE}/games/${gameId}`);
  if (!res.ok) return null;
  const data = await res.json();
  data.isMetacritic = false;
  data.gameId = gameId;
  return data;
}

async function fetchMetacriticGame(title, slug) {
  const param = slug ? `slug=${encodeURIComponent(slug)}` : `title=${encodeURIComponent(title)}`;
  const res = await fetch(`${API_BASE}/metacritic?${param}`);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    game_title: slug ? title : data.game_title,
    reviews: data.reviews,
    isMetacritic: true,
    metacriticSlug: data.metacritic_slug,
    nextOffset: data.next_offset,
    totalAvailable: data.total_available,
  };
}

async function loadLocalGame(gameId) {
  els.searchStatus.textContent = 'Cargando…';
  const game = await fetchLocalGame(gameId);
  if (!game) {
    els.searchStatus.textContent = 'No se pudo cargar ese juego.';
    return;
  }
  currentGame = game;
  pushRecent({ title: game.game_title, kind: 'local', id: gameId });
  showGame();
}

async function loadMetacriticGame(title, slug) {
  els.searchStatus.textContent = `Buscando "${title}" en Metacritic (prueba)...`;
  const game = await fetchMetacriticGame(title, slug);
  if (!game) {
    els.searchStatus.textContent = `No se encontró "${title}" ni en tu cosecha ni en Metacritic.`;
    return;
  }
  currentGame = game;
  pushRecent({ title: game.game_title, kind: 'mc', id: game.metacriticSlug });
  showGame();
}

/** Historial local de búsquedas (solo este navegador, no viaja con el
 * perfil del servidor): últimos juegos vistos, para volver a abrirlos sin
 * re-escribir el nombre. */
function loadRecent() {
  try {
    recentSearches = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch {
    recentSearches = [];
  }
}

function pushRecent(entry) {
  if (!entry.id) return;
  recentSearches = recentSearches.filter((r) => r.title !== entry.title);
  recentSearches.unshift(entry);
  recentSearches = recentSearches.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches));
  renderRecent();
}

function renderRecent() {
  els.recentSearches.innerHTML = '';
  els.recentSearches.hidden = recentSearches.length === 0;
  recentSearches.forEach((entry) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-chip';
    chip.textContent = entry.title;
    chip.addEventListener('click', () => {
      els.search.value = entry.title;
      if (entry.kind === 'local') loadLocalGame(entry.id);
      else loadMetacriticGame(entry.title, entry.id);
    });
    els.recentSearches.appendChild(chip);
  });
}

/** Compara currentGame contra un segundo juego, con la misma selección de
 * prensas y el mismo filtro de outliers — no duplica el panel completo,
 * solo la nota final y la diferencia. */
async function onCompareChosen() {
  const typed = els.compareSearch.value.trim();
  if (!typed) return;
  const option = Array.from(els.gameList.options).find((o) => o.value === typed);

  els.compareResult.hidden = false;
  els.compareResult.textContent = 'Cargando…';

  const game = option?.dataset.id
    ? await fetchLocalGame(option.dataset.id)
    : await fetchMetacriticGame(typed, option?.dataset.metacriticSlug);

  if (!game) {
    els.compareResult.textContent = `No se encontró "${typed}".`;
    return;
  }
  compareGame = game;
  renderCompare();
}

function clearCompare() {
  compareGame = null;
  els.compareSearch.value = '';
  renderCompare();
}

function renderCompare() {
  if (!compareGame || !currentGame) {
    els.compareResult.hidden = true;
    els.compareClearBtn.hidden = true;
    return;
  }

  const mainScore = scoreFor(currentGame.reviews || []);
  const otherScore = scoreFor(compareGame.reviews || []);
  const diff = mainScore != null && otherScore != null ? otherScore - mainScore : null;
  const diffText = diff == null ? '' : `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} vs ${currentGame.game_title}`;

  els.compareResult.hidden = false;
  els.compareClearBtn.hidden = false;
  els.compareResult.innerHTML = `
    <span class="compare-title">${compareGame.game_title}</span>
    <span class="compare-score">${otherScore != null ? otherScore.toFixed(1) : '—'}</span>
    ${diff != null ? `<span class="compare-diff">${diffText}</span>` : ''}
  `;
}

/** Nota final de un set de reseñas con tu selección y filtro de outliers
 * actuales — misma regla que renderReadout, pero sin armar los chips. */
function scoreFor(reviews) {
  const active = reviews.filter((r) => selectedSources.has(r.source_id));
  const outliers = computeOutliers(active);
  const counted = active.filter((r) => !outliers.has(r.source_id));
  return counted.length ? counted.reduce((a, r) => a + r.normalized_score, 0) / counted.length : null;
}

function shareLink() {
  if (!currentGame) return;
  const params = new URLSearchParams();
  if (currentGame.isMetacritic) params.set('mc', currentGame.metacriticSlug);
  else params.set('local', currentGame.gameId);
  params.set('title', currentGame.game_title);
  params.set('src', btoa(encodeURIComponent(JSON.stringify(Array.from(selectedSources)))));

  const url = `${location.origin}${location.pathname}?${params.toString()}`;
  navigator.clipboard
    .writeText(url)
    .then(() => {
      els.searchStatus.textContent = 'Link copiado al portapapeles.';
    })
    .catch(() => {
      els.searchStatus.textContent = url;
    });
}

/** Trae la siguiente tanda de reseñas de Metacritic (hay hasta 150+ por
 * juego, solo mostramos ~20 al principio) y las suma sin pisar las ya
 * mostradas. */
async function loadMoreMetacriticReviews() {
  if (!currentGame?.isMetacritic) return;
  els.loadMoreBtn.disabled = true;
  els.loadMoreBtn.textContent = 'CARGANDO...';
  try {
    const res = await fetch(
      `${API_BASE}/metacritic?slug=${encodeURIComponent(currentGame.metacriticSlug)}&offset=${currentGame.nextOffset}`
    );
    const data = await res.json();
    currentGame.reviews = currentGame.reviews.concat(data.reviews || []);
    currentGame.nextOffset = data.next_offset;
    currentGame.totalAvailable = data.total_available;
    renderReadout();
  } catch {
    updateLoadMoreButton();
  }
}

/** Botón "ver más": oculto para juegos locales (no hay paginación), y
 * desactivado (no escondido) una vez que ya se vieron todas las prensas
 * disponibles de Metacritic. */
function updateLoadMoreButton() {
  const hasMore = Boolean(
    currentGame?.isMetacritic && currentGame.nextOffset < (currentGame.totalAvailable || 0)
  );
  els.loadMoreBtn.hidden = !currentGame?.isMetacritic;
  els.loadMoreBtn.disabled = !hasMore;
  els.loadMoreBtn.textContent = hasMore ? 'VER MÁS PRENSAS' : 'YA VISTE TODAS LAS PRENSAS';
}

/** Un solo botón que suma todas las prensas del juego que estás viendo a tu
 * selección, o las saca todas si ya estaban todas sumadas. */
function toggleAllCurrentReviews() {
  if (!currentGame) return;
  const reviews = currentGame.reviews || [];
  const allSelected = reviews.length > 0 && reviews.every((r) => selectedSources.has(r.source_id));

  reviews.forEach((r) => {
    if (allSelected) selectedSources.delete(r.source_id);
    else selectedSources.set(r.source_id, r.source_name);
  });

  saveProfile();
  renderChannels();
  refreshSearchAvailability();
  renderReadout();
}

function updateSelectAllButton() {
  const reviews = currentGame?.reviews || [];
  els.selectAllBtn.hidden = reviews.length === 0;
  const allSelected = reviews.length > 0 && reviews.every((r) => selectedSources.has(r.source_id));
  els.selectAllBtn.textContent = allSelected ? '- QUITAR TODAS' : '+ SUMAR TODAS';
}

function toggleOutlierFilter() {
  filterOutliersEnabled = !filterOutliersEnabled;
  els.outlierToggleBtn.setAttribute('aria-pressed', String(filterOutliersEnabled));
  renderReadout();
}

/** Devuelve el set de source_id activos cuya nota se aleja demasiado del
 * resto (más de OUTLIER_Z desvíos estándar de la media) — se excluyen del
 * promedio pero se siguen mostrando, marcadas aparte. Con pocas reseñas
 * (menos de 4) no filtra: la muestra es demasiado chica para que la
 * desviación estándar signifique algo. */
function computeOutliers(activeReviews) {
  if (!filterOutliersEnabled || activeReviews.length < 4) return new Set();

  const scores = activeReviews.map((r) => r.normalized_score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return new Set();

  const outliers = new Set();
  activeReviews.forEach((r) => {
    if (Math.abs(r.normalized_score - mean) > OUTLIER_Z * stddev) outliers.add(r.source_id);
  });
  return outliers;
}

function showGame() {
  els.searchStatus.textContent = currentGame.isMetacritic
    ? 'Resultado de Metacritic (prueba) — click en una prensa para sumarla a tu selección.'
    : '';
  els.intro.hidden = true;
  els.console.hidden = false;
  els.gameTitle.textContent = currentGame.game_title;
  compareGame = null;
  els.compareSearch.value = '';
  renderReadout();
}

function renderReadout() {
  if (!currentGame) return;

  const reviews = currentGame.reviews || [];
  els.chips.innerHTML = '';

  const activeReviews = reviews.filter((r) => selectedSources.has(r.source_id));
  const outlierIds = computeOutliers(activeReviews);

  let sum = 0;
  let count = 0;

  reviews.forEach((review) => {
    const isActive = selectedSources.has(review.source_id);
    const isOutlier = isActive && outlierIds.has(review.source_id);

    if (isActive && !isOutlier) {
      sum += review.normalized_score;
      count++;
    }

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (isActive ? '' : ' is-muted') + (isOutlier ? ' is-outlier' : '');
    chip.title = isOutlier
      ? 'Excluida del promedio por ser un outlier (click para sacarla del todo)'
      : isActive
      ? 'Click para sacarla de tus prensas'
      : 'Click para sumarla a tus prensas';
    chip.innerHTML = `
      <span class="chip-source">${review.source_name}</span>
      <span class="chip-score">${review.normalized_score.toFixed(0)}</span>
      ${isOutlier ? '<span class="chip-flag">ATIPICA</span>' : ''}
    `;
    chip.addEventListener('click', () => toggleSource(review.source_id, review.source_name));
    els.chips.appendChild(chip);
  });

  const hasScore = count > 0;
  const finalScore = hasScore ? sum / count : null;

  els.emptyHint.style.display = hasScore ? 'none' : 'block';
  els.gaugeValue.textContent = hasScore ? finalScore.toFixed(1) : '—';
  updateGauge(hasScore ? finalScore : 0);

  updateLoadMoreButton();
  updateSelectAllButton();
  renderCompare();
}

function updateGauge(score) {
  const clamped = Math.max(0, Math.min(100, score));
  const offset = GAUGE_ARC_LENGTH * (1 - clamped / 100);
  els.gaugeFill.style.strokeDashoffset = String(offset);

  const rotation = (clamped / 100) * 180 - 90;
  els.gaugeNeedle.style.transform = `rotate(${rotation}deg)`;

  let color = 'var(--crimson)';
  if (clamped >= 80) color = 'var(--good)';
  else if (clamped >= 40) color = 'var(--amber)';
  els.gaugeFill.style.stroke = color;
  els.gaugeValue.style.color = color;
}

function setApiStatus(message) {
  els.apiStatus.textContent = message;
}
