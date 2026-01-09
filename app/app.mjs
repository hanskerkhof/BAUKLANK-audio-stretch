import SignalsmithStretch from "./SignalsmithStretch.mjs";
// v2.8 HK removed
// import Scope from './Scope.mjs';
let $ = document.querySelector.bind(document);
let $$ = document.querySelectorAll.bind(document);

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
// LocalStorage helpers (single app, unscoped keys)
// - Stores JSON values (numbers, booleans) so we can round-trip types cleanly
// - Mirrors the multi-app behavior
// ------------------------------------------------------------
function loadFromLocalStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        const parsed = JSON.parse(raw);
        return (parsed === null || parsed === undefined) ? fallback : parsed;
    } catch {
        return fallback;
    }
}

function setLocalStorageIfChanged(key, value, opts = {}) {
    const decimals = Number.isFinite(opts.decimals) ? opts.decimals : null;

    let v = value;
    if (typeof v === 'number' && Number.isFinite(v) && decimals !== null) {
        const f = Math.pow(10, decimals);
        v = Math.round(v * f) / f;
    }

    const prev = localStorage.getItem(key);
    const next = JSON.stringify(v);
    if (prev !== next) localStorage.setItem(key, next);
}

// ✅ Toggle this
const enableScope = false;

(async () => {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Load version.json (best effort). Works when served over HTTP(S).
    // When running from file://, this may fail; WS server will also publish version.
    void (async () => {
        try {
            const res = await fetch('./version.json', {cache: 'no-store'});
            if (!res.ok) return;
            const data = await res.json();
            if (data && typeof data.version === 'string') {
                setServerVersion(data.version);
            }
        } catch {
            // ignore
        }
    })();

    let stretch = null;
    let audioDuration = 1;

    // Audio chain
    const volumeGain = audioContext.createGain();
    const panNode = audioContext.createStereoPanner();

    // Defaults
    const controlValuesInitial = {
        volume: 0.35,           // 0..1
        pan: 0,                 // -1..+1
        active: false,

        rate: 0.001,
        semitones: 0,
        tonalityHz: 16000,
        formantSemitones: 0,
        formantCompensation: false,
        formantBaseHz: 200,

        loopStart: 1,
        loopEnd: 1 // will be set when audio loads
    };

    const configValuesInitial = {
        blockMs: 60,
        overlap: 1.5,
        splitComputation: true
    };

    // Restore persisted values (multi-app style)
    const controlValues = {...controlValuesInitial};
    for (const k of Object.keys(controlValuesInitial)) {
        controlValues[k] = loadFromLocalStorage(k, controlValuesInitial[k]);
    }

    // Guard ranges
    controlValues.volume = clamp(toFiniteNumber(controlValues.volume, controlValuesInitial.volume), 0, 1);
    controlValues.pan = clamp(toFiniteNumber(controlValues.pan, controlValuesInitial.pan), -1, 1);
    controlValues.rate = clamp(toFiniteNumber(controlValues.rate, controlValuesInitial.rate), 0.00001, 4);
    controlValues.semitones = clamp(toFiniteNumber(controlValues.semitones, 0), -48, 48);
    controlValues.tonalityHz = clamp(toFiniteNumber(controlValues.tonalityHz, 16000), 20, 22050);
    controlValues.formantSemitones = clamp(toFiniteNumber(controlValues.formantSemitones, 0), -48, 48);
    controlValues.formantBaseHz = clamp(toFiniteNumber(controlValues.formantBaseHz, 200), 20, 2000);
    controlValues.loopStart = clamp(toFiniteNumber(controlValues.loopStart, 1), 0, 1e9);
    controlValues.loopEnd = clamp(toFiniteNumber(controlValues.loopEnd, 1), 0, 1e9);
    controlValues.active = !!controlValues.active;
    controlValues.formantCompensation = !!controlValues.formantCompensation;

    const configValues = {...configValuesInitial};
    for (const k of Object.keys(configValuesInitial)) {
        configValues[k] = loadFromLocalStorage(k, configValuesInitial[k]);
    }

    configValues.blockMs = clamp(toFiniteNumber(configValues.blockMs, 60), 10, 500);
    configValues.overlap = clamp(toFiniteNumber(configValues.overlap, 1.5), 1, 8);
    configValues.splitComputation = !!configValues.splitComputation;

    // Keep track whether "active" existed in storage; if not, we can auto-start once after loading default audio.
    const hadActiveStored = (localStorage.getItem('active') !== null);

    // Optional scope
    let scope = null;
    if (enableScope) {
        const {default: Scope} = await import("./Scope.mjs");

        scope = await Scope(audioContext);

        volumeGain.connect(panNode);
        panNode.connect(scope);
        scope.connect(audioContext.destination);

        const scopeFrame = scope.openInterface();
        scopeFrame.id = "scope";
        document.body.appendChild(scopeFrame);
    } else {
        volumeGain.connect(panNode);
        panNode.connect(audioContext.destination);

        document.body.style.gridTemplateAreas =
            '"playstop playback upload" "controls controls controls"';
        document.body.style.gridTemplateRows =
            "max-content 2fr";
    }

    // Apply initial gain/pan
    volumeGain.gain.value = clamp(toFiniteNumber(controlValues.volume, 0.35), 0, 1);
    panNode.pan.value = clamp(toFiniteNumber(controlValues.pan, 0), -1, 1);

    // Drop zone
    document.body.ondragover = (event) => event.preventDefault();
    document.body.ondrop = handleDrop;

    function handleDrop(event) {
        event.preventDefault();
        const dt = event.dataTransfer;
        handleFile(dt.items ? dt.items[0].getAsFile() : dt.files[0]);
    }

    function handleFile(file) {
        return new Promise((pass, fail) => {
            const reader = new FileReader();
            reader.onload = () => pass(handleArrayBuffer(reader.result));
            reader.onerror = fail;
            reader.readAsArrayBuffer(file);
        });
    }

    async function handleArrayBuffer(arrayBuffer) {
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        audioDuration = audioBuffer.duration;

        const channelBuffers = [];
        for (let c = 0; c < audioBuffer.numberOfChannels; ++c) {
            channelBuffers.push(audioBuffer.getChannelData(c));
        }

        // fresh node
        if (stretch) {
            stretch.stop();
            stretch.disconnect();
        }

        stretch = await SignalsmithStretch(audioContext);
        stretch.connect(volumeGain);
        await stretch.addBuffers(channelBuffers);

        controlValues.loopEnd = audioDuration;

        // Auto-start behavior like multi-app:
        // - If user previously set active, keep it.
        // - If there's no stored active yet, start once after loading the default file.
        if (!hadActiveStored) controlValues.active = true;

        console.log(`Loaded ${audioBuffer.numberOfChannels} channels, ${audioBuffer.length} samples`);

        configChanged();
        controlsChanged();
    }

    // ------------------------------------------------------------
    // Default audio (auto-load)
    // ------------------------------------------------------------
    (async () => {
        try {
            const res = await fetch('Black Hole Sun - Soundgarden.mp3', {cache: 'no-store'});
            if (!res.ok) return;
            await handleArrayBuffer(await res.arrayBuffer());
        } catch (e) {
            console.warn('[single] default audio load failed:', e);
        }
    })();

    // ------------------------------------------------------------
    // UI: play/stop
    // ------------------------------------------------------------
    $('#playstop').onclick = async () => {
        // User gesture here helps Safari/iOS; harmless elsewhere.
        await audioContext.resume();

        controlValues.active = !controlValues.active;
        controlsChanged(0.15);
    };

    // ------------------------------------------------------------
    // Reset buttons
    // ------------------------------------------------------------
    $$('#controls .reset-btn').forEach(btn => {
        btn.onclick = () => {
            const key = btn.dataset.resetKey;
            if (!key) return;

            // UI alias: volumePercent -> controlValues.volume (0..1)
            if (key === 'volumePercent') {
                controlValues.volume = controlValuesInitial.volume;
                controlsChanged();
                return;
            }

            if (key in controlValues) {
                controlValues[key] = controlValuesInitial[key];
                controlsChanged();
                return;
            }

            if (key in configValues) {
                configValues[key] = configValuesInitial[key];
                configChanged();
                return;
            }
        };
    });

    // ------------------------------------------------------------
    // Controls inputs
    // ------------------------------------------------------------
    $$('#controls input').forEach(input => {
        const isCheckbox = input.type === 'checkbox';
        const key = input.dataset.key;

        input.oninput = input.onchange = () => {
            const value = isCheckbox ? input.checked : parseFloat(input.value);

            // If a number input is temporarily empty/invalid, don't propagate NaN.
            if (!isCheckbox && !Number.isFinite(value)) return;

            // UI alias: volumePercent (1..100) -> controlValues.volume (0..1)
            if (key === 'volumePercent') {
                controlValues.volume = clamp(value, 1, 100) / 100;
                controlsChanged();
                return;
            }

            if (key in controlValues) {
                controlValues[key] = isCheckbox ? !!value : value;
                controlsChanged();
            } else if (key in configValues) {
                configValues[key] = isCheckbox ? !!value : value;
                configChanged();
            }
        };

        if (!isCheckbox) {
            input.ondblclick = () => {
                if (key in controlValues) {
                    controlValues[key] = controlValuesInitial[key];
                    controlsChanged();
                } else if (key in configValues) {
                    configValues[key] = configValuesInitial[key];
                    configChanged();
                }
            };
        }
    });

    // ------------------------------------------------------------
    // Apply controls -> audio graph + stretcher
    // ------------------------------------------------------------
    function controlsChanged(scheduleAhead) {
        // Play/pause icon
        $('#playstop').innerHTML =
            '<svg alt="toggle play" height="1em" width="1em" viewbox="0 0 8 8" style="vertical-align:middle"><path d="' +
            (controlValues.active ? 'M1 1L3 1 3 7 1 7ZM5 1 7 1 7 7 5 7Z' : 'M1 0L8 4 1 8') +
            '" fill="currentColor"/></svg>';

        // Persist controls (multi-app style)
        setLocalStorageIfChanged('volume', controlValues.volume, {decimals: 4});
        setLocalStorageIfChanged('pan', controlValues.pan, {decimals: 4});
        setLocalStorageIfChanged('rate', controlValues.rate, {decimals: 6});
        setLocalStorageIfChanged('semitones', controlValues.semitones, {decimals: 4});
        setLocalStorageIfChanged('tonalityHz', controlValues.tonalityHz, {decimals: 2});
        setLocalStorageIfChanged('formantSemitones', controlValues.formantSemitones, {decimals: 4});
        setLocalStorageIfChanged('formantCompensation', !!controlValues.formantCompensation);
        setLocalStorageIfChanged('formantBaseHz', controlValues.formantBaseHz, {decimals: 2});
        setLocalStorageIfChanged('loopStart', controlValues.loopStart, {decimals: 4});
        setLocalStorageIfChanged('loopEnd', controlValues.loopEnd, {decimals: 4});
        setLocalStorageIfChanged('active', !!controlValues.active);

        // Reflect to UI (including checkboxes)
        $$('#controls input').forEach(input => {
            const key = input.dataset.key;
            if (!key) return;

            // Keep the 1..100 UI in sync with controlValues.volume (0..1)
            if (key === 'volumePercent') {
                const volume01 = clamp(toFiniteNumber(controlValues.volume, 0), 0, 1);
                const percent = clamp(Math.round(volume01 * 100), 1, 100);
                const current = toFiniteNumber(parseFloat(input.value), NaN);
                if (!Number.isFinite(current) || percent !== current) input.value = String(percent);
                return;
            }

            if (key in controlValues) {
                const value = controlValues[key];
                if (input.type === 'checkbox') input.checked = !!value;
                else if (value !== parseFloat(input.value)) input.value = value;
            }
        });

        // Apply volume immediately (smooth)
        const targetVol = clamp(toFiniteNumber(controlValues.volume, 1), 0, 1);
        {
            const t = audioContext.currentTime;
            volumeGain.gain.cancelScheduledValues(t);
            volumeGain.gain.setValueAtTime(volumeGain.gain.value, t);
            volumeGain.gain.linearRampToValueAtTime(targetVol, t + 0.03);
        }

        // Apply pan immediately (smooth)
        const targetPan = clamp(toFiniteNumber(controlValues.pan, 0), -1, 1);
        {
            const t = audioContext.currentTime;
            panNode.pan.cancelScheduledValues(t);
            panNode.pan.setValueAtTime(panNode.pan.value, t);
            panNode.pan.linearRampToValueAtTime(targetPan, t + 0.03);
        }

        // Make it a singleton on window so repeated script evals won't spawn more sockets.
        if (!window.wsControlClient) {
            window.wsControlClient = (() => {
                let ws = null;
                let reconnectAttempt = 0;
                let reconnectTimer = null;
                let status = 'disconnected';

                function setStatus(next) {
                    status = next;
                    const el = document.querySelector('#ws-status');
                    if (el) el.textContent = `ws: ${next}`;

                    if (next === 'connected') setBadgeState('#ws-status', 'ok');
                    else if (String(next).startsWith('reconnecting')) setBadgeState('#ws-status', 'warn');
                    else setBadgeState('#ws-status', 'bad');
                }

                function setControllerStatus(msg) {
                    const el = document.querySelector('#controller-status');
                    if (!el) return;

                    if (msg && msg.status === 'connected') {
                        const deviceId = msg.deviceId ?? '?';
                        const fw = msg.fw ?? '?';
                        const port = msg.port ?? '?';
                        el.textContent = `controller: connected · ${deviceId} · fw=${fw} · ${port}`;
                        setBadgeState('#controller-status', 'ok');
                    } else {
                        el.textContent = 'controller: disconnected';
                        setBadgeState('#controller-status', 'bad');
                    }
                }

                function clearReconnectTimer() {
                    if (reconnectTimer) {
                        clearTimeout(reconnectTimer);
                        reconnectTimer = null;
                    }
                }

                function scheduleReconnect() {
                    if (reconnectTimer) return;

                    reconnectAttempt += 1;
                    const delayMs = Math.min(8000, 250 * (2 ** (reconnectAttempt - 1))); // 250..8000ms

                    setStatus(`reconnecting in ${Math.round(delayMs / 100) / 10}s`);
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        connect();
                    }, delayMs);
                }

                function applyIncomingSet(key, value) {
                    // volume 1..100 -> 0..1
                    if (key === 'volume') {
                        const volPercent = clamp(toFiniteNumber(value, NaN), 1, 100);
                        if (!Number.isFinite(volPercent)) return;
                        controlValues.volume = volPercent / 100;
                        controlsChanged(/*scheduleAhead=*/0.1);
                        return;
                    }

                    // pan -1..+1
                    if (key === 'pan') {
                        const p = clamp(toFiniteNumber(value, NaN), -1, 1);
                        if (!Number.isFinite(p)) return;
                        controlValues.pan = p;
                        controlsChanged(/*scheduleAhead=*/0.1);
                        return;
                    }

                    if (key in controlValues) {
                        if (typeof controlValues[key] === 'number') {
                            const n = toFiniteNumber(value, NaN);
                            if (!Number.isFinite(n)) return;
                            controlValues[key] = n;
                        } else {
                            controlValues[key] = value;
                        }
                        controlsChanged(/*scheduleAhead=*/0.1);
                        return;
                    }

                    if (key in configValues) {
                        configValues[key] = value;
                        configChanged();
                    }
                }

                function handleMessage(raw) {
                    let msg;
                    try {
                        msg = JSON.parse(raw);
                    } catch {
                        return;
                    }

                    if (msg.type === 'controller') {
                        setControllerStatus(msg);
                        return;
                    }

                    if (msg.type === 'machine') {
                        setMachineStatus(msg);
                        return;
                    }

                    if (msg.type === 'set') {
                        applyIncomingSet(msg.key, msg.value);
                        return;
                    }

                    if (msg.type === 'state' && msg.values) {
                        Object.entries(msg.values).forEach(([k, v]) => applyIncomingSet(k, v));
                        return;
                    }

                    if (typeof msg.type === 'string' && ('value' in msg)) {
                        applyIncomingSet(msg.type, msg.value);
                    }
                }

                function connect() {
                    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                        return; // already connected/connecting
                    }

                    clearReconnectTimer();
                    setStatus('connecting');

                    ws = new WebSocket('ws://localhost:8765');

                    ws.onopen = () => {
                        reconnectAttempt = 0;
                        setStatus('connected');
                    };

                    ws.onmessage = (event) => handleMessage(event.data);

                    ws.onerror = () => {
                        // Don’t reconnect here — wait for onclose (prevents double-reconnect storms)
                    };

                    ws.onclose = () => {
                        setStatus('disconnected');
                        setControllerStatus({status: 'disconnected'});
                        ws = null;
                        scheduleReconnect();
                    };
                }

                return {connect, getStatus: () => status};
            })();

            window.wsControlClient.connect();
        } else {
            window.wsControlClient.connect();
        }

        // Schedule stretch (Signalsmith: active + outputTime + explicit fields)
        if (stretch) {
            const loopStart = clamp(toFiniteNumber(controlValues.loopStart, 0), 0, audioDuration);
            const loopEnd = clamp(toFiniteNumber(controlValues.loopEnd, audioDuration), 0, audioDuration);

            const scheduleOffset = scheduleAhead || 0;

            stretch.schedule({
                active: !!controlValues.active,

                rate: clamp(toFiniteNumber(controlValues.rate, 0.001), 0.00001, 4),
                semitones: clamp(toFiniteNumber(controlValues.semitones, 0), -48, 48),
                tonalityHz: clamp(toFiniteNumber(controlValues.tonalityHz, 16000), 20, 22050),
                formantSemitones: clamp(toFiniteNumber(controlValues.formantSemitones, 0), -48, 48),
                formantCompensation: !!controlValues.formantCompensation,
                formantBaseHz: clamp(toFiniteNumber(controlValues.formantBaseHz, 200), 20, 2000),

                loopStart,
                loopEnd,

                outputTime: audioContext.currentTime + scheduleOffset
            });
        }

        // Try to resume (may be blocked until first user gesture, but harmless)
        audioContext.resume();
    }

    // ------------------------------------------------------------
    // Apply config -> stretcher
    // ------------------------------------------------------------
    let configTimeout = null;

    function configChanged() {
        // Persist config (multi-app style)
        setLocalStorageIfChanged('blockMs', configValues.blockMs, {decimals: 2});
        setLocalStorageIfChanged('overlap', configValues.overlap, {decimals: 4});
        setLocalStorageIfChanged('splitComputation', !!configValues.splitComputation);

        // Reflect in UI
        $$('#controls input').forEach(input => {
            const key = input.dataset.key;
            if (!key) return;

            if (key in configValues) {
                const value = configValues[key];
                if (input.type === 'checkbox') input.checked = !!value;
                else if (value !== parseFloat(input.value)) input.value = value;
            }
        });

        if (configTimeout == null) {
            configTimeout = setTimeout(() => {
                configTimeout = null;

                if (stretch) {
                    const blockMs = clamp(toFiniteNumber(configValues.blockMs, 60), 10, 500);
                    const overlap = clamp(toFiniteNumber(configValues.overlap, 1.5), 1, 8);
                    const splitComputation = !!configValues.splitComputation;

                    stretch.configure({blockMs, overlap, splitComputation});
                }
            }, 50);
        }

        audioContext.resume();
    }

    // ------------------------------------------------------------
    // Upload
    // ------------------------------------------------------------
    $('#upload').onclick = async () => {
        await audioContext.resume();
        $('#upload-file').click();
    };

    $('#upload-file').onchange = async () => {
        if (stretch) stretch.stop();

        await handleFile($('#upload-file').files[0]).catch(e => alert(e.message));
        if (stretch) {
            controlValues.active = true;
            controlsChanged();
        }
    };

    // ------------------------------------------------------------
    // Playback slider
    // ------------------------------------------------------------
    const playbackPosition = $('#playback');

    let playbackHeld = false;
    playbackPosition.onmousedown = () => {
        playbackHeld = true;
    };
    playbackPosition.onmouseup = playbackPosition.onmousecancel = () => {
        playbackHeld = false;
    };

    function updatePlaybackPosition() {
        if (!stretch) return;

        const inputTime = clamp(toFiniteNumber(parseFloat(playbackPosition.value), 0), 0, audioDuration);
        const rate = playbackHeld ? 0 : clamp(toFiniteNumber(controlValues.rate, 0.001), 0.00001, 4);

        stretch.schedule({
            active: true,
            input: inputTime,

            rate,
            semitones: clamp(toFiniteNumber(controlValues.semitones, 0), -48, 48),
            tonalityHz: clamp(toFiniteNumber(controlValues.tonalityHz, 16000), 20, 22050),
            formantSemitones: clamp(toFiniteNumber(controlValues.formantSemitones, 0), -48, 48),
            formantCompensation: !!controlValues.formantCompensation,
            formantBaseHz: clamp(toFiniteNumber(controlValues.formantBaseHz, 200), 20, 2000),

            loopStart: clamp(toFiniteNumber(controlValues.loopStart, 0), 0, audioDuration),
            loopEnd: clamp(toFiniteNumber(controlValues.loopEnd, audioDuration), 0, audioDuration),

            outputTime: audioContext.currentTime + 0.01
        });
    }

    playbackPosition.oninput = playbackPosition.onchange = updatePlaybackPosition;

    // Keep slider updated
    setInterval(() => {
        playbackPosition.max = audioDuration;
        if (stretch) playbackPosition.value = stretch.inputTime;
    }, 100);

    // Initial paint
    configChanged();
    controlsChanged();
})();

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function setBadgeState(selector, state) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.dataset.state = state; // "ok" | "warn" | "bad" | "idle"
}

// ------------------------------------------------------------
// Server version UI (new)
// ------------------------------------------------------------
function setServerVersion(version) {
    const el = document.querySelector('#server-version');
    if (!el) return;
    const v = (typeof version === 'string' && version.length) ? version : '0.0.0';
    el.textContent = `server: v${v}`;
    setBadgeState('#server-version', 'idle');
}

// ------------------------------------------------------------
// Machine status UI (new)
// ------------------------------------------------------------
function setMachineStatus(msg) {
    const el = document.querySelector('#machine-status');
    if (!el) return;

    if (!msg || typeof msg !== 'object') {
        el.textContent = 'machine: ?';
        return;
    }

    const hostname = (typeof msg.hostname === 'string' && msg.hostname.length) ? msg.hostname : '?';
    const ip = (typeof msg.ip === 'string' && msg.ip.length) ? msg.ip : '?';
    const platform = (typeof msg.platform === 'string' && msg.platform.length) ? msg.platform : '';
    const arch = (typeof msg.arch === 'string' && msg.arch.length) ? msg.arch : '';

    const parts = [`machine: ${hostname}`, ip !== '?' ? ip : null, platform || null, arch || null].filter(Boolean);
    el.textContent = parts.join(' · ');
    setBadgeState('#machine-status', 'idle');
}

// import SignalsmithStretch from "./SignalsmithStretch.mjs";
// // v2.8 HK removed
// // import Scope from './Scope.mjs';
// let $ = document.querySelector.bind(document);
// let $$ = document.querySelectorAll.bind(document);
//
// // ------------------------------------------------------------
// // Small utilities (guards against NaN / non-finite values)
// // ------------------------------------------------------------
// function toFiniteNumber(value, fallback) {
//     const n = (typeof value === 'number') ? value : Number(value);
//     return Number.isFinite(n) ? n : fallback;
// }
//
// function clamp(n, min, max) {
//     return Math.max(min, Math.min(max, n));
// }
//
// function setLocalStorageIfChanged(key, valueNumber, {decimals = 4} = {}) {
//     const numberValue = Number(valueNumber);
//     if (!Number.isFinite(numberValue)) return false;
//
//     const next = numberValue.toFixed(decimals);
//     const prev = localStorage.getItem(key);
//     if (prev !== next) {
//         localStorage.setItem(key, next);
//         return true;
//     }
//     return false;
// }
//
// // ------------------------------------------------------------
// // LocalStorage bool helpers (for autoplay "trick")
// // ------------------------------------------------------------
// function setLocalStorageBoolIfChanged(key, valueBool) {
//     const next = valueBool ? '1' : '0';
//     const prev = localStorage.getItem(key);
//     if (prev !== next) {
//         localStorage.setItem(key, next);
//         return true;
//     }
//     return false;
// }
//
// function getLocalStorageBool(key, fallbackBool) {
//     const raw = localStorage.getItem(key);
//     if (raw === null || raw === undefined) return fallbackBool;
//     if (raw === '1' || raw === 'true') return true;
//     if (raw === '0' || raw === 'false') return false;
//     return fallbackBool;
// }
//
// // ✅ Toggle this
// const enableScope = false;
//
// (async () => {
//     let audioContext = new AudioContext();
//
//     // Load version.json (best effort). Works when served over HTTP(S).
//     // When running from file://, this may fail; WS server will also publish version.
//     void (async () => {
//         try {
//             const res = await fetch('./version.json', {cache: 'no-store'});
//             if (!res.ok) return;
//             const data = await res.json();
//             if (data && typeof data.version === 'string') {
//                 setServerVersion(data.version);
//             }
//         } catch {
//             // ignore
//         }
//     })();
//
//     let stretch;
//     let audioDuration = 1;
//
//     // HK Added
//     let volumeGain = audioContext.createGain();
//     // HK Added: Stereo panner for balance control (-1..+1)
//     let panNode = audioContext.createStereoPanner();
//     panNode.pan.value = 0;
//
//     volumeGain.gain.value = 0.35;
//
//     let controlValuesInitial = {
//         // HK Added
//         volume: 0.35,
//         // HK Added: stereo balance (pan) -1..+1
//         pan: 0,
//
//         // IMPORTANT: will be restored from localStorage for "auto start"
//         active: false,
//
//         // rate: 1,
//         rate: 0.001,
//         semitones: 0,
//         // tonalityHz: 8000,
//         tonalityHz: 16000,
//         formantSemitones: 0,
//         formantCompensation: false,
//         formantBaseHz: 200,
//         loopStart: 1,
//         loopEnd: 1 // disabled (<= start), but this gets set when we load an audio file
//     };
//     let controlValues = Object.assign({}, controlValuesInitial);
//
//     // Restore persisted values (guard against NaN / garbage)
//     controlValues.volume = clamp(
//         toFiniteNumber(localStorage.getItem('volume'), controlValuesInitial.volume),
//         0,
//         1
//     );
//     controlValues.pan = clamp(
//         toFiniteNumber(localStorage.getItem('pan'), controlValuesInitial.pan),
//         -1,
//         1
//     );
//
//     controlValues.active = getLocalStorageBool('active', controlValuesInitial.active);
//
//     let configValuesInitial = {
//         // blockMs: 120,
//         // blockMs: 300,
//         blockMs: 60, // bigger blocks = better quality, but slower and makes it sound like a synthesizer
//         // For BHS keep the blockMs small (30 to 100Ms is fine)
//         // overlap: 7,
//         overlap: 1.5,
//         splitComputation: true
//     };
//     let configValues = Object.assign({}, configValuesInitial);
//
//     // ✅ Toggle Scope on/off here
//     let scope = null;
//
//     if (enableScope) {
//         const {default: Scope} = await import("./Scope.mjs");
//
//         scope = await Scope(audioContext);
//
//         volumeGain.connect(panNode);
//         panNode.connect(scope);
//         scope.connect(audioContext.destination);
//
//         const scopeFrame = scope.openInterface();
//         scopeFrame.id = "scope";
//         document.body.appendChild(scopeFrame);
//     } else {
//         volumeGain.connect(panNode);
//         panNode.connect(audioContext.destination);
//
//         document.body.style.gridTemplateAreas =
//             '"playstop playback upload" "controls controls controls"';
//         document.body.style.gridTemplateRows =
//             "max-content 2fr";
//     }
//
//     // Drop zone
//     document.body.ondragover = event => {
//         event.preventDefault();
//     };
//     document.body.ondrop = handleDrop;
//
//     function handleDrop(event) {
//         event.preventDefault();
//         var dt = event.dataTransfer;
//         handleFile(dt.items ? dt.items[0].getAsFile() : dt.files[0]);
//     }
//
//     function handleFile(file) {
//         return new Promise((pass, fail) => {
//             var reader = new FileReader();
//             reader.onload = e => pass(handleArrayBuffer(reader.result));
//             reader.onerror = fail;
//             reader.readAsArrayBuffer(file);
//         });
//     }
//
//     async function handleArrayBuffer(arrayBuffer) {
//         let audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
//         audioDuration = audioBuffer.duration;
//
//         let channelBuffers = [];
//         for (let c = 0; c < audioBuffer.numberOfChannels; ++c) {
//             channelBuffers.push(audioBuffer.getChannelData(c));
//         }
//
//         // fresh node
//         if (stretch) {
//             stretch.stop();
//             stretch.disconnect();
//         }
//         stretch = await SignalsmithStretch(audioContext);
//
//         stretch.connect(volumeGain);
//
//         await stretch.addBuffers(channelBuffers);
//
//         controlValues.loopEnd = audioDuration;
//
//         // ------------------------------------------------------------
//         // "Trick": auto-start after load (and persist)
//         // ------------------------------------------------------------
//         controlValues.active = true;
//
//         console.log(`Loaded ${audioBuffer.numberOfChannels} channels, ${audioBuffer.length} samples`);
//         configChanged();
//         controlsChanged();
//     }
//
//     // fetch audio and add buffer
//     let response = await fetch('Black Hole Sun - Soundgarden.mp3');
//     handleArrayBuffer(await response.arrayBuffer());
//
//     $('#playstop').onclick = e => {
//         controlValues.active = !controlValues.active;
//         controlsChanged(0.15);
//     };
//
//     // ------------------------------------------------------------
//     // Reset buttons (new)
//     // ------------------------------------------------------------
//     $$('#controls .reset-btn').forEach(btn => {
//         btn.onclick = (e) => {
//             const key = btn.dataset.resetKey;
//             if (!key) return;
//
//             // UI alias: volumePercent -> controlValues.volume (0..1)
//             if (key === 'volumePercent') {
//                 controlValues.volume = controlValuesInitial.volume;
//                 controlsChanged();
//                 return;
//             }
//
//             if (key in controlValues) {
//                 controlValues[key] = controlValuesInitial[key];
//                 controlsChanged();
//                 return;
//             }
//
//             if (key in configValues) {
//                 configValues[key] = configValuesInitial[key];
//                 configChanged();
//                 return;
//             }
//         };
//     });
//
//     $$('#controls input').forEach(input => {
//         let isCheckbox = input.type === 'checkbox';
//         let key = input.dataset.key;
//
//         input.oninput = input.onchange = e => {
//             let value = isCheckbox ? input.checked : parseFloat(input.value);
//
//             // If a number input is temporarily empty/invalid, don't propagate NaN.
//             if (!isCheckbox && !Number.isFinite(value)) return;
//
//             // ✅ UI alias: volumePercent (1..100) -> controlValues.volume (0..1)
//             if (key === 'volumePercent') {
//                 controlValues.volume = clamp(value, 1, 100) / 100;
//                 controlsChanged();
//                 return;
//             }
//
//             if (key in controlValues) {
//                 controlValues[key] = value;
//                 controlsChanged();
//             } else if (key in configValues) {
//                 configValues[key] = value;
//                 configChanged();
//             }
//         };
//
//         if (!isCheckbox) input.ondblclick = e => {
//             if (key in controlValues) {
//                 controlValues[key] = controlValuesInitial[key];
//                 controlsChanged();
//             } else if (key in configValues) {
//                 configValues[key] = configValuesInitial[key];
//                 configChanged();
//             }
//         };
//     });
//
//     function controlsChanged(scheduleAhead) {
//         $('#playstop').innerHTML =
//             '<svg alt="toggle play" height="1em" width="1em" viewbox="0 0 8 8" style="vertical-align:middle"><path d="' +
//             (controlValues.active ? 'M1 1L3 1 3 7 1 7ZM5 1 7 1 7 7 5 7Z' : 'M1 0L8 4 1 8') +
//             '" fill="currentColor"/></svg>';
//
//         // Reflect values back into UI (including checkboxes)
//         $$('#controls input').forEach(input => {
//             let key = input.dataset.key;
//             if (!key) return;
//
//             // ✅ keep the 1..100 UI in sync with controlValues.volume (0..1)
//             if (key === 'volumePercent') {
//                 const volume01 = clamp(toFiniteNumber(controlValues.volume, 0), 0, 1);
//                 const percent = clamp(Math.round(volume01 * 100), 1, 100);
//                 const current = toFiniteNumber(parseFloat(input.value), NaN);
//                 if (!Number.isFinite(current) || percent !== current) input.value = String(percent);
//                 return;
//             }
//
//             if (key in controlValues) {
//                 const value = controlValues[key];
//                 if (input.type === 'checkbox') {
//                     input.checked = !!value;
//                 } else {
//                     if (value !== parseFloat(input.value)) input.value = value;
//                 }
//             }
//         });
//
//         // Make it a singleton on window so repeated script evals won't spawn more sockets.
//         if (!window.wsControlClient) {
//             window.wsControlClient = (() => {
//                 let ws = null;
//                 let reconnectAttempt = 0;
//                 let reconnectTimer = null;
//                 let status = 'disconnected';
//
//                 // new v2.14.0: machine status
//                 function setStatus(next) {
//                     status = next;
//                     const el = document.querySelector('#ws-status');
//                     if (el) el.textContent = `ws: ${next}`;
//
//                     // color state
//                     if (next === 'connected') setBadgeState('#ws-status', 'ok');
//                     else if (String(next).startsWith('reconnecting')) setBadgeState('#ws-status', 'warn');
//                     else setBadgeState('#ws-status', 'bad');
//                 }
//
//                 function setControllerStatus(msg) {
//                     const el = document.querySelector('#controller-status');
//                     if (!el) return;
//
//                     if (msg && msg.status === 'connected') {
//                         const deviceId = msg.deviceId ?? '?';
//                         const fw = msg.fw ?? '?';
//                         const port = msg.port ?? '?';
//                         el.textContent = `controller: connected · ${deviceId} · fw=${fw} · ${port}`;
//                         setBadgeState('#controller-status', 'ok');
//                     } else {
//                         el.textContent = 'controller: disconnected';
//                         setBadgeState('#controller-status', 'bad');
//                     }
//                 }
//
//                 function clearReconnectTimer() {
//                     if (reconnectTimer) {
//                         clearTimeout(reconnectTimer);
//                         reconnectTimer = null;
//                     }
//                 }
//
//                 function scheduleReconnect() {
//                     if (reconnectTimer) return;
//
//                     reconnectAttempt += 1;
//                     const delayMs = Math.min(8000, 250 * (2 ** (reconnectAttempt - 1))); // 250..8000ms
//
//                     setStatus(`reconnecting in ${Math.round(delayMs / 100) / 10}s`);
//                     reconnectTimer = setTimeout(() => {
//                         reconnectTimer = null;
//                         connect();
//                     }, delayMs);
//                 }
//
//                 function applyIncomingSet(key, value) {
//                     // volume 1..100 -> 0..1
//                     if (key === 'volume') {
//                         const volPercent = clamp(toFiniteNumber(value, NaN), 1, 100);
//                         if (!Number.isFinite(volPercent)) return;
//                         controlValues.volume = volPercent / 100;
//                         controlsChanged();
//                         return;
//                     }
//
//                     // pan -1..+1
//                     if (key === 'pan') {
//                         const pan = clamp(toFiniteNumber(value, NaN), -1, 1);
//                         if (!Number.isFinite(pan)) return;
//                         controlValues.pan = pan;
//                         controlsChanged();
//                         return;
//                     }
//
//                     if (key in controlValues) {
//                         if (typeof controlValues[key] === 'number') {
//                             const n = toFiniteNumber(value, NaN);
//                             if (!Number.isFinite(n)) return;
//                             controlValues[key] = n;
//                         } else {
//                             controlValues[key] = value;
//                         }
//                         controlsChanged();
//                         return;
//                     }
//                     if (key in configValues) {
//                         configValues[key] = value;
//                         configChanged();
//                     }
//                 }
//
//                 function handleMessage(raw) {
//                     let msg;
//                     try {
//                         msg = JSON.parse(raw);
//                     } catch {
//                         return;
//                     }
//
//                     if (msg.type === 'controller') {
//                         setControllerStatus(msg);
//                         return;
//                     }
//
//                     if (msg.type === 'machine') {
//                         setMachineStatus(msg);
//                         return;
//                     }
//
//                     if (msg.type === 'set') {
//                         applyIncomingSet(msg.key, msg.value);
//                         return;
//                     }
//                     if (msg.type === 'state' && msg.values) {
//                         Object.entries(msg.values).forEach(([k, v]) => applyIncomingSet(k, v));
//                         return;
//                     }
//
//                     if (typeof msg.type === 'string' && ('value' in msg)) {
//                         applyIncomingSet(msg.type, msg.value);
//                     }
//                 }
//
//                 function connect() {
//                     if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
//                         return; // already connected/connecting
//                     }
//
//                     clearReconnectTimer();
//                     setStatus('connecting');
//
//                     ws = new WebSocket('ws://localhost:8765');
//
//                     ws.onopen = () => {
//                         reconnectAttempt = 0;
//                         setStatus('connected');
//                     };
//
//                     ws.onmessage = (event) => handleMessage(event.data);
//
//                     ws.onerror = () => {
//                         // Don’t reconnect here — wait for onclose (prevents double-reconnect storms)
//                     };
//
//                     ws.onclose = () => {
//                         setStatus('disconnected');
//                         setControllerStatus({status: 'disconnected'});
//                         // Make sure the guard works: drop reference so connect() can create a fresh one.
//                         ws = null;
//                         scheduleReconnect();
//                     };
//                 }
//
//                 return {connect, getStatus: () => status};
//             })();
//
//             window.wsControlClient.connect();
//         } else {
//             // If script runs again, do nothing (existing client keeps running).
//             window.wsControlClient.connect();
//         }
//
//         // Apply volume immediately
//         if (volumeGain) {
//             const target = clamp(toFiniteNumber(controlValues.volume, 1), 0, 1);
//             setLocalStorageIfChanged('volume', target, {decimals: 4});
//
//             let t = audioContext.currentTime;
//             volumeGain.gain.cancelScheduledValues(t);
//             volumeGain.gain.setValueAtTime(volumeGain.gain.value, t);
//             volumeGain.gain.linearRampToValueAtTime(target, t + 0.03);
//         }
//
//         // Apply pan immediately
//         if (panNode) {
//             const targetPan = clamp(toFiniteNumber(controlValues.pan, 0), -1, 1);
//             setLocalStorageIfChanged('pan', targetPan, {decimals: 4});
//
//             let t = audioContext.currentTime;
//             panNode.pan.cancelScheduledValues(t);
//             panNode.pan.setValueAtTime(panNode.pan.value, t);
//             panNode.pan.linearRampToValueAtTime(targetPan, t + 0.03);
//         }
//
//         // Persist active (the autoplay "trick")
//         setLocalStorageBoolIfChanged('active', !!controlValues.active);
//
//         // Schedule stretch (Signalsmith expects active + outputTime)
//         if (stretch) {
//             const scheduleOffset = scheduleAhead || 0;
//
//             stretch.schedule({
//                 active: !!controlValues.active,
//
//                 rate: controlValues.rate,
//                 semitones: controlValues.semitones,
//                 tonalityHz: controlValues.tonalityHz,
//                 formantSemitones: controlValues.formantSemitones,
//                 formantCompensation: !!controlValues.formantCompensation,
//                 formantBaseHz: controlValues.formantBaseHz,
//
//                 loopStart: controlValues.loopStart,
//                 loopEnd: controlValues.loopEnd,
//
//                 outputTime: audioContext.currentTime + scheduleOffset
//             });
//         }
//
//         // Try to resume (may be blocked until first user gesture, but harmless)
//         audioContext.resume();
//     }
//
//     controlsChanged();
//     let configTimeout = null;
//
//     function configChanged() {
//         // Reflect config values to UI (including checkboxes)
//         $$('#controls input').forEach(input => {
//             let key = input.dataset.key;
//             if (!key) return;
//             if (key in configValues) {
//                 const value = configValues[key];
//                 if (input.type === 'checkbox') {
//                     input.checked = !!value;
//                 } else {
//                     if (value !== parseFloat(input.value)) input.value = value;
//                 }
//             }
//         });
//
//         if (configTimeout == null) {
//             configTimeout = setTimeout(_ => {
//                 configTimeout = null;
//                 if (stretch) {
//                     // Match the working multi-app configure() call shape
//                     stretch.configure({
//                         blockMs: configValues.blockMs,
//                         overlap: configValues.overlap,
//                         splitComputation: configValues.splitComputation,
//                     });
//                 }
//             }, 50);
//         }
//
//         // Try to resume (may be blocked until first user gesture, but harmless)
//         audioContext.resume();
//     }
//
//     controlsChanged();
//
//     $('#upload').onclick = e => $('#upload-file').click();
//     $('#upload-file').onchange = async e => {
//         stretch.stop();
//         await handleFile($('#upload-file').files[0]).catch(e => alert(e.message));
//         if (stretch) {
//             controlValues.active = true;
//             controlsChanged();
//         }
//     };
//
//     let playbackPosition = $('#playback');
//     setInterval(_ => {
//         playbackPosition.max = audioDuration;
//         playbackPosition.value = stretch?.inputTime;
//         console.log(`playbackPosition: ${playbackPosition.value}, minutes: ${playbackPosition.value / 60}`);
//     }, 100);
//     let playbackHeld = false;
//
//     function updatePlaybackPosition(e) {
//         if (!stretch) return;
//
//         let inputTime = parseFloat(playbackPosition.value);
//         inputTime = clamp(toFiniteNumber(inputTime, 0), 0, audioDuration);
//
//         // During "scrub hold" we can optionally freeze rate
//         const rate = playbackHeld ? 0 : controlValues.rate;
//
//         console.log(`updatePlaybackPosition: ${inputTime}, minutes: ${inputTime / 60}`);
//
//         stretch.schedule({
//             active: true,
//             input: inputTime,
//
//             rate,
//             semitones: controlValues.semitones,
//             tonalityHz: controlValues.tonalityHz,
//             formantSemitones: controlValues.formantSemitones,
//             formantCompensation: !!controlValues.formantCompensation,
//             formantBaseHz: controlValues.formantBaseHz,
//
//             loopStart: controlValues.loopStart,
//             loopEnd: controlValues.loopEnd,
//
//             outputTime: audioContext.currentTime + 0.01
//         });
//     }
//
//     playbackPosition.onmousedown = e => {
//         playbackHeld = true;
//     };
//     playbackPosition.onmouseup = playbackPosition.onmousecancel = e => {
//         playbackHeld = false;
//     };
//     playbackPosition.oninput = playbackPosition.onchange = updatePlaybackPosition;
// })();
//
// // ------------------------------------------------------------
// // Helpers
// // ------------------------------------------------------------
//
// function setBadgeState(selector, state) {
//     const el = document.querySelector(selector);
//     if (!el) return;
//     el.dataset.state = state; // "ok" | "warn" | "bad" | "idle"
// }
//
// // ------------------------------------------------------------
// // Server version UI (new)
// // ------------------------------------------------------------
// function setServerVersion(version) {
//     const el = document.querySelector('#server-version');
//     if (!el) return;
//     const v = (typeof version === 'string' && version.length) ? version : '0.0.0';
//     el.textContent = `server: v${v}`;
//     setBadgeState('#server-version', 'idle');
// }
//
// // ------------------------------------------------------------
// // Machine status UI (new)
// // ------------------------------------------------------------
// function setMachineStatus(msg) {
//     const el = document.querySelector('#machine-status');
//     if (!el) return;
//
//     if (!msg || typeof msg !== 'object') {
//         el.textContent = 'machine: ?';
//         return;
//     }
//
//     const hostname = (typeof msg.hostname === 'string' && msg.hostname.length) ? msg.hostname : '?';
//     const ip = (typeof msg.ip === 'string' && msg.ip.length) ? msg.ip : '?';
//     const platform = (typeof msg.platform === 'string' && msg.platform.length) ? msg.platform : '';
//     const arch = (typeof msg.arch === 'string' && msg.arch.length) ? msg.arch : '';
//
//     // Keep it compact for the status bar.
//     // Example: "machine: ctrl-pi · 192.168.1.42 · Linux 6.1.0-rpi · aarch64"
//     const parts = [`machine: ${hostname}`, ip !== '?' ? ip : null, platform || null, arch || null].filter(Boolean);
//     el.textContent = parts.join(' · ');
//     setBadgeState('#machine-status', 'idle');
// }
//
// // import SignalsmithStretch from "./SignalsmithStretch.mjs";
// // // v2.8 HK removed
// // // import Scope from './Scope.mjs';
// // let $ = document.querySelector.bind(document);
// // let $$ = document.querySelectorAll.bind(document);
// //
// // // ------------------------------------------------------------
// // // Small utilities (guards against NaN / non-finite values)
// // // ------------------------------------------------------------
// // function toFiniteNumber(value, fallback) {
// //     const n = (typeof value === 'number') ? value : Number(value);
// //     return Number.isFinite(n) ? n : fallback;
// // }
// //
// // function clamp(n, min, max) {
// //     return Math.max(min, Math.min(max, n));
// // }
// //
// // function setLocalStorageIfChanged(key, valueNumber, {decimals = 4} = {}) {
// //     const numberValue = Number(valueNumber);
// //     if (!Number.isFinite(numberValue)) return false;
// //
// //     const next = numberValue.toFixed(decimals);
// //     const prev = localStorage.getItem(key);
// //     if (prev !== next) {
// //         localStorage.setItem(key, next);
// //         return true;
// //     }
// //     return false;
// // }
// //
// // // ✅ Toggle this
// // const enableScope = false;
// //
// // (async () => {
// //     let audioContext = new AudioContext();
// //
// //     // Load version.json (best effort). Works when served over HTTP(S).
// //     // When running from file://, this may fail; WS server will also publish version.
// //     void (async () => {
// //         try {
// //             const res = await fetch('./version.json', {cache: 'no-store'});
// //             if (!res.ok) return;
// //             const data = await res.json();
// //             if (data && typeof data.version === 'string') {
// //                 setServerVersion(data.version);
// //             }
// //         } catch {
// //             // ignore
// //         }
// //     })();
// //
// // //     (async () => {
// // //         try {
// // //             const res = await fetch('./version.json', {cache: 'no-store'});
// // //             if (!res.ok) return;
// // //             const data = await res.json();
// // //             if (data && typeof data.version === 'string') {
// // //                 setServerVersion(data.version);
// // //             }
// // //         } catch {
// // //             // ignore
// // //         }
// // //     })();
// //
// //
// //     // // Load version.json (best effort). Works when served over HTTP(S).
// //     // // When running from file://, this may fail; WS server will also publish version.
// //     // (async () => {
// //     //     try {
// //     //         const res = await fetch('./version.json', {cache: 'no-store'});
// //     //         if (!res.ok) return;
// //     //         const data = await res.json();
// //     //         const el = document.querySelector('#server-version');
// //     //         if (el && data && typeof data.version === 'string') {
// //     //             el.textContent = `server: v${data.version}`;
// //     //         }
// //     //     } catch {
// //     //         // ignore
// //     //     }
// //     // })();
// //
// //     let stretch;
// //     let audioDuration = 1;
// //
// //     // HK Added
// //     let volumeGain = audioContext.createGain();
// // // HK Added: Stereo panner for balance control (-1..+1)
// //     let panNode = audioContext.createStereoPanner();
// //     panNode.pan.value = 0;
// //
// //     volumeGain.gain.value = 0.35;
// //
// //     let controlValuesInitial = {
// //         // HK Added
// //         volume: 0.35,
// //         // HK Added: stereo balance (pan) -1..+1
// //         pan: 0,
// //         active: false,
// //         // rate: 1,
// //         rate: 0.001,
// //         semitones: 0,
// //         // tonalityHz: 8000,
// //         tonalityHz: 16000,
// //         formantSemitones: 0,
// //         formantCompensation: false,
// //         formantBaseHz: 200,
// //         loopStart: 1,
// //         loopEnd: 1 // disabled (<= start), but this gets set when we load an audio file
// //     };
// //     let controlValues = Object.assign({}, controlValuesInitial);
// //
// //     // Restore persisted values (guard against NaN / garbage)
// //     controlValues.volume = clamp(
// //         toFiniteNumber(localStorage.getItem('volume'), controlValuesInitial.volume),
// //         0,
// //         1
// //     );
// //     controlValues.pan = clamp(
// //         toFiniteNumber(localStorage.getItem('pan'), controlValuesInitial.pan),
// //         -1,
// //         1
// //     );
// //
// //     let configValuesInitial = {
// //         // blockMs: 120,
// //         // blockMs: 300,
// //         blockMs: 60, // bigger blocks = better quality, but slower and makes it sound like a synthesizer
// //         // For BHS keep the blockMs small (30 to 100Ms is fine)
// //         // overlap: 7,
// //         overlap: 1.5,
// //         splitComputation: true
// //     };
// //     let configValues = Object.assign({}, configValuesInitial);
// //
// //     // ✅ Toggle Scope on/off here
// //     let scope = null;
// //
// //     if (enableScope) {
// //         const {default: Scope} = await import("./Scope.mjs");
// //
// //         scope = await Scope(audioContext);
// //
// //         volumeGain.connect(panNode);
// //         panNode.connect(scope);
// //         scope.connect(audioContext.destination);
// //
// //         const scopeFrame = scope.openInterface();
// //         scopeFrame.id = "scope";
// //         document.body.appendChild(scopeFrame);
// //     } else {
// //         volumeGain.connect(panNode);
// //         panNode.connect(audioContext.destination);
// //
// //         document.body.style.gridTemplateAreas =
// //             '"playstop playback upload" "controls controls controls"';
// //         document.body.style.gridTemplateRows =
// //             "max-content 2fr";
// //     }
// //
// //     // Drop zone
// //     document.body.ondragover = event => {
// //         event.preventDefault();
// //     }
// //     document.body.ondrop = handleDrop;
// //
// //     function handleDrop(event) {
// //         event.preventDefault();
// //         var dt = event.dataTransfer;
// //         handleFile(dt.items ? dt.items[0].getAsFile() : dt.files[0]);
// //     }
// //
// //     function handleFile(file) {
// //         return new Promise((pass, fail) => {
// //             var reader = new FileReader();
// //             reader.onload = e => pass(handleArrayBuffer(reader.result));
// //             reader.onerror = fail;
// //             reader.readAsArrayBuffer(file);
// //         });
// //     }
// //
// //     async function handleArrayBuffer(arrayBuffer) {
// //         let audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
// //         audioDuration = audioBuffer.duration;
// //         let channelBuffers = []
// //         for (let c = 0; c < audioBuffer.numberOfChannels; ++c) {
// //             channelBuffers.push(audioBuffer.getChannelData(c));
// //         }
// //         // fresh node
// //         if (stretch) {
// //             stretch.stop();
// //             stretch.disconnect();
// //         }
// //         stretch = await SignalsmithStretch(audioContext);
// //
// //         stretch.connect(volumeGain);
// //
// //         await stretch.addBuffers(channelBuffers);
// //         controlValues.loopEnd = audioDuration;
// //         console.log(`Loaded ${audioBuffer.numberOfChannels} channels, ${audioBuffer.length} samples`);
// //         configChanged();
// //         controlsChanged();
// //     }
// //
// //     // fetch audio and add buffer
// //     let response = await fetch('Black Hole Sun - Soundgarden.mp3');
// //     handleArrayBuffer(await response.arrayBuffer());
// //
// //     $('#playstop').onclick = e => {
// //         controlValues.active = !controlValues.active;
// //         controlsChanged(0.15);
// //     };
// //
// //     // ------------------------------------------------------------
// //     // Reset buttons (new)
// //     // ------------------------------------------------------------
// //     $$('#controls .reset-btn').forEach(btn => {
// //         btn.onclick = (e) => {
// //             const key = btn.dataset.resetKey;
// //             if (!key) return;
// //
// //             // UI alias: volumePercent -> controlValues.volume (0..1)
// //             if (key === 'volumePercent') {
// //                 controlValues.volume = controlValuesInitial.volume;
// //                 controlsChanged();
// //                 return;
// //             }
// //
// //             if (key in controlValues) {
// //                 controlValues[key] = controlValuesInitial[key];
// //                 controlsChanged();
// //                 return;
// //             }
// //
// //             if (key in configValues) {
// //                 configValues[key] = configValuesInitial[key];
// //                 configChanged();
// //                 return;
// //             }
// //         };
// //     });
// //
// //     $$('#controls input').forEach(input => {
// //         let isCheckbox = input.type == 'checkbox';
// //         let key = input.dataset.key;
// //
// //         input.oninput = input.onchange = e => {
// //             let value = isCheckbox ? input.checked : parseFloat(input.value);
// //
// //             // If a number input is temporarily empty/invalid, don't propagate NaN.
// //             if (!isCheckbox && !Number.isFinite(value)) return;
// //
// //             // ✅ UI alias: volumePercent (1..100) -> controlValues.volume (0..1)
// //             if (key === 'volumePercent') {
// //                 controlValues.volume = clamp(value, 1, 100) / 100;
// //                 controlsChanged();
// //                 return;
// //             }
// //
// //             if (key in controlValues) {
// //                 controlValues[key] = value;
// //                 controlsChanged();
// //             } else if (key in configValues) {
// //                 configValues[key] = value;
// //                 configChanged();
// //             }
// //         };
// //
// //         if (!isCheckbox) input.ondblclick = e => {
// //             if (key in controlValues) {
// //                 controlValues[key] = controlValuesInitial[key];
// //                 controlsChanged();
// //             } else if (key in configValues) {
// //                 configValues[key] = configValuesInitial[key];
// //                 configChanged();
// //             }
// //         };
// //     });
// //
// //     function controlsChanged(scheduleAhead) {
// //         $('#playstop').innerHTML =
// //             '<svg alt="toggle play" height="1em" width="1em" viewbox="0 0 8 8" style="vertical-align:middle"><path d="' +
// //             (controlValues.active ? 'M1 1L3 1 3 7 1 7ZM5 1 7 1 7 7 5 7Z' : 'M1 0L8 4 1 8') +
// //             '" fill="currentColor"/></svg>';
// //
// //         $$('#controls input').forEach(input => {
// //             let key = input.dataset.key;
// //
// //             // ✅ keep the 1..100 UI in sync with controlValues.volume (0..1)
// //             if (key === 'volumePercent') {
// //                 const volume01 = clamp(toFiniteNumber(controlValues.volume, 0), 0, 1);
// //                 const percent = clamp(Math.round(volume01 * 100), 1, 100);
// //                 const current = toFiniteNumber(parseFloat(input.value), NaN);
// //                 if (!Number.isFinite(current) || percent !== current) input.value = String(percent);
// //                 return;
// //             }
// //
// //             if (key in controlValues) {
// //                 let value = controlValues[key];
// //                 if (value !== parseFloat(input.value)) input.value = value;
// //             }
// //         });
// //
// //         // Make it a singleton on window so repeated script evals won't spawn more sockets.
// //         if (!window.wsControlClient) {
// //             window.wsControlClient = (() => {
// //                 let ws = null;
// //                 let reconnectAttempt = 0;
// //                 let reconnectTimer = null;
// //                 let status = 'disconnected';
// //
// //                 // new v2.14.0: machine status
// //                 function setStatus(next) {
// //                     status = next;
// //                     const el = document.querySelector('#ws-status');
// //                     if (el) el.textContent = `ws: ${next}`;
// //
// //                     // color state
// //                     if (next === 'connected') setBadgeState('#ws-status', 'ok');
// //                     else if (String(next).startsWith('reconnecting')) setBadgeState('#ws-status', 'warn');
// //                     else setBadgeState('#ws-status', 'bad');
// //                 }
// //
// //
// //                 // function setStatus(next) {
// //                 //     status = next;
// //                 //     const el = document.querySelector('#ws-status');
// //                 //     if (el) el.textContent = `ws: ${next}`;
// //                 // }
// //
// //                 function setControllerStatus(msg) {
// //                     const el = document.querySelector('#controller-status');
// //                     if (!el) return;
// //
// //                     if (msg && msg.status === 'connected') {
// //                         const deviceId = msg.deviceId ?? '?';
// //                         const fw = msg.fw ?? '?';
// //                         const port = msg.port ?? '?';
// //                         el.textContent = `controller: connected · ${deviceId} · fw=${fw} · ${port}`;
// //                         setBadgeState('#controller-status', 'ok');
// //                     } else {
// //                         el.textContent = 'controller: disconnected';
// //                         setBadgeState('#controller-status', 'bad');
// //                     }
// //                 }
// //
// //                 function clearReconnectTimer() {
// //                     if (reconnectTimer) {
// //                         clearTimeout(reconnectTimer);
// //                         reconnectTimer = null;
// //                     }
// //                 }
// //
// //                 function scheduleReconnect() {
// //                     if (reconnectTimer) return;
// //
// //                     reconnectAttempt += 1;
// //                     const delayMs = Math.min(8000, 250 * (2 ** (reconnectAttempt - 1))); // 250..8000ms
// //
// //                     setStatus(`reconnecting in ${Math.round(delayMs / 100) / 10}s`);
// //                     reconnectTimer = setTimeout(() => {
// //                         reconnectTimer = null;
// //                         connect();
// //                     }, delayMs);
// //                 }
// //
// //                 function applyIncomingSet(key, value) {
// //                     // volume 1..100 -> 0..1
// //                     if (key === 'volume') {
// //                         const volPercent = clamp(toFiniteNumber(value, NaN), 1, 100);
// //                         if (!Number.isFinite(volPercent)) return;
// //                         controlValues.volume = volPercent / 100;
// //                         controlsChanged();
// //                         return;
// //                     }
// //
// //                     // pan -1..+1
// //                     if (key === 'pan') {
// //                         const pan = clamp(toFiniteNumber(value, NaN), -1, 1);
// //                         if (!Number.isFinite(pan)) return;
// //                         controlValues.pan = pan;
// //                         controlsChanged();
// //                         return;
// //                     }
// //
// //                     if (key in controlValues) {
// //                         if (typeof controlValues[key] === 'number') {
// //                             const n = toFiniteNumber(value, NaN);
// //                             if (!Number.isFinite(n)) return;
// //                             controlValues[key] = n;
// //                         } else {
// //                             controlValues[key] = value;
// //                         }
// //                         controlsChanged();
// //                         return;
// //                     }
// //                     if (key in configValues) {
// //                         configValues[key] = value;
// //                         configChanged();
// //                     }
// //                 }
// //
// //                 function handleMessage(raw) {
// //                     let msg;
// //                     try {
// //                         msg = JSON.parse(raw);
// //                     } catch {
// //                         return;
// //                     }
// //
// //                     if (msg.type === 'controller') {
// //                         setControllerStatus(msg);
// //                         return;
// //                     }
// //
// //                     if (msg.type === 'machine') {
// //                         setMachineStatus(msg);
// //                         return;
// //                     }
// //
// //                     // if (msg.type === 'controller') {
// //                     //     setControllerStatus(msg);
// //                     //     return;
// //                     // }
// //
// //                     if (msg.type === 'set') {
// //                         applyIncomingSet(msg.key, msg.value);
// //                         return;
// //                     }
// //                     if (msg.type === 'state' && msg.values) {
// //                         Object.entries(msg.values).forEach(([k, v]) => applyIncomingSet(k, v));
// //                         return;
// //                     }
// //
// //                     if (typeof msg.type === 'string' && ('value' in msg)) {
// //                         applyIncomingSet(msg.type, msg.value);
// //                     }
// //                 }
// //
// //                 function connect() {
// //                     if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
// //                         return; // already connected/connecting
// //                     }
// //
// //                     clearReconnectTimer();
// //                     setStatus('connecting');
// //
// //                     ws = new WebSocket('ws://localhost:8765');
// //
// //                     ws.onopen = () => {
// //                         reconnectAttempt = 0;
// //                         setStatus('connected');
// //                     };
// //
// //                     ws.onmessage = (event) => handleMessage(event.data);
// //
// //                     ws.onerror = () => {
// //                         // Don’t reconnect here — wait for onclose (prevents double-reconnect storms)
// //                     };
// //
// //                     ws.onclose = () => {
// //                         setStatus('disconnected');
// //                         setControllerStatus({status: 'disconnected'});
// //                         // Make sure the guard works: drop reference so connect() can create a fresh one.
// //                         ws = null;
// //                         scheduleReconnect();
// //                     };
// //                 }
// //
// //                 return {connect, getStatus: () => status};
// //             })();
// //
// //             window.wsControlClient.connect();
// //         } else {
// //             // If script runs again, do nothing (existing client keeps running).
// //             window.wsControlClient.connect();
// //         }
// //
// //         // Apply volume immediately
// //         if (volumeGain) {
// //             const target = clamp(toFiniteNumber(controlValues.volume, 1), 0, 1);
// //             setLocalStorageIfChanged('volume', target, {decimals: 4});
// //
// //             let t = audioContext.currentTime;
// //             volumeGain.gain.cancelScheduledValues(t);
// //             volumeGain.gain.setValueAtTime(volumeGain.gain.value, t);
// //             volumeGain.gain.linearRampToValueAtTime(target, t + 0.03);
// //         }
// //
// //         // Apply pan immediately
// //         if (panNode) {
// //             const targetPan = clamp(toFiniteNumber(controlValues.pan, 0), -1, 1);
// //             setLocalStorageIfChanged('pan', targetPan, {decimals: 4});
// //
// //             let t = audioContext.currentTime;
// //             panNode.pan.cancelScheduledValues(t);
// //             panNode.pan.setValueAtTime(panNode.pan.value, t);
// //             panNode.pan.linearRampToValueAtTime(targetPan, t + 0.03);
// //         }
// //
// //         if (stretch) {
// //             let obj = Object.assign({output: audioContext.currentTime + (scheduleAhead || 0)}, controlValues);
// //             stretch.schedule(obj);
// //         }
// //         audioContext.resume();
// //     }
// //
// //     controlsChanged();
// //     let configTimeout = null;
// //
// //     function configChanged() {
// //         $$('#controls input').forEach(input => {
// //             let key = input.dataset.key;
// //             if (key in configValues) {
// //                 let value = configValues[key];
// //                 if (value !== parseFloat(input.value)) input.value = value;
// //             }
// //         });
// //
// //         if (configTimeout == null) {
// //             configTimeout = setTimeout(_ => {
// //                 configTimeout = null;
// //                 if (stretch) {
// //                     stretch.configure({
// //                         blockMs: configValues.blockMs,
// //                         intervalMs: configValues.blockMs / configValues.overlap,
// //                         splitComputation: configValues.splitComputation,
// //                     });
// //                 }
// //             }, 50);
// //         }
// //         audioContext.resume();
// //     }
// //
// //     controlsChanged();
// //
// //     $('#upload').onclick = e => $('#upload-file').click();
// //     $('#upload-file').onchange = async e => {
// //         stretch.stop();
// //         await handleFile($('#upload-file').files[0]).catch(e => alert(e.message));
// //         if (stretch) {
// //             controlValues.active = true;
// //             controlsChanged();
// //         }
// //     }
// //
// //     let playbackPosition = $('#playback');
// //     setInterval(_ => {
// //         playbackPosition.max = audioDuration;
// //         playbackPosition.value = stretch?.inputTime;
// //         console.log(`playbackPosition: ${playbackPosition.value}, minutes: ${playbackPosition.value / 60}`);
// //     }, 100);
// //     let playbackHeld = false;
// //
// //     function updatePlaybackPosition(e) {
// //         let inputTime = parseFloat(playbackPosition.value);
// //         let obj = Object.assign({}, controlValues);
// //         if (playbackHeld) obj.rate = 0;
// //         console.log(`updatePlaybackPosition: ${inputTime}, minutes: ${inputTime / 60}`);
// //         stretch.schedule(Object.assign({input: inputTime}, obj));
// //     }
// //
// //     playbackPosition.onmousedown = e => {
// //         playbackHeld = true;
// //     };
// //     playbackPosition.onmouseup = playbackPosition.onmousecancel = e => {
// //         playbackHeld = false;
// //     };
// //     playbackPosition.oninput = playbackPosition.onchange = updatePlaybackPosition;
// // })();
// //
// // // ------------------------------------------------------------
// // // Helpers
// // // ------------------------------------------------------------
// //
// // function setBadgeState(selector, state) {
// //     const el = document.querySelector(selector);
// //     if (!el) return;
// //     el.dataset.state = state; // "ok" | "warn" | "bad" | "idle"
// // }
// //
// // // ------------------------------------------------------------
// // // Server version UI (new)
// // // ------------------------------------------------------------
// // function setServerVersion(version) {
// //     const el = document.querySelector('#server-version');
// //     if (!el) return;
// //     const v = (typeof version === 'string' && version.length) ? version : '0.0.0';
// //     el.textContent = `server: v${v}`;
// //     setBadgeState('#server-version', 'idle');
// // }
// //
// // // ------------------------------------------------------------
// // // Machine status UI (new)
// // // ------------------------------------------------------------
// // function setMachineStatus(msg) {
// //     const el = document.querySelector('#machine-status');
// //     if (!el) return;
// //
// //     if (!msg || typeof msg !== 'object') {
// //         el.textContent = 'machine: ?';
// //         return;
// //     }
// //
// //     const hostname = (typeof msg.hostname === 'string' && msg.hostname.length) ? msg.hostname : '?';
// //     const ip = (typeof msg.ip === 'string' && msg.ip.length) ? msg.ip : '?';
// //     const platform = (typeof msg.platform === 'string' && msg.platform.length) ? msg.platform : '';
// //     const arch = (typeof msg.arch === 'string' && msg.arch.length) ? msg.arch : '';
// //
// //     // Keep it compact for the status bar.
// //     // Example: "machine: ctrl-pi · 192.168.1.42 · Linux 6.1.0-rpi · aarch64"
// //     const parts = [`machine: ${hostname}`, ip !== '?' ? ip : null, platform || null, arch || null].filter(Boolean);
// //     el.textContent = parts.join(' · ');
// //     setBadgeState('#machine-status', 'idle');
// // }
// //
