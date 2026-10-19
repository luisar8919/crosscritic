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

// Tu id de afiliado de Instant Gaming Partners (parámetro "igr") — anotate
// en https://www.instant-gaming.com/en/partners/ y pegalo acá. Sin esto el
// botón COMPRAR igual funciona, solo que sin comisión para vos.
const INSTANT_GAMING_AFFILIATE_TAG = '';

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
  gameCover: document.getElementById('game-cover'),
  gaugeFill: document.getElementById('gauge-fill'),
  gaugeNeedle: document.getElementById('gauge-needle'),
  gaugeValue: document.getElementById('gauge-value'),
  chips: document.getElementById('chips'),
  selectAllBtn: document.getElementById('select-all-btn'),
  loadMoreBtn: document.getElementById('load-more-btn'),
  outlierToggleBtn: document.getElementById('outlier-toggle-btn'),
  shareBtn: document.getElementById('share-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  buyLink: document.getElementById('buy-link'),
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
      "Welcome! Choose which outlets you want to use to calculate the score — it's saved to your profile.";
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
  els.copyLinkBtn.addEventListener('click', copyShareLink);
}

/** Arma el mismo link que lee applySharedLinkIfPresent (?local=/mc=&title=&
 * src=) y lo copia al portapapeles — para compartir la valoración exacta
 * (juego + tu selección de prensas) con alguien, no solo una imagen.
 *
 * `src` solo lleva los ids de las prensas ACTIVAS en este juego (no todo tu
 * perfil acumulado): eso es lo que realmente determina la nota que estás
 * viendo, y mantiene el link corto — perfiles viejos con decenas de prensas
 * sumadas de otros juegos tiraban un link tan largo que el navegador lo
 * rechazaba (Request Too Long). */
function copyShareLink() {
  if (!currentGame) return;
  const activeIds = (currentGame.reviews || [])
    .map((r) => r.source_id)
    .filter((id) => selectedSources.has(id));

  const params = new URLSearchParams();
  if (currentGame.isMetacritic) params.set('mc', currentGame.metacriticSlug);
  else params.set('local', currentGame.gameId);
  params.set('title', currentGame.game_title);
  params.set('src', activeIds.join(','));

  const url = `${location.origin}${location.pathname}?${params.toString()}`;
  navigator.clipboard
    .writeText(url)
    .then(() => {
      els.searchStatus.textContent = 'Link copied — opening it shows the same game with your exact outlet selection.';
    })
    .catch(() => {
      els.searchStatus.textContent = url;
    });
}

/** Link compartible: ?local=<id>|mc=<slug>&title=<titulo>&src=<ids separados
 * por coma>. Si trae `src`, pisa el perfil guardado (y lo persiste) para que
 * quien abre el link vea la misma selección de prensas que lo generó. Los
 * nombres reales de esos ids se completan al cargar el juego (ver
 * reconcileSourceNames) — el link solo necesita el id para que el cálculo
 * de la nota ya dé igual. */
async function applySharedLinkIfPresent() {
  const params = new URLSearchParams(location.search);
  const srcParam = params.get('src');
  if (srcParam) {
    const ids = srcParam.split(',').filter(Boolean);
    selectedSources = new Map(ids.map((id) => [id, id]));
    saveProfile();
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
    setApiStatus("Couldn't load the outlet catalog. Is the API deployed?");
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
    setApiStatus("Couldn't load your preferences profile.");
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
    setApiStatus("Couldn't save your outlet selection.");
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
    setApiStatus("Couldn't load the game list.");
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
  els.pressSummaryCount.textContent = `${selectedSources.size} selected`;
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
    els.searchStatus.textContent = "No outlets selected: you'll only be able to search live against Metacritic.";
  } else {
    els.searchStatus.textContent = visibleGames.length
      ? ''
      : 'None of the harvested games have been reviewed yet by the outlets you picked — try searching anyway, it falls back to live Metacritic.';
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

      // Si un título de Metacritic es idéntico a uno que ya está en tu
      // cosecha local, no lo agregamos: dos <option> con el mismo texto
      // visible eran ambiguos (el buscador siempre resolvía al primero que
      // encontraba en el DOM, o sea siempre el local, sin que el usuario
      // pudiera elegir el de Metacritic a propósito).
      const localTitles = new Set(
        Array.from(els.gameList.options)
          .filter((o) => !o.dataset.metacriticSlug)
          .map((o) => o.value)
      );
      (data.suggestions || [])
        .filter((s) => !localTitles.has(s.title))
        .forEach((s) => {
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
    coverImage: data.cover_image || null,
  };
}

async function loadLocalGame(gameId) {
  els.searchStatus.textContent = 'Loading…';
  const game = await fetchLocalGame(gameId);
  if (!game) {
    els.searchStatus.textContent = "Couldn't load that game.";
    return;
  }
  currentGame = game;
  pushRecent({ title: game.game_title, kind: 'local', id: gameId });
  showGame();
}

async function loadMetacriticGame(title, slug) {
  els.searchStatus.textContent = `Searching for "${title}" on Metacritic (beta)...`;
  const game = await fetchMetacriticGame(title, slug);
  if (!game) {
    els.searchStatus.textContent = `Couldn't find "${title}" in your harvest or on Metacritic.`;
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
  els.compareResult.textContent = 'Loading…';

  const game = option?.dataset.id
    ? await fetchLocalGame(option.dataset.id)
    : await fetchMetacriticGame(typed, option?.dataset.metacriticSlug);

  if (!game) {
    els.compareResult.textContent = `Couldn't find "${typed}".`;
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

/** Genera una tarjeta PNG (canvas nativo) con el juego y la nota para
 * compartir en redes — ahí es donde se ve la promoción, un link pelado no
 * dice nada por sí mismo. En mobile usa el share sheet nativo con el
 * archivo adjunto; si el navegador no soporta compartir archivos, lo
 * descarga para subirlo a mano. */
async function shareLink() {
  if (!currentGame) return;
  const score = parseFloat(els.gaugeValue.textContent);
  const hasScore = !Number.isNaN(score);
  const activeCount = (currentGame.reviews || []).filter((r) => selectedSources.has(r.source_id)).length;

  const canvas = buildShareCard({
    title: currentGame.game_title,
    score: hasScore ? score : null,
    pressCount: activeCount,
  });

  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const fileName = `crosscritic-${currentGame.gameId || currentGame.metacriticSlug || 'nota'}.png`;
    const file = new File([blob], fileName, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: currentGame.game_title,
          text: `${currentGame.game_title} on CrossCritic: ${hasScore ? score.toFixed(1) : '—'}`,
        });
        return;
      } catch {
        // el usuario canceló el share sheet, o no hay apps destino: cae a descarga
      }
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    els.searchStatus.textContent = 'Image downloaded — post it on your socials.';
  }, 'image/png');
}

function buildShareCard({ title, score, pressCount }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext('2d');

  let color = '#ff3b5c';
  if (score != null) {
    if (score >= 80) color = '#39ff9d';
    else if (score >= 40) color = '#ffcc33';
  }

  ctx.fillStyle = '#0a0e16';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8f4ff';
  ctx.font = '800 42px "IBM Plex Mono", monospace';
  ctx.fillText('CROSSCRITIC', canvas.width / 2, 110);

  ctx.font = '400 22px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#6f8299';
  ctx.fillText('your press, your weights', canvas.width / 2, 148);

  ctx.font = '700 46px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#e8f4ff';
  wrapCenteredText(ctx, title, canvas.width / 2, 280, 1000, 56);

  ctx.font = '900 170px "IBM Plex Mono", monospace';
  ctx.fillStyle = color;
  ctx.fillText(score != null ? score.toFixed(1) : '—', canvas.width / 2, 490);

  ctx.font = '400 24px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#6f8299';
  const caption = pressCount > 0
    ? `weighted from ${pressCount} trusted outlet${pressCount === 1 ? '' : 's'}`
    : 'average score';
  ctx.fillText(caption, canvas.width / 2, 545);

  return canvas;
}

function wrapCenteredText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  });
  lines.push(line);

  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, startY + i * lineHeight));
}

/** Trae la siguiente tanda de reseñas de Metacritic (hay hasta 150+ por
 * juego, solo mostramos ~20 al principio) y las suma sin pisar las ya
 * mostradas. */
async function loadMoreMetacriticReviews() {
  if (!currentGame?.isMetacritic) return;
  els.loadMoreBtn.disabled = true;
  els.loadMoreBtn.textContent = 'LOADING...';
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
  els.loadMoreBtn.textContent = hasMore ? 'SHOW MORE OUTLETS' : 'ALL OUTLETS SHOWN';
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
  els.selectAllBtn.textContent = allSelected ? '- REMOVE ALL' : '+ ADD ALL';
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
    ? 'Metacritic result (beta) — click an outlet to add it to your selection.'
    : '';
  els.intro.hidden = true;
  els.console.hidden = false;
  els.gameTitle.textContent = currentGame.game_title;
  if (currentGame.coverImage) {
    els.gameCover.src = currentGame.coverImage;
    els.gameCover.alt = currentGame.game_title;
    els.gameCover.hidden = false;
  } else {
    els.gameCover.hidden = true;
  }
  compareGame = null;
  els.compareSearch.value = '';
  if (reconcileSourceNames(currentGame.reviews)) renderChannels();
  updateBuyLink();
  renderReadout();
}

/** Link de afiliado a Instant Gaming para el juego que se está viendo —
 * monetización simple sin backend propio: la URL de búsqueda ya alcanza,
 * no hace falta resolver el producto exacto. */
function updateBuyLink() {
  if (!currentGame) {
    els.buyLink.hidden = true;
    return;
  }
  const query = encodeURIComponent(currentGame.game_title);
  const ref = INSTANT_GAMING_AFFILIATE_TAG ? `&igr=${encodeURIComponent(INSTANT_GAMING_AFFILIATE_TAG)}` : '';
  els.buyLink.href = `https://www.instant-gaming.com/en/search/?q=${query}${ref}`;
  els.buyLink.hidden = false;
}

/** Un link compartido solo trae ids de prensa (ver applySharedLinkIfPresent);
 * en cuanto el juego carga, sus reseñas traen el nombre real de cada fuente
 * y lo completamos acá en vez de mostrar el id pelado en el dropdown. */
function reconcileSourceNames(reviews) {
  let changed = false;
  (reviews || []).forEach((r) => {
    if (selectedSources.get(r.source_id) === r.source_id && r.source_name !== r.source_id) {
      selectedSources.set(r.source_id, r.source_name);
      changed = true;
    }
  });
  return changed;
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
      ? 'Excluded from the average as an outlier (click to remove it entirely)'
      : isActive
      ? 'Click to remove it from your outlets'
      : 'Click to add it to your outlets';
    chip.innerHTML = `
      <span class="chip-source">${review.source_name}</span>
      <span class="chip-score">${review.normalized_score.toFixed(0)}</span>
      ${isOutlier ? '<span class="chip-flag">OUTLIER</span>' : ''}
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
