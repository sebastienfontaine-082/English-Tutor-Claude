/* ---------- Config / storage ---------- */

const store = {
  get key(){ return localStorage.getItem('groq_api_key') || ''; },
  set key(v){ localStorage.setItem('groq_api_key', v); },
  get topic(){ return localStorage.getItem('topic') || ''; },
  set topic(v){ localStorage.setItem('topic', v); },
  get voiceURI(){ return localStorage.getItem('voiceURI') || ''; },
  set voiceURI(v){ localStorage.setItem('voiceURI', v); },
  get rate(){ return parseFloat(localStorage.getItem('rate') || '1'); },
  set rate(v){ localStorage.setItem('rate', v); },
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';   // fast, reliable, generous free quota
const SEARCH_MODEL = 'groq/compound';               // has web search, but a much smaller free daily quota

// Only route to the (rate-limited) search model when the message clearly
// calls for current/real-world information — keeps everyday chat fast and
// within the generous default quota.
const NEWS_PATTERN = /\b(news|headline|current event|what'?s happening|happening (today|now)|latest|this morning|this week|yesterday|today'?s date|who won|the score|weather (today|right now)|election|breaking|stock price|what year|current president|current prime minister)\b/i;

function pickModel(text){
  return NEWS_PATTERN.test(text) ? SEARCH_MODEL : DEFAULT_MODEL;
}

function systemPrompt(){
  const topic = store.topic.trim();
  return `You are a warm, casual native English speaker having a real spoken conversation with someone practicing English. ` +
    `Talk about everyday life, ask natural follow-up questions, react like a real person (curiosity, humor, small opinions). ` +
    `Keep replies SHORT — 1 to 3 sentences, like real speech, never a lecture. ` +
    `You have access to real-time web search — if the user asks about news, current events, ` +
    `today's date, sports results, or any fact you're unsure about, use it and answer naturally, ` +
    `still in a short spoken style, not like reading a list of headlines. ` +
    `If you're ever not sure whether your information is current, say so honestly instead of guessing. ` +
    `Do not mention that you are an AI. Do not use markdown, lists, or emojis — plain spoken sentences only. ` +
    `If the user makes a grammar or word-choice mistake, don't interrupt the flow to correct it every time — occasionally, naturally, ` +
    `weave the correct form back into your own reply the way a friend would, without explicitly pointing it out unless they ask for help. ` +
    (topic ? `The conversation should currently be about: ${topic}. ` : ``) +
    `Start the conversation yourself with a short, friendly opener.`;
}

let history = [];

function loadHistory(){
  try{ history = JSON.parse(sessionStorage.getItem('history') || '[]'); }catch(e){ history = []; }
}
function saveHistory(){
  sessionStorage.setItem('history', JSON.stringify(history));
}
loadHistory();

/* ---------- DOM ---------- */

const mainBtn = document.getElementById('mainBtn');
const btnLabel = document.getElementById('btnLabel');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const captionEl = document.getElementById('caption');

// Keeps the caption's visual height roughly constant (shows the tail of
// long text) so a growing transcript never pushes the orb around.
function setCaption(text){
  const MAX_CHARS = 170;
  captionEl.textContent = text.length > MAX_CHARS ? '… ' + text.slice(-MAX_CHARS) : text;
}
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const resetConvoBtn = document.getElementById('resetConvoBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
const topicInput = document.getElementById('topicInput');
const voiceSelect = document.getElementById('voiceSelect');
const rateInput = document.getElementById('rateInput');

/* ---------- Settings panel ---------- */

function openSettings(){
  apiKeyInput.value = store.key;
  topicInput.value = store.topic;
  rateInput.value = store.rate;
  populateVoices();
  settingsPanel.hidden = false;
}
function closeSettings(){
  store.key = apiKeyInput.value.trim();
  store.topic = topicInput.value.trim();
  store.rate = parseFloat(rateInput.value);
  const v = voiceSelect.value;
  if (v) store.voiceURI = v;
  settingsPanel.hidden = true;
}
settingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);
resetConvoBtn.addEventListener('click', () => {
  history = [];
  saveHistory();
  captionEl.textContent = '';
  statusEl.textContent = 'Conversation reset. Tap to start';
});

let cachedVoices = [];
function populateVoices(){
  cachedVoices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
  if (!cachedVoices.length) cachedVoices = speechSynthesis.getVoices();
  voiceSelect.innerHTML = '';
  cachedVoices.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === store.voiceURI) opt.selected = true;
    voiceSelect.appendChild(opt);
  });
}
speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();

/* First run: force settings open if no key saved */
if (!store.key){
  statusEl.textContent = 'Add your free Groq key first';
}

/* ---------- Orb visualizer ---------- */

const canvas = document.getElementById('orbCanvas');
const ctx = canvas.getContext('2d');
const BARS = 48;
let animFrame = null;
let vizState = 'idle'; // idle | listening | thinking | speaking
let phase = 0;

function resizeCanvas(){
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.getBoundingClientRect().width || 600;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resizeCanvas);

function drawOrb(){
  const size = canvas.getBoundingClientRect().width || 300;
  const cx = size/2, cy = size/2;
  const baseR = size*0.30;
  ctx.clearRect(0,0,size,size);

  let color = '#3a3f4a';
  if (vizState === 'listening') color = '#52c7c0';
  if (vizState === 'thinking') color = '#b7bccb';
  if (vizState === 'speaking') color = '#f2a35c';

  let levels = new Array(BARS).fill(0.08);

  if (vizState === 'listening'){
    // Synthetic "alive" pulse — intentionally NOT reading real mic amplitude
    // here anymore, since holding our own mic stream open at the same time
    // as SpeechRecognition was starving it of audio on some Android devices.
    phase += 0.11;
    for (let i=0;i<BARS;i++){
      levels[i] = 0.15 + 0.35*Math.abs(Math.sin(phase*1.3 + i*0.9)) * (0.6 + 0.4*Math.random());
    }
  } else if (vizState === 'thinking'){
    phase += 0.06;
    for (let i=0;i<BARS;i++){
      levels[i] = 0.12 + 0.05*Math.sin(phase*2 + i*0.5);
    }
  } else if (vizState === 'speaking'){
    phase += 0.18;
    for (let i=0;i<BARS;i++){
      levels[i] = 0.18 + 0.32*Math.abs(Math.sin(phase + i*0.7)) * Math.abs(Math.sin(phase*0.3));
    }
  } else {
    phase += 0.02;
    for (let i=0;i<BARS;i++){
      levels[i] = 0.08 + 0.02*Math.sin(phase + i);
    }
  }

  ctx.save();
  ctx.translate(cx, cy);
  for (let i=0;i<BARS;i++){
    const angle = (i/BARS) * Math.PI * 2;
    const len = baseR * 0.55 * levels[i];
    const r1 = baseR;
    const r2 = baseR + len;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55 + levels[i]*0.4;
    ctx.lineWidth = size*0.012;
    ctx.lineCap = 'round';
    ctx.moveTo(Math.cos(angle)*r1, Math.sin(angle)*r1);
    ctx.lineTo(Math.cos(angle)*r2, Math.sin(angle)*r2);
    ctx.stroke();
  }
  ctx.restore();

  animFrame = requestAnimationFrame(drawOrb);
}

/* ---------- Speech recognition ---------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let sessionActive = false;

function buildRecognition(){
  const r = new SR();
  r.lang = 'en-US';
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 1;
  return r;
}

// How long a silence has to last before we consider the user done talking.
// Generous on purpose — tolerates hesitation, "uhh", searching for a word, etc.
const SILENCE_MS = 2200;

function setState(s){
  vizState = s;
  mainBtn.classList.remove('listening','thinking','speaking');
  if (s !== 'idle') mainBtn.classList.add(s);
  const labels = { idle: 'TALK', listening: 'LISTENING', thinking: '···', speaking: 'SPEAKING' };
  btnLabel.textContent = labels[s] || 'TALK';
  const statusText = {
    idle: 'Tap to start',
    listening: 'Listening… speak naturally',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
  };
  statusEl.textContent = statusText[s] || '';
}

function listen(){
  if (!sessionActive) return;

  let accumulated = '';
  let lastSpeechTime = Date.now();

  function startChunk(){
    if (!sessionActive) return;
    recognition = buildRecognition();

    recognition.onstart = () => setState('listening');

    recognition.onresult = (e) => {
      // Android sometimes emits several result entries that are each
      // already cumulative (not incremental deltas) — summing them all
      // together doubles/repeats text. Only the LAST entry matters.
      const last = e.results[e.results.length - 1];
      const t = last[0].transcript;
      if (t.trim()) lastSpeechTime = Date.now();

      if (last.isFinal){
        if (t.trim()) accumulated = (accumulated + ' ' + t).trim();
        setCaption(accumulated);
      } else {
        setCaption((accumulated + ' ' + t).trim());
      }
    };

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed'){
        statusEl.textContent = 'Microphone access denied';
        endSession();
        return;
      }
      if (e.error !== 'no-speech' && e.error !== 'aborted'){
        console.warn('SpeechRecognition error:', e.error);
      }
      // onend fires right after onerror in all these cases — let it decide
      // whether to finalize or start the next chunk.
    };

    recognition.onend = () => {
      if (!sessionActive || vizState !== 'listening') return;
      const silentFor = Date.now() - lastSpeechTime;
      if (accumulated.trim() && silentFor >= SILENCE_MS){
        const text = accumulated.trim();
        accumulated = '';
        handleUserUtterance(text);
      } else {
        // Either mid-utterance pause (short native gap) or nothing said
        // yet — start the next short chunk to keep listening.
        startChunk();
      }
    };

    try{ recognition.start(); }catch(e){ /* already running, ignore */ }
  }

  startChunk();
}

async function handleUserUtterance(text){
  if (text.length > 1000) text = text.slice(0, 1000); // safety cap, avoids oversized requests
  setState('thinking');
  history.push({ role: 'user', content: text });
  saveHistory();

  try{
    const reply = await callGroq();
    history.push({ role: 'assistant', content: reply });
    saveHistory();
    speak(reply);
  }catch(err){
    console.error(err);
    statusEl.textContent = err.message || 'Connection error';
    captionEl.textContent = '⚠ ' + (err.message || 'Connection error');
    setState('idle');
    sessionActive = false;
    toggleSessionUI(false);
  }
}

/* ---------- Groq ---------- */

async function callGroq(){
  if (!store.key){
    throw new Error('Add your Groq API key in settings');
  }
  const convo = history.slice(-16);
  if (convo.length === 0){
    // Groq requires the last message to be role 'user'. This kickoff line
    // is never shown or saved — it just triggers the AI's opening line.
    convo.push({ role: 'user', content: '(Start the conversation with your opener.)' });
  }
  const messages = [{ role: 'system', content: systemPrompt() }, ...convo];

  const lastUser = [...convo].reverse().find(m => m.role === 'user');
  const model = pickModel(lastUser ? lastUser.content : '');

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${store.key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_completion_tokens: 220,
      temperature: 0.8,
    }),
  });

  if (!res.ok){
    let detail = '';
    try{ const errBody = await res.json(); detail = errBody?.error?.message || ''; }catch(e){}

    // If the search model is rate-limited, fall back to the reliable
    // default model rather than ending the conversation.
    if (res.status === 429 && model === SEARCH_MODEL){
      return callGroqWithModel(messages, DEFAULT_MODEL);
    }

    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 429) throw new Error('Rate limit reached, wait a moment');
    throw new Error('Groq error ' + res.status + (detail ? ': ' + detail : ''));
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from Groq');
  return content.trim();
}

async function callGroqWithModel(messages, model){
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${store.key}`,
    },
    body: JSON.stringify({ model, messages, max_completion_tokens: 220, temperature: 0.8 }),
  });
  if (!res.ok){
    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 429) throw new Error('Rate limit reached, wait a moment');
    throw new Error('Groq error ' + res.status);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from Groq');
  return content.trim();
}

/* ---------- Speech synthesis ---------- */

function speakRaw(text){
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const chosen = cachedVoices.find(v => v.voiceURI === store.voiceURI);
    if (chosen) u.voice = chosen;
    u.lang = 'en-US';
    u.rate = store.rate || 1;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

async function speak(text){
  setState('speaking');
  setCaption(text);
  await speakRaw(text);
  if (sessionActive) listen();
  else setState('idle');
}

/* ---------- Session control ---------- */

function toggleSessionUI(active){
  stopBtn.hidden = !active;
}

async function startSession(){
  if (!store.key){
    openSettings();
    return;
  }
  if (!SR){
    statusEl.textContent = 'Speech recognition not supported on this browser';
    return;
  }
  try{
    // Request permission, then immediately release the stream — we don't
    // keep it open, so it can't compete with SpeechRecognition's own mic
    // access (which was silently starving recognition of audio before).
    const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permStream.getTracks().forEach(t => t.stop());
  }catch(e){
    statusEl.textContent = 'Microphone access denied';
    return;
  }

  sessionActive = true;
  toggleSessionUI(true);

  // Instant local welcome — no network needed — confirms TTS works
  // even before we contact Groq for the real conversation opener.
  setState('speaking');
  await speakRaw("Hi! Let's talk.");
  if (!sessionActive) return; // user tapped "End conversation" during the welcome

  if (history.length === 0){
    // AI opens the conversation
    setState('thinking');
    try{
      const reply = await callGroq();
      history.push({ role: 'assistant', content: reply });
      saveHistory();
      speak(reply);
    }catch(err){
      statusEl.textContent = err.message;
      captionEl.textContent = '⚠ ' + err.message;
      sessionActive = false;
      toggleSessionUI(false);
      setState('idle');
    }
  } else {
    listen();
  }
}

function endSession(){
  sessionActive = false;
  toggleSessionUI(false);
  if (recognition) try{ recognition.stop(); }catch(e){}
  speechSynthesis.cancel();
  setState('idle');
}

mainBtn.addEventListener('click', () => {
  if (!sessionActive) startSession();
});
stopBtn.addEventListener('click', endSession);

/* ---------- Boot ---------- */

resizeCanvas();
setState('idle');
drawOrb();

if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
