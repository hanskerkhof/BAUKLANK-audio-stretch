# Raspberry Pi OS Hardening for Power-Loss-Resilient Installations

This setup is optimized for **kiosk / installation use** where power can be cut without warning.
Goal: **minimize disk writes, prevent filesystem corruption, and ensure deterministic reboot behavior**.

---

## 1. Chromium disk cache in RAM (`/run/chromium-cache`)

**Why**
Chromium writes *a lot* to its disk cache. Writing this to RAM:

* eliminates SSD wear
* removes corruption risk on power loss
* improves performance

**How it works**

* `/run` is already a `tmpfs` (RAM-backed filesystem)
* Contents are **automatically cleared on reboot**
* This is fine: cache is disposable

**Setup**

```bash
sudo mkdir -p /run/chromium-cache
sudo chown pi:pi /run/chromium-cache
```

**Chromium launch flags**

```bash
--disk-cache-dir=/run/chromium-cache
```

**Persistence over reboots**

* No extra work needed
* `/run` is recreated automatically at boot
* The directory is created early by systemd

✅ Cache survives crashes
❌ Cache does *not* persist across reboots (intended)

---

## 2. Keep application state while cache is in RAM

**Key distinction**

* **Disk cache** → RAM (`/run`)
* **User data / LocalStorage** → SSD (persistent)

**Chromium flag**

```bash
--user-data-dir=/home/pi/.config/chromium-kiosk
```

This ensures:

* `localStorage`, IndexedDB, app state **survive reboot**
* only *volatile* data lives in RAM

---

## 3. Mount boot filesystem read-only (`/boot/firmware`)

**Why**

* Boot partition is FAT (no journal, corruption-prone)
* Almost never needs writes in production
* fsck warnings disappear after hard power cuts

**fstab**

```ini
PARTUUID=xxxx-01  /boot/firmware  vfat  defaults,ro,noatime  0  2
```

**Operational consequence**

* Firmware updates require a temporary remount:

```bash
sudo mount -o remount,rw /boot/firmware
```

**After update**

```bash
sudo mount -o remount,ro /boot/firmware
```

✅ Boot partition protected
⚠️ Must remount RW for kernel / firmware updates

---

## 4. Minimize ext4 journal churn on root filesystem

**Why**
Even with SSD, frequent journal commits increase:

* write amplification
* recovery time after power loss

**Mount options used**

```ini
PARTUUID=xxxx-02  /  ext4  defaults,noatime,commit=60,errors=remount-ro  0  1
```

**What these do**

* `noatime` → no read-access writes
* `commit=60` → journal flush every 60s instead of ~5s
* `errors=remount-ro` → filesystem protects itself if corruption occurs

**Result**

* Fewer writes
* Safer behavior on sudden power loss
* Slightly more data at risk (≤60s) — acceptable for read-heavy installations

---

## 5. Swap behavior (optional but recommended)

On 8 GB Pis:

* swap is effectively unused
* safe to keep small or disable entirely

Check:

```bash
swapon --show
```

Optional disable:

```bash
sudo dphys-swapfile swapoff
sudo systemctl disable dphys-swapfile
```

---

## 6. What “good” looks like (verification)

### Disk activity

```bash
iotop
```

Expected:

* near-zero writes at idle
* occasional `jbd2` activity only

### Mount status

```bash
mount | grep boot
mount | grep ' on / '
```

### Power-cut test result

* fsck runs automatically
* system boots cleanly
* kiosk restarts without manual intervention

---

> **Outcome**
> The Pi now behaves like an embedded appliance:
>
> * power-loss tolerant
> * minimal disk writes
> * predictable recovery
> * no heroics required

This is the exact sweet spot between **Linux flexibility** and **ESP-like determinism**.

If you want, next logical steps would be:

* `/health` endpoint spec
* write-protected root with overlayfs (advanced)
* automatic self-test banner on boot

But what you have now is already **gallery-grade reliable**.
