"use client";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { formatTokens, formatUsd } from "@optio/shared";
import { api, type DeploymentUsageReport, type DeploymentUsageReportGroup } from "@/lib/api-client";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

const GROUPS: Array<{ value: DeploymentUsageReportGroup; label: string }> = [
  { value: "workspace", label: "Workspace" },
  { value: "person", label: "Person" },
  { value: "repo", label: "Repository" },
  { value: "model", label: "Model" },
  { value: "agent", label: "Agent" },
  { value: "month", label: "Month" },
];

const money = (cost: string | null) => (cost === null ? "Not reported" : formatUsd(Number(cost)));
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Usage across every workspace, for deployment admins: totals for a range of
 * UTC days grouped one way, and the same rows as a CSV download. The caller
 * shows it only to deployment admins; the API refuses everyone else.
 */
export function DeploymentUsageReportPanel() {
  const [to, setTo] = useState(today);
  const [from, setFrom] = useState(() => `${today().slice(0, 7)}-01`);
  const [groupBy, setGroupBy] = useState<DeploymentUsageReportGroup>("workspace");
  const [data, setData] = useState<DeploymentUsageReport | null>(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!from || !to) return;
    let active = true;
    setError("");
    api
      .getDeploymentUsageReport({ from, to, groupBy })
      .then((r) => active && setData(r))
      .catch((e: Error) => {
        if (!active) return;
        setData(null);
        setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [from, to, groupBy]);

  async function download() {
    setDownloading(true);
    setError("");
    try {
      const blob = await api.downloadDeploymentUsageReport({ from, to, groupBy });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `optio-usage-${groupBy}-${from}-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Panel
      title="All workspaces"
      actions={
        <Button size="sm" variant="secondary" onClick={download} disabled={downloading || !data}>
          <Download /> Download CSV
        </Button>
      }
    >
      <div className="px-4 py-3 flex flex-wrap items-center gap-3 border-b border-border/50">
        <label className="flex items-center gap-2 text-xs text-text-muted">
          From
          <input
            type="date"
            aria-label="From"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass({ className: "w-auto" })}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          To
          <input
            type="date"
            aria-label="To"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className={inputClass({ className: "w-auto" })}
          />
        </label>
        <Segmented
          aria-label="Group by"
          value={groupBy}
          onChange={setGroupBy}
          options={GROUPS}
          wrap
        />
      </div>
      {error ? (
        <PanelEmpty>{error}</PanelEmpty>
      ) : !data ? (
        <PanelEmpty>Loading…</PanelEmpty>
      ) : data.rows.length === 0 ? (
        <PanelEmpty>No usage recorded in this range.</PanelEmpty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="text-left font-medium px-4 py-2">
                  {GROUPS.find((g) => g.value === data.groupBy)?.label}
                </th>
                <th className="text-right font-medium px-4">Runs</th>
                <th className="text-right font-medium px-4">Tokens</th>
                <th className="text-right font-medium px-4">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {data.rows.map((r) => (
                <tr key={r.key ?? `none:${r.name}`}>
                  <td className="px-4 py-2 max-w-80 truncate" title={r.key ?? undefined}>
                    {r.name}
                  </td>
                  <td className="text-right px-4 tabular-nums">{r.runs}</td>
                  <td className="text-right px-4 tabular-nums">{formatTokens(r.tokens)}</td>
                  <td className="text-right px-4 tabular-nums whitespace-nowrap">
                    {money(r.costUsd)}
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="px-4 py-2">Total</td>
                <td className="text-right px-4 tabular-nums">{data.totals.runs}</td>
                <td className="text-right px-4 tabular-nums">{formatTokens(data.totals.tokens)}</td>
                <td className="text-right px-4 tabular-nums whitespace-nowrap">
                  {money(data.totals.costUsd)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-3 border-t border-border/50 text-xs text-text-muted">
        Whole UTC days, up to 366 at a time. A run active in several months counts in each of them,
        so per-month run counts can add up to more than the total.
        {data?.truncated && " Only the first 5,000 rows are shown; narrow the range."}
      </p>
    </Panel>
  );
}
