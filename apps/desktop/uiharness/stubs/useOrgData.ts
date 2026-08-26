// Harness stub for the org capability/subteam hooks.
export function useMyCapabilities() {
  return {
    can: () => true,
    canAnywhere: () => true,
    loading: false,
    error: null,
    refetch: () => {},
  };
}
export function useSubteams() {
  return {
    data: [
      { id: "s1", name: "Aerodynamics", code: "AERO", color: null },
      { id: "s2", name: "Chassis", code: "CHS", color: null },
    ],
    refetch: () => {},
  };
}
export interface Subteam {
  id: string;
  name: string;
  code: string;
  color: string | null;
  icon?: string | null;
}
