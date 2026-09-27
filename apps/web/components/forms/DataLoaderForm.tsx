'use client';

import { useState, useEffect } from 'react';
import { useCreateDataLoader, useUpdateDataLoader, useDataConnections } from '@/lib/hooks/useDataConnections';

interface DataLoaderFormProps {
  loader?: any;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export default function DataLoaderForm({ loader, onSuccess, onCancel }: DataLoaderFormProps) {
  const isEdit = !!loader;
  const createMutation = useCreateDataLoader();
  const updateMutation = useUpdateDataLoader();
  const { data: connections } = useDataConnections();

  const [activeTab, setActiveTab] = useState<'basic' | 'schedule' | 'transform'>('basic');

  const [formData, setFormData] = useState({
    loaderCode: loader?.loaderCode || '',
    loaderName: loader?.loaderName || '',
    connectionId: loader?.connectionId || '',
    domainCode: loader?.domainCode || '',
    attributeCodes: loader?.attributeCodes?.join(', ') || '',
    loadFrequency: loader?.loadFrequency || 'DAILY',
    cronExpression: loader?.cronExpression || '',
    loadWindow: loader?.loadWindow || 'OVERNIGHT',
    batchSize: loader?.batchSize || 1000,
    isActive: loader?.isActive !== false,
  });

  const [transformMapping, setTransformMapping] = useState<string>(() => {
    try {
      return JSON.stringify(loader?.transformMapping || {}, null, 2);
    } catch {
      return '{}';
    }
  });

  const [fieldMapping, setFieldMapping] = useState<string>(() => {
    try {
      return JSON.stringify(loader?.fieldMapping || {}, null, 2);
    } catch {
      return '{}';
    }
  });

  useEffect(() => {
    // Set default cron expression based on frequency
    if (!isEdit && !formData.cronExpression) {
      const defaultCron = getDefaultCron(formData.loadFrequency);
      setFormData({ ...formData, cronExpression: defaultCron });
    }
  }, [formData.loadFrequency]);

  const getDefaultCron = (frequency: string) => {
    switch (frequency) {
      case 'INTRADAY':
        return '*/30 9-16 * * 1-5'; // Every 30 min during market hours
      case 'HOURLY':
        return '0 * * * *'; // Every hour
      case 'DAILY':
        return '0 2 * * *'; // 2 AM daily
      case 'WEEKLY':
        return '0 2 * * 0'; // 2 AM Sunday
      case 'MONTHLY':
        return '0 2 1 * *'; // 2 AM first of month
      default:
        return '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let transformObj = {};
    let fieldObj = {};

    try {
      transformObj = JSON.parse(transformMapping);
      fieldObj = JSON.parse(fieldMapping);
    } catch (error) {
      alert('Invalid JSON in transform or field mapping');
      return;
    }

    const input = {
      loaderCode: formData.loaderCode,
      loaderName: formData.loaderName,
      connectionId: formData.connectionId,
      domainCode: formData.domainCode || null,
      attributeCodes: formData.attributeCodes
        ? formData.attributeCodes.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      loadFrequency: formData.loadFrequency,
      cronExpression: formData.cronExpression,
      loadWindow: formData.loadWindow,
      batchSize: formData.batchSize,
      transformMapping: transformObj,
      fieldMapping: fieldObj,
      isActive: formData.isActive,
    };

    try {
      if (isEdit) {
        await updateMutation.mutateAsync({ id: loader.id, ...input });
      } else {
        await createMutation.mutateAsync(input);
      }
      onSuccess?.();
    } catch (error) {
      console.error('Error saving loader:', error);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="form-container">
      <div className="form-tabs">
        <button
          type="button"
          className={`tab ${activeTab === 'basic' ? 'active' : ''}`}
          onClick={() => setActiveTab('basic')}
        >
          Basic Info
        </button>
        <button
          type="button"
          className={`tab ${activeTab === 'schedule' ? 'active' : ''}`}
          onClick={() => setActiveTab('schedule')}
        >
          Schedule
        </button>
        <button
          type="button"
          className={`tab ${activeTab === 'transform' ? 'active' : ''}`}
          onClick={() => setActiveTab('transform')}
        >
          Transform
        </button>
      </div>

      {activeTab === 'basic' && (
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="field">
            <label>Loader Code *</label>
            <input
              type="text"
              value={formData.loaderCode}
              onChange={(e) => setFormData({ ...formData, loaderCode: e.target.value })}
              className="text-input"
              placeholder="e.g., BLOOMBERG_NAV_INTRADAY"
              required
              disabled={isEdit}
            />
          </div>

          <div className="field">
            <label>Loader Name *</label>
            <input
              type="text"
              value={formData.loaderName}
              onChange={(e) => setFormData({ ...formData, loaderName: e.target.value })}
              className="text-input"
              placeholder="e.g., Bloomberg NAV Intraday"
              required
            />
          </div>

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Data Connection *</label>
            <select
              value={formData.connectionId}
              onChange={(e) => setFormData({ ...formData, connectionId: e.target.value })}
              className="select"
              required
            >
              <option value="">Select a connection...</option>
              {connections?.map((conn: any) => (
                <option key={conn.id} value={conn.id}>
                  {conn.connectionName} ({conn.connectionCode})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Domain Code</label>
            <select
              value={formData.domainCode}
              onChange={(e) => setFormData({ ...formData, domainCode: e.target.value })}
              className="select"
            >
              <option value="">Select domain...</option>
              <option value="FUND">Fund</option>
              <option value="ISSUER">Issuer</option>
              <option value="SECURITY">Security</option>
              <option value="DEAL">Deal</option>
              <option value="POSITION">Position</option>
            </select>
          </div>

          <div className="field">
            <label>Attribute Codes (comma-separated)</label>
            <input
              type="text"
              value={formData.attributeCodes}
              onChange={(e) => setFormData({ ...formData, attributeCodes: e.target.value })}
              className="text-input"
              placeholder="e.g., NAV, NAV_DATE, NAV_CURRENCY"
            />
          </div>

          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={formData.isActive}
                onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
              />
              Is Active
            </label>
          </div>
        </div>
      )}

      {activeTab === 'schedule' && (
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="field">
            <label>Load Frequency *</label>
            <select
              value={formData.loadFrequency}
              onChange={(e) => setFormData({ ...formData, loadFrequency: e.target.value })}
              className="select"
              required
            >
              <option value="INTRADAY">Intraday</option>
              <option value="HOURLY">Hourly</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="ON_DEMAND">On Demand</option>
            </select>
          </div>

          <div className="field">
            <label>Load Window</label>
            <select
              value={formData.loadWindow}
              onChange={(e) => setFormData({ ...formData, loadWindow: e.target.value })}
              className="select"
            >
              <option value="OVERNIGHT">Overnight</option>
              <option value="MARKET_HOURS">Market Hours</option>
              <option value="ANYTIME">Anytime</option>
            </select>
          </div>

          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Cron Expression *</label>
            <input
              type="text"
              value={formData.cronExpression}
              onChange={(e) => setFormData({ ...formData, cronExpression: e.target.value })}
              className="text-input"
              placeholder="0 2 * * *"
              required
            />
            <small className="text-muted">
              Standard cron format: minute hour day month weekday (e.g., "0 2 * * *" = 2 AM daily)
            </small>
          </div>

          <div className="field">
            <label>Batch Size</label>
            <input
              type="number"
              value={formData.batchSize}
              onChange={(e) => setFormData({ ...formData, batchSize: parseInt(e.target.value) })}
              className="text-input"
              min="1"
            />
          </div>
        </div>
      )}

      {activeTab === 'transform' && (
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div className="field">
            <label>Transform Mapping (JSON)</label>
            <textarea
              value={transformMapping}
              onChange={(e) => setTransformMapping(e.target.value)}
              className="text-input"
              rows={10}
              style={{ fontFamily: 'monospace', fontSize: '13px' }}
              placeholder='{"field": "expression"}'
            />
          </div>

          <div className="field">
            <label>Field Mapping (JSON)</label>
            <textarea
              value={fieldMapping}
              onChange={(e) => setFieldMapping(e.target.value)}
              className="text-input"
              rows={10}
              style={{ fontFamily: 'monospace', fontSize: '13px' }}
              placeholder='{"sourceField": "targetField"}'
            />
          </div>
        </div>
      )}

      <div className="form-actions">
        <button type="button" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          {isEdit ? 'Update Loader' : 'Create Loader'}
        </button>
      </div>
    </form>
  );
}
