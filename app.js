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
  get pauseMs(){ return parseInt(localStorage.getItem('pauseMs') || '2200', 10); },
  set pauseMs(v){ localStorage.setItem('pauseMs', v); },
  get bargeInEnabled(){ return localStorage.getItem('bargeInEnabled') === 'true'; }, // default off — degrades TTS audio even without Bluetooth
  set bargeInEnabled(v){ localStorage.setItem('bargeInEnabled', v); },
  get keepAwake(){ return localStorage.getItem('keepAwake') === 'true'; }, // default off
  set keepAwake(v){ localStorage.setItem('keepAwake', v); },
  // Learned speaking rate, normalized to rate=1 — refined after every
  // utterance so the reveal speed adapts to the real device/voice.
  get charsPerSecondBase(){ return parseFloat(localStorage.getItem('cpsBase') || '15'); },
  set charsPerSecondBase(v){ localStorage.setItem('cpsBase', v); },
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
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `You are a warm, casual native English speaker having a real spoken conversation with someone practicing English. ` +
    `Talk about everyday life, ask natural follow-up questions, react like a real person (curiosity, humor, small opinions). ` +
    `Keep replies SHORT — 1 to 3 sentences, like real speech, never a lecture. ` +
    `The real current date and time where the user is is: ${dateStr}, ${timeStr}. Use this whenever you refer to "today", ` +
    `the day of the week, "this morning/evening", or anything time-related — never guess or invent a date. ` +
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
let pendingMerge = false;            // true: next finalized utterance should merge onto the last user turn (app cut user off early)
let pendingInterruptionNote = false; // true: next finalized utterance is a deliberate interruption of the AI

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
const statusEl = document.getElementById('status');
const aiCaptionEl = document.getElementById('aiCaption');
const aiCaptionWrapEl = document.getElementById('aiCaptionWrap');
const userCaptionEl = document.getElementById('userCaption');
const userCaptionWrapEl = document.getElementById('userCaptionWrap');

function scrollToBottom(wrapEl){
  requestAnimationFrame(() => {
    wrapEl.scrollTo({ top: wrapEl.scrollHeight, behavior: 'smooth' });
  });
}
function setAiCaption(text){
  aiCaptionEl.textContent = text;
  scrollToBottom(aiCaptionWrapEl);
}
function setUserCaption(text){
  userCaptionEl.textContent = text;
  scrollToBottom(userCaptionWrapEl);
}
// Highlights whichever zone is currently "live" (speaking vs listening).
function setActiveZone(which){
  aiCaptionWrapEl.classList.toggle('active', which === 'ai');
  userCaptionWrapEl.classList.toggle('active', which === 'user');
}

/* ---------- Semantic end-of-sentence indicator (passive, informational only) ---------- */

const semanticDotEl = document.getElementById('semanticDot');
let lastSemanticState = 'unknown';
function setSemanticIndicator(state){
  lastSemanticState = state;
  semanticDotEl.classList.remove('complete', 'incomplete');
  if (state === 'complete') semanticDotEl.classList.add('complete');
  else if (state === 'incomplete') semanticDotEl.classList.add('incomplete');
}

let semanticCheckTimer = null;

// Words that, when trailing, strongly suggest the thought isn't finished
// yet (articles, conjunctions, prepositions, subject pronouns, fillers...).
// Deliberately excludes object pronouns like "it"/"that" — those very
// commonly and correctly end a complete English sentence ("I like it.",
// "I know that.") and would otherwise cause false "incomplete" reads.
const CONTINUATION_ENDERS = new Set([
  'a','an','the','and','or','but','so','because','if','when','while','although',
  'to','of','in','on','at','for','with','from','by','about','as','which','who',
  'is','are','was','were','am','be','been','being','i','you','he','she','we','they',
  'my','your','his','her','its','our','their','um','uh','er','like','than','then','not',
]);

// Free, local, instant heuristic — no network call, so it costs nothing.
// It's cruder than an LLM judgment, but reacts immediately and never
// touches the API quota.
function isLikelyComplete(text){
  const words = text.trim().toLowerCase().replace(/[^\w\s']/g, '').split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const lastWord = words[words.length - 1];
  if (CONTINUATION_ENDERS.has(lastWord)) return false;
  return true;
}

function scheduleSemanticCheck(text){
  clearTimeout(semanticCheckTimer);
  semanticCheckTimer = setTimeout(() => {
    setSemanticIndicator(isLikelyComplete(text) ? 'complete' : 'incomplete');
  }, 150);
}
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const resetConvoBtn = document.getElementById('resetConvoBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
const topicInput = document.getElementById('topicInput');
const voiceSelect = document.getElementById('voiceSelect');
const rateInput = document.getElementById('rateInput');
const pauseInput = document.getElementById('pauseInput');
const pauseHint = document.getElementById('pauseHint');
const bargeInToggle = document.getElementById('bargeInToggle');
const keepAwakeToggle = document.getElementById('keepAwakeToggle');

/* ---------- Settings panel ---------- */

function openSettings(){
  apiKeyInput.value = store.key;
  topicInput.value = store.topic;
  rateInput.value = store.rate;
  pauseInput.value = store.pauseMs;
  bargeInToggle.checked = store.bargeInEnabled;
  keepAwakeToggle.checked = store.keepAwake;
  updatePauseHint();
  populateVoices();
  settingsPanel.hidden = false;
}
function closeSettings(){
  store.key = apiKeyInput.value.trim();
  store.topic = topicInput.value.trim();
  store.rate = parseFloat(rateInput.value);
  store.pauseMs = parseInt(pauseInput.value, 10);
  store.bargeInEnabled = bargeInToggle.checked;
  store.keepAwake = keepAwakeToggle.checked;
  const v = voiceSelect.value;
  if (v) store.voiceURI = v;
  settingsPanel.hidden = true;
  if (sessionActive && store.keepAwake) acquireWakeLock();
  if (!store.keepAwake) releaseWakeLock();
}
function updatePauseHint(){
  pauseHint.textContent = (parseInt(pauseInput.value, 10) / 1000).toFixed(1) + 's';
}
pauseInput.addEventListener('input', updatePauseHint);
settingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);
resetConvoBtn.addEventListener('click', () => {
  history = [];
  saveHistory();
  setAiCaption('');
  setUserCaption('');
  statusEl.textContent = 'Conversation reset';
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
// Adjustable in settings — tolerates hesitation, "uhh", searching for a word, etc.
// Adaptive pause: the settings slider is now the "unknown/ambiguous"
// baseline. If the free heuristic spots an obviously dangling word, we
// wait noticeably longer (less risk of cutting a real thought short).
// If it looks finished, we finalize sooner — barge-in is the safety net
// that recovers gracefully on the rarer cases where that guess is wrong.
function silenceMs(){
  const base = store.pauseMs;
  if (lastSemanticState === 'incomplete') return Math.max(base, 4000);
  if (lastSemanticState === 'complete') return Math.min(base, 1400);
  return base;
}

function setState(s){
  vizState = s;
  mainBtn.classList.remove('listening','thinking','speaking');
  if (s !== 'idle') mainBtn.classList.add(s);
  const labels = { idle: 'TALK', listening: 'LISTENING', thinking: '···', speaking: 'SPEAKING' };
  btnLabel.textContent = labels[s] || 'TALK';
  const statusText = {
    idle: '',
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
  setUserCaption('');
  setActiveZone('user');
  setSemanticIndicator('unknown');

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
        setUserCaption(accumulated);
        scheduleSemanticCheck(accumulated);
      } else {
        const combined = (accumulated + ' ' + t).trim();
        setUserCaption(combined);
        scheduleSemanticCheck(combined);
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
      if (accumulated.trim() && silentFor >= silenceMs()){
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

function pushAssistantReply(reply){
  const capped = reply.length > 900 ? reply.slice(0, 900) : reply;
  history.push({ role: 'assistant', content: capped });
  saveHistory();
  return capped;
}

async function handleUserUtterance(text){
  if (text.length > 1000) text = text.slice(0, 1000); // safety cap, avoids oversized requests
  setState('thinking');

  if (pendingMerge){
    // The app likely cut the user off mid-thought during the previous
    // turn — fold this continuation onto their last message instead of
    // treating it as a brand new one, so the AI sees the whole thought.
    pendingMerge = false;
    if (history.length && history[history.length - 1].role === 'user'){
      history[history.length - 1].content = (history[history.length - 1].content + ' ' + text).trim();
    } else {
      history.push({ role: 'user', content: text });
    }
  } else if (pendingInterruptionNote){
    // The user deliberately cut the AI off — flag it so the AI reacts
    // naturally instead of getting confused or repeating itself.
    pendingInterruptionNote = false;
    history.push({ role: 'system', content: 'The user just cut you off mid-sentence out of enthusiasm, not rudeness — react naturally, do not apologize or make a big deal of it.' });
    history.push({ role: 'user', content: text });
  } else {
    history.push({ role: 'user', content: text });
  }
  saveHistory();

  try{
    const reply = await callGroq();
    const capped = pushAssistantReply(reply);
    speak(capped);
  }catch(err){
    console.error(err);
    statusEl.textContent = err.message || 'Connection error';
    setAiCaption('⚠ ' + (err.message || 'Connection error'));
    setActiveZone('ai');
    setState('idle');
    sessionActive = false;
  }
}

/* ---------- Groq ---------- */

async function callGroq(){
  if (!store.key){
    throw new Error('Add your Groq API key in settings');
  }

  const lastUserFull = [...history].reverse().find(m => m.role === 'user');
  const model = pickModel(lastUserFull ? lastUserFull.content : '');

  // Search-model answers tend to be more verbose (search context, more
  // detail) — keep less history on those turns to reduce payload size
  // and the risk of a 413 (Request Entity Too Large).
  const historyWindow = model === SEARCH_MODEL ? 6 : 16;
  const convo = history.slice(-historyWindow);
  if (convo.length === 0){
    // Groq requires the last message to be role 'user'. This kickoff line
    // is never shown or saved — it just triggers the AI's opening line.
    convo.push({ role: 'user', content: '(Start the conversation with your opener.)' });
  }
  const messages = [{ role: 'system', content: systemPrompt() }, ...convo];

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

    // If the search model is rate-limited OR the request was too large,
    // fall back to the reliable default model rather than ending the
    // conversation.
    if ((res.status === 429 || res.status === 413) && model === SEARCH_MODEL){
      const fallbackMessages = [{ role: 'system', content: systemPrompt() }, ...history.slice(-4)];
      return callGroqWithModel(fallbackMessages, DEFAULT_MODEL);
    }

    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 429) throw new Error('Rate limit reached' + (detail ? ' — ' + detail : ', wait a moment'));
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
    let detail = '';
    try{ const errBody = await res.json(); detail = errBody?.error?.message || ''; }catch(e){}
    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 429) throw new Error('Rate limit reached' + (detail ? ' — ' + detail : ', wait a moment'));
    throw new Error('Groq error ' + res.status + (detail ? ': ' + detail : ''));
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from Groq');
  return content.trim();
}

/* ---------- Barge-in detection ---------- */

// Runs a lightweight amplitude-based voice detector while the AI is
// speaking. Uses echoCancellation so the phone's own TTS output (leaking
// into the mic) is suppressed as much as the browser's AEC allows — not
// perfect on every device, but the standard mechanism for this exact
// scenario (same one hands-free calls rely on).
function watchForBargeIn(onTrigger){
  let stopped = false;
  let cleanup = () => {};

  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  }).then(stream => {
    if (stopped){ stream.getTracks().forEach(t => t.stop()); return; }

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    const data = new Uint8Array(analyser.frequencyBinCount);
    audioCtx.createMediaStreamSource(stream).connect(analyser);

    // Only look at the frequency band where human voice actually lives
    // (~300Hz–3000Hz). Car engines, road noise, and AC hum are mostly
    // energy below ~300Hz — ignoring that band makes the detector far
    // less prone to false triggers from steady background noise.
    const binHz = audioCtx.sampleRate / 2 / analyser.frequencyBinCount;
    const loBin = Math.max(0, Math.floor(300 / binHz));
    const hiBin = Math.min(data.length - 1, Math.ceil(3000 / binHz));

    const startTime = Date.now();
    let baseline = null;
    let aboveCount = 0;
    let timer = null;

    cleanup = () => {
      if (timer) clearTimeout(timer);
      stream.getTracks().forEach(t => t.stop());
      try{ audioCtx.close(); }catch(e){}
    };

    function sample(){
      if (stopped) return;
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = loBin; i <= hiBin; i++) sum += data[i];
      const level = sum / (hiBin - loBin + 1);
      const elapsed = Date.now() - startTime;

      // Continuously track the ambient/leak level (slow moving average)
      // instead of a single early snapshot — this also means a steady
      // background noise floor (engine hum, etc.) gets absorbed into the
      // baseline rather than causing false triggers.
      if (baseline === null){
        baseline = level;
      } else if (level < baseline + 16){
        baseline = baseline * 0.9 + level * 0.1;
      }

      if (elapsed > 300){
        if (level > baseline + 16){
          aboveCount++;
          if (aboveCount >= 2){ // ~160ms of sustained louder sound
            stopped = true;
            cleanup();
            onTrigger();
            return;
          }
        } else {
          aboveCount = 0;
        }
      }
      timer = setTimeout(sample, 80);
    }
    sample();
  }).catch(() => { /* mic unavailable this turn — barge-in just won't fire */ });

  return () => { stopped = true; cleanup(); };
}

// How far into the AI's reply (0–1) a barge-in still counts as "the app
// cut the user off early, they're continuing the same thought" rather
// than "a deliberate interruption".
const BARGE_IN_EARLY_FRACTION = 0.25;

function handleBargeIn(spokenPortion, fraction){
  setAiCaption(spokenPortion || '(interrupted)');

  if (fraction < BARGE_IN_EARLY_FRACTION){
    if (history.length && history[history.length - 1].role === 'assistant'){
      history.pop(); // discard the premature reply entirely
      saveHistory();
    }
    pendingMerge = true;
  } else {
    if (history.length && history[history.length - 1].role === 'assistant'){
      history[history.length - 1].content = spokenPortion || '(cut short)';
      saveHistory();
    }
    pendingInterruptionNote = true;
  }

  listen();
}

/* ---------- Speech synthesis ---------- */

function speakRaw(text, onProgress){
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const chosen = cachedVoices.find(v => v.voiceURI === store.voiceURI);
    if (chosen) u.voice = chosen;
    u.lang = 'en-US';
    const rate = store.rate || 1;
    u.rate = rate;

    const startTime = Date.now();
    let revealTimer = null;
    function stopReveal(){ if (revealTimer) clearInterval(revealTimer); }

    function finish(){
      stopReveal();
      // Learn the real speaking speed for next time — normalize back to
      // rate=1 so it stays valid even if the user changes the rate slider.
      const actualMs = Date.now() - startTime;
      if (actualMs > 250 && text.length > 8){
        const actualCps = text.length / (actualMs / 1000);
        const actualBase = actualCps / rate;
        const prevBase = store.charsPerSecondBase;
        store.charsPerSecondBase = prevBase * 0.6 + actualBase * 0.4; // EMA — adapts over a few turns
      }
      resolve();
    }
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);

    // onboundary (word-by-word progress) is unfortunately not reliably
    // fired by Android Chrome's TTS engine, so we simulate the reveal
    // timing instead, using our learned speaking-rate estimate — this
    // still gives a "written as it's spoken" feel, and gets more accurate
    // turn after turn as store.charsPerSecondBase self-corrects.
    if (onProgress){
      const words = text.split(/\s+/).filter(Boolean);
      const cps = store.charsPerSecondBase * rate;
      const totalMs = Math.max(300, (text.length / cps) * 1000);
      const msPerWord = totalMs / Math.max(1, words.length);
      let idx = 0;
      revealTimer = setInterval(() => {
        idx++;
        onProgress(words.slice(0, idx).join(' '));
        if (idx >= words.length) stopReveal();
      }, msPerWord);
    }
  });
}

async function speak(text){
  setState('speaking');
  setActiveZone('ai');
  setAiCaption('');

  let spokenChars = 0;
  let bargeTriggered = false;

  const stopWatch = store.bargeInEnabled
    ? watchForBargeIn(() => { bargeTriggered = true; speechSynthesis.cancel(); })
    : () => {};

  await speakRaw(text, (partial) => {
    spokenChars = partial.length;
    setAiCaption(partial);
  });

  stopWatch();

  if (!sessionActive){
    setState('idle');
    return;
  }

  if (bargeTriggered){
    const fraction = text.length ? spokenChars / text.length : 0;
    handleBargeIn(text.slice(0, spokenChars).trim(), fraction);
    return;
  }

  setAiCaption(text);
  listen();
}

/* ---------- Screen wake lock ---------- */

let wakeLock = null;
async function acquireWakeLock(){
  if (!('wakeLock' in navigator)) return;
  try{
    wakeLock = await navigator.wakeLock.request('screen');
  }catch(e){ /* e.g. tab not visible — will retry on visibilitychange */ }
}
function releaseWakeLock(){
  if (wakeLock){ try{ wakeLock.release(); }catch(e){} wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sessionActive && store.keepAwake) acquireWakeLock();
});

/* ---------- Session control ---------- */

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
  if (store.keepAwake) acquireWakeLock();

  if (history.length === 0){
    // AI opens the conversation
    setState('thinking');
    try{
      const reply = await callGroq();
      const capped = pushAssistantReply(reply);
      speak(capped);
    }catch(err){
      statusEl.textContent = err.message;
      setAiCaption('⚠ ' + err.message);
      sessionActive = false;
      setState('idle');
    }
  } else {
    listen();
  }
}

function endSession(){
  sessionActive = false;
  if (recognition) try{ recognition.stop(); }catch(e){}
  speechSynthesis.cancel();
  setActiveZone(null);
  clearTimeout(semanticCheckTimer);
  setSemanticIndicator('unknown');
  releaseWakeLock();
  setState('idle');
}

mainBtn.addEventListener('click', () => {
  if (!sessionActive) startSession();
  else endSession();
});

/* ---------- Boot ---------- */

resizeCanvas();
setState('idle');
drawOrb();

if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
