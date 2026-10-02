import { describe, expect, it } from "vitest";
import { guessCar, guessSubteam, tabName } from "../airtableFiles";

const SUBTEAMS = [
  { id: "aer", name: "Aero", code: "AER" }, { id: "brk", name: "Brakes", code: "BRK" }, { id: "cha", name: "Chassis", code: "CHA" },
  { id: "dri", name: "Driver Interface", code: "DRI" }, { id: "bat", name: "Battery", code: "BAT" },
  { id: "team", name: "Overall Team", code: "TEAM" }, { id: "daq", name: "Data AQ", code: "DAQ" },
];
const CARS = [{ id: "ic", car_code: "SDM27", name: "SDM27 (IC)" }, { id: "ev", car_code: "SDM27e", name: "SDM27e (EV)" }];

describe("Airtable export names", () => {
  it("strips Airtable's view name and download counter", () => {
    expect(tabName("AirtableExports/EV Team/Aero-Grid view (1).csv")).toBe("Aero");
    expect(tabName("Overall Team-Grid view.csv")).toBe("Overall Team");
  });
  it("matches tab names to subteams, typos and short names included", () => {
    expect(guessSubteam("EV Team/Brakess-Grid view.csv", SUBTEAMS)).toBe("brk");
    expect(guessSubteam("Chassiss-Grid view.csv", SUBTEAMS)).toBe("cha");
    expect(guessSubteam("DI-Grid view.csv", SUBTEAMS)).toBe("dri");
    expect(guessSubteam("Accumulator-Grid view.csv", SUBTEAMS)).toBe("bat");
    expect(guessSubteam("Data AQ-Grid view.csv", SUBTEAMS)).toBe("daq");
    expect(guessSubteam("Overall Team-Grid view (1).csv", SUBTEAMS)).toBe("team");
    expect(guessSubteam("Marketing-Grid view.csv", SUBTEAMS)).toBeNull();
  });
  it("takes the car from the folder", () => {
    expect(guessCar("AirtableExports/EV Team/Aero-Grid view.csv", CARS)).toBe("ev");
    expect(guessCar("AirtableExports/IC Team/Aero-Grid view.csv", CARS)).toBe("ic");
    expect(guessCar("SDM27e budget.csv", CARS)).toBe("ev");
    expect(guessCar("Aero-Grid view.csv", CARS)).toBeNull();
    // with past cars and other projects around
    const more = [...CARS, { id: "old", car_code: "SDM26", name: "SDM26" }, { id: "x", car_code: "SIM", name: "Simulator" }];
    expect(guessCar("IC Team/Aero-Grid view.csv", more)).toBe("ic");
    expect(guessCar("EV Team/Aero-Grid view.csv", more)).toBe("ev");
    const plain = [{ id: "ic", car_code: "SDM27", name: "SDM27" }, { id: "ev", car_code: "SDM27e", name: "SDM27e" }, { id: "old", car_code: "SDM26", name: "SDM26" }];
    expect(guessCar("IC", plain)).toBe("ic");
    // the org structure's IC/EV setting wins over names
    const set = [{ id: "a", car_code: "Gen7", name: "Gen7", program: "ev" as const }, { id: "b", car_code: "Gen6", name: "Gen6", program: "ic" as const }];
    expect(guessCar("EV Team/Aero.csv", set)).toBe("a");
    expect(guessCar("IC Team/Aero.csv", set)).toBe("b");
  });
});
