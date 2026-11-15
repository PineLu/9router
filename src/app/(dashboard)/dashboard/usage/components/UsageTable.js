"use client";

import { useState, useEffect, useCallback, useMemo, Fragment } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

function fmtTime(iso) {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function SortIcon({ field, currentSort, currentOrder }) {
  if (currentSort !== field) return <span className="ml-1 opacity-20">↕</span>;
  return <span className="ml-1">{currentOrder === "asc" ? "↑" : "↓"}</span>;
}

SortIcon.propTypes = {
  field: PropTypes.string.isRequired,
  currentSort: PropTypes.string.isRequired,
  currentOrder: PropTypes.string.isRequired,
};

/**
 * Render 3 token or cost cells based on viewMode
 */
function ValueCells({ item, viewMode, isSummary = false }) {
  if (viewMode === "tokens") {
    return (
      <>
        <td className="px-6 py-3 text-right text-text-muted">
          {isSummary && item.promptTokens === undefined ? "—" : fmt(item.promptTokens)}
        </td>
        <td className="px-6 py-3 text-right text-text-muted">
          {item.cachedTokens ? fmt(item.cachedTokens) : "—"}
        </td>
        <td className="px-6 py-3 text-right text-text-muted">
          {isSummary && item.completionTokens === undefined ? "—" : fmt(item.completionTokens)}
        </td>
        <td className="px-6 py-3 text-right font-medium">
          {fmt(item.totalTokens)}
        </td>
      </>
    );
  }
  return (
    <>
      <td className="px-6 py-3 text-right text-text-muted">
        {isSummary && item.inputCost === undefined ? "—" : fmtCost(item.inputCost)}
      </td>
      <td className="px-6 py-3 text-right text-text-muted">
        {item.cachedCost ? fmtCost(item.cachedCost) : "—"}
      </td>
      <td className="px-6 py-3 text-right text-text-muted">
        {isSummary && item.outputCost === undefined ? "—" : fmtCost(item.outputCost)}
      </td>
      <td className="px-6 py-3 text-right font-medium text-warning">
        {fmtCost(item.totalCost || item.cost)}
      </td>
    </>
  );
}

ValueCells.propTypes = {
  item: PropTypes.object.isRequired,
  viewMode: PropTypes.string.isRequired,
  isSummary: PropTypes.bool,
};

/**
 * Reusable sortable usage table with expandable group rows.
 *
 * @param {object} props
 * @param {string} props.title - Table title
 * @param {Array} props.columns - Column definitions [{field, label}]
 * @param {Array} props.groupedData - Grouped data from groupDataByKey
 * @param {string} props.tableType - Table type key for sort URL params
 * @param {string} props.sortBy - Current sort field
 * @param {string} props.sortOrder - Current sort order
 * @param {function} props.onToggleSort - Sort toggle handler
 * @param {string} props.viewMode - "tokens" or "costs"
 * @param {string} props.storageKey - localStorage key for expanded state
 * @param {function} props.renderGroupLabel - Render group summary first cell content
 * @param {function} props.renderDetailCells - Render detail row custom cells (before value cells)
 * @param {function} props.renderSummaryCells - Render summary row cells after group label (placeholder cols)
 * @param {string} props.emptyMessage - Empty state message
 */
export default function UsageTable({
  title,
  columns,
  groupedData,
  tableType,
  sortBy,
  sortOrder,
  onToggleSort,
  viewMode,
  storageKey,
  renderDetailCells,
  renderSummaryCells,
  emptyMessage,
}) {
  const [expanded, setExpanded] = useState(new Set());

  // Load expanded state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) setExpanded(new Set(JSON.parse(saved)));
    } catch (e) {
      console.error(`Failed to load ${storageKey}:`, e);
    }
  }, [storageKey]);

  // Save expanded state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch (e) {
      console.error(`Failed to save ${storageKey}:`, e);
    }
  }, [expanded, storageKey]);

  const toggleGroup = useCallback((groupKey) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(groupKey) ? next.delete(groupKey) : next.add(groupKey);
      return next;
    });
  }, []);

  const valueColumns = useMemo(() => {
    if (viewMode === "tokens") {
      return [
        { field: "promptTokens", label: "Input Tokens" },
        { field: "cachedTokens", label: "Cached" },
        { field: "completionTokens", label: "Output Tokens" },
        { field: "totalTokens", label: "Total Tokens" },
      ];
    }
    return [
      { field: "promptTokens", label: "Input Cost" },
      { field: "cachedCost", label: "Cached Cost" },
      { field: "completionTokens", label: "Output Cost" },
      { field: "cost", label: "Total Cost" },
    ];
  }, [viewMode]);

  const totalColSpan = columns.length + valueColumns.length;

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-border bg-bg-subtle/50">
        <h3 className="font-semibold">{title}</h3>
      </div>
      {/* Overview tables become readable, expandable cards below the md breakpoint. */}
      <div className="space-y-3 p-3 md:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
            Sort by
            <select
              value={sortBy}
              onChange={(event) => onToggleSort(tableType, event.target.value)}
              className="max-w-[180px] rounded-lg border border-border bg-surface p-2 text-base text-text-main"
            >
              {[...columns, ...valueColumns].map((column) => (
                <option key={column.field} value={column.field}>{column.label}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => onToggleSort(tableType, sortBy)}
            className="flex min-h-10 items-center gap-1 rounded-lg border border-border px-3 text-sm text-text-main"
            aria-label="Toggle sort order">
            {sortOrder === "asc" ? "↑ Asc" : "↓ Desc"}
          </button>
        </div>
        {groupedData.length === 0 ? (
          <p className="p-6 text-center text-sm text-text-muted">{emptyMessage}</p>
        ) : groupedData.map((group) => (
          <section key={group.groupKey} className="min-w-0 overflow-hidden rounded-xl border border-border-subtle bg-surface-2/30">
            <button type="button" onClick={() => toggleGroup(group.groupKey)}
              aria-expanded={expanded.has(group.groupKey)}
              className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left">
              <span className="min-w-0 flex-1 break-all text-sm font-semibold text-text-main">{group.groupKey}</span>
              <span className="shrink-0 text-right font-mono text-sm font-semibold text-primary">
                {viewMode === "tokens" ? fmt(group.summary.totalTokens) : fmtCost(group.summary.cost)}
              </span>
              <span className="material-symbols-outlined text-lg text-text-muted">
                {expanded.has(group.groupKey) ? "expand_less" : "expand_more"}
              </span>
            </button>
            <div className="grid grid-cols-3 gap-2 border-t border-border-subtle px-3 py-2 text-xs">
              <div><span className="block text-text-muted">Requests</span><span className="font-medium">{fmt(group.summary.requests)}</span></div>
              <div><span className="block text-text-muted">Input</span><span className="font-medium">{viewMode === "tokens" ? fmt(group.summary.promptTokens) : fmtCost(group.summary.inputCost)}</span></div>
              <div><span className="block text-text-muted">Output</span><span className="font-medium">{viewMode === "tokens" ? fmt(group.summary.completionTokens) : fmtCost(group.summary.outputCost)}</span></div>
            </div>
            {expanded.has(group.groupKey) && (
              <div className="space-y-2 border-t border-border-subtle bg-bg-subtle/30 p-2">
                {group.items.map((item) => (
                  <div key={item.key} className="min-w-0 rounded-lg border border-border-subtle bg-surface p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 break-all text-xs font-medium text-text-main">{item.rawModel || item.model || item.accountName || item.keyName || item.key}</span>
                      <span className="shrink-0 font-mono text-xs text-primary">
                        {viewMode === "tokens" ? fmt(item.totalTokens) : fmtCost(item.cost)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                      <span>{fmt(item.requests)} requests</span>
                      <span>Input {viewMode === "tokens" ? fmt(item.promptTokens) : fmtCost(item.inputCost)}</span>
                      <span>Output {viewMode === "tokens" ? fmt(item.completionTokens) : fmtCost(item.outputCost)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm text-left">
          <thead className="bg-bg-subtle/30 text-text-muted uppercase text-xs">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.field}
                  className={`px-6 py-3 cursor-pointer hover:bg-bg-subtle/50 ${col.align === "right" ? "text-right" : ""}`}
                  onClick={() => onToggleSort(tableType, col.field)}
                >
                  {col.label}{" "}
                  <SortIcon field={col.field} currentSort={sortBy} currentOrder={sortOrder} />
                </th>
              ))}
              {valueColumns.map((col) => (
                <th
                  key={col.field}
                  className="px-6 py-3 text-right cursor-pointer hover:bg-bg-subtle/50"
                  onClick={() => onToggleSort(tableType, col.field)}
                >
                  {col.label}{" "}
                  <SortIcon field={col.field} currentSort={sortBy} currentOrder={sortOrder} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {groupedData.map((group) => (
              <Fragment key={group.groupKey}>
                {/* Group summary row */}
                <tr
                  className="group-summary cursor-pointer hover:bg-bg-subtle/50 transition-colors"
                  onClick={() => toggleGroup(group.groupKey)}
                >
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${expanded.has(group.groupKey) ? "rotate-90" : ""}`}>
                        chevron_right
                      </span>
                      <span className={`font-medium transition-colors ${group.summary.pending > 0 ? "text-primary" : ""}`}>
                        {group.groupKey}
                      </span>
                    </div>
                  </td>
                  {renderSummaryCells(group)}
                  <ValueCells item={group.summary} viewMode={viewMode} isSummary />
                </tr>
                {/* Detail rows */}
                {expanded.has(group.groupKey) && group.items.map((item) => (
                  <tr
                    key={`detail-${item.key}`}
                    className="group-detail hover:bg-bg-subtle/20 transition-colors"
                  >
                    {renderDetailCells(item)}
                    <ValueCells item={item} viewMode={viewMode} />
                  </tr>
                ))}
              </Fragment>
            ))}
            {groupedData.length === 0 && (
              <tr>
                <td colSpan={totalColSpan} className="px-6 py-8 text-center text-text-muted">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

UsageTable.propTypes = {
  title: PropTypes.string.isRequired,
  columns: PropTypes.arrayOf(PropTypes.shape({
    field: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    align: PropTypes.string,
  })).isRequired,
  groupedData: PropTypes.array.isRequired,
  tableType: PropTypes.string.isRequired,
  sortBy: PropTypes.string.isRequired,
  sortOrder: PropTypes.string.isRequired,
  onToggleSort: PropTypes.func.isRequired,
  viewMode: PropTypes.string.isRequired,
  storageKey: PropTypes.string.isRequired,
  renderDetailCells: PropTypes.func.isRequired,
  renderSummaryCells: PropTypes.func.isRequired,
  emptyMessage: PropTypes.string.isRequired,
};

// Re-export utilities for use in UsageStats orchestrator
export { fmt, fmtCost, fmtTime };
