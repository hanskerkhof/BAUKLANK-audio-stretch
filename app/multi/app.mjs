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
// Small utilities (guards against NaN / non-finite values)
// ------------------------------------------------------------
function toFiniteNumber(value, fallback) {
    const n = (typeof value === 'number') ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
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
        blockMs: 160,
        overlap: 1.5,
        splitComputation: true
    };

    // Load persisted values (per engine)
    const controlValues = {...controlDefaults};
    if(LOAD_CONFIG_FROM_LOCAL_STORAGE) {
        for (const k of Object.keys(controlDefaults)) {
            const v = loadFromLocalStorage(engineId, k, controlDefaults[k]);
            controlValues[k] = v;
        }
    }

    const configValues = {...configDefaults};
    if(LOAD_CONFIG_FROM_LOCAL_STORAGE) {
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
        currentFileName: ''
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
    el.textContent = text;
    setBadgeState(el, state);
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
        const bits = [
            `controller ${engine.id}: ${deviceId}`,
            fw ? `fw ${fw}` : null,
            port ? `port ${port}` : null
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

    const engines = new Map();
    engines.set('A', createEngine(audioContext, mixNode, 'A', 0));
    engines.set('B', createEngine(audioContext, mixNode, 'B', 1));

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
        const loopStart = clamp(toFiniteNumber(engine.controlValues.loopStart, 0), 0, engine.audioDuration);
        const loopEnd = clamp(toFiniteNumber(engine.controlValues.loopEnd, engine.audioDuration), 0, engine.audioDuration);

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
    }

    // Apply incoming control/config updates, scoped to engine (WS/serial)
    function applyIncomingSet(engine, key, value) {
        if (!engine || !key) return;

        if (key === 'volume') {
            const n = toFiniteNumber(value, NaN);
            if (!Number.isFinite(n)) return;
            const v01 = clamp(n, 0, 100) / 100;
            engine.controlValues.volume = v01;
            controlsChanged(engine, /*scheduleAhead=*/true);
            return;
        }

        if (key === 'volumePercent') {
            const v = clamp(toFiniteNumber(value, 100), 1, 100) / 100;
            engine.controlValues.volume = v;
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
                    engine.controlValues.volume = clamp(value, 1, 100) / 100;
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

    function connectWs() {
        const url = `ws://${location.host.replace(/:\d+$/, '')}:8765`;
        updateWsStatus('ws: connecting…', 'warn');

        ws = new WebSocket(url);

        ws.onopen = () => updateWsStatus('ws: connected', 'ok');

        ws.onclose = () => {
            updateWsStatus('ws: disconnected', 'warn');
            setTimeout(connectWs, 1000);
        };

        ws.onerror = () => {
            updateWsStatus('ws: error', 'warn');
        };

        ws.onmessage = (evt) => {
            let msg;
            try {
                msg = JSON.parse(evt.data);
            } catch {
                return;
            }

            if (msg.type === 'serverVersion' && typeof msg.version === 'string') {
                updateServerVersion(msg.version);
                return;
            }
            if (msg.type === 'machineStatus') {
                updateMachineStatus(msg);
                return;
            }

            if (msg.type === 'controllerStatus') {
                const engineId = (typeof msg.engine === 'string' && engines.has(msg.engine)) ? msg.engine : 'A';
                updateControllerStatus(engines.get(engineId), msg);
                return;
            }

            if (msg.type === 'set') {
                const engineId = (typeof msg.engine === 'string' && engines.has(msg.engine)) ? msg.engine : 'A';
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

