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
const GROQ_MODEL = 'llama-3.3-70b-versatile';

function systemPrompt(){
  const topic = store.topic.trim();
  return `You are a warm, casual native English speaker having a real spoken conversation with someone practicing English. ` +
    `Talk about everyday life, ask natural follow-up questions, react like a real person (curiosity, humor, small opinions). ` +
    `Keep replies SHORT — 1 to 3 sentences, like real speech, never a lecture. ` +
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
let audioCtx, analyser, micSource, dataArray;
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

  if (vizState === 'listening' && analyser){
    analyser.getByteFrequencyData(dataArray);
    const step = Math.floor(dataArray.length / BARS);
    for (let i=0;i<BARS;i++){
      levels[i] = Math.min(1, (dataArray[i*step]/255) * 1.6 + 0.06);
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

async function startMicAnalyser(stream){
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  dataArray = new Uint8Array(analyser.frequencyBinCount);
  micSource = audioCtx.createMediaStreamSource(stream);
  micSource.connect(analyser);
}
function stopMicAnalyser(){
  if (micSource) try{ micSource.disconnect(); }catch(e){}
  if (audioCtx) try{ audioCtx.close(); }catch(e){}
  audioCtx = null; analyser = null; micSource = null;
}

/* ---------- Speech recognition ---------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let sessionActive = false;
let micStream = null;

function buildRecognition(){
  const r = new SR();
  r.lang = 'en-US';
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 1;
  return r;
}

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
  recognition = buildRecognition();
  let lastInterim = '';

  recognition.onstart = () => setState('listening');

  recognition.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++){
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t; else interim += t;
    }
    if (interim.trim()) lastInterim = interim;
    captionEl.textContent = final || interim;
    if (final.trim()){
      recognition.stop();
      handleUserUtterance(final.trim());
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
      captionEl.textContent = `(mic hiccup: ${e.error}, retrying…)`;
    }
    // Only auto-restart if we're still meant to be listening (avoid
    // interfering with the thinking/speaking states triggered elsewhere).
    if (sessionActive && vizState === 'listening') listen();
  };

  recognition.onend = () => {
    if (!sessionActive || vizState !== 'listening') return;
    // Chrome on Android sometimes ends recognition without ever marking
    // a result as final. If we captured interim speech, use it instead
    // of silently restarting forever.
    if (lastInterim.trim()){
      const text = lastInterim.trim();
      lastInterim = '';
      handleUserUtterance(text);
    } else {
      listen();
    }
  };

  try{ recognition.start(); }catch(e){ /* already started, ignore */ }
}

async function handleUserUtterance(text){
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
  const messages = [{ role: 'system', content: systemPrompt() }, ...history.slice(-16)];

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${store.key}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 150,
      temperature: 0.8,
    }),
  });

  if (!res.ok){
    if (res.status === 401) throw new Error('Invalid API key');
    if (res.status === 429) throw new Error('Rate limit reached, wait a moment');
    throw new Error('Groq error ' + res.status);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
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
  captionEl.textContent = text;
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
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });
    await startMicAnalyser(micStream);
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
  stopMicAnalyser();
  if (micStream) micStream.getTracks().forEach(t => t.stop());
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
