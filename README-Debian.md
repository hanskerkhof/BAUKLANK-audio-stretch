### 1. Creating a pi user on Debian (the right way)

On Debian (unlike Raspberry Pi OS), pi is not special. You must create it yourself.

Do this once (as root or via sudo):

    sudo adduser pi
    sudo usermod -aG sudo,audio,video,input,dialout pi

Groups matter here:
- sudo → admin access
- audio → ALSA, Pulse, PipeWire
- video → Chromium GPU access
- input → keyboard, mouse, kiosk setups
- dialout → serial devices (important for BAUKLANK controllers)

Then log out and log back in as pi.


### 4. systemd service: one small improvement

Your service file is solid. One tweak I strongly recommend for Chromium + audio:

    [Service]
    User=pi
    SupplementaryGroups=audio video input dialout

Check:



This avoids subtle permission bugs when systemd starts Chromium headless.

Also consider adding:

    Environment=XDG_RUNTIME_DIR=/run/user/1000

Only if you ever see:
- audio device not found
- Pulse / PipeWire complaints
- Chromium audio failing only in systemd




    sudo adduser pi
    sudo usermod -aG sudo,audio,video,input,dialout pi


### Install software

    sudo apt update
    sudo apt install -y git
    sudo apt install -y chromium
    sudo apt install -y curl

    sudo apt install -y python3 python3-pip
    sudo pip3 install --break-system-packages websockets
    sudo apt install -y python3-serial

    sudo apt install -y xdotool
    sudo apt install -y nodejs npm node-semver
    sudo npm i -g http-server
    sudo apt install -y htop
    sudo apt-get install -y iotop


### Clone repo

First launch (safe mode)

In the terminal, run:

    chromium --disable-gpu


### Run it (as user pi)
        
    cd ~/Public/BAUKLANK-audio-stretch/
    ./launch_on_debian.sh


----


### Can we have a method to auto login as the user pi when booting?

Absolutely. And yes, this is exactly right for an installation / artwork machine.

There are two clean ways to do auto-login on Debian.
I’ll give you the recommended one first (display manager level), then the fallback.

You’re likely using LightDM with XFCE, but we’ll verify.

#### Method 1 (recommended): Auto-login via display manager (LightDM)
Step 1: Check which display manager you’re using

Run:

    cat /etc/X11/default-display-manager


If it says:

    /usr/sbin/lightdm


Perfect. Continue below.

(If it says gdm3, tell me and I’ll adapt.)

#### Step 2: Edit LightDM config

Open the config file:

    sudo nano /etc/lightdm/lightdm.conf


If the file is empty or minimal, that’s fine.

Add (or uncomment) this block:

    [Seat:*]
    autologin-user=pi
    autologin-user-timeout=0


Optional but nice for kiosk installs:

    greeter-hide-users=true
    greeter-show-manual-login=false

Step 3: Reboot and test

    sudo reboot


What should happen:

- machine boots
- login screen flashes briefly (or not at all)
- desktop appears logged in as pi
- No clicks. No keyboard. Perfect for installations.

----

Cool. Let’s do it cleanly, as user pi on the Debian box.

1) Generate an SSH key (ed25519)

In a terminal:

ssh-keygen -t ed25519 -C "pi@debian"


When it asks where to save:

press Enter for default (~/.ssh/id_ed25519)

Passphrase:

for an installation machine, it’s fine to press Enter for none

2) Start ssh-agent and add the key


    eval "$(ssh-agent -s)"
    ssh-add ~/.ssh/id_ed25519

3) Copy the public key

Print it:


    cat ~/.ssh/id_ed25519.pub


Copy the whole line (starts with ssh-ed25519).

4) Add it to GitHub


    GitHub → Settings → SSH and GPG keys → New SSH key

Title: something like debian-dx2300-pi

Key: paste the line

5) Test the connection

Back in terminal:

    ssh -T git@github.com


Expected first time:

it asks to confirm host key: type yes

then you should see a message like “successfully authenticated” (GitHub won’t give shell access, that’s normal)

6) Clone your repo


    mkdir -p ~/Public
    cd ~/Public
    git clone git@github.com:hanskerkhof/BAUKLANK-audio-stretch.git

----


You’re very close. Those errors are classic “systemd service tried to touch X, but it doesn’t have the right DISPLAY/XAUTHORITY, and xdotool cannot connect”.

The key lines:

* `Invalid MIT-MAGIC-COOKIE-1 key`
* `Can't open display: (null)`
* `Failed creating new xdo instance`

That means: **your service is running without access to the graphical session**.

## Fix it the clean way (two small changes)

### 1) Run the service only after the graphical session exists

In your service file, you already have `After=... graphical.target`, but that does not guarantee the user session’s X server and cookie are ready.

The robust approach for kiosk installs is: **start from the user’s desktop autostart**, not a system service that tries to “reach into” X.

If you want to keep systemd (totally fine), then do this:

### Option A (recommended): Make it a user service (runs inside pi’s session)

This avoids XAUTHORITY issues completely.

1. Stop and disable the system service:

```bash
sudo systemctl disable --now bauklank-kiosk.service
```

2. Create a user service as `pi`:

```bash
mkdir -p /home/pi/.config/systemd/user
nano /home/pi/.config/systemd/user/bauklank-kiosk.service
```

Paste:

```ini
[Unit]
Description=BAUKLANK Kiosk (audio stretch)
After=graphical-session.target network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/pi/Public/BAUKLANK-audio-stretch
ExecStart=/home/pi/Public/BAUKLANK-audio-stretch/launch_on_debian.sh
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

3. Enable lingering so the user service can start at boot:

```bash
sudo loginctl enable-linger pi
```

4. Enable and start the user service (as `pi`):

```bash
systemctl --user daemon-reload
systemctl --user enable --now bauklank-kiosk.service
```

Logs:

```bash
journalctl --user -u bauklank-kiosk.service -f
```

This solves the display cookie problem because it runs inside pi’s session.

---

### Option B: Keep the system service, but fix DISPLAY/XAUTHORITY properly

If you insist on keeping `/etc/systemd/system/bauklank-kiosk.service`, then:

1. Make sure the service has the correct env and permissions.
   Edit:

```bash
sudo nano /etc/systemd/system/bauklank-kiosk.service
```

Change/add:

```ini
[Service]
User=pi
WorkingDirectory=/home/pi/Public/BAUKLANK-audio-stretch

Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/pi/.Xauthority

# Important: ensure the cookie is accessible
ExecStartPre=/bin/bash -lc 'test -r /home/pi/.Xauthority'

ExecStart=/home/pi/Public/BAUKLANK-audio-stretch/launch_on_debian.sh
```

2. Reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart bauklank-kiosk.service
```

If this still fails, it’s because LightDM sometimes uses a different authority file location or ownership timing. That’s why Option A is more reliable.

---

## About the “other users” journal hint

If you want `pi` to see full system logs without sudo:

```bash
sudo usermod -aG adm pi
```

Log out/in. Then `journalctl` will show more.

---

## My recommendation for gallery reliability

Use **Option A (user service)** or even simpler: **XFCE autostart**. System services touching X are always slightly brittle.

If you tell me which way you prefer (user service vs system service), I’ll give you the final “paste-and-go” exact files for your setup.
