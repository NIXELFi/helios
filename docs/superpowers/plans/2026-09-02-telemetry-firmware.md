# Telemetry Firmware (`sdm-telemetry-fw`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ESP32-S3 firmware that opens its own telemetry session, streams `live_fast` at 10 Hz over a persistent WebSocket to Supabase Realtime, and ships HTP/1 frames to `telemetry-ingest` with the protocol's retry semantics — first over Wi-Fi on a devkit, then over Cat-1 LTE on the LILYGO T-SIM7670G-S3, then fed by the Link G4X CAN bus.

**Architecture:** PlatformIO project on the ESP-IDF framework, split into components with one responsibility each (`htp` encoder, `livepack`, `rtws` Realtime client, `uplink` retry queue + HTTP, `session`, `canbus`, `transport`). Protocol code is pure C with no ESP dependencies so it runs and is tested on the host (`native` env) against the golden fixtures vendored from `crates/helios-htp/fixtures` in the Helios repo. Three FreeRTOS tasks: sampler (CAN → latest values), live publisher (100 ms tick), uplink (1 s windows → bounded queue → batched POSTs).

**Tech Stack:** PlatformIO (per-user pip install, no admin), ESP-IDF 5.x via `framework = espidf`, managed components `espressif/esp_websocket_client` and `espressif/esp_modem`, mbedTLS (HMAC-SHA256, TLS), Unity tests on `native` (PlatformIO's bundled MinGW GCC), Python 3 for the channel-set code generator.

**Spec:** `Helios/docs/superpowers/specs/2026-09-02-cellular-telemetry-fast-path.md`. **Prerequisite:** plan A tasks 4–8 done (fixtures exist, migration + `telemetry-session` deployed, `helios-telemetry-gen` proven against prod) — this plan copies the gen's behaviour into C.

**Machine facts:** no ESP toolchain, no admin, `python` present, `cargo` present. PlatformIO installs into `%USERPROFILE%\.platformio` without admin. Hardware for M1: ESP32-S3-DevKitC-1 N8R8; for M2: LILYGO T-SIM7670G-S3 (verify availability; fallback T-SIM7080G-S3 = Cat-M1, `esp_modem` device `SIM7080`); M3: SN65HVD230 breakout.

**Secrets never in git:** `include/secrets.h` (gitignored, template committed) carries Wi-Fi creds, `TELEMETRY_HMAC_KEY`, the device JWT (plan A task 6), project URL + anon key.

---

## File map

```
sdm-telemetry-fw/
  platformio.ini
  sdkconfig.defaults
  partitions.csv
  README.md
  .gitignore
  include/secrets.h.template   include/secrets.h (gitignored)
  include/config.h             # LIVE_HZ, WINDOWS_PER_POST, QUEUE_WINDOWS, DEVICE_ID
  fixtures/                    # vendored copy of Helios/crates/helios-htp/fixtures (+ VERSION file with the Helios commit)
  tools/gen_channel_set.py     # channel_set_1.json → components/htp/channel_set_gen.{h,c}
  components/htp/              htp.h htp.c channel_set_gen.h channel_set_gen.c CMakeLists.txt
  components/livepack/         livepack.h livepack.c b64.h b64.c CMakeLists.txt
  components/uplink/           queue.h queue.c uplink.h uplink.c CMakeLists.txt      (queue = pure C; uplink = ESP)
  components/rtws/             rtws.h rtws.c CMakeLists.txt                          (ESP; Phoenix over esp_websocket_client)
  components/session/          session.h session.c CMakeLists.txt                    (ESP; esp_http_client + HMAC)
  components/transport/        transport.h transport_wifi.c transport_lte.c CMakeLists.txt
  components/sampler/          sampler.h sampler.c sampler_synth.c sampler_can.c CMakeLists.txt
  main/                        main.c CMakeLists.txt
  test/common/                 fixture_io.h fixture_io.c units.c    (shared; each suite #includes units.c)
  test/test_htp/test_htp.c     test/test_livepack/test_livepack.c   test/test_queue/test_queue.c
                               (one PlatformIO suite = one directory = one main(); `-f <dir>` filters by suite)
```

---

### Task 0: Toolchain + repo skeleton

**Files:** `platformio.ini`, `.gitignore`, `README.md`, `include/secrets.h.template`, `include/config.h`, `sdkconfig.defaults`, `partitions.csv`

- [ ] **Step 1: Install PlatformIO per-user**

```bash
python -m pip install --user platformio
python -m platformio --version        # expect "PlatformIO Core, version 6.x"
```

If `pio` is not on PATH, use `python -m platformio` everywhere below (aliased as `pio`).

- [ ] **Step 2: Create the repo**

```bash
mkdir -p /c/Users/nmurray/Documents/sdm-telemetry-fw && cd "$_"
git init -b main
mkdir -p include components main test/common test/test_htp test/test_livepack test/test_queue tools fixtures
```

`.gitignore`:

```
.pio/
include/secrets.h
sdkconfig
sdkconfig.*
!sdkconfig.defaults
managed_components/
dependencies.lock
```

`platformio.ini`:

```ini
[platformio]
default_envs = devkit-wifi

; ---------- shared ----------
[env]
build_flags = -Wall -Wextra -Werror=return-type -Icomponents/htp -Icomponents/livepack -Icomponents/uplink -Iinclude

; ---------- host tests: protocol code only, no ESP-IDF ----------
[env:native]
platform = native
; -lm last: htp.c uses floor/isfinite; MinGW links libm implicitly, the Ubuntu CI runner does not
build_flags = ${env.build_flags} -DHOST_BUILD -std=gnu11 -Itest/common -lm
build_src_filter = -<*>
test_framework = unity
test_build_src = no
lib_deps =
; Each test/<suite>/ dir is one binary with one main(); suites #include ../common/units.c to pull
; the pure-C components in without a lib_deps dance.

; ---------- ESP32-S3 DevKitC-1 on Wi-Fi (milestone 1) ----------
[env:devkit-wifi]
platform = espressif32
board = esp32-s3-devkitc-1
framework = espidf
board_build.partitions = partitions.csv
build_flags = ${env.build_flags} -DTRANSPORT_WIFI=1
monitor_speed = 115200
monitor_filters = esp32_exception_decoder

; ---------- LILYGO T-SIM7670G-S3 on LTE (milestone 2) ----------
[env:t-sim7670g]
platform = espressif32
board = esp32-s3-devkitc-1
framework = espidf
board_build.partitions = partitions.csv
build_flags = ${env.build_flags} -DTRANSPORT_LTE=1 -DMODEM_SIM7670=1
monitor_speed = 115200
monitor_filters = esp32_exception_decoder
```

`main/idf_component.yml` (ESP-IDF managed components; PlatformIO honours it):

```yaml
dependencies:
  espressif/esp_websocket_client: "^1.2.3"
  espressif/esp_modem: "^1.2.0"
```

`partitions.csv`:

```
# Name,   Type, SubType, Offset,  Size
nvs,      data, nvs,     0x9000,  0x6000
phy_init, data, phy,     0xf000,  0x1000
factory,  app,  factory, 0x10000, 0x300000
```

`sdkconfig.defaults` (the latency-relevant bits):

```
CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y
CONFIG_SPIRAM=y
CONFIG_SPIRAM_MODE_OCT=y
CONFIG_SPIRAM_SPEED_80M=y
CONFIG_SPIRAM_USE_MALLOC=y
CONFIG_ESP_MAIN_TASK_STACK_SIZE=8192
CONFIG_MBEDTLS_HARDWARE_SHA=y
CONFIG_MBEDTLS_HARDWARE_AES=y
CONFIG_MBEDTLS_SSL_PROTO_TLS1_3=y
CONFIG_MBEDTLS_CLIENT_SSL_SESSION_TICKETS=y
CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y
CONFIG_ESP_TLS_INSECURE=n
CONFIG_LWIP_TCP_KEEPALIVE=y
CONFIG_LWIP_SO_RCVBUF=y
CONFIG_LWIP_PPP_SUPPORT=y
CONFIG_LWIP_PPP_PAP_SUPPORT=y
CONFIG_LWIP_PPP_CHAP_SUPPORT=y
CONFIG_FREERTOS_HZ=1000
CONFIG_ESP_TASK_WDT_TIMEOUT_S=30
```

`include/config.h`:

```c
#pragma once
#define DEVICE_ID          "sdm26-car-1"
#define CHANNEL_SET_ID     1
#define LIVE_HZ            10          /* live_fast cadence; 5 halves Realtime quota, +50 ms latency */
#define WINDOWS_PER_POST   4           /* HTP/1 batching; latency-irrelevant on the durable path */
#define QUEUE_WINDOWS      240         /* 4 min of retry queue per group, PSRAM (~700 B/window-set) */
#define HTTP_TIMEOUT_MS    8000
#define RT_HEARTBEAT_MS    25000
```

`include/secrets.h.template`:

```c
#pragma once
#define WIFI_SSID          "..."
#define WIFI_PASS          "..."
#define SUPABASE_URL       "https://dlmyixonuyckxkknolku.supabase.co"
#define SUPABASE_ANON_KEY  "eyJ..."
#define TELEMETRY_HMAC_KEY "..."       /* same value as the edge-function secret */
#define DEVICE_JWT         "eyJ..."    /* node scripts/mint-device-jwt.mjs --device sdm26-car-1 */
#define LTE_APN            "hologram"  /* carrier APN for milestone 2 */
```

`README.md`: one paragraph pointing at the spec, the three envs, `cp include/secrets.h.template include/secrets.h`, and the milestone list from the spec §5.

- [ ] **Step 3: Vendor the fixtures**

```bash
cp -r /c/Users/nmurray/Documents/Helios/crates/helios-htp/fixtures/* fixtures/
git -C /c/Users/nmurray/Documents/Helios rev-parse HEAD > fixtures/VERSION
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: PlatformIO skeleton (native/devkit-wifi/t-sim7670g), config, vendored HTP fixtures"
```

---

### Task 1: Channel-set code generator

**Files:** `tools/gen_channel_set.py`, `components/htp/channel_set_gen.h`, `components/htp/channel_set_gen.c`

The firmware bakes the channel set in at build time (spec: sets are immutable; changing channels = new set id + reflash).

- [ ] **Step 1: Write the generator**

```python
#!/usr/bin/env python3
"""fixtures/channel_set_1.json -> components/htp/channel_set_gen.{h,c}
Run: python tools/gen_channel_set.py   (commit the output)"""
import json, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
src = json.loads((root / "fixtures/channel_set_1.json").read_text())
groups = sorted(((int(k), g) for k, g in src["groups"].items()), key=lambda kg: kg[0])

h = ["/* GENERATED by tools/gen_channel_set.py — do not edit */", "#pragma once", "#include \"htp.h\"", ""]
c = ["/* GENERATED by tools/gen_channel_set.py — do not edit */", "#include \"channel_set_gen.h\"", ""]
h.append(f"#define CS_ID {1}")
h.append(f"#define CS_GROUP_COUNT {len(groups)}")
total = 0
for gk, g in groups:
    n = len(g["channels"])
    h.append(f"#define CS_G{gk}_RATE_HZ {g['rate_hz']}")
    h.append(f"#define CS_G{gk}_CHANNELS {n}")
    c.append(f"static const htp_channel_t g{gk}_channels[{n}] = {{")
    for ch in g["channels"]:
        enc = "HTP_ENC_F32" if ch["enc"] == "f32" else "HTP_ENC_I16FP"
        c.append(f'  {{ "{ch["id"]}", {enc}, {ch.get("scale", 1.0)!r}, {ch.get("offset", 0.0)!r} }},')
    c.append("};")
    total += n
h.append(f"#define CS_LIVE_CHANNELS {total}")
h.append("extern const htp_group_t CS_GROUPS[CS_GROUP_COUNT];")
h.append("extern const uint8_t CS_GROUP_KEYS[CS_GROUP_COUNT];")
c.append(f"const uint8_t CS_GROUP_KEYS[CS_GROUP_COUNT] = {{ {', '.join(str(gk) for gk, _ in groups)} }};")
c.append(f"const htp_group_t CS_GROUPS[CS_GROUP_COUNT] = {{")
for gk, g in groups:
    c.append(f"  {{ {gk}, {g['rate_hz']}, {len(g['channels'])}, g{gk}_channels }},")
c.append("};")
(root / "components/htp/channel_set_gen.h").write_text("\n".join(h) + "\n")
(root / "components/htp/channel_set_gen.c").write_text("\n".join(c) + "\n")
print(f"wrote {len(groups)} groups, {total} channels")
```

- [ ] **Step 2: Run it after Task 2 defines `htp.h`** (it only needs the types). Expected output: `wrote 3 groups, 38 channels`. Spot-check: `CS_G0_CHANNELS 22`, `CS_G1_RATE_HZ 10`, `CS_LIVE_CHANNELS 38`, `engine.lambda` row has `0.0001, 0.6`.

---

### Task 2: `htp` component — HTP/1 encoder (pure C)

**Files:** `components/htp/htp.h`, `components/htp/htp.c`, `components/htp/CMakeLists.txt`, `test/common/fixture_io.{h,c}`, `test/common/units.c`, `test/test_htp/test_htp.c`

- [ ] **Step 1: Header (the API the rest of the firmware uses)**

`components/htp/htp.h`:

```c
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <math.h>

#define HTP_MAGIC        0x4854u
#define HTP_VERSION      1
#define HTP_HEADER_LEN   36
#define HTP_MAX_WINDOWS  8
#define HTP_I16_NULL     ((int16_t)0x8000)
#define HTP_NULL         NAN          /* callers pass NAN for a missing sample */

typedef enum { HTP_ENC_I16FP = 0, HTP_ENC_F32 = 1 } htp_enc_t;

typedef struct {
  const char *id;
  htp_enc_t   enc;
  double      scale;
  double      offset;
} htp_channel_t;

typedef struct {
  uint8_t             key;
  uint16_t            rate_hz;
  uint16_t            channel_count;
  const htp_channel_t *channels;
} htp_group_t;

typedef struct {
  uint8_t  session_id[16];
  uint16_t channel_set_id;
  uint8_t  group_key;
  uint32_t first_seq;
  uint64_t send_timestamp_ms;
} htp_header_t;

/* One window's samples: values[ch * rate_hz + i], row-major per channel. */
typedef struct {
  uint64_t     t_start_us;
  const double *values;   /* channel_count * rate_hz doubles */
} htp_window_t;

size_t htp_channel_width(const htp_channel_t *ch);
size_t htp_window_bytes(const htp_group_t *g);
size_t htp_frame_bytes(const htp_group_t *g, uint8_t window_count);

/* Encodes one sample into out (2 or 4 bytes). NAN/inf -> null sentinel / NaN. */
void htp_encode_sample(const htp_channel_t *ch, double v, uint8_t *out);

/* Little-endian writers, public so the uplink can assemble frames from
 * pre-encoded window bodies without re-encoding. */
void htp_put_u16(uint8_t *p, uint16_t v);
void htp_put_u32(uint8_t *p, uint32_t v);
void htp_put_u64(uint8_t *p, uint64_t v);
/* Writes the 36-byte header. Returns HTP_HEADER_LEN, or 0 if window_count is out of 1..8. */
size_t htp_write_header(const htp_header_t *h, uint8_t window_count, uint8_t *out);
/* Encodes one window's samples (no t_start_us) into out; returns bytes or 0 if cap too small. */
size_t htp_encode_window_body(const htp_group_t *g, const double *values, uint8_t *out, size_t cap);

/* Writes a full frame. Returns bytes written, or 0 if out_cap too small /
 * window_count out of 1..8. Byte-exact with crates/helios-htp. */
size_t htp_encode_frame(const htp_group_t *g, const htp_header_t *h,
                        const htp_window_t *windows, uint8_t window_count,
                        uint8_t *out, size_t out_cap);
```

`components/htp/CMakeLists.txt`:

```cmake
idf_component_register(SRCS "htp.c" "channel_set_gen.c" INCLUDE_DIRS ".")
```

- [ ] **Step 2: Failing host test against the golden fixtures**

`test/common/fixture_io.h`:

```c
#pragma once
#include <stddef.h>
#include <stdint.h>
/* Reads fixtures/<rel>; returns malloc'd buffer, sets *len. Aborts test on failure. */
uint8_t *fixture_read(const char *rel, size_t *len);
```

`test/common/units.c` — pulls the pure-C units under test into whichever suite `#include`s it (PlatformIO only compiles files inside the suite directory, so a shared file must be included, not listed):

```c
/* #include "../common/units.c" from exactly one file per suite. */
#include "../../components/htp/htp.c"
#include "../../components/htp/channel_set_gen.c"
#include "../../components/livepack/b64.c"
#include "../../components/livepack/livepack.c"
#include "../../components/uplink/queue.c"
#include "fixture_io.c"
```

`test/common/fixture_io.c`:

```c
#include "fixture_io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "unity.h"

uint8_t *fixture_read(const char *rel, size_t *len) {
  char path[512];
  snprintf(path, sizeof path, "fixtures/%s", rel);      /* pio test runs from the project root */
  FILE *f = fopen(path, "rb");
  if (!f) { TEST_FAIL_MESSAGE(path); return NULL; }
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  uint8_t *buf = malloc((size_t)n);
  fread(buf, 1, (size_t)n, f); fclose(f);
  *len = (size_t)n;
  return buf;
}
```

`test/test_htp/test_htp.c` — a tiny hand JSON reader is not worth it; the fixture `.json` files are only needed for **values**, which `value()` in `gen-fixtures.rs` defines deterministically. Re-implement that function here (it is 4 lines) and byte-compare the encoder output to the `.htp`:

```c
#include "unity.h"
#include "htp.h"
#include "channel_set_gen.h"
#include "fixture_io.h"
#include "../common/units.c"
#include <stdlib.h>
#include <string.h>

void setUp(void) {}
void tearDown(void) {}

/* Mirrors gen-fixtures.rs::value(). Keep in lockstep. */
static double fixture_value(uint8_t g, size_t c, size_t s) {
  if ((c + s) % 13 == 12) return NAN;
  double base = g == 0 ? 100.0 * (c + 1.0) : g == 1 ? 33.0 + c : 20.0 + c;
  return base + s * 0.25 - c * 0.125;
}

static const uint8_t SESSION[16] = {0x9b,0x2f,0x1c,0x3e,0x4d,0x5a,0x4b,0x6c,0x8d,0x7e,0x0f,0x1a,0x2b,0x3c,0x4d,0x5e};

static void check_group(uint8_t gi, uint8_t nwin) {
  const htp_group_t *g = &CS_GROUPS[gi];
  size_t per = (size_t)g->channel_count * g->rate_hz;
  double *vals = malloc(sizeof(double) * per * nwin);
  htp_window_t win[HTP_MAX_WINDOWS];
  for (uint8_t w = 0; w < nwin; w++) {
    for (size_t c = 0; c < g->channel_count; c++)
      for (size_t s = 0; s < g->rate_hz; s++)
        vals[w * per + c * g->rate_hz + s] = fixture_value(g->key, c, s + (size_t)w * 100);
    win[w].t_start_us = 1781234560000000ULL + (uint64_t)w * 1000000ULL;
    win[w].values = &vals[w * per];
  }
  htp_header_t h = { .channel_set_id = 1, .group_key = g->key, .first_seq = 1042, .send_timestamp_ms = 1781234567890ULL };
  memcpy(h.session_id, SESSION, 16);
  uint8_t out[4096];
  size_t n = htp_encode_frame(g, &h, win, nwin, out, sizeof out);
  char name[64]; snprintf(name, sizeof name, "htp1/set1_g%u_w%u.htp", g->key, nwin);
  size_t want_len; uint8_t *want = fixture_read(name, &want_len);
  TEST_ASSERT_EQUAL_size_t(want_len, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want, out, want_len);
  free(want); free(vals);
}

void test_frame_sizes(void) {
  TEST_ASSERT_EQUAL_size_t(448, htp_window_bytes(&CS_GROUPS[0]));
  TEST_ASSERT_EQUAL_size_t(208, htp_window_bytes(&CS_GROUPS[1]));
  TEST_ASSERT_EQUAL_size_t(30,  htp_window_bytes(&CS_GROUPS[2]));
  TEST_ASSERT_EQUAL_size_t(1828, htp_frame_bytes(&CS_GROUPS[0], 4));
}

void test_i16fp_sentinel_and_clamp(void) {
  htp_channel_t ch = { "x", HTP_ENC_I16FP, 0.5, 0.0 };
  uint8_t b[2];
  htp_encode_sample(&ch, NAN, b);  TEST_ASSERT_EQUAL_HEX8(0x00, b[0]); TEST_ASSERT_EQUAL_HEX8(0x80, b[1]);
  htp_encode_sample(&ch, 1e9, b);  TEST_ASSERT_EQUAL_HEX8(0xFF, b[0]); TEST_ASSERT_EQUAL_HEX8(0x7F, b[1]);
  htp_encode_sample(&ch, 8123.0, b); TEST_ASSERT_EQUAL_INT16(16246, (int16_t)(b[0] | (b[1] << 8)));
}

void test_golden_g0_w1(void) { check_group(0, 1); }
void test_golden_g0_w4(void) { check_group(0, 4); }
void test_golden_g1_w4(void) { check_group(1, 4); }
void test_golden_g2_w4(void) { check_group(2, 4); }

void test_rejects_bad_window_count(void) {
  uint8_t out[64]; htp_header_t h = {0}; htp_window_t w = {0};
  TEST_ASSERT_EQUAL_size_t(0, htp_encode_frame(&CS_GROUPS[2], &h, &w, 0, out, sizeof out));
  TEST_ASSERT_EQUAL_size_t(0, htp_encode_frame(&CS_GROUPS[2], &h, &w, 9, out, sizeof out));
  TEST_ASSERT_EQUAL_size_t(0, htp_encode_frame(&CS_GROUPS[2], &h, &w, 1, out, 10)); /* too small */
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_frame_sizes);
  RUN_TEST(test_i16fp_sentinel_and_clamp);
  RUN_TEST(test_golden_g0_w1);
  RUN_TEST(test_golden_g0_w4);
  RUN_TEST(test_golden_g1_w4);
  RUN_TEST(test_golden_g2_w4);
  RUN_TEST(test_rejects_bad_window_count);
  return UNITY_END();
}
```

Note: `units.c` `#include`s the other components' `.c` files too; create empty `b64.c`, `livepack.c`, `queue.c` placeholders now (`/* Task 3/4 */`) so this task compiles.

- [ ] **Step 3: Run to verify failure**

```bash
python tools/gen_channel_set.py
pio test -e native
```

Expected: the `test_htp` suite fails to link (`htp_encode_frame` undefined) — because `htp.c` is empty. The other suite dirs are still empty and are skipped.

- [ ] **Step 4: Implement**

`components/htp/htp.c`:

```c
#include "htp.h"
#include <string.h>

void htp_put_u16(uint8_t *p, uint16_t v) { p[0] = v & 0xFF; p[1] = v >> 8; }
void htp_put_u32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (v >> (8 * i)) & 0xFF; }
void htp_put_u64(uint8_t *p, uint64_t v) { for (int i = 0; i < 8; i++) p[i] = (v >> (8 * i)) & 0xFF; }
#define put_u16 htp_put_u16
#define put_u32 htp_put_u32
#define put_u64 htp_put_u64

size_t htp_channel_width(const htp_channel_t *ch) { return ch->enc == HTP_ENC_F32 ? 4 : 2; }

size_t htp_window_bytes(const htp_group_t *g) {
  size_t n = 8;
  for (uint16_t c = 0; c < g->channel_count; c++) n += (size_t)g->rate_hz * htp_channel_width(&g->channels[c]);
  return n;
}

size_t htp_frame_bytes(const htp_group_t *g, uint8_t window_count) {
  return HTP_HEADER_LEN + (size_t)window_count * htp_window_bytes(g);
}

void htp_encode_sample(const htp_channel_t *ch, double v, uint8_t *out) {
  if (ch->enc == HTP_ENC_F32) {
    float f = isnan(v) ? NAN : (float)v;       /* ±inf stays ±inf, exactly like Rust `x as f32` */
    memcpy(out, &f, 4);                       /* ESP32 + x86 are little-endian */
    return;
  }
  int16_t raw;
  if (!isfinite(v)) raw = HTP_I16_NULL;
  else {
    double r = (v - ch->offset) / ch->scale;
    r = r < 0 ? -floor(-r + 0.5) : floor(r + 0.5);   /* round half away from zero == Rust f64::round */
    if (r >  32767.0) r =  32767.0;
    if (r < -32767.0) r = -32767.0;             /* never the sentinel */
    raw = (int16_t)r;
  }
  put_u16(out, (uint16_t)raw);
}

size_t htp_write_header(const htp_header_t *h, uint8_t window_count, uint8_t *out) {
  if (window_count < 1 || window_count > HTP_MAX_WINDOWS) return 0;
  uint8_t *p = out;
  put_u16(p, HTP_MAGIC); p += 2;
  *p++ = HTP_VERSION;
  *p++ = 0;
  memcpy(p, h->session_id, 16); p += 16;
  put_u16(p, h->channel_set_id); p += 2;
  *p++ = h->group_key;
  *p++ = window_count;
  put_u32(p, h->first_seq); p += 4;
  put_u64(p, h->send_timestamp_ms); p += 8;
  return (size_t)(p - out);   /* == HTP_HEADER_LEN */
}

size_t htp_encode_window_body(const htp_group_t *g, const double *v, uint8_t *out, size_t cap) {
  if (cap < htp_window_bytes(g) - 8) return 0;
  uint8_t *p = out;
  for (uint16_t c = 0; c < g->channel_count; c++) {
    const htp_channel_t *ch = &g->channels[c];
    size_t width = htp_channel_width(ch);
    for (uint16_t s = 0; s < g->rate_hz; s++) { htp_encode_sample(ch, v[(size_t)c * g->rate_hz + s], p); p += width; }
  }
  return (size_t)(p - out);
}

size_t htp_encode_frame(const htp_group_t *g, const htp_header_t *h,
                        const htp_window_t *windows, uint8_t window_count,
                        uint8_t *out, size_t out_cap) {
  if (window_count < 1 || window_count > HTP_MAX_WINDOWS) return 0;
  size_t need = htp_frame_bytes(g, window_count);
  if (need > out_cap) return 0;
  uint8_t *p = out + htp_write_header(h, window_count, out);
  for (uint8_t w = 0; w < window_count; w++) {
    put_u64(p, windows[w].t_start_us); p += 8;
    p += htp_encode_window_body(g, windows[w].values, p, out_cap - (size_t)(p - out));
  }
  return (size_t)(p - out);
}
```

- [ ] **Step 5: Run tests**

Run: `pio test -e native -f test_htp`
Expected: `7 Tests 0 Failures` for suite `test_htp`. If a golden comparison fails on **one** byte pair, it is rounding: confirm `fixture_value` was mirrored exactly and that the C rounding is half-away-from-zero.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(htp): HTP/1 encoder byte-exact against Helios golden fixtures; channel-set codegen"
```

---

### Task 3: `livepack` component — `live_fast` blob + base64 (pure C)

**Files:** `components/livepack/livepack.h`, `livepack.c`, `b64.h`, `b64.c`, `CMakeLists.txt`, `test/test_livepack/test_livepack.c`

- [ ] **Step 1: Failing test**

```c
#include "unity.h"
#include "livepack.h"
#include "b64.h"
#include "channel_set_gen.h"
#include "fixture_io.h"
#include "../common/units.c"
#include <string.h>
#include <stdlib.h>

void setUp(void) {}
void tearDown(void) {}

/* live_0 fixture = gen-fixtures value(g, c, 0) for every channel, no forced nulls */
static double fixture_value(uint8_t g, size_t c, size_t s) {
  if ((c + s) % 13 == 12) return NAN;
  double base = g == 0 ? 100.0 * (c + 1.0) : g == 1 ? 33.0 + c : 20.0 + c;
  return base + s * 0.25 - c * 0.125;
}

void test_live_len(void) { TEST_ASSERT_EQUAL_size_t(86, livepack_len()); }

void test_live_0_matches_fixture(void) {
  double vals[CS_LIVE_CHANNELS]; size_t i = 0;
  for (size_t gi = 0; gi < CS_GROUP_COUNT; gi++)
    for (size_t c = 0; c < CS_GROUPS[gi].channel_count; c++) vals[i++] = fixture_value(CS_GROUPS[gi].key, c, 0);
  uint8_t out[128]; size_t n = livepack_pack(vals, out, sizeof out);
  size_t want_len; uint8_t *want = fixture_read("live/live_0.bin", &want_len);
  TEST_ASSERT_EQUAL_size_t(want_len, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want, out, want_len);
  free(want);
}

void test_live_1_nulls_every_5th_per_group(void) {
  double vals[CS_LIVE_CHANNELS]; size_t i = 0;
  for (size_t gi = 0; gi < CS_GROUP_COUNT; gi++)
    for (size_t c = 0; c < CS_GROUPS[gi].channel_count; c++) vals[i++] = (c % 5 == 0) ? NAN : fixture_value(CS_GROUPS[gi].key, c, 1);
  uint8_t out[128]; size_t n = livepack_pack(vals, out, sizeof out);
  size_t want_len; uint8_t *want = fixture_read("live/live_1.bin", &want_len);
  TEST_ASSERT_EQUAL_size_t(want_len, n);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(want, out, want_len);
  free(want);
}

void test_b64(void) {
  char out[16];
  TEST_ASSERT_EQUAL_size_t(4, b64_encode((const uint8_t *)"\x01\x02", 2, out, sizeof out));
  TEST_ASSERT_EQUAL_STRING("AQI=", out);
  TEST_ASSERT_EQUAL_size_t(0, b64_encode((const uint8_t *)"\x01\x02", 2, out, 4)); /* needs NUL room */
  TEST_ASSERT_EQUAL_size_t(116, b64_encoded_len(86));
}

void test_live_message_json(void) {
  char json[256];
  uint8_t blob[2] = {1, 2};
  size_t n = livepack_message_json(7, 10, 11, 1, blob, 2, json, sizeof json);
  TEST_ASSERT_EQUAL_STRING("{\"seq\":7,\"t_us\":10,\"t_send_ms\":11,\"cs\":1,\"v\":\"AQI=\"}", json);
  TEST_ASSERT_EQUAL_size_t(strlen(json), n);
}

int main(void) {
  UNITY_BEGIN();
  RUN_TEST(test_live_len);
  RUN_TEST(test_live_0_matches_fixture);
  RUN_TEST(test_live_1_nulls_every_5th_per_group);
  RUN_TEST(test_b64);
  RUN_TEST(test_live_message_json);
  return UNITY_END();
}
```

- [ ] **Step 2: Run to verify failure** — `pio test -e native -f test_livepack` → undefined `livepack_*`, `b64_*`.

- [ ] **Step 3: Implement**

`b64.h` / `b64.c`:

```c
#pragma once
#include <stddef.h>
#include <stdint.h>
size_t b64_encoded_len(size_t n);                                   /* without NUL */
size_t b64_encode(const uint8_t *in, size_t n, char *out, size_t cap); /* returns len, 0 if cap < len+1 */
```

```c
#include "b64.h"
static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
size_t b64_encoded_len(size_t n) { return ((n + 2) / 3) * 4; }
size_t b64_encode(const uint8_t *in, size_t n, char *out, size_t cap) {
  size_t len = b64_encoded_len(n);
  if (cap < len + 1) return 0;
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    out[o++] = T[(v >> 18) & 63]; out[o++] = T[(v >> 12) & 63];
    out[o++] = i + 1 < n ? T[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? T[v & 63] : '=';
  }
  out[o] = 0;
  return o;
}
```

`livepack.h` / `livepack.c`:

```c
#pragma once
#include <stdint.h>
#include <stddef.h>
size_t livepack_len(void);
/* values: CS_LIVE_CHANNELS doubles in live order (groups ascending, channels in order). NAN = null. */
size_t livepack_pack(const double *values, uint8_t *out, size_t cap);
/* Builds the live_fast payload JSON (spec §3.2). Returns strlen or 0 on overflow. */
size_t livepack_message_json(uint32_t seq, uint64_t t_us, uint64_t t_send_ms, uint16_t cs,
                             const uint8_t *blob, size_t blob_len, char *out, size_t cap);
```

```c
#include "livepack.h"
#include "b64.h"
#include "htp.h"
#include "channel_set_gen.h"
#include <stdio.h>
#include <inttypes.h>

size_t livepack_len(void) {
  size_t n = 0;
  for (size_t g = 0; g < CS_GROUP_COUNT; g++)
    for (size_t c = 0; c < CS_GROUPS[g].channel_count; c++) n += htp_channel_width(&CS_GROUPS[g].channels[c]);
  return n;
}

size_t livepack_pack(const double *values, uint8_t *out, size_t cap) {
  if (cap < livepack_len()) return 0;
  uint8_t *p = out; size_t i = 0;
  for (size_t g = 0; g < CS_GROUP_COUNT; g++)
    for (size_t c = 0; c < CS_GROUPS[g].channel_count; c++) {
      const htp_channel_t *ch = &CS_GROUPS[g].channels[c];
      htp_encode_sample(ch, values[i++], p);
      p += htp_channel_width(ch);
    }
  return (size_t)(p - out);
}

size_t livepack_message_json(uint32_t seq, uint64_t t_us, uint64_t t_send_ms, uint16_t cs,
                             const uint8_t *blob, size_t blob_len, char *out, size_t cap) {
  char b64[256];
  if (!b64_encode(blob, blob_len, b64, sizeof b64)) return 0;
  int n = snprintf(out, cap, "{\"seq\":%" PRIu32 ",\"t_us\":%" PRIu64 ",\"t_send_ms\":%" PRIu64 ",\"cs\":%u,\"v\":\"%s\"}",
                   seq, t_us, t_send_ms, (unsigned)cs, b64);
  return (n > 0 && (size_t)n < cap) ? (size_t)n : 0;
}
```

`components/livepack/CMakeLists.txt`: `idf_component_register(SRCS "livepack.c" "b64.c" INCLUDE_DIRS "." REQUIRES htp)`

- [ ] **Step 4: Run** — `pio test -e native` → suite `test_htp` 7/0, suite `test_livepack` 5/0.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(livepack): live_fast blob + base64 + payload JSON, fixture-verified"`

---

### Task 4: `uplink` retry queue (pure C, PSRAM-backed on target)

**Files:** `components/uplink/queue.h`, `queue.c`, `test/test_queue/test_queue.c`

- [ ] **Step 1: Failing test** (mirrors `helios-telemetry-gen`'s `RetryQueue` tests)

```c
#include "unity.h"
#include "queue.h"
#include "../common/units.c"
#include <stdlib.h>

void setUp(void) {}
void tearDown(void) {}

static uint8_t *arena; static uq_t q;
static void setup(size_t cap, size_t win_bytes) { arena = malloc(uq_arena_bytes(cap, win_bytes)); uq_init(&q, cap, win_bytes, arena); }

void test_drop_oldest_counts(void) {
  setup(3, 4);
  for (uint32_t s = 0; s < 5; s++) { uint8_t b[4] = {(uint8_t)s}; uq_push(&q, s, 1000 + s, b); }
  TEST_ASSERT_EQUAL_size_t(3, uq_len(&q));
  TEST_ASSERT_EQUAL_UINT32(2, q.dropped_oldest);
  uint32_t first; size_t n = uq_batch(&q, 8, &first);
  TEST_ASSERT_EQUAL_UINT32(2, first); TEST_ASSERT_EQUAL_size_t(3, n);
  TEST_ASSERT_EQUAL_UINT8(2, uq_window(&q, 0)[0]);
  free(arena);
}

void test_batch_stops_at_gap_and_ack_removes(void) {
  setup(10, 4);
  uint32_t seqs[] = {1, 2, 3, 5, 6};
  for (int i = 0; i < 5; i++) { uint8_t b[4] = {0}; uq_push(&q, seqs[i], 0, b); }
  uint32_t first; TEST_ASSERT_EQUAL_size_t(3, uq_batch(&q, 8, &first)); TEST_ASSERT_EQUAL_UINT32(1, first);
  uint32_t acked[] = {1, 2, 3}; uq_ack(&q, acked, 3);
  TEST_ASSERT_EQUAL_size_t(2, uq_batch(&q, 8, &first)); TEST_ASSERT_EQUAL_UINT32(5, first);
  free(arena);
}

void test_batch_limited_by_max(void) {
  setup(10, 4);
  for (uint32_t s = 0; s < 10; s++) { uint8_t b[4] = {0}; uq_push(&q, s, 0, b); }
  uint32_t first; TEST_ASSERT_EQUAL_size_t(4, uq_batch(&q, 4, &first));
  free(arena);
}

int main(void) { UNITY_BEGIN(); RUN_TEST(test_drop_oldest_counts); RUN_TEST(test_batch_stops_at_gap_and_ack_removes); RUN_TEST(test_batch_limited_by_max); return UNITY_END(); }
```

- [ ] **Step 2: Run to verify failure** — undefined `uq_*`.

- [ ] **Step 3: Implement**

`queue.h`:

```c
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
/* Bounded FIFO of encoded windows for ONE group. Fixed-size slots in a caller-
 * supplied arena (PSRAM on target). Drop-oldest on overflow (protocol §4.1). */
typedef struct { uint32_t seq; uint64_t t_start_us; } uq_slot_hdr_t;
typedef struct {
  size_t cap, win_bytes, head, len;
  uint32_t dropped_oldest;
  uint8_t *arena;   /* cap * (sizeof(uq_slot_hdr_t) + win_bytes) */
} uq_t;
size_t   uq_arena_bytes(size_t cap, size_t win_bytes);
void     uq_init(uq_t *q, size_t cap, size_t win_bytes, uint8_t *arena);
void     uq_push(uq_t *q, uint32_t seq, uint64_t t_start_us, const uint8_t *window_body);
size_t   uq_len(const uq_t *q);
/* Number of consecutive-seq windows from the head, ≤ max; *first = head seq. */
size_t   uq_batch(const uq_t *q, size_t max, uint32_t *first);
const uint8_t *uq_window(const uq_t *q, size_t i);          /* body bytes of i-th window from head */
uint64_t uq_t_start(const uq_t *q, size_t i);
void     uq_ack(uq_t *q, const uint32_t *seqs, size_t n);   /* removes matching seqs, compacts */
```

`queue.c`:

```c
#include "queue.h"
#include <string.h>
#define SLOT(q, i) ((q)->arena + (((q)->head + (i)) % (q)->cap) * (sizeof(uq_slot_hdr_t) + (q)->win_bytes))
#define HDR(q, i)  ((uq_slot_hdr_t *)SLOT(q, i))
size_t uq_arena_bytes(size_t cap, size_t win_bytes) { return cap * (sizeof(uq_slot_hdr_t) + win_bytes); }
void uq_init(uq_t *q, size_t cap, size_t win_bytes, uint8_t *arena) { *q = (uq_t){ .cap = cap, .win_bytes = win_bytes, .arena = arena }; }
size_t uq_len(const uq_t *q) { return q->len; }
void uq_push(uq_t *q, uint32_t seq, uint64_t t_start_us, const uint8_t *body) {
  size_t i;
  if (q->len < q->cap) i = q->len++;
  else { q->head = (q->head + 1) % q->cap; q->dropped_oldest++; i = q->len - 1; }
  HDR(q, i)->seq = seq; HDR(q, i)->t_start_us = t_start_us;
  memcpy(SLOT(q, i) + sizeof(uq_slot_hdr_t), body, q->win_bytes);
}
size_t uq_batch(const uq_t *q, size_t max, uint32_t *first) {
  if (q->len == 0) return 0;
  *first = HDR(q, 0)->seq;
  size_t n = 1;
  while (n < q->len && n < max && HDR(q, n)->seq == *first + n) n++;
  return n;
}
const uint8_t *uq_window(const uq_t *q, size_t i) { return SLOT(q, i) + sizeof(uq_slot_hdr_t); }
uint64_t uq_t_start(const uq_t *q, size_t i) { return HDR(q, i)->t_start_us; }
void uq_ack(uq_t *q, const uint32_t *seqs, size_t n) {
  size_t w = 0;
  for (size_t r = 0; r < q->len; r++) {
    bool drop = false;
    for (size_t k = 0; k < n; k++) if (HDR(q, r)->seq == seqs[k]) { drop = true; break; }
    if (!drop) { if (w != r) memmove(SLOT(q, w), SLOT(q, r), sizeof(uq_slot_hdr_t) + q->win_bytes); w++; }
  }
  q->len = w;
}
```

(`SLOT(q, w)` with `w < r` never wraps past `r`, so `memmove` over the modular index is safe: both are computed relative to `head`.)

- [ ] **Step 4: Run** — `pio test -e native` → three suites, 7 + 5 + 3 tests, 0 failures. **Milestone M0 done.**

- [ ] **Step 5: Commit** — `git commit -am "feat(uplink): bounded drop-oldest retry queue (protocol §4.1), host-tested"`

---

### Task 5: `transport` — Wi-Fi now, LTE later

**Files:** `components/transport/transport.h`, `transport_wifi.c`, `transport_lte.c`, `CMakeLists.txt`

- [ ] **Step 1: API + Wi-Fi implementation**

`transport.h`:

```c
#pragma once
#include "esp_err.h"
#include <stdbool.h>
/* Brings up a netif with a default route + DNS. Blocks until IP or timeout. */
esp_err_t transport_start(void);
bool      transport_is_up(void);
/* Unix time in µs from the transport's best clock (GNSS on LTE board, SNTP on Wi-Fi). 0 = unsynced. */
uint64_t  transport_time_us(void);
```

`transport_wifi.c` — standard ESP-IDF station bring-up (`esp_netif_create_default_wifi_sta`, `WIFI_MODE_STA`, event group waits for `IP_EVENT_STA_GOT_IP`, auto-reconnect on `WIFI_EVENT_STA_DISCONNECTED`), then `esp_sntp` with `pool.ntp.org`; `transport_time_us()` = `gettimeofday` once `sntp_get_sync_status() == SNTP_SYNC_STATUS_COMPLETED`. Wrap everything in `#if TRANSPORT_WIFI`.

`transport_lte.c` — `#if TRANSPORT_LTE` stub for now: `return ESP_ERR_NOT_SUPPORTED;` (filled in Task 9).

`CMakeLists.txt`: `idf_component_register(SRCS "transport_wifi.c" "transport_lte.c" INCLUDE_DIRS "." REQUIRES esp_wifi esp_netif esp_event nvs_flash lwip)` — add `esp_modem` to REQUIRES in Task 9.

- [ ] **Step 2: Create `main/`**

`main/CMakeLists.txt`:

```cmake
idf_component_register(SRCS "main.c" INCLUDE_DIRS "." REQUIRES transport session rtws uplink sampler htp livepack nvs_flash esp_event)
```

`main/main.c` (grows in Tasks 6–8; this version only brings the network up):

```c
#include "nvs_flash.h"
#include "esp_event.h"
#include "esp_log.h"
#include "transport.h"
#include "config.h"
#include "secrets.h"
static const char *TAG = "main";
void app_main(void) {
  ESP_ERROR_CHECK(nvs_flash_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  ESP_ERROR_CHECK(transport_start());
  ESP_LOGI(TAG, "network up, time_us=%llu", (unsigned long long)transport_time_us());
}
```

Components listed in REQUIRES that do not exist yet (session, rtws, uplink, sampler) get an empty `CMakeLists.txt` + stub now: `idf_component_register(INCLUDE_DIRS ".")`.

- [ ] **Step 3: Build + flash the devkit, watch it get an IP**

```bash
cp include/secrets.h.template include/secrets.h     # fill in Wi-Fi + keys
pio run -e devkit-wifi -t upload && pio device monitor
```

Expected in the monitor: `transport: got ip 192.168.x.x`, `sntp: synced`, `main: network up`. (First `pio run` downloads ESP-IDF + toolchain, several GB; run it early.)

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(transport,main): Wi-Fi station + SNTP behind transport_start(); LTE stub; app_main"`

---

### Task 6: `session` — HMAC-signed open/close

**Files:** `components/session/session.h`, `session.c`, `CMakeLists.txt`

- [ ] **Step 1: Implement**

```c
#pragma once
#include "esp_err.h"
#include <stdint.h>
/* hex(HMAC-SHA256(key, body)) into out[65]. */
void      session_hmac_hex(const char *key, const uint8_t *body, size_t len, char out[65]);
/* POST telemetry-session {action:open}; fills session_id (36-char uuid + NUL) and its 16 raw bytes. */
esp_err_t session_open(char session_id[37], uint8_t session_bytes[16]);
esp_err_t session_close(const char *session_id);
```

`session.c` core:

```c
#include "session.h"
#include "config.h"
#include "secrets.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "mbedtls/md.h"
#include <stdio.h>
#include <string.h>
static const char *TAG = "session";

void session_hmac_hex(const char *key, const uint8_t *body, size_t len, char out[65]) {
  uint8_t mac[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t *)key, strlen(key), body, len, mac);
  for (int i = 0; i < 32; i++) sprintf(out + 2 * i, "%02x", mac[i]);
}

static esp_err_t post_json(const char *body, char *resp, size_t resp_cap, int *status) {
  char sig[65]; session_hmac_hex(TELEMETRY_HMAC_KEY, (const uint8_t *)body, strlen(body), sig);
  esp_http_client_config_t cfg = { .url = SUPABASE_URL "/functions/v1/telemetry-session", .method = HTTP_METHOD_POST,
                                   .crt_bundle_attach = esp_crt_bundle_attach, .timeout_ms = HTTP_TIMEOUT_MS };
  esp_http_client_handle_t c = esp_http_client_init(&cfg);
  esp_http_client_set_header(c, "content-type", "application/json");
  esp_http_client_set_header(c, "x-htp-device", DEVICE_ID);
  esp_http_client_set_header(c, "x-htp-signature", sig);
  esp_http_client_set_post_field(c, body, strlen(body));
  esp_err_t err = esp_http_client_open(c, strlen(body));
  if (err == ESP_OK) {
    esp_http_client_write(c, body, strlen(body));
    esp_http_client_fetch_headers(c);
    int n = esp_http_client_read_response(c, resp, resp_cap - 1); resp[n > 0 ? n : 0] = 0;
    *status = esp_http_client_get_status_code(c);
  }
  esp_http_client_cleanup(c);
  return err;
}

static bool parse_uuid(const char *s, uint8_t out[16]) {          /* "9b2f1c3e-4d5a-..." → bytes, RFC 4122 order */
  int j = 0;
  for (int i = 0; s[i] && j < 16; i++) { if (s[i] == '-') continue; unsigned b; if (sscanf(s + i, "%2x", &b) != 1) return false; out[j++] = (uint8_t)b; i++; }
  return j == 16;
}

esp_err_t session_open(char session_id[37], uint8_t session_bytes[16]) {
  char body[128]; snprintf(body, sizeof body, "{\"action\":\"open\",\"device_id\":\"%s\",\"channel_set_id\":%d}", DEVICE_ID, CHANNEL_SET_ID);
  char resp[256]; int status = 0;
  esp_err_t err = post_json(body, resp, sizeof resp, &status);
  if (err != ESP_OK || status != 200) { ESP_LOGE(TAG, "open failed err=%d status=%d %s", err, status, resp); return ESP_FAIL; }
  const char *p = strstr(resp, "\"session_id\":\""); if (!p) return ESP_FAIL;
  strncpy(session_id, p + 14, 36); session_id[36] = 0;
  if (!parse_uuid(session_id, session_bytes)) return ESP_FAIL;
  ESP_LOGI(TAG, "session %s", session_id);
  return ESP_OK;
}

esp_err_t session_close(const char *session_id) {
  char body[96]; snprintf(body, sizeof body, "{\"action\":\"close\",\"session_id\":\"%s\"}", session_id);
  char resp[64]; int status = 0;
  return (post_json(body, resp, sizeof resp, &status) == ESP_OK && status == 200) ? ESP_OK : ESP_FAIL;
}
```

`CMakeLists.txt`: `idf_component_register(SRCS "session.c" INCLUDE_DIRS "." REQUIRES esp_http_client esp-tls mbedtls)`.

- [ ] **Step 2: Verify the HMAC on host** — a host test is not possible because `mbedtls` is not in the native build. Instead verify on target: temporarily log `session_hmac_hex("key", "The quick brown fox jumps over the lazy dog")` at boot → expect `f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8`. Remove the log.

- [ ] **Step 3: Flash; `main.c` calls `transport_start()` then `session_open()`.** Expected monitor line `session: session <uuid>`, and the row appears in `telemetry.sessions` with `metadata->>'device_id' = 'sdm26-car-1'`. Reboot → previous row flips to `ended`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(session): HMAC-signed open/close via telemetry-session"`

---

### Task 7: `rtws` — Realtime WebSocket publisher

**Files:** `components/rtws/rtws.h`, `rtws.c`, `CMakeLists.txt`

- [ ] **Step 1: Implement** (mirror of `helios-telemetry-gen/src/live_client.rs`)

```c
#pragma once
#include "esp_err.h"
#include <stdbool.h>
esp_err_t rtws_start(const char *session_id);   /* connects, joins private topic with DEVICE_JWT, auto-reconnects */
bool      rtws_joined(void);
esp_err_t rtws_publish_live(const char *payload_json);   /* wraps in Phoenix broadcast envelope; drops if not joined */
void      rtws_stop(void);
```

`rtws.c` essentials:

```c
#include "rtws.h"
#include "config.h"
#include "secrets.h"
#include "esp_websocket_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_timer.h"
#include <stdio.h>
#include <string.h>
static const char *TAG = "rtws";
static esp_websocket_client_handle_t ws;
static char topic[80];
static volatile bool joined;
static uint32_t ref_counter = 1;
static esp_timer_handle_t hb_timer;

static void send_join(void) {
  char msg[1024];
  int n = snprintf(msg, sizeof msg,
    "{\"topic\":\"%s\",\"event\":\"phx_join\",\"ref\":\"%u\",\"payload\":{\"config\":{\"broadcast\":{\"self\":false,\"ack\":false},"
    "\"presence\":{\"key\":\"\"},\"private\":true},\"access_token\":\"%s\"}}", topic, (unsigned)ref_counter++, DEVICE_JWT);
  esp_websocket_client_send_text(ws, msg, n, pdMS_TO_TICKS(1000));
}

static void heartbeat(void *arg) {
  if (!esp_websocket_client_is_connected(ws)) return;
  char msg[96]; int n = snprintf(msg, sizeof msg, "{\"topic\":\"phoenix\",\"event\":\"heartbeat\",\"payload\":{},\"ref\":\"%u\"}", (unsigned)ref_counter++);
  esp_websocket_client_send_text(ws, msg, n, pdMS_TO_TICKS(500));
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  esp_websocket_event_data_t *e = data;
  switch (id) {
    case WEBSOCKET_EVENT_CONNECTED: ESP_LOGI(TAG, "connected, joining %s", topic); joined = false; send_join(); break;
    case WEBSOCKET_EVENT_DISCONNECTED: case WEBSOCKET_EVENT_ERROR: joined = false; ESP_LOGW(TAG, "disconnected"); break;
    case WEBSOCKET_EVENT_DATA:
      if (e->op_code == 0x1 && e->data_len > 0) {
        if (strstr(e->data_ptr, "\"phx_reply\"") && strstr(e->data_ptr, "\"status\":\"ok\"") && !joined) { joined = true; ESP_LOGI(TAG, "joined"); }
        else if (strstr(e->data_ptr, "\"phx_error\"") || strstr(e->data_ptr, "\"status\":\"error\"")) { joined = false; ESP_LOGE(TAG, "join/reply error: %.*s", e->data_len, e->data_ptr); }
      }
      break;
    default: break;
  }
}

esp_err_t rtws_start(const char *session_id) {
  snprintf(topic, sizeof topic, "realtime:telemetry:live:%s", session_id);
  static char uri[256];
  snprintf(uri, sizeof uri, "wss://%s/realtime/v1/websocket?apikey=%s&vsn=1.0.0", SUPABASE_URL + strlen("https://"), SUPABASE_ANON_KEY);
  esp_websocket_client_config_t cfg = { .uri = uri, .crt_bundle_attach = esp_crt_bundle_attach, .reconnect_timeout_ms = 2000,
                                        .network_timeout_ms = 5000, .buffer_size = 2048, .disable_pingpong_discon = true };
  ws = esp_websocket_client_init(&cfg);
  esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, on_event, NULL);
  const esp_timer_create_args_t t = { .callback = heartbeat, .name = "rt_hb" };
  esp_timer_create(&t, &hb_timer); esp_timer_start_periodic(hb_timer, (uint64_t)RT_HEARTBEAT_MS * 1000);
  return esp_websocket_client_start(ws);
}

bool rtws_joined(void) { return joined && esp_websocket_client_is_connected(ws); }

esp_err_t rtws_publish_live(const char *payload_json) {
  if (!rtws_joined()) return ESP_ERR_INVALID_STATE;
  char msg[512];
  int n = snprintf(msg, sizeof msg, "{\"topic\":\"%s\",\"event\":\"broadcast\",\"ref\":null,\"payload\":{\"type\":\"broadcast\",\"event\":\"live_fast\",\"payload\":%s}}", topic, payload_json);
  if (n <= 0 || n >= (int)sizeof msg) return ESP_ERR_NO_MEM;
  return esp_websocket_client_send_text(ws, msg, n, pdMS_TO_TICKS(50)) >= 0 ? ESP_OK : ESP_FAIL;
}

void rtws_stop(void) { esp_timer_stop(hb_timer); esp_websocket_client_stop(ws); esp_websocket_client_destroy(ws); }
```

`CMakeLists.txt`: `idf_component_register(SRCS "rtws.c" INCLUDE_DIRS "." REQUIRES esp_websocket_client esp-tls esp_timer)`.

Send timeout is 50 ms on purpose: if the socket is stalled, a live message is dropped, not queued — freshness beats completeness (the durable path has the data).

- [ ] **Step 2: Live publisher task in `main.c`** (synthetic sampler for now)

```c
static void live_task(void *arg) {
  const TickType_t period = pdMS_TO_TICKS(1000 / LIVE_HZ);
  TickType_t next = xTaskGetTickCount();
  uint32_t seq = 0;
  double vals[CS_LIVE_CHANNELS]; uint8_t blob[128]; char json[256];
  for (;;) {
    vTaskDelayUntil(&next, period);
    uint64_t t_us = transport_time_us(); if (!t_us) continue;
    sampler_snapshot_live(vals);                        /* Task 8 */
    size_t n = livepack_pack(vals, blob, sizeof blob);
    livepack_message_json(seq++, t_us, t_us / 1000, CS_ID, blob, n, json, sizeof json);
    rtws_publish_live(json);
  }
}
```

Create with `xTaskCreatePinnedToCore(live_task, "live", 6144, NULL, 8, NULL, 1)` (higher priority than uplink).

- [ ] **Step 3: Verify in Helios** — flash, open Helios → ◉ → the device's session. Expected: strip chart moves at 10 Hz; `lastLatencyMs()` (temporary log in Helios per plan A task 11) shows **< 500 ms p50** on the shop Wi-Fi with SNTP-synced clock. If join logs `error`, check the JWT (plan A task 6) and that `migration 20260902000000` is applied.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(rtws): Phoenix/Realtime WebSocket publisher for live_fast"`

---

### Task 8: `sampler` + `uplink` — window builder, HTP POSTs, retry

**Files:** `components/sampler/sampler.h`, `sampler_synth.c`, `components/uplink/uplink.h`, `uplink.c`, `CMakeLists.txt`s, `main/main.c`

- [ ] **Step 1: Sampler API (synthetic backend first; CAN in Task 10)**

```c
#pragma once
#include <stddef.h>
#include <stdint.h>
void sampler_start(void);
/* Latest value per channel in live order (NAN = no data). Thread-safe snapshot. */
void sampler_snapshot_live(double *out /* CS_LIVE_CHANNELS */);
/* Copies the sample at index i of group gi's current window row-major into `row` and advances. */
void sampler_window_fill(size_t gi, uint16_t sample_index);
/* Returns the finished window body for group gi (channel_count*rate_hz doubles). */
const double *sampler_window_take(size_t gi, uint64_t *t_start_us);
```

`sampler_synth.c`: port `synth.rs::value()` (same formulas) into `static double synth_value(const char *id, double t_s)`; keep a `latest[CS_LIVE_CHANNELS]` array protected by a spinlock updated by a 100 Hz timer; the window buffers are `double win[gi][channel_count * rate_hz]` filled at each group's `rate_hz` tick and double-buffered so `take` never races `fill`.

- [ ] **Step 2: Uplink task** (mirror of `helios-telemetry-gen::replay` + `HtpClient`)

`uplink.h`: `void uplink_start(const uint8_t session_bytes[16]);`

`uplink.c` core loop per second:

```c
/* one persistent esp_http_client (keep-alive) for telemetry-ingest */
static esp_http_client_handle_t http;
static uq_t queues[CS_GROUP_COUNT]; static uint32_t next_seq[CS_GROUP_COUNT];
static uint8_t frame_buf[HTP_HEADER_LEN + HTP_MAX_WINDOWS * 448];   /* largest group window; PSRAM if bigger sets */

static int post_frame(size_t gi, uint32_t first, size_t nwin, uint32_t *acked, size_t *n_acked) {
  const htp_group_t *g = &CS_GROUPS[gi];
  size_t wb = htp_window_bytes(g) - 8;
  /* assemble header + windows directly from queue slots (bodies are already encoded) */
  htp_header_t h = { .channel_set_id = CS_ID, .group_key = g->key, .first_seq = first, .send_timestamp_ms = transport_time_us() / 1000 };
  memcpy(h.session_id, session, 16);
  uint8_t *p = frame_buf + htp_write_header(&h, (uint8_t)nwin, frame_buf);
  for (size_t i = 0; i < nwin; i++) { htp_put_u64(p, uq_t_start(&queues[gi], i)); p += 8; memcpy(p, uq_window(&queues[gi], i), wb); p += wb; }
  size_t len = (size_t)(p - frame_buf);
  char sig[65]; session_hmac_hex(TELEMETRY_HMAC_KEY, frame_buf, len, sig);
  esp_http_client_set_header(http, "x-htp-signature", sig);
  esp_http_client_set_post_field(http, (const char *)frame_buf, len);
  if (esp_http_client_perform(http) != ESP_OK) return -1;          /* transient */
  int status = esp_http_client_get_status_code(http);
  if (status == 200) { /* parse "acked":[..] and "dup":[..] with a tiny int-list scanner into acked[] */ return 200; }
  return status;                                                     /* 4xx permanent, 5xx transient */
}
```

`components/uplink/CMakeLists.txt` replaces the Task 5 stub with `idf_component_register(SRCS "queue.c" "uplink.c" INCLUDE_DIRS "." REQUIRES htp session transport esp_http_client esp-tls)` — without this `queue.c` silently stays out of the target build.

`uplink_start` does, per group `gi`: `uq_init(&queues[gi], QUEUE_WINDOWS, htp_window_bytes(&CS_GROUPS[gi]) - 8, heap_caps_malloc(uq_arena_bytes(...), MALLOC_CAP_SPIRAM))` — a queue slot holds the window **body** (samples only); `t_start_us` lives in the slot header and is re-emitted by `post_frame`.

Behaviour (protocol §4, identical to the gen):
- every 1 s tick: for each group, `sampler_window_take` → `htp_encode_window_body` into a stack scratch buffer → `uq_push(seq++, t_start_us, body)`.
- if `uq_batch ≥ WINDOWS_PER_POST` **or** queue non-empty and last POST > 1 s ago → POST.
- 200 → `uq_ack(acked ∪ dup)`; 4xx → `uq_ack(seqs of the frame)` + `permanent_errors++`; transient → backoff 1/2/4/8 s ±20 % (use `esp_random()` for jitter) and retry same batch.
- one `esp_http_client` handle reused with `.keep_alive_enable = true`; on any transport error `esp_http_client_close()` then reopen next attempt.
- log a counters line every 30 s: `posts acked dup dropped_oldest permanent_errors queue_depth[g]`.

`main.c` task creation: `sampler_start()`, `uplink_start(session_bytes)` on core 0 priority 5, `live_task` on core 1 priority 8, stack 8192 for uplink (TLS).

- [ ] **Step 3: Verify (Milestone M1)**

Flash; in the monitor expect a counters line like `posts=15 acked=60 dup=0 dropped_oldest=0 perm=0 depth=[0,0,0]` after ~20 s. In SQL: `select group_key,count(*) from telemetry.staging_chunks where session_id='<id>' group by 1` grows 1 row/s/group. Then **kill the Wi-Fi AP for 2 minutes**: expect `depth` to climb to ~120 per group, then on reconnect drain to 0 within ~10 s with `dup=0` and live resuming; `dropped_oldest` stays 0 (QUEUE_WINDOWS=240 > 120). Helios shows the live trace resume with a gap, not garbage.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(uplink,sampler): 1 s windows, batched HTP/1 POSTs with keep-alive, ack/dup/backoff per protocol §4; synthetic sampler"`

---

### Task 9: LTE transport (Milestone M2) — T-SIM7670G-S3

**Files:** `components/transport/transport_lte.c`, `CMakeLists.txt`, `include/board_tsim7670g.h`

- [ ] **Step 1: Board pins** — from LILYGO's repo for the T-SIM7670G-S3 (verify against the board you receive): modem UART TX/RX, PWRKEY, and the GNSS is on the modem (AT+CGNSSPWR / AT+CGNSSINFO on SIM767x). Put them in `include/board_tsim7670g.h`.

- [ ] **Step 2: PPPoS via `esp_modem`**

```c
#if TRANSPORT_LTE
#include "esp_modem_api.h"
static esp_modem_dce_t *dce; static esp_netif_t *ppp;
esp_err_t transport_start(void) {
  esp_netif_config_t netif_cfg = ESP_NETIF_DEFAULT_PPP(); ppp = esp_netif_new(&netif_cfg);
  esp_modem_dte_config_t dte = ESP_MODEM_DTE_DEFAULT_CONFIG();
  dte.uart_config.tx_io_num = MODEM_TX; dte.uart_config.rx_io_num = MODEM_RX; dte.uart_config.baud_rate = 115200;
  esp_modem_dce_config_t dce_cfg = ESP_MODEM_DCE_DEFAULT_CONFIG(LTE_APN);
  dce = esp_modem_new_dev(ESP_MODEM_DCE_SIM7600, &dte, &dce_cfg, ppp);   /* SIM767x speaks the SIM7600 AT set */
  /* latency: no power saving, ever */
  esp_modem_at(dce, "AT+CPSMS=0", NULL, 1000);
  esp_modem_at(dce, "AT+CEDRXS=0", NULL, 1000);
  esp_modem_at(dce, "AT+CGNSSPWR=1", NULL, 1000);
  ESP_ERROR_CHECK(esp_modem_set_mode(dce, ESP_MODEM_MODE_DATA));
  /* wait IP_EVENT_PPP_GOT_IP as in the Wi-Fi path */
  return ESP_OK;
}
#endif
```

GNSS time: while in DATA mode the UART is PPP; use `ESP_MODEM_MODE_CMUX` so AT and PPP coexist, and poll `AT+CGNSSINFO` once a second on the AT channel for fix + UTC → `transport_time_us()` (fall back to SNTP-over-PPP if no fix). Also expose `gps.lat/lon/speed/fix_quality` to the sampler from this parse.

- [ ] **Step 3: Verify** — `pio run -e t-sim7670g -t upload`; monitor shows PPP IP, session opened, `rtws: joined`; drive around the parking lot with Helios open on a laptop hotspot. Expect latency **~400–550 ms p50** (Cat-1) and no live dropouts at walking/driving speed; log `AT+CSQ` every 30 s alongside the counters line for signal correlation.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(transport): PPPoS over SIM7670G via esp_modem (CMUX), PSM/eDRX off, GNSS time"`

---

### Task 10: CAN sampler (Milestone M3)

**Files:** `components/sampler/sampler_can.c`, `include/can_map.h`

- [ ] **Step 1: CAN map** — the Link G4X's configurable CAN stream: export the "Generic Dash" / custom stream definition from PCLink and transcribe frame id → (byte offset, length, endian, scale, offset, channel id) into `can_map.h` as a table. Channel ids must be registry ids (`engine.rpm`, …) so the mapping into live order is by string lookup at boot (build an index array once).

- [ ] **Step 2: TWAI driver** — `twai_general_config_t` on the SN65HVD230 pins, 1 Mbps (match the ECU), RX task at priority 9 decoding frames into `latest[]` under the sampler spinlock; `sampler_window_fill` decimates by sampling `latest` at each group's rate (the registry is 100 Hz, wire is 10 Hz → decimation not averaging, matching the handoff's integrity convention).

- [ ] **Step 3: Verify** — bench with a PCLink-driven ECU or a CAN simulator; Helios live RPM tracks the ECU; a staged window decoded by `helios-htp` matches PCLink's live values at the documented resolution.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(sampler): Link G4X CAN (TWAI) backend replaces synthetic"`

---

### Task 11: Repo hygiene + handoff

- [ ] Push to `github.com/NIXELFi/sdm-telemetry-fw` (private), add a GitHub Action that runs `pio test -e native` on every push (Ubuntu runner: `pip install platformio`, then `pio test -e native`).
- [ ] `README.md`: hardware list, `secrets.h` steps, the three envs, the M0–M3 verification steps above, and the counters-line format.
- [ ] Add a note in Helios `docs/telemetry-wire-protocol.md` §9 pointing at this repo as the production client.

---

## Deferred / known risks
- **JWT signing:** HS256 device tokens need the legacy JWT secret enabled (spec §3.3).
- **`esp_websocket_client` send timeout** semantics on a stalled socket: verified empirically in Task 8 step 3's AP-kill test; if publishes block longer than 50 ms, move `rtws_publish_live` behind a 1-deep queue + own task.
- **Realtime quota** at 10 Hz with several viewers (spec §3.2) — `LIVE_HZ` is the knob.
- **T-SIM7670G-S3 availability / pinout** — verify before ordering; `esp_modem` may need the `SIM7600` device class with `+CGNSSINFO` parsing added by hand.
- **PlatformIO native on Windows** installs its own MinGW toolchain per-user; if that fails behind the work proxy, run `pio test -e native` on the Mac.
