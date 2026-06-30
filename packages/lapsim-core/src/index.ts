// @helios/lapsim-core — pure-TS lap-time simulation physics, extracted from the
// CFD module so both the native CFD app (optimizer/points scoring) and the
// standalone sandboxed Lap Sim plugin consume ONE source of truth. No React,
// Tauri, DOM, or DB — values flow in via the input DTOs (inputs.ts).

export * from "./inputs";
export * from "./types";
export * from "./lapSim";
export * from "./vehicle";
export * from "./tractive";
export * from "./torqueCurve";
export * from "./tir";
export * from "./fuelMap";
export * from "./track";
export * from "./trackGeometry";
export * from "./tracks2026";
export * from "./tracksVisual2026";
export * from "./sectors";
export * from "./vdSweep";
export * from "./loadSensitivity";
export * from "./events";
export * from "./accel";
export * from "./points";
export * from "./fuels";
