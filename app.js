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
  get pauseMs(){ return parseInt(localStorage.getItem('pauseMs') || '800', 10); },
  set pauseMs(v){ localStorage.setItem('pauseMs', v); },
  get keepAwake(){ return localStorage.getItem('keepAwake') !== 'false'; }, // default on
  set keepAwake(v){ localStorage.setItem('keepAwake', v); },
  get lipDetectEnabled(){ return localStorage.getItem('lipDetectEnabled') !== 'false'; }, // default on
  set lipDetectEnabled(v){ localStorage.setItem('lipDetectEnabled', v); },
  // Learned speaking rate, normalized to rate=1 — refined after every
  // utterance so the reveal speed adapts to the real device/voice.
  get charsPerSecondBase(){ return parseFloat(localStorage.getItem('cpsBase') || '15'); },
  set charsPerSecondBase(v){ localStorage.setItem('cpsBase', v); },
  // Self-tuning lip-movement sensitivity threshold — adjusted based on
  // how often the video signal actually helps vs. false-triggers.
  get lipThreshold(){ return parseFloat(localStorage.getItem('lipThresholdV2') || '0.06'); },
  set lipThreshold(v){ localStorage.setItem('lipThresholdV2', v); },
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
const dbgPhaseEl = document.getElementById('dbgPhase');
const dbgHeuristicEl = document.getElementById('dbgHeuristic');
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

/* ---------- Debug panel — every dialogue-dynamics state, in plain text ---------- */

function setPhase(text){
  dbgPhaseEl.textContent = text;
}

function updateDebugPanel(){
  const labels = {
    unknown: 'Heuristic: —',
    complete: 'Heuristic: sentence looks complete',
    incomplete: 'Heuristic: sentence unfinished',
  };
  dbgHeuristicEl.textContent = labels[lastSemanticState] || labels.unknown;
}

/* ---------- Semantic end-of-sentence heuristic (no visual dot — used as a fallback signal and reported in the debug panel) ---------- */

let lastSemanticState = 'unknown';
function setSemanticIndicator(state){
  lastSemanticState = state;
  updateDebugPanel();
}

let semanticCheckTimer = null;

// Words that, when trailing, strongly suggest the thought isn't finished
// yet (articles, conjunctions, prepositions, subject pronouns, fillers...).
// Deliberately excludes object pronouns like "it"/"that" — those very
// commonly and correctly end a complete English sentence ("I like it.",
// "I know that.") and would otherwise cause false "incomplete" reads.
const CONTINUATION_ENDERS = new Set([
  // Articles / conjunctions
  'a','an','the','and','or','but','so','because','if','when','while','although',
  'unless','until','since','though','whereas','whether','before','after','once',
  'nor','yet','either','neither',
  // Prepositions
  'to','of','in','on','at','for','with','from','by','about','as','which','who',
  'into','onto','over','under','between','among','through','during','without',
  'within','against','toward','towards','upon','across','behind','beyond',
  'beside','along','around','above','below','near','off','up','down','out',
  // Auxiliary / modal verbs
  'is','are','was','were','am','be','been','being','do','does','did',
  'have','has','had','having','can','could','will','would','shall','should',
  'may','might','must',
  // Subject pronouns
  'i','you','he','she','we','they',
  // Possessives
  'my','your','his','her','its','our','their',
  // Determiners / quantifiers
  'this','these','those','some','any','no','every','each','all','both',
  'many','much','more','most','several','few','little','other','another','such',
  // Fillers / hesitations
  'um','uh','er','like','than','then','not',
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
const keepAwakeToggle = document.getElementById('keepAwakeToggle');
const lipDetectToggle = document.getElementById('lipDetectToggle');
const camPreviewEl = document.getElementById('camPreview');
const lipReadoutEl = document.getElementById('lipReadout');

/* ---------- Settings panel ---------- */

function openSettings(){
  apiKeyInput.value = store.key;
  topicInput.value = store.topic;
  rateInput.value = store.rate;
  pauseInput.value = store.pauseMs;
  keepAwakeToggle.checked = store.keepAwake;
  lipDetectToggle.checked = store.lipDetectEnabled;
  updatePauseHint();
  populateVoices();
  settingsPanel.hidden = false;
}
function closeSettings(){
  store.key = apiKeyInput.value.trim();
  store.topic = topicInput.value.trim();
  store.rate = parseFloat(rateInput.value);
  store.pauseMs = parseInt(pauseInput.value, 10);
  store.keepAwake = keepAwakeToggle.checked;
  const lipWasEnabled = store.lipDetectEnabled;
  store.lipDetectEnabled = lipDetectToggle.checked;
  const v = voiceSelect.value;
  if (v) store.voiceURI = v;
  settingsPanel.hidden = true;
  if (sessionActive && store.keepAwake) acquireWakeLock();
  if (!store.keepAwake) releaseWakeLock();
  if (sessionActive){
    if (store.lipDetectEnabled && !lipWasEnabled) startLipWatch();
    if (!store.lipDetectEnabled && lipWasEnabled) stopLipWatch();
  }
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
  setButtonMessage('Reset');
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
  setButtonMessage('Add API key');
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
  const fast = store.pauseMs;
  if (lipState === 'moving') return 4000;                 // confirmed still talking
  if (lipState === 'still') return fast;                  // confirmed done — lips are the strongest signal
  // No face, or lips didn't help — fall back to the word heuristic.
  if (lastSemanticState === 'incomplete') return 4000;     // confirmed still talking
  if (lastSemanticState === 'complete') return fast;       // confirmed done
  return 1800;                                             // genuinely uncertain — don't rush
}

function setState(s){
  vizState = s;
  mainBtn.classList.remove('listening','thinking','speaking');
  mainBtn.classList.remove('longMsg');
  if (s !== 'idle') mainBtn.classList.add(s);
  const labels = { idle: 'TALK', listening: 'LISTENING', thinking: '···', speaking: 'SPEAKING' };
  btnLabel.textContent = labels[s] || 'TALK';
}

// For anything longer than a short state word (errors, notices) — shown
// inside the button itself, with smaller wrapping text.
function setButtonMessage(text){
  btnLabel.textContent = text;
  mainBtn.classList.toggle('longMsg', text.length > 10);
}

// How long to wait for a continuation before deciding a barge-in was a
// false alarm and letting the AI resume — deliberately independent of
// the (now much shorter) fast conversational pause setting, so a normal
// breath mid-sentence doesn't trigger a premature resume.
const RESUME_GRACE_MS = 2500;

function listen(resumeCallback){
  if (!sessionActive) return;

  let accumulated = '';
  let lastSpeechTime = Date.now();
  const listenStartTime = Date.now();
  let finalized = false;
  let watchdogTimer = null;
  mouthBuffer = []; // fresh start — don't judge this turn on stale samples from before

  setUserCaption('');
  setActiveZone('user');
  setSemanticIndicator('unknown');
  setPhase('Sentence in progress…');

  function cleanupWatchdog(){
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  function finalizeUtterance(){
    if (finalized) return;
    finalized = true;
    cleanupWatchdog();
    if (recognition) try{ recognition.stop(); }catch(e){}

    const text = accumulated.trim();
    const thresholdUsed = silenceMs();
    const wasLong = thresholdUsed >= 4000;

    // Adaptive lip-threshold tuning: if a face is visible but we still
    // ended up waiting the long pause repeatedly, the lip signal isn't
    // helping — make it more sensitive. Any fast finalize resets the
    // streak (the signal is doing its job).
    if (lipState !== 'no-face'){
      if (!wasLong){
        longWaitStreak = 0;
      } else {
        longWaitStreak++;
        if (longWaitStreak >= 3){
          store.lipThreshold = Math.max(0.01, store.lipThreshold * 0.8);
          longWaitStreak = 0;
        }
      }
    }

    setPhase(`Pause confirmed (${wasLong ? 'long' : 'fast'}, ${(thresholdUsed/1000).toFixed(1)}s) → sending`);
    handleUserUtterance(text);
  }

  function giveUpAndResume(){
    if (finalized) return;
    finalized = true;
    cleanupWatchdog();
    if (recognition) try{ recognition.stop(); }catch(e){}
    resumeCallback();
  }

  // Checks elapsed silence on our own clock, independently of Chrome's
  // recognition cycle (which can take 1-2s to fire onend by itself —
  // far slower than a short configured pause tolerance).
  watchdogTimer = setInterval(() => {
    if (finalized || !sessionActive || vizState !== 'listening' || pausedForOffline) return;
    const silentFor = Date.now() - lastSpeechTime;
    if (accumulated.trim() && silentFor >= silenceMs()){
      finalizeUtterance();
    } else if (resumeCallback && !accumulated.trim() && Date.now() - listenStartTime >= RESUME_GRACE_MS){
      giveUpAndResume();
    }
  }, 150);

  function startChunk(){
    if (!sessionActive || finalized) return;
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
        setButtonMessage('Mic blocked');
        endSession();
        return;
      }
      if (e.error === 'network' && !navigator.onLine){
        setOfflineUI(true);
        pausedForOffline = true;
        return; // don't loop-retry while offline — the 'online' listener resumes us
      }
      if (e.error !== 'no-speech' && e.error !== 'aborted'){
        console.warn('SpeechRecognition error:', e.error);
      }
      // onend fires right after onerror in all these cases — let it decide
      // whether to restart the chunk.
    };

    recognition.onend = () => {
      // The watchdog above is what actually decides when to finalize —
      // this just keeps the recognition chunks chained for as long as
      // we're still waiting.
      if (finalized || !sessionActive || vizState !== 'listening' || pausedForOffline) return;
      startChunk();
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

function friendlyError(err){
  const msg = err?.message || 'Connection error';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError')){
    return 'Network hiccup — check your connection and tap TALK to try again';
  }
  return msg;
}

async function handleUserUtterance(text){
  if (text.length > 1000) text = text.slice(0, 1000); // safety cap, avoids oversized requests
  setState('thinking');
  setPhase('Thinking (contacting AI)…');

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
    const msg = friendlyError(err);
    setButtonMessage(msg);
    setAiCaption('⚠ ' + msg);
    setActiveZone('ai');
    setState('idle');
    sessionActive = false;
  }
}

/* ---------- Groq ---------- */

// Retries only on network-level failures (fetch() itself rejecting —
// "Failed to fetch" and the like), not on HTTP error responses (429,
// 413, etc.), which already have their own specific handling below.
async function fetchWithRetry(url, opts, retries = 1){
  try{
    return await fetch(url, opts);
  }catch(err){
    if (retries > 0){
      await new Promise(r => setTimeout(r, 700));
      return fetchWithRetry(url, opts, retries - 1);
    }
    throw err;
  }
}

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

  const res = await fetchWithRetry(GROQ_URL, {
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
  const res = await fetchWithRetry(GROQ_URL, {
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

    let speechStartTime = null;
    let revealTimer = null;
    function stopReveal(){ if (revealTimer) clearInterval(revealTimer); }

    // onboundary (word-by-word progress) is unfortunately not reliably
    // fired by Android Chrome's TTS engine, so we simulate the reveal
    // timing instead, anchored to the real moment speech actually starts
    // (onstart) rather than when we merely requested it — engine startup
    // latency was otherwise the main source of the caption/voice desync.
    function startReveal(){
      if (!onProgress || revealTimer) return;
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

    function finish(){
      stopReveal();
      // Learn the real speaking speed for next time — normalize back to
      // rate=1 so it stays valid even if the user changes the rate slider.
      // Measured from actual speech onset, not from when we called speak().
      if (speechStartTime !== null){
        const actualMs = Date.now() - speechStartTime;
        if (actualMs > 250 && text.length > 8){
          const actualCps = text.length / (actualMs / 1000);
          const actualBase = actualCps / rate;
          const prevBase = store.charsPerSecondBase;
          store.charsPerSecondBase = prevBase * 0.6 + actualBase * 0.4; // EMA — adapts over a few turns
        }
      }
      resolve();
    }

    u.onstart = () => {
      speechStartTime = Date.now();
      startReveal();
    };
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);

    // Fallback in case onstart never fires on some device/voice — don't
    // leave the caption blank for the whole utterance.
    setTimeout(() => { if (speechStartTime === null) startReveal(); }, 400);
  });
}

/* ---------- Visual lip-movement detection ---------- */
// Uses the front camera (never the mic) so it never touches the audio
// pipeline that caused the Bluetooth/choppy-TTS problems. Runs
// continuously for the whole session once started; both the listening
// side (silenceMs) and the speaking side (visual barge-in) just read the
// shared `lipState` variable below.

let faceLandmarkerPromise = null;
function ensureFaceLandmarker(){
  if (!faceLandmarkerPromise){
    faceLandmarkerPromise = (async () => {
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
      const fileset = await vision.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      return vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
    })().catch(err => { console.warn('Face landmarker failed to load', err); faceLandmarkerPromise = null; return null; });
  }
  return faceLandmarkerPromise;
}

let camStream = null;
let lipLoopTimer = null;
let lipState = 'no-face'; // 'no-face' | 'still' | 'moving'
let longWaitStreak = 0;   // consecutive turns finalized via the long pause despite a visible face
let earlyBargeStreak = 0; // consecutive very-early (likely false-positive) barge-ins
let mouthBuffer = [];

const MOUTH_UPPER = 13, MOUTH_LOWER = 14, MOUTH_LEFT = 61, MOUTH_RIGHT = 291;
const BUFFER_MS = 650;

function dist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y); }

async function startLipWatch(){
  if (!store.lipDetectEnabled || camStream) return;
  try{
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } }
    });
  }catch(e){
    camStream = null;
    return; // permission denied or no camera — silently fall back to audio-only
  }

  camPreviewEl.srcObject = camStream;
  camPreviewEl.hidden = false;
  lipReadoutEl.hidden = false;

  const landmarker = await ensureFaceLandmarker();
  if (!landmarker || !camStream){ stopLipWatch(); return; }

  lipLoopTimer = setInterval(() => {
    if (camPreviewEl.readyState < 2) return; // not enough video data yet
    let result;
    try{ result = landmarker.detectForVideo(camPreviewEl, performance.now()); }
    catch(e){ return; }

    if (!result || !result.faceLandmarks || !result.faceLandmarks.length){
      lipState = 'no-face';
      mouthBuffer = [];
      lipReadoutEl.textContent = 'no face';
      return;
    }

    const lm = result.faceLandmarks[0];
    const mouthWidth = dist(lm[MOUTH_LEFT], lm[MOUTH_RIGHT]) || 1;
    const mouthOpen = dist(lm[MOUTH_UPPER], lm[MOUTH_LOWER]) / mouthWidth;

    const now = Date.now();
    mouthBuffer.push({ t: now, v: mouthOpen });
    mouthBuffer = mouthBuffer.filter(s => now - s.t <= BUFFER_MS);

    if (mouthBuffer.length >= 3){
      const vals = mouthBuffer.map(s => s.v);
      const range = Math.max(...vals) - Math.min(...vals);
      lipState = range > store.lipThreshold ? 'moving' : 'still';
      lipReadoutEl.textContent = `${range.toFixed(3)} / thr ${store.lipThreshold.toFixed(3)} — ${lipState}`;
    }
  }, 100); // ~10Hz — plenty for mouth movement, easy on battery
}

function stopLipWatch(){
  if (lipLoopTimer) clearInterval(lipLoopTimer);
  lipLoopTimer = null;
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  camStream = null;
  camPreviewEl.hidden = true;
  camPreviewEl.srcObject = null;
  lipReadoutEl.hidden = true;
  lipState = 'no-face';
  mouthBuffer = [];
}

function watchForVisualBargeIn(onTrigger){
  if (!store.lipDetectEnabled) return () => {};
  let stopped = false;
  const iv = setInterval(() => {
    if (stopped) return;
    if (lipState === 'moving'){
      stopped = true;
      clearInterval(iv);
      onTrigger();
    }
  }, 150);
  return () => { stopped = true; clearInterval(iv); };
}

async function speak(text){
  setState('speaking');
  setActiveZone('ai');
  setAiCaption('');
  setPhase('AI speaking…');
  mouthBuffer = []; // avoid stale movement from the user's last turn causing an instant false barge-in

  let spokenChars = 0;
  let bargeTriggered = false;
  const speakStart = Date.now();
  const stopWatch = watchForVisualBargeIn(() => { bargeTriggered = true; speechSynthesis.cancel(); });

  await speakRaw(text, (partial) => { spokenChars = partial.length; setAiCaption(partial); });

  stopWatch();

  if (!sessionActive){
    setState('idle');
    return;
  }

  if (bargeTriggered){
    const fraction = text.length ? spokenChars / text.length : 0;
    const elapsedMs = Date.now() - speakStart;
    handleBargeIn(text.slice(0, spokenChars).trim(), fraction, elapsedMs, text);
    return;
  }

  setAiCaption(text);
  listen();
}

// How far into the AI's reply (0–1) a barge-in still counts as "the app
// cut the user off early, they're continuing the same thought" rather
// than "a deliberate interruption".
const BARGE_IN_EARLY_FRACTION = 0.25;

function handleBargeIn(spokenPortion, fraction, elapsedMs, fullText){
  setAiCaption(spokenPortion || '(interrupted)');

  // Adaptive lip-threshold tuning: a barge-in firing very soon after the
  // AI started talking is more likely a false trigger (oversensitive)
  // than a genuine cut — if it keeps happening, make it less sensitive.
  if (elapsedMs < 1500){
    earlyBargeStreak++;
    if (earlyBargeStreak >= 2){
      store.lipThreshold = store.lipThreshold * 1.25;
      earlyBargeStreak = 0;
    }
  } else {
    earlyBargeStreak = 0;
  }

  if (fraction < BARGE_IN_EARLY_FRACTION){
    setPhase('Barge-in: accidental cutoff detected — merging');
    const discardedReply = (history.length && history[history.length - 1].role === 'assistant')
      ? history[history.length - 1].content : null;
    if (discardedReply !== null){
      history.pop(); // discard the premature reply for now — restored below if this was a false alarm
      saveHistory();
    }
    pendingMerge = true;

    const remainder = fullText.slice(spokenPortion.length).trim();
    listen(() => {
      // No continuation came within the pause window — false alarm.
      // The AI didn't actually get cut off; let it finish its sentence.
      pendingMerge = false;
      setPhase('No continuation heard — resuming AI reply');
      if (discardedReply !== null){
        history.push({ role: 'assistant', content: discardedReply });
        saveHistory();
      }
      if (remainder){
        speak(remainder);
      } else {
        setAiCaption(discardedReply || '');
        listen();
      }
    });
    return;
  }

  setPhase('Barge-in: voluntary interruption detected');
  if (history.length && history[history.length - 1].role === 'assistant'){
    history[history.length - 1].content = spokenPortion || '(cut short)';
    saveHistory();
  }
  pendingInterruptionNote = true;

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
    setButtonMessage('No speech support');
    return;
  }
  try{
    // Request permission, then immediately release the stream — we don't
    // keep it open, so it can't compete with SpeechRecognition's own mic
    // access (which was silently starving recognition of audio before).
    const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permStream.getTracks().forEach(t => t.stop());
  }catch(e){
    setButtonMessage('Mic blocked');
    return;
  }

  sessionActive = true;
  if (store.keepAwake) acquireWakeLock();
  if (store.lipDetectEnabled) startLipWatch();

  if (history.length === 0){
    // AI opens the conversation
    setState('thinking');
    try{
      const reply = await callGroq();
      const capped = pushAssistantReply(reply);
      speak(capped);
    }catch(err){
      const msg = friendlyError(err);
      setButtonMessage(msg);
      setAiCaption('⚠ ' + msg);
      sessionActive = false;
      setState('idle');
    }
  } else {
    listen();
  }
}

/* ---------- Network connectivity monitoring ---------- */

let pausedForOffline = false;

let offlineMessageShown = false;
function setOfflineUI(offline){
  mainBtn.classList.toggle('offline', offline);
  if (offline){
    setButtonMessage('Offline — tap to retry');
    offlineMessageShown = true;
  } else if (offlineMessageShown){
    offlineMessageShown = false;
    setState(vizState); // restore the normal short label
  }
}

window.addEventListener('offline', () => {
  setOfflineUI(true);
  pausedForOffline = true;
});

window.addEventListener('online', () => {
  setOfflineUI(false);
  if (sessionActive && pausedForOffline){
    pausedForOffline = false;
    if (recognition) try{ recognition.stop(); }catch(e){}
    listen();
  }
});

function endSession(){
  sessionActive = false;
  if (recognition) try{ recognition.stop(); }catch(e){}
  speechSynthesis.cancel();
  setActiveZone(null);
  clearTimeout(semanticCheckTimer);
  setSemanticIndicator('unknown');
  releaseWakeLock();
  stopLipWatch();
  setPhase('');
  setState('idle');
}

mainBtn.addEventListener('click', () => {
  if (!sessionActive) startSession();
  else endSession();
});

/* ---------- Boot ---------- */

setOfflineUI(!navigator.onLine);
resizeCanvas();
setState('idle');
updateDebugPanel();
drawOrb();

if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
