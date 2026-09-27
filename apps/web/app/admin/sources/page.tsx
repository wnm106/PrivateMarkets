import { useState } from 'react';
import Link from 'next/link';
import DataConnectionForm from '@/components/forms/DataConnectionForm';
import DataLoaderForm from '@/components/forms/DataLoaderForm';
import { useDataConnections, useDataLoaders, useDeleteDataConnection, useDeleteDataLoader, useTestDataConnection, useTriggerDataLoader } from '@/lib/hooks/useDataConnections';

export default function SourcesPage() {
  const [activeTab, setActiveTab] = useState<'connections' | 'loaders'>('connections');
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [showLoaderForm, setShowLoaderForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<any>(null);
  const [editingLoader, setEditingLoader] = useState<any>(null);

  const { data: connections, isLoading: loadingConnections } = useDataConnections();
  const { data: loaders, isLoading: loadingLoaders } = useDataLoaders();
  const deleteConnection = useDeleteDataConnection();
  const deleteLoader = useDeleteDataLoader();
  const testConnection = useTestDataConnection();
  const triggerLoader = useTriggerDataLoader();

  const handleDeleteConnection = async (id: string) => {
    if (!confirm('Are you sure you want to delete this connection? All associated loaders will also be deleted.')) {
      return;
    }
    try {
      await deleteConnection.mutateAsync(id);
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Failed to delete connection'}`);
    }
  };

  const handleDeleteLoader = async (id: string) => {
    if (!confirm('Are you sure you want to delete this loader?')) {
      return;
    }
    try {
      await deleteLoader.mutateAsync(id);
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Failed to delete loader'}`);
    }
  };

  const handleTestConnection = async (id: string) => {
    try {
      const result = await testConnection.mutateAsync(id);
      alert(`Connection test ${result.success ? 'succeeded' : 'failed'}: ${result.message}`);
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Failed to test connection'}`);
    }
  };

  const handleTriggerLoader = async (id: string) => {
    try {
      const result = await triggerLoader.mutateAsync(id);
      if (result.success) {
        alert(`Loader triggered successfully. Run ID: ${result.runId}`);
      }
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Failed to trigger loader'}`);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE': return '#10b981';
      case 'IDLE': return '#6b7280';
      case 'RUNNING': return '#3b82f6';
      case 'ERROR': return '#ef4444';
      case 'TESTING': return '#f59e0b';
      default: return '#6b7280';
    }
  };

  const getFrequencyLabel = (freq: string) => {
    switch (freq) {
      case 'INTRADAY': return 'Intraday';
      case 'HOURLY': return 'Hourly';
      case 'DAILY': return 'Daily';
      case 'WEEKLY': return 'Weekly';
      case 'MONTHLY': return 'Monthly';
      case 'ON_DEMAND': return 'On Demand';
      default: return freq;
    }
  };

  const getAuthTypeLabel = (authType: string) => {
    switch (authType) {
      case 'NONE': return 'None';
      case 'API_KEY': return 'API Key';
      case 'BEARER_TOKEN': return 'Bearer Token';
      case 'BASIC_AUTH': return 'Basic Auth';
      case 'OAUTH2_CLIENT': return 'OAuth2 Client';
      case 'CERTIFICATE': return 'Certificate';
      case 'CUSTOM_HEADER': return 'Custom Header';
      default: return authType;
    }
  };

  if (loadingConnections || loadingLoaders) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="container">
      <div className="header">
        <div className="breadcrumbs">
          <Link href="/admin" className="breadcrumb-link">Admin</Link>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-current">Data Sources</span>
        </div>
        <h1>Data Sources</h1>
        <div className="header-actions">
          {activeTab === 'connections' && (
            <button className="btn btn-primary" onClick={() => setShowConnectionForm(true)}>
              + New Connection
            </button>
          )}
          {activeTab === 'loaders' && (
            <button className="btn btn-primary" onClick={() => setShowLoaderForm(true)}>
              + New Loader
            </button>
          )}
        </div>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'connections' ? 'active' : ''}`}
          onClick={() => setActiveTab('connections')}
        >
          Connections ({connections?.length || 0})
        </button>
        <button
          className={`tab ${activeTab === 'loaders' ? 'active' : ''}`}
          onClick={() => setActiveTab('loaders')}
        >
          Loaders ({loaders?.length || 0})
        </button>
      </div>

      {activeTab === 'connections' && (
        <div className="card-grid">
          {connections?.map((conn: any) => (
            <div key={conn.id} className="card">
              <div className="card-header">
                <div>
                  <h3>{conn.connectionName}</h3>
                  <p className="card-code">{conn.connectionCode}</p>
                </div>
                <span
                  className="status-badge"
                  style={{ backgroundColor: getStatusColor(conn.connectionStatus) }}
                >
                  {conn.connectionStatus}
                </span>
              </div>

              <div className="card-body">
                <div className="detail-row">
                  <span className="detail-label">Type:</span>
                  <span>{conn.sourceType}</span>
                </div>
                {conn.vendorName && (
                  <div className="detail-row">
                    <span className="detail-label">Vendor:</span>
                    <span>{conn.vendorName}</span>
                  </div>
                )}
                {conn.endpointUrl && (
                  <div className="detail-row">
                    <span className="detail-label">Endpoint:</span>
                    <span className="mono">{conn.endpointUrl}</span>
                  </div>
                )}
                <div className="detail-row">
                  <span className="detail-label">Auth:</span>
                  <span>{getAuthTypeLabel(conn.authType)}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Precedence:</span>
                  <span>{conn.precedenceRank}</span>
                </div>
                {conn.lastTestedAt && (
                  <div className="detail-row">
                    <span className="detail-label">Last Tested:</span>
                    <span>{new Date(conn.lastTestedAt).toLocaleString()}</span>
                  </div>
                )}
                <div className="detail-row">
                  <span className="detail-label">Loaders:</span>
                  <span>{conn.loaders?.length || 0}</span>
                </div>
              </div>

              <div className="card-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => handleTestConnection(conn.id)}
                  disabled={testConnection.isPending}
                >
                  Test
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setEditingConnection(conn);
                    setShowConnectionForm(true);
                  }}
                >
                  Edit
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => handleDeleteConnection(conn.id)}
                  disabled={deleteConnection.isPending}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'loaders' && (
        <div className="card-grid">
          {loaders?.map((loader: any) => (
            <div key={loader.id} className="card">
              <div className="card-header">
                <div>
                  <h3>{loader.loaderName}</h3>
                  <p className="card-code">{loader.loaderCode}</p>
                </div>
                <span
                  className="status-badge"
                  style={{ backgroundColor: getStatusColor(loader.loaderStatus) }}
                >
                  {loader.loaderStatus}
                </span>
              </div>

              <div className="card-body">
                <div className="detail-row">
                  <span className="detail-label">Connection:</span>
                  <span>{loader.connection?.connectionName || 'N/A'}</span>
                </div>
                {loader.domainCode && (
                  <div className="detail-row">
                    <span className="detail-label">Domain:</span>
                    <span>{loader.domainCode}</span>
                  </div>
                )}
                {loader.attributeCodes?.length > 0 && (
                  <div className="detail-row">
                    <span className="detail-label">Attributes:</span>
                    <span className="mono">{loader.attributeCodes.join(', ')}</span>
                  </div>
                )}
                <div className="detail-row">
                  <span className="detail-label">Frequency:</span>
                  <span>{getFrequencyLabel(loader.loadFrequency)}</span>
                </div>
                {loader.cronExpression && (
                  <div className="detail-row">
                    <span className="detail-label">Cron:</span>
                    <span className="mono">{loader.cronExpression}</span>
                  </div>
                )}
                {loader.loadWindow && (
                  <div className="detail-row">
                    <span className="detail-label">Window:</span>
                    <span>{loader.loadWindow}</span>
                  </div>
                )}
                <div className="detail-row">
                  <span className="detail-label">Batch Size:</span>
                  <span>{loader.batchSize}</span>
                </div>
                {loader.lastRunAt && (
                  <div className="detail-row">
                    <span className="detail-label">Last Run:</span>
                    <span>{new Date(loader.lastRunAt).toLocaleString()}</span>
                  </div>
                )}
                {loader.nextRunAt && (
                  <div className="detail-row">
                    <span className="detail-label">Next Run:</span>
                    <span>{new Date(loader.nextRunAt).toLocaleString()}</span>
                  </div>
                )}
              </div>

              <div className="card-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => handleTriggerLoader(loader.id)}
                  disabled={triggerLoader.isPending}
                >
                  Run Now
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setEditingLoader(loader);
                    setShowLoaderForm(true);
                  }}
                >
                  Edit
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => handleDeleteLoader(loader.id)}
                  disabled={deleteLoader.isPending}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showConnectionForm && (
        <div className="modal-overlay" onClick={() => {
          setShowConnectionForm(false);
          setEditingConnection(null);
        }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingConnection ? 'Edit Connection' : 'New Connection'}</h2>
              <button
                className="close-btn"
                onClick={() => {
                  setShowConnectionForm(false);
                  setEditingConnection(null);
                }}
              >
                ×
              </button>
            </div>
            <DataConnectionForm
              connection={editingConnection}
              onSuccess={() => {
                setShowConnectionForm(false);
                setEditingConnection(null);
              }}
              onCancel={() => {
                setShowConnectionForm(false);
                setEditingConnection(null);
              }}
            />
          </div>
        </div>
      )}

      {showLoaderForm && (
        <div className="modal-overlay" onClick={() => {
          setShowLoaderForm(false);
          setEditingLoader(null);
        }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingLoader ? 'Edit Loader' : 'New Loader'}</h2>
              <button
                className="close-btn"
                onClick={() => {
                  setShowLoaderForm(false);
                  setEditingLoader(null);
                }}
              >
                ×
              </button>
            </div>
            <DataLoaderForm
              loader={editingLoader}
              onSuccess={() => {
                setShowLoaderForm(false);
                setEditingLoader(null);
              }}
              onCancel={() => {
                setShowLoaderForm(false);
                setEditingLoader(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
