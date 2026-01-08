### splitComputation is a real-time safety / CPU smoothing switch in Signalsmith Stretch.

When ```splitComputation=true:```

the stretcher adds one extra “interval” of output latency

and uses that extra latency “budget” to spread the heavy spectral work more evenly over time, instead of doing occasional big compute spikes. 
GitHub

When splitComputation=false:

it behaves more like typical spectral processors: most of the time it’s light, but sometimes it does a bigger chunk of work at once to compute the next spectral block. That’s often fine in DAWs / buffered multi-thread contexts, but can be risky in stricter real-time situations. 
GitHub

How this maps to your code

In your app.mjs you’re doing:

stretch.configure({
  blockMs: configValues.blockMs,
  intervalMs: configValues.blockMs / configValues.overlap,
  splitComputation: configValues.splitComputation,
});


So the latency penalty is “one extra interval”, where your interval is:

intervalMs = blockMs / overlap

Example with your defaults: blockMs=70, overlap=1.5 → intervalMs≈46.7ms
So enabling splitComputation costs roughly +46.7ms extra output latency (on top of whatever the algorithm already needs), in exchange for less glitch risk. 
GitHub

Practical advice

Raspberry Pi / AudioWorklet / kiosk web UI: keep it true (more stable).

If you’re chasing minimum latency and your CPU is strong + you’re not getting crackles: try false and see if it stays clean.

If you want, paste your current SignalsmithStretch.mjs wrapper and I can point to where exactly it forwards this flag into the underlying stretcher call.


### In Signalsmith Stretch, **`overlap` controls how much successive analysis/synthesis blocks overlap in time** — i.e. how small the “hop” is between blocks.

In your wrapper you compute:

* `intervalMs = blockMs / overlap`

So:

* **overlap = 1** → `intervalMs = blockMs` (no overlap, big hops)
* **overlap = 2** → 50% overlap (`intervalMs = blockMs/2`)
* **overlap = 4** → 75% overlap (`intervalMs = blockMs/4`)
* **overlap = 1.5** (your current default) → `intervalMs ≈ 0.667 * blockMs`

### What changing overlap does (practically)

**Higher overlap (bigger number):**

* More frequent blocks (smaller hop)
* Usually **smoother / higher quality**, fewer “grainy” transitions, better handling of transients
* **More CPU** (more blocks per second)
* With `splitComputation=true`, it also increases the “extra interval” latency cost because that extra latency is *one interval* (and interval gets smaller when overlap is larger) — so overlap interacts with that latency term. ([signalsmith-audio.co.uk][1])

**Lower overlap (closer to 1):**

* Fewer blocks (bigger hop)
* **Cheaper CPU**
* More likely to sound “steppy”, smeary, or produce timing artifacts on transients because each transient shows up in fewer overlapping frames. ([signalsmith-audio.co.uk][2])

### A good mental model

This is classic **overlap-add / STFT-style processing**: you window audio into blocks and recombine them; overlap determines how densely those windows cover time. ([signalsmith-audio.co.uk][2])

### Rule of thumb for your setup (Pi + touchscreen + realtime)

* If you hear **crackles / CPU stress** → decrease overlap a bit (e.g. 1.5 → 1.25 → 1.0)
* If you hear **graininess / rough modulation** and CPU is fine → increase overlap (e.g. 1.5 → 2.0)

If you tell me your Pi model (3/4/5) and whether you’re running in Chromium kiosk, I can suggest a tighter “safe” range for `blockMs` + `overlap` as a pair.

[1]: https://signalsmith-audio.co.uk/code/stretch/demo/?utm_source=chatgpt.com "Signalsmith Stretch Web Audio demo"
[2]: https://signalsmith-audio.co.uk/writing/2023/stretch-design/?utm_source=chatgpt.com "The Design of Signalsmith Stretch"



_Q: What is the impact on the sound that is playing?_

Good question — this gets to the **audible character** of the stretcher, not just performance.

I’ll describe the impact **as you hear it**, then map it back to `overlap` (and briefly `blockMs`, because they interact).

---

## What `overlap` changes in the *sound*

Think of Signalsmith Stretch as repeatedly asking:

> “How often do I re-decide what the sound should be doing?”

That “how often” is controlled by `intervalMs = blockMs / overlap`.

### 1) **Low overlap (≈ 1.0–1.25)**

**Audible character:**

* More **grainy**
* Transients feel **chunked**
* Sustains may sound slightly **fluttery** or **phasier**
* Pitch/formants can feel less stable at extreme stretch rates

**What’s happening:**

* Each block stands more on its own
* Transitions between blocks are more audible
* The algorithm has fewer chances to “smooth over” changes

**Musically:**

* Can sound *raw*, *mechanical*, *granular*
* Sometimes desirable for experimental textures
* Risk of audible stepping at very slow rates

---

### 2) **Medium overlap (≈ 1.5–2.0)** ← *your current sweet spot*

**Audible character:**

* **Smooth**, coherent time-stretch
* Transients still readable
* Sustains feel continuous
* Very little “grain boundary” perception

**What’s happening:**

* Enough overlapping windows to crossfade spectral decisions
* Transients appear in multiple frames → less tearing
* Phase relationships are more stable

**Musically:**

* Best balance between **clarity** and **stability**
* Especially good for:

  * very slow playback (your Black Hole Sun use case)
  * drones, long tones, vocals
* This is why `1.5` feels “right”

---

### 3) **High overlap (≈ 3–4+)**

**Audible character:**

* Extremely **smooth**
* Transients become **blurred**
* Attacks soften
* Sound can feel slightly **washed / smeared**

**What’s happening:**

* Many overlapping windows average everything
* Sharp events are spread across many frames
* Phase is ultra-stable, but detail is softened

**Musically:**

* Great for ambient pads, infinite drones
* Less good if you want rhythmic articulation
* Can feel “too polite”

---

## Interaction with *very slow playback*

You’re often running rates like `0.01 → 0.003`.

At those rates:

* **Low overlap** → audible stepping / “spectral clicks”
* **Medium overlap** → smooth, evolving textures
* **High overlap** → dreamlike smear, almost static sound mass

This is why overlap becomes *more audible* the slower you go.

---

## Interaction with `blockMs`

These two are inseparable:

* `blockMs` = **how big each decision window is**
* `overlap` = **how often decisions overlap**

Examples:

| blockMs | overlap | Resulting feel         |
| ------- | ------- | ---------------------- |
| large   | low     | chunky, grainy         |
| large   | medium  | slow, cinematic        |
| small   | medium  | articulate, alive      |
| small   | high    | very smooth, CPU-heavy |

Your current:

```
blockMs ≈ 70
overlap ≈ 1.5
```

is a very good **“slow, organic, non-glitchy”** configuration.

---

## One-sentence summary (the ear-level truth)

> **Overlap controls how continuous time feels**:
> low overlap exposes the seams, high overlap hides them.

---

## Practical tuning advice (by ear)

If you want to experiment safely:

* Want **more texture / grit** → lower overlap slightly (1.5 → 1.25)
* Want **more smoothness / dream** → raise overlap slightly (1.5 → 2.0)
* If you hear **flutter or stepping** at ultra-slow rates → overlap is too low
* If you hear **loss of articulation** → overlap is too high

If you want, we can add a **hidden “quality” macro** that moves `blockMs` and `overlap` together in a perceptually linear way — that’s a very nice performance control.

---

### Formant compensation

_Q: And what does formantCompensation and formantBaseHz do?_

Good question — these two are about **how pitch-related spectral structure (formants)** is treated when you stretch or transpose sound. This matters *a lot* for voices, guitars, anything harmonic… and also for how “human” vs “broken” things feel.

I’ll explain them **by ear first**, then technically, then give you **practical settings**, especially aligned with your liking for grit.

---

## First: what are formants (ear-level)

Formants are the **stable resonant peaks** of a sound.

* In **voice**: vowels (the “ah / ee / oo” shape)
* In **instruments**: body resonances (guitar box, piano soundboard)
* In **speech**: what makes a voice sound like *that* person, regardless of pitch

When you slow down or pitch-shift audio:

* **Pitch** wants to move
* **Formants** often *shouldn’t* (if you want natural sound)

Signalsmith gives you control over whether it tries to **keep formants stable** or lets them **move / collapse**.

---

## `formantCompensation` (boolean)

### What it does (in plain language)

> **Should the algorithm try to keep the spectral “shape” of the sound intact when pitch/time changes happen?**

### `formantCompensation = true`

**Sound:**

* Voices stay **recognisably human**
* Vowels remain stable
* Less “chipmunk” or “monster” effect
* Stretching feels more *correct*, less alien

**Perception:**

* Cleaner
* Polite
* Naturalistic
* Slightly less dramatic

### `formantCompensation = false`

**Sound:**

* Formants drift with pitch
* Vowels smear or collapse
* Voices become **ghostly, hollow, broken**
* Instruments lose their body identity

**Perception:**

* More **spectral erosion**
* More **grit**
* More “time chewing on sound”

👉 Given everything you’ve said so far:
**you probably prefer `false`.**

---

## `formantBaseHz` (number, in Hz)

This sets a **reference frequency** for how formant compensation behaves.

Think of it as:

> “What frequency region should be treated as the *anchor* for formants?”

### Typical values

* **Human voice**: ~200–300 Hz
* **Lower male voice**: ~120–180 Hz
* **Generic music**: ~200 Hz (default-ish)

### What changing it does

#### Higher `formantBaseHz` (e.g. 400–800 Hz)

* Formant correction focuses higher in the spectrum
* Low frequencies drift more freely
* Can sound thinner, more brittle

#### Lower `formantBaseHz` (e.g. 80–150 Hz)

* Anchors correction lower
* Keeps body / chest tones more stable
* Upper harmonics smear more

But here’s the key:

> **If `formantCompensation = false`, `formantBaseHz` has little to no audible effect.**

It only really matters **when compensation is enabled**.

---

## Interaction with extreme slow-down (your use case)

At rates like `0.01 → 0.003`:

### Compensation ON

* Sound feels *frozen*
* Vowels hang unnaturally stable
* Almost like a sustained synth
* Beautiful, but controlled

### Compensation OFF

* Formants slide downward
* Vowels dissolve into texture
* Identity erodes over time
* Much more **entropic**

This aligns perfectly with your interest in grit and erosion.

---

## Practical recommendations for *your* work

### If you want **gritty / decaying / memory-loss sound**

```js
formantCompensation: false
formantBaseHz: 200   // irrelevant, but harmless
```

### If you want **recognisable ghost-voice**

```js
formantCompensation: true
formantBaseHz: 180   // low male-ish anchor
overlap: 1.25        // keep some texture
```

### If you want **unnatural but controlled**

```js
formantCompensation: true
formantBaseHz: 400   // exaggerates spectral shift
```

---

## One-sentence ear-level summary

> **Formant compensation decides whether sound keeps its identity or lets time destroy it.**

You’re already exploring a space where *destruction is expressive*, so leaving it **off** is conceptually and sonically consistent.

If you want, next we can:

* map formant compensation to *activity* (wheel movement)
* let formants collapse only when motion stops
* or exaggerate formant drift incarcerated by rate

This is exactly where DSP becomes narrative.
