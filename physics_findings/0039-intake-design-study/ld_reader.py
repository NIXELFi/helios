"""Minimal MoTeC .ld (i2 log) reader.

Layout follows the reverse-engineered format documented by gotzl/ldparser
(https://github.com/gotzl/ldparser):

  file header (ldHead)  at offset 0
      u32 ldmarker, 4x, u32 chan_meta_ptr, u32 chan_data_ptr, 20x,
      u32 event_ptr, 24x, u16 x3, u32 device_serial, 8s device_type,
      u16 device_version, u16, u32 num_channels, 4x, 16s date, 16x,
      16s time, 16x, 64s driver, 64s vehicle, 64x, 64s venue, ...
  channel meta records, a doubly linked list starting at chan_meta_ptr
      u32 prev, u32 next, u32 data_ptr, u32 n_data, u16 counter,
      u16 dtype_a, u16 dtype_size, u16 freq_hz,
      i16 shift, i16 mul, i16 scale, i16 dec,
      32s name, 8s short_name, 12s unit, 40x
  channel data: n_data samples of dtype at data_ptr

  dtype_a 0x07 -> float (size 2: f16, 4: f32, 8: f64)
  dtype_a 0/3/5 -> signed int (size 2: i16, 4: i32)
  value = (raw / scale * 10**-dec + shift) * mul

Each channel has its own sample rate; its time base is t = i / freq_hz from the
start of the log (the format has no per-channel start offset).

Usage:
    ld = read_ld(path)            # metadata only (lazy data)
    ld.channels["Engine Speed"].data   # numpy float64 array (loaded on demand)
    ld.channels[name].time()           # seconds
"""
from __future__ import annotations

import struct
import sys
from dataclasses import dataclass, field

import numpy as np

HEAD_FMT = "<I4xII20xI24xHHHI8sHHI4x16s16x16s16x64s64s64x64s"
CHAN_FMT = "<IIIIHHHHhhhh32s8s12s"
CHAN_SIZE = struct.calcsize(CHAN_FMT) + 40


def _s(b: bytes) -> str:
    return b.split(b"\0", 1)[0].decode("latin-1").strip()


@dataclass
class LdChannel:
    path: str
    name: str
    short: str
    unit: str
    freq: int
    n: int
    data_ptr: int
    dtype_a: int
    dtype_size: int
    shift: int
    mul: int
    scale: int
    dec: int
    _data: np.ndarray | None = field(default=None, repr=False)

    @property
    def np_dtype(self):
        if self.dtype_a == 0x07:
            return {2: "<f2", 4: "<f4", 8: "<f8"}.get(self.dtype_size)
        if self.dtype_a in (0x00, 0x03, 0x05):
            return {1: "<i1", 2: "<i2", 4: "<i4", 8: "<i8"}.get(self.dtype_size)
        return None

    @property
    def data(self) -> np.ndarray:
        if self._data is None:
            dt = self.np_dtype
            if dt is None:
                raise ValueError(f"{self.name}: unsupported dtype {self.dtype_a:#x}/{self.dtype_size}")
            with open(self.path, "rb") as f:
                f.seek(self.data_ptr)
                raw = np.fromfile(f, dtype=dt, count=self.n).astype(np.float64)
            scale = self.scale if self.scale else 1
            mul = self.mul if self.mul else 1
            self._data = (raw / scale * 10.0 ** (-self.dec) + self.shift) * mul
        return self._data

    def time(self) -> np.ndarray:
        return np.arange(self.n, dtype=np.float64) / float(self.freq or 1)

    def free(self):
        self._data = None


@dataclass
class LdFile:
    path: str
    date: str
    time: str
    driver: str
    vehicle: str
    venue: str
    device: str
    channels: dict[str, LdChannel]

    def duration(self) -> float:
        return max((c.n / c.freq for c in self.channels.values() if c.freq), default=0.0)


def read_ld(path: str) -> LdFile:
    with open(path, "rb") as f:
        head = f.read(struct.calcsize(HEAD_FMT))
        h = struct.unpack(HEAD_FMT, head)
        (_marker, meta_ptr, _data_ptr, _event_ptr, _a, _b, _c, _serial, devtype,
         _devver, _d, _nchan, date, tim, driver, vehicle, venue) = h
        chans: dict[str, LdChannel] = {}
        ptr = meta_ptr
        seen = set()
        while ptr and ptr not in seen:
            seen.add(ptr)
            f.seek(ptr)
            buf = f.read(struct.calcsize(CHAN_FMT))
            if len(buf) < struct.calcsize(CHAN_FMT):
                break
            (_prev, nxt, dptr, n, _cnt, dta, dts, freq, shift, mul, scale, dec,
             name, short, unit) = struct.unpack(CHAN_FMT, buf)
            ch = LdChannel(path, _s(name), _s(short), _s(unit), freq, n, dptr, dta, dts,
                           shift, mul, scale, dec)
            key = ch.name
            k = 2
            while key in chans:  # duplicate names: suffix
                key = f"{ch.name} #{k}"
                k += 1
            chans[key] = ch
            ptr = nxt
    return LdFile(path, _s(date), _s(tim), _s(driver), _s(vehicle), _s(venue), _s(devtype), chans)


if __name__ == "__main__":
    ld = read_ld(sys.argv[1])
    print(f"{ld.path}\n date={ld.date} {ld.time} driver={ld.driver!r} vehicle={ld.vehicle!r} "
          f"venue={ld.venue!r} device={ld.device!r} channels={len(ld.channels)} dur={ld.duration():.1f}s")
    for k, c in ld.channels.items():
        try:
            d = c.data
            rng = f"{np.nanmin(d):10.3f} .. {np.nanmax(d):10.3f}" if d.size else "empty"
        except ValueError as e:
            rng = str(e)
        print(f" {k:32s} [{c.unit:8s}] {c.freq:4d} Hz n={c.n:7d} dt={c.dtype_a:#x}/{c.dtype_size} {rng}")
        c.free()
