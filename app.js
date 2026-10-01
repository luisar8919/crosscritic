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

const els = {
  search: document.getElementById('game-search'),
  gameList: document.getElementById('game-list'),
  searchStatus: document.getElementById('search-status'),
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
  emptyHint: document.getElementById('empty-hint'),
  apiStatus: document.getElementById('api-status'),
};

const GAUGE_ARC_LENGTH = 314; // aprox. longitud del semicírculo (π * r=100)

let profileId = null;
let sources = [];               // catálogo semilla: [{source_id, source_name}]
let selectedSources = new Map(); // prensas elegidas por el usuario: source_id -> source_name
let allGames = [];              // índice completo: [{game_id, game_title, sources}]
let currentGame = null;         // último juego cargado desde la API

init();

async function init() {
  profileId = getOrCreateProfileId();

  await loadSources();
  const isNewProfile = await loadProfile();
  await loadGameIndex();

  if (isNewProfile) {
    els.channelsSub.textContent =
      '¡Bienvenido! Elige qué prensas quieres usar para calcular la nota — se guarda en tu perfil.';
  }

  renderChannels();
  refreshSearchAvailability();
  els.search.addEventListener('change', onGameChosen);
  els.search.addEventListener('input', onSearchInput);
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

async function loadLocalGame(gameId) {
  els.searchStatus.textContent = 'Cargando…';
  try {
    const res = await fetch(`${API_BASE}/games/${gameId}`);
    if (!res.ok) throw new Error('no encontrado');
    currentGame = await res.json();
    currentGame.isMetacritic = false;
    showGame();
  } catch {
    els.searchStatus.textContent = 'No se pudo cargar ese juego.';
  }
}

async function loadMetacriticGame(title, slug) {
  els.searchStatus.textContent = `Buscando "${title}" en Metacritic (prueba)...`;
  try {
    const param = slug ? `slug=${encodeURIComponent(slug)}` : `title=${encodeURIComponent(title)}`;
    const res = await fetch(`${API_BASE}/metacritic?${param}`);
    if (!res.ok) throw new Error('no encontrado');
    const data = await res.json();
    currentGame = { game_title: slug ? title : data.game_title, reviews: data.reviews, isMetacritic: true };
    showGame();
  } catch {
    els.searchStatus.textContent = `No se encontró "${title}" ni en tu cosecha ni en Metacritic.`;
  }
}

function showGame() {
  els.searchStatus.textContent = currentGame.isMetacritic
    ? 'Resultado de Metacritic (prueba) — click en una prensa para sumarla a tu selección.'
    : '';
  els.intro.hidden = true;
  els.console.hidden = false;
  els.gameTitle.textContent = currentGame.game_title;
  renderReadout();
}

function renderReadout() {
  if (!currentGame) return;

  const reviews = currentGame.reviews || [];
  els.chips.innerHTML = '';

  let sum = 0;
  let count = 0;

  reviews.forEach((review) => {
    const isActive = selectedSources.has(review.source_id);

    if (isActive) {
      sum += review.normalized_score;
      count++;
    }

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (isActive ? '' : ' is-muted');
    chip.title = isActive ? 'Click para sacarla de tus prensas' : 'Click para sumarla a tus prensas';
    chip.innerHTML = `
      <span class="chip-source">${review.source_name}</span>
      <span class="chip-score">${review.normalized_score.toFixed(0)}</span>
    `;
    chip.addEventListener('click', () => toggleSource(review.source_id, review.source_name));
    els.chips.appendChild(chip);
  });

  const hasScore = count > 0;
  const finalScore = hasScore ? sum / count : null;

  els.emptyHint.style.display = hasScore ? 'none' : 'block';
  els.gaugeValue.textContent = hasScore ? finalScore.toFixed(1) : '—';
  updateGauge(hasScore ? finalScore : 0);
}

function updateGauge(score) {
  const clamped = Math.max(0, Math.min(100, score));
  const offset = GAUGE_ARC_LENGTH * (1 - clamped / 100);
  els.gaugeFill.style.strokeDashoffset = String(offset);

  const rotation = (clamped / 100) * 180 - 90;
  els.gaugeNeedle.style.transform = `rotate(${rotation}deg)`;

  let color = 'var(--cobalt)';
  if (clamped >= 80) color = 'var(--crimson)';
  else if (clamped >= 40) color = 'var(--amber)';
  els.gaugeFill.style.stroke = color;
  els.gaugeValue.style.color = color;
}

function setApiStatus(message) {
  els.apiStatus.textContent = message;
}
