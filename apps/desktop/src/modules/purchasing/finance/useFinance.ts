import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@helios/auth";
import {
  fetchAccounts, fetchBalances, fetchCategories, fetchEvidence, fetchReimbursements, fetchResolutions, fetchStatements,
  fetchTransactions, type Category, type EvidenceRow, type ReimbursementWithReceipts, type Resolution,
} from "./api";
import type { Account, BalanceEntry, Statement, Txn } from "./ledger";

/** Everything the exec finance pages show. Members only load their own reimbursements. */
export interface FinanceData {
  accounts: Account[];
  categories: Category[];
  statements: Statement[];
  txns: Txn[];
  balances: BalanceEntry[];
  evidence: EvidenceRow[];
  resolutions: Resolution[];
  reimbursements: ReimbursementWithReceipts[];
}

const EMPTY: FinanceData = {
  accounts: [], categories: [], statements: [], txns: [], balances: [], evidence: [], resolutions: [], reimbursements: [],
};
const REFRESH_MS = 60_000;

export function useFinance(client: SupabaseClient | null, active: boolean, exec: boolean) {
  const [data, setData] = useState<FinanceData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!client) return;
    try {
      if (exec) {
        const [accounts, categories, statements, txns, balances, evidence, resolutions, reimbursements] = await Promise.all([
          fetchAccounts(client), fetchCategories(client), fetchStatements(client), fetchTransactions(client),
          fetchBalances(client), fetchEvidence(client), fetchResolutions(client), fetchReimbursements(client),
        ]);
        setData({ accounts, categories, statements, txns, balances, evidence, resolutions, reimbursements });
      } else {
        setData({ ...EMPTY, reimbursements: await fetchReimbursements(client) });
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, exec]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [active, reload]);

  return useMemo(() => ({ data, loading, error, reload }), [data, loading, error, reload]);
}
