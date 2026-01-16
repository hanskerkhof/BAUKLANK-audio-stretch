import SignalsmithStretch from "./SignalsmithStretch.mjs";

let $ = document.querySelector.bind(document);
let $$ = document.querySelectorAll.bind(document);

// ------------------------------------------------------------
// Default audio configuration (per engine)
// ------------------------------------------------------------

const DEFAULT_AUDIO_BY_ENGINE = {
    A: 'Black Hole Sun - Soundgarden.mp3',
    // B: 'Associations2.mp3',
    B: 'Black Hole Sun - Soundgarden.mp3',
};

function getDefaultAudioUrl(engineId) {
    const filename = DEFAULT_AUDIO_BY_ENGINE[engineId];
    if (!filename) {
        throw new Error(`No default audio configured for engine ${engineId}`);
    }
    return `./${filename}`;
}

// ------------------------------------------------------------
// Engine slot selection (default: 2 engines)
// ------------------------------------------------------------
//
// Supported URL params:
//   ?engines=2                (default)
//   ?engines=1&slot=A
//   ?engines=1&slot=B
//
// Preferred source: window.BAUKLANK_BOOT (set by index.html boot script).
function getRequestedEngineSlots() {
    // 1) Preferred: provided by index.html boot script
    if (window.BAUKLANK_BOOT && Array.isArray(window.BAUKLANK_BOOT.engineSlots)) {
        const slots = window.BAUKLANK_BOOT.engineSlots
            .map(s => String(s).toUpperCase())
            .filter(s => s === 'A' || s === 'B');
        if (slots.length) return slots;
    }

    // 2) Fallback: parse URL directly
    const p = new URLSearchParams(location.search);
    const enginesParam = p.get('engines');
    const slotParam = (p.get('slot') || 'A').toUpperCase();

    if (enginesParam === '1') {
        return [(slotParam === 'B') ? 'B' : 'A'];
    }
    return ['A', 'B']; // ✅ default = 2 engines
}


// ------------------------------------------------------------
// Small utilities (guards against NaN / non-finite values)
// ------------------------------------------------------------
function toFiniteNumber(value, fallback) {
    const n = (typeof value === 'number') ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function setVolumeFromPercent(engine, value, fallback = 100) {
    const v = clamp(toFiniteNumber(value, fallback), 0, 100) / 100;
    engine.controlValues.volume = v;
}

function setVolumeNormalized(engine, value) {
    const n = toFiniteNumber(value, NaN);
    if (!Number.isFinite(n)) return false;
    const normalized = (n <= 1 && n >= 0) ? n : (n / 100);
    engine.controlValues.volume = clamp(normalized, 0, 1);
    return true;
}

// ------------------------------------------------------------
// LocalStorage helpers (scoped per engine)
// ------------------------------------------------------------
function storageKey(engineId, key) {
    return `stretch:${engineId}:${key}`;
}

function loadFromLocalStorage(engineId, key, fallback) {
    try {
        const raw = localStorage.getItem(storageKey(engineId, key));
        if (raw === null || raw === undefined) return fallback;
        const parsed = JSON.parse(raw);
        return (parsed === null || parsed === undefined) ? fallback : parsed;
    } catch {
        return fallback;
    }
}

// HK - Temp out-commeted to check if i can lower cpu
// function setLocalStorageIfChanged(engineId, key, value, opts = {}) {
//     const decimals = Number.isFinite(opts.decimals) ? opts.decimals : null;
//     let v = value;
//     if (typeof v === 'number' && Number.isFinite(v) && decimals !== null) {
//         const f = Math.pow(10, decimals);
//         v = Math.round(v * f) / f;
//     }
//     const sk = storageKey(engineId, key);
//     const prev = localStorage.getItem(sk);
//     const next = JSON.stringify(v);
//     if (prev !== next) localStorage.setItem(sk, next);
// }

// ------------------------------------------------------------
// Engine factory (A/B now, N later)
// ------------------------------------------------------------
function createEngine(audioContext, mixNode, engineId, outputIndex) {

    const LOAD_CONFIG_FROM_LOCAL_STORAGE = false;

    const controlDefaults = {
        // UI alias: volumePercent maps to controlValues.volume
        volume: .10,
        pan: (engineId === 'A' ? -1 : (engineId === 'B' ? 1 : 0)),
        // pan in [-1..1], applied via L/R gains into ChannelMerger
        active: true,

        rate: 0.001,
        semitones: 0,
        tonalityHz: 16000,
        formantSemitones: 0,
        formantCompensation: false,
        formantBaseHz: 200,

        loopStart: 1,
        loopEnd: 1
    };

    const configDefaults = {
        // blockMs: 160,
        // overlap: 1.5,
        blockMs: 200,
        overlap: 1.0,       // <-- big win in cpu
        splitComputation: true
    };

    // Load persisted values (per engine)
    const controlValues = {...controlDefaults};
    if (LOAD_CONFIG_FROM_LOCAL_STORAGE) {
        for (const k of Object.keys(controlDefaults)) {
            const v = loadFromLocalStorage(engineId, k, controlDefaults[k]);
            controlValues[k] = v;
        }
    }

    const configValues = {...configDefaults};
    if (LOAD_CONFIG_FROM_LOCAL_STORAGE) {
        for (const k of Object.keys(configDefaults)) {
            const v = loadFromLocalStorage(engineId, k, configDefaults[k]);
            configValues[k] = v;
        }
    }

    const gain = audioContext.createGain();
    gain.gain.value = clamp(toFiniteNumber(controlValues.volume, 1), 0, 1);

    // Pan routing into the stereo mix (ChannelMerger)
    const panLeftGain = audioContext.createGain();
    const panRightGain = audioContext.createGain();

    // Gain feeds both pan branches
    gain.connect(panLeftGain);
    gain.connect(panRightGain);

    // Route to stereo outputs
    panLeftGain.connect(mixNode, 0, 0);   // Left
    panRightGain.connect(mixNode, 0, 1);  // Right

    return {
        id: engineId,
        outputIndex,

        // audio / dsp
        stretch: null,
        audioDuration: 1,
        gain,
        panLeftGain,
        panRightGain,

        // state
        controlDefaults,
        configDefaults,
        controlValues,
        configValues,

        // ui (wired later)
        ui: {
            playstop: null,
            playback: null,
            upload: null,
            uploadFile: null,
            controlsRoot: null,
            controllerStatus: null,
            filename: null
        },

        // ui state
        currentFileName: '',
        lastUiPaintMs: 0
    };
}

// ------------------------------------------------------------
// WebSocket (engine-targeted messages)
// ------------------------------------------------------------
function setBadgeState(selectorOrEl, state) {
    const el = (typeof selectorOrEl === 'string') ? $(selectorOrEl) : selectorOrEl;
    if (!el) return;
    el.dataset.state = state;
}

function updateWsStatus(text, state) {
    const el = $('#ws-status');
    if (!el) return;

    const textEl = el.querySelector('.ws-text');
    if (textEl) textEl.textContent = text;
    else el.textContent = text;

    setBadgeState(el, state);
}


// function updateWsStatus(text, state) {
//     const el = $('#ws-status');
//     if (!el) return;
//
//     const textEl = el.querySelector('.ws-text');
//     if (textEl) textEl.textContent = text;
//     else el.textContent = text;
//
//     setBadgeState(el, state);
// }

function pulseWsActivity() {
    const el = $('#ws-status');
    if (!el) return;

    // Restart animation even if messages arrive fast
    el.classList.remove('ws-pulse');
    void el.offsetWidth; // force reflow
    el.classList.add('ws-pulse');

    window.clearTimeout(pulseWsActivity._t);
    pulseWsActivity._t = window.setTimeout(() => {
        el.classList.remove('ws-pulse');
    }, 260);
}

function updateWsRateText(text) {
    const el = $('#ws-status');
    if (!el) return;
    const rateEl = el.querySelector('.ws-rate');
    if (!rateEl) return;
    rateEl.textContent = text;
}

function updateServerVersion(version) {
    const el = $('#server-version');
    if (!el) return;
    el.textContent = `server: v${version}`;
    setBadgeState(el, 'ok');
}

function updateMachineStatus(msg) {
    const el = $('#machine-status');
    if (!el) return;

    const hostname = (typeof msg.hostname === 'string' && msg.hostname.length) ? msg.hostname : '?';
    const ip = (typeof msg.ip === 'string' && msg.ip.length) ? msg.ip : '?';
    const platform = (typeof msg.platform === 'string' && msg.platform.length) ? msg.platform : '';
    const arch = (typeof msg.arch === 'string' && msg.arch.length) ? msg.arch : '';

    const parts = [`machine: ${hostname}`, ip !== '?' ? ip : null, platform || null, arch || null].filter(Boolean);
    el.textContent = parts.join(' · ');
    setBadgeState(el, 'idle');
}

function updateControllerStatus(engine, msg) {
    const el = engine.ui.controllerStatus;
    if (!el) return;

    if (msg && msg.connected === true) {
        const deviceId = (typeof msg.deviceId === 'string' && msg.deviceId.length) ? msg.deviceId : 'controller';
        const fw = (typeof msg.fw === 'string' && msg.fw.length) ? msg.fw : '';
        const port = (typeof msg.port === 'string' && msg.port.length) ? msg.port : '';

        // Encoder traffic/deviceId info (from controllerStatus.encoders.channels[A|B])
        const enc = (msg.encoders && msg.encoders.channels && msg.encoders.channels[engine.id]) ? msg.encoders.channels[engine.id] : null;
        const encOnline = !!(enc && enc.online === true);
        const encAgeMs = (enc && Number.isFinite(enc.ageMs)) ? Math.max(0, Math.floor(enc.ageMs)) : null;
        const encAgeStr = (encAgeMs === null) ? '—' : `${encAgeMs}ms`;
        // Prefer new name: deviceId. Fallback to legacy: fixture (for older servers during rollout).
        const encDeviceId = (enc && typeof enc.deviceId === 'string' && enc.deviceId.length) ? enc.deviceId : null;
        const encFixtureLegacy = (enc && typeof enc.fixture === 'string' && enc.fixture.length) ? enc.fixture : null;
        const encLabel = (encDeviceId || encFixtureLegacy) ? `${encDeviceId || encFixtureLegacy}` : `encoder ${engine.id}`;
        const encBits = `${encLabel}: ${encOnline ? 'ON' : 'OFF'} · age ${encAgeStr}`;

        const bits = [
            `controller ${engine.id}: ${deviceId}`,
            fw ? `fw ${fw}` : null,
            port ? `port ${port}` : null,
            encBits,
        ].filter(Boolean);

        el.textContent = bits.join(' · ');
        setBadgeState(el, 'ok');
    } else {
        el.textContent = `controller ${engine.id}: disconnected`;
        setBadgeState(el, 'warn');
    }
}

// ------------------------------------------------------------
// Filename / status UI helpers (IMPORTANT FIX)
// ------------------------------------------------------------

// Only paints the UI text. Does NOT touch engine.currentFileName.
function setFilenameText(engine, text) {
    const el = engine.ui.filename;
    if (!el) return;
    el.textContent = text;
}

// Sets the loaded filename AND paints it.
function setLoadedFilename(engine, name) {
    const safe = (typeof name === 'string' && name.length) ? name : 'no audio loaded';
    engine.currentFileName = safe;
    setFilenameText(engine, safe);
}

function showProcessing(engine, label = 'processing audio…') {
    engine._processing = true;
    setFilenameText(engine, label);
}

function hideProcessing(engine) {
    engine._processing = false;
    setFilenameText(engine, engine.currentFileName || 'audio loaded');
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
(async function main() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Mix: route A->L (0), B->R (1). Future channels: increase merger inputs.
    const mixNode = audioContext.createChannelMerger(2);
    mixNode.connect(audioContext.destination);

    const requestedSlots = getRequestedEngineSlots();
    const defaultEngineId = requestedSlots[0] || 'A';

    const engines = new Map();
    if (requestedSlots.includes('A')) engines.set('A', createEngine(audioContext, mixNode, 'A', 0));
    if (requestedSlots.includes('B')) engines.set('B', createEngine(audioContext, mixNode, 'B', 1));

    // ------------------------------------------------------------
    // File handling (per engine)
    // ------------------------------------------------------------
    function handleFile(engine, file) {
        return new Promise((pass, fail) => {
            const reader = new FileReader();
            reader.onload = () => pass(handleArrayBuffer(engine, reader.result));
            reader.onerror = fail;
            reader.readAsArrayBuffer(file);
        });
    }

    async function handleArrayBuffer(engine, arrayBuffer) {
        showProcessing(engine);

        try {
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            engine.audioDuration = audioBuffer.duration;

            const channelBuffers = [];
            for (let c = 0; c < audioBuffer.numberOfChannels; ++c) {
                channelBuffers.push(audioBuffer.getChannelData(c));
            }

            if (engine.stretch) {
                engine.stretch.stop();
                engine.stretch.disconnect();
            }

            engine.stretch = await SignalsmithStretch(audioContext);
            engine.stretch.connect(engine.gain);

            await engine.stretch.addBuffers(channelBuffers);

            engine.controlValues.loopEnd = engine.audioDuration;
            configChanged(engine);
            controlsChanged(engine);

        } finally {
            // ALWAYS clear processing state, restoring the stored filename
            hideProcessing(engine);
        }
    }

    // ------------------------------------------------------------
    // Config + controls application (per engine)
    // ------------------------------------------------------------
    function configChanged(engine) {
        // Persist config values
// HK - Temp out-commeted to check if i can lower cpu
        // for (const [k, v] of Object.entries(engine.configValues)) {
        //     setLocalStorageIfChanged(engine.id, k, v);
        // }

        if (!engine.stretch) return;

        const blockMs = clamp(toFiniteNumber(engine.configValues.blockMs, 60), 10, 500);
        const overlap = clamp(toFiniteNumber(engine.configValues.overlap, 1.5), 1, 8);
        const splitComputation = !!engine.configValues.splitComputation;

        engine.stretch.configure({
            blockMs,
            overlap,
            splitComputation
        });

        // Also reflect in UI inputs (for this engine panel)
        if (engine.ui.controlsRoot) {
            engine.ui.controlsRoot.querySelectorAll('input[data-key]').forEach(input => {
                const key = input.dataset.key;
                if (!key) return;
                if (key in engine.configValues) {
                    if (input.type === 'checkbox') input.checked = !!engine.configValues[key];
                    else input.value = String(engine.configValues[key]);
                }
            });
        }
    }

    function controlsChanged(engine, scheduleAhead, opts = {}) {
        // Persist controls (selected ones)
// HK - Temp out-commeted to check if i can lower cpu
        // setLocalStorageIfChanged(engine.id, 'volume', engine.controlValues.volume, {decimals: 4});
        // setLocalStorageIfChanged(engine.id, 'pan', engine.controlValues.pan, {decimals: 4});
        // setLocalStorageIfChanged(engine.id, 'rate', engine.controlValues.rate, {decimals: 6});
        // setLocalStorageIfChanged(engine.id, 'semitones', engine.controlValues.semitones, {decimals: 4});
        // setLocalStorageIfChanged(engine.id, 'tonalityHz', engine.controlValues.tonalityHz, {decimals: 2});
        // setLocalStorageIfChanged(engine.id, 'formantSemitones', engine.controlValues.formantSemitones, {decimals: 4});
        // setLocalStorageIfChanged(engine.id, 'formantCompensation', !!engine.controlValues.formantCompensation);
        // setLocalStorageIfChanged(engine.id, 'formantBaseHz', engine.controlValues.formantBaseHz, {decimals: 2});
        // setLocalStorageIfChanged(engine.id, 'loopStart', engine.controlValues.loopStart, {decimals: 4});
        // setLocalStorageIfChanged(engine.id, 'loopEnd', engine.controlValues.loopEnd, {decimals: 4});
        // setLocalStorageIfChanged(engine.id, 'active', !!engine.controlValues.active);

        // Update gain
        const targetVol = clamp(toFiniteNumber(engine.controlValues.volume, 1), 0, 1);
        const t = audioContext.currentTime;
        engine.gain.gain.cancelScheduledValues(t);
        engine.gain.gain.setValueAtTime(engine.gain.gain.value, t);
        engine.gain.gain.linearRampToValueAtTime(targetVol, t + 0.03);

        // Update pan (into L/R gains)
        const pan = clamp(toFiniteNumber(engine.controlValues.pan, 0), -1, 1);
        const left = (1 - pan) * 0.5;
        const right = (1 + pan) * 0.5;
        engine.panLeftGain.gain.cancelScheduledValues(t);
        engine.panRightGain.gain.cancelScheduledValues(t);
        engine.panLeftGain.gain.setValueAtTime(engine.panLeftGain.gain.value, t);
        engine.panRightGain.gain.setValueAtTime(engine.panRightGain.gain.value, t);
        engine.panLeftGain.gain.linearRampToValueAtTime(left, t + 0.03);
        engine.panRightGain.gain.linearRampToValueAtTime(right, t + 0.03);

        // Update play/stop button icon
        if (engine.ui.playstop) {
            engine.ui.playstop.innerHTML =
                (engine.controlValues.active ?
                        '<svg alt="toggle play" height="1em" width="1em" viewbox="0 0 60 60"><rect x="12" y="12" width="12" height="36"></rect><rect x="36" y="12" width="12" height="36"></rect></svg>' :
                        '<svg alt="toggle play" height="1em" width="1em" viewbox="0 0 60 60"><polygon points="15,10 50,30 15,50"></polygon></svg>'
                );
        }

        if (!engine.stretch) return;

        // Apply loop bounds
        let loopStart = clamp(toFiniteNumber(engine.controlValues.loopStart, 0), 0, engine.audioDuration);
        let loopEnd = clamp(toFiniteNumber(engine.controlValues.loopEnd, engine.audioDuration), 0, engine.audioDuration);
        if (loopStart > loopEnd) {
            [loopStart, loopEnd] = [loopEnd, loopStart];
        }

        // Apply scheduling params (rate/pitch/etc.)
        const rate = clamp(toFiniteNumber(engine.controlValues.rate, 0.001), 0.00001, 2);
        const semitones = clamp(toFiniteNumber(engine.controlValues.semitones, 0), -48, 48);
        const tonalityHz = clamp(toFiniteNumber(engine.controlValues.tonalityHz, 16000), 20, 22050);
        const formantSemitones = clamp(toFiniteNumber(engine.controlValues.formantSemitones, 0), -48, 48);
        const formantCompensation = !!engine.controlValues.formantCompensation;
        const formantBaseHz = clamp(toFiniteNumber(engine.controlValues.formantBaseHz, 200), 20, 2000);

        const seekInput = (opts && Number.isFinite(opts.input))
            ? clamp(toFiniteNumber(opts.input, 0), 0, engine.audioDuration)
            : null;

        const scheduleOffset = scheduleAhead ? 0.1 : 0.0;
        engine.stretch.schedule({
            active: !!engine.controlValues.active,
            rate: rate,
            semitones,
            tonalityHz,
            formantSemitones,
            formantCompensation,
            formantBaseHz,
            loopStart,
            loopEnd,
            ...(seekInput !== null ? {input: seekInput} : {}),
            outputTime: audioContext.currentTime + scheduleOffset
        });

        const now = performance.now();
        if (now - lastUiPaintMs > 250) {  // 4Hz UI paint max
            lastUiPaintMs = now;
            // Reflect in UI block here
            // Reflect in UI
            if (engine.ui.controlsRoot) {
                engine.ui.controlsRoot.querySelectorAll('input[data-key]').forEach(input => {
                    const key = input.dataset.key;
                    if (!key) return;

                    if (key === 'volumePercent') {
                        const v = clamp(toFiniteNumber(engine.controlValues.volume, 1), 0, 1);
                        const pct = Math.round(v * 100);
                        if (input.type === 'checkbox') return;
                        input.value = String(pct);
                        return;
                    }

                    if (key in engine.controlValues) {
                        if (input.type === 'checkbox') input.checked = !!engine.controlValues[key];
                        else input.value = String(engine.controlValues[key]);
                    }
                });
            }
        } // if (now - lastUiPaintMs > 250)
    }

    // Apply incoming control/config updates, scoped to engine (WS/serial)
    function applyIncomingSet(engine, key, value) {
        if (!engine || !key) return;

        if (key === 'volume') {
            if (!setVolumeNormalized(engine, value)) return;
            controlsChanged(engine, /*scheduleAhead=*/true);
            return;
        }

        if (key === 'volumePercent') {
            setVolumeFromPercent(engine, value, 100);
            controlsChanged(engine, /*scheduleAhead=*/true);
            return;
        }

        if (key === 'pan') {
            const n = toFiniteNumber(value, NaN);
            if (!Number.isFinite(n)) return;
            const pan = (n >= 0 && n <= 100) ? ((n / 50) - 1) : n;
            engine.controlValues.pan = clamp(pan, -1, 1);
            controlsChanged(engine, /*scheduleAhead=*/true);
            return;
        }


        // 'tone' is the hardware-controller name for semitones (pitch), in integer steps.
        // We keep the internal control key as 'semitones' (Signalsmith schedule param).
        if (key === 'tone') {
            const n = toFiniteNumber(value, NaN);
            if (!Number.isFinite(n)) return;
            const st = Math.round(clamp(n, -24, 24));
            engine.controlValues.semitones = st;
            controlsChanged(engine, /*scheduleAhead=*/true);
            return;
        }

        // Ensure semitones stays integer-ish even if UI sends floats.
        if (key === 'semitones') {
            const n = toFiniteNumber(value, NaN);
            if (!Number.isFinite(n)) return;
            const st = Math.round(clamp(n, -48, 48));
            engine.controlValues.semitones = st;
            controlsChanged(engine, /*scheduleAhead=*/true);
            return;
        }

        if (key in engine.controlValues) {
            const current = engine.controlValues[key];
            if (typeof current === 'number') {
                const n = toFiniteNumber(value, NaN);
                if (!Number.isFinite(n)) return;
                engine.controlValues[key] = n;
            } else if (typeof current === 'boolean') {
                engine.controlValues[key] = !!value;
            } else {
                engine.controlValues[key] = value;
            }
            controlsChanged(engine, /*scheduleAhead=*/true);
            return;
        }

        if (key in engine.configValues) {
            const current = engine.configValues[key];
            if (typeof current === 'number') {
                const n = toFiniteNumber(value, NaN);
                if (!Number.isFinite(n)) return;
                engine.configValues[key] = n;
            } else if (typeof current === 'boolean') {
                engine.configValues[key] = !!value;
            } else {
                engine.configValues[key] = value;
            }
            configChanged(engine);
            return;
        }
    }

    // ------------------------------------------------------------
    // Wire up UI per engine panel
    // ------------------------------------------------------------
    function wireEngineUi(engine) {
        engine.ui.playstop = $(`#playstop-${engine.id}`);
        engine.ui.playback = $(`#playback-${engine.id}`);
        engine.ui.upload = $(`#upload-${engine.id}`);
        engine.ui.uploadFile = $(`#upload-file-${engine.id}`);
        engine.ui.controlsRoot = $(`#controls-${engine.id}`);

        // If this engine's panel was removed by index.html (single-engine mode), skip wiring.
        if (!engine.ui.controlsRoot) return;
        engine.ui.controllerStatus = $(`#controller-status-${engine.id}`);
        engine.ui.filename = $(`#filename-${engine.id}`);

        // Initial filename paint (placeholder only, doesn't matter)
        setLoadedFilename(engine, engine.currentFileName || 'no audio loaded');

        // Reset buttons
        engine.ui.controlsRoot.querySelectorAll('.reset-btn').forEach(btn => {
            btn.onclick = () => {
                const key = btn.dataset.resetKey;
                if (!key) return;

                if (key === 'volumePercent') {
                    engine.controlValues.volume = engine.controlDefaults.volume;
                    controlsChanged(engine);
                    return;
                }

                if (key in engine.controlValues) {
                    engine.controlValues[key] = engine.controlDefaults[key];
                    controlsChanged(engine);
                } else if (key in engine.configValues) {
                    engine.configValues[key] = engine.configDefaults[key];
                    configChanged(engine);
                }
            };
        });

        // Inputs
        engine.ui.controlsRoot.querySelectorAll('input').forEach(input => {
            const isCheckbox = input.type === 'checkbox';
            const key = input.dataset.key;

            input.oninput = input.onchange = () => {
                const value = isCheckbox ? input.checked : parseFloat(input.value);
                if (!isCheckbox && !Number.isFinite(value)) return;

                if (key === 'volumePercent') {
                    setVolumeFromPercent(engine, value, 100);
                    controlsChanged(engine);
                    return;
                }

                if (key in engine.controlValues) {
                    engine.controlValues[key] = isCheckbox ? !!value : value;
                    controlsChanged(engine);
                } else if (key in engine.configValues) {
                    engine.configValues[key] = isCheckbox ? !!value : value;
                    configChanged(engine);
                }
            };

            if (!isCheckbox) {
                input.ondblclick = () => {
                    if (key in engine.controlValues) {
                        engine.controlValues[key] = engine.controlDefaults[key];
                        controlsChanged(engine);
                    } else if (key in engine.configValues) {
                        engine.configValues[key] = engine.configDefaults[key];
                        configChanged(engine);
                    }
                };
            }
        });

        // Transport
        engine.ui.playstop.onclick = async () => {
            await audioContext.resume();
            engine.controlValues.active = !engine.controlValues.active;
            controlsChanged(engine);
        };

        // Upload
        engine.ui.upload.onclick = async () => {
            await audioContext.resume();
            engine.ui.uploadFile.click();
        };

        engine.ui.uploadFile.onchange = async () => {
            try {
                if (engine.stretch) engine.stretch.stop();
                const file = engine.ui.uploadFile.files && engine.ui.uploadFile.files[0];
                if (!file) return;

                // IMPORTANT: store the final filename BEFORE processing,
                // so hideProcessing() can restore it.
                setLoadedFilename(engine, file.name);

                await handleFile(engine, file);
                engine.controlValues.active = true;
                controlsChanged(engine);
            } catch (e) {
                alert(e.message || String(e));
            }
        };

        // Playback seek
        let playbackHeld = false;
        engine.ui.playback.addEventListener('pointerdown', () => playbackHeld = true);
        engine.ui.playback.addEventListener('pointerup', () => playbackHeld = false);
        engine.ui.playback.addEventListener('change', () => playbackHeld = false);

        engine.ui.playback.oninput = async () => {
            if (!engine.stretch) return;
            await audioContext.resume();

            const v = clamp(toFiniteNumber(engine.ui.playback.value, 0), 0, engine.audioDuration);
            controlsChanged(engine, /*scheduleAhead=*/true, {input: v});
        };

        const PLAYBACK_UI_HZ = 5;           // 5Hz instead of 20Hz
        const PLAYBACK_UI_MS = 1000 / PLAYBACK_UI_HZ;

        setInterval(() => {
            if (!engine.ui.playback) return;

            // max rarely changes; only update when duration changes
            const dur = engine.audioDuration || 1;
            if (engine.ui.playback.max != dur) engine.ui.playback.max = dur;

            if (!playbackHeld && engine.stretch && engine.controlValues.active) {
                engine.ui.playback.value = engine.stretch.inputTime;
            }
        }, PLAYBACK_UI_MS);

        // // keep playback slider updated
        // setInterval(() => {
        //     if (!engine.ui.playback) return;
        //     engine.ui.playback.max = engine.audioDuration;
        //     if (!playbackHeld && engine.stretch) {
        //         engine.ui.playback.value = engine.stretch.inputTime;
        //     }
        // }, 50);

        // Initial paint
        configChanged(engine);
        controlsChanged(engine);
    }

    for (const engine of engines.values()) wireEngineUi(engine);

    // ------------------------------------------------------------
    // Default audio (auto-load for BOTH engines)
    // ------------------------------------------------------------
    loadDefaultAudioIntoAllEngines().catch(err => {
        console.warn('[multi] default audio load failed:', err);
    });

    async function loadDefaultAudioIntoAllEngines() {
        for (const engine of engines.values()) {
            const url = getDefaultAudioUrl(engine.id);

            const res = await fetch(url, {cache: 'no-store'});
            if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

            const buf = await res.arrayBuffer();

            // IMPORTANT: store final filename BEFORE processing
            setLoadedFilename(engine, url.split('/').pop());

            await handleArrayBuffer(engine, buf.slice(0));
        }
    }

    // ------------------------------------------------------------
    // WebSocket hookup (single socket, messages must include engine="A"/"B")
    // ------------------------------------------------------------
    let ws;

    let wsMsgCountThisSecond = 0;
    let wsRateTimer = null;

    function stopWsRateTimer() {
        if (wsRateTimer !== null) {
            clearInterval(wsRateTimer);
            wsRateTimer = null;
        }
    }

    function startWsRateTimer() {
        if (wsRateTimer !== null) return;
        wsRateTimer = setInterval(() => {
            const n = wsMsgCountThisSecond;
            wsMsgCountThisSecond = 0;
            updateWsRateText(`${n} msg/s`);
        }, 1000);
    }


    function connectWs() {
        const protocol = (location.protocol === 'https:') ? 'wss' : 'ws';
        const url = `${protocol}://${location.host.replace(/:\d+$/, '')}:8765`;
        updateWsStatus('ws: connecting…', 'warn');
        updateWsRateText('— msg/s');

        ws = new WebSocket(url);

        ws.onopen = () => {
            updateWsStatus('ws: connected', 'ok');
            // Optional: let the server know which engine slots we are running
wsMsgCountThisSecond = 0;
updateWsRateText('0 msg/s');
startWsRateTimer();
            try {
                ws.send(JSON.stringify({type: 'hello', engineSlots: requestedSlots}));
            } catch {
            }
        };

        ws.onclose = () => {
            updateWsStatus('ws: disconnected', 'warn');
stopWsRateTimer();
wsMsgCountThisSecond = 0;
updateWsRateText('— msg/s');
            setTimeout(connectWs, 1000);
        };

        ws.onerror = () => {
            updateWsStatus('ws: error', 'warn');
        };

        ws.onmessage = (evt) => {

wsMsgCountThisSecond++;
pulseWsActivity();

            let msg;
            try {
                msg = JSON.parse(evt.data);
            } catch {
                return;
            }

            pulseWsActivity();

            if (msg.type === 'serverVersion' && typeof msg.version === 'string') {
                updateServerVersion(msg.version);
                return;
            }
            if (msg.type === 'machineStatus') {
                updateMachineStatus(msg);
                return;
            }

            if (msg.type === 'controllerStatus') {
                // controllerStatus applies to the whole controller (A+B). Update all visible engines.
                for (const [engineId, engine] of engines.entries()) {
                    updateControllerStatus(engine, msg);
                }
                return;
            }

            if (msg.type === 'set') {
                const engineId = (typeof msg.engine === 'string' && engines.has(msg.engine)) ? msg.engine : defaultEngineId;
                const engine = engines.get(engineId);
                applyIncomingSet(engine, msg.key, msg.value);
            }
        };
    }

    try {
        connectWs();
    } catch {
    }

})();
