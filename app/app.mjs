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

function setLocalStorageIfChanged(key, valueNumber, {decimals = 4} = {}) {
    const numberValue = Number(valueNumber);
    if (!Number.isFinite(numberValue)) return false;

    const next = numberValue.toFixed(decimals);
    const prev = localStorage.getItem(key);
    if (prev !== next) {
        localStorage.setItem(key, next);
        return true;
    }
    return false;
}

// ✅ Toggle this
const enableScope = false;

(async () => {
    let audioContext = new AudioContext();

    // Load version.json (best effort). Works when served over HTTP(S).
    // When running from file://, this may fail; WS server will also publish version.
    (async () => {
        try {
            const res = await fetch('./version.json', {cache: 'no-store'});
            if (!res.ok) return;
            const data = await res.json();
            const el = document.querySelector('#server-version');
            if (el && data && typeof data.version === 'string') {
                el.textContent = `server: v${data.version}`;
            }
        } catch {
            // ignore
        }
    })();

    let stretch;
    let audioDuration = 1;

    // HK Added
    let volumeGain = audioContext.createGain();
// HK Added: Stereo panner for balance control (-1..+1)
    let panNode = audioContext.createStereoPanner();
    panNode.pan.value = 0;

    volumeGain.gain.value = 0.35;

    let controlValuesInitial = {
        // HK Added
        volume: 0.35,
        // HK Added: stereo balance (pan) -1..+1
        pan: 0,
        active: false,
        // rate: 1,
        rate: 0.001,
        semitones: 0,
        // tonalityHz: 8000,
        tonalityHz: 16000,
        formantSemitones: 0,
        formantCompensation: false,
        formantBaseHz: 200,
        loopStart: 1,
        loopEnd: 1 // disabled (<= start), but this gets set when we load an audio file
    };
    let controlValues = Object.assign({}, controlValuesInitial);

    // Restore persisted values (guard against NaN / garbage)
    controlValues.volume = clamp(
        toFiniteNumber(localStorage.getItem('volume'), controlValuesInitial.volume),
        0,
        1
    );
    controlValues.pan = clamp(
        toFiniteNumber(localStorage.getItem('pan'), controlValuesInitial.pan),
        -1,
        1
    );

    let configValuesInitial = {
        // blockMs: 120,
        // blockMs: 300,
        blockMs: 70, // bigger blocks = better quality, but slower and makes it sound like a synthesizer
        // For BHS keep the blockMs small (30 to 100Ms is fine)
        // overlap: 7,
        overlap: 1.5,
        splitComputation: true
    };
    let configValues = Object.assign({}, configValuesInitial);

    // ✅ Toggle Scope on/off here
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

    // Drop zone
    document.body.ondragover = event => {
        event.preventDefault();
    }
    document.body.ondrop = handleDrop;

    function handleDrop(event) {
        event.preventDefault();
        var dt = event.dataTransfer;
        handleFile(dt.items ? dt.items[0].getAsFile() : dt.files[0]);
    }

    function handleFile(file) {
        return new Promise((pass, fail) => {
            var reader = new FileReader();
            reader.onload = e => pass(handleArrayBuffer(reader.result));
            reader.onerror = fail;
            reader.readAsArrayBuffer(file);
        });
    }

    async function handleArrayBuffer(arrayBuffer) {
        let audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        audioDuration = audioBuffer.duration;
        let channelBuffers = []
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
        configChanged();
        controlsChanged();
    }

    // fetch audio and add buffer
    let response = await fetch('Black Hole Sun - Soundgarden.mp3');
    handleArrayBuffer(await response.arrayBuffer());

    $('#playstop').onclick = e => {
        controlValues.active = !controlValues.active;
        controlsChanged(0.15);
    };

    // ------------------------------------------------------------
    // Reset buttons (new)
    // ------------------------------------------------------------
    $$('#controls .reset-btn').forEach(btn => {
        btn.onclick = (e) => {
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

    $$('#controls input').forEach(input => {
        let isCheckbox = input.type == 'checkbox';
        let key = input.dataset.key;

        input.oninput = input.onchange = e => {
            let value = isCheckbox ? input.checked : parseFloat(input.value);

            // If a number input is temporarily empty/invalid, don't propagate NaN.
            if (!isCheckbox && !Number.isFinite(value)) return;

            // ✅ UI alias: volumePercent (1..100) -> controlValues.volume (0..1)
            if (key === 'volumePercent') {
                controlValues.volume = clamp(value, 1, 100) / 100;
                controlsChanged();
                return;
            }

            if (key in controlValues) {
                controlValues[key] = value;
                controlsChanged();
            } else if (key in configValues) {
                configValues[key] = value;
                configChanged();
            }
        };

        if (!isCheckbox) input.ondblclick = e => {
            if (key in controlValues) {
                controlValues[key] = controlValuesInitial[key];
                controlsChanged();
            } else if (key in configValues) {
                configValues[key] = configValuesInitial[key];
                configChanged();
            }
        };
    });

    function controlsChanged(scheduleAhead) {
        $('#playstop').innerHTML =
            '<svg alt="toggle play" height="1em" width="1em" viewbox="0 0 8 8" style="vertical-align:middle"><path d="' +
            (controlValues.active ? 'M1 1L3 1 3 7 1 7ZM5 1 7 1 7 7 5 7Z' : 'M1 0L8 4 1 8') +
            '" fill="currentColor"/></svg>';

        $$('#controls input').forEach(input => {
            let key = input.dataset.key;

            // ✅ keep the 1..100 UI in sync with controlValues.volume (0..1)
            if (key === 'volumePercent') {
                const volume01 = clamp(toFiniteNumber(controlValues.volume, 0), 0, 1);
                const percent = clamp(Math.round(volume01 * 100), 1, 100);
                const current = toFiniteNumber(parseFloat(input.value), NaN);
                if (!Number.isFinite(current) || percent !== current) input.value = String(percent);
                return;
            }

            if (key in controlValues) {
                let value = controlValues[key];
                if (value !== parseFloat(input.value)) input.value = value;
            }
        });

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
                }

                function setControllerStatus(msg) {
                    const el = document.querySelector('#controller-status');
                    if (!el) return;

                    if (msg && msg.status === 'connected') {
                        const deviceId = msg.deviceId ?? '?';
                        const fw = msg.fw ?? '?';
                        const port = msg.port ?? '?';
                        el.textContent = `controller: connected · ${deviceId} · fw=${fw} · ${port}`;
                    } else {
                        el.textContent = 'controller: disconnected';
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
                        controlsChanged();
                        return;
                    }

                    // pan -1..+1
                    if (key === 'pan') {
                        const pan = clamp(toFiniteNumber(value, NaN), -1, 1);
                        if (!Number.isFinite(pan)) return;
                        controlValues.pan = pan;
                        controlsChanged();
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
                        controlsChanged();
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

                    // if (msg.type === 'controller') {
                    //     setControllerStatus(msg);
                    //     return;
                    // }

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
                        // Make sure the guard works: drop reference so connect() can create a fresh one.
                        ws = null;
                        scheduleReconnect();
                    };
                }

                return {connect, getStatus: () => status};
            })();

            window.wsControlClient.connect();
        } else {
            // If script runs again, do nothing (existing client keeps running).
            window.wsControlClient.connect();
        }

        // Apply volume immediately
        if (volumeGain) {
            const target = clamp(toFiniteNumber(controlValues.volume, 1), 0, 1);
            setLocalStorageIfChanged('volume', target, {decimals: 4});

            let t = audioContext.currentTime;
            volumeGain.gain.cancelScheduledValues(t);
            volumeGain.gain.setValueAtTime(volumeGain.gain.value, t);
            volumeGain.gain.linearRampToValueAtTime(target, t + 0.03);
        }

        // Apply pan immediately
        if (panNode) {
            const targetPan = clamp(toFiniteNumber(controlValues.pan, 0), -1, 1);
            setLocalStorageIfChanged('pan', targetPan, {decimals: 4});

            let t = audioContext.currentTime;
            panNode.pan.cancelScheduledValues(t);
            panNode.pan.setValueAtTime(panNode.pan.value, t);
            panNode.pan.linearRampToValueAtTime(targetPan, t + 0.03);
        }

        if (stretch) {
            let obj = Object.assign({output: audioContext.currentTime + (scheduleAhead || 0)}, controlValues);
            stretch.schedule(obj);
        }
        audioContext.resume();
    }

    controlsChanged();
    let configTimeout = null;

    function configChanged() {
        $$('#controls input').forEach(input => {
            let key = input.dataset.key;
            if (key in configValues) {
                let value = configValues[key];
                if (value !== parseFloat(input.value)) input.value = value;
            }
        });

        if (configTimeout == null) {
            configTimeout = setTimeout(_ => {
                configTimeout = null;
                if (stretch) {
                    stretch.configure({
                        blockMs: configValues.blockMs,
                        intervalMs: configValues.blockMs / configValues.overlap,
                        splitComputation: configValues.splitComputation,
                    });
                }
            }, 50);
        }
        audioContext.resume();
    }

    controlsChanged();

    $('#upload').onclick = e => $('#upload-file').click();
    $('#upload-file').onchange = async e => {
        stretch.stop();
        await handleFile($('#upload-file').files[0]).catch(e => alert(e.message));
        if (stretch) {
            controlValues.active = true;
            controlsChanged();
        }
    }

    let playbackPosition = $('#playback');
    setInterval(_ => {
        playbackPosition.max = audioDuration;
        playbackPosition.value = stretch?.inputTime;
    }, 100);
    let playbackHeld = false;

    function updatePlaybackPosition(e) {
        let inputTime = parseFloat(playbackPosition.value);
        let obj = Object.assign({}, controlValues);
        if (playbackHeld) obj.rate = 0;
        stretch.schedule(Object.assign({input: inputTime}, obj));
    }

    playbackPosition.onmousedown = e => {
        playbackHeld = true;
    };
    playbackPosition.onmouseup = playbackPosition.onmousecancel = e => {
        playbackHeld = false;
    };
    playbackPosition.oninput = playbackPosition.onchange = updatePlaybackPosition;
})();

// ------------------------------------------------------------
// Server version UI (new)
// ------------------------------------------------------------
function setServerVersion(version) {
    const el = document.querySelector('#server-version');
    if (!el) return;
    const v = (typeof version === 'string' && version.length) ? version : '0.0.0';
    el.textContent = `server: v${v}`;
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

    // Keep it compact for the status bar.
    // Example: "machine: ctrl-pi · 192.168.1.42 · Linux 6.1.0-rpi · aarch64"
    const parts = [`machine: ${hostname}`, ip !== '?' ? ip : null, platform || null, arch || null].filter(Boolean);
    el.textContent = parts.join(' · ');
}

