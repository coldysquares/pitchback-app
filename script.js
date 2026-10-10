'use strict';

// Pitchback v1.1. User-controlled reference, capture, and feedback. Everything stays on the device.
const $ = id => document.getElementById(id);
const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const RANGE_NOTES = {
  low: [52,55,57,59,60],    // E3 – C4
  mid: [55,57,59,60,62],    // G3 – D4
  high: [60,62,64,65,67]   // C4 – G4
};
const RANGE_DESCRIPTIONS = {
  low: 'E3–C4 · a gentler lower range.',
  mid: 'G3–D4 · clearer on phone speakers and a comfortable starting point.',
  high: 'C4–G4 · brighter, higher notes.'
};
const HISTORY_KEY = 'pitchback-v1-pitch-history';
const TARGET_NOTE_COUNT = 5;
const MAX_SING_MS = 9000;
const MIN_SING_MS = 550;
const REFERENCE_MS = 2600;
const FRAME_MS = 85;

const noteName = midi => NOTE_NAMES[((midi%12)+12)%12] + (Math.floor(midi/12)-1);
const noteHz = midi => 440 * 2 ** ((midi-69)/12);
const cents = (hz,target) => 1200 * Math.log2(hz/target);
const median = values => {
  const sorted=values.filter(Number.isFinite).slice().sort((a,b)=>a-b);
  const n=sorted.length;
  return n ? (n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2) : NaN;
};
const displayCents = value => Number.isFinite(value) ? `${Math.abs(value)<.5?'':value>0?'+':'−'}${Math.abs(value)<.5?0:Math.round(Math.abs(value))}¢` : '—';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
function shuffle(items){
  const r=items.slice();
  for(let i=r.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[r[i],r[j]]=[r[j],r[i]];}
  return r;
}

let selectedRange='mid';
let recallSeconds=null; // Manual: user decides the listening-to-recording gap.
let notes=[];
let position=0;
let results=[];
let audioContext=null;
let micStream=null;
let micSource=null;
let analyser=null;
let sampleBuffer=null;
let toneOsc=[];
let toneGain=[];
let playing=false;
let stageState='ready';
let animation=null;
let flowToken=0;
let collecting=false;
let captureStart=0;
let lastFrame=0;
let frames=[];

function show(screen){
  ['welcome','session','complete'].forEach(id=>$(id).classList.toggle('hidden',id!==screen));
  window.scrollTo({top:0,behavior:'instant'});
}
function selectedButtons(type,value){
  document.querySelectorAll(`[data-${type}]`).forEach(button=>{
    button.setAttribute('aria-pressed',String(button.dataset[type]===String(value)));
  });
}
function chooseRange(range){
  selectedRange=range;
  selectedButtons('range',range);
  $('range-desc').textContent=RANGE_DESCRIPTIONS[range];
}
document.querySelectorAll('[data-range]').forEach(button=>button.addEventListener('click',()=>chooseRange(button.dataset.range)));
$('tone-volume').addEventListener('input',()=>{$('volume-label').textContent=$('tone-volume').value+'%';});

function readHistory(){
  try { const x=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');return Array.isArray(x)?x:[]; }
  catch { return []; }
}
function saveHistory(){
  const usable=results.filter(result=>result?.ok && !result?.octaveMismatch);
  if(!usable.length) return;
  const item={
    at:new Date().toISOString(),
    range:selectedRange,
    recall:recallSeconds,
    medianAbs:median(usable.map(result=>Math.abs(result.settled))),
    notes:usable.map(result=>({midi:result.midi,landing:Math.round(result.landing),settled:Math.round(result.settled),variation:Math.round(result.variation)}))
  };
  try { const old=readHistory();old.push(item);localStorage.setItem(HISTORY_KEY,JSON.stringify(old.slice(-20))); }
  catch { /* Private browsing or storage disabled; the diagnostic still works. */ }
}
function showLastRound(){
  const last=readHistory().at(-1);
  if(!last||!Number.isFinite(last.medianAbs)){$('previous').classList.add('hidden');return;}
  $('previous').classList.remove('hidden');
  const date=new Date(last.at).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  $('previous').textContent=`Last time (${date}): median settled error ${Math.round(last.medianAbs)}¢. Results live only in this browser.`;
}
showLastRound();

async function ensureAudio(){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw new Error('Web Audio isn’t available in this browser.');
  if(!audioContext || audioContext.state==='closed')audioContext=new AC({latencyHint:'interactive'});
  await audioContext.resume();
  if(audioContext.state!=='running')throw new Error('Couldn’t start the audio engine. Tap to retry.');
}
async function ensureMicAndAudio(){
  await ensureAudio();
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone unavailable. Open the HTTPS page in Safari or Chrome, rather than a file preview.');
  if(!micStream || micStream.getTracks().some(track=>track.readyState==='ended')){
    let stream;
    try {
      stream=await navigator.mediaDevices.getUserMedia({audio:{
        echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:1}
      },video:false});
    }catch(error){
      if(error?.name==='NotAllowedError'||error?.name==='PermissionDeniedError')throw new Error('Microphone permission was declined. Allow microphone access in your browser settings, then try again.');
      if(error?.name==='NotFoundError')throw new Error('No microphone detected. Connect or enable a microphone.');
      throw new Error('Couldn’t open the microphone. Please check permissions and try again.');
    }
    micStream=stream;
    micSource=audioContext.createMediaStreamSource(stream);
    analyser=audioContext.createAnalyser();
    analyser.fftSize=8192;
    analyser.smoothingTimeConstant=0;
    micSource.connect(analyser); // Never route the microphone to speakers.
    sampleBuffer=new Float32Array(analyser.fftSize);
  }
}
function stopMic(){
  micStream?.getTracks().forEach(track=>track.stop());
  micSource?.disconnect();
  micStream=null;micSource=null;analyser=null;sampleBuffer=null;
}
function stopTone(){
  for(const osc of toneOsc){try { osc.stop(); } catch {} try { osc.disconnect(); } catch {}}
  for(const gain of toneGain){try { gain.disconnect(); } catch {}}
  toneOsc=[];toneGain=[];playing=false;
}
function cancelActive({closeMic=true}={}){\n  stopReferenceAudio();
  flowToken++;
  collecting=false;
  if(animation)cancelAnimationFrame(animation);
  animation=null;
  stopTone();
  if(closeMic)stopMic();
  $('meter').style.width='0%';
}
function playReference(hz){
  stopTone();
  const t=audioContext.currentTime;
  const volume=Number($('tone-volume').value)/100;
  // Harmonics make mid-register notes easier to hear through phone speakers
  // without changing the perceived fundamental pitch.
  for(const [multiple,level] of [[1,.32],[2,.15],[3,.07]]){
    const osc=audioContext.createOscillator();
    const gain=audioContext.createGain();
    osc.type='sine';
    osc.frequency.value=hz*multiple;
    gain.gain.setValueAtTime(.0001,t);
    gain.gain.linearRampToValueAtTime(level*volume,t+.06);
    gain.gain.setValueAtTime(level*volume,t+(REFERENCE_MS/1000)-.18);
    gain.gain.linearRampToValueAtTime(.0001,t+(REFERENCE_MS/1000));
    osc.connect(gain).connect(audioContext.destination);
    osc.start(t);
    osc.stop(t+REFERENCE_MS/1000+.02);
    toneOsc.push(osc);toneGain.push(gain);
  }
  playing=true;
}
function practiceButtons(state){
  stageState=state;
  $('practice-actions').classList.toggle('hidden',state==='result');
  $('play-tone').classList.toggle('hidden',state!=='ready'&&state!=='playing');
  $('play-tone').disabled=state==='playing';
  $('play-tone').textContent=state==='playing'?'♪ Playing tone…':'▶ Play tone';
  $('record-mine').classList.toggle('hidden',state!=='ready-to-record'&&state!=='mic-error');
  $('record-mine').textContent=state==='mic-error'?'● Try microphone again':'● Record mine';
  $('replay-tone').classList.toggle('hidden',state!=='ready-to-record'&&state!=='mic-error');
  $('stop-take').classList.toggle('hidden',state!=='recording');
}
function setStage(label,copy,symbol,state='idle'){
  $('stage').textContent=label;
  $('stage-copy').textContent=copy;
  $('disc').textContent=symbol;
  $('disc').classList.toggle('recording',state==='recording');
  $('disc').classList.toggle('countdown',state==='countdown');
}
function updateProgress(){
  $('counter').textContent=`NOTE ${position+1} OF ${TARGET_NOTE_COUNT}`;
  $('progress').innerHTML=notes.map((_,index)=>`<span class="${index<position?'done':index===position?'now':''}"></span>`).join('');
  $('target').textContent=noteName(notes[position]);
  $('freq').textContent=Math.round(noteHz(notes[position]))+' Hz';
  $('result').classList.add('hidden');
  $('meter').style.width='0%';
  $('live-msg').textContent='No live pitch indicator while you sing.';
}

// Lightweight YIN difference detector. A low RMS or high difference score
// produces "no pitch" rather than an invented note. Guitar/chords are not supported.
function detectPitch(wave,sr){
  let energy=0;
  for(let i=0;i<wave.length;i++)energy+=wave[i]*wave[i];
  const rms=Math.sqrt(energy/wave.length);
  if(rms<.004)return {hz:null,rms,confidence:0};
  const stride=Math.max(1,Math.round(sr/11025));
  const length=Math.floor(wave.length/stride);
  const data=new Float32Array(length);
  let mean=0;
  for(let i=0;i<length;i++){data[i]=wave[i*stride];mean+=data[i];}
  mean/=length;
  for(let i=0;i<length;i++)data[i]-=mean;
  const rate=sr/stride;
  const minLag=Math.max(2,Math.floor(rate/900));
  const maxLag=Math.min(Math.floor(rate/72),Math.floor(length/3));
  const span=Math.min(length-maxLag,1400);
  const normalized=new Float32Array(maxLag+1);
  let running=0, best=Infinity,selected=-1;
  for(let lag=1;lag<=maxLag;lag++){
    let diff=0;
    for(let i=0;i<span;i++){const error=data[i]-data[i+lag];diff+=error*error;}
    running+=diff;
    normalized[lag]=running>0 ? diff*lag/running : 1;
    if(lag>=minLag&&normalized[lag]<best){best=normalized[lag];selected=lag;}
  }
  if(selected<0||best>.24)return {hz:null,rms,confidence:0};
  // Prefer the first well-defined period; this helps avoid octave errors.
  for(let lag=minLag;lag<maxLag-1;lag++){
    if(normalized[lag]<.13){
      while(lag+1<maxLag && normalized[lag+1]<normalized[lag])lag++;
      selected=lag;best=normalized[lag];break;
    }
  }
  let refined=selected;
  if(selected>1&&selected<maxLag){
    const a=normalized[selected-1],b=normalized[selected],c=normalized[selected+1];
    const denominator=a-2*b+c;
    if(Math.abs(denominator)>1e-7)refined+=Math.max(-1,Math.min(1,.5*(a-c)/denominator));
  }
  const hz=rate/refined;
  return {hz:hz>72&&hz<900?hz:null,rms,confidence:1-best};
}

function prepareCurrentNote(){
  cancelActive();
  updateProgress();
  practiceButtons('ready');
  setStage('Ready when you are','Tap Play tone. Listen as many times as you need.','♪');
  $('live-msg').textContent='Your recording starts only when you tap Record mine.';
}
// Use a real media element for reference playback. iOS Safari can leave Web Audio
// silent after an asynchronous AudioContext.resume() gesture boundary.
let referenceAudio=null;
function makeReferenceWav(hz, volume){
  const rate=22050, seconds=REFERENCE_MS/1000, n=Math.ceil(rate*seconds);
  const bytes=new ArrayBuffer(44+n*2), view=new DataView(bytes);
  const word=(at,v)=>view.setUint16(at,v,true), dword=(at,v)=>view.setUint32(at,v,true);
  for(let i=0;i<4;i++)view.setUint8(i,"RIFF".charCodeAt(i));
  dword(4,36+n*2);
  for(let i=0;i<4;i++)view.setUint8(8+i,"WAVE".charCodeAt(i));
  for(let i=0;i<4;i++)view.setUint8(12+i,"fmt ".charCodeAt(i));
  dword(16,16);word(20,1);word(22,1);dword(24,rate);dword(28,rate*2);word(32,2);word(34,16);
  for(let i=0;i<4;i++)view.setUint8(36+i,"data".charCodeAt(i));
  dword(40,n*2);
  for(let i=0;i<n;i++){
    const t=i/rate;
    const env=Math.min(1,t/.045,(seconds-t)/.14);
    const sample=(.62*Math.sin(2*Math.PI*hz*t)+.27*Math.sin(2*Math.PI*hz*2*t)+.11*Math.sin(2*Math.PI*hz*3*t))*Math.max(0,env)*volume*.9;
    view.setInt16(44+i*2,Math.max(-32767,Math.min(32767,Math.round(sample*32767))),true);
  }
  return URL.createObjectURL(new Blob([bytes],{type:"audio/wav"}));
}
function stopReferenceAudio(){
  if(referenceAudio){
    referenceAudio.audio.pause();
    referenceAudio.audio.removeAttribute("src");
    referenceAudio.audio.load();
    URL.revokeObjectURL(referenceAudio.url);
    referenceAudio=null;
  }
}
async function playCurrentTone(){
  if(!['ready','ready-to-record','mic-error'].includes(stageState))return;
  cancelActive({closeMic:false});
  stopReferenceAudio();
  const token=flowToken;
  practiceButtons('playing');
  $('result').classList.add('hidden');
  setStage('Listen','Playing your reference note…','♫');
  $('live-msg').textContent='The note should be audible now. Use the phone volume buttons if needed.';
  const url=makeReferenceWav(noteHz(notes[position]),Number($('tone-volume').value)/100);
  const audio=new Audio();
  audio.preload='auto';
  audio.src=url;
  referenceAudio={audio,url};
  // Critical: start playback immediately within the actual tap, before any await.
  let playback;
  try { playback=audio.play(); }
  catch(error){ playback=Promise.reject(error); }
  try { await playback; }
  catch(error){
    if(token!==flowToken)return;
    stopReferenceAudio();
    practiceButtons('ready');
    setStage('Sound unavailable','Safari blocked playback. Tap Play tone again.','!');
    $('live-msg').textContent=String(error?.message||'Audio playback was blocked.');
    return;
  }
  await pause(REFERENCE_MS+125);
  if(token!==flowToken)return;
  stopReferenceAudio();
  practiceButtons('ready-to-record');
  setStage('Your turn','Remember the note. Tap Record mine whenever you’re ready.','●');
  $('live-msg').textContent='Replay the tone if needed. You control when recording begins.';
}
async function startRecording(){
  if(!['ready-to-record','mic-error'].includes(stageState))return;
  practiceButtons('opening-mic');
  setStage('Microphone','Allow microphone access if your phone asks.','●');
  $('live-msg').textContent='Waiting for microphone…';
  const token=flowToken;
  try { await ensureMicAndAudio(); }
  catch(error){
    if(token!==flowToken){stopMic();return;}
    renderUnavailable(error.message);
    return;
  }
  if(token!==flowToken){stopMic();return;}
  frames=[];
  captureStart=performance.now();
  lastFrame=0;
  collecting=true;
  practiceButtons('recording');
  setStage('Recording','Sing and hold the note, then tap Stop & see result.','●','recording');
  $('live-msg').textContent='Only pitch estimates are used. Stops automatically after 9 seconds.';
  animation=requestAnimationFrame(readMicrophoneFrame);
}
function stopRecording(){
  if(stageState!=='recording'||!collecting)return;
  if(performance.now()-captureStart<MIN_SING_MS){$('live-msg').textContent='Hold the note a little longer, then stop.';return;}
  if(animation)cancelAnimationFrame(animation);
  animation=null;
  collecting=false;
  finishTake();
}
function readMicrophoneFrame(now){
  if(!collecting)return;
  const elapsed=now-captureStart;
  $('meter').style.width=Math.min(100,elapsed/MAX_SING_MS*100)+'%';
  if(now-lastFrame>=FRAME_MS && analyser){
    lastFrame=now;
    analyser.getFloatTimeDomainData(sampleBuffer);
    const estimate=detectPitch(sampleBuffer,audioContext.sampleRate);
    if(estimate.hz && estimate.confidence>.76){
      const deviation=cents(estimate.hz,noteHz(notes[position]));
      if(Number.isFinite(deviation)&&Math.abs(deviation)<1700){
        frames.push({t:elapsed/1000,c:deviation,confidence:estimate.confidence});
      }
    }
  }
  if(elapsed<MAX_SING_MS){animation=requestAnimationFrame(readMicrophoneFrame);}
  else {collecting=false;animation=null;finishTake();}
}
function analyzeTake(){
  // Reject isolated pitch estimates distant from the typical voiced segment,
  // while leaving intentional slides and vibrato available in the visible trace.
  if(frames.length<5)return {ok:false,midi:notes[position],reason:'not-enough',samples:frames};
  const centerAll=median(frames.map(frame=>frame.c));
  const filtered=frames.filter(frame=>Math.abs(frame.c-centerAll)<=310);
  if(filtered.length<5)return {ok:false,midi:notes[position],reason:'unstable',samples:frames};
  const start=filtered.slice(0,Math.min(4,filtered.length));
  const late=filtered.slice(Math.floor(filtered.length*.45));
  const settled=median(late.map(frame=>frame.c));
  const landing=median(start.map(frame=>frame.c));
  const variation=median(late.map(frame=>Math.abs(frame.c-settled)))*1.4826;
  const octaveMismatch=Math.abs(settled)>700;
  return {ok:true,midi:notes[position],landing,settled,variation,samples:filtered,octaveMismatch};
}
function finishTake(){
  stopMic();
  $('meter').style.width=Math.min(100,Math.max(0,(performance.now()-captureStart)/MAX_SING_MS*100))+'%';
  practiceButtons('result');
  setStage('Complete','Here’s where you landed.','✓');
  results[position]=analyzeTake();
  renderResult(results[position]);
}
function renderUnavailable(message){
  stopMic();
  setStage('Microphone unavailable','Give Pitchback microphone access, then try again.','!');
  practiceButtons('mic-error');
  $('result').classList.remove('hidden');
  $('result-title').textContent='Couldn’t hear you';
  $('result-description').textContent=message;
  $('metrics').classList.add('hidden');
  $('chartbox').classList.add('hidden');
  $('result-tip').textContent='On iPhone, open this HTTPS link in Safari. Check Safari microphone permissions if access was declined. You can replay the tone and retry the microphone.';
  $('retry').textContent='Try from the beginning';
  $('next').classList.add('hidden');
}
function renderResult(result){
  $('result').classList.remove('hidden');
  $('retry').textContent='Try again';
  $('next').classList.remove('hidden');
  $('next').textContent=position===notes.length-1?'See my baseline →':'Next note →';
  $('metrics').classList.toggle('hidden',!result.ok);
  $('chartbox').classList.toggle('hidden',!result.ok||result.octaveMismatch);
  if(!result.ok){
    $('result-title').textContent='Not enough clear pitch';
    $('result-description').textContent='The microphone couldn’t confidently identify your held note.';
    $('result-tip').textContent='Try a gentle, steady “ah” closer to your phone, without guitar or background music. You can also skip this note.';
    $('next').textContent=position===notes.length-1?'Finish session →':'Skip this note →';
    return;
  }
  $('m-first').textContent=displayCents(result.landing);
  $('m-center').textContent=displayCents(result.settled);
  $('m-spread').textContent='±'+Math.round(result.variation)+'¢';
  if(result.octaveMismatch){
    const direction=result.settled<0?'below':'above';
    $('result-title').textContent='Different octave';
    $('result-description').textContent=`Your sung note landed about an octave ${direction} the target.`;
    $('result-tip').textContent='Try again, or change to a more comfortable range. These notes are excluded from the accuracy median.';
  }else{
    const off=Math.abs(result.settled);
    $('result-title').textContent=off<=20?'Very close.':off<=45?'In the neighborhood.':'A little room to calibrate.';
    $('result-description').textContent=off<.5?'Your settled pitch was right on the target.':`Your settled pitch was about ${Math.round(off)} cents ${result.settled<0?'flat':'sharp'}.`;
    $('result-tip').textContent='First landing = your earliest clear pitch. Settled = later part of the note. Variation = how much that later pitch moved. A cent is 1/100 of a semitone.';
    requestAnimationFrame(()=>drawTrace(result.samples));
  }
}
function drawTrace(samples){
  const canvas=$('chart'),ctx=canvas.getContext('2d');
  const w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#f8f6f8';ctx.fillRect(0,0,w,h);
  const lo=-150,hi=150;
  const x=val=>42+(val-lo)/(hi-lo)*(w-84);
  const lastTime=Math.max(1,samples.at(-1)?.t||1);
  const y=seconds=>h-27-(seconds/lastTime)*(h-53);
  for(const v of [-150,-100,-50,0,50,100,150]){
    ctx.strokeStyle=v===0?'#56548c':'#e5dfe9';ctx.lineWidth=v===0?3:1;
    ctx.beginPath();ctx.moveTo(x(v),10);ctx.lineTo(x(v),h-25);ctx.stroke();
    if(Math.abs(v)!==150){ctx.fillStyle='#766b7b';ctx.font='17px system-ui';ctx.textAlign='center';ctx.fillText(v>0?'+'+v:String(v),x(v),h-5);}
  }
  // Don't connect unvoiced gaps: a pause is not a pitch slide.
  ctx.lineWidth=4;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#52746e';
  let last=null,hadLine=false;
  for(const point of samples){
    const px=x(Math.min(hi,Math.max(lo,point.c))),py=y(point.t);
    if(!last || point.t-last.t>.25){
      if(hadLine)ctx.stroke();
      ctx.beginPath();ctx.moveTo(px,py);hadLine=false;
    }else{ctx.lineTo(px,py);hadLine=true;}
    last=point;
  }
  if(hadLine)ctx.stroke();
  for(const p of samples){
    ctx.fillStyle='#52746e';ctx.beginPath();ctx.arc(x(Math.min(hi,Math.max(lo,p.c))),y(p.t),2.6,0,Math.PI*2);ctx.fill();
  }
}
function renderSummary(){
  cancelActive();
  const measurable=results.filter(result=>result?.ok&&!result?.octaveMismatch);
  const medianAbs=median(measurable.map(result=>Math.abs(result.settled)));
  const directional=median(measurable.map(result=>result.settled));
  $('overall').textContent=Number.isFinite(medianAbs)?Math.round(medianAbs)+'¢':'—';
  $('overall-comment').textContent=Number.isFinite(medianAbs)
    ?`${measurable.length} of ${notes.length} notes measured. Your typical settled pitch was ${Math.abs(directional)<=5?'near the target':directional<0?'slightly flat':'slightly sharp'}. This is a reference point, not a grade.`
    :'No reliable notes measured. Try another range or a quieter spot.';
  $('summary-list').replaceChildren();
  for(const result of results){
    const row=document.createElement('div');row.className='summary-row';
    const name=document.createElement('strong');name.textContent=noteName(result?.midi??0);
    const track=document.createElement('div');track.className='mini-track';
    const bar=document.createElement('span');
    if(result?.ok&&!result.octaveMismatch){bar.style.width=`${Math.max(4,100-Math.abs(result.settled)/2)}%`;}
    else bar.style.width='0%';
    track.append(bar);
    const score=document.createElement('b');score.textContent=result?.ok?(result.octaveMismatch?'Octave':displayCents(result.settled)):'Skipped';
    row.append(name,track,score);
    $('summary-list').append(row);
  }
  saveHistory();show('complete');
}
function startSession({sameNotes=false}={}){
  cancelActive();
  if(!sameNotes||notes.length!==5)notes=shuffle(RANGE_NOTES[selectedRange]);
  position=0;results=new Array(notes.length);
  show('session');prepareCurrentNote();
}
function pauseForBackground(){
  const sessionIsVisible=!$('session').classList.contains('hidden');
  if(!sessionIsVisible)return;
  cancelActive();
  practiceButtons('result');
  setStage('Paused','You switched away. The microphone is off.','Ⅱ');
  $('result').classList.remove('hidden');
  $('result-title').textContent='Session paused';
  $('result-description').textContent='Your completed notes are still here.';
  $('metrics').classList.add('hidden');$('chartbox').classList.add('hidden');
  $('result-tip').textContent='Tap resume when you’re ready.';
  $('retry').textContent='Start this note again';
  $('next').classList.add('hidden');
}
$('start').addEventListener('click',()=>startSession());
$('retry').addEventListener('click',prepareCurrentNote);
$('play-tone').addEventListener('click',playCurrentTone);
$('replay-tone').addEventListener('click',playCurrentTone);
$('record-mine').addEventListener('click',startRecording);
$('stop-take').addEventListener('click',stopRecording);
$('next').addEventListener('click',()=>{if(position===notes.length-1)renderSummary();else{position++;prepareCurrentNote();}});
$('again').addEventListener('click',()=>startSession());
$('repeat').addEventListener('click',()=>startSession({sameNotes:true}));
$('change-range').addEventListener('click',()=>{cancelActive();showLastRound();show('welcome');});
$('quit').addEventListener('click',()=>{cancelActive();showLastRound();show('welcome');});
$('clear-history').addEventListener('click',()=>{
  try {localStorage.removeItem(HISTORY_KEY);}catch{}
  $('clear-history').textContent='Saved history cleared';
  showLastRound();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden && !$('session').classList.contains('hidden'))pauseForBackground();});
window.addEventListener('pagehide',()=>cancelActive());
