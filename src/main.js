// src/main.js
import { VoiceEngine } from './voice/VoiceEngine.js';

// Global state
let engine = null;
let isSessionActive = false;
let currentLanguage = 'en-US';

// DOM Element References (bound synchronously on load)
const btnVerifyKeys = document.getElementById('btnVerifyKeys');
const verifyBtnText = document.getElementById('verifyBtnText');
const btnToggleSession = document.getElementById('btnToggleSession');
const sessionBtnText = document.getElementById('sessionBtnText');
const btnManualBargeIn = document.getElementById('btnManualBargeIn');
const langEnBtn = document.getElementById('langEnBtn');
const langArBtn = document.getElementById('langArBtn');

const wsStatusBadge = document.getElementById('wsStatusBadge');
const wsStatusText = document.getElementById('wsStatusText');
const ttsTierBadge = document.getElementById('ttsTierBadge');
const groqStatusBadge = document.getElementById('groqStatusBadge');
const vadStateBadge = document.getElementById('vadStateBadge');
const vadStateText = document.getElementById('vadStateText');
const sttLangBadge = document.getElementById('sttLangBadge');

// Error Banner Elements
const errorBanner = document.getElementById('errorBanner');
const errorMessage = document.getElementById('errorMessage');
const btnDismissError = document.getElementById('btnDismissError');

// Verification Checklist Elements
const verifyChecklist = document.getElementById('verifyChecklist');
const verifyTotalLatency = document.getElementById('verifyTotalLatency');
const azureVerifyBadge = document.getElementById('azureVerifyBadge');
const azureVerifyDetail = document.getElementById('azureVerifyDetail');
const groqVerifyBadge = document.getElementById('groqVerifyBadge');
const groqVerifyDetail = document.getElementById('groqVerifyDetail');

// Simulation Toolbar Buttons
const btnSimCrisis = document.getElementById('btnSimCrisis');
const btnSimBreathing = document.getElementById('btnSimBreathing');
const btnSimJitGate = document.getElementById('btnSimJitGate');
const btnSimHighArousal = document.getElementById('btnSimHighArousal');

// HUD Elements
const hudVadSilence = document.getElementById('hudVadSilence');
const hudBargeHalt = document.getElementById('hudBargeHalt');
const hudTtfa = document.getElementById('hudTtfa');
const hudWavSize = document.getElementById('hudWavSize');

// Phase 5 Pause Hold & Accumulator HUD Elements
const hudPauseText = document.getElementById('hudPauseText');
const hudPauseBar = document.getElementById('hudPauseBar');
const hudPauseClause = document.getElementById('hudPauseClause');
const hudPauseStatus = document.getElementById('hudPauseStatus');

// Phase 4 Barge-in Sensitivity & Clinical Slots
const selectBargeSensitivity = document.getElementById('selectBargeSensitivity');
const btnResetMemory = document.getElementById('btnResetMemory');
const slotPhq9 = document.getElementById('slotPhq9');
const slotGad7 = document.getElementById('slotGad7');
const slotSomatic = document.getElementById('slotSomatic');

// Phase 5 Pause Tolerance & Instant Commit
const selectPauseTolerance = document.getElementById('selectPauseTolerance');
const btnDoneSpeaking = document.getElementById('btnDoneSpeaking');

// Visualizer & Transcript Elements
const micRmsVal = document.getElementById('micRmsVal');
const canvas = document.getElementById('waveformCanvas');
const ctx = canvas.getContext('2d');
const transcriptBox = document.getElementById('transcriptBox');

// Inspector Elements
const inspectorLogs = document.getElementById('inspectorLogs');
const btnClearInspector = document.getElementById('btnClearInspector');

// Modals
const emergencyModal = document.getElementById('emergencyModal');
const emergencyMessageText = document.getElementById('emergencyMessageText');
const hotlinePrimary = document.getElementById('hotlinePrimary');
const hotlineSecondary = document.getElementById('hotlineSecondary');
const btnDismissEmergency = document.getElementById('btnDismissEmergency');

const breathingModal = document.getElementById('breathingModal');
const breathingCircle = document.getElementById('breathingCircle');
const btnDismissBreathing = document.getElementById('btnDismissBreathing');

const jitGateModal = document.getElementById('jitGateModal');
const btnDismissJitGate = document.getElementById('btnDismissJitGate');
const btnUaePassMock = document.getElementById('btnUaePassMock');

let currentRms = 0;
let animationFrameId = null;

// Helper: Show Error Banner
function showError(msg) {
  if (errorBanner && errorMessage) {
    errorMessage.textContent = msg;
    errorBanner.style.display = 'flex';
  }
  appendInspectorLog('ERROR', { message: msg });
}

function hideError() {
  if (errorBanner) {
    errorBanner.style.display = 'none';
  }
}

// Helper: Inspector Logger
function appendInspectorLog(direction, data) {
  if (!inspectorLogs) return;
  const now = new Date().toTimeString().split(' ')[0];
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  let dirClass = 'log-dir-status';
  let dirLabel = `[${direction}]`;
  if (direction === 'SEND') {
    dirClass = 'log-dir-send';
    dirLabel = '[CLIENT -> WS]';
  } else if (direction === 'RECV') {
    dirClass = 'log-dir-recv';
    dirLabel = '[WS -> CLIENT]';
  } else if (direction === 'CLICK') {
    dirClass = 'log-dir-click';
    dirLabel = '[UI CLICK]';
  } else if (direction === 'ERROR') {
    dirClass = 'log-dir-status';
    dirLabel = '[ALERT]';
  }

  const eventName = data.event || data.status || data.action || data.button || 'DATA';
  const summary = JSON.stringify(data);

  entry.innerHTML = `
    <span class="log-time">${now}</span>
    <span class="${dirClass}">${dirLabel}</span>
    <span class="log-event">${eventName}</span>
    <span class="log-payload">${summary}</span>
  `;

  inspectorLogs.appendChild(entry);
  inspectorLogs.scrollTop = inspectorLogs.scrollHeight;
}

// 60fps Visualizer Loop
function renderVisualizer() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const state = engine ? engine.state : 'IDLE';
  const freqData = engine ? engine.getFrequencyData() : new Uint8Array(64);
  const barCount = freqData.length;
  const barWidth = (width / barCount) * 0.75;
  const spacing = (width / barCount) * 0.25;

  let barColor = '#38bdf8';
  let glowColor = 'rgba(56, 189, 248, 0.4)';
  if (state === 'USER_SPEAKING') {
    barColor = '#10b981';
    glowColor = 'rgba(16, 185, 129, 0.6)';
  } else if (state === 'AGENT_SPEAKING') {
    barColor = '#06b6d4';
    glowColor = 'rgba(6, 182, 212, 0.6)';
  } else if (state === 'EMERGENCY_LOCKED') {
    barColor = '#ef4444';
    glowColor = 'rgba(239, 68, 68, 0.7)';
  }

  for (let i = 0; i < barCount; i++) {
    const val = freqData[i] / 255;
    const barHeight = Math.max(3, val * (height * 0.85) + currentRms * 30);
    const x = i * (barWidth + spacing);
    const y = (height - barHeight) / 2;

    ctx.fillStyle = barColor;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = val > 0.3 ? 8 : 0;

    ctx.fillRect(x, y, barWidth, barHeight);
  }
  ctx.shadowBlur = 0;

  animationFrameId = requestAnimationFrame(renderVisualizer);
}

// Initialize VoiceEngine
function getOrCreateEngine() {
  if (!engine) {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/ws/voice`;
    engine = new VoiceEngine({
      wsUrl: wsUrl,
      language: currentLanguage,
      bargeInSensitivity: selectBargeSensitivity ? selectBargeSensitivity.value : 'LOW',
      pauseToleranceMs: selectPauseTolerance ? parseInt(selectPauseTolerance.value, 10) : 1400,
      onPauseProgress: (remainingMs, totalMs, percent) => {
        if (hudPauseBar) {
          hudPauseBar.style.width = `${percent}%`;
        }
        if (hudPauseText) {
          if (totalMs > 0 && remainingMs > 0) {
            hudPauseText.textContent = `${Math.round(remainingMs)} ms`;
          } else {
            hudPauseText.textContent = (engine && engine.state === 'HOLDING_FOR_PAUSE') ? 'Committed' : 'Ready';
          }
        }
        if (hudPauseStatus) {
          if (remainingMs > 0) {
            hudPauseStatus.textContent = 'Holding...';
            hudPauseStatus.style.color = '#c084fc';
          } else {
            hudPauseStatus.textContent = (engine && engine.state === 'USER_SPEAKING') ? 'Speaking' : 'Listening';
            hudPauseStatus.style.color = '#34d399';
          }
        }
      },
      onSlotsUpdate: (slots) => {
        if (slotPhq9 && slots.phq9_estimate !== undefined && slots.phq9_estimate !== null) {
          slotPhq9.textContent = `${slots.phq9_estimate} / 27`;
        }
        if (slotGad7 && slots.gad7_estimate !== undefined && slots.gad7_estimate !== null) {
          slotGad7.textContent = `${slots.gad7_estimate} / 21`;
        }
        if (slotSomatic) {
          if (slots.somatic_flags && slots.somatic_flags.length > 0) {
            slotSomatic.textContent = Array.isArray(slots.somatic_flags) ? slots.somatic_flags.join(', ') : String(slots.somatic_flags);
          } else {
            slotSomatic.textContent = 'None detected yet';
          }
        }
      },
      onStateChange: (state) => {
        vadStateBadge.className = `status-pill state-${state.toLowerCase()}`;
        vadStateText.textContent = state;
        if (hudPauseStatus) {
          if (state === 'HOLDING_FOR_PAUSE') {
            hudPauseStatus.textContent = 'Pause Hold';
            hudPauseStatus.style.color = '#c084fc';
          } else if (state === 'USER_SPEAKING') {
            hudPauseStatus.textContent = 'Speaking';
            hudPauseStatus.style.color = '#10b981';
            if (hudPauseBar) hudPauseBar.style.width = '0%';
            if (hudPauseText) hudPauseText.textContent = 'Capturing';
          } else if (state === 'PROCESSING_TURN') {
            hudPauseStatus.textContent = 'Thinking';
            hudPauseStatus.style.color = '#fbbf24';
            if (hudPauseBar) hudPauseBar.style.width = '100%';
            if (hudPauseText) hudPauseText.textContent = 'Sent';
          } else if (state === 'AGENT_SPEAKING') {
            hudPauseStatus.textContent = 'Agent Speaking';
            hudPauseStatus.style.color = '#38bdf8';
            if (hudPauseBar) hudPauseBar.style.width = '0%';
            if (hudPauseText) hudPauseText.textContent = 'Playing';
          } else {
            hudPauseStatus.textContent = 'Standby';
            hudPauseStatus.style.color = '#34d399';
            if (hudPauseBar) hudPauseBar.style.width = '0%';
            if (hudPauseText) hudPauseText.textContent = 'Ready';
          }
        }
        if (state === 'EMERGENCY_LOCKED') {
          emergencyModal.style.display = 'flex';
        }
      },
      onTelemetryUpdate: (metrics) => {
        if (metrics.vadSilenceTriggerMs) hudVadSilence.textContent = `${metrics.vadSilenceTriggerMs} ms`;
        if (metrics.bargeInHaltLatencyMs !== undefined) hudBargeHalt.textContent = `${metrics.bargeInHaltLatencyMs} ms`;
        if (metrics.timeToFirstAudioMs) hudTtfa.textContent = `${metrics.timeToFirstAudioMs} ms`;
        if (metrics.lastWavPayloadSizeKB) hudWavSize.textContent = `${metrics.lastWavPayloadSizeKB} KB`;
      },
      onRmsUpdate: (rms) => {
        currentRms = rms;
        micRmsVal.textContent = `RMS: ${rms.toFixed(3)}`;
      },
      onTranscriptUpdate: ({ final, interim, combined, language, source }) => {
        transcriptBox.setAttribute('dir', language.startsWith('ar') ? 'rtl' : 'ltr');
        if (source === 'groq-whisper') {
          // Full audio verified transcript is rendered via onTranscriptFinalized
          return;
        }

        let html = '';
        if (final || interim) {
          html = `
            <div class="transcript-meta-row">
              <span class="transcript-badge-preview">&#x23F3; Live Browser Preview</span>
            </div>
            <div class="transcript-body-preview">
              <span>${final || ''}</span>
              ${interim ? `<span class="transcript-interim"> ${interim}</span>` : ''}
            </div>
          `;
        } else {
          html = `<span style="color: var(--text-muted);">${language.startsWith('ar') ? 'في انتظار التحدث...' : 'Listening for user speech...'}</span>`;
        }
        transcriptBox.innerHTML = html;
        transcriptBox.scrollTop = transcriptBox.scrollHeight;

        // Dynamic incomplete clause detection indicator
        if (hudPauseClause && engine) {
          const testText = combined || final || interim || '';
          const hasIncomplete = engine.hasIncompleteClause(testText);
          hudPauseClause.textContent = hasIncomplete ? 'Clause Ext: +600ms Active' : 'Clause Ext: Inactive';
          hudPauseClause.style.color = hasIncomplete ? '#f59e0b' : 'var(--text-muted)';
        }
      },
      onTranscriptFinalized: ({ transcript, source }) => {
        if (!transcript) return;
        transcriptBox.setAttribute('dir', currentLanguage.startsWith('ar') ? 'rtl' : 'ltr');
        const html = `
          <div class="transcript-meta-row">
            <span class="transcript-badge-verified">&#x2705; Groq Whisper Full-Audio Verified (${source || 'whisper-large-v3-turbo'})</span>
          </div>
          <div class="transcript-body-verified">
            ${transcript}
          </div>
        `;
        transcriptBox.innerHTML = html;
        transcriptBox.scrollTop = transcriptBox.scrollHeight;
        appendInspectorLog('RECV', { event: 'TRANSCRIPT_FINALIZED', transcript, source });
      },
      onServerConfig: (srvCfg) => {
        if (ttsTierBadge && srvCfg.tts_tier) {
          ttsTierBadge.textContent = `TTS: ${srvCfg.tts_tier}`;
        }
        if (groqStatusBadge) {
          groqStatusBadge.textContent = srvCfg.groq_configured ? 'Groq Whisper: Ready' : 'Groq Whisper: Standby';
        }
        if (hotlinePrimary && srvCfg.hotlines?.primary) hotlinePrimary.textContent = srvCfg.hotlines.primary;
        if (hotlineSecondary && srvCfg.hotlines?.secondary) hotlineSecondary.textContent = srvCfg.hotlines.secondary;
      },
      onServerError: (errData) => {
        showError(`Server Error (${errData.error_type || 'GENERAL'}): ${errData.message}`);
      },
      onVerifyResult: (vResult) => {
        displayVerificationChecklist(vResult);
      },
      onWsEvent: (direction, data) => {
        appendInspectorLog(direction, data);
        if (direction === 'STATUS') {
          if (data.status === 'CONNECTED') {
            wsStatusBadge.className = 'badge badge-ws-connected';
            wsStatusBadge.querySelector('.status-dot').style.background = '#10b981';
            wsStatusText.textContent = `WS: CONNECTED (${window.location.host})`;
            hideError();
          } else if (data.status === 'DISCONNECTED') {
            wsStatusBadge.className = 'badge badge-ws-disconnected';
            wsStatusBadge.querySelector('.status-dot').style.background = '#ef4444';
            wsStatusText.textContent = 'WS: DISCONNECTED (Run server)';
          }
        }
      },
      onDispatchedAction: (actionData) => {
        const type = actionData.action_type;
        if (type === 'HARD_EMERGENCY_OVERRIDE') {
          emergencyModal.style.display = 'flex';
        } else if (type === 'BREATHING_EXERCISE_478') {
          breathingModal.style.display = 'flex';
          startBreathingAnimation();
        } else if (type === 'JIT_IDENTITY_GATE') {
          jitGateModal.style.display = 'flex';
        }
      },
      onEmergencyAction: (payload) => {
        if (payload) {
          hotlinePrimary.textContent = payload.hotline_primary || '800-SAKINA (800 968)';
          hotlineSecondary.textContent = payload.hotline_secondary || 'Istijaba (800 1717)';
          const msg = currentLanguage.startsWith('ar') ? payload.message_ar : payload.message_en;
          if (msg) emergencyMessageText.textContent = msg;
        }
        emergencyModal.style.display = 'flex';
      }
    });

    // Auto-connect to WebSocket on startup
    engine.connectWebSocket();
  }
  return engine;
}

// Display Live Verification Checklist
function displayVerificationChecklist(res) {
  if (!verifyChecklist) return;
  verifyChecklist.style.display = 'flex';
  verifyTotalLatency.textContent = `Total: ${res.total_latency_ms || 0}ms`;

  // Azure Status
  if (res.azure?.status === 'PASS') {
    azureVerifyBadge.className = 'verify-status-pass';
    azureVerifyBadge.innerHTML = `&check; PASS (${res.azure.latency_ms}ms)`;
    azureVerifyDetail.textContent = `Voice: ${res.azure.voice || 'Fatima/Jenny'} | Region: ${res.azure.region || 'eastasia'}`;
  } else {
    azureVerifyBadge.className = 'verify-status-fail';
    azureVerifyBadge.innerHTML = `&#x2717; FAIL`;
    azureVerifyDetail.textContent = res.azure?.error || 'Azure Speech API key verification failed';
    showError(`Azure Speech API failed: ${res.azure?.error}`);
  }

  // Groq Status
  if (res.groq?.status === 'PASS') {
    groqVerifyBadge.className = 'verify-status-pass';
    groqVerifyBadge.innerHTML = `&check; PASS (${res.groq.latency_ms}ms)`;
    groqVerifyDetail.textContent = `Model: ${res.groq.model} | Transcription OK`;
  } else {
    groqVerifyBadge.className = 'verify-status-fail';
    groqVerifyBadge.innerHTML = `&#x2717; FAIL`;
    groqVerifyDetail.textContent = res.groq?.error || 'Groq Whisper API key verification failed';
    showError(`Groq Whisper API failed: ${res.groq?.error}`);
  }
}

// 4-7-8 Breathing Animation Controller
let breathingInterval = null;
function startBreathingAnimation() {
  if (breathingInterval) clearInterval(breathingInterval);
  let step = 0;
  const steps = [
    { text: 'Inhale (4s)', scale: 1.3, color: '#34d399' },
    { text: 'Hold (7s)', scale: 1.3, color: '#fbbf24' },
    { text: 'Exhale (8s)', scale: 0.85, color: '#38bdf8' }
  ];

  function runCycle() {
    const cur = steps[step];
    breathingCircle.textContent = cur.text;
    breathingCircle.style.transform = `scale(${cur.scale})`;
    breathingCircle.style.borderColor = cur.color;
    breathingCircle.style.color = cur.color;
    step = (step + 1) % steps.length;
  }

  runCycle();
  breathingInterval = setInterval(runCycle, 6300);
}

// =====================================================================
// SYNCHRONOUS DOM EVENT BINDING (Ensures 100% interactivity immediately)
// =====================================================================

// 1. Verify API Keys Button
if (btnVerifyKeys) {
  btnVerifyKeys.addEventListener('click', async () => {
    appendInspectorLog('CLICK', { button: 'Verify API Keys' });
    hideError();
    verifyBtnText.textContent = 'Testing Azure & Groq APIs...';
    btnVerifyKeys.disabled = true;

    try {
      // First try via HTTP endpoint (relative URL proxied by Vite)
      const response = await fetch('/api/verify-keys');
      if (response.ok) {
        const data = await response.json();
        appendInspectorLog('RECV', { event: 'VERIFY_KEYS_HTTP', ...data });
        displayVerificationChecklist(data);

        // If audio returned, play through engine
        if (data.azure?.audio_base64) {
          const eng = getOrCreateEngine();
          if (eng.gaplessQueue) {
            const buf = base64ToArrayBuffer(data.azure.audio_base64);
            await eng.gaplessQueue.enqueueAudioChunk(buf);
          }
        }
      } else {
        throw new Error(`HTTP ${response.status}: Failed to reach /api/verify-keys`);
      }
    } catch (e) {
      console.warn('[VERIFY] HTTP check failed, trying WebSocket:', e);
      // Fallback: request via WebSocket
      const eng = getOrCreateEngine();
      eng.verifyApiKeys();
    } finally {
      verifyBtnText.textContent = '🔑 Verify Azure TTS & Groq API Keys Now';
      btnVerifyKeys.disabled = false;
    }
  });
}

// 2. Start/Stop Full-Duplex Session Button
if (btnToggleSession) {
  btnToggleSession.addEventListener('click', async () => {
    appendInspectorLog('CLICK', { button: 'Toggle Session', active: isSessionActive });
    hideError();

    const eng = getOrCreateEngine();

    if (!isSessionActive) {
      try {
        btnToggleSession.disabled = true;
        sessionBtnText.textContent = 'Initializing AudioContext & VAD...';
        await eng.startSession();
        isSessionActive = true;
        btnToggleSession.disabled = false;
        btnToggleSession.className = 'btn btn-stop';
        sessionBtnText.textContent = 'Stop Full-Duplex Session';
      } catch (err) {
        console.error('Session start error:', err);
        showError(`Could not start voice session: ${err.message}. Please check microphone permissions and ensure python sandbox is running.`);
        btnToggleSession.disabled = false;
        btnToggleSession.className = 'btn btn-primary';
        sessionBtnText.textContent = 'Start Full-Duplex Session';
        isSessionActive = false;
      }
    } else {
      eng.stopSession();
      isSessionActive = false;
      btnToggleSession.className = 'btn btn-primary';
      sessionBtnText.textContent = 'Start Full-Duplex Session';
      vadStateBadge.className = 'status-pill state-idle';
      vadStateText.textContent = 'IDLE';
    }
  });
}

// 3. Instant Barge-In Button
if (btnManualBargeIn) {
  btnManualBargeIn.addEventListener('click', () => {
    appendInspectorLog('CLICK', { button: 'Manual Barge-In' });
    const eng = getOrCreateEngine();
    eng.triggerManualBargeIn();
  });
}

// 3b. Barge-In Sensitivity Selector (Phase 4 Desensitization)
if (selectBargeSensitivity) {
  selectBargeSensitivity.addEventListener('change', (e) => {
    const mode = e.target.value;
    appendInspectorLog('CLICK', { control: 'Barge-In Sensitivity', mode });
    const eng = getOrCreateEngine();
    eng.setBargeInSensitivity(mode);
  });
}

// 3c. Reset Conversation Memory Button
if (btnResetMemory) {
  btnResetMemory.addEventListener('click', () => {
    appendInspectorLog('CLICK', { button: 'Reset Conversation Memory' });
    const eng = getOrCreateEngine();
    eng.resetSessionMemory();
    if (slotPhq9) slotPhq9.textContent = '0 / 27';
    if (slotGad7) slotGad7.textContent = '0 / 21';
    if (slotSomatic) slotSomatic.textContent = 'None detected yet';
    transcriptBox.innerHTML = '<span style="color: #38bdf8; font-style: italic;">[Conversation memory reset] Ready for a new intake dialogue.</span>';
  });
}

// 3d. Phase 5 Pause Tolerance Selector
if (selectPauseTolerance) {
  selectPauseTolerance.addEventListener('change', (e) => {
    const ms = parseInt(e.target.value, 10);
    appendInspectorLog('CLICK', { control: 'Pause Tolerance', ms });
    const eng = getOrCreateEngine();
    eng.setPauseTolerance(ms);
  });
}

// 3e. Phase 5 Done Speaking (Instant Turn Commit)
if (btnDoneSpeaking) {
  btnDoneSpeaking.addEventListener('click', () => {
    appendInspectorLog('CLICK', { button: 'Done Speaking (Instant Commit)' });
    const eng = getOrCreateEngine();
    eng.commitTurnImmediately();
  });
}

// 4. Language Switcher Buttons
function switchLanguage(lang) {
  currentLanguage = lang;
  if (lang === 'en-US') {
    langEnBtn.classList.add('active');
    langArBtn.classList.remove('active');
    sttLangBadge.textContent = 'en-US';
    transcriptBox.setAttribute('dir', 'ltr');
  } else {
    langArBtn.classList.add('active');
    langEnBtn.classList.remove('active');
    sttLangBadge.textContent = 'ar-AE';
    transcriptBox.setAttribute('dir', 'rtl');
  }

  const eng = getOrCreateEngine();
  eng.setLanguage(lang);
  appendInspectorLog('STATUS', { action: 'LANGUAGE_SWITCHED', language: lang });
}

if (langEnBtn) langEnBtn.addEventListener('click', () => switchLanguage('en-US'));
if (langArBtn) langArBtn.addEventListener('click', () => switchLanguage('ar-AE'));

// 5. Person 2 Simulation Triggers
if (btnSimCrisis) {
  btnSimCrisis.addEventListener('click', () => {
    appendInspectorLog('CLICK', { simulation: 'CRISIS_OVERRIDE' });
    const eng = getOrCreateEngine();
    eng.simulatePerson2Action('CRISIS_OVERRIDE');
  });
}

if (btnSimBreathing) {
  btnSimBreathing.addEventListener('click', () => {
    appendInspectorLog('CLICK', { simulation: 'BREATHING_478' });
    const eng = getOrCreateEngine();
    eng.simulatePerson2Action('BREATHING_478');
  });
}

if (btnSimJitGate) {
  btnSimJitGate.addEventListener('click', () => {
    appendInspectorLog('CLICK', { simulation: 'JIT_IDENTITY' });
    const eng = getOrCreateEngine();
    eng.simulatePerson2Action('JIT_IDENTITY');
  });
}

if (btnSimHighArousal) {
  btnSimHighArousal.addEventListener('click', () => {
    appendInspectorLog('CLICK', { simulation: 'HIGH_AROUSAL_VOICE' });
    const eng = getOrCreateEngine();
    eng.simulatePerson2Action('HIGH_AROUSAL_VOICE');
  });
}

// 6. Dismiss Error Banner
if (btnDismissError) {
  btnDismissError.addEventListener('click', () => hideError());
}

// 7. Modal Dismissal Handlers
if (btnDismissEmergency) {
  btnDismissEmergency.addEventListener('click', () => {
    emergencyModal.style.display = 'none';
    if (engine) engine.setState('IDLE');
  });
}

if (btnDismissBreathing) {
  btnDismissBreathing.addEventListener('click', () => {
    breathingModal.style.display = 'none';
    if (breathingInterval) clearInterval(breathingInterval);
  });
}

if (btnDismissJitGate) {
  btnDismissJitGate.addEventListener('click', () => {
    jitGateModal.style.display = 'none';
  });
}

if (btnUaePassMock) {
  btnUaePassMock.addEventListener('click', () => {
    alert('UAE PASS authentication simulated successfully. Identity securely bridged to Malaffi FHIR bundle.');
    jitGateModal.style.display = 'none';
  });
}

if (btnClearInspector) {
  btnClearInspector.addEventListener('click', () => {
    inspectorLogs.innerHTML = '';
  });
}

// Kick off visualizer animation loop and initialize engine connection
renderVisualizer();
getOrCreateEngine();
appendInspectorLog('STATUS', { message: 'Prodrome Labs Diagnostic Harness UI fully bound and active.' });
