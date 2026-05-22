// Hook that fetches the optimizable-parameter schema for a config path.
// The backend reads `n_cylinders` from the config to populate per-cylinder
// array bounds, so the hook re-runs when the path changes.

import { useEffect, useState } from "react";
import { useCfd } from "../state/CfdContext";
import type { ParameterMeta } from "../state/types";

export interface ParameterSchemaState {
  schema: ParameterMeta[] | null;
  loading: boolean;
  error: string | null;
}

export function useParameterSchema(configPath: string | null): ParameterSchemaState {
  const { bridge } = useCfd();
  const [state, setState] = useState<ParameterSchemaState>({
    schema: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!configPath) {
      setState({ schema: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ schema: null, loading: true, error: null });
    bridge
      .getParameterSchema(configPath)
      .then((s) => {
        if (!cancelled) setState({ schema: s, loading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ schema: null, loading: false, error: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [configPath, bridge]);

  return state;
}
