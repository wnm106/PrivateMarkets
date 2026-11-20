'use client';

export interface ClientModuleOption {
  code: string;
  name: string;
  description: string;
  domainCodes: string[];
  surfaceCodes: string[];
  workflowCodes: string[];
  toolHrefs: string[];
}

const SURFACE_TITLES: Record<string, string> = {
  'fund-index': 'Fund surface',
  'deal-pipeline': 'Deal Pipeline',
};

/** One line naming what saving this module turns on. */
export function moduleContents(module: ClientModuleOption): string {
  const parts: string[] = [];
  if (module.domainCodes.length === 1) parts.push('1 entity type');
  else if (module.domainCodes.length > 1) parts.push(`${module.domainCodes.length} entity types`);
  const surfaces = module.surfaceCodes.map((code) => SURFACE_TITLES[code] || code);
  if (surfaces.length) parts.push(surfaces.join(', '));
  if (module.workflowCodes.length === 1) parts.push('1 workflow');
  else if (module.workflowCodes.length > 1) parts.push(`${module.workflowCodes.length} workflows`);
  return parts.join(' · ');
}

export function ModuleChoices({
  modules,
  selected,
  onToggle,
}: {
  modules: ClientModuleOption[];
  selected: readonly string[];
  onToggle: (code: string, on: boolean) => void;
}) {
  const chosen = new Set(selected);
  return (
    <div className="space-y-2">
      {modules.map((module) => {
        const contents = moduleContents(module);
        return (
          <label key={module.code} className="flex gap-3 rounded border border-gray-200 px-3 py-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={chosen.has(module.code)}
              onChange={(event) => onToggle(module.code, event.target.checked)}
            />
            <span>
              <span className="block text-[13px] font-medium text-gray-900">{module.name}</span>
              <span className="block text-[12px] text-gray-600">{module.description}</span>
              {contents && <span className="block text-[12px] text-gray-500">{contents}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function experienceLabel(curated: boolean, moduleCodes: readonly string[], modules: readonly ClientModuleOption[]): string {
  if (!curated) return 'Full catalog';
  if (moduleCodes.length === 0) return 'Nothing enabled';
  const names = new Map(modules.map((module) => [module.code, module.name]));
  return moduleCodes.map((code) => names.get(code) || code).join(', ');
}
