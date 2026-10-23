'use client';

import { useState, useEffect } from 'react';
import { usePublishViewContext } from '@/lib/view-context';
import { graphqlClient } from '@/lib/graphql';
import {
  DATA_SOURCES_QUERY,
  CREATE_DATA_SOURCE_MUTATION,
  UPDATE_DATA_SOURCE_MUTATION,
  DELETE_DATA_SOURCE_MUTATION,
  TOGGLE_DATA_SOURCE_ACTIVE_MUTATION,
} from '@/lib/graphql';

interface Source {
  id: string;
  sourceCode: string;
  sourceName: string;
  sourceType: string;
  vendorName: string | null;
  feedFormat: string | null;
  feedFrequency: string | null;
  precedenceRank: number;
  isActive: boolean;
  isProtected: boolean;
  color: string | null;
  metadata: any;
  createdAt: string;
  updatedAt: string;
}

interface SourceFormData {
  sourceCode: string;
  sourceName: string;
  sourceType: string;
  vendorName: string;
  feedFormat: string;
  feedFrequency: string;
  precedenceRank: number;
  color: string;
  isActive: boolean;
}

const SOURCE_TYPES = ['VENDOR', 'INTERNAL', 'MANUAL', 'CALCULATED'];
const FEED_FORMATS = ['JSON', 'CSV', 'XML', 'API', 'FLAT_FILE', 'OTHER'];
const FEED_FREQUENCIES = ['REAL_TIME', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND'];
const DEFAULT_COLOR = '#6b7280';

export default function AdminSourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [formData, setFormData] = useState<SourceFormData>({
    sourceCode: '', sourceName: '', sourceType: 'VENDOR', vendorName: '',
    feedFormat: 'API', feedFrequency: 'DAILY', precedenceRank: 100,
    color: DEFAULT_COLOR, isActive: true,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<'precedenceRank' | 'sourceName'>('precedenceRank');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  usePublishViewContext(
    showModal
      ? {
          activity: editingSource ? 'editing' : 'creating',
          kind: 'data-source',
          label: formData.sourceName || formData.sourceCode || 'Data source',
          id: editingSource?.id,
          summary: formData.sourceType,
          snapshot: { ...formData },
        }
      : null
  );

  useEffect(() => { loadSources(); }, []);

  const loadSources = async () => {
    setLoading(true); setError(null);
    try {
      const result = await graphqlClient.query(DATA_SOURCES_QUERY, {}, { requestPolicy: 'network-only' }).toPromise();
      if (result.error) setError(result.error.message);
      else if (result.data?.dataSources) {
        setSources(result.data.dataSources.map((source: Source) => ({
          ...source,
          color: source.color || source.metadata?.color || null,
        })));
      }
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  };

  const handleCreate = () => {
    setEditingSource(null);
    setFormData({ sourceCode: '', sourceName: '', sourceType: 'VENDOR', vendorName: '',
      feedFormat: 'API', feedFrequency: 'DAILY', precedenceRank: 100, color: DEFAULT_COLOR, isActive: true });
    setShowModal(true);
  };

  const handleEdit = (source: Source) => {
    setEditingSource(source);
    setFormData({ sourceCode: source.sourceCode, sourceName: source.sourceName,
      sourceType: source.sourceType, vendorName: source.vendorName || '',
      feedFormat: source.feedFormat || 'API', feedFrequency: source.feedFrequency || 'DAILY',
      precedenceRank: source.precedenceRank, color: source.color || DEFAULT_COLOR, isActive: source.isActive });
    setShowModal(true);
  };

  const handleSave = async () => {
    try {
      if (editingSource) {
        const result = await graphqlClient.mutation(UPDATE_DATA_SOURCE_MUTATION, {
          input: { id: editingSource.id, sourceName: formData.sourceName, sourceType: formData.sourceType,
            vendorName: formData.vendorName || null, feedFormat: formData.feedFormat || null,
            feedFrequency: formData.feedFrequency || null, precedenceRank: formData.precedenceRank,
            color: formData.color, isActive: formData.isActive },
        }).toPromise();
        if (result.error) { setError(result.error.message); return; }
        if (result.data?.updateDataSource?.errors?.length > 0) { setError(result.data.updateDataSource.errors[0].message); return; }
      } else {
        const result = await graphqlClient.mutation(CREATE_DATA_SOURCE_MUTATION, {
          input: { sourceCode: formData.sourceCode.toUpperCase(), sourceName: formData.sourceName,
            sourceType: formData.sourceType, vendorName: formData.vendorName || null,
            feedFormat: formData.feedFormat || null, feedFrequency: formData.feedFrequency || null,
            precedenceRank: formData.precedenceRank, color: formData.color },
        }).toPromise();
        if (result.error) { setError(result.error.message); return; }
        if (result.data?.createDataSource?.errors?.length > 0) { setError(result.data.createDataSource.errors[0].message); return; }
      }
      setShowModal(false);
      await loadSources();
      window.dispatchEvent(new Event('sources-updated'));
    } catch (err: any) { setError(err.message); }
  };

  const handleDelete = async (source: Source) => {
    if (source.isProtected) { setError('Cannot delete a protected source'); return; }
    if (!confirm(`Delete "${source.sourceName}"?`)) return;
    try {
      const result = await graphqlClient.mutation(DELETE_DATA_SOURCE_MUTATION, { id: source.id }).toPromise();
      if (result.error) { setError(result.error.message); return; }
      if (result.data?.deleteDataSource?.errors?.length > 0) { setError(result.data.deleteDataSource.errors[0].message); return; }
      await loadSources();
    } catch (err: any) { setError(err.message); }
  };

  const handleToggleActive = async (source: Source) => {
    if (source.isProtected && source.isActive) return;
    try {
      const result = await graphqlClient.mutation(TOGGLE_DATA_SOURCE_ACTIVE_MUTATION, { id: source.id, active: !source.isActive }).toPromise();
      if (result.error) { setError(result.error.message); return; }
      if (result.data?.toggleDataSourceActive?.errors?.length > 0) { setError(result.data.toggleDataSourceActive.errors[0].message); return; }
      await loadSources();
    } catch (err: any) { setError(err.message); }
  };

  const handleSort = (field: 'precedenceRank' | 'sourceName') => {
    if (sortField === field) setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDirection('asc'); }
  };

  const filteredSources = sources
    .filter(s => { const q = searchQuery.toLowerCase(); return s.sourceName.toLowerCase().includes(q) || s.sourceCode.toLowerCase().includes(q) || (s.vendorName?.toLowerCase().includes(q) ?? false); })
    .sort((a, b) => { const m = sortDirection === 'asc' ? 1 : -1; return sortField === 'precedenceRank' ? (a.precedenceRank - b.precedenceRank) * m : a.sourceName.localeCompare(b.sourceName) * m; });

  const generateSourceCode = (name: string) => name.toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, '_').substring(0, 50);


  if (loading) {
    return <div className="p-8"><div className="text-center">Loading sources...</div></div>;
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Source Registry</h1>
        <p className="text-gray-600">
          Manage the data sources that provide attribute values for entities. Manual Override is protected and cannot be removed.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-center justify-between">
            <span className="text-red-800">{error}</span>
            <button onClick={() => setError(null)} className="text-red-600 hover:text-red-800">×</button>
          </div>
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex-1 max-w-md">
          <input type="text" placeholder="Search sources..." value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <button onClick={handleCreate} className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">
          + Add Source
        </button>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Code</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Vendor</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Feed</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('precedenceRank')}>
                Precedence {sortField === 'precedenceRank' && (sortDirection === 'asc' ? '↑' : '↓')}
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredSources.map((source) => (
              <tr key={source.id} className={`hover:bg-gray-50 ${!source.isActive ? 'opacity-50' : ''}`}>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center gap-3">
                    {source.isProtected && <span className="text-gray-400" title="Protected source">🔒</span>}
                    <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: source.color || DEFAULT_COLOR }} />
                    <span className={`font-medium ${!source.isActive ? 'line-through' : ''}`}>{source.sourceName}</span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">{source.sourceCode}</code>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 py-1 text-xs font-medium rounded ${
                    source.sourceType === 'VENDOR' ? 'bg-blue-100 text-blue-800'
                    : source.sourceType === 'INTERNAL' ? 'bg-green-100 text-green-800'
                    : source.sourceType === 'MANUAL' ? 'bg-yellow-100 text-yellow-800'
                    : 'bg-gray-100 text-gray-800'
                  }`}>{source.sourceType}</span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{source.vendorName || '-'}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {source.feedFormat ? `${source.feedFormat} / ${source.feedFrequency || 'N/A'}` : '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{source.precedenceRank}</td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <button onClick={() => handleToggleActive(source)} disabled={source.isProtected && source.isActive}
                    className={`px-3 py-1 text-xs font-medium rounded ${
                      source.isActive ? 'bg-green-100 text-green-800 hover:bg-green-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    } ${source.isProtected && source.isActive ? 'cursor-not-allowed opacity-50' : ''}`}>
                    {source.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm">
                  <div className="flex gap-2">
                    <button onClick={() => handleEdit(source)} className="text-blue-600 hover:text-blue-800">Edit</button>
                    {!source.isProtected && (
                      <button onClick={() => handleDelete(source)} className="text-red-600 hover:text-red-800">Delete</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredSources.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            {searchQuery ? 'No sources match your search' : 'No sources found'}
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold">{editingSource ? 'Edit Source' : 'Add Source'}</h2>
                <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 text-2xl">×</button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Source Name <span className="text-red-500">*</span>
                  </label>
                  <input type="text" value={formData.sourceName}
                    onChange={(e) => {
                      const name = e.target.value;
                      setFormData({ ...formData, sourceName: name,
                        sourceCode: editingSource ? formData.sourceCode : generateSourceCode(name) });
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g., Bloomberg Terminal" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Source Code <span className="text-red-500">*</span>
                  </label>
                  <input type="text" value={formData.sourceCode}
                    onChange={(e) => setFormData({ ...formData, sourceCode: e.target.value.toUpperCase() })}
                    disabled={!!editingSource}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                    placeholder="e.g., BLOOMBERG" />
                  <p className="text-xs text-gray-500 mt-1">Auto-generated from name. Uppercase snake_case format.</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Source Type</label>
                  <select value={formData.sourceType} onChange={(e) => setFormData({ ...formData, sourceType: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {SOURCE_TYPES.map((type) => (<option key={type} value={type}>{type}</option>))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Name</label>
                  <input type="text" value={formData.vendorName}
                    onChange={(e) => setFormData({ ...formData, vendorName: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="e.g., Bloomberg LP" />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Feed Format</label>
                    <select value={formData.feedFormat} onChange={(e) => setFormData({ ...formData, feedFormat: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {FEED_FORMATS.map((format) => (<option key={format} value={format}>{format}</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Feed Frequency</label>
                    <select value={formData.feedFrequency} onChange={(e) => setFormData({ ...formData, feedFrequency: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {FEED_FREQUENCIES.map((freq) => (<option key={freq} value={freq}>{freq}</option>))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Precedence Rank</label>
                  <input type="number" value={formData.precedenceRank}
                    onChange={(e) => setFormData({ ...formData, precedenceRank: parseInt(e.target.value) || 100 })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" min="1" />
                  <p className="text-xs text-gray-500 mt-1">Lower numbers have higher priority</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
                  <div className="flex items-center gap-3">
                    <input type="color" value={formData.color}
                      onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                      className="w-16 h-10 border border-gray-300 rounded cursor-pointer" />
                    <input type="text" value={formData.color}
                      onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="#6b7280" />
                  </div>
                </div>

                {!editingSource && (
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="isActive" checked={formData.isActive}
                      onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })} className="w-4 h-4" />
                    <label htmlFor="isActive" className="text-sm font-medium text-gray-700">Active</label>
                  </div>
                )}
              </div>

              <div className="flex gap-3 mt-6">
                <button onClick={handleSave}
                  disabled={!formData.sourceName || !formData.sourceCode}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:bg-gray-300 disabled:cursor-not-allowed">
                  {editingSource ? 'Update' : 'Create'}
                </button>
                <button onClick={() => setShowModal(false)}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 font-medium">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
