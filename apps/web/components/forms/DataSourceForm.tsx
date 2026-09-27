'use client';

import { useState } from 'react';
import { CREATE_DATA_SOURCE_MUTATION, UPDATE_DATA_SOURCE_MUTATION } from '@/lib/graphql';

interface DataSource {
  id?: string;
  sourceCode: string;
  sourceName: string;
  sourceType: string;
  vendorName?: string;
  precedenceRank: number;
  isActive: boolean;
}

interface DataSourceFormProps {
  dataSource?: DataSource;
  onSave: (dataSource: DataSource) => void;
  onCancel: () => void;
}

export default function DataSourceForm({ dataSource, onSave, onCancel }: DataSourceFormProps) {
  const isEdit = !!dataSource;
  const [formData, setFormData] = useState({
    sourceCode: dataSource?.sourceCode || '',
    sourceName: dataSource?.sourceName || '',
    sourceType: dataSource?.sourceType || 'VENDOR',
    vendorName: dataSource?.vendorName || '',
    precedenceRank: dataSource?.precedenceRank || 100,
    isActive: dataSource?.isActive || true,
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;
    
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const input = {
        ...formData,
        id: dataSource?.id,
      };
      
      let result;
      if (isEdit) {
        result = await updateDataSourceGQL(input);
      } else {
        result = await createDataSourceGQL(input);
      }
      
      if (result.errors?.length > 0) {
        console.error('GraphQL mutation errors:', result.errors);
        alert(`Error: ${result.errors[0].message}`);
      } else {
        onSave(result.dataSource);
      }
    } catch (err) {
      console.error('Error saving data source:', err);
      alert('An error occurred while saving the data source');
    }
  };

  return (
    <div className="form-container">
      <div className="form-header">
        <h3>{isEdit ? 'Edit Data Source' : 'Create Data Source'}</h3>
      </div>
      
      <form onSubmit={handleSubmit}>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="field">
            <label htmlFor="sourceCode">Source Code</label>
            <input
              type="text"
              id="sourceCode"
              name="sourceCode"
              value={formData.sourceCode}
              onChange={handleChange}
              className="text-input"
              placeholder="e.g., BLOOMBERG"
            />
          </div>
          
          <div className="field">
            <label htmlFor="sourceName">Source Name</label>
            <input
              type="text"
              id="sourceName"
              name="sourceName"
              value={formData.sourceName}
              onChange={handleChange}
              className="text-input"
              placeholder="e.g., Bloomberg Terminal"
            />
          </div>
          
          <div className="field">
            <label htmlFor="sourceType">Source Type</label>
            <select
              id="sourceType"
              name="sourceType"
              value={formData.sourceType}
              onChange={handleChange}
              className="select"
            >
              <option value="VENDOR">Vendor</option>
              <option value="INTERNAL">Internal</option>
              <option value="MANUAL">Manual</option>
              <option value="CALCULATED">Calculated</option>
            </select>
          </div>
          
          <div className="field">
            <label htmlFor="vendorName">Vendor Name</label>
            <input
              type="text"
              id="vendorName"
              name="vendorName"
              value={formData.vendorName}
              onChange={handleChange}
              className="text-input"
              placeholder="e.g., Bloomberg LP"
            />
          </div>
          
          <div className="field">
            <label htmlFor="precedenceRank">Precedence Rank</label>
            <input
              type="number"
              id="precedenceRank"
              name="precedenceRank"
              value={formData.precedenceRank}
              onChange={handleChange}
              className="text-input"
            />
          </div>
          
          <div className="field">
            <label>
              <input
                type="checkbox"
                name="isActive"
                checked={formData.isActive}
                onChange={handleChange}
                className="checkbox"
              />
              <span style={{ marginLeft: '8px' }}>Is Active</span>
            </label>
          </div>
        </div>
        
        <div className="form-actions" style={{ marginTop: '20px', display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            {isEdit ? 'Update Data Source' : 'Create Data Source'}
          </button>
        </div>
      </form>
    </div>
  );
}