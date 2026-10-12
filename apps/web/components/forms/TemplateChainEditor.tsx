"use client";

import { useState, useCallback } from "react";
import { sources, type SourceKey } from "@/lib/data";
import { graphqlMutation, UPDATE_TEMPLATE_PRECEDENCE_CHAIN_MUTATION } from "@/lib/graphql";

interface TemplateChainEditorProps {
  templateId: string;
  templateCode: string;
  attributes: Array<{ code: string; name: string; currentChain: string[]; chainVersion: number }>;
  onChainUpdated?: () => void;
}

const SOURCE_CODE_MAP: Record<string, SourceKey> = {
  BLOOMBERG: "bloomberg", WSO: "wso", DEALCLOUD: "dealcloud",
  ALLVUE: "allvue", SPCIQ: "spciq", MANUAL: "manual", DERIVED: "derived",
};
const ALL_SOURCE_CODES = ["BLOOMBERG", "WSO", "DEALCLOUD", "ALLVUE", "SPCIQ"];

export function TemplateChainEditor({ templateId, templateCode, attributes, onChainUpdated }: TemplateChainEditorProps) {
  const [editingAttr, setEditingAttr] = useState<string | null>(null);
  const [draftChain, setDraftChain] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  const startEditing = useCallback((attrCode: string, currentChain: string[]) => {
    setEditingAttr(attrCode);
    setDraftChain(currentChain.filter(c => c !== "MANUAL"));
    setSaveResult(null);
  }, []);

  const moveItem = useCallback((fromIdx: number, toIdx: number) => {
    setDraftChain(prev => { const n = [...prev]; const [item] = n.splice(fromIdx, 1); n.splice(toIdx, 0, item); return n; });
  }, []);

  const removeItem = useCallback((idx: number) => {
    setDraftChain(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const addSource = useCallback((sourceCode: string) => {
    if (!draftChain.includes(sourceCode)) setDraftChain(prev => [...prev, sourceCode]);
  }, [draftChain]);

  const saveChain = useCallback(async (attrCode: string) => {
    setSaving(true);
    try {
      const result = await graphqlMutation<{ updateTemplatePrecedenceChain: any }, { templateId: string; attributeCode: string; chain: string[] }>(
        UPDATE_TEMPLATE_PRECEDENCE_CHAIN_MUTATION, { templateId, attributeCode: attrCode, chain: draftChain }
      );
      if (result.data?.updateTemplatePrecedenceChain?.success) {
        const r = result.data.updateTemplatePrecedenceChain;
        setSaveResult({ success: true, message: `Chain saved (v${r.chainVersion}). ${r.entitiesResolved} entities re-resolved.` });
        setEditingAttr(null);
        onChainUpdated?.();
      } else {
        const err = result.data?.updateTemplatePrecedenceChain?.errors?.[0];
        setSaveResult({ success: false, message: err?.message || "Failed to save chain" });
      }
    } catch (err: any) { setSaveResult({ success: false, message: err.message || "Network error" }); }
    finally { setSaving(false); }
  }, [templateId, draftChain, onChainUpdated]);

  const availableSources = ALL_SOURCE_CODES.filter(s => !draftChain.includes(s));

  return (
    <div className="space-y-4">
      {attributes.map(attr => {
        const isEditing = editingAttr === attr.code;
        const chain = isEditing ? draftChain : attr.currentChain.filter(c => c !== "MANUAL");
        return (
          <div key={attr.code} className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">{attr.name}</h3>
                <p className="text-xs text-gray-500 font-mono">{attr.code} · v{attr.chainVersion}</p>
              </div>
              {!isEditing ? (
                <button onClick={() => startEditing(attr.code, attr.currentChain)}
                  className="px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-md hover:bg-blue-100">Edit Chain</button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => { setEditingAttr(null); setSaveResult(null); }}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200">Cancel</button>
                  <button onClick={() => saveChain(attr.code)} disabled={saving || draftChain.length === 0}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50">
                    {saving ? "Saving..." : "Save & Re-resolve"}
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border-2 border-dashed"
                style={{ borderColor: sources.manual.hex + "60", background: sources.manual.hex + "08" }}>
                <span className="w-2 h-2 rounded-full" style={{ background: sources.manual.hex }} />
                <span className="text-xs font-semibold" style={{ color: sources.manual.hex }}>Manual Override</span>
                <span className="text-[9px] uppercase tracking-wider text-gray-400 ml-1">always #1</span>
              </div>
              <span className="text-gray-300">?</span>
              {chain.map((srcCode, idx) => {
                const srcKey = SOURCE_CODE_MAP[srcCode];
                const src = srcKey ? sources[srcKey] : null;
                if (!src) return null;
                return (
                  <div key={srcCode} className="flex items-center gap-1">
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border cursor-default group relative"
                      style={{ borderColor: src.hex + "40", background: src.hex + "0a" }}>
                      {isEditing && (
                        <div className="absolute -top-1 -right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          {idx > 0 && <button onClick={() => moveItem(idx, idx - 1)}
                            className="w-4 h-4 bg-white border border-gray-200 rounded-full flex items-center justify-center text-[10px] hover:bg-gray-50">?</button>}
                          {idx < chain.length - 1 && <button onClick={() => moveItem(idx, idx + 1)}
                            className="w-4 h-4 bg-white border border-gray-200 rounded-full flex items-center justify-center text-[10px] hover:bg-gray-50">?</button>}
                          <button onClick={() => removeItem(idx)}
                            className="w-4 h-4 bg-white border border-red-200 rounded-full flex items-center justify-center text-[10px] text-red-500 hover:bg-red-50">×</button>
                        </div>
                      )}
                      <span className="w-2 h-2 rounded-full" style={{ background: src.hex }} />
                      <span className="text-xs font-medium" style={{ color: src.hex }}>{src.name}</span>
                      <span className="text-[9px] text-gray-400">#{idx + 2}</span>
                    </div>
                    {idx < chain.length - 1 && <span className="text-gray-300">?</span>}
                  </div>
                );
              })}
            </div>
            {isEditing && availableSources.length > 0 && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-gray-500">Add source:</span>
                {availableSources.map(srcCode => {
                  const srcKey = SOURCE_CODE_MAP[srcCode];
                  const src = srcKey ? sources[srcKey] : null;
                  if (!src) return null;
                  return (
                    <button key={srcCode} onClick={() => addSource(srcCode)}
                      className="px-2 py-1 text-xs rounded border border-dashed hover:border-solid transition-all"
                      style={{ borderColor: src.hex + "40", color: src.hex }}>+ {src.name}</button>
                  );
                })}
              </div>
            )}
            {saveResult && (
              <div className={`mt-3 px-3 py-2 rounded text-xs ${saveResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                {saveResult.message}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
