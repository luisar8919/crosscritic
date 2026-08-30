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
let sources = [];              // catálogo completo: [{source_id, source_name}]
let selectedSources = new Set(); // prensas elegidas por el usuario (su perfil)
let allGames = [];             // índice completo: [{game_id, game_title, sources}]
let currentGame = null;        // último juego cargado desde la API

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
      selectedSources = new Set(data.selected_sources || []);
      return false;
    }
    selectedSources = new Set();
    return true;
  } catch {
    selectedSources = new Set();
    setApiStatus('No se pudo cargar tu perfil de preferencias.');
    return false;
  }
}

async function saveProfile() {
  try {
    await fetch(`${API_BASE}/profile/${profileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_sources: Array.from(selectedSources) }),
    });
  } catch {
    setApiStatus('No se pudo guardar tu selección de prensas.');
  }
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

function renderChannels() {
  els.channels.innerHTML = '';
  sources.forEach((source) => {
    const isSelected = selectedSources.has(source.source_id);

    const item = document.createElement('label');
    item.className = 'press-item' + (isSelected ? ' is-selected' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isSelected;
    checkbox.setAttribute('aria-label', source.source_name);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedSources.add(source.source_id);
      } else {
        selectedSources.delete(source.source_id);
      }
      item.classList.toggle('is-selected', checkbox.checked);
      saveProfile();
      refreshSearchAvailability();
      renderReadout();
    });

    const name = document.createElement('span');
    name.className = 'press-name';
    name.textContent = source.source_name;

    item.append(checkbox, name);
    els.channels.appendChild(item);
  });
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
    els.search.disabled = true;
    els.searchStatus.textContent = 'Selecciona al menos una prensa arriba para poder buscar.';
  } else {
    els.search.disabled = false;
    els.searchStatus.textContent = visibleGames.length
      ? ''
      : 'Ninguno de los juegos cosechados fue reseñado todavía por las prensas que elegiste.';
  }
}

async function onGameChosen() {
  const typed = els.search.value.trim();
  const option = Array.from(els.gameList.options).find((o) => o.value === typed);
  if (!option) return;

  const gameId = option.dataset.id;
  els.searchStatus.textContent = 'Cargando…';

  try {
    const res = await fetch(`${API_BASE}/games/${gameId}`);
    if (!res.ok) throw new Error('no encontrado');
    currentGame = await res.json();
    els.searchStatus.textContent = '';
    els.intro.hidden = true;
    els.console.hidden = false;
    els.gameTitle.textContent = currentGame.game_title;
    renderReadout();
  } catch {
    els.searchStatus.textContent = 'No se pudo cargar ese juego.';
  }
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

    const chip = document.createElement('div');
    chip.className = 'chip' + (isActive ? '' : ' is-muted');
    chip.innerHTML = `
      <span class="chip-source">${review.source_name}</span>
      <span class="chip-score">${review.normalized_score.toFixed(0)}</span>
    `;
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
