'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { graphqlQuery, graphqlMutation, DOMAIN_TEMPLATES_QUERY, TEMPLATE_PRECEDENCE_CHAIN_QUERY, UPDATE_TEMPLATE_PRECEDENCE_CHAIN_MUTATION } from '@/lib/graphql';
import { sources, type SourceKey } from '@/lib/data';

interface Template {
  id: string;
  code: string;
  name: string;
  domainCode: string;
  attributes: Array<{
    attributeId: string;
    attributeCode: string;
    attributeName: string;
  }>;
}

interface AttributeChain {
  attributeCode: string;
  attributeName: string;
  chain: string[];
  chainVersion: number;
}

const SOURCE_CODE_MAP: Record<string, SourceKey> = {
  BLOOMBERG: 'bloomberg',
  WSO: 'wso',
  DEALCLOUD: 'dealcloud',
  ALLVUE: 'allvue',
  SPCIQ: 'spciq',
  MANUAL: 'manual',
  DERIVED: 'derived',
};

const ALL_SOURCE_CODES = ['BLOOMBERG', 'WSO', 'DEALCLOUD', 'ALLVUE', 'SPCIQ'];

export default function TemplatePrecedencePage() {
  const params = useParams();
  const templateId = params.templateId as string;

  const [template, setTemplate] = useState<Template | null>(null);
  const [attributeChains, setAttributeChains] = useState<AttributeChain[]>([]);
  const [editingAttr, setEditingAttr] = useState<string | null>(null);
  const [draftChain, setDraftChain] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTemplate();
  }, [templateId]);

  const loadTemplate = async () => {
    setLoading(true);
    try {
      const result = await graphqlQuery<{ domainTemplates: any[] }>(DOMAIN_TEMPLATES_QUERY, {});
      if (result.data?.domainTemplates) {
        const tpl = result.data.domainTemplates.find(t => t.id === templateId);
        if (tpl) {
          const templateData: Template = {
            id: tpl.id,
            code: tpl.templateCode,
            name: tpl.templateName,
            domainCode: tpl.domainCode,
            attributes: tpl.attributes.map((attr: any) => ({
              attributeId: attr.attributeId,
              attributeCode: attr.attribute.attributeCode,
              attributeName: attr.attribute.attributeName,
            })),
          };
          setTemplate(templateData);

          const chains: AttributeChain[] = [];
          for (const attr of templateData.attributes) {
            const chainResult = await graphqlQuery<{ templatePrecedenceChain: any }>(
              TEMPLATE_PRECEDENCE_CHAIN_QUERY,
              { templateId, attributeCode: attr.attributeCode }
            );
            chains.push({
              attributeCode: attr.attributeCode,
              attributeName: attr.attributeName,
              chain: chainResult.data?.templatePrecedenceChain?.chain || ['MANUAL'],
              chainVersion: chainResult.data?.templatePrecedenceChain?.chainVersion || 1,
            });
          }
          setAttributeChains(chains);
        }
      }
    } catch (error) {
      console.error('Error loading template:', error);
    } finally {
      setLoading(false);
    }
  };

  const startEditing = (attrCode: string, currentChain: string[]) => {
    setEditingAttr(attrCode);
    setDraftChain(currentChain.filter(c => c !== 'MANUAL'));
  };

  const moveItem = (fromIdx: number, toIdx: number) => {
    setDraftChain(prev => {
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
  };

  const removeItem = (idx: number) => {
    setDraftChain(prev => prev.filter((_, i) => i !== idx));
  };

  const addSource = (sourceCode: string) => {
    if (!draftChain.includes(sourceCode)) {
      setDraftChain(prev => [...prev, sourceCode]);
    }
  };

  const saveChain = async (attrCode: string) => {
    setSaving(true);
    try {
      const result = await graphqlMutation<{ updateTemplatePrecedenceChain: any }>(
        UPDATE_TEMPLATE_PRECEDENCE_CHAIN_MUTATION,
        { templateId, attributeCode: attrCode, chain: draftChain }
      );
      if (result.data?.updateTemplatePrecedenceChain?.success) {
        const r = result.data.updateTemplatePrecedenceChain;
        alert(`✅ Chain saved (v${r.chainVersion}). ${r.entitiesResolved} entities re-resolved.`);
        setEditingAttr(null);
        loadTemplate();
      } else {
        const err = result.data?.updateTemplatePrecedenceChain?.errors?.[0];
        alert(`❌ Failed: ${err?.message || 'Unknown error'}`);
      }
    } catch (error: any) {
      alert(`❌ Error: ${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-8">Loading...</div>;
  if (!template) return <div className="p-8">Template not found</div>;

  return null; // Placeholder - will be replaced
}
