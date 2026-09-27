'use client';

import { useState } from 'react';
import { useCreateDataConnection, useUpdateDataConnection } from '@/lib/hooks/useDataConnections';

interface DataConnectionFormProps {
  connection?: any;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export default function DataConnectionForm({ connection, onSuccess, onCancel }: DataConnectionFormProps) {
  const isEdit = !!connection;
  const createMutation = useCreateDataConnection();
  const updateMutation = useUpdateDataConnection();

  const [activeTab, setActiveTab] = useState<'basic' | 'endpoint' | 'auth'>('basic');

  const [formData, setFormData] = useState({
    connectionCode: connection?.connectionCode || '',
    connectionName: connection?.connectionName || '',
    sourceType: connection?.sourceType || 'VENDOR',
    vendorName: connection?.vendorName || '',
    endpointUrl: connection?.endpointUrl || '',
    endpointMethod: connection?.endpointMethod || 'GET',
    requestTimeout: connection?.requestTimeout || 30000,
    precedenceRank: connection?.precedenceRank || 100,
    isActive: connection?.isActive !== false,
    authType: connection?.authType || 'NONE',
    authConfig: connection?.authConfig || {},
  });

  const [authFields, setAuthFields] = useState<Record<string, string>>(() => {
    const config = connection?.authConfig || {};
    const fields: Record<string, string> = {};
    
    // Initialize fields based on auth type
    if (config.apiKeyHeader) fields.apiKeyHeader = config.apiKeyHeader;
    if (config.apiKeyValue) fields.apiKeyValue = config.apiKeyValue;
    if (config.tokenHeader) fields.tokenHeader = config.tokenHeader || 'Authorization';
    if (config.tokenValue) fields.tokenValue = config.tokenValue;
    if (config.username) fields.username = config.username;
    if (config.password) fields.password = config.password;
    if (config.tokenUrl) fields.tokenUrl = config.tokenUrl;
    if (config.clientId) fields.clientId = config.clientId;
    if (config.clientSecret) fields.clientSecret = config.clientSecret;
    if (config.scopes) fields.scopes = config.scopes;
    if (config.certPath) fields.certPath = config.certPath;
    if (config.keyPath) fields.keyPath = config.keyPath;
    if (config.customHeaderName) fields.customHeaderName = config.customHeaderName;
    if (config.customHeaderValue) fields.customHeaderValue = config.customHeaderValue;
    
    return fields;
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Build auth config based on auth type
    const authConfig: Record<string, any> = {};
    
    switch (formData.authType) {
      case 'API_KEY':
        authConfig.apiKeyHeader = authFields.apiKeyHeader || 'X-API-Key';
        authConfig.apiKeyValue = authFields.apiKeyValue;
        break;
      case 'BEARER_TOKEN':
        authConfig.tokenHeader = authFields.tokenHeader || 'Authorization';
        authConfig.tokenValue = authFields.tokenValue;
        break;
      case 'BASIC_AUTH':
        authConfig.username = authFields.username;
        authConfig.password = authFields.password;
        break;
      case 'OAUTH2_CLIENT':
        authConfig.tokenUrl = authFields.tokenUrl;
        authConfig.clientId = authFields.clientId;
        authConfig.clientSecret = authFields.clientSecret;
        authConfig.scopes = authFields.scopes;
        break;
      case 'CERTIFICATE':
        authConfig.certPath = authFields.certPath;
        authConfig.keyPath = authFields.keyPath;
        break;
      case 'CUSTOM_HEADER':
        authConfig.customHeaderName = authFields.customHeaderName;
        authConfig.customHeaderValue = authFields.customHeaderValue;
        break;
    }

    const input = {
      connectionCode: formData.connectionCode,
      connectionName: formData.connectionName,
      sourceType: formData.sourceType,
      vendorName: formData.vendorName,
      endpointUrl: formData.endpointUrl,
      endpointMethod: formData.endpointMethod,
      requestTimeout: formData.requestTimeout,
      precedenceRank: formData.precedenceRank,
      isActive: formData.isActive,
      authType: formData.authType,
      authConfig,
    };

    try {
      if (isEdit) {
        await updateMutation.mutateAsync({ id: connection.id, ...input });
      } else {
        await createMutation.mutateAsync(input);
      }
      onSuccess?.();
    } catch (error) {
      console.error('Error saving connection:', error);
    }
  };

  const renderAuthFields = () => {
    switch (formData.authType) {
      case 'API_KEY':
        return (
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field">
              <label>API Key Header Name</label>
              <input
                type="text"
                value={authFields.apiKeyHeader || 'X-API-Key'}
                onChange={(e) => setAuthFields({ ...authFields, apiKeyHeader: e.target.value })}
                className="text-input"
                placeholder="X-API-Key"
              />
            </div>
            <div className="field">
              <label>API Key Value</label>
              <input
                type="password"
                value={authFields.apiKeyValue || ''}
                onChange={(e) => setAuthFields({ ...authFields, apiKeyValue: e.target.value })}
                className="text-input"
                placeholder="Enter API key"
              />
            </div>
          </div>
        );

      case 'BEARER_TOKEN':
        return (
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field">
              <label>Token Header Name</label>
              <input
                type="text"
                value={authFields.tokenHeader || 'Authorization'}
                onChange={(e) => setAuthFields({ ...authFields, tokenHeader: e.target.value })}
                className="text-input"
                placeholder="Authorization"
              />
            </div>
            <div className="field">
              <label>Bearer Token</label>
              <input
                type="password"
                value={authFields.tokenValue || ''}
                onChange={(e) => setAuthFields({ ...authFields, tokenValue: e.target.value })}
                className="text-input"
                placeholder="Enter bearer token"
              />
            </div>
          </div>
        );

      case 'BASIC_AUTH':
        return (
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field">
              <label>Username</label>
              <input
                type="text"
                value={authFields.username || ''}
                onChange={(e) => setAuthFields({ ...authFields, username: e.target.value })}
                className="text-input"
                placeholder="Username"
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={authFields.password || ''}
                onChange={(e) => setAuthFields({ ...authFields, password: e.target.value })}
                className="text-input"
                placeholder="Password"
              />
            </div>
          </div>
        );

      case 'OAUTH2_CLIENT':
        return (
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Token URL</label>
              <input
                type="text"
                value={authFields.tokenUrl || ''}
                onChange={(e) => setAuthFields({ ...authFields, tokenUrl: e.target.value })}
                className="text-input"
                placeholder="https://auth.example.com/oauth/token"
              />
            </div>
            <div className="field">
              <label>Client ID</label>
              <input
                type="text"
                value={authFields.clientId || ''}
                onChange={(e) => setAuthFields({ ...authFields, clientId: e.target.value })}
                className="text-input"
                placeholder="Client ID"
              />
            </div>
            <div className="field">
              <label>Client Secret</label>
              <input
                type="password"
                value={authFields.clientSecret || ''}
                onChange={(e) => setAuthFields({ ...authFields, clientSecret: e.target.value })}
                className="text-input"
                placeholder="Client Secret"
              />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Scopes (space-separated)</label>
              <input
                type="text"
                value={authFields.scopes || ''}
                onChange={(e) => setAuthFields({ ...authFields, scopes: e.target.value })}
                className="text-input"
                placeholder="read write"
              />
            </div>
          </div>
        );

      case 'CERTIFICATE':
        return (
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field">
              <label>Certificate Path</label>
              <input
                type="text"
                value={authFields.certPath || ''}
                onChange={(e) => setAuthFields({ ...authFields, certPath: e.target.value })}
                className="text-input"
                placeholder="/path/to/cert.pem"
              />
            </div>
            <div className="field">
              <label>Private Key Path</label>
              <input
                type="text"
                value={authFields.keyPath || ''}
                onChange={(e) => setAuthFields({ ...authFields, keyPath: e.target.value })}
                className="text-input"
                placeholder="/path/to/key.pem"
              />
            </div>
          </div>
        );

      case 'CUSTOM_HEADER':
        return (
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="field">
              <label>Header Name</label>
              <input
                type="text"
                value={authFields.customHeaderName || ''}
                onChange={(e) => setAuthFields({ ...authFields, customHeaderName: e.target.value })}
                className="text-input"
                placeholder="X-Custom-Auth"
              />
            </div>
            <div className="field">
              <label>Header Value</label>
              <input
                type="password"
                value={authFields.customHeaderValue || ''}
                onChange={(e) => setAuthFields({ ...authFields, customHeaderValue: e.target.value })}
                className="text-input"
                placeholder="Header value"
              />
            </div>
          </div>
        );

      default:
        return (
          <div className="text-muted">
            No authentication required for this connection.
          </div>
        );
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
          className={`tab ${activeTab === 'endpoint' ? 'active' : ''}`}
          onClick={() => setActiveTab('endpoint')}
        >
          Endpoint
        </button>
        <button
          type="button"
          className={`tab ${activeTab === 'auth' ? 'active' : ''}`}
          onClick={() => setActiveTab('auth')}
        >
          Authentication
        </button>
      </div>

      {activeTab === 'basic' && (
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="field">
            <label>Connection Code *</label>
            <input
              type="text"
              value={formData.connectionCode}
              onChange={(e) => setFormData({ ...formData, connectionCode: e.target.value })}
              className="text-input"
              placeholder="e.g., BLOOMBERG_API"
              required
              disabled={isEdit}
            />
          </div>

          <div className="field">
            <label>Connection Name *</label>
            <input
              type="text"
              value={formData.connectionName}
              onChange={(e) => setFormData({ ...formData, connectionName: e.target.value })}
              className="text-input"
              placeholder="e.g., Bloomberg API"
              required
            />
          </div>

          <div className="field">
            <label>Source Type *</label>
            <select
              value={formData.sourceType}
              onChange={(e) => setFormData({ ...formData, sourceType: e.target.value })}
              className="select"
              required
            >
              <option value="VENDOR">Vendor</option>
              <option value="INTERNAL">Internal</option>
              <option value="MANUAL">Manual</option>
              <option value="CALCULATED">Calculated</option>
            </select>
          </div>

          <div className="field">
            <label>Vendor Name</label>
            <input
              type="text"
              value={formData.vendorName}
              onChange={(e) => setFormData({ ...formData, vendorName: e.target.value })}
              className="text-input"
              placeholder="e.g., Bloomberg LP"
            />
          </div>

          <div className="field">
            <label>Precedence Rank</label>
            <input
              type="number"
              value={formData.precedenceRank}
              onChange={(e) => setFormData({ ...formData, precedenceRank: parseInt(e.target.value) })}
              className="text-input"
              min="1"
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

      {activeTab === 'endpoint' && (
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Endpoint URL</label>
            <input
              type="text"
              value={formData.endpointUrl}
              onChange={(e) => setFormData({ ...formData, endpointUrl: e.target.value })}
              className="text-input"
              placeholder="https://api.example.com/v1"
            />
          </div>

          <div className="field">
            <label>HTTP Method</label>
            <select
              value={formData.endpointMethod}
              onChange={(e) => setFormData({ ...formData, endpointMethod: e.target.value })}
              className="select"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>

          <div className="field">
            <label>Request Timeout (ms)</label>
            <input
              type="number"
              value={formData.requestTimeout}
              onChange={(e) => setFormData({ ...formData, requestTimeout: parseInt(e.target.value) })}
              className="text-input"
              min="1000"
              step="1000"
            />
          </div>
        </div>
      )}

      {activeTab === 'auth' && (
        <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div className="field">
            <label>Authentication Type *</label>
            <select
              value={formData.authType}
              onChange={(e) => setFormData({ ...formData, authType: e.target.value })}
              className="select"
              required
            >
              <option value="NONE">None</option>
              <option value="API_KEY">API Key</option>
              <option value="BEARER_TOKEN">Bearer Token</option>
              <option value="BASIC_AUTH">Basic Auth</option>
              <option value="OAUTH2_CLIENT">OAuth2 Client Credentials</option>
              <option value="CERTIFICATE">Certificate</option>
              <option value="CUSTOM_HEADER">Custom Header</option>
            </select>
          </div>

          {renderAuthFields()}
        </div>
      )}

      <div className="form-actions">
        <button type="button" onClick={onCancel} className="btn btn-secondary">
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          {isEdit ? 'Update Connection' : 'Create Connection'}
        </button>
      </div>
    </form>
  );
}
