// Si el frontend NO se despliega junto a la Function App como Azure Static
// Web Apps "managed functions", cambia esto por la URL completa de tu
// Function App, ej: "https://consola-api.azurewebsites.net/api"
const API_BASE = '/api';

const STORAGE_KEY = 'consola_weights_v1';

const els = {
  search: document.getElementById('game-search'),
  gameList: document.getElementById('game-list'),
  searchStatus: document.getElementById('search-status'),
  console: document.getElementById('console'),
  intro: document.getElementById('intro'),
  channels: document.getElementById('channels'),
  gameTitle: document.getElementById('game-title'),
  gaugeFill: document.getElementById('gauge-fill'),
  gaugeNeedle: document.getElementById('gauge-needle'),
  gaugeValue: document.getElementById('gauge-value'),
  chips: document.getElementById('chips'),
  emptyHint: document.getElementById('empty-hint'),
  apiStatus: document.getElementById('api-status'),
};

const GAUGE_ARC_LENGTH = 314; // aprox. longitud del semicírculo (π * r=100)

let sources = [];       // catálogo: [{source_id, source_name}]
let weights = {};        // preferencias del usuario: {source_id: number 0-2}
let currentGame = null;  // último juego cargado desde la API

init();

async function init() {
  loadWeights();
  await Promise.all([loadSources(), loadGameIndex()]);
  els.search.addEventListener('change', onGameChosen);
}

function loadWeights() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    weights = raw ? JSON.parse(raw) : {};
  } catch {
    weights = {};
  }
}

function saveWeights() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(weights));
}

async function loadSources() {
  try {
    const res = await fetch(`${API_BASE}/sources`);
    const data = await res.json();
    sources = data.sources || [];
    renderChannels();
  } catch (err) {
    setApiStatus('No se pudo cargar el catálogo de prensas. ¿La API está desplegada?');
  }
}

async function loadGameIndex() {
  try {
    const res = await fetch(`${API_BASE}/games`);
    const data = await res.json();
    els.gameList.innerHTML = '';
    (data.games || [])
      .sort((a, b) => a.game_title.localeCompare(b.game_title))
      .forEach((g) => {
        const opt = document.createElement('option');
        opt.value = g.game_title;
        opt.dataset.id = g.game_id;
        els.gameList.appendChild(opt);
      });
    if (!data.games || data.games.length === 0) {
      els.searchStatus.textContent = 'Todavía no hay reseñas cosechadas. Espera a que corra la ingesta o ejecútala manualmente.';
    }
  } catch {
    setApiStatus('No se pudo cargar la lista de juegos.');
  }
}

function renderChannels() {
  els.channels.innerHTML = '';
  sources.forEach((source) => {
    const weight = weights[source.source_id] ?? 1.0;

    const channel = document.createElement('div');
    channel.className = 'channel';
    channel.dataset.sourceId = source.source_id;

    const weightLabel = document.createElement('div');
    weightLabel.className = 'channel-weight';
    weightLabel.textContent = weight.toFixed(1);

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.className = 'channel-fader';
    fader.min = '0';
    fader.max = '2';
    fader.step = '0.1';
    fader.value = String(weight);
    fader.setAttribute('aria-label', `Peso de ${source.source_name}`);

    fader.addEventListener('input', () => {
      const value = parseFloat(fader.value);
      weights[source.source_id] = value;
      weightLabel.textContent = value.toFixed(1);
      channel.classList.toggle('is-muted', value === 0);
      saveWeights();
      renderReadout();
    });

    const label = document.createElement('div');
    label.className = 'channel-label';
    label.textContent = source.source_name;

    channel.classList.toggle('is-muted', weight === 0);
    channel.append(weightLabel, fader, label);
    els.channels.appendChild(channel);
  });
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

  let weightedSum = 0;
  let weightTotal = 0;

  reviews.forEach((review) => {
    const weight = weights[review.source_id] ?? 1.0;
    const isMuted = weight === 0;

    if (!isMuted) {
      weightedSum += review.normalized_score * weight;
      weightTotal += weight;
    }

    const chip = document.createElement('div');
    chip.className = 'chip' + (isMuted ? ' is-muted' : '');
    chip.innerHTML = `
      <span class="chip-source">${review.source_name}</span>
      <span class="chip-score">${review.normalized_score.toFixed(0)}</span>
    `;
    els.chips.appendChild(chip);
  });

  const hasScore = weightTotal > 0;
  const finalScore = hasScore ? weightedSum / weightTotal : null;

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
