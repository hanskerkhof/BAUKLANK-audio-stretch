    User:     pi
    Password: raspberry!

### Add ssh key on rp

    ssh-keygen -t ed25519 -C "hans@netmatic.nl"

#### add it to github

    cat ~/.ssh/id_ed25519.pub 

Paste it into github settings -> SSH and GPG keys -> New SSH key

## How to run on Raspberry Pi

### Clone the repo (user must be 'pi')

    cd ~/Public
    git clone git@github.com:hanskerkhof/BAUKLANK-audio-stretch.git

### Install prerequisites (linux raspbian bookworm)

    sudo apt update -y
    sudo apt install -y xdotool
    sudo apt install -y nodejs npm node-semver
    sudo npm i -g http-server
    sudo apt-get install -y iotop
    sudo pip3 install --break-system-packages websockets

chmod for the startup script to work:
**NOTE: This is not needed, check the Nice to know setion on how to chmod for a file in git**

    sudo chmod +x /home/pi/Public/BAUKLANK-audio-stretch/launch_on_pi.sh


RUN (as user 'pi'):

    /home/pi/Public/BAUKLANK-audio-stretch/launch_on_pi.sh

**NOTE:** This will run the stack manually, normally it is started with the systemd service. If the service is running you have to stop it first with the command: `sudo systemctl stop bauklank-kiosk.service`

## How to install as a systemd service

1. Add a new service file


    sudo nano /etc/systemd/system/bauklank-kiosk.service

2. Add the following content:


    [Unit]
    Description=BAUKLANK Kiosk (audio stretch)
    After=network-online.target graphical.target
    Wants=network-online.target
    
    [Service]
    Type=simple
    User=pi
    WorkingDirectory=/home/pi/Public/BAUKLANK-audio-stretch
    
    Environment=DISPLAY=:0
    Environment=XAUTHORITY=/home/pi/.Xauthority
    
    ExecStart=/home/pi/Public/BAUKLANK-audio-stretch/launch_on_pi.sh
    
    Restart=on-failure
    RestartSec=2
    TimeoutStopSec=15
    KillSignal=SIGTERM
    
    [Install]
    WantedBy=graphical.target

3) Enable + start


    sudo systemctl daemon-reload
    sudo systemctl enable --now bauklank-kiosk.service

4) Control it cleanly

Stop

    sudo systemctl stop bauklank-kiosk.service

Restart (after edits)

    sudo systemctl restart bauklank-kiosk.service

Logs:

    journalctl -u bauklank-kiosk.service -f

Status:

    systemctl status bauklank-kiosk.service


### Manual start on Pi for debugging

Run the following commands (each in a new terminal):

The server:

    python3 server-multi.py

The app:

    npx http-server app/multi -p 8080 -c-1 -o




---

## Development

### Run on mac

Run server.py either from pyCharm or from the command line:

    python3 server.py

Serve the frontend from a terminal

    npx http-server app -p 8080 -c-1 -o

https://github.com/Signalsmith-Audio/pitch-time-example-code

## Nice to know:

### Set the executable bit on a file

On your development machine (or anywhere with a clean repo):

    git update-index --chmod=+x launch_on_pi.sh
    git commit -m "Make launch_on_pi.sh executable"
    git push

From then on, the file will come out executable after every pull/checkout automatically.

Then on the Pi:

    git pull

Check if Git already tracks it:

    git ls-files -s launch_on_pi.sh

If you see 100755 → executable is tracked.
If you see 100644 → not executable.


---


Pitch shifter

TODO for black hole sun


Making a Pitch Shifter
https://www.youtube.com/watch?v=PjKlMXhxtTM



Four Ways To Write A Pitch-Shifter - Geraint Luff - ADC22
https://www.youtube.com/watch?v=fJUmmcGKZMI


https://github.com/Signalsmith-Audio/pitch-time-example-code


his is the code used to produce the audio demos for the ADC22 presentation: Four Ways To Write A Pitch-Shifter. It aimes for simplicity rather than performance.
The ideas from this code are used in the Signalsmith Stretch library.


https://signalsmith-audio.co.uk/code/stretch/

Web demo

https://signalsmith-audio.co.uk/code/stretch/demo/

Repo's:

https://github.com/Signalsmith-Audio/signalsmith-stretch




#### All Chromium command line switches
https://peter.sh/experiments/chromium-command-line-switches/


## Setup Hifiberry Amp2

To setup the Hifiberry Amp2 you'll have to start by removing the driver for the onboard sound.

    sudo nano /boot/firmware/config.txt

Remove the line ```dtparam=audio=on``` and add the line ```dtoverlay=hifiberry-dacplus```

The final part of the file will look something like this:

    # For more options and information see
    # http://rptl.io/configtxt
    # Some settings may impact device functionality. See link above for details
    
    # Uncomment some or all of these to enable the optional hardware interfaces
    #dtparam=i2c_arm=on
    #dtparam=i2s=on
    #dtparam=spi=on
    
    # Enable audio (loads snd_bcm2835)

    # Enable audio (loads snd_bcm2835)
    # >>>> outcomment the default audio driver <<<<
    # dtparam=audio=on
    # >>>> Add this for to enable hifiberry Amp2 or DAC+ <<<<
    dtoverlay=hifiberry-dacplus
    # >>>> Add this for ZERO / MINIAMP <<<<
    # dtoverlay=hifiberry-dac
    
    # Additional overlays and parameters are documented
    # /boot/firmware/overlays/README
    
    # Automatically load overlays for detected cameras
    camera_auto_detect=1
    
    # Automatically load overlays for detected DSI displays
    display_auto_detect=1
    
    # Automatically load initramfs files, if found
    auto_initramfs=1
    
    # Enable DRM VC4 V3D driver
    #dtoverlay=vc4-kms-v3d
    # >>> important add ,noaudio <<<
    dtoverlay=vc4-kms-v3d,noaudio
    max_framebuffers=2
    
    # Don't have the firmware create an initial video= setting in cmdline.txt.
    # Use the kernel's default instead.
    disable_fw_kms_setup=1
    
    # Run in 64-bit mode
    arm_64bit=1
    
    # Disable compensation for displays with overscan
    disable_overscan=1
    
    # Run as fast as firmware / board allows
    arm_boost=1
    
    [cm4]
    # Enable host mode on the 2711 built-in XHCI USB controller.
    # This line should be removed if the legacy DWC2 controller is required
    # (e.g. for USB device mode) or if USB support is not required.
    otg_mode=1
    
    [cm5]
    dtoverlay=dwc2,dr_mode=host
    
    [all]

Configure ALSA
According to the Hifiberry site this part should be optional, but I couldn't get my amp2 to work without it.
Create the file /etc/asound.conf

    sudo nano /etc/asound.conf

with following content:
pcm.!default {
    type hw card 0
}
ctl.!default {
    type hw card 0
}

Make sure you have no .asound.conf file with different settings in your home directory, if there is delete it (or rename it)
Reboot to start with the new settings and check if the device is listed by typing aplay -l:

    aplay -l

Should output something like:

    **** List of PLAYBACK Hardware Devices ****
    card 0: sndrpihifiberry [snd_rpi_hifiberry_dacplus], device 0: HiFiBerry DAC+ HiFi pcm512x-hifi-0 []
      Subdevices: 0/1
      Subdevice #0: subdevice #0

Alsa

    amixer

Should output something like:

    Simple mixer control 'Master',0
      Capabilities: pvolume pswitch pswitch-joined
      Playback channels: Front Left - Front Right
      Limits: Playback 0 - 65536
      Mono:
      Front Left: Playback 26214 [40%] [on]
      Front Right: Playback 26214 [40%] [on]
    Simple mixer control 'Capture',0
      Capabilities: cvolume cswitch cswitch-joined
      Capture channels: Front Left - Front Right
      Limits: Capture 0 - 65536
      Front Left: Capture 65536 [100%] [on]
      Front Right: Capture 65536 [100%] [on]

To set the volume:

    amixer sset Master 40%

Speaker test

    speaker-test -t wav -f 600 -c2 -l2
    speaker-test -t sine -f 600 -c2 -l2

----

https://choosealicense.com/licenses/
