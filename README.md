## BAUKLANK Audio Stretch

Current supported workflows:

- Debian kiosk deployment: see `README-Debian.md`
- macOS local development: use `launch_on_mac.sh`

## 1) Install & Run on macOS (Local Development)

### Install

```bash
cd /Users/hanskerkhof
git clone git@github.com:hanskerkhof/BAUKLANK-audio-stretch.git
cd /Users/hanskerkhof/BAUKLANK-audio-stretch
python3 -m venv .venv
source .venv/bin/activate
pip install pyserial websockets
```

### Run

Run full stack (web server + backend + browser):

```bash
./launch_on_mac.sh
```

Run without opening browser:

```bash
BAUKLANK_OPEN_BROWSER=0 ./launch_on_mac.sh
```

Run browser in kiosk mode:

```bash
./launch_on_mac.sh --kiosk
```

## 2) Install & Run on Debian (Kiosk)

### Install

```bash
sudo apt update
sudo apt install -y git
cd /home/pi/Public
git clone git@github.com:hanskerkhof/BAUKLANK-audio-stretch.git
sudo /home/pi/Public/BAUKLANK-audio-stretch/deploy/debian/provision_debian_kiosk.sh
```

### Run

The provisioner installs and starts the user service automatically.

Check status:

```bash
systemctl --user status bauklank-kiosk.service --no-pager
```

Restart after updates:

```bash
systemctl --user restart bauklank-kiosk.service
```

### Runtime Scripts

- Debian kiosk runtime launcher: `launch_on_debian.sh`
- macOS dev launcher: `launch_on_mac.sh`
- Backend bridge: `server-multi.py`

### Manual Debug Commands

Start backend manually:

```bash
python3 server-multi.py --startup-log-level DEBUG --run-log-level DEBUG --engine-count 2
```

Serve frontend manually:

```bash
python3 -m http.server 8080 --directory app/multi
```

Then open:

- `http://127.0.0.1:8080/index.html?engines=2`
- `http://127.0.0.1:8080/index.html?engines=1&slot=A`
- `http://127.0.0.1:8080/index.html?engines=1&slot=B`
