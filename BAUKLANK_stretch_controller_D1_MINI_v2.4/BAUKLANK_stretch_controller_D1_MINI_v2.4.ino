// v2.5
/*
  BAUKLANK Controller (ESP8266 / D1 mini) - serial protocol

  - On boot: prints a JSON "hello" line
  - Responds to: {"type":"whoareyou"}
  - Every few seconds: sends volume values:
      {"type":"set","key":"volume","value":N}   (N = 1..100)
  - Every 1s (configurable): sweeps rate 0.10 -> 0.50 -> 0.10 in steps of 0.05:
      {"type":"set","key":"rate","value":0.25}

  Wiring: none needed (just USB serial)
*/

#include <Arduino.h>
#include <math.h>
#include <BauklankAnalogReader.h>

#include <TM1637Display.h>  // https://github.com/avishorp/TM1637
#include <TM1637DisplayManager.h>
#include <BauklankTM1637DisplayCharset.h>

#if defined(ESP32)
#define TMD_CLK 13  // (green wire)
#define TMD_DIO 14  // (blue wire)
// VCC is connected to 3.3v           // (orange wire)
// GND is connected to ground         // (yellow wire)
#elif defined(ESP8266)
#define TMD_CLK D1  // (green wire)
#define TMD_DIO D2  // (blue wire)
#endif
#define DISPLAY_BRIGHTNESS 5

TM1637Display display(TMD_CLK, TMD_DIO);
DisplayManager displayManager;  // Direct instance instead of singleton

#if defined(ESP32)
// I recommend using one of these pins, preferably GPIO34, GPIO35, GPIO36, or GPIO39, as they are input-only pins and are part of ADC1.
// These pins are especially suitable because:
// 1. They are dedicated analog input pins
// 2. They can't be used as outputs, which prevents accidental configuration mistakes
// 3. They're part of ADC1, which is more stable than ADC2 (which can be affected by WiFi usage)
// Here's how to connect your potentiometer:
// 1. VCC (3.3V) → Potentiometer's first pin
// 2. GPIO34 (or another ADC1 pin) → Potentiometer's middle pin (wiper)
// 3. GND → Potentiometer's last pin
#define ANALOG_PIN 34
#elif defined(ESP8266)
#define ANALOG_PIN A0
#endif

#define ANALOG_MIN_VALUE 0
#define ANALOG_MAX_VALUE 100  // 0-100% volume range

#define ANALOG_READ_INTERVAL 10
#define ANALOG_NUM_SAMPLES 10

// Create the global instance
AnalogReader analogReader(
  /*pin=*/ANALOG_PIN,
  /*minValue=*/ANALOG_MIN_VALUE,
  /*mmaxValue=*/ANALOG_MAX_VALUE,
  /*readInterval=*/ANALOG_READ_INTERVAL,
  /*numSamples=*/ANALOG_NUM_SAMPLES);

int PLAYER_MINIMUM_VOLUME = 1;
int PLAYER_MAXIMUM_VOLUME = 50;

// --------- Device identity ----------
static const char* deviceType = "bauklank-controller";
static const char* deviceId = "ctrl-01";
static const char* fwVersion = "0.2.10";

// --------- Timing ----------
static const uint32_t volumeResendIntervalMs = 5000;  // configurable refresh
static uint32_t lastVolumeResendMs = 0;

static int lastMappedVolume = -1;
static bool hasVolume = false;

static const uint32_t volumeIntervalMs = 2500;  // random volume cadence
static uint32_t lastVolumeSendMs = 0;

static const uint32_t rateIntervalMs = 1000;  // <-- configurable: 1s by default
static uint32_t lastRateSendMs = 0;
static float lastSentRate = -999.0f;

static const uint32_t volumeDisplayDurationMs = 1200;  // how long volume is shown on display

// --------- Rate sweep config ----------
static const float rateMin = 0.001f;
static const float rateMax = 0.15f;
// static const float rateMax = 11.2f;  // was 0.2
static const float rateStep = 0.001f;
// static const float rateStep = 0.05f;  // was 0.005f

static float currentRate = rateMin;
static int rateDirection = +1;  // +1 up, -1 down

// --------- Serial input buffer ----------
static String lineBuffer;

// --------- Display override guard (volume wins for 2s) ----------
static uint32_t volumeDisplayUntilMs = 0;

static bool pendingRateUpdate = false;
static float pendingRateValue = 0.0f;

// --------- Volume display ----------
static void showVolumeOnDisplay(int volume1to100) {
  if (volume1to100 < 0) volume1to100 = 0;
  if (volume1to100 > 999) volume1to100 = 999;

  char text[5];

  if (volume1to100 < 10) {
    // v␠␠7
    snprintf(text, sizeof(text), "v  %d", volume1to100);
  } else if (volume1to100 < 100) {
    // v␠30
    snprintf(text, sizeof(text), "v %d", volume1to100);
  } else {
    // v100
    snprintf(text, sizeof(text), "v%d", volume1to100);
  }

  displayManager.showMessageImmediate(text, volumeDisplayDurationMs);
  volumeDisplayUntilMs = millis() + volumeDisplayDurationMs;
}

// --------- Rate display ----------
static const bool useRateScalePrefix = false;  // true: m/c/d/i  |  false: always 'r'
static char lastRateDisplayPrefix = '\0';
static int lastRateDisplayMilli = -1;
static int lastRateDisplayCode = -1;

static void rateToDisplay(float rateValue, char* outPrefix, int* outCode) {
  if (rateValue < 0.0f) rateValue = 0.0f;

  char prefix = 'r';
  int code = 0;

  if (useRateScalePrefix) {
    // milli: 0.000..0.999  -> m### (0.001)
    if (rateValue < 1.0f) {
      prefix = 'm';
      code = (int)lroundf(rateValue * 1000.0f);
    }
    // centi: 1.00..9.99 -> c### (0.01)
    else if (rateValue < 10.0f) {
      prefix = 'c';
      code = (int)lroundf(rateValue * 100.0f);
    }
    // deci: 10.0..99.9 -> d### (0.1)
    else if (rateValue < 100.0f) {
      prefix = 'd';
      code = (int)lroundf(rateValue * 10.0f);
    }
    // integer: 100.. -> i###
    else {
      prefix = 'i';
      code = (int)lroundf(rateValue);
    }
  } else {
    // Always 'r' — but still keep it moving above 1.0 by using a single scaling.
    // (Here: centi-rate, so 1.25 -> r125, 12.3 -> r1230 (capped) -> you’ll likely hit 999.)
    // Better: just reuse the same scaling as before but clamp:
    prefix = 'r';
    code = (int)lroundf(rateValue * 1000.0f);  // original milli style
  }

  if (code < 0) code = 0;
  if (code > 999) code = 999;

  *outPrefix = prefix;
  *outCode = code;
}

// static int rateToDisplayCode(float rateValue) {
//   if (rateValue < 0.0f) rateValue = 0.0f;

//   // < 1.0  -> milli (0.001 resolution): 0.010 -> 10  => r010
//   if (rateValue < 1.0f) {
//     return (int)lroundf(rateValue * 1000.0f);
//   }

//   // 1.0..9.99 -> centi (0.01 resolution): 1.50 -> 150 => r150
//   if (rateValue < 10.0f) {
//     return (int)lroundf(rateValue * 100.0f);
//   }

//   // 10..99.9 -> deci (0.1 resolution): 12.3 -> 123 => r123
//   if (rateValue < 100.0f) {
//     return (int)lroundf(rateValue * 10.0f);
//   }

//   // 100+ -> integer (cap)
//   int code = (int)lroundf(rateValue);
//   if (code > 999) code = 999;
//   return code;
// }
static void showRateOnDisplayIfChanged(float rateValue) {
  // Respect your "volume wins" guard
  const uint32_t nowMs = millis();
  if (nowMs < volumeDisplayUntilMs) {
    pendingRateUpdate = true;
    pendingRateValue = rateValue;
    return;
  }

  char prefix = 'r';
  int code = 0;
  rateToDisplay(rateValue, &prefix, &code);

  if (prefix == lastRateDisplayPrefix && code == lastRateDisplayCode) return;
  lastRateDisplayPrefix = prefix;
  lastRateDisplayCode = code;

  char text[5];
  snprintf(text, sizeof(text), "%c%03d", prefix, code);
  displayManager.showMessageImmediate(text, -1);
}

// static void showRateOnDisplayIfChanged(float rateValue) {
//   const int code = rateToDisplayCode(rateValue);

//   // Respect your "volume wins for N ms" guard
//   const uint32_t nowMs = millis();
//   if (nowMs < volumeDisplayUntilMs) {
//     pendingRateUpdate = true;
//     pendingRateValue = rateValue;
//     return;
//   }

//   if (code == lastRateDisplayCode) return;
//   lastRateDisplayCode = code;

//   char text[5];
//   snprintf(text, sizeof(text), "r%03d", code);
//   displayManager.showMessageImmediate(text, -1);
// }

// static int rateToMilli(float rateValue) {
//   // convert 0.010 -> 10, 0.200 -> 200
//   int milli = (int)lroundf(rateValue * 1000.0f);
//   if (milli < 0) milli = 0;
//   if (milli > 999) milli = 999;
//   return milli;
// }

// static void showRateOnDisplayIfChanged(float rateValue) {
//   // If volume is currently displayed, don't touch the display now.
//   // Just remember the latest rate, and apply it after the 2 seconds.
//   const uint32_t nowMs = millis();
//   if (nowMs < volumeDisplayUntilMs) {
//     pendingRateUpdate = true;
//     pendingRateValue = rateValue;
//     return;
//   }

//   const int milli = rateToMilli(rateValue);
//   if (milli == lastRateDisplayMilli) return;
//   lastRateDisplayMilli = milli;

//   char text[5];
//   snprintf(text, sizeof(text), "r%03d", milli);

//   // Set the "base layer" (indefinite)
//   displayManager.showMessageImmediate(text, -1);
// }

static void tickApplyPendingRate(uint32_t nowMs) {
  if (!pendingRateUpdate) return;
  if (nowMs < volumeDisplayUntilMs) return;

  pendingRateUpdate = false;
  showRateOnDisplayIfChanged(pendingRateValue);
}

// ----- analog volume helper -----
static int mapAnalogPercentToPlayerVolume(int analogPercent0to100) {
  int minVol = PLAYER_MINIMUM_VOLUME;
  int maxVol = PLAYER_MAXIMUM_VOLUME;

  // Guard: swap if misconfigured
  if (maxVol < minVol) {
    const int tmp = minVol;
    minVol = maxVol;
    maxVol = tmp;
  }

  // Clamp analog
  if (analogPercent0to100 < 0) analogPercent0to100 = 0;
  if (analogPercent0to100 > 100) analogPercent0to100 = 100;

  // Map 0..100 -> minVol..maxVol
  // (use long math to avoid rounding issues)
  const long mapped = (long)analogPercent0to100 * (maxVol - minVol) / 100L + minVol;
  return (int)mapped;
}

static void tickResendVolume(uint32_t nowMs) {
  if (!hasVolume) return;
  if (nowMs - lastVolumeResendMs < volumeResendIntervalMs) return;
  lastVolumeResendMs = nowMs;

  sendVolumeSet(lastMappedVolume);
}

static void sendHello() {
  Serial.print(F("{\"type\":\"hello\",\"deviceType\":\""));
  Serial.print(deviceType);
  Serial.print(F("\",\"deviceId\":\""));
  Serial.print(deviceId);
  Serial.print(F("\",\"fw\":\""));
  Serial.print(fwVersion);
  Serial.println(F("\"}"));
}

static void sendVolumeSet(int volume1to100) {
  if (volume1to100 < 1) volume1to100 = 1;
  if (volume1to100 > 100) volume1to100 = 100;

  Serial.print(F("{\"type\":\"set\",\"key\":\"volume\",\"value\":"));
  Serial.print(volume1to100);
  Serial.println(F("}"));
}

static void sendRateSet(float rateValue) {
  // Clamp
  if (rateValue < rateMin) rateValue = rateMin;
  if (rateValue > rateMax) rateValue = rateMax;

  // ✅ Dedupe: only send if different from last time
  // Use a small epsilon because floats can be slightly off.
  const float epsilon = 0.0005f;
  if (fabsf(rateValue - lastSentRate) < epsilon) {
    return;
  }
  lastSentRate = rateValue;

  Serial.print(F("{\"type\":\"set\",\"key\":\"rate\",\"value\":"));
  Serial.print(rateValue, 2);
  Serial.println(F("}"));
}

// static void sendRateSet(float rateValue) {
//   // Clamp
//   if (rateValue < rateMin) rateValue = rateMin;
//   if (rateValue > rateMax) rateValue = rateMax;

//   Serial.print(F("{\"type\":\"set\",\"key\":\"rate\",\"value\":"));
//   // Print with 2 decimals to keep it neat: 0.10, 0.15, ...
//   Serial.print(rateValue, 2);
//   Serial.println(F("}"));
// }

// Super-lightweight “parser”: just checks if the incoming line mentions whoareyou.
static bool isWhoAreYouMessage(const String& line) {
  return line.indexOf(F("whoareyou")) >= 0;
}

static void handleSerialLine(const String& line) {
  if (line.length() == 0) return;

  if (isWhoAreYouMessage(line)) {
    sendHello();
  }
}

static void readSerialLines() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') {
      continue;
    } else if (c == '\n') {
      String line = lineBuffer;
      lineBuffer = "";
      line.trim();
      handleSerialLine(line);
    } else {
      if (lineBuffer.length() < 256) {
        lineBuffer += c;
      }
    }
  }
}

static void tickSendRandomVolume(uint32_t nowMs) {
  if (nowMs - lastVolumeSendMs < volumeIntervalMs) return;
  lastVolumeSendMs = nowMs;

  const int randomVolume = random(1, 101);  // 1..100
  sendVolumeSet(randomVolume);
}

static void tickRateSweep(uint32_t nowMs) {
  if (nowMs - lastRateSendMs < rateIntervalMs) return;
  lastRateSendMs = nowMs;

  // Send current value
  sendRateSet(currentRate);


  // ✅ Update display when rate changes
  showRateOnDisplayIfChanged(currentRate);

  // Advance to next step
  currentRate += (float)rateDirection * rateStep;

  // Bounce at ends (avoid overshoot accumulation)
  if (currentRate >= rateMax) {
    currentRate = rateMax;
    rateDirection = -1;
    // Next tick will step downward
    currentRate -= rateStep;
  } else if (currentRate <= rateMin) {
    currentRate = rateMin;
    rateDirection = +1;
    currentRate += rateStep;
  }
}

bool adjustmentMode = false;

void onDisplayTimeout(DisplayManager::TimeoutEvent event) {
  switch (event) {
    case DisplayManager::TimeoutEvent::OVERRIDE_TIMEOUT:
      adjustmentMode = false;
      Serial.println("onDisplayTimeout Adjustment mode ended due to timeout");
      break;

    case DisplayManager::TimeoutEvent::MESSAGE_EXPIRED:
      Serial.println("onDisplayTimeout Message expired");
      break;

    case DisplayManager::TimeoutEvent::COUNTDOWN_FINISHED:
      Serial.println("onDisplayTimeout Countdown finished");
      break;

    case DisplayManager::TimeoutEvent::INDEFINITE_REPLACED:
      Serial.println("onDisplayTimeout Indefinite message temporarily replaced");
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(150);
  Serial.println();
  Serial.println();
  Serial.println();
  Serial.println(F("--------------------------------------------------------------------------------------------"));
  Serial.println(__FILE__);
  Serial.println("Compiled " __DATE__ " at " __TIME__);
  Serial.println(F("--------------------------------------------------------------------------------------------"));

  Serial.println("\nInitializing analog reader");
  analogReader.begin();

  analogReader.registerCallback([](int value) {
    const int mappedVolume = mapAnalogPercentToPlayerVolume(value);

    if (hasVolume && mappedVolume == lastMappedVolume) return;

    lastMappedVolume = mappedVolume;
    hasVolume = true;

    // Send immediately on change
    sendVolumeSet(mappedVolume);

    // ✅ Show volume for 2 seconds, then rate resumes automatically
    showVolumeOnDisplay(mappedVolume);

    //   // Serial.print("Analog value changed: ");
    //   // Serial.println(value);
    //   // Add your code here to handle the analog value change
  });

  analogReader.emitCurrent();
  // -------------------------------------------------------

  Serial.println("\nInitialize DisplayManager");
  // Initialize DisplayManager with the display
  // displayManager.setDebug(true);
  displayManager.begin(display);

  displayManager.setTimeoutCallback(onDisplayTimeout);

  // Show "BOOT" for 2 seconds using showMessage
  displayManager.showMessage("RDY ", 2000);
  // -------------------------------------------------------

  randomSeed(ESP.getCycleCount());

  sendHello();

  // Optional: immediately send initial state
  // sendVolumeSet(50);
  sendRateSet(currentRate);
}

void loop() {
  // Update display manager - THIS IS REQUIRED FOR THE COUNTDOWN or blink TO WORK
  displayManager.update();

  analogReader.update();

  readSerialLines();

  const uint32_t nowMs = millis();
  // tickSendRandomVolume(nowMs);
  tickRateSweep(nowMs);     // for testing do a rate sweep
  tickResendVolume(nowMs);  // ✅ periodic refresh of current volume

  // ✅ If rate changed while volume was shown, apply it right after the 2s window
  tickApplyPendingRate(nowMs);
}
